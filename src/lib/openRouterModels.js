const CACHE_KEY = 'heraai_openrouter_models_cache'
const CACHE_DURATION = 24 * 60 * 60 * 1000

const isFreeModel = (model) => {
    if (!model.pricing) return false
    const promptPrice = model.pricing.prompt
    return promptPrice === 0 || promptPrice === '0' || promptPrice === null || promptPrice === undefined
}

export const fetchOpenRouterModels = async (apiKey) => {
    const cached = await chrome.storage.local.get([CACHE_KEY])
    const now = Date.now()
    
    if (cached[CACHE_KEY] && cached[CACHE_KEY].expires > now) {
        console.log('[OpenRouter Models] Using cached models, count:', cached[CACHE_KEY].models.length)
        return cached[CACHE_KEY].models
    }
    
    try {
        const headers = {}
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`
        }
        
        const response = await fetch('https://openrouter.ai/api/v1/models', { headers })
        
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
        
        const data = await response.json()
        
        if (!data.data || !Array.isArray(data.data)) {
            throw new Error('Invalid API response format')
        }
        
        const models = data.data.map(m => {
            const provider = m.id.includes('/') ? m.id.split('/')[0] : 'other'
            const supportedModalities = m.input_modalities || m.supported_modalities || ['text']
            
            return {
                id: m.id,
                name: m.name || m.id,
                provider: provider,
                supportedModalities: supportedModalities,
                supports: {
                    text: supportedModalities.includes('text'),
                    image: supportedModalities.includes('image'),
                    pdf: supportedModalities.includes('file'),
                    audio: supportedModalities.includes('audio'),
                    video: supportedModalities.includes('video'),
                },
                contextLength: m.context_length || m.max_tokens || 4096,
                pricing: m.pricing || { prompt: null, completion: null },
                description: m.description || '',
            }
        })
        
        const freeModels = models.filter(isFreeModel)
        const paidModels = models.filter(m => !isFreeModel(m))
        
        const sortedModels = [
            ...freeModels.sort((a, b) => a.name.localeCompare(b.name)),
            ...paidModels.sort((a, b) => a.name.localeCompare(b.name))
        ]
        
        console.log('[OpenRouter Models] Fetched:', models.length, 'models,', freeModels.length, 'free')
        
        await chrome.storage.local.set({
            [CACHE_KEY]: { 
                models: sortedModels, 
                expires: now + CACHE_DURATION,
                fetchedAt: new Date().toISOString()
            }
        })
        
        return sortedModels
    } catch (error) {
        console.error('[OpenRouter Models] Fetch failed:', error)
        if (cached[CACHE_KEY]) {
            console.log('[OpenRouter Models] Falling back to cached models')
            return cached[CACHE_KEY].models
        }
        return []
    }
}

export const clearModelsCache = () => {
    chrome.storage.local.remove([CACHE_KEY])
    console.log('[OpenRouter Models] Cache cleared')
}