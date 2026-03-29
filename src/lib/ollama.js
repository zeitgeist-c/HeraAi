import { filterAttachmentsForModel } from './modelCapabilities';

const OLLAMA_BASE_URL = 'https://ollama.com/api'

let ollamaKey = null
let currentProvider = 'google'

export const OLLAMA_CLOUD_MODELS = [
    { id: 'gpt-oss:120b-cloud', name: 'GPT-Oss 120B Cloud', provider: 'ollama', supports: { text: true, image: false, pdf: false } },
    { id: 'gpt-oss:20b-cloud', name: 'GPT-Oss 20B Cloud', provider: 'ollama', supports: { text: true, image: false, pdf: false } },
    { id: 'qwen3-coder:480b-cloud', name: 'Qwen3 Coder 480B Cloud', provider: 'ollama', supports: { text: true, image: false, pdf: false } },
    { id: 'deepseek-v3.1:671b-cloud', name: 'DeepSeek V3.1 671B Cloud', provider: 'ollama', supports: { text: true, image: false, pdf: false } },
    { id: 'qwen3-vl:235b-cloud', name: 'Qwen3 VL 235B Cloud', provider: 'ollama', supports: { text: true, image: true, pdf: false } },
    { id: 'kimi-k2.5-cloud', name: 'Kimi K2.5 Cloud', provider: 'ollama', supports: { text: true, image: true, pdf: false } },
    { id: 'gemma3:27b-cloud', name: 'Gemma 3 27B Cloud', provider: 'ollama', supports: { text: true, image: true, pdf: false } },
    { id: 'gemma3:12b-cloud', name: 'Gemma 3 12B Cloud', provider: 'ollama', supports: { text: true, image: true, pdf: false } },
    { id: 'gemma3:4b-cloud', name: 'Gemma 3 4B Cloud', provider: 'ollama', supports: { text: true, image: true, pdf: false } },
    { id: 'minimax-m2.7-cloud', name: 'MiniMax M2.7 Cloud', provider: 'ollama', supports: { text: true, image: false, pdf: false } },
    { id: 'minimax-m2.5-cloud', name: 'MiniMax M2.5 Cloud', provider: 'ollama', supports: { text: true, image: false, pdf: false } },
    { id: 'glm-4.7-cloud', name: 'GLM 4.7 Cloud', provider: 'ollama', supports: { text: true, image: false, pdf: false } },
    { id: 'mistral-large-3:675b-cloud', name: 'Mistral Large 3 675B Cloud', provider: 'ollama', supports: { text: true, image: false, pdf: false } },
]

const MAX_RETRIES = 3
const RETRY_DELAY = 1000
const REQUEST_TIMEOUT = 120000

export const initOllama = (apiKey) => {
    ollamaKey = apiKey
    currentProvider = 'ollama'
}

export const getCurrentProvider = () => currentProvider

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const sleepWithExponentialBackoff = async (attempt) => {
    const waitTime = RETRY_DELAY * Math.pow(2, attempt)
    await delay(waitTime)
}

let currentAbortController = null

export const cancelOllamaStream = () => {
    if (currentAbortController) {
        currentAbortController.abort()
        currentAbortController = null
        return true
    }
    return false
}

const callOllama = async (model, messages, onChunk, onError, signal) => {
    currentAbortController = new AbortController()
    const timeoutId = setTimeout(() => currentAbortController.abort(), REQUEST_TIMEOUT)
    
    const abortHandler = () => {
        clearTimeout(timeoutId)
        onError('İstek iptal edildi')
    }
    
    const externalSignal = signal
    const signalPromise = externalSignal ? new Promise(resolve => {
        externalSignal.addEventListener('abort', abortHandler)
    }) : Promise.resolve()
    
    try {
        const response = await fetch(`${OLLAMA_BASE_URL}/chat`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${ollamaKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: model,
                messages: messages,
                stream: true
            }),
            signal: currentAbortController.signal
        })
        clearTimeout(timeoutId)
        
        if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`Ollama Error: ${response.status} - ${errorText}`)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
                if (line.trim() === '') continue
                if (line.trim() === '[DONE]') return
                
                try {
                    const json = JSON.parse(line)
                    if (json.message?.content) {
                        onChunk(json.message.content)
                    }
                    if (json.done) return
                } catch (e) {
                    // Ignore parse errors
                }
            }
        }
    } catch (error) {
        clearTimeout(timeoutId)
        if (error.name === 'AbortError') {
            const isExternalAbort = externalSignal?.aborted
            if (!isExternalAbort) {
                onError('İstek iptal edildi')
            }
        } else {
            throw error
        }
    } finally {
        if (externalSignal) {
            externalSignal.removeEventListener('abort', abortHandler)
        }
        currentAbortController = null
    }
}

export const streamChatResponse = async (history, message, attachments, options = {}, onChunk, onError) => {
    const model = options.selectedModel || 'gemma3:12b'
    const apiProvider = currentProvider
    
    console.log('[Ollama] API Call - Provider:', apiProvider, 'Model:', model, 'Attachments:', attachments?.length || 0)
    
    if (apiProvider !== 'ollama') {
        throw new Error('Ollama provider not initialized')
    }
    
    if (!ollamaKey) {
        onError('Ollama API Key ayarlanmamış. Lütfen ayarlardan API key girin.')
        return
    }
    
    const filteredAttachments = filterAttachmentsForModel(attachments || [], model, 'ollama')
    const hadImageAttachments = (attachments?.length || 0) > filteredAttachments.length
    
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            let messageToSend = (message || '').trim()
            if (!messageToSend && filteredAttachments.length > 0) {
                if (hadImageAttachments) {
                    messageToSend = 'Bu görseli analiz et'
                } else if (filteredAttachments.length > 0) {
                    messageToSend = 'Bu dosyayı analiz et'
                }
            }
            
            const formatOllamaMessage = (msg) => {
                const content = msg?.content ?? ''
                return { role: msg?.role === 'model' ? 'assistant' : 'user', content }
            }
            
            const buildOllamaContent = (text, atts) => {
                if (!atts || atts.length === 0) {
                    return text
                }
                
                const parts = []
                if (text && text.trim()) {
                    parts.push({ type: 'text', text: text.trim() })
                }
                
                atts.forEach(att => {
                    if (att.mimeType?.startsWith('image/')) {
                        parts.push({
                            type: 'image_url',
                            image_url: {
                                url: `data:${att.mimeType};base64,${att.data}`
                            }
                        })
                    } else if (att.mimeType === 'application/pdf' || att.name?.toLowerCase().endsWith('.pdf')) {
                        parts.push({
                            type: 'text',
                            text: `[PDF Attachment: ${att.name}]`
                        })
                    } else {
                        parts.push({
                            type: 'text',
                            text: `[Attachment: ${att.name}]`
                        })
                    }
                })
                
                return parts.length > 0 ? parts : text
            }
            
            const formattedMessages = history
                .filter(m => m.role !== 'system')
                .map(formatOllamaMessage)
            
            const userMessage = {
                role: 'user',
                content: buildOllamaContent(messageToSend, filteredAttachments)
            }
            
            if (options.systemInstruction && options.systemInstruction.trim()) {
                formattedMessages.unshift({
                    role: 'system',
                    content: options.systemInstruction.trim()
                })
            }
            
            formattedMessages.push(userMessage)
            
            await callOllama(model, formattedMessages, onChunk, onError, options.signal)
            return
            
        } catch (error) {
            console.error(`[Ollama] Error (attempt ${attempt + 1}/${MAX_RETRIES}):`, error)
            
            if (error.name === 'AbortError' || error.message?.includes('abort')) {
                return
            }
            
            if (error.message?.includes('401') || error.message?.includes('unauthorized')) {
                onError('Ollama API key geçersiz. Lütfen ayarlardan kontrol edin.')
                return
            }
            
            if (error.message?.includes('429') || error.message?.includes('rate limit') || error.message?.includes('usage') || error.message?.includes('limit')) {
                if (attempt < MAX_RETRIES - 1) {
                    await sleepWithExponentialBackoff(attempt)
                    continue
                }
                onError('Ollama Cloud ücretsiz kullanım sınırı aşıldı. Daha sonra tekrar deneyin veya Pro plan düşünün.')
                return
            }
            
            if (error.message?.includes('model')) {
                onError('Model bulunamadı. Lütfen farklı bir model seçin.')
                return
            }
            
            if (attempt === MAX_RETRIES - 1) {
                onError(`Ollama hatası: ${error.message || 'Bilinmeyen hata'}`
            )
                return
            }
            
            await sleepWithExponentialBackoff(attempt)
        }
    }
}

export const fetchOllamaModels = async (apiKey) => {
    if (!apiKey) return OLLAMA_CLOUD_MODELS
    
    try {
        const response = await fetch(`${OLLAMA_BASE_URL}/tags`, {
            headers: {
                'Authorization': `Bearer ${apiKey}`
            }
        })
        
        if (!response.ok) {
            console.log('[Ollama] /tags endpoint returned', response.status, '- using static cloud models')
            return OLLAMA_CLOUD_MODELS
        }
        
        const data = await response.json()
        
        if (!data.models || !Array.isArray(data.models) || data.models.length === 0) {
            console.log('[Ollama] No local models found - using static cloud models')
            return OLLAMA_CLOUD_MODELS
        }
        
        const localModels = data.models.map(m => ({
            id: m.name,
            name: m.name,
            provider: 'ollama',
            supportedModalities: m.details?.modalities || ['text'],
            supports: {
                text: true,
                image: m.details?.modalities?.includes('image') || false,
                pdf: false,
            },
            contextLength: m.details?.context_length || 4096,
            description: m.description || '',
        }))
        
        const allModels = [...OLLAMA_CLOUD_MODELS, ...localModels]
        
        console.log('[Ollama] Fetched models:', allModels.length, 'cloud:', OLLAMA_CLOUD_MODELS.length, 'local:', localModels.length)
        return allModels
        
    } catch (error) {
        console.error('[Ollama] Failed to fetch local models:', error.message, '- using static cloud models')
        return OLLAMA_CLOUD_MODELS
    }
}