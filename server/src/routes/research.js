import { Router } from 'express';
import { config } from '../config.js';
import { searchWeb } from '../services/tavily.js';
import { buildResearchContext, buildSourcesList } from '../services/contextBuilder.js';
import { researchLimiter } from '../middleware/rateLimiter.js';
import { validateResearch } from '../middleware/validate.js';
import { writeEvent, endStream, sendError } from '../utils/sse.js';

const router = Router();

router.post('/research', researchLimiter, validateResearch, async (req, res) => {
  if (!config.tavilyApiKey) {
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

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(config.geminiApiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
    
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

  } catch (err) {
    console.error('Research error:', err);
    if (!res.writableEnded) {
      if (err.message?.includes('Tavily')) {
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
