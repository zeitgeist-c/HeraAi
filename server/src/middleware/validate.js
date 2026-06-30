function validateKeyArray(keys, provider) {
  if (!keys || !Array.isArray(keys) || keys.length === 0) {
    return `${provider} API key listesi gerekli`;
  }
  for (const k of keys) {
    if (!k.id || !k.key || typeof k.key !== 'string' || k.key.trim() === '') {
      return `${provider} API key bilgisi geçersiz`;
    }
  }
  return null;
}

export function validateChat(req, res, next) {
  const { messages, geminiKeys } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'messages dizisi gerekli.' },
    });
  }
  const keyErr = validateKeyArray(geminiKeys, 'Gemini');
  if (keyErr) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: keyErr } });
  }
  next();
}

export function validateResearch(req, res, next) {
  const { question, geminiKeys, tavilyKeys } = req.body;
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'question metni gerekli.' },
    });
  }
  const geminiErr = validateKeyArray(geminiKeys, 'Gemini');
  if (geminiErr) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: geminiErr } });
  }
  const tavilyErr = validateKeyArray(tavilyKeys, 'Tavily');
  if (tavilyErr) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: tavilyErr } });
  }
  next();
}

export function validateVision(req, res, next) {
  const { messages, geminiKeys } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'messages dizisi gerekli.' },
    });
  }
  const keyErr = validateKeyArray(geminiKeys, 'Gemini');
  if (keyErr) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: keyErr } });
  }
  next();
}
