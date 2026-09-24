import { OPENROUTER_MODEL_IDS, getOpenRouterFallbackModel } from './models'

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
// Every OpenRouter request targets a model from the shared catalog. The
// provider's own `openrouter/free` router is deliberately NOT used: it picks
// a model on its own and the UI then showed ids this system never offered.
export const OPENROUTER_MODEL = OPENROUTER_MODEL_IDS[0] || 'google/gemma-4-26b-a4b-it:free'
export const OLLAMA_CLOUD_BASE_URL = 'https://ollama.com/api'
export const OLLAMA_CLOUD_MODEL = 'gemma4:31b'
export const OLLAMA_TEST_MODEL = 'gpt-oss:20b'

const REQUEST_TIMEOUT_MS = 180_000
const STREAM_IDLE_TIMEOUT_MS = 180_000

// A catalog OpenRouter model falls back to the next catalog model when it
// fails before producing content, so transient failures never duplicate a
// partial answer and the fallback can never leave the system.
const OPENROUTER_MODEL_FALLBACKABLE = new Set([
  'model_unavailable',
  'rate_limited',
  'quota_exceeded',
  'service_unavailable',
  'network_error',
  'timeout',
  'empty_response',
  'generation_failed',
])

function createAbortError() {
  const error = new Error('Request aborted')
  error.name = 'AbortError'
  return error
}

function createProviderError(code, message, status = 0) {
  const error = new Error(message || code)
  error.code = code
  error.status = status
  return error
}

function validKeys(keys) {
  return (keys || []).filter(entry => entry?.key?.trim())
}

function providerErrorCode(status, message = '') {
  const normalized = String(message).toLowerCase()
  if (status === 401 || normalized.includes('invalid api key') || normalized.includes('unauthorized')) return 'api_key_invalid'
  if (status === 403 || normalized.includes('permission')) return 'permission_denied'
  if (status === 404 || normalized.includes('model') && normalized.includes('not found')) return 'model_unavailable'
  if (status === 429 || normalized.includes('rate limit') || normalized.includes('too many requests')) return 'rate_limited'
  if (normalized.includes('quota') || normalized.includes('usage limit') || normalized.includes('insufficient')) return 'quota_exceeded'
  if (status === 408 || status === 504 || normalized.includes('timeout')) return 'timeout'
  if (status === 400 || status === 422) return 'invalid_request'
  if (status >= 500) return 'service_unavailable'
  return 'generation_failed'
}

function keyStatusForCode(code) {
  if (code === 'rate_limited') return 'cooldown'
  if (code === 'quota_exceeded') return 'quota_exceeded'
  if (code === 'api_key_invalid') return 'error'
  if (code === 'network_error') return 'network'
  return null
}

async function errorFromResponse(response) {
  let message = ''
  try {
    const body = await response.json()
    message = body?.error?.message || body?.error || body?.message || ''
  } catch (_error) {
    try {
      message = await response.text()
    } catch (_readError) {
      message = ''
    }
  }
  const code = providerErrorCode(response.status, message)
  return createProviderError(code, message || `HTTP ${response.status}`, response.status)
}

async function fetchWithTimeout(url, options, parentSignal) {
  if (parentSignal?.aborted) throw createAbortError()
  const controller = new AbortController()
  let timedOut = false
  const handleAbort = () => controller.abort()
  parentSignal?.addEventListener('abort', handleAbort, { once: true })
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(timeoutId)
    return {
      response,
      abort: () => controller.abort(),
      cleanup: () => parentSignal?.removeEventListener('abort', handleAbort),
    }
  } catch (error) {
    clearTimeout(timeoutId)
    parentSignal?.removeEventListener('abort', handleAbort)
    if (parentSignal?.aborted) throw createAbortError()
    if (timedOut || error?.name === 'AbortError') throw createProviderError('timeout', 'Request timeout')
    throw createProviderError('network_error', error?.message || 'Network error')
  }
}

function readStreamChunk(reader, signal, abort) {
  if (signal?.aborted) return Promise.reject(createAbortError())
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
      abort?.()
      finish(reject, createProviderError('timeout', 'Response stream timed out'))
    }, STREAM_IDLE_TIMEOUT_MS)
    signal?.addEventListener('abort', handleAbort, { once: true })
    reader.read().then(
      value => finish(resolve, value),
      error => finish(reject, error),
    )
  })
}

function normalizedMessages(messages) {
  const normalized = []
  for (const message of messages || []) {
    if (!message || !['user', 'model'].includes(message.role)) continue
    const content = typeof message.content === 'string' ? message.content.trim() : ''
    const transientEmpty = message.role === 'model'
      && ['thinking', 'streaming', 'cancelled_empty'].includes(message.status)
      && !content
    if (transientEmpty || (message.role === 'model' && message.status === 'error' && !content)) continue
    const attachments = Array.isArray(message.attachments) ? message.attachments : []
    if (!content && attachments.length === 0) continue
    if (message.role === 'model' && normalized.length === 0) continue
    normalized.push({ ...message, content, attachments })
  }
  return normalized
}

function attachmentText(attachment) {
  if (typeof attachment?.modelText !== 'string' || !attachment.modelText.trim()) return ''
  const name = String(attachment.name || 'attachment')
  return `--- BEGIN FILE: ${name} ---\n${attachment.modelText.trim()}\n--- END FILE: ${name} ---`
}

function assertNoPdf(attachments) {
  if ((attachments || []).some(attachment => attachment?.mimeType === 'application/pdf')) {
    throw createProviderError('pdf_requires_gemini', 'PDF attachments require Gemini')
  }
}

function toOpenRouterMessages(messages, systemInstruction, fallbackImage = null) {
  const result = []
  if (systemInstruction?.trim()) result.push({ role: 'system', content: systemInstruction.trim() })
  const normalized = normalizedMessages(messages)

  normalized.forEach((message, index) => {
    const attachments = [...message.attachments]
    if (index === normalized.length - 1 && fallbackImage && !attachments.some(item => item?.mimeType?.startsWith('image/'))) {
      attachments.push({ name: 'image.png', mimeType: 'image/png', data: fallbackImage })
    }
    assertNoPdf(attachments)
    const parts = []
    if (message.content) parts.push({ type: 'text', text: message.content })
    for (const attachment of attachments) {
      const text = attachmentText(attachment)
      if (text) parts.push({ type: 'text', text })
      if (attachment?.mimeType?.startsWith('image/') && attachment.data) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${attachment.mimeType};base64,${attachment.data}` },
        })
      }
    }
    result.push({
      role: message.role === 'model' ? 'assistant' : 'user',
      content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
    })
  })
  return result
}

function toOllamaMessages(messages, systemInstruction, fallbackImage = null) {
  const result = []
  if (systemInstruction?.trim()) result.push({ role: 'system', content: systemInstruction.trim() })
  const normalized = normalizedMessages(messages)

  normalized.forEach((message, index) => {
    const attachments = [...message.attachments]
    if (index === normalized.length - 1 && fallbackImage && !attachments.some(item => item?.mimeType?.startsWith('image/'))) {
      attachments.push({ name: 'image.png', mimeType: 'image/png', data: fallbackImage })
    }
    assertNoPdf(attachments)
    if (attachments.some(attachment => attachment?.mimeType?.startsWith('image/'))) {
      throw createProviderError('image_not_supported', 'The selected Ollama model accepts text only')
    }
    const textParts = [message.content]
    const images = []
    for (const attachment of attachments) {
      const text = attachmentText(attachment)
      if (text) textParts.push(text)
      if (attachment?.mimeType?.startsWith('image/') && attachment.data) images.push(attachment.data)
    }
    result.push({
      role: message.role === 'model' ? 'assistant' : 'user',
      content: textParts.filter(Boolean).join('\n\n'),
      ...(images.length > 0 ? { images } : {}),
    })
  })
  return result
}

function parseSseEvent(rawEvent) {
  const dataLines = rawEvent.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
  return dataLines.join('\n').trim()
}

async function* streamOpenRouterRequest(messages, options, key, signal, fallbackImage, modelId) {
  const request = await fetchWithTimeout(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-OpenRouter-Title': 'HeraAi',
    },
    body: JSON.stringify({
      model: modelId || OPENROUTER_MODEL,
      messages: toOpenRouterMessages(messages, options.systemInstruction, fallbackImage),
      stream: true,
    }),
  }, signal)

  try {
    if (!request.response.ok) throw await errorFromResponse(request.response)
    if (!request.response.body?.getReader) throw createProviderError('network_error', 'Streaming response is unavailable')
    const reader = request.response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let resolvedModel = null

    const consumeEvent = function* (rawEvent) {
      const payload = parseSseEvent(rawEvent)
      if (!payload || payload === '[DONE]') return
      let data
      try {
        data = JSON.parse(payload)
      } catch (_error) {
        throw createProviderError('generation_failed', 'Invalid OpenRouter stream event')
      }
      if (data.error) {
        const message = data.error?.message || String(data.error)
        throw createProviderError(providerErrorCode(Number(data.error?.code || 0), message), message)
      }
      if (data.model && data.model !== resolvedModel) {
        resolvedModel = data.model
        yield { event: 'model_resolved', data: { provider: 'openrouter', requestedModel: modelId || OPENROUTER_MODEL, resolvedModel } }
      }
      const choice = data.choices?.[0]
      if (choice?.finish_reason === 'error') throw createProviderError('generation_failed', 'OpenRouter stream failed')
      const text = typeof choice?.delta?.content === 'string' ? choice.delta.content : ''
      if (text) yield { event: 'chunk', data: { text } }
    }

    while (true) {
      const { value, done } = await readStreamChunk(reader, signal, request.abort)
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() || ''
      for (const rawEvent of events) yield* consumeEvent(rawEvent)
    }
    buffer += decoder.decode()
    if (buffer.trim()) yield* consumeEvent(buffer)
  } finally {
    request.cleanup()
  }
}

async function* streamOllamaRequest(messages, options, key, signal, fallbackImage, modelId) {
  const request = await fetchWithTimeout(`${OLLAMA_CLOUD_BASE_URL}/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      messages: toOllamaMessages(messages, options.systemInstruction, fallbackImage),
      stream: true,
    }),
  }, signal)

  try {
    if (!request.response.ok) throw await errorFromResponse(request.response)
    if (!request.response.body?.getReader) throw createProviderError('network_error', 'Streaming response is unavailable')
    const reader = request.response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let resolvedModel = null

    const consumeLine = function* (line) {
      const trimmed = line.trim()
      if (!trimmed) return
      let data
      try {
        data = JSON.parse(trimmed)
      } catch (_error) {
        throw createProviderError('generation_failed', 'Invalid Ollama stream event')
      }
      if (data.error) throw createProviderError(providerErrorCode(0, data.error), data.error)
      if (data.model && data.model !== resolvedModel) {
        resolvedModel = data.model
        yield { event: 'model_resolved', data: { provider: 'ollama', requestedModel: modelId, resolvedModel } }
      }
      const text = typeof data.message?.content === 'string' ? data.message.content : ''
      if (text) yield { event: 'chunk', data: { text } }
    }

    while (true) {
      const { value, done } = await readStreamChunk(reader, signal, request.abort)
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) yield* consumeLine(line)
    }
    buffer += decoder.decode()
    if (buffer.trim()) yield* consumeLine(buffer)
  } finally {
    request.cleanup()
  }
}

function requestCarriesImage(messages, fallbackImage) {
  if (fallbackImage) return true
  return (Array.isArray(messages) ? messages : []).some(message => (
    Array.isArray(message?.attachments)
    && message.attachments.some(attachment => attachment?.mimeType?.startsWith('image/') && attachment.data)
  ))
}

function buildOpenRouterModelAttempts(requestedModel, messages, fallbackImage) {
  const fallbackModel = getOpenRouterFallbackModel(requestedModel, {
    hasImage: requestCarriesImage(messages, fallbackImage),
  })
  return fallbackModel && fallbackModel !== requestedModel
    ? [requestedModel, fallbackModel]
    : [requestedModel]
}

export async function* streamRemoteProvider(provider, messages, options = {}, keys = [], signal, fallbackImage = null, model = null) {
  const entries = validKeys(keys)
  if (entries.length === 0) {
    yield { event: 'error', data: { code: 'api_key_missing' } }
    return
  }

  const requestedModel = provider === 'ollama'
    ? (String(model || '').trim() || OLLAMA_CLOUD_MODEL)
    : (String(model || '').trim() || OPENROUTER_MODEL)
  const modelAttempts = provider === 'openrouter'
    ? buildOpenRouterModelAttempts(requestedModel, messages, fallbackImage)
    : [requestedModel]
  let lastError = createProviderError('generation_failed', 'Generation failed')
  for (const [attemptIndex, attemptModel] of modelAttempts.entries()) {
    let attemptHadContent = false
    for (const entry of entries) {
    let hasContent = false
    let pendingModelEvent = null
    try {
      const stream = provider === 'openrouter'
        ? streamOpenRouterRequest(messages, options, entry.key.trim(), signal, fallbackImage, attemptModel)
        : streamOllamaRequest(messages, options, entry.key.trim(), signal, fallbackImage, attemptModel)
      for await (const event of stream) {
        if (event.event === 'model_resolved') {
          if (hasContent) yield event
          else pendingModelEvent = event
          continue
        }
        if (event.event === 'chunk' && event.data?.text) {
          if (!hasContent) {
            hasContent = true
            attemptHadContent = true
            if (pendingModelEvent) yield pendingModelEvent
            yield { event: 'key_status', data: { provider, keyId: entry.id, status: 'success' } }
          }
          yield event
        }
      }
      if (!hasContent) throw createProviderError('empty_response', 'Provider returned an empty response')
      return
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw createAbortError()
      lastError = error?.code ? error : createProviderError('network_error', error?.message || 'Network error')
      const status = keyStatusForCode(lastError.code)
      if (status) yield { event: 'key_status', data: { provider, keyId: entry.id, status } }
      const retryableKeyFailure = [
        'api_key_invalid',
        'permission_denied',
        'rate_limited',
        'quota_exceeded',
        'network_error',
        'timeout',
        'service_unavailable',
      ].includes(lastError.code)
      if (hasContent || !retryableKeyFailure) break
    }
  }
    const isLastAttempt = attemptIndex === modelAttempts.length - 1
    if (attemptHadContent || isLastAttempt || !OPENROUTER_MODEL_FALLBACKABLE.has(lastError.code)) break
    yield {
      event: 'model_resolved',
      data: { provider: 'openrouter', requestedModel, resolvedModel: modelAttempts[attemptIndex + 1] },
    }
  }

  yield { event: 'error', data: { code: lastError.code || 'generation_failed' } }
}

export async function testOpenRouterKey(key) {
  try {
    const request = await fetchWithTimeout(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${String(key || '').trim()}`,
        'Content-Type': 'application/json',
        'X-OpenRouter-Title': 'HeraAi',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [{ role: 'user', content: 'OK' }],
        stream: false,
        max_tokens: 1,
      }),
    })
    try {
      if (!request.response.ok) throw await errorFromResponse(request.response)
      const data = await request.response.json()
      if (data?.error) {
        const message = data.error?.message || String(data.error)
        throw createProviderError(providerErrorCode(Number(data.error?.code || 0), message), message)
      }
      if (!Array.isArray(data?.choices) || !data.choices[0]?.message) {
        throw createProviderError('invalid_response', 'Invalid OpenRouter test response')
      }
      return { success: true, provider: 'openrouter' }
    } finally {
      request.cleanup()
    }
  } catch (error) {
    return { success: false, provider: 'openrouter', errorType: testErrorType(error) }
  }
}

export async function testOllamaKey(key) {
  try {
    const request = await fetchWithTimeout(`${OLLAMA_CLOUD_BASE_URL}/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${String(key || '').trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OLLAMA_TEST_MODEL,
        messages: [{ role: 'user', content: 'OK' }],
        stream: false,
        think: 'low',
        options: { num_predict: 1 },
      }),
    })
    try {
      if (!request.response.ok) throw await errorFromResponse(request.response)
      const data = await request.response.json()
      if (data?.error) {
        const message = data.error?.message || String(data.error)
        throw createProviderError(providerErrorCode(0, message), message)
      }
      if (!data?.message || typeof data.message !== 'object') {
        throw createProviderError('invalid_response', 'Invalid Ollama test response')
      }
      return { success: true, provider: 'ollama' }
    } finally {
      request.cleanup()
    }
  } catch (error) {
    return { success: false, provider: 'ollama', errorType: testErrorType(error) }
  }
}

function testErrorType(error) {
  const code = error?.code || 'network_error'
  if (code === 'api_key_invalid') return 'invalid'
  if (code === 'rate_limited') return 'rate_limit'
  if (code === 'quota_exceeded') return 'quota'
  if (code === 'network_error') return 'network'
  return code
}
