import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
  sendMessageStreamMock: vi.fn(),
  getGenerativeModelMock: vi.fn(),
}))

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(function GoogleGenerativeAI() {
    return {
      getGenerativeModel: mocks.getGenerativeModelMock,
    }
  }),
}))

mocks.getGenerativeModelMock.mockReturnValue({
  generateContent: mocks.generateContentMock,
  startChat: vi.fn().mockReturnValue({
    sendMessageStream: mocks.sendMessageStreamMock,
  }),
})

const { streamResearch, streamVision, streamChat, testKey, MODELS, DEFAULT_MODEL } = await import('./api')

function geminiStream(text) {
  return (async function* stream() {
    yield { text: () => text }
  })()
}

async function collectEvents(stream) {
  const events = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

describe('streamResearch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: 'Dunya Gunes yorungesi',
            url: 'https://example.com/dunya-gunes',
            content: 'Dunya Gunes etrafinda eliptik yorungede hareket eder.',
            score: 0.9,
          },
        ],
      }),
    })
    mocks.generateContentMock.mockResolvedValue({
      response: {
        text: () => 'Dunya su an Gunes yorungesinde hangi tarihte ve konumda',
      },
    })
    mocks.sendMessageStreamMock.mockResolvedValue({ stream: geminiStream('Baglamli cevap') })
  })

  it('expands a short follow-up question before sending it to Tavily', async () => {
    await collectEvents(streamResearch([
      { role: 'user', content: 'dunya suan gunesin neresinde' },
      { role: 'model', content: 'Dunya Gunes etrafindaki eliptik yorungededir.' },
      { role: 'user', content: 'hangi tarihten bahsediyorsun' },
    ], [{ id: 'g1', key: 'gemini-key' }], [{ id: 't1', key: 'tavily-key' }]))

    const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(fetchBody.query).toBe('Dunya su an Gunes yorungesinde hangi tarihte ve konumda')
    expect(fetchBody.query).not.toBe('hangi tarihten bahsediyorsun')
  })

  it('passes original question, generated query, conversation context and sources into the final answer prompt', async () => {
    await collectEvents(streamResearch([
      { role: 'user', content: 'dunya suan gunesin neresinde' },
      { role: 'model', content: 'Dunya Gunes etrafindaki eliptik yorungededir.' },
      { role: 'user', content: 'hangi tarihten bahsediyorsun' },
    ], [{ id: 'g1', key: 'gemini-key' }], [{ id: 't1', key: 'tavily-key' }]))

    const finalPrompt = mocks.sendMessageStreamMock.mock.calls[0][0]
    expect(finalPrompt).toContain('Orijinal kullanici sorusu: hangi tarihten bahsediyorsun')
    expect(finalPrompt).toContain('Web arama sorgusu: Dunya su an Gunes yorungesinde hangi tarihte ve konumda')
    expect(finalPrompt).toContain('Kullanici: dunya suan gunesin neresinde')
    expect(finalPrompt).toContain('Dunya Gunes yorungesi')
  })

  it('does not include empty UI-only assistant states in research history', async () => {
    await collectEvents(streamResearch([
      { role: 'model', content: 'Merhaba' },
      { role: 'user', content: 'ilk soru' },
      { role: 'model', content: '', status: 'thinking' },
      { role: 'model', content: '', status: 'error' },
      { role: 'model', content: 'ilk cevap' },
      { role: 'user', content: 'devami ne' },
    ], [{ id: 'g1', key: 'gemini-key' }], [{ id: 't1', key: 'tavily-key' }]))

    const finalPrompt = mocks.sendMessageStreamMock.mock.calls[0][0]
    expect(finalPrompt).toContain('Kullanici: ilk soru')
    expect(finalPrompt).toContain('HeraAi: ilk cevap')
    expect(finalPrompt).not.toContain('Merhaba')
    expect(finalPrompt).not.toContain('thinking')
    expect(finalPrompt).not.toContain('Response failed')
  })
})

describe('streamVision', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sendMessageStreamMock.mockResolvedValue({ stream: geminiStream('Vision answer') })
  })

  it('sends every image attachment to Gemini in attachment order', async () => {
    await collectEvents(streamVision([
      {
        role: 'user',
        content: 'Cevir',
        attachments: [
          { name: 'first.png', mimeType: 'image/png', data: 'first-image' },
          { name: 'note.txt', mimeType: 'text/plain', data: 'ignored-text' },
          { name: 'second.png', mimeType: 'image/png', data: 'second-image' },
        ],
      },
    ], null, {}, [{ id: 'g1', key: 'gemini-key' }]))

    const parts = mocks.sendMessageStreamMock.mock.calls[0][0]
    expect(parts).toEqual([
      { text: 'Cevir' },
      { inlineData: { data: 'first-image', mimeType: 'image/png' } },
      { inlineData: { data: 'second-image', mimeType: 'image/png' } },
    ])
  })

  it('keeps fallback image support when the message has no image attachments', async () => {
    await collectEvents(streamVision([
      {
        role: 'user',
        content: 'Cevir',
        attachments: [],
      },
    ], 'fallback-image', {}, [{ id: 'g1', key: 'gemini-key' }]))

    const parts = mocks.sendMessageStreamMock.mock.calls[0][0]
    expect(parts).toEqual([
      { text: 'Cevir' },
      { inlineData: { data: 'fallback-image', mimeType: 'image/png' } },
    ])
  })
})

describe('testKey (Gemini)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns success when the Gemini SDK accepts a tiny request', async () => {
    mocks.generateContentMock.mockResolvedValue({})
    const result = await testKey('gemini', 'AIza-valid-key-12345abcdef')

    expect(result).toEqual({ success: true, provider: 'gemini' })
  })

  it('classifies a 429 error as rate_limit', async () => {
    mocks.generateContentMock.mockRejectedValue(Object.assign(new Error('429 RATE_LIMIT'), { status: 429 }))
    const result = await testKey('gemini', 'AIza-rate-limited-key')

    expect(result.success).toBe(false)
    expect(result.errorType).toBe('rate_limit')
  })

  it('classifies a RESOURCE_EXHAUSTED / quota error as quota', async () => {
    mocks.generateContentMock.mockRejectedValue(new Error('RESOURCE_EXHAUSTED quota exhausted'))
    const result = await testKey('gemini', 'AIza-quota-key')

    expect(result.success).toBe(false)
    expect(result.errorType).toBe('quota')
  })

  it('classifies a 400 error as invalid', async () => {
    mocks.generateContentMock.mockRejectedValue(Object.assign(new Error('API_KEY_INVALID'), { status: 400 }))
    const result = await testKey('gemini', 'AIza-bad-key')

    expect(result.success).toBe(false)
    expect(result.errorType).toBe('invalid')
  })

  it('classifies a SAFETY block as invalid (no fallback expected)', async () => {
    mocks.generateContentMock.mockRejectedValue(new Error('blocked content SAFETY'))
    const result = await testKey('gemini', 'AIza-key-safety')

    expect(result.success).toBe(false)
    expect(result.errorType).toBe('invalid')
  })

  it('classifies an abort/timeout as timeout', async () => {
    const abortErr = new Error('Aborted')
    abortErr.name = 'AbortError'
    mocks.generateContentMock.mockRejectedValue(abortErr)
    const result = await testKey('gemini', 'AIza-timeout-key')

    expect(result.success).toBe(false)
    expect(result.errorType).toBe('timeout')
  })

  it('classifies an unknown network error as network', async () => {
    mocks.generateContentMock.mockRejectedValue(new Error('ECONNRESET network down'))
    const result = await testKey('gemini', 'AIza-network-key')

    expect(result.success).toBe(false)
    expect(result.errorType).toBe('network')
  })
})

describe('testKey (Tavily)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns success when Tavily responds 200', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const result = await testKey('tavily', 'tvly-valid-key-abcdefg')

    expect(result).toEqual({ success: true, provider: 'tavily' })
  })

  it('classifies 401 as invalid', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 })
    const result = await testKey('tavily', 'tvly-bad-key')

    expect(result.success).toBe(false)
    expect(result.errorType).toBe('invalid')
  })

  it('classifies 429 as rate_limit', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 })
    const result = await testKey('tavily', 'tvly-rate-limited')

    expect(result.success).toBe(false)
    expect(result.errorType).toBe('rate_limit')
  })

  it('classifies 5xx as network', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    const result = await testKey('tavily', 'tvly-server-error')

    expect(result.success).toBe(false)
    expect(result.errorType).toBe('network')
  })

  it('classifies an abort error as timeout', async () => {
    const abortErr = new Error('Aborted')
    abortErr.name = 'AbortError'
    global.fetch = vi.fn().mockRejectedValue(abortErr)
    const result = await testKey('tavily', 'tvly-timeout')

    expect(result.success).toBe(false)
    expect(result.errorType).toBe('timeout')
  })

  it('classifies a generic fetch error as network', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const result = await testKey('tavily', 'tvly-network')

    expect(result.success).toBe(false)
    expect(result.errorType).toBe('network')
  })
})

describe('streamChat fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('falls back to the next key when the primary rate-limits during stream creation', async () => {
    mocks.sendMessageStreamMock
      .mockRejectedValueOnce(Object.assign(new Error('429 RATE_LIMIT'), { status: 429 }))
      .mockResolvedValueOnce({ stream: geminiStream('chunk from g2') })

    const events = await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [
        { id: 'g1', key: 'AIza-primary-key-aaaaaaaa' },
        { id: 'g2', key: 'AIza-fallback-key-bbbbbb' },
      ],
    ))

    const keyStatuses = events.filter(e => e.event === 'key_status').map(e => e.data)
    expect(keyStatuses).toEqual([
      { provider: 'gemini', keyId: 'g1', status: 'cooldown' },
      { provider: 'gemini', keyId: 'g2', status: 'success' },
    ])
    expect(events.find(e => e.event === 'chunk').data.text).toBe('chunk from g2')
    expect(events.some(e => e.event === 'error')).toBe(false)
  })

  it('does not fall back when a single key returns an invalid 400 error', async () => {
    mocks.sendMessageStreamMock.mockRejectedValueOnce(
      Object.assign(new Error('API_KEY_INVALID'), { status: 400 })
    )

    const events = await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [{ id: 'g1', key: 'AIza-invalid-key-aaaaaaaa' }],
    ))

    const keyStatuses = events.filter(e => e.event === 'key_status').map(e => e.data)
    expect(keyStatuses).toEqual([
      { provider: 'gemini', keyId: 'g1', status: 'error' },
    ])
    expect(events.some(e => e.event === 'error')).toBe(true)
    expect(mocks.sendMessageStreamMock).toHaveBeenCalledTimes(1)
  })

  it('does not fall back when a single key refuses content for SAFETY reasons', async () => {
    mocks.sendMessageStreamMock.mockRejectedValueOnce(new Error('blocked content SAFETY'))

    const events = await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [{ id: 'g1', key: 'AIza-safety-key-aaaaaaaa' }],
    ))

    const keyStatuses = events.filter(e => e.event === 'key_status').map(e => e.data)
    expect(keyStatuses).toEqual([
      { provider: 'gemini', keyId: 'g1', status: 'error' },
    ])
    expect(events.some(e => e.event === 'error')).toBe(true)
    expect(mocks.sendMessageStreamMock).toHaveBeenCalledTimes(1)
  })
})

describe('model selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sendMessageStreamMock.mockResolvedValue({ stream: geminiStream('ok') })
  })

  it('exports the 4 supported model ids with DEFAULT_MODEL as gemini-3.1-flash-lite', () => {
    expect(DEFAULT_MODEL).toBe('gemini-3.1-flash-lite')
    expect(MODELS).toEqual([
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
    ])
  })

  it('passes the selected model into getGenerativeModel for streamChat', async () => {
    await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [{ id: 'g1', key: 'AIza-key-aaaaaaaaaaaa' }],
      undefined,
      'gemini-3.5-flash',
    ))

    const modelArg = mocks.getGenerativeModelMock.mock.calls[0][0]
    expect(modelArg.model).toBe('gemini-3.5-flash')
  })

  it('passes the selected model into getGenerativeModel for streamVision', async () => {
    await collectEvents(streamVision(
      [{ role: 'user', content: 'describe', attachments: [] }],
      'fallback-image',
      {},
      [{ id: 'g1', key: 'AIza-key-aaaaaaaaaaaa' }],
      undefined,
      'gemini-3.6-flash',
    ))

    const modelArg = mocks.getGenerativeModelMock.mock.calls[0][0]
    expect(modelArg.model).toBe('gemini-3.6-flash')
  })

  it('falls back to DEFAULT_MODEL when no model argument is supplied for streamChat', async () => {
    await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [{ id: 'g1', key: 'AIza-key-aaaaaaaaaaaa' }],
      undefined,
    ))

    const modelArg = mocks.getGenerativeModelMock.mock.calls[0][0]
    expect(modelArg.model).toBe(DEFAULT_MODEL)
  })

  it('testKey still uses DEFAULT_MODEL regardless of selected model arg', async () => {
    mocks.generateContentMock.mockResolvedValue({})

    await testKey('gemini', 'AIza-valid-key-12345abcde')
    await testKey('gemini', 'AIza-valid-key-12345abcde', 'gemini-3.5-flash')

    expect(mocks.getGenerativeModelMock.mock.calls[0][0].model).toBe(DEFAULT_MODEL)
    expect(mocks.getGenerativeModelMock.mock.calls[1][0].model).toBe(DEFAULT_MODEL)
  })
})
