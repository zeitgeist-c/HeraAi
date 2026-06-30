import rateLimit from 'express-rate-limit';

export const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: { code: 'RATE_LIMITED', message: 'Çok fazla istek. Lütfen bekleyin.' } },
});

export const researchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: { code: 'RATE_LIMITED', message: 'Çok fazla istek. Lütfen bekleyin.' } },
});

export const visionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: { code: 'RATE_LIMITED', message: 'Çok fazla istek. Lütfen bekleyin.' } },
});
