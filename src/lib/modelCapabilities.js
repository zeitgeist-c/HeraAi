import { OLLAMA_CLOUD_MODELS } from './ollama';

const OLLAMA_IMAGE_MODELS = [
    'qwen3-vl:235b',
    'kimi-k2.5',
    'gemma3:27b',
    'gemma3:12b',
    'gemma3:4b',
];

export const modelSupportsImage = (modelId, provider) => {
    if (provider === 'ollama') {
        const cleanId = modelId.replace('-cloud', '');
        
        if (OLLAMA_CLOUD_MODELS.some(m => m.id === modelId)) {
            const cloudModel = OLLAMA_CLOUD_MODELS.find(m => m.id === modelId);
            return cloudModel?.supports?.image ?? false;
        }
        
        if (OLLAMA_IMAGE_MODELS.some(m => cleanId.startsWith(m))) {
            return true;
        }
        
        return false;
    }
    
    if (provider === 'openrouter') {
        const lowerId = modelId.toLowerCase();
        
        if (lowerId.includes('gpt-4o') || 
            lowerId.includes('gpt-4-turbo') ||
            lowerId.includes('gpt-4') ||
            lowerId.includes('claude') ||
            lowerId.includes('gemini') ||
            lowerId.includes('vision') ||
            lowerId.includes('vl ') ||
            lowerId.includes('qwen2.5-vl') ||
            lowerId.includes('qwen-vl') ||
            lowerId.includes('mistral-large') ||
            lowerId.includes('kimi')) {
            return true;
        }
        
        return false;
    }
    
    return false;
};

export const filterAttachmentsForModel = (attachments, modelId, provider) => {
    const supportsImages = modelSupportsImage(modelId, provider);
    
    if (supportsImages) {
        return attachments;
    }
    
    const filtered = attachments.filter(att => !att.mimeType?.startsWith('image/'));
    const removedImages = attachments.filter(att => att.mimeType?.startsWith('image/'));
    
    if (removedImages.length > 0) {
        console.warn(`Model ${modelId} does not support images. Removed ${removedImages.length} image(s).`);
    }
    
    return filtered;
};
