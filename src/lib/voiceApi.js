import { GoogleGenAI } from '@google/genai'

export const DICTATION_PRIMARY_MODEL = 'gemini-3.1-flash-lite'
export const DICTATION_FALLBACK_MODEL = 'gemini-3.5-flash-lite'
export const DICTATION_TERTIARY_MODEL = 'gemini-3.6-flash'
export const DICTATION_MODEL = DICTATION_PRIMARY_MODEL
// The third model is tried only on server rejection (5xx) and invalid request
// (400);
// no pointless request is sent on quota/key errors.
export const DICTATION_TERTIARY_CODES = new Set(['service_unavailable', 'invalid_request'])
const REQUEST_TIMEOUT_MS = 200000

export const DICTATION_FALLBACKABLE_CODES = new Set([
  'rate_limited',
  'quota_exceeded',
  'model_unavailable',
  'service_unavailable',
  'timeout',
  'permission_denied',
  'invalid_request',
  'generation_failed',
])

export function isDictationFallbackableCode(code) {
  return DICTATION_FALLBACKABLE_CODES.has(code)
}

export class VoiceApiError extends Error {
  constructor(code, cause) {
    super(code)
    this.name = 'VoiceApiError'
    this.code = code
    this.cause = cause
  }
}

function errorStatus(error) {
  const direct = Number(error?.status || error?.code || error?.error?.code)
  if (Number.isInteger(direct) && direct >= 100 && direct <= 599) return direct
  const text = [error?.message, error?.error?.message].filter(Boolean).join(' ')
  return Number(text.match(/\b(400|401|403|404|408|429|500|502|503|504)\b/)?.[1] || 0)
}

function classifyError(error) {
  if (error?.name === 'AbortError') return 'aborted'
  if (error?.name === 'TimeoutError') return 'timeout'
  if (error instanceof VoiceApiError && typeof error.code === 'string') return error.code
  const status = errorStatus(error)
  const text = String(error?.message || error?.error?.message || '').toLowerCase()
  if (status === 429 || text.includes('rate limit')) return 'rate_limited'
  if (text.includes('quota') || text.includes('resource_exhausted')) return 'quota_exceeded'
  if (status === 401 || text.includes('api_key_invalid')) return 'api_key_invalid'
  if (status === 403 || text.includes('permission_denied')) return 'permission_denied'
  if (status === 404 || text.includes('not found')) return 'model_unavailable'
  if (status >= 500) return 'service_unavailable'
  if (status === 400) return 'invalid_request'
  if (error instanceof TypeError || text.includes('fetch') || text.includes('network')) return 'network_error'
  return 'generation_failed'
}

function keyStatusFor(code) {
  if (code === 'rate_limited') return 'cooldown'
  if (code === 'quota_exceeded') return 'quota_exceeded'
  if (code === 'api_key_invalid') return 'error'
  if (code === 'network_error') return 'network'
  return null
}

async function runWithTimeout(callback, parentSignal) {
  if (parentSignal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const controller = new AbortController()
  const abort = () => controller.abort()
  parentSignal?.addEventListener('abort', abort, { once: true })
  const timeoutId = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS)
  try {
    return await callback(controller.signal)
  } catch (error) {
    if (parentSignal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (controller.signal.aborted) {
      const timeout = new Error('Request timeout')
      timeout.name = 'TimeoutError'
      throw timeout
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
    parentSignal?.removeEventListener('abort', abort)
  }
}

function usableKeys(keys) {
  return (keys || []).filter(entry => entry?.key?.trim())
}

async function runAcrossKeys({ keys, apiVersion, signal, onKeyStatus, request }) {
  const entries = usableKeys(keys)
  if (!entries.length) throw new VoiceApiError('api_key_missing')
  let lastError = null

  for (const entry of entries) {
    const client = new GoogleGenAI({ apiKey: entry.key, httpOptions: { apiVersion } })
    try {
      const result = await runWithTimeout(requestSignal => request(client, requestSignal), signal)
      onKeyStatus?.({ keyId: entry.id, status: 'success' })
      return result
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      const code = classifyError(error)
      lastError = new VoiceApiError(code, error)
      const keyStatus = keyStatusFor(code)
      if (keyStatus) onKeyStatus?.({ keyId: entry.id, status: keyStatus })
      const mayTryNextKey = ['rate_limited', 'quota_exceeded', 'api_key_invalid', 'permission_denied', 'network_error'].includes(code)
      if (!mayTryNextKey) throw lastError
    }
  }
  throw lastError || new VoiceApiError('generation_failed')
}

async function requestTranscriptionWithModel({ wavBase64, keys, signal, onKeyStatus, model }) {
  const response = await runAcrossKeys({
    keys,
    apiVersion: 'v1',
    signal,
    onKeyStatus,
    request: (client, requestSignal) => client.models.generateContent({
      model,
      contents: [{
        role: 'user',
        parts: [
          { text: 'Transcribe the spoken audio exactly as heard, in its original language. This may be a fragment of a longer recording cut at an arbitrary point, so never complete partial words or sentences and never add anything that was not spoken. No translation, summary, answer, or commentary. Return only the plain transcript. If there is no intelligible speech, return an empty response.' },
          { inlineData: { mimeType: 'audio/wav', data: wavBase64 } },
        ],
      }],
      config: { abortSignal: requestSignal, temperature: 0, maxOutputTokens: 8192, responseMimeType: 'text/plain' },
    }),
  })
  return String(response?.text || '').trim()
}

export async function transcribeAudio({ wavBase64, keys, signal, onKeyStatus, model = null }) {
  if (!wavBase64) throw new VoiceApiError('empty_audio')
  if (typeof model === 'string' && model) {
    return requestTranscriptionWithModel({ wavBase64, keys, signal, onKeyStatus, model })
  }
  try {
    return await requestTranscriptionWithModel({ wavBase64, keys, signal, onKeyStatus, model: DICTATION_PRIMARY_MODEL })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    const code = error instanceof VoiceApiError ? error.code : classifyError(error)
    if (!isDictationFallbackableCode(code)) {
      throw error instanceof VoiceApiError ? error : new VoiceApiError(code, error)
    }
    try {
      return await requestTranscriptionWithModel({ wavBase64, keys, signal, onKeyStatus, model: DICTATION_FALLBACK_MODEL })
    } catch (fallbackError) {
      if (fallbackError?.name === 'AbortError') throw fallbackError
      const fallbackCode = fallbackError instanceof VoiceApiError ? fallbackError.code : classifyError(fallbackError)
      if (!DICTATION_TERTIARY_CODES.has(fallbackCode)) {
        throw fallbackError instanceof VoiceApiError ? fallbackError : new VoiceApiError(fallbackCode, fallbackError)
      }
      return requestTranscriptionWithModel({ wavBase64, keys, signal, onKeyStatus, model: DICTATION_TERTIARY_MODEL })
    }
  }
}

