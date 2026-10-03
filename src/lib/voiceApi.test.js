import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  clients: [],
}))

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(function GoogleGenAI(options) {
    mocks.clients.push(options)
    return { models: { generateContent: mocks.generateContent } }
  }),
}))

const {
  DICTATION_FALLBACK_MODEL,
  DICTATION_MODEL,
  DICTATION_PRIMARY_MODEL,
  DICTATION_TERTIARY_CODES,
  DICTATION_TERTIARY_MODEL,
  isDictationFallbackableCode,
  transcribeAudio,
} = await import('./voiceApi')

describe('voice API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.clients.length = 0
  })

  it('sends WAV inline data to the fixed dictation model on v1', async () => {
    mocks.generateContent.mockResolvedValue({ text: 'Merhaba dünya' })
    const statuses = []
    const result = await transcribeAudio({
      wavBase64: 'UklGRg==',
      keys: [{ id: 'g1', key: 'secret' }],
      onKeyStatus: status => statuses.push(status),
    })
    expect(result).toBe('Merhaba dünya')
    expect(mocks.clients[0].httpOptions.apiVersion).toBe('v1')
    const request = mocks.generateContent.mock.calls[0][0]
    expect(request.model).toBe(DICTATION_MODEL)
    expect(request.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'audio/wav', data: 'UklGRg==' } })
    expect(statuses).toEqual([{ keyId: 'g1', status: 'success' }])
  })

  it('uses Gemini 3.1 Flash Lite for dictation with 3.5 Flash Lite as the fallback', () => {
    expect(DICTATION_PRIMARY_MODEL).toBe('gemini-3.1-flash-lite')
    expect(DICTATION_FALLBACK_MODEL).toBe('gemini-3.5-flash-lite')
    expect(DICTATION_MODEL).toBe(DICTATION_PRIMARY_MODEL)
  })

  it('falls back to the secondary dictation model on quota exhaustion', async () => {
    mocks.generateContent
      .mockRejectedValueOnce(Object.assign(new Error('429 quota exhausted'), { status: 429 }))
      .mockResolvedValueOnce({ text: 'Quota transcript' })
    const result = await transcribeAudio({ wavBase64: 'UklGRg==', keys: [{ id: 'g1', key: 'secret' }] })
    expect(result).toBe('Quota transcript')
    expect(mocks.generateContent).toHaveBeenCalledTimes(2)
    expect(mocks.generateContent.mock.calls[0][0].model).toBe(DICTATION_PRIMARY_MODEL)
    expect(mocks.generateContent.mock.calls[1][0].model).toBe(DICTATION_FALLBACK_MODEL)
    expect(DICTATION_MODEL).toBe(DICTATION_PRIMARY_MODEL)
  })

  it('pins dictation to an explicit model without retrying the primary', async () => {
    mocks.generateContent.mockResolvedValue({ text: 'Pinned transcript' })
    const result = await transcribeAudio({
      wavBase64: 'UklGRg==',
      keys: [{ id: 'g1', key: 'secret' }],
      model: DICTATION_FALLBACK_MODEL,
    })
    expect(result).toBe('Pinned transcript')
    expect(mocks.generateContent).toHaveBeenCalledTimes(1)
    expect(mocks.generateContent.mock.calls[0][0].model).toBe(DICTATION_FALLBACK_MODEL)
  })

  it('does not fall back dictation on an invalid key or network error', async () => {
    mocks.generateContent.mockRejectedValue(Object.assign(new Error('API key invalid'), { status: 401 }))
    await expect(transcribeAudio({ wavBase64: 'UklGRg==', keys: [{ id: 'g1', key: 'secret' }] }))
      .rejects.toMatchObject({ name: 'VoiceApiError', code: 'api_key_invalid' })
    expect(mocks.generateContent).toHaveBeenCalledTimes(1)
  })

  it('does not fall back dictation on an empty transcript', async () => {
    mocks.generateContent.mockResolvedValue({ text: '   ' })
    const result = await transcribeAudio({ wavBase64: 'UklGRg==', keys: [{ id: 'g1', key: 'secret' }] })
    expect(result).toBe('')
    expect(mocks.generateContent).toHaveBeenCalledTimes(1)
  })

  it('falls back to the next key after rate limiting', async () => {
    const statuses = []
    mocks.generateContent
      .mockRejectedValueOnce(Object.assign(new Error('429 rate limit'), { status: 429 }))
      .mockResolvedValueOnce({ text: 'Fallback transcript' })
    const result = await transcribeAudio({
      wavBase64: 'UklGRg==',
      keys: [{ id: 'g1', key: 'one' }, { id: 'g2', key: 'two' }],
      onKeyStatus: status => statuses.push(status),
    })
    expect(result).toBe('Fallback transcript')
    expect(statuses).toEqual([
      { keyId: 'g1', status: 'cooldown' },
      { keyId: 'g2', status: 'success' },
    ])
  })

  it('retries the secondary model when the primary rejects the request', async () => {
    mocks.generateContent
      .mockRejectedValueOnce(Object.assign(new Error('bad request: model is not supported for audio input'), { status: 400 }))
      .mockResolvedValueOnce({ text: 'Fallback transcript' })
    const result = await transcribeAudio({ wavBase64: 'UklGRg==', keys: [{ id: 'g1', key: 'secret' }] })
    expect(result).toBe('Fallback transcript')
    expect(mocks.generateContent).toHaveBeenCalledTimes(2)
    expect(mocks.generateContent.mock.calls[0][0].model).toBe(DICTATION_PRIMARY_MODEL)
    expect(mocks.generateContent.mock.calls[1][0].model).toBe(DICTATION_FALLBACK_MODEL)
  })

  it('tries Gemini 3.6 Flash when both lite dictation models hit a server error', async () => {
    mocks.generateContent
      .mockRejectedValueOnce(Object.assign(new Error('503 model overloaded'), { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error('503 model overloaded'), { status: 503 }))
      .mockResolvedValueOnce({ text: 'Tertiary transcript' })
    const result = await transcribeAudio({ wavBase64: 'UklGRg==', keys: [{ id: 'g1', key: 'secret' }] })
    expect(result).toBe('Tertiary transcript')
    expect(mocks.generateContent).toHaveBeenCalledTimes(3)
    expect(mocks.generateContent.mock.calls.map(call => call[0].model)).toEqual([
      DICTATION_PRIMARY_MODEL,
      DICTATION_FALLBACK_MODEL,
      DICTATION_TERTIARY_MODEL,
    ])
  })

  it('does not reach for the tertiary model after a quota failure', async () => {
    mocks.generateContent.mockRejectedValue(Object.assign(new Error('429 quota exhausted'), { status: 429 }))
    await expect(transcribeAudio({ wavBase64: 'UklGRg==', keys: [{ id: 'g1', key: 'secret' }] }))
      .rejects.toMatchObject({ name: 'VoiceApiError', code: 'rate_limited' })
    expect(mocks.generateContent).toHaveBeenCalledTimes(2)
    expect(mocks.generateContent.mock.calls.map(call => call[0].model)).toEqual([
      DICTATION_PRIMARY_MODEL,
      DICTATION_FALLBACK_MODEL,
    ])
    expect(DICTATION_TERTIARY_CODES.has('quota_exceeded')).toBe(false)
    expect(DICTATION_TERTIARY_CODES.has('service_unavailable')).toBe(true)
  })

  it('classifies only meaningful failures as fallbackable', () => {
    for (const code of ['rate_limited', 'quota_exceeded', 'model_unavailable', 'service_unavailable', 'timeout', 'permission_denied', 'invalid_request', 'generation_failed']) {
      expect(isDictationFallbackableCode(code)).toBe(true)
    }
    for (const code of ['aborted', 'api_key_invalid', 'api_key_missing', 'network_error']) {
      expect(isDictationFallbackableCode(code)).toBe(false)
    }
  })
})
