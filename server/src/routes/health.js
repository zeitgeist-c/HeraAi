import { Router } from 'express';
import { geminiPool } from '../services/gemini.js';
import { tavilyPool } from '../services/tavily.js';
const router = Router();

router.get('/health', (req, res) => {
  const geminiStatus = geminiPool.getStatus();
  const tavilyStatus = tavilyPool.getStatus();

  res.json({
    status: 'ok',
    timestamp: Date.now(),
    providers: {
      gemini: {
        configured: geminiStatus.total > 0,
        available: geminiStatus.available > 0,
        totalKeys: geminiStatus.total,
        ready: geminiStatus.total > 0 && geminiStatus.available > 0,
      },
      tavily: {
        configured: tavilyStatus.total > 0,
        available: tavilyStatus.available > 0,
        totalKeys: tavilyStatus.total,
        ready: tavilyStatus.total > 0 && tavilyStatus.available > 0,
      },
    },
  });
});

export default router;
