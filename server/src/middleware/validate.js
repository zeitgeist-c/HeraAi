export function validateChat(req, res, next) {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'messages dizisi gerekli.' },
    });
  }
  next();
}

export function validateResearch(req, res, next) {
  const { question } = req.body;
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'question metni gerekli.' },
    });
  }
  next();
}

export function validateVision(req, res, next) {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'messages dizisi gerekli.' },
    });
  }
  next();
}
