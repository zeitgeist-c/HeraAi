import { Router } from 'express';
import { streamVision } from '../services/gemini.js';
import { visionLimiter } from '../middleware/rateLimiter.js';
import { validateVision } from '../middleware/validate.js';
import { sendError } from '../utils/sse.js';

const router = Router();

router.post('/vision', visionLimiter, validateVision, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const timeout = setTimeout(() => {
    sendError(res, 'TIMEOUT', 'İstek zaman aşımına uğradı.');
  }, 30000);

  req.on('close', () => clearTimeout(timeout));

  try {
    await streamVision(req, res);
  } catch (err) {
    console.error('Vision error:', err);
    if (!res.writableEnded) {
      sendError(res, 'GEMINI_ERROR', 'Cevap oluşturulamadı. Lütfen tekrar deneyin.');
    }
  } finally {
    clearTimeout(timeout);
  }
});

export default router;
