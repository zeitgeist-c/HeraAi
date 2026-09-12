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
  TTS_FALLBACK_MODEL,
  TTS_MODEL,
  TTS_PRIMARY_MODEL,
  TTS_VOICE,
  generateSpeech,
  isTtsFallbackableCode,
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

  it('falls back to 3.5 Flash Lite dictation on quota exhaustion', async () => {
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

  it('uses the preview TTS model, v1beta and fixed voice', async () => {
    mocks.generateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ inlineData: { data: btoa('\u0001\u0002') } }] } }],
    })
    const result = await generateSpeech({ text: 'Read me', keys: [{ id: 'g1', key: 'secret' }] })
    expect(result.pcm).toEqual(new Uint8Array([1, 2]))
    expect(result.model).toBe(TTS_PRIMARY_MODEL)
    expect(TTS_MODEL).toBe(TTS_PRIMARY_MODEL)
    expect(TTS_PRIMARY_MODEL).toBe('gemini-3.1-flash-tts-preview')
    expect(TTS_FALLBACK_MODEL).toBe('gemini-2.5-flash-preview-tts')
    expect(mocks.clients[0].httpOptions.apiVersion).toBe('v1beta')
    const request = mocks.generateContent.mock.calls[0][0]
    expect(request.model).toBe(TTS_MODEL)
    expect(request.config.responseModalities).toEqual(['AUDIO'])
    expect(request.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(TTS_VOICE)
  })

  it('retries one server failure for TTS', async () => {
    mocks.generateContent
      .mockRejectedValueOnce(Object.assign(new Error('500 unavailable'), { status: 500 }))
      .mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ inlineData: { data: btoa('\u0000\u0000') } }] } }],
      })
    await generateSpeech({ text: 'Retry me', keys: [{ id: 'g1', key: 'secret' }] })
    expect(mocks.generateContent).toHaveBeenCalledTimes(2)
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

  it('falls back to 2.5 Flash TTS on quota exhaustion', async () => {
    mocks.generateContent
      .mockRejectedValueOnce(Object.assign(new Error('429 quota exhausted'), { status: 429 }))
      .mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ inlineData: { data: btoa('\u0003\u0004') } }] } }],
      })
    const result = await generateSpeech({ text: 'Quota fallback', keys: [{ id: 'g1', key: 'secret' }] })
    expect(result.pcm).toEqual(new Uint8Array([3, 4]))
    expect(result.model).toBe(TTS_FALLBACK_MODEL)
    expect(mocks.generateContent).toHaveBeenCalledTimes(2)
    expect(mocks.generateContent.mock.calls[0][0].model).toBe(TTS_PRIMARY_MODEL)
    expect(mocks.generateContent.mock.calls[1][0].model).toBe(TTS_FALLBACK_MODEL)
    expect(mocks.generateContent.mock.calls[1][0].config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName)
      .toBe(TTS_VOICE)
  })

  it('falls back to 2.5 Flash TTS on an empty audio response', async () => {
    mocks.generateContent
      .mockResolvedValueOnce({ candidates: [{ content: { parts: [{ text: 'no audio' }] } }] })
      .mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ inlineData: { data: btoa('\u0005\u0006') } }] } }],
      })
    const result = await generateSpeech({ text: 'Empty fallback', keys: [{ id: 'g1', key: 'secret' }] })
    expect(result.pcm).toEqual(new Uint8Array([5, 6]))
    expect(result.model).toBe(TTS_FALLBACK_MODEL)
  })

  it('pins follow-up chunks to an explicit model without retrying the primary', async () => {
    mocks.generateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ inlineData: { data: btoa('\u0007\u0008') } }] } }],
    })
    const result = await generateSpeech({
      text: 'Pinned chunk',
      keys: [{ id: 'g1', key: 'secret' }],
      model: TTS_FALLBACK_MODEL,
    })
    expect(result.model).toBe(TTS_FALLBACK_MODEL)
    expect(mocks.generateContent).toHaveBeenCalledTimes(1)
    expect(mocks.generateContent.mock.calls[0][0].model).toBe(TTS_FALLBACK_MODEL)
  })

  it.each([
    ['api_key_invalid', Object.assign(new Error('API key invalid'), { status: 401 }), 1],
    ['invalid_request', Object.assign(new Error('bad request'), { status: 400 }), 1],
    ['network_error', new TypeError('fetch failed'), 1],
  ])('does not fall back on %s', async (_code, error, expectedCalls) => {
    mocks.generateContent.mockRejectedValue(error)
    await expect(generateSpeech({ text: 'No fallback', keys: [{ id: 'g1', key: 'secret' }] }))
      .rejects.toMatchObject({ name: 'VoiceApiError' })
    expect(mocks.generateContent).toHaveBeenCalledTimes(expectedCalls)
  })

  it('classifies only meaningful failures as fallbackable', () => {
    for (const code of ['rate_limited', 'quota_exceeded', 'model_unavailable', 'service_unavailable', 'timeout', 'permission_denied', 'empty_audio_response']) {
      expect(isTtsFallbackableCode(code)).toBe(true)
    }
    for (const code of ['aborted', 'api_key_invalid', 'api_key_missing', 'invalid_request', 'network_error', 'generation_failed']) {
      expect(isTtsFallbackableCode(code)).toBe(false)
    }
  })
})
