import { GoogleGenerativeAI } from "@google/generative-ai";
import { classifyError } from './errorClassifier';
import { initOllama as initOllamaFromModule, streamChatResponse as ollamaStreamChat, getCurrentProvider as getOllamaProvider } from './ollama';
import { filterAttachmentsForModel } from './modelCapabilities';

let genAI = null;
let openRouterKey = null;
let currentProvider = 'google';

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const REQUEST_TIMEOUT = 120000;

export const initGemini = (apiKey) => {
    genAI = new GoogleGenerativeAI(apiKey);
    currentProvider = 'google';
};

export const initOpenRouter = (apiKey) => {
    openRouterKey = apiKey;
    currentProvider = 'openrouter';
};

export const initOllama = (apiKey) => {
    initOllamaFromModule(apiKey);
    currentProvider = 'ollama';
};

export const getCurrentProvider = () => currentProvider;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const sleepWithExponentialBackoff = async (attempt) => {
    const waitTime = RETRY_DELAY * Math.pow(2, attempt);
    await delay(waitTime);
};

let currentAbortController = null;

export const cancelOpenRouterStream = () => {
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
        return true;
    }
    return false;
};

const callOpenRouter = async (model, messages, onChunk, onError, signal) => {
    currentAbortController = new AbortController();
    const timeoutId = setTimeout(() => currentAbortController.abort(), REQUEST_TIMEOUT);
    
    const abortHandler = () => {
        clearTimeout(timeoutId);
        onError('İstek iptal edildi');
    };
    
    const externalSignal = signal;
    const signalPromise = externalSignal ? new Promise(resolve => {
        externalSignal.addEventListener('abort', abortHandler);
    }) : Promise.resolve();
    
    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${openRouterKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://heraai.dev',
                'X-Title': 'HeraAi'
            },
            body: JSON.stringify({
                model: model,
                messages: messages,
                stream: true
            }),
            signal: currentAbortController.signal
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenRouter Error: ${response.status} - ${error}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') return;
                    try {
                        const json = JSON.parse(data);
                        if (json.choices?.[0]?.delta?.content) {
                            onChunk(json.choices[0].delta.content);
                        }
                    } catch (e) {
                        // Ignore parse errors for non-JSON lines
                    }
                }
            }
        }
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            const isExternalAbort = externalSignal?.aborted;
            if (!isExternalAbort) {
                onError('İstek iptal edildi');
            }
        } else {
            throw error;
        }
    } finally {
        if (externalSignal) {
            externalSignal.removeEventListener('abort', abortHandler);
        }
        currentAbortController = null;
    }
};

export const streamChatResponse = async (history, message, attachments, options = {}, onChunk, onError) => {
    const model = options.selectedModel || 'gemini-2.5-flash';
    const apiProvider = currentProvider;
    
    console.log("API Call - Provider:", apiProvider, "Model:", model, "Attachments:", attachments?.length || 0);
    
    if (apiProvider === 'ollama') {
        await ollamaStreamChat(history, message, attachments, options, onChunk, onError);
        return;
    }
    
    if (apiProvider === 'openrouter') {
        const filteredAttachments = filterAttachmentsForModel(attachments || [], model, 'openrouter');
        const hadImageAttachments = (attachments?.length || 0) > filteredAttachments.length;
        
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                if (!openRouterKey) throw new Error("OpenRouter API Key is not initialized.");
                const knownPrefixes = ['openai/', 'anthropic/', 'google/', 'deepseek/', 'meta-llama/', 'mistralai/', 'qwen/', 'xai/', 'minimax/', 'moonshotai/', 'cohere/', 'stepfun/', 'arcee-ai/', 'nvidia/'];
                const openRouterModel = knownPrefixes.some(p => model.startsWith(p)) ? model : `google/${model}`;

                let messageToSend = (message || '').trim();
                if (!messageToSend && filteredAttachments.length > 0) {
                    if (hadImageAttachments) {
                        messageToSend = "Bu görseli analiz et";
                    } else if (filteredAttachments.length > 0) {
                        messageToSend = "Bu dosyayı analiz et";
                    }
                }

                const formatOpenRouterMessage = (msg) => {
                    const content = msg?.content ?? '';
                    return { role: msg?.role === 'model' ? 'assistant' : 'user', content };
                };

                const buildOpenRouterContent = (text, atts) => {
                    const parts = [];
                    if (text && text.trim()) {
                        parts.push({ type: 'text', text: text.trim() });
                    }
                    if (atts && atts.length > 0) {
                        atts.forEach(att => {
                            if (att.mimeType?.startsWith('image/')) {
                                parts.push({
                                    type: 'image_url',
                                    image_url: {
                                        url: `data:${att.mimeType};base64,${att.data}`
                                    }
                                });
                            } else if (att.mimeType === 'application/pdf' || att.name?.toLowerCase().endsWith('.pdf')) {
                                parts.push({
                                    type: 'text',
                                    text: `[PDF Attachment: ${att.name}]`
                                });
                            } else {
                                parts.push({
                                    type: 'text',
                                    text: `[Attachment: ${att.name}]`
                                });
                            }
                        });
                    }
                    return parts.length > 0 ? parts : text;
                };

                const messages = [
                    ...(options.systemInstruction ? [{ role: 'system', content: options.systemInstruction }] : []),
                    ...history.filter(m => m.role !== 'system').map(formatOpenRouterMessage),
                    {
                        role: 'user',
                        content: buildOpenRouterContent(messageToSend, filteredAttachments)
                    }
                ];

                await callOpenRouter(openRouterModel, messages, onChunk, onError, options.signal);
                return;

            } catch (error) {
                console.error(`OpenRouter Error (attempt ${attempt + 1}/${MAX_RETRIES}):`, error);
                
                const classified = classifyError(error.message || String(error));
                
                if (error.name === 'AbortError' || error.message?.includes('abort')) {
                    return;
                }
                
                onError(classified.userMessage);
                return;
            }
        }
        onError("OpenRouter hatası. Lütfen tekrar deneyin.");
        return;
    }

    let lastError = null;

    console.log("Google Gemini API - Model:", model, "Attachments:", attachments?.length || 0);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            if (!genAI) throw new Error("API Key is not initialized.");

            const modelOptions = {
                model: options.selectedModel || "gemini-2.5-flash",
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