import { Router } from 'express';
import { searchWeb } from '../services/tavily.js';
import { buildResearchContext, buildSourcesList } from '../services/contextBuilder.js';
import { researchLimiter } from '../middleware/rateLimiter.js';
import { validateResearch } from '../middleware/validate.js';
import { writeEvent, endStream, sendError } from '../utils/sse.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createPool, ERROR_RETRYABLE, ERROR_NON_RETRYABLE } from '../services/keyPool.js';
import { config } from '../config.js';

const router = Router();
const MODEL = 'gemini-3.1-flash-lite';

router.post('/research', researchLimiter, validateResearch, async (req, res) => {
  const { question, geminiKeys, tavilyKeys } = req.body;

  if (!tavilyKeys || !Array.isArray(tavilyKeys) || tavilyKeys.length === 0) {
    return res.status(400).json({
      error: { code: 'TAVILY_NOT_CONFIGURED', message: 'Web Research için Tavily API key gerekli' },
    });
  }

  if (!geminiKeys || !Array.isArray(geminiKeys) || geminiKeys.length === 0) {
    return res.status(400).json({
      error: { code: 'GEMINI_NOT_CONFIGURED', message: 'Gemini API key gerekli' },
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const timeout = setTimeout(() => {
    sendError(res, 'TIMEOUT', 'İstek zaman aşımına uğradı.');
  }, 45000);

  req.on('close', () => clearTimeout(timeout));

  try {
    writeEvent(res, 'search_status', { status: 'searching', message: 'Web\'de araştırma yapılıyor...' });

    const results = await searchWeb(question, 10, tavilyKeys, res);

    const pool = createPool('gemini', geminiKeys, config.cooldowns);
    const total = pool.keys.length;
    let lastError = null;
    let succeeded = false;

    for (let attempt = 0; attempt < total; attempt++) {
      const entry = pool.getNextKey();
      if (!entry) break;

      try {
        const genAI = new GoogleGenerativeAI(entry.key);
        const model = genAI.getGenerativeModel({ model: MODEL });

        if (!results || results.length === 0) {
          writeEvent(res, 'search_status', { status: 'no_results', message: 'Web araması sonuç vermedi.' });
          const result = await model.generateContentStream(
            `Web araması "${question}" için sonuç bulamadı. Kullanıcıya bu konuda yeterli bilgi bulunamadığını söyleyen kısa bir yanıt yaz (Türkçe). Uydurma bilgi üretme.`
          );
          writeEvent(res, 'key_status', { provider: 'gemini', keyId: entry.id, status: 'success' });
          for await (const chunk of result.stream) {
            writeEvent(res, 'chunk', { text: chunk.text() });
          }
          endStream(res);
          pool.markSucceeded(entry);
          succeeded = true;
          break;
        }

        writeEvent(res, 'search_status', { status: 'generating', message: 'Cevap oluşturuluyor...' });
        writeEvent(res, 'key_status', { provider: 'gemini', keyId: entry.id, status: 'success' });

        const context = buildResearchContext(results, question);
        const sources = buildSourcesList(results);

        const result = await model.generateContentStream(context);

        for await (const chunk of result.stream) {
          writeEvent(res, 'chunk', { text: chunk.text() });
        }

        writeEvent(res, 'sources', { sources });
        endStream(res);
        pool.markSucceeded(entry);
        succeeded = true;
        break;
      } catch (err) {
        lastError = err;
        const msg = err.message || '';
        const isNonRetryable = msg.includes('INVALID_ARGUMENT') || msg.includes('BAD_REQUEST') || msg.includes('SAFETY') || msg.includes('blocked');

        if (isNonRetryable) {
          if (!res.writableEnded) {
            writeEvent(res, 'key_status', { provider: 'gemini', keyId: entry.id, status: 'invalid_request' });
          }
          throw err;
        }

        if (!res.writableEnded) {
          writeEvent(res, 'key_status', { provider: 'gemini', keyId: entry.id, status: 'provider_error' });
        }
        pool.markFailed(entry, ERROR_RETRYABLE.serverError);
      }
    }

    if (!succeeded) {
      throw lastError || new Error('Gemini servisi kullanılamıyor.');
    }

  } catch (err) {
    console.error('Research error:', err.message?.slice(0, 200));
    if (!res.writableEnded) {
      if (err.message?.includes('Tavily') || err.name === 'AbortError') {
        sendError(res, 'TAVILY_ERROR', 'Web araması yapılamadı. Lütfen daha sonra tekrar deneyin.');
      } else {
        sendError(res, 'GEMINI_ERROR', 'Arama sonuçları alındı ancak cevap oluşturulamadı.');
      }
    }
  } finally {
    clearTimeout(timeout);
  }
});

export default router;
