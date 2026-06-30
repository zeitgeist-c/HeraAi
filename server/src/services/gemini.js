import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';
import { KeyPool, ERROR_RETRYABLE, ERROR_NON_RETRYABLE } from './keyPool.js';
import { writeEvent, endStream, sendError } from '../utils/sse.js';

const MODEL = 'gemini-3.1-flash-lite';

export const geminiPool = new KeyPool('gemini', config.geminiKeys, config.cooldowns);

function classifyGeminiError(err) {
  const msg = err.message || '';
  const status = err.status || err.code || 0;

  if (status === 429 || msg.includes('RATE_LIMIT') || msg.includes('rate_limit')) {
    return ERROR_RETRYABLE.rateLimit;
  }
  if (status === 429 || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota') || msg.includes('exhausted')) {
    return ERROR_RETRYABLE.quotaExceeded;
  }
  if (status === 500 || status === 503 || msg.includes('500') || msg.includes('503') || msg.includes('internal')) {
    return ERROR_RETRYABLE.serverError;
  }
  if (msg.includes('timeout') || msg.includes('TIMEOUT') || msg.includes('Deadline') || msg.includes('network')) {
    return ERROR_RETRYABLE.timeout;
  }
  if (status === 400 || msg.includes('INVALID_ARGUMENT') || msg.includes('BAD_REQUEST')) {
    return ERROR_NON_RETRYABLE.badRequest;
  }
  if (msg.includes('SAFETY') || msg.includes('blocked') || msg.includes('safety')) {
    return ERROR_NON_RETRYABLE.safetyBlock;
  }

  return ERROR_RETRYABLE.serverError;
}

async function withGeminiFallback(fn) {
  const total = geminiPool.keys.length;
  let lastError = null;

  for (let attempt = 0; attempt < total; attempt++) {
    const entry = geminiPool.getNextKey();
    if (!entry) break;

    try {
      const genAI = new GoogleGenerativeAI(entry.key);
      const result = await fn(genAI);
      geminiPool.markSucceeded(entry);
      return result;
    } catch (err) {
      lastError = err;
      const errorType = classifyGeminiError(err);

      if (errorType in ERROR_NON_RETRYABLE) {
        console.error(`Gemini key ${entry.masked} failed with non-retryable error: ${err.message?.slice(0, 100)}`);
        throw err;
      }

      console.warn(`Gemini key ${entry.masked} failed (${errorType}), trying next key...`);
      geminiPool.markFailed(entry, errorType);
    }
  }

  console.error('All Gemini keys exhausted. Last error:', lastError?.message?.slice(0, 200));
  throw lastError || new Error('No Gemini keys available');
}

export async function streamChat(req, res) {
  const { messages, systemInstruction } = req.body;

  await withGeminiFallback(async (genAI) => {
    const model = genAI.getGenerativeModel({
      model: MODEL,
      ...(systemInstruction?.trim() ? { systemInstruction: systemInstruction.trim() } : {}),
    });

    const history = messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const lastMsg = messages[messages.length - 1];
    const chat = model.startChat({ history });
    const result = await chat.sendMessageStream(lastMsg.content);

    for await (const chunk of result.stream) {
      writeEvent(res, 'chunk', { text: chunk.text() });
    }
    endStream(res);
  });
}

export async function streamVision(req, res) {
  const { messages, image, systemInstruction } = req.body;

  await withGeminiFallback(async (genAI) => {
    const model = genAI.getGenerativeModel({
      model: MODEL,
      ...(systemInstruction?.trim() ? { systemInstruction: systemInstruction.trim() } : {}),
    });

    const history = messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: m.image
        ? [{ text: m.content }, { inlineData: { data: m.image, mimeType: 'image/png' } }]
        : [{ text: m.content }],
    }));

    const lastMsg = messages[messages.length - 1];
    const parts = [{ text: lastMsg.content }];
    if (image) {
      parts.push({ inlineData: { data: image, mimeType: 'image/png' } });
    }

    const chat = model.startChat({ history });
    const result = await chat.sendMessageStream(parts);

    for await (const chunk of result.stream) {
      writeEvent(res, 'chunk', { text: chunk.text() });
    }
    endStream(res);
  });
}
