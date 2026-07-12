import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
  sendMessageStreamMock: vi.fn(),
}))

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(function GoogleGenerativeAI() {
    return {
      getGenerativeModel: vi.fn().mockReturnValue({
        generateContent: mocks.generateContentMock,
        startChat: vi.fn().mockReturnValue({
          sendMessageStream: mocks.sendMessageStreamMock,
        }),
      }),
    }
  }),
}))

const { streamResearch, streamVision } = await import('./api')

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
