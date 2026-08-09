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
  DICTATION_MODEL,
  TTS_MODEL,
  TTS_VOICE,
  generateSpeech,
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

  it('uses the preview TTS model, v1beta and fixed voice', async () => {
    mocks.generateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ inlineData: { data: btoa('\u0001\u0002') } }] } }],
    })
    const result = await generateSpeech({ text: 'Read me', keys: [{ id: 'g1', key: 'secret' }] })
    expect(result.pcm).toEqual(new Uint8Array([1, 2]))
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
})
