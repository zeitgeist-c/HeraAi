import { GoogleGenerativeAI } from "@google/generative-ai";

let genAI = null;

export const initGemini = (apiKey) => {
    genAI = new GoogleGenerativeAI(apiKey);
};

export const streamChatResponse = async (history, message, attachments, options = {}, onChunk, onError) => {
    try {
        if (!genAI) throw new Error("API Key is not initialized.");

        const modelOptions = {
            model: "gemini-2.5-flash",
            generationConfig: {
                temperature: options.aiTemperature ?? 0.7
            }
        };

        if (options.systemInstruction && options.systemInstruction.trim() !== '') {
            modelOptions.systemInstruction = options.systemInstruction.trim();
        }

        const model = genAI.getGenerativeModel(modelOptions);

        // Format history for Gemini chat format
        const formattedHistory = history.map(msg => ({
            role: msg.role === 'model' ? 'model' : 'user',
            parts: [
                { text: msg.actualPrompt || msg.content },
                ...(msg.attachments || []).map(att => ({
                    inlineData: {
                        data: att.data,
                        mimeType: att.mimeType
                    }
                }))
            ]
        }));

        const chat = model.startChat({
            history: formattedHistory,
        });

        const parts = [{ text: message }];
        if (attachments && attachments.length > 0) {
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
    } catch (error) {
        console.error("Gemini API Error:", error);
        onError(error.message || "An error occurred while generating the response.");
    }
};
