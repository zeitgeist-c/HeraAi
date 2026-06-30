import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  allowedOrigins: process.env.ALLOWED_ORIGINS || 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV || 'development',
  cooldowns: {
    rateLimit: parseInt(process.env.COOLDOWN_RATE_LIMIT || '60000', 10),
    quotaExceeded: parseInt(process.env.COOLDOWN_QUOTA || '3600000', 10),
    timeout: parseInt(process.env.COOLDOWN_TIMEOUT || '30000', 10),
    serverError: parseInt(process.env.COOLDOWN_SERVER_ERROR || '60000', 10),
  },
};
