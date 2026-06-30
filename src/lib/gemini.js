import { GoogleGenerativeAI } from "@google/generative-ai";
import { classifyError } from './errorClassifier';

const DEFAULT_MODEL = 'gemini-3.1-flash-lite' // Gemini 3.1 Flash Lite

let genAI = null;
let currentProvider = 'google';

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const REQUEST_TIMEOUT = 120000;

export const initGemini = (apiKey) => {
    genAI = new GoogleGenerativeAI(apiKey);
    currentProvider = 'google';
};

export const getCurrentProvider = () => currentProvider;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const sleepWithExponentialBackoff = async (attempt) => {
    const waitTime = RETRY_DELAY * Math.pow(2, attempt);
    await delay(waitTime);
};

export const streamChatResponse = async (history, message, attachments, options = {}, onChunk, onError) => {
    const model = options.selectedModel || DEFAULT_MODEL;
    const apiProvider = currentProvider;
    
    console.log("API Call - Provider:", apiProvider, "Model:", model, "Attachments:", attachments?.length || 0);
    
    let lastError = null;

    console.log("Google Gemini API - Model:", model, "Attachments:", attachments?.length || 0);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            if (!genAI) throw new Error("API Key is not initialized.");

            const modelOptions = {
                model: model,
                generationConfig: {}
            };

            if (options.systemInstruction && options.systemInstruction.trim() !== '') {
                modelOptions.systemInstruction = options.systemInstruction.trim();
            }

            const geminiModel = genAI.getGenerativeModel(modelOptions);

            const formattedHistory = history
                .filter(msg => msg.role !== 'system')
                .map(msg => ({
                    role: msg.role === 'model' ? 'model' : 'user',
                    parts: [{ text: msg.actualPrompt || msg.content }]
                }));

            let chatOptions = {
                history: formattedHistory,
            };

            if (options.enableSearch) {
                chatOptions.tools = [{
                    googleSearch: {}
                }];
            }

            const chat = geminiModel.startChat(chatOptions);

            let messageToSend = (message || '').trim();
            if (!messageToSend && attachments && attachments.length > 0) {
                messageToSend = "Bu görseli analiz et";
            }
            
            const parts = [{ text: messageToSend }];
            if (attachments && attachments.length > 0) {
                console.log("Sending attachment:", attachments[0].name, "mimeType:", attachments[0].mimeType, "data length:", attachments[0].data?.length);
                attachments.forEach(att => {
                    parts.push({
                        inlineData: {
                            data: att.data,
                            mimeType: att.mimeType,
                        }
                    });
                });
            }

            const result = await chat.sendMessageStream(parts);

            for await (const chunk of result.stream) {
                const chunkText = chunk.text();
                onChunk(chunkText);
            }

            return;

        } catch (error) {
            console.error(`Gemini API Error (attempt ${attempt + 1}/${MAX_RETRIES}):`, error);
            lastError = error;

            const isRetryableError = 
                error.message?.includes('rate limit') ||
                error.message?.includes('429') ||
                error.message?.includes('500') ||
                error.message?.includes('503') ||
                error.message?.includes('network') ||
                error.message?.includes('ENOTFOUND') ||
                error.message?.includes('ETIMEDOUT');

            if (error.message?.includes('quota') || error.message?.includes('exceeded')) {
                onError("API kota aşıldı. Lütfen daha sonra tekrar deneyin veya farklı bir API anahtarı kullanın.");
                return;
            }

            if (!isRetryableError || attempt === MAX_RETRIES - 1) {
                break;
            }

            await sleepWithExponentialBackoff(attempt);
        }
    }

    console.error("Gemini API Error after retries:", lastError);
    
    const classified = classifyError(lastError?.message || "Bir hata oluştu.");
    
    onError(classified.userMessage);
};