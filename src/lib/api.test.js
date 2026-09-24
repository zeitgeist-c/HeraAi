import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
  generateContentStreamMock: vi.fn(),
  clientOptionsMock: vi.fn(),
}))

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(function GoogleGenAI(options) {
    mocks.clientOptionsMock(options)
    return {
      models: {
        generateContent: mocks.generateContentMock,
        generateContentStream: mocks.generateContentStreamMock,
      },
    }
  }),
}))

const { streamResearch, streamVision, streamChat, testKey, MODELS, DEFAULT_MODEL, parseDuckDuckGoHtml } = await import('./api')

function geminiStream(text) {
  return (async function* stream() {
    yield { text }
  })()
}

function ollamaStream(text, model) {
  const encoder = new TextEncoder()
  let consumed = false
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (consumed) return { value: undefined, done: true }
          consumed = true
          return {
            value: encoder.encode(`${JSON.stringify({ model, message: { content: text } })}\n`),
            done: false,
          }
        },
      }),
    },
  }
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
      text: 'Dunya su an Gunes yorungesinde hangi tarihte ve konumda',
    })
    mocks.generateContentStreamMock.mockResolvedValue(geminiStream('Baglamli cevap'))
  })

  it('builds a contextual search query locally before sending it to Tavily', async () => {
    await collectEvents(streamResearch([
      { role: 'user', content: 'dunya suan gunesin neresinde' },
      { role: 'model', content: 'Dunya Gunes etrafindaki eliptik yorungededir.' },
      { role: 'user', content: 'hangi tarihten bahsediyorsun' },
    ], [{ id: 'g1', key: 'gemini-key' }], [{ id: 't1', key: 'tavily-key' }]))

    const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(fetchBody.query).toBe('dunya suan gunesin neresinde hangi tarihten bahsediyorsun')
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tavily-key')
    expect(fetchBody).not.toHaveProperty('api_key')
  })

  it('passes original question, generated query, conversation context and sources into the final answer prompt', async () => {
    await collectEvents(streamResearch([
      { role: 'user', content: 'dunya suan gunesin neresinde' },
      { role: 'model', content: 'Dunya Gunes etrafindaki eliptik yorungededir.' },
      { role: 'user', content: 'hangi tarihten bahsediyorsun' },
    ], [{ id: 'g1', key: 'gemini-key' }], [{ id: 't1', key: 'tavily-key' }]))

    const finalPrompt = mocks.generateContentStreamMock.mock.calls[0][0].contents.at(-1).parts[0].text
    expect(finalPrompt).toContain('Orijinal kullanici sorusu: hangi tarihten bahsediyorsun')
    expect(finalPrompt).toContain('Web arama sorgusu: dunya suan gunesin neresinde hangi tarihten bahsediyorsun')
    expect(finalPrompt).toContain('Kullanici: dunya suan gunesin neresinde')
    expect(finalPrompt).toContain('Dunya Gunes yorungesi')
  })

  it('applies systemInstruction only to the final research answer', async () => {
    await collectEvents(streamResearch(
      [{ role: 'user', content: 'guncel bilgi' }],
      [{ id: 'g1', key: 'gemini-key' }],
      [{ id: 't1', key: 'tavily-key' }],
      undefined,
      'gemini-3.7-flash',
      { systemInstruction: '  Her zaman Turkce yanit ver.  ' },
    ))

    expect(mocks.generateContentMock).not.toHaveBeenCalled()
    expect(mocks.generateContentStreamMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      model: 'gemini-3.7-flash',
      config: expect.objectContaining({ systemInstruction: 'Her zaman Turkce yanit ver.' }),
    }))
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

    const finalPrompt = mocks.generateContentStreamMock.mock.calls[0][0].contents.at(-1).parts[0].text
    expect(finalPrompt).toContain('Kullanici: ilk soru')
    expect(finalPrompt).toContain('HeraAi: ilk cevap')
    expect(finalPrompt).not.toContain('Merhaba')
    expect(finalPrompt).not.toContain('thinking')
    expect(finalPrompt).not.toContain('Response failed')
  })

  it('does not call Gemini to create the Tavily query', async () => {
    const events = await collectEvents(streamResearch(
      [{ role: 'user', content: 'follow-up question' }],
      [{ id: 'g1', key: 'gemini-key' }],
      [{ id: 't1', key: 'tavily-key' }],
    ))

    expect(events.find(event => event.event === 'error')).toBeUndefined()
    expect(mocks.generateContentMock).not.toHaveBeenCalled()
  })

  it('returns tavily_key_missing when research has no Tavily key', async () => {
    const events = await collectEvents(streamResearch(
      [{ role: 'user', content: 'bugunun haberlerini ara' }],
      [{ id: 'g1', key: 'gemini-key' }],
      [],
    ))

    expect(events).toEqual([
      expect.objectContaining({
        event: 'error',
        data: expect.objectContaining({ code: 'tavily_key_missing' }),
      }),
    ])
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('returns research_failed when Tavily search fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 })

    const events = await collectEvents(streamResearch(
      [{ role: 'user', content: 'bugunun haberlerini ara' }],
      [{ id: 'g1', key: 'gemini-key' }],
      [{ id: 't1', key: 'tavily-key' }],
    ))

    expect(events.find(event => event.event === 'error')).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ code: 'research_failed' }),
      }),
    )
    expect(mocks.generateContentStreamMock).not.toHaveBeenCalled()
  })

  it('tries the next Tavily key when the primary key is rate-limited', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: [{
            title: 'Fallback result',
            url: 'https://example.com/fallback',
            content: 'Result from the fallback Tavily key.',
            score: 0.8,
          }],
        }),
      })

    const events = await collectEvents(streamResearch(
      [{ role: 'user', content: 'guncel bilgi' }],
      [{ id: 'g1', key: 'gemini-key' }],
      [
        { id: 't1', key: 'tavily-primary' },
        { id: 't2', key: 'tavily-fallback' },
      ],
    ))

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(global.fetch.mock.calls.map(call => call[1].headers.Authorization)).toEqual([
      'Bearer tavily-primary',
      'Bearer tavily-fallback',
    ])
    expect(events).toEqual(expect.arrayContaining([
      { event: 'key_status', data: { provider: 'tavily', keyId: 't1', status: 'cooldown' } },
      { event: 'key_status', data: { provider: 'tavily', keyId: 't2', status: 'success' } },
    ]))
    expect(events.find(event => event.event === 'error')).toBeUndefined()
  })

  it('routes exact public URLs through Gemini URL Context without Tavily Search', async () => {
    mocks.generateContentMock.mockResolvedValueOnce({
      text: 'Verified page summary',
      candidates: [{
        urlContextMetadata: {
          urlMetadata: [{
            retrievedUrl: 'https://example.com/article',
            urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS',
          }],
        },
      }],
    })

    const events = await collectEvents(streamResearch(
      [{ role: 'user', content: 'Summarize this page' }],
      [{ id: 'g1', key: 'gemini-key' }],
      [],
      undefined,
      DEFAULT_MODEL,
      { language: 'en', webContext: { kind: 'url', urls: ['https://example.com/article'] } },
    ))

    expect(events).toEqual(expect.arrayContaining([
      { event: 'chunk', data: { text: 'Verified page summary' } },
      expect.objectContaining({ event: 'sources' }),
    ]))
    expect(global.fetch).not.toHaveBeenCalled()
    expect(mocks.clientOptionsMock).toHaveBeenCalledWith(expect.objectContaining({
      httpOptions: { apiVersion: 'v1beta' },
    }))
    expect(mocks.generateContentMock.mock.calls[0][0].config.tools).toEqual([{ urlContext: {} }])
  })

  it('falls back to Tavily Extract when URL Context metadata is incomplete', async () => {
    mocks.generateContentMock.mockResolvedValueOnce({ text: 'Unverified answer', candidates: [] })
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ url: 'https://example.com/article', raw_content: '# Article\nReliable content' }],
        failed_results: [],
      }),
    })

    const events = await collectEvents(streamResearch(
      [{ role: 'user', content: 'Summarize this page' }],
      [{ id: 'g1', key: 'gemini-key' }],
      [{ id: 't1', key: 'tavily-key' }],
      undefined,
      DEFAULT_MODEL,
      { language: 'en', webContext: { kind: 'url', urls: ['https://example.com/article'] } },
    ))

    expect(global.fetch).toHaveBeenCalledWith('https://api.tavily.com/extract', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer tavily-key' }),
    }))
    const finalPrompt = mocks.generateContentStreamMock.mock.calls[0][0].contents.at(-1).parts.at(-1).text
    expect(finalPrompt).toContain('BEGIN UNTRUSTED WEB PAGE')
    expect(finalPrompt).toContain('Reliable content')
    expect(finalPrompt).not.toContain('Unverified answer')
    expect(events.find(event => event.event === 'error')).toBeUndefined()
  })

  it('does not return an unverified answer when both URL providers fail', async () => {
    mocks.generateContentMock.mockResolvedValueOnce({ text: 'Unverified answer', candidates: [] })
    const events = await collectEvents(streamResearch(
      [{ role: 'user', content: 'Summarize this page' }],
      [{ id: 'g1', key: 'gemini-key' }],
      [],
      undefined,
      DEFAULT_MODEL,
      { webContext: { kind: 'url', urls: ['https://example.com/article'] } },
    ))
    expect(events.find(event => event.event === 'chunk')).toBeUndefined()
    expect(events.find(event => event.event === 'error')?.data.code).toBe('tavily_key_missing')
  })
})

const DDG_FIXTURE_HTML = `
<div class="result results_links results_links_deep web-result">
<div class="links_main links_deep result__body">
<h2 class="result__title">
<a rel="nofollow" class="result__a" href="/l/?kh=-1&amp;uddg=https%3A%2F%2Fexample.com%2Fdolar&amp;rut=abc">Dolar kuru <b>bugün</b> ne kadar?</a>
</h2>
<a class="result__snippet" href="/l/?kh=-1&amp;uddg=https%3A%2F%2Fexample.com%2Fdolar&amp;rut=abc">Dolar bug&#252;n 41,50 TL &amp; y&#252;kselişte.</a>
</div>
</div>
<div class="result results_links results_links_deep web-result">
<div class="links_main links_deep result__body">
<h2 class="result__title">
<a rel="nofollow" class="result__a" href="https://example.com/altin">Altın fiyatları</a>
</h2>
</div>
</div>`

describe('parseDuckDuckGoHtml', () => {
  it('decodes redirect URLs, titles and snippets', () => {
    expect(parseDuckDuckGoHtml(DDG_FIXTURE_HTML)).toEqual([
      {
        title: 'Dolar kuru bugün ne kadar?',
        url: 'https://example.com/dolar',
        content: 'Dolar bugün 41,50 TL & yükselişte.',
        score: null,
      },
      {
        title: 'Altın fiyatları',
        url: 'https://example.com/altin',
        content: '',
        score: null,
      },
    ])
  })

  it('returns an empty list for bot-protection or empty pages', () => {
    expect(parseDuckDuckGoHtml('')).toEqual([])
    expect(parseDuckDuckGoHtml(null)).toEqual([])
    expect(parseDuckDuckGoHtml('<html><body>nothing here</body></html>')).toEqual([])
  })
})

describe('streamResearch auto mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.generateContentStreamMock.mockResolvedValue(geminiStream('Baglamli cevap'))
  })

  function autoSearch(fetchImpl) {
    global.fetch = fetchImpl
    return collectEvents(streamResearch(
      [{ role: 'user', content: 'bugün dolar kuru ne kadar?' }],
      [{ id: 'g1', key: 'gemini-key' }],
      [],
      undefined,
      DEFAULT_MODEL,
      { webContext: { kind: 'search', searchMode: 'auto' } },
    ))
  }

  it('answers from DuckDuckGo without touching Tavily', async () => {
    const events = await autoSearch(vi.fn().mockResolvedValue({
      ok: true,
      text: async () => DDG_FIXTURE_HTML,
    }))

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch.mock.calls[0][0]).toContain('html.duckduckgo.com/html/')
    expect(events.find(event => event.event === 'error')).toBeUndefined()
    expect(events).toEqual(expect.arrayContaining([
      { event: 'chunk', data: { text: 'Baglamli cevap' } },
      expect.objectContaining({ event: 'sources' }),
    ]))
    const sources = events.find(event => event.event === 'sources').data.sources
    expect(sources.map(source => source.url)).toEqual([
      'https://example.com/dolar',
      'https://example.com/altin',
    ])
    const finalPrompt = mocks.generateContentStreamMock.mock.calls[0][0].contents.at(-1).parts[0].text
    expect(finalPrompt).toContain('Dolar kuru bugün ne kadar?')
  })

  it('falls back to plain chat when DuckDuckGo returns nothing', async () => {
    const events = await autoSearch(vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<html><body>nothing here</body></html>',
    }))

    expect(events.find(event => event.event === 'error')).toBeUndefined()
    expect(events.find(event => event.event === 'sources')).toBeUndefined()
    expect(events).toEqual(expect.arrayContaining([
      { event: 'chunk', data: { text: 'Baglamli cevap' } },
    ]))
    const contents = mocks.generateContentStreamMock.mock.calls[0][0].contents.at(-1).parts[0].text
    expect(contents).toBe('bugün dolar kuru ne kadar?')
  })

  it('falls back to plain chat when DuckDuckGo fails', async () => {
    const events = await autoSearch(vi.fn().mockResolvedValue({ ok: false, status: 503 }))

    expect(events.find(event => event.event === 'error')).toBeUndefined()
    const contents = mocks.generateContentStreamMock.mock.calls[0][0].contents.at(-1).parts[0].text
    expect(contents).toBe('bugün dolar kuru ne kadar?')
  })

  it('keeps the Tavily key requirement for explicit search', async () => {
    const events = await collectEvents(streamResearch(
      [{ role: 'user', content: 'bugün dolar kuru ne kadar?' }],
      [{ id: 'g1', key: 'gemini-key' }],
      [],
      undefined,
      DEFAULT_MODEL,
      { webContext: { kind: 'search', searchMode: 'explicit' } },
    ))

    expect(events).toEqual([
      expect.objectContaining({
        event: 'error',
        data: expect.objectContaining({ code: 'tavily_key_missing' }),
      }),
    ])
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('streamVision', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.generateContentStreamMock.mockResolvedValue(geminiStream('Vision answer'))
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

    const parts = mocks.generateContentStreamMock.mock.calls[0][0].contents[0].parts
    expect(parts).toEqual([
      { text: 'Attached file: first.png' },
      { inlineData: { data: 'first-image', mimeType: 'image/png' } },
      { text: 'Attached file: second.png' },
      { inlineData: { data: 'second-image', mimeType: 'image/png' } },
      { text: 'Cevir' },
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

    const parts = mocks.generateContentStreamMock.mock.calls[0][0].contents[0].parts
    expect(parts).toEqual([
      { text: 'Attached file: image.png' },
      { inlineData: { data: 'fallback-image', mimeType: 'image/png' } },
      { text: 'Cevir' },
    ])
  })
})

describe('testKey (Gemini)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns success when the Gemini SDK accepts a tiny request', async () => {
    mocks.generateContentMock.mockResolvedValue({ candidates: [{}] })
    const result = await testKey('gemini', 'AIza-valid-key-12345abcdef')

    expect(result).toEqual({ success: true, provider: 'gemini' })
  })

  it('rejects a malformed successful Gemini response without calling the key invalid', async () => {
    mocks.generateContentMock.mockResolvedValue({ unexpected: true })
    const result = await testKey('gemini', 'AIza-valid-key-12345abcdef')

    expect(result).toEqual({ success: false, provider: 'gemini', errorType: 'unknown' })
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

  it('does not classify a SAFETY block as an invalid key', async () => {
    mocks.generateContentMock.mockRejectedValue(new Error('blocked content SAFETY'))
    const result = await testKey('gemini', 'AIza-key-safety')

    expect(result.success).toBe(false)
    expect(result.errorType).toBe('unknown')
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

  it('always tests the low-usage Gemini model with one output token', async () => {
    mocks.generateContentMock.mockResolvedValue({ candidates: [{}] })

    await testKey('gemini', 'AIza-model-key', 'gemini-3.6-flash')

    expect(mocks.generateContentMock.mock.calls[0][0]).toMatchObject({
      model: 'gemini-3.1-flash-lite',
      contents: 'OK',
      config: { maxOutputTokens: 1 },
    })
  })

  it('reports selected-model access failures without calling the key invalid', async () => {
    mocks.generateContentMock.mockRejectedValue(
      Object.assign(new Error('models/gemini-3.6-flash is not found for API version v1'), { status: 404 })
    )

    const result = await testKey('gemini', 'AIza-model-key', 'gemini-3.6-flash')

    expect(result).toEqual({
      success: false,
      provider: 'gemini',
      errorType: 'model_unavailable',
    })
  })

  it('keeps permission errors distinct from an invalid API key', async () => {
    mocks.generateContentMock.mockRejectedValue(
      Object.assign(new Error('PERMISSION_DENIED for selected model'), { status: 403 })
    )

    const result = await testKey('gemini', 'AIza-model-key', 'gemini-3.6-flash')

    expect(result.errorType).toBe('permission_denied')
  })

  it('classifies a billing precondition before the generic 403 permission case', async () => {
    mocks.generateContentMock.mockRejectedValue(
      Object.assign(new Error('FAILED_PRECONDITION: billing must be enabled'), { status: 403 })
    )

    const result = await testKey('gemini', 'AIza-billing-key', 'gemini-3.6-flash')

    expect(result.errorType).toBe('billing_required')
  })
})

describe('testKey (Tavily)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns success when Tavily responds 200', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    })
    const result = await testKey('tavily', 'tvly-valid-key-abcdefg')

    expect(result).toEqual({ success: true, provider: 'tavily' })
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({
      query: 'test',
      max_results: 1,
      include_answer: false,
    })
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

  it('classifies 5xx as service_unavailable', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    const result = await testKey('tavily', 'tvly-server-error')

    expect(result.success).toBe(false)
    expect(result.errorType).toBe('service_unavailable')
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
    mocks.generateContentStreamMock
      .mockRejectedValueOnce(Object.assign(new Error('429 RATE_LIMIT'), { status: 429 }))
      .mockResolvedValueOnce(geminiStream('chunk from g2'))

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

  it.each([
    ['times out', Object.assign(new Error('The operation timed out'), { name: 'AbortError' })],
    ['returns a temporary service error', Object.assign(new Error('Service unavailable'), { status: 503 })],
  ])('falls back to the next key when the primary %s before output starts', async (_label, primaryError) => {
    mocks.generateContentStreamMock
      .mockRejectedValueOnce(primaryError)
      .mockResolvedValueOnce(geminiStream('chunk from fallback key'))

    const events = await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [
        { id: 'g1', key: 'AIza-primary-key-aaaaaaaa' },
        { id: 'g2', key: 'AIza-fallback-key-bbbbbb' },
      ],
    ))

    expect(mocks.generateContentStreamMock).toHaveBeenCalledTimes(2)
    expect(events).toContainEqual({ event: 'chunk', data: { text: 'chunk from fallback key' } })
    expect(events).toContainEqual({
      event: 'key_status',
      data: { provider: 'gemini', keyId: 'g2', status: 'success' },
    })
    expect(events.some(event => event.event === 'error')).toBe(false)
  })

  it('does not change Gemini keys after partial output has started', async () => {
    mocks.generateContentStreamMock
      .mockResolvedValueOnce((async function* partialStream() {
        yield { text: 'partial' }
        throw Object.assign(new Error('Service unavailable'), { status: 503 })
      })())

    const events = await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [
        { id: 'g1', key: 'AIza-primary-key-aaaaaaaa' },
        { id: 'g2', key: 'AIza-fallback-key-bbbbbb' },
      ],
    ))

    expect(mocks.generateContentStreamMock).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual({ event: 'chunk', data: { text: 'partial' } })
    expect(events.at(-1)).toEqual(expect.objectContaining({
      event: 'error',
      data: expect.objectContaining({ code: 'service_unavailable' }),
    }))
  })

  it('falls back to non-streaming generation on a streaming transport failure', async () => {
    mocks.generateContentStreamMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    mocks.generateContentMock.mockResolvedValueOnce({ text: 'fallback response' })

    const events = await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [{ id: 'g1', key: 'AIza-working-key-aaaaaaaa' }],
    ))

    expect(events).toContainEqual({
      event: 'key_status',
      data: { provider: 'gemini', keyId: 'g1', status: 'success' },
    })
    expect(events).toContainEqual({ event: 'chunk', data: { text: 'fallback response' } })
    expect(events.some(event => event.event === 'error')).toBe(false)
    expect(mocks.generateContentMock).toHaveBeenCalledTimes(1)
  })

  it('does not fall back when a single key returns an invalid 400 error', async () => {
    mocks.generateContentStreamMock.mockRejectedValueOnce(
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
    expect(mocks.generateContentStreamMock).toHaveBeenCalledTimes(1)
  })

  it('does not fall back when a single key refuses content for SAFETY reasons', async () => {
    mocks.generateContentStreamMock.mockRejectedValueOnce(
      Object.assign(new Error('blocked content SAFETY'), { status: 400 })
    )

    const events = await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [{ id: 'g1', key: 'AIza-safety-key-aaaaaaaa' }],
    ))

    const keyStatuses = events.filter(e => e.event === 'key_status').map(e => e.data)
    expect(keyStatuses).toEqual([])
    expect(events.some(e => e.event === 'error')).toBe(true)
    expect(mocks.generateContentStreamMock).toHaveBeenCalledTimes(1)
  })

  it('does not mark the key invalid for a model-scoped 403 permission error', async () => {
    mocks.generateContentStreamMock.mockRejectedValueOnce(
      Object.assign(new Error('PERMISSION_DENIED for gemini-3.6-flash'), { status: 403 })
    )

    const events = await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [{ id: 'g1', key: 'AIza-permission-key' }],
      undefined,
      'gemini-3.6-flash',
    ))

    expect(events.some(event => event.event === 'key_status')).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({
      event: 'error',
      data: expect.objectContaining({ code: 'permission_denied' }),
    }))
  })

  it('falls back through lite models when the requested model is unavailable', async () => {
    mocks.generateContentStreamMock.mockRejectedValue(
      Object.assign(new Error('NOT_FOUND: models/gemini-3.6-flash is not found'), { status: 404 })
    )

    const events = await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [{ id: 'g1', key: 'AIza-model-key-aaaaaaaa' }],
      undefined,
      'gemini-3.6-flash',
    ))

    expect(mocks.generateContentStreamMock.mock.calls.map(([parameters]) => parameters.model)).toEqual([
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
    ])
    expect(events.at(-1)).toEqual(expect.objectContaining({
      event: 'error',
      data: expect.objectContaining({ code: 'model_unavailable' }),
    }))
    expect(events.some(event => event.event === 'key_status')).toBe(false)
    expect(mocks.generateContentMock).not.toHaveBeenCalled()
  })

  it('falls back through lite models on a 503 without calling the non-stream fallback', async () => {
    mocks.generateContentStreamMock.mockRejectedValue(
      Object.assign(new Error('UNAVAILABLE: The model is overloaded'), { status: 503 })
    )

    const events = await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [{ id: 'g1', key: 'AIza-service-key-aaaaaa' }],
      undefined,
      'gemini-3.6-flash',
    ))

    expect(mocks.generateContentStreamMock.mock.calls.map(([parameters]) => parameters.model)).toEqual([
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
    ])
    expect(events.at(-1)).toEqual(expect.objectContaining({
      event: 'error',
      data: expect.objectContaining({ code: 'service_unavailable' }),
    }))
    expect(mocks.generateContentMock).not.toHaveBeenCalled()
  })

  it('falls back to gemini-3.5-flash-lite when the requested model hits quota', async () => {
    mocks.generateContentStreamMock
      .mockRejectedValueOnce(Object.assign(new Error('quota exceeded for gemini-3.8-flash'), { status: 429 }))
      .mockResolvedValueOnce(geminiStream('Lite answer'))

    const events = await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [{ id: 'g1', key: 'AIza-quota-key-aaaaaaaa' }],
      undefined,
      'gemini-3.8-flash',
    ))

    expect(mocks.generateContentStreamMock.mock.calls.map(([parameters]) => parameters.model)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
    ])
    expect(events).toContainEqual({ event: 'chunk', data: { text: 'Lite answer' } })
    expect(events).toContainEqual({
      event: 'model_resolved',
      data: { provider: 'gemini', requestedModel: 'gemini-3.8-flash', resolvedModel: 'gemini-3.5-flash-lite' },
    })
    expect(events.some(event => event.event === 'error')).toBe(false)
  })

  it('tries the other lite model when the lightest lite model hits quota', async () => {
    mocks.generateContentStreamMock.mockRejectedValue(
      Object.assign(new Error('quota exceeded'), { status: 429 })
    )

    const events = await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [{ id: 'g1', key: 'AIza-lite-key-aaaaaaaa' }],
      undefined,
      'gemini-3.1-flash-lite',
    ))

    expect(mocks.generateContentStreamMock.mock.calls.map(([parameters]) => parameters.model)).toEqual([
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash-lite',
    ])
    expect(events.at(-1)).toEqual(expect.objectContaining({
      event: 'error',
      data: expect.objectContaining({ code: 'quota_exceeded' }),
    }))
  })

  it.each([
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
  ])('uses the extended startup deadline and then tries the safe lite fallbacks for %s', async model => {
    vi.useFakeTimers()
    try {
      const requestSignals = []
      mocks.generateContentStreamMock.mockImplementation(parameters => {
        requestSignals.push(parameters.config.abortSignal)
        return new Promise(() => {})
      })

      const eventsPromise = collectEvents(streamChat(
        [{ role: 'user', content: 'question' }],
        {},
        [{ id: 'g1', key: 'AIza-slow-key-aaaaaaaaa' }],
        undefined,
        model,
      ))

      await vi.advanceTimersByTimeAsync(120000)
      expect(mocks.generateContentStreamMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(240000)
      const events = await eventsPromise

      expect(events).toContainEqual(expect.objectContaining({
        event: 'error',
        data: expect.objectContaining({ code: 'timeout' }),
      }))
      expect(mocks.generateContentStreamMock.mock.calls.map(([parameters]) => parameters.model)).toEqual([
        model,
        'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite',
      ])
      expect(requestSignals.every(signal => signal.aborted)).toBe(true)
      expect(mocks.generateContentMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports an SDK-internal abort as timeout when both streaming and recovery fail', async () => {
    const sdkTimeout = new DOMException('The operation was aborted', 'AbortError')
    mocks.generateContentStreamMock.mockRejectedValue(sdkTimeout)
    mocks.generateContentMock.mockRejectedValue(sdkTimeout)

    const events = await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [{ id: 'g1', key: 'AIza-sdk-timeout-key' }],
      undefined,
      'gemini-3.6-flash',
    ))

    expect(events).toContainEqual(expect.objectContaining({
      event: 'error',
      data: expect.objectContaining({ code: 'timeout' }),
    }))
    expect(mocks.generateContentStreamMock.mock.calls.map(([parameters]) => parameters.model)).toEqual([
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
    ])
    expect(mocks.generateContentMock).not.toHaveBeenCalled()
  })

  it('returns an error instead of completing successfully when the model stream is empty', async () => {
    mocks.generateContentStreamMock.mockResolvedValueOnce(geminiStream(''))

    const events = await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [{ id: 'g1', key: 'AIza-key-aaaaaaaaaaaa' }],
    ))

    expect(events.some(event => event.event === 'chunk')).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({ event: 'error' }))
    expect(events).not.toContainEqual(expect.objectContaining({
      event: 'key_status',
      data: expect.objectContaining({ status: 'success' }),
    }))
  })
})

describe('cross-provider Gemini fallback', () => {
  const ollamaKeys = [{ id: 'o1', key: 'ollama-key' }]
  const geminiFallbackKeys = [{ id: 'g1', key: 'gemini-key' }]
  const ollamaErrorResponse = (status, message) => ({
    ok: false,
    status,
    json: async () => ({ error: { message, code: status } }),
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('falls back to gemini-3.5-flash-lite when Ollama hits quota', async () => {
    global.fetch = vi.fn().mockResolvedValue(ollamaErrorResponse(429, 'rate limit'))
    mocks.generateContentStreamMock.mockResolvedValue(geminiStream('Gemini lite answer'))

    const events = await collectEvents(streamChat(
      [{ role: 'user', content: 'selam' }],
      { fallbackGeminiKeys: geminiFallbackKeys },
      ollamaKeys,
      undefined,
      'gpt-oss:120b',
      'ollama',
    ))

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(mocks.generateContentStreamMock.mock.calls.map(([parameters]) => parameters.model)).toEqual([
      'gemini-3.5-flash-lite',
    ])
    expect(events).toContainEqual({ event: 'chunk', data: { text: 'Gemini lite answer' } })
    expect(events).toContainEqual({
      event: 'model_resolved',
      data: { provider: 'gemini', requestedModel: 'gpt-oss:120b', resolvedModel: 'gemini-3.5-flash-lite' },
    })
    expect(events.some(event => event.event === 'error')).toBe(false)
  })

  it('keeps the remote error when no Gemini fallback keys are available', async () => {
    global.fetch = vi.fn().mockResolvedValue(ollamaErrorResponse(429, 'rate limit'))

    const events = await collectEvents(streamChat(
      [{ role: 'user', content: 'selam' }],
      {},
      ollamaKeys,
      undefined,
      'gpt-oss:120b',
      'ollama',
    ))

    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'rate_limited' } })
    expect(mocks.generateContentStreamMock).not.toHaveBeenCalled()
  })

  it('does not fall back on authentication errors even with Gemini keys present', async () => {
    global.fetch = vi.fn().mockResolvedValue(ollamaErrorResponse(401, 'unauthorized'))

    const events = await collectEvents(streamChat(
      [{ role: 'user', content: 'selam' }],
      { fallbackGeminiKeys: geminiFallbackKeys },
      ollamaKeys,
      undefined,
      'gpt-oss:120b',
      'ollama',
    ))

    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'api_key_invalid' } })
    expect(mocks.generateContentStreamMock).not.toHaveBeenCalled()
  })
})

describe('model selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.generateContentStreamMock.mockResolvedValue(geminiStream('ok'))
  })

  it('exports the 11 supported model ids with DEFAULT_MODEL as gemini-3.1-flash-lite', () => {
    expect(DEFAULT_MODEL).toBe('gemini-3.1-flash-lite')
    expect(MODELS).toEqual([
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash-lite',
      'gemini-3.6-flash',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'nex-agi/nex-n2.5-pro:free',
      'qwen/qwen3.8-27b:free',
      'nvidia/nemotron-3.5-lightning:free',
      'gpt-oss:120b',
      'nemotron-3-super',
      'nemotron-3-ultra',
    ])
  })

  it('passes the selected model into generateContentStream for streamChat', async () => {
    await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [{ id: 'g1', key: 'AIza-key-aaaaaaaaaaaa' }],
      undefined,
      'gemini-3.7-flash',
    ))

    expect(mocks.generateContentStreamMock.mock.calls[0][0].model).toBe('gemini-3.7-flash')
    expect(mocks.clientOptionsMock).toHaveBeenCalledWith({
      apiKey: 'AIza-key-aaaaaaaaaaaa',
      httpOptions: {
        apiVersion: 'v1',
      },
    })
  })

  it.each([
    'nemotron-3-ultra',
    'gpt-oss:120b',
  ])('passes the selected Ollama model %s to the direct provider request', async modelId => {
    global.fetch = vi.fn().mockResolvedValue(ollamaStream('ok', modelId))

    await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [{ id: 'o1', key: 'ollama-key' }],
      undefined,
      modelId,
      'ollama',
    ))

    expect(JSON.parse(global.fetch.mock.calls[0][1].body).model).toBe(modelId)
  })

  it('passes the selected model into generateContentStream for streamVision', async () => {
    await collectEvents(streamVision(
      [{ role: 'user', content: 'describe', attachments: [] }],
      'fallback-image',
      {},
      [{ id: 'g1', key: 'AIza-key-aaaaaaaaaaaa' }],
      undefined,
      'gemini-3.7-flash',
    ))

    expect(mocks.generateContentStreamMock.mock.calls[0][0].model).toBe('gemini-3.7-flash')
  })

  it('falls back to DEFAULT_MODEL when no model argument is supplied for streamChat', async () => {
    await collectEvents(streamChat(
      [{ role: 'user', content: 'question' }],
      {},
      [{ id: 'g1', key: 'AIza-key-aaaaaaaaaaaa' }],
      undefined,
    ))

    expect(mocks.generateContentStreamMock.mock.calls[0][0].model).toBe(DEFAULT_MODEL)
  })

  it('testKey always uses the low-usage Gemini test model', async () => {
    mocks.generateContentMock.mockResolvedValue({ candidates: [{}] })

    await testKey('gemini', 'AIza-valid-key-12345abcde')
    await testKey('gemini', 'AIza-valid-key-12345abcde', 'gemini-3.7-flash')

    expect(mocks.generateContentMock.mock.calls[0][0].model).toBe(DEFAULT_MODEL)
    expect(mocks.generateContentMock.mock.calls[1][0].model).toBe(DEFAULT_MODEL)
  })
})
