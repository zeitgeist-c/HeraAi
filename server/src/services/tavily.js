import { config } from '../config.js';
import { createPool, ERROR_RETRYABLE, ERROR_NON_RETRYABLE } from './keyPool.js';
import { writeEvent } from '../utils/sse.js';

function classifyTavilyError(status, body) {
  if (status === 429) return ERROR_RETRYABLE.rateLimit;
  if (status >= 500 && status < 600) return ERROR_RETRYABLE.serverError;
  if (status === 400) return ERROR_NON_RETRYABLE.badRequest;
  if (status === 401 || status === 403) return ERROR_NON_RETRYABLE.authError;
  return ERROR_RETRYABLE.serverError;
}

function isTavilyRetryable(errorType) {
  return errorType === ERROR_RETRYABLE.rateLimit
    || errorType === ERROR_RETRYABLE.serverError
    || errorType === ERROR_RETRYABLE.timeout;
}

export async function searchWeb(query, maxResults = 10, tavilyKeysArray = [], res = null) {
  const pool = createPool('tavily', tavilyKeysArray, config.cooldowns);
  if (pool.keys.length === 0) {
    throw new Error('Tavily servisi kullanılamıyor. API anahtarı gerekli.');
  }

  const total = pool.keys.length;
  let lastError = null;

  for (let attempt = 0; attempt < total; attempt++) {
    const entry = pool.getNextKey();
    if (!entry) break;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: entry.key,
          query,
          max_results: maxResults,
          include_answer: false,
          include_raw_content: false,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const text = await response.text();
        const errorType = classifyTavilyError(response.status, text);

        if (isTavilyRetryable(errorType)) {
          if (res && !res.writableEnded) {
            writeEvent(res, 'key_status', { provider: 'tavily', keyId: entry.id, status: errorType });
          }
          pool.markFailed(entry, errorType);
          continue;
        }

        if (res && !res.writableEnded) {
          writeEvent(res, 'key_status', { provider: 'tavily', keyId: entry.id, status: errorType });
        }
        throw new Error(`Tavily API error: ${errorType}`);
      }

      pool.markSucceeded(entry);
      if (res && !res.writableEnded) {
        writeEvent(res, 'key_status', { provider: 'tavily', keyId: entry.id, status: 'success' });
      }

      const data = await response.json();
      return data.results.map(r => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
      }));

    } catch (err) {
      lastError = err;

      if (err.name === 'AbortError') {
        if (res && !res.writableEnded) {
          writeEvent(res, 'key_status', { provider: 'tavily', keyId: entry.id, status: 'timeout' });
        }
        pool.markFailed(entry, ERROR_RETRYABLE.timeout);
        continue;
      }

      if (err.message?.includes('fetch failed') || err.message?.includes('network') || err.message?.includes('ENOTFOUND')) {
        if (res && !res.writableEnded) {
          writeEvent(res, 'key_status', { provider: 'tavily', keyId: entry.id, status: 'network_error' });
        }
        pool.markFailed(entry, ERROR_RETRYABLE.timeout);
        continue;
      }

      if (isTavilyRetryable(classifyTavilyError(0, ''))) {
        if (res && !res.writableEnded) {
          writeEvent(res, 'key_status', { provider: 'tavily', keyId: entry.id, status: 'provider_error' });
        }
        pool.markFailed(entry, ERROR_RETRYABLE.serverError);
        continue;
      }

      throw err;
    }
  }

  throw lastError || new Error('Tavily servisi kullanılamıyor. Lütfen daha sonra tekrar deneyin.');
}
