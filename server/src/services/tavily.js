import { config } from '../config.js';
import { KeyPool, ERROR_RETRYABLE, ERROR_NON_RETRYABLE } from './keyPool.js';

export const tavilyPool = new KeyPool('tavily', config.tavilyKeys, config.cooldowns);

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

export async function searchWeb(query, maxResults = 10) {
  const total = tavilyPool.keys.length;
  let lastError = null;

  for (let attempt = 0; attempt < total; attempt++) {
    const entry = tavilyPool.getNextKey();
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
          console.warn(`Tavily key ${entry.masked} failed (${errorType}), trying next key...`);
          tavilyPool.markFailed(entry, errorType);
          continue;
        }

        throw new Error(`Tavily API error ${response.status}: ${text}`);
      }

      tavilyPool.markSucceeded(entry);

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
        console.warn(`Tavily key ${entry.masked} timed out, trying next key...`);
        tavilyPool.markFailed(entry, ERROR_RETRYABLE.timeout);
        continue;
      }

      if (err.message?.includes('fetch failed') || err.message?.includes('network') || err.message?.includes('ENOTFOUND')) {
        console.warn(`Tavily key ${entry.masked} network error, trying next key...`);
        tavilyPool.markFailed(entry, ERROR_RETRYABLE.timeout);
        continue;
      }

      if (isTavilyRetryable(classifyTavilyError(0, ''))) {
        console.warn(`Tavily key ${entry.masked} error, trying next key...`);
        tavilyPool.markFailed(entry, ERROR_RETRYABLE.serverError);
        continue;
      }

      throw err;
    }
  }

  console.error('All Tavily keys exhausted. Last error:', lastError?.message?.slice(0, 200));
  throw lastError || new Error('Tavily servisi kullanılamıyor. Lütfen daha sonra tekrar deneyin.');
}
