import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';
import { writeEvent, endStream, sendError } from '../utils/sse.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);
const MODEL = 'gemini-3.1-flash-lite';

export async function streamChat(req, res) {
  const { messages, systemInstruction } = req.body;
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
}

export async function streamVision(req, res) {
  const { messages, image, systemInstruction } = req.body;
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
}
