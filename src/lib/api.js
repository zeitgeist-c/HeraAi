import { GoogleGenerativeAI } from '@google/generative-ai'

export const DEFAULT_MODEL = 'gemini-3.1-flash-lite'
export const MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
]
const GEMINI_TIMEOUT_MS = 30000
const TAVILY_TIMEOUT_MS = 15000
const RESEARCH_CONTEXT_TURNS = 6
const RESEARCH_CONTEXT_MAX_CHARS = 2200
const RESEARCH_QUERY_MAX_CHARS = 240

function createAbortError() {
  const err = new Error('Request aborted')
  err.name = 'AbortError'
  return err
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError()
}

function withTimeout(promise, ms) {
  let timeoutId
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Request timeout')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId))
}

function validKeys(keys) {
  return (keys || []).filter(entry => entry?.key?.trim())
}

function classifyGeminiError(err) {
  const msg = err?.message || ''
  const status = err?.status || err?.code || 0

  if (status === 429 || msg.includes('RATE_LIMIT') || msg.includes('rate_limit')) return 'cooldown'
  if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota') || msg.includes('exhausted')) return 'quota_exceeded'
  if (status === 400 || status === 401 || status === 403 || msg.includes('API_KEY_INVALID')) return 'error'
  if (msg.includes('SAFETY') || msg.includes('blocked') || msg.includes('safety')) return 'error'
  return 'cooldown'
}

function classifyTavilyStatus(status) {
  if (status === 429) return 'cooldown'
  if (status === 401 || status === 403) return 'error'
  if (status >= 500) return 'cooldown'
  return 'error'
}

function testKeyErrorType(provider, err) {
  if (err?.name === 'AbortError') return 'timeout'
  if (provider === 'gemini') {
    const status = err?.status || err?.code || 0
    const msg = err?.message || ''
    if (status === 429 || msg.includes('RATE_LIMIT') || msg.includes('rate_limit')) return 'rate_limit'
    if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota') || msg.includes('exhausted')) return 'quota'
    if (status === 400 || status === 401 || status === 403 || msg.includes('API_KEY_INVALID')) return 'invalid'
    if (msg.includes('SAFETY') || msg.includes('blocked') || msg.includes('safety')) return 'invalid'
    return 'network'
  }
  if (provider === 'tavily') {
    const status = err?.status || 0
    if (status === 429) return 'rate_limit'
    if (status === 401 || status === 403) return 'invalid'
    if (status >= 500) return 'network'
    return 'network'
  }
  return 'network'
}

function toGeminiHistory(messages) {
  const history = []

  for (const message of (messages || []).slice(0, -1)) {
    if (!message || (message.role !== 'user' && message.role !== 'model')) continue
    const text = typeof message.content === 'string' ? message.content.trim() : ''
    const isEmptyUiState = (
      message.role === 'model' &&
      ['thinking', 'streaming', 'cancelled_empty'].includes(message.status)
    )
    const isEmptyError = message.role === 'model' && message.status === 'error' && !text
    if (isEmptyUiState || isEmptyError) continue
    if (!text) continue
    if (message.role === 'model' && history.length === 0) continue

    history.push({
      role: message.role === 'model' ? 'model' : 'user',
      parts: [{ text }],
    })
  }

  return history
}

function normalizeTextMessages(messages) {
  const normalized = []

  for (const message of messages || []) {
    if (!message || (message.role !== 'user' && message.role !== 'model')) continue
    const content = typeof message.content === 'string' ? message.content.trim() : ''
    const isEmptyUiState = (
      message.role === 'model' &&
      ['thinking', 'streaming', 'cancelled_empty'].includes(message.status)
    )
    const isEmptyError = message.role === 'model' && message.status === 'error' && !content
    if (isEmptyUiState || isEmptyError) continue
    if (!content) continue
    if (message.role === 'model' && normalized.length === 0) continue
    normalized.push({ ...message, content })
  }

  return normalized
}

function toVisionParts(message, fallbackImage) {
  const parts = [{ text: message?.content || '' }]
  const imageAttachments = (message?.attachments || [])
    .filter(att => att?.mimeType?.startsWith('image/') && att?.data)

  if (imageAttachments.length > 0) {
    for (const imageAttachment of imageAttachments) {
      parts.push({
        inlineData: {
          data: imageAttachment.data,
          mimeType: imageAttachment.mimeType || 'image/png',
        },
      })
    }
  } else if (fallbackImage) {
    parts.push({
      inlineData: {
        data: fallbackImage,
        mimeType: 'image/png',
      },
    })
  }

  return parts
}

async function* streamGeminiWithFallback(keys, createRequest, signal) {
  const entries = validKeys(keys)
  if (entries.length === 0) {
    yield { event: 'error', data: { message: 'Gemini API key gerekli. Ayarlardan bir Gemini anahtari ekleyin.' } }
    return
  }

  let lastError = null

  for (const entry of entries) {
    let hasStartedStreaming = false
    try {
      throwIfAborted(signal)
      const genAI = new GoogleGenerativeAI(entry.key.trim())
      const stream = await withTimeout(createRequest(genAI), GEMINI_TIMEOUT_MS)

      yield { event: 'key_status', data: { provider: 'gemini', keyId: entry.id, status: 'success' } }

      for await (const chunk of stream) {
        throwIfAborted(signal)
        const text = chunk.text()
        if (text) {
          hasStartedStreaming = true
          yield { event: 'chunk', data: { text } }
        }
      }
      return
    } catch (err) {
      if (err.name === 'AbortError') throw err
      lastError = err
      const status = classifyGeminiError(err)
      yield { event: 'key_status', data: { provider: 'gemini', keyId: entry.id, status } }

      if (hasStartedStreaming || status === 'error') {
        yield { event: 'error', data: { message: 'Gemini yaniti olusturulamadi. Lutfen API anahtarinizi kontrol edin.' } }
        return
      }
    }
  }

  console.error('Gemini keys exhausted')
  yield { event: 'error', data: { message: 'Tum Gemini anahtarlari denendi ancak yanit alinamadi.' } }
}

export async function* streamChat(messages, options = {}, geminiKeys = [], signal, model) {
  const lastMsg = messages[messages.length - 1]
  const modelId = model || DEFAULT_MODEL

  yield* streamGeminiWithFallback(geminiKeys, async (genAI) => {
    const genModel = genAI.getGenerativeModel({
      model: modelId,
      ...(options.systemInstruction?.trim() ? { systemInstruction: options.systemInstruction.trim() } : {}),
    })
    const chat = genModel.startChat({ history: toGeminiHistory(messages) })
    const result = await chat.sendMessageStream(lastMsg?.content || '')
    return result.stream
  }, signal)
}

export async function* streamVision(messages, image, options = {}, geminiKeys = [], signal, model) {
  const lastMsg = messages[messages.length - 1]
  const modelId = model || DEFAULT_MODEL

  yield* streamGeminiWithFallback(geminiKeys, async (genAI) => {
    const genModel = genAI.getGenerativeModel({
      model: modelId,
      ...(options.systemInstruction?.trim() ? { systemInstruction: options.systemInstruction.trim() } : {}),
    })
    const chat = genModel.startChat({ history: toGeminiHistory(messages) })
    const result = await chat.sendMessageStream(toVisionParts(lastMsg, image))
    return result.stream
  }, signal)
}

async function searchTavily(question, tavilyKeys, signal) {
  const entries = validKeys(tavilyKeys)
  if (entries.length === 0) {
    return {
      error: { message: 'Web arastirma icin Tavily API key gerekli. Ayarlardan Tavily anahtari ekleyin.' },
    }
  }

  let lastError = null

  for (const entry of entries) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TAVILY_TIMEOUT_MS)
    const abortHandler = () => controller.abort()
    signal?.addEventListener('abort', abortHandler, { once: true })

    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: entry.key.trim(),
          query: question,
          max_results: 10,
          include_answer: false,
          include_raw_content: false,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const status = classifyTavilyStatus(response.status)
        return {
          keyStatus: { provider: 'tavily', keyId: entry.id, status },
          retryable: status === 'cooldown',
          error: new Error(`Tavily HTTP ${response.status}`),
        }
      }

      const data = await response.json()
      return {
        keyStatus: { provider: 'tavily', keyId: entry.id, status: 'success' },
        results: (data.results || []).map(result => ({
          title: result.title,
          url: result.url,
          content: result.content,
          score: result.score,
        })),
      }
    } catch (err) {
      if (signal?.aborted || err.name === 'AbortError') throw createAbortError()
      lastError = err
      return {
        keyStatus: { provider: 'tavily', keyId: entry.id, status: 'cooldown' },
        retryable: true,
        error: err,
      }
    } finally {
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', abortHandler)
    }
  }

  return { error: lastError || new Error('Tavily search failed') }
}

function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) return text || ''
  return `${text.slice(0, maxLength - 1).trim()}...`
}

function sanitizeResearchQuery(text) {
  return truncateText(
    (text || '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
    RESEARCH_QUERY_MAX_CHARS
  )
}

function buildConversationContext(messages) {
  const contextMessages = normalizeTextMessages(messages)
    .slice(0, -1)
    .slice(-RESEARCH_CONTEXT_TURNS)

  const context = contextMessages.map(message => {
    const speaker = message.role === 'user' ? 'Kullanici' : 'HeraAi'
    return `${speaker}: ${truncateText(message.content, 500)}`
  }).join('\n')

  return truncateText(context, RESEARCH_CONTEXT_MAX_CHARS)
}

function buildFallbackResearchQuery(conversationMessages, question) {
  const previousUser = [...conversationMessages]
    .slice(0, -1)
    .reverse()
    .find(message => message.role === 'user')
  return sanitizeResearchQuery(previousUser?.content ? `${previousUser.content} ${question}` : question)
}

function buildResearchQueryPrompt(context, question) {
  return `Sen bir web arama sorgusu hazirlama yardimcisisin.

Gorev: Kullanici takip sorusu kisa veya belirsizse, onceki konusma baglamini kullanarak tek satirlik acik bir web arama sorgusu yaz.

Kurallar:
- Sadece arama sorgusunu yaz.
- Cevap verme, aciklama yapma.
- Turkce yaz.
- Soru onceki baglama bagliysa baglamdaki ana konuyu sorguya ekle.
- Tarih/zaman sorularinda bugunun tarihini koru: ${new Date().toISOString().slice(0, 10)}.

Konusma baglami:
${context || '(baglam yok)'}

Son kullanici sorusu:
${question}`
}

async function generateResearchQuery(conversationMessages, question, geminiKeys, signal, model) {
  const fallbackQuery = buildFallbackResearchQuery(conversationMessages, question)
  const context = buildConversationContext(conversationMessages)
  const entries = validKeys(geminiKeys)
  const modelId = model || DEFAULT_MODEL

  if (entries.length === 0) {
    return { query: fallbackQuery, context, keyStatuses: [] }
  }

  const keyStatuses = []
  for (const entry of entries) {
    try {
      throwIfAborted(signal)
      const genAI = new GoogleGenerativeAI(entry.key.trim())
      const genModel = genAI.getGenerativeModel({ model: modelId })
      const result = await withTimeout(
        genModel.generateContent(buildResearchQueryPrompt(context, question)),
        GEMINI_TIMEOUT_MS
      )
      const text = sanitizeResearchQuery(result?.response?.text?.() || '')
      if (text) {
        keyStatuses.push({ provider: 'gemini', keyId: entry.id, status: 'success' })
        return { query: text, context, keyStatuses }
      }
      keyStatuses.push({ provider: 'gemini', keyId: entry.id, status: 'cooldown' })
    } catch (err) {
      if (err.name === 'AbortError') throw err
      keyStatuses.push({ provider: 'gemini', keyId: entry.id, status: classifyGeminiError(err) })
    }
  }

  return { query: fallbackQuery, context, keyStatuses }
}

function buildResearchPrompt(question, researchQuery, conversationContext, results) {
  const context = results.map((result, index) => (
    `[${index + 1}] ${result.title}\nURL: ${result.url}\nContent: ${result.content || ''}`
  )).join('\n\n')

  return `Bugunun tarihi: ${new Date().toISOString().slice(0, 10)}

Orijinal kullanici sorusu: ${question}

Web arama sorgusu: ${researchQuery}

Kisa konusma baglami:
${conversationContext || '(baglam yok)'}

Gorev: Web arama sorgusunu degil, orijinal kullanici sorusunu cevapla. Konusma baglamindan kopma. Asagidaki web arama sonuclarini kullanarak Turkce, net ve kaynaklara dayali yanit ver. Kaynaklar soruyla alakasizsa uydurma bilgi ekleme; kaynaklarin yeterli olmadigini acikca soyle. Kaynak numaralarini ilgili cumlelerde [1], [2] biciminde kullan.

Web arama sonuclari:
${context}`
}

export async function* streamResearch(input, geminiKeys = [], tavilyKeys = [], signal, model) {
  const conversationMessages = Array.isArray(input)
    ? normalizeTextMessages(input)
    : normalizeTextMessages([{ role: 'user', content: input }])
  const lastUserMessage = [...conversationMessages].reverse().find(message => message.role === 'user')
  const question = lastUserMessage?.content || ''

  const entries = validKeys(tavilyKeys)
  if (entries.length === 0) {
    yield { event: 'error', data: { message: 'Web arastirma icin Tavily API key gerekli. Ayarlardan Tavily anahtari ekleyin.' } }
    return
  }

  const queryResult = await generateResearchQuery(conversationMessages, question, geminiKeys, signal, model)
  for (const keyStatus of queryResult.keyStatuses) {
    yield { event: 'key_status', data: keyStatus }
  }

  let searchResult = null
  for (const entry of entries) {
    searchResult = await searchTavily(queryResult.query, [entry], signal)
    if (searchResult.keyStatus) {
      yield { event: 'key_status', data: searchResult.keyStatus }
    }
    if (searchResult.results) break
    if (!searchResult.retryable) break
  }

  if (!searchResult?.results) {
    console.error('Tavily search failed')
    yield { event: 'error', data: { message: searchResult?.error?.message || 'Web aramasi yapilamadi.' } }
    return
  }

  if (searchResult.results.length === 0) {
    yield { event: 'error', data: { message: 'Web aramasi sonuc vermedi.' } }
    return
  }

  const messages = conversationMessages.length > 0
    ? [
        ...conversationMessages.slice(0, -1),
        {
          ...conversationMessages[conversationMessages.length - 1],
          content: buildResearchPrompt(question, queryResult.query, queryResult.context, searchResult.results),
        },
      ]
    : [{ role: 'user', content: buildResearchPrompt(question, queryResult.query, queryResult.context, searchResult.results) }]
  for await (const evt of streamChat(messages, {}, geminiKeys, signal, model)) {
    yield evt
    if (evt.event === 'error') return
  }
  yield {
    event: 'sources',
    data: {
      sources: searchResult.results.map((result, index) => ({
        index: index + 1,
        title: result.title,
        url: result.url,
      })),
    },
  }
}

export async function testKey(provider, key) {
  const normalizedKey = typeof key === 'string' ? key.trim() : ''
  if (provider === 'gemini') {
    try {
      const genAI = new GoogleGenerativeAI(normalizedKey)
      const model = genAI.getGenerativeModel({ model: DEFAULT_MODEL })
      await model.generateContent('test')
      return { success: true, provider }
    } catch (err) {
      if (err?.name === 'AbortError') {
        return { success: false, provider, errorType: 'timeout' }
      }
      console.error('Gemini key test failed')
      return { success: false, provider, errorType: testKeyErrorType('gemini', err) }
    }
  }

  if (provider === 'tavily') {
    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: normalizedKey, query: 'test', max_results: 1 }),
      })
      if (response.ok) return { success: true, provider }
      return { success: false, provider, errorType: testKeyErrorType('tavily', { status: response.status }) }
    } catch (err) {
      if (err?.name === 'AbortError') {
        return { success: false, provider, errorType: 'timeout' }
      }
      console.error('Tavily key test failed')
      return { success: false, provider, errorType: 'network' }
    }
  }

  return { success: false, provider, errorType: 'invalid' }
}
