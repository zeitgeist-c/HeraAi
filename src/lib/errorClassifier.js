export const ErrorType = {
    QUOTA_EXCEEDED: {
        codes: ['quota', 'exceeded', 'insufficient', 'credits', 'limit', '429'],
        userMessage: 'API kota aşıldı. Lütfen daha sonra tekrar deneyin.'
    },
    INVALID_API_KEY: {
        codes: ['api_key', 'unauthorized', 'invalid', '401', '403'],
        userMessage: 'API anahtarı geçersiz. Lütfen ayarlardan kontrol edin.'
    },
    RATE_LIMITED: {
        codes: ['rate_limit', '429', 'too_many'],
        userMessage: 'Çok fazla istek. Lütfen biraz bekleyin.'
    },
    OLLAMA_USAGE_LIMIT: {
        codes: ['usage', 'limit', 'exceeded', 'quota', '429', 'too_many_requests', 'rate_limit'],
        userMessage: 'Ollama Cloud ücretsiz kullanım sınırı aşıldı. Daha sonra tekrar deneyin veya Pro plan düşünün.'
    },
    MODEL_NOT_FOUND: {
        codes: ['model_not_found', 'unknown_model', '404'],
        userMessage: 'Model bulunamadı. Farklı bir model seçin.'
    },
    CONTEXT_LENGTH: {
        codes: ['context_length', 'tokens', 'max_tokens', '413'],
        userMessage: 'Mesaj çok uzun. Lütfen kısaltın.'
    },
    IMAGE_NOT_SUPPORTED: {
        codes: ['image', 'vision', 'multimodal', 'does not support image'],
        userMessage: 'Bu model resim desteklemiyor. GPT-4o, Claude veya Gemini kullanın.'
    },
    NETWORK_ERROR: {
        codes: ['network', 'enotfound', 'etimedout', 'fetch failed', 'failed to fetch'],
        userMessage: 'Ağ hatası. İnternet bağlantınızı kontrol edin.'
    },
    SERVER_ERROR: {
        codes: ['500', '502', '503', 'server_error', 'bad_gateway', 'service_unavailable'],
        userMessage: 'Sunucu hatası. Daha sonra tekrar deneyin.'
    },
    UNKNOWN: {
        codes: [],
        userMessage: 'Bilinmeyen hata oluştu.'
    }
}

export const classifyError = (errorMsg) => {
    const msg = (errorMsg || '').toLowerCase()
    for (const [type, config] of Object.entries(ErrorType)) {
        if (config.codes.some(code => msg.includes(code))) {
            return { type, ...config, originalError: errorMsg }
        }
    }
    return { type: 'UNKNOWN', ...ErrorType.UNKNOWN, originalError: errorMsg }
}