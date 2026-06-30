import { Router } from 'express';
import { searchWeb, tavilyPool } from '../services/tavily.js';
import { geminiPool } from '../services/gemini.js';
import { buildResearchContext, buildSourcesList } from '../services/contextBuilder.js';
import { researchLimiter } from '../middleware/rateLimiter.js';
import { validateResearch } from '../middleware/validate.js';
import { writeEvent, endStream, sendError } from '../utils/sse.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ERROR_RETRYABLE } from '../services/keyPool.js';

const router = Router();
const MODEL = 'gemini-3.1-flash-lite';

router.post('/research', researchLimiter, validateResearch, async (req, res) => {
  if (tavilyPool.keys.length === 0) {
    return res.status(400).json({
      error: { code: 'TAVILY_NOT_CONFIGURED', message: 'Web Research kullanmak icin TAVILY_API_KEY gerekli.' },
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

    const results = await searchWeb(req.body.question);

    const genAICall = async (genAI) => {
      const model = genAI.getGenerativeModel({ model: MODEL });

      if (!results || results.length === 0) {
        writeEvent(res, 'search_status', { status: 'no_results', message: 'Web araması sonuç vermedi.' });
        const result = await model.generateContentStream(
          `Web araması "${req.body.question}" için sonuç bulamadı. Kullanıcıya bu konuda yeterli bilgi bulunamadığını söyleyen kısa bir yanıt yaz (Türkçe). Uydurma bilgi üretme.`
        );
        for await (const chunk of result.stream) {
          writeEvent(res, 'chunk', { text: chunk.text() });
        }
        endStream(res);
        return;
      }

      writeEvent(res, 'search_status', { status: 'generating', message: 'Cevap oluşturuluyor...' });

      const context = buildResearchContext(results, req.body.question);
      const sources = buildSourcesList(results);

      const result = await model.generateContentStream(context);

      for await (const chunk of result.stream) {
        writeEvent(res, 'chunk', { text: chunk.text() });
      }

      writeEvent(res, 'sources', { sources });
      endStream(res);
    };

    const total = geminiPool.keys.length;
    let lastError = null;
    let succeeded = false;

    for (let attempt = 0; attempt < total; attempt++) {
      const entry = geminiPool.getNextKey();
      if (!entry) break;

      try {
        const genAI = new GoogleGenerativeAI(entry.key);
        await genAICall(genAI);
        geminiPool.markSucceeded(entry);
        succeeded = true;
        break;
      } catch (err) {
        lastError = err;
        const msg = err.message || '';
        const isNonRetryable = msg.includes('INVALID_ARGUMENT') || msg.includes('BAD_REQUEST') || msg.includes('SAFETY') || msg.includes('blocked');

        if (isNonRetryable) {
          console.error(`Research Gemini key ${entry.masked} non-retryable error: ${msg.slice(0, 100)}`);
          throw err;
        }

        console.warn(`Research Gemini key ${entry.masked} failed, trying next key...`);
        geminiPool.markFailed(entry, ERROR_RETRYABLE.serverError);
      }
    }

    if (!succeeded) {
      throw lastError || new Error('Gemini servisi kullanılamıyor.');
    }

  } catch (err) {
    console.error('Research error:', err);
    if (!res.writableEnded) {
      if (err.message?.includes('Tavily') || err.message?.includes('tavily')) {
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
