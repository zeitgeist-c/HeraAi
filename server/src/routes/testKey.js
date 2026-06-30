import { Router } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';

const router = Router();

function classifyTestError(err) {
  const msg = err.message || '';
  const status = err.status || err.code || 0;

  if (status === 429 || msg.includes('RATE_LIMIT') || msg.includes('rate_limit') || msg.includes('429')) {
    return { errorType: 'rate_limited', message: 'Rate limit aşıldı. Lütfen kısa bir süre bekleyin.' };
  }
  if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota') || msg.includes('exhausted')) {
    return { errorType: 'quota_exceeded', message: 'Kota dolmuş olabilir. Lütfen kota durumunuzu kontrol edin.' };
  }
  if (msg.includes('API_KEY_INVALID') || msg.includes('API key') || msg.includes('403') || (status === 401)) {
    return { errorType: 'invalid_key', message: 'Geçersiz API anahtarı.' };
  }
  if (err.name === 'AbortError' || msg.includes('timeout') || msg.includes('TIMEOUT')) {
    return { errorType: 'timeout', message: 'Bağlantı zaman aşımına uğradı.' };
  }
  if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED')) {
    return { errorType: 'network_error', message: 'Bağlantı hatası. Sunucuya erişilemiyor.' };
  }
  return { errorType: 'unknown', message: 'Beklenmeyen bir hata oluştu.' };
}

router.post('/test-key', async (req, res) => {
  const { provider, key } = req.body;

  if (!provider || !['gemini', 'tavily'].includes(provider)) {
    return res.status(400).json({
      success: false,
      errorType: 'invalid_request',
      message: 'Geçersiz sağlayıcı. Sadece "gemini" veya "tavily" kabul edilir.',
    });
  }

  if (!key || typeof key !== 'string' || key.trim() === '') {
    return res.status(400).json({
      success: false,
      errorType: 'invalid_request',
      message: 'API anahtarı gerekli.',
    });
  }

  try {
    if (provider === 'gemini') {
      const genAI = new GoogleGenerativeAI(key.trim());
      const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      await model.generateContent('test');
      clearTimeout(timeoutId);
    } else {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key.trim(), query: 'test', max_results: 1 }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        const errInfo = classifyTestError({
          message: `HTTP ${response.status}`,
          status: response.status,
        });
        return res.json({ success: false, provider, ...errInfo });
      }
    }

    res.json({ success: true, provider });
  } catch (err) {
    const errInfo = classifyTestError(err);
    res.json({ success: false, provider, ...errInfo });
  }
});

export default router;
