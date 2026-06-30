import dotenv from 'dotenv';
import { parseKeys } from './services/keyPool.js';
dotenv.config();

const geminiKeys = parseKeys(process.env.GEMINI_API_KEYS, process.env.GEMINI_API_KEY);
const tavilyKeys = parseKeys(process.env.TAVILY_API_KEYS, process.env.TAVILY_API_KEY);

if (geminiKeys.length === 0) {
  console.error('Missing required env var: GEMINI_API_KEY or GEMINI_API_KEYS');
  process.exit(1);
}

if (tavilyKeys.length === 0) {
  console.warn('Warning: No Tavily API key configured. Web Research will be unavailable.');
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  geminiKeys,
  tavilyKeys,
  allowedOrigins: process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGIN || 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV || 'development',
  cooldowns: {
    rateLimit: parseInt(process.env.COOLDOWN_RATE_LIMIT || '60000', 10),
    quotaExceeded: parseInt(process.env.COOLDOWN_QUOTA || '3600000', 10),
    timeout: parseInt(process.env.COOLDOWN_TIMEOUT || '30000', 10),
    serverError: parseInt(process.env.COOLDOWN_SERVER_ERROR || '60000', 10),
  },
};
