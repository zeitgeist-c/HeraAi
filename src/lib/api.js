import { GoogleGenAI } from '@google/genai'

export const DEFAULT_MODEL = 'gemini-3.1-flash-lite'
export const MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
]
const GEMINI_API_VERSION = 'v1'
const GEMINI_DEFAULT_REQUEST_TIMEOUT_MS = 60000
const GEMINI_REASONING_REQUEST_TIMEOUT_MS = 120000
const GEMINI_STREAM_IDLE_TIMEOUT_MS = 120000
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

function createTimeoutError() {
  const error = new Error('Request timeout')
  error.name = 'TimeoutError'
  return error
}

function getGeminiRequestTimeoutMs(modelId) {
  return modelId === 'gemini-3.5-flash' || modelId === 'gemini-3.6-flash'
    ? GEMINI_REASONING_REQUEST_TIMEOUT_MS
    : GEMINI_DEFAULT_REQUEST_TIMEOUT_MS
}

function createGeminiClient(apiKey) {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion: GEMINI_API_VERSION,
    },
  })
}

async function startGeminiRequest(createRequest, timeoutMs, parentSignal) {
  throwIfAborted(parentSignal)
  const controller = new AbortController()
  const forwardParentAbort = () => controller.abort()
  parentSignal?.addEventListener('abort', forwardParentAbort, { once: true })
  if (parentSignal?.aborted) {
    parentSignal.removeEventListener('abort', forwardParentAbort)
    throw createAbortError()
  }

  let timedOut = false
  let timeoutId
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true
      const error = createTimeoutError()
      reject(error)
      controller.abort()
    }, timeoutMs)
  })

  const cleanup = () => {
    clearTimeout(timeoutId)
    parentSignal?.removeEventListener('abort', forwardParentAbort)
  }

  try {
    const result = await Promise.race([
      Promise.resolve().then(() => createRequest(controller.signal)),
      timeout,
    ])
    clearTimeout(timeoutId)
    return {
      result,
      requestSignal: controller.signal,
      abortRequest: () => controller.abort(),
      cleanup,
    }
  } catch (error) {
    cleanup()
    if (parentSignal?.aborted) throw createAbortError()
    if (timedOut || error?.name === 'AbortError') throw createTimeoutError()
    throw error
  }
}

async function runGeminiRequest(createRequest, timeoutMs, signal) {
  const request = await startGeminiRequest(createRequest, timeoutMs, signal)
  try {
    return request.result
  } finally {
    request.cleanup()
  }
}

function nextStreamChunk(iterator, signal, abortRequest) {
  throwIfAborted(signal)

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', handleAbort)
      callback(value)
    }
    const handleAbort = () => finish(reject, createAbortError())
    const timeoutId = setTimeout(() => {
      const error = new Error('Gemini response stream timed out')
      error.name = 'StreamTimeoutError'
      finish(reject, error)
      abortRequest?.()
    }, GEMINI_STREAM_IDLE_TIMEOUT_MS)

    signal?.addEventListener('abort', handleAbort, { once: true })
    Promise.resolve().then(() => iterator.next()).then(
      result => finish(resolve, result),
      error => finish(reject, error),
    )
  })
}

function validKeys(keys) {
  return (keys || []).filter(entry => entry?.key?.trim())
}

function getGeminiErrorText(err) {
  return [
    err?.message,
    err?.statusText,
    err?.error?.message,
    err?.cause?.message,
  ].filter(Boolean).join(' ').toLowerCase()
}

function getGeminiHttpStatus(err) {
  const candidates = [err?.status, err?.error?.code, err?.code]
  for (const candidate of candidates) {
    const numericStatus = Number(candidate)
    if (Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599) {
      return numericStatus
    }
  }

  const match = getGeminiErrorText(err).match(/\b(400|401|403|404|408|409|429|500|502|503|504)\b/)
  return match ? Number(match[1]) : 0
}

function classifyGeminiError(err) {
  const message = getGeminiErrorText(err)
  const status = getGeminiHttpStatus(err)

  if (
    err?.name === 'TimeoutError'
    || err?.name === 'StreamTimeoutError'
    || err?.name === 'AbortError'
    || status === 408
    || status === 504
    || message.includes('timed out')
    || message.includes('timeout')
  ) return 'timeout'
  if (message.includes('rate_limit') || message.includes('rate limit') || message.includes('too many requests')) return 'cooldown'
  if (message.includes('resource_exhausted') || message.includes('quota') || message.includes('exhausted')) return 'quota_exceeded'
  if (status === 429) return 'cooldown'
  if (message.includes('safety') || message.includes('blocked')) return 'safety'
  if (message.includes('api_key_invalid') || status === 401) return 'invalid_key'
  if (message.includes('failed_precondition') || message.includes('billing')) return 'billing_required'
  if (
    status === 404
    || message.includes('not_found')
    || message.includes('not found')
    || (message.includes('model') && message.includes('unsupported'))
  ) return 'model_unavailable'
  if (status === 403 || message.includes('permission_denied')) return 'permission_denied'
  if (status >= 500) return 'service_unavailable'
  if (status === 400 || message.includes('invalid_argument')) return 'invalid_request'
  if (
    err instanceof TypeError
    || message.includes('failed to fetch')
    || message.includes('network')
    || message.includes('econnreset')
    || message.includes('enotfound')
  ) return 'network'
  return 'generation_failed'
}

function geminiErrorCode(classification) {
  const codes = {
    timeout: 'timeout',
    cooldown: 'rate_limited',
    quota_exceeded: 'quota_exceeded',
    invalid_key: 'api_key_invalid',
    permission_denied: 'permission_denied',
    model_unavailable: 'model_unavailable',
    billing_required: 'billing_required',
    service_unavailable: 'service_unavailable',
    invalid_request: 'invalid_request',
    network: 'network_error',
  }
  return codes[classification] || 'generation_failed'
}

function geminiKeyStatus(classification) {
  if (classification === 'cooldown') return 'cooldown'
  if (classification === 'quota_exceeded') return 'quota_exceeded'
  if (classification === 'invalid_key') return 'error'
  if (classification === 'network') return 'network'
  return null
}

function logGeminiFailure(modelId, classification, err) {
  console.error('Gemini request failed', {
    model: modelId,
    reason: classification,
    httpStatus: getGeminiHttpStatus(err) || null,
  })
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
    const classification = classifyGeminiError(err)
    if (classification === 'cooldown') return 'rate_limit'
    if (classification === 'quota_exceeded') return 'quota'
    if (classification === 'timeout') return 'timeout'
    if (classification === 'model_unavailable') return 'model_unavailable'
    if (classification === 'service_unavailable') return 'service_unavailable'
    if (classification === 'billing_required') return 'billing_required'
    if (classification === 'permission_denied') return 'permission_denied'
    if (classification === 'network') return 'network'
    return 'invalid'
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

function toGeminiContents(messages, fallbackImage = null) {
  const contents = []

  for (const message of messages || []) {
    if (!message || (message.role !== 'user' && message.role !== 'model')) continue
    const text = typeof message.content === 'string' ? message.content.trim() : ''
    const isEmptyUiState = (
      message.role === 'model' &&
      ['thinking', 'streaming', 'cancelled_empty'].includes(message.status)
    )
    const isEmptyError = message.role === 'model' && message.status === 'error' && !text
    if (isEmptyUiState || isEmptyError) continue
    const imageAttachments = (message.attachments || [])
      .filter(attachment => attachment?.mimeType?.startsWith('image/') && attachment?.data)
    const parts = []
    if (text) parts.push({ text })
    for (const attachment of imageAttachments) {
      parts.push({
        inlineData: {
          data: attachment.data,
          mimeType: attachment.mimeType || 'image/png',
        },
      })
    }
    if (message === (messages || []).at(-1) && imageAttachments.length === 0 && fallbackImage) {
      parts.push({ inlineData: { data: fallbackImage, mimeType: 'image/png' } })
    }
    if (parts.length === 0) continue
    if (message.role === 'model' && contents.length === 0) continue

    contents.push({
      role: message.role === 'model' ? 'model' : 'user',
      parts,
    })
  }

  return contents
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

async function* streamGeminiWithFallback(keys, createStreamRequest, createFallbackRequest, signal, modelId) {
  const entries = validKeys(keys)
  if (entries.length === 0) {
    yield { event: 'error', data: { code: 'api_key_missing', message: 'Gemini API key gerekli. Ayarlardan bir Gemini anahtari ekleyin.' } }
    return
  }

  let lastError = null
  let lastClassification = 'generation_failed'
  const requestTimeoutMs = getGeminiRequestTimeoutMs(modelId)

  for (const entry of entries) {
    let hasStartedStreaming = false
    let reportedSuccess = false
    let streamRequest = null
    const genAI = createGeminiClient(entry.key.trim())
    try {
      throwIfAborted(signal)
      streamRequest = await startGeminiRequest(
        requestSignal => createStreamRequest(genAI, requestSignal),
        requestTimeoutMs,
        signal,
      )
      const stream = streamRequest.result

      const iterator = stream[Symbol.asyncIterator]()
      while (true) {
        const { value: chunk, done } = await nextStreamChunk(
          iterator,
          streamRequest.requestSignal,
          streamRequest.abortRequest,
        )
        if (done) break
        throwIfAborted(signal)
        const text = chunk.text || ''
        if (text) {
          hasStartedStreaming = true
          if (!reportedSuccess) {
            reportedSuccess = true
            yield { event: 'key_status', data: { provider: 'gemini', keyId: entry.id, status: 'success' } }
          }
          yield { event: 'chunk', data: { text } }
        }
      }

      if (!hasStartedStreaming) {
        const error = new Error('Gemini returned an empty response')
        error.name = 'EmptyResponseError'
        throw error
      }
      return
    } catch (err) {
      streamRequest?.abortRequest()
      streamRequest?.cleanup()
      streamRequest = null
      if (err.name === 'AbortError' && signal?.aborted) throw err
      if (err.name === 'EmptyResponseError') {
        yield { event: 'error', data: { code: 'empty_response', message: 'Gemini bos bir yanit dondurdu. Lutfen yeniden deneyin.' } }
        return
      }
      let resolvedError = err
      let status = classifyGeminiError(resolvedError)

      if (!hasStartedStreaming && status === 'network' && createFallbackRequest) {
        try {
          throwIfAborted(signal)
          const response = await runGeminiRequest(
            requestSignal => createFallbackRequest(genAI, requestSignal),
            requestTimeoutMs,
            signal,
          )
          throwIfAborted(signal)
          const fallbackText = response?.text || ''
          if (!fallbackText) {
            const emptyError = new Error('Gemini returned an empty response')
            emptyError.name = 'EmptyResponseError'
            throw emptyError
          }
          yield { event: 'key_status', data: { provider: 'gemini', keyId: entry.id, status: 'success' } }
          yield { event: 'chunk', data: { text: fallbackText } }
          return
        } catch (fallbackError) {
          if (fallbackError.name === 'AbortError' && signal?.aborted) throw fallbackError
          if (fallbackError.name === 'EmptyResponseError') {
            yield { event: 'error', data: { code: 'empty_response', message: 'Gemini bos bir yanit dondurdu. Lutfen yeniden deneyin.' } }
            return
          }
          resolvedError = fallbackError
          status = classifyGeminiError(resolvedError)
        }
      }

      lastError = resolvedError
      lastClassification = status
      const keyStatus = geminiKeyStatus(status)
      if (keyStatus) {
        yield { event: 'key_status', data: { provider: 'gemini', keyId: entry.id, status: keyStatus } }
      }

      const requestScopedFailure = [
        'timeout',
        'model_unavailable',
        'service_unavailable',
        'invalid_request',
        'safety',
        'generation_failed',
      ].includes(status)
      if (hasStartedStreaming || requestScopedFailure) {
        logGeminiFailure(modelId, status, resolvedError)
        yield {
          event: 'error',
          data: {
            code: geminiErrorCode(status),
            message: 'Gemini yaniti olusturulamadi.',
          },
        }
        return
      }
    } finally {
      streamRequest?.cleanup()
    }
  }

  const code = geminiErrorCode(lastClassification)
  const message = lastClassification === 'network'
    ? 'Gemini ile baglanti kurulamadi. Internet baglantinizi ve tarayici konsolunu kontrol edin.'
    : 'Tum Gemini anahtarlari denendi ancak yanit alinamadi.'
  logGeminiFailure(modelId, lastClassification, lastError)
  yield { event: 'error', data: { code, message } }
}

function createGeminiRequestParameters(messages, options, requestSignal, modelId, fallbackImage = null) {
  return {
    model: modelId,
    contents: toGeminiContents(messages, fallbackImage),
    config: {
      abortSignal: requestSignal,
      ...(options.systemInstruction?.trim() ? { systemInstruction: options.systemInstruction.trim() } : {}),
    },
  }
}

export async function* streamChat(messages, options = {}, geminiKeys = [], signal, model) {
  const modelId = model || DEFAULT_MODEL

  yield* streamGeminiWithFallback(
    geminiKeys,
    (genAI, requestSignal) => genAI.models.generateContentStream(
      createGeminiRequestParameters(messages, options, requestSignal, modelId)
    ),
    (genAI, requestSignal) => genAI.models.generateContent(
      createGeminiRequestParameters(messages, options, requestSignal, modelId)
    ),
    signal,
    modelId,
  )
}

export async function* streamVision(messages, image, options = {}, geminiKeys = [], signal, model) {
  const modelId = model || DEFAULT_MODEL

  yield* streamGeminiWithFallback(
    geminiKeys,
    (genAI, requestSignal) => genAI.models.generateContentStream(
      createGeminiRequestParameters(messages, options, requestSignal, modelId, image)
    ),
    (genAI, requestSignal) => genAI.models.generateContent(
      createGeminiRequestParameters(messages, options, requestSignal, modelId, image)
    ),
    signal,
    modelId,
  )
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
      const requestTimeoutMs = getGeminiRequestTimeoutMs(modelId)
      const genAI = createGeminiClient(entry.key.trim())
      const result = await runGeminiRequest(
        requestSignal => genAI.models.generateContent({
          model: modelId,
          contents: buildResearchQueryPrompt(context, question),
          config: { abortSignal: requestSignal },
        }),
        requestTimeoutMs,
        signal,
      )
      const text = sanitizeResearchQuery(result?.text || '')
      if (text) {
        keyStatuses.push({ provider: 'gemini', keyId: entry.id, status: 'success' })
        return { query: text, context, keyStatuses }
      }
    } catch (err) {
      if (err.name === 'AbortError' && signal?.aborted) throw err
      const keyStatus = geminiKeyStatus(classifyGeminiError(err))
      if (keyStatus) keyStatuses.push({ provider: 'gemini', keyId: entry.id, status: keyStatus })
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
    yield {
      event: 'error',
      data: {
        code: 'tavily_key_missing',
        message: 'Web arastirma icin Tavily API key gerekli. Ayarlardan Tavily anahtari ekleyin.',
      },
    }
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
    yield {
      event: 'error',
      data: {
        code: 'research_failed',
        message: searchResult?.error?.message || 'Web aramasi yapilamadi.',
      },
    }
    return
  }

  if (searchResult.results.length === 0) {
    yield { event: 'error', data: { code: 'research_failed', message: 'Web aramasi sonuc vermedi.' } }
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

export async function testKey(provider, key, model = DEFAULT_MODEL) {
  const normalizedKey = typeof key === 'string' ? key.trim() : ''
  if (provider === 'gemini') {
    const modelId = MODELS.includes(model) ? model : DEFAULT_MODEL
    const requestTimeoutMs = getGeminiRequestTimeoutMs(modelId)
    try {
      const genAI = createGeminiClient(normalizedKey)
      await runGeminiRequest(
        requestSignal => genAI.models.generateContent({
          model: modelId,
          contents: 'test',
          config: { abortSignal: requestSignal },
        }),
        requestTimeoutMs,
        undefined,
      )
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
