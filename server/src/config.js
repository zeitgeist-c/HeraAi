import dotenv from 'dotenv';
dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  console.error('Missing required env var: GEMINI_API_KEY');
  process.exit(1);
}

if (!process.env.TAVILY_API_KEY) {
  console.warn('Warning: TAVILY_API_KEY not set. Web Research (Tavily) will be unavailable.');
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  geminiApiKey: process.env.GEMINI_API_KEY,
  tavilyApiKey: process.env.TAVILY_API_KEY || '',
  allowedOrigins: process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGIN || 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV || 'development',
};
