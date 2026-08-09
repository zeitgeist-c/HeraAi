import { GoogleGenAI } from '@google/genai'

import { base64ToBytes } from './audioUtils'

export const DICTATION_MODEL = 'gemini-3.1-flash-lite'
export const TTS_MODEL = 'gemini-3.1-flash-tts-preview'
export const TTS_FALLBACK_MODEL = 'gemini-2.5-flash-preview-tts'
export const TTS_VOICE = 'Kore'
const REQUEST_TIMEOUT_MS = 60000

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

async function runAcrossKeys({ keys, apiVersion, signal, onKeyStatus, request, retryServerError = false }) {
  const entries = usableKeys(keys)
  if (!entries.length) throw new VoiceApiError('api_key_missing')
  let lastError = null

  for (const entry of entries) {
    const client = new GoogleGenAI({ apiKey: entry.key.trim(), httpOptions: { apiVersion } })
    const attempts = retryServerError ? 2 : 1
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = await runWithTimeout(requestSignal => request(client, requestSignal), signal)
        onKeyStatus?.({ keyId: entry.id, status: 'success' })
        return result
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        const code = classifyError(error)
        lastError = new VoiceApiError(code, error)
        if (retryServerError && code === 'service_unavailable' && attempt === 0) continue
        const keyStatus = keyStatusFor(code)
        if (keyStatus) onKeyStatus?.({ keyId: entry.id, status: keyStatus })
        const mayTryNextKey = ['rate_limited', 'quota_exceeded', 'api_key_invalid', 'permission_denied', 'network_error'].includes(code)
        if (!mayTryNextKey) throw lastError
        break
      }
    }
  }
  throw lastError || new VoiceApiError('generation_failed')
}

export async function transcribeAudio({ wavBase64, keys, signal, onKeyStatus }) {
  if (!wavBase64) throw new VoiceApiError('empty_audio')
  const response = await runAcrossKeys({
    keys,
    apiVersion: 'v1',
    signal,
    onKeyStatus,
    request: (client, requestSignal) => client.models.generateContent({
      model: DICTATION_MODEL,
      contents: [{
        role: 'user',
        parts: [
          { text: 'Transcribe the spoken audio. Preserve the spoken language. Return only the plain transcript, with no translation, summary, answer, labels, or commentary. If there is no intelligible speech, return an empty response.' },
          { inlineData: { mimeType: 'audio/wav', data: wavBase64 } },
        ],
      }],
      config: { abortSignal: requestSignal },
    }),
  })
  return String(response?.text || '').trim()
}

export async function generateSpeech({ text, keys, signal, onKeyStatus, preferredModel = TTS_MODEL }) {
  if (!String(text || '').trim()) throw new VoiceApiError('empty_text')
  const entries = usableKeys(keys)
  if (!entries.length) throw new VoiceApiError('api_key_missing')
  const models = preferredModel === TTS_FALLBACK_MODEL
    ? [TTS_FALLBACK_MODEL]
    : [TTS_MODEL, TTS_FALLBACK_MODEL]
  let lastError = null
  let response = null
  let usedModel = null

  keyLoop: for (const entry of entries) {
    const client = new GoogleGenAI({ apiKey: entry.key.trim(), httpOptions: { apiVersion: 'v1beta' } })
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await runWithTimeout(requestSignal => client.models.generateContent({
            model,
            contents: [{ parts: [{ text: `Synthesize speech for the transcript below. Read the transcript naturally and do not read these instructions aloud.\n\nTRANSCRIPT:\n${text}` }] }],
            config: {
              abortSignal: requestSignal,
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: TTS_VOICE },
                },
              },
            },
          }), signal)
          usedModel = model
          onKeyStatus?.({ keyId: entry.id, status: 'success' })
          break keyLoop
        } catch (error) {
          if (error?.name === 'AbortError') throw error
          const code = classifyError(error)
          lastError = new VoiceApiError(code, error)
          if (code === 'service_unavailable' && attempt === 0) continue

          const canUseFallbackModel = (
            model === TTS_MODEL &&
            ['rate_limited', 'quota_exceeded'].includes(code)
          )
          if (canUseFallbackModel) break

          const keyStatus = keyStatusFor(code)
          if (keyStatus) onKeyStatus?.({ keyId: entry.id, status: keyStatus })
          const mayTryNextKey = ['rate_limited', 'quota_exceeded', 'api_key_invalid', 'permission_denied', 'network_error'].includes(code)
          if (mayTryNextKey) continue keyLoop
          throw lastError
        }
      }
    }
  }
  if (!response || !usedModel) throw lastError || new VoiceApiError('generation_failed')
  const part = response?.candidates?.[0]?.content?.parts?.find(candidate => candidate?.inlineData?.data)
  if (!part?.inlineData?.data) throw new VoiceApiError('empty_audio_response')
  return {
    pcm: base64ToBytes(part.inlineData.data),
    sampleRate: 24000,
    model: usedModel,
  }
}
