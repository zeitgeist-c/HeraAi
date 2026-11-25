import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OPENROUTER_MODEL_IDS, configureModelCatalog } from './models.js'

import {
  OPENROUTER_MODEL,
  streamRemoteProvider,
  testOpenRouterKey,
} from './providerApi.js'

const encoder = new TextEncoder()

function streamResponse(chunks, status = 200) {
  let index = 0
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ error: { message: `HTTP ${status}` } }),
    body: {
      getReader: () => ({
        read: async () => index < chunks.length
          ? { value: encoder.encode(chunks[index++]), done: false }
          : { value: undefined, done: true },
      }),
    },
  }
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  }
}

async function collect(stream) {
  const events = []
  for await (const event of stream) events.push(event)
  return events
}

const keys = [{ id: 'primary', key: 'secret', isPrimary: true }]
const messages = [{ role: 'user', content: 'Hello' }]

describe('fixed catalog request isolation', () => {
  afterEach(() => { configureModelCatalog(null); vi.restoreAllMocks() })
  it('falls back to the next fixed model using its own key', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ error: { message: 'Unavailable' } }, 503))
      .mockResolvedValueOnce(streamResponse(['data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n']))
    const events = await collect(streamRemoteProvider('openrouter', messages, {}, [{ id: 'a', key: 'secret-a' }, { id: 'b', key: 'secret-b' }], undefined, null, 'nvidia/nemotron-3.5-lightning:free'))
    expect(global.fetch.mock.calls.map(([, options]) => [JSON.parse(options.body).model, options.headers.Authorization])).toEqual([
      ['nvidia/nemotron-3.5-lightning:free', 'Bearer secret-a'], ['nvidia/nemotron-3.5-lightning:free', 'Bearer secret-b'],
    ])
    expect(events).toContainEqual({ event: 'chunk', data: { text: 'answer' } })
  })
})

describe('OpenRouter provider adapter', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('parses fragmented SSE frames, comments, DONE and resolved model data', async () => {
    global.fetch.mockResolvedValue(streamResponse([
      ': keepalive\n\ndata: {"model":"nvidia/nemotron-3.5-lightning:free","choices":[{"delta":{"content":"Hel',
      'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n',
    ]))

    const events = await collect(streamRemoteProvider('openrouter', messages, {}, keys))

    expect(events).toEqual([
      { event: 'model_resolved', data: { provider: 'openrouter', requestedModel: OPENROUTER_MODEL, resolvedModel: OPENROUTER_MODEL } },
      { event: 'key_status', data: { provider: 'openrouter', keyId: 'primary', status: 'success' } },
      { event: 'chunk', data: { text: 'Hello' } },
      { event: 'chunk', data: { text: ' world' } },
    ])
    const body = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(body.model).toBe(OPENROUTER_MODEL)
  })

  it('sends the selected catalog model and routes nothing on its own', async () => {
    global.fetch.mockResolvedValue(streamResponse([
      'data: {"model":"nvidia/nemotron-3.5-super-vl:free","choices":[{"delta":{"content":"hi"}}]}\n\n',
    ]))

    const events = await collect(streamRemoteProvider('openrouter', messages, {}, keys, undefined, null, 'nvidia/nemotron-3.5-super-vl:free'))

    const body = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(body.model).toBe('nvidia/nemotron-3.5-super-vl:free')
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(events).toEqual(expect.arrayContaining([
      { event: 'chunk', data: { text: 'hi' } },
    ]))
    expect(events.find(event => event.event === 'error')).toBeUndefined()
  })

  it('falls back to the next catalog model when the selected one is gone', async () => {
    global.fetch
      .mockResolvedValueOnce(streamResponse([], 404))
      .mockResolvedValueOnce(streamResponse([
        'data: {"model":"nvidia/nemotron-3.5-super-vl:free","choices":[{"delta":{"content":"ok"}}]}\n\n',
      ]))

    const events = await collect(streamRemoteProvider('openrouter', messages, {}, keys, undefined, null, 'nvidia/nemotron-3.5-lightning:free'))

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).model).toBe('nvidia/nemotron-3.5-lightning:free')
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).model).toBe('nvidia/nemotron-3.5-super-vl:free')
    expect(events).toEqual(expect.arrayContaining([
      { event: 'model_resolved', data: { provider: 'openrouter', requestedModel: 'nvidia/nemotron-3.5-lightning:free', resolvedModel: 'nvidia/nemotron-3.5-super-vl:free' } },
      { event: 'chunk', data: { text: 'ok' } },
    ]))
    expect(events.find(event => event.event === 'error')).toBeUndefined()
  })

  it('never switches to a model outside the catalog, not even for an unknown id', async () => {
    global.fetch.mockResolvedValue(streamResponse([], 404))

    const events = await collect(streamRemoteProvider('openrouter', messages, {}, keys, undefined, null, 'meta-llama/legacy-model:free'))

    expect(global.fetch.mock.calls.map(call => JSON.parse(call[1].body).model)).toEqual([
      'meta-llama/legacy-model:free',
      OPENROUTER_MODEL_IDS[0],
    ])
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'model_unavailable' } })
  })

  it('falls back to the next catalog model when the selected one is rate-limited', async () => {
    global.fetch
      .mockResolvedValueOnce(streamResponse([], 429))
      .mockResolvedValueOnce(streamResponse([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      ]))

    const events = await collect(streamRemoteProvider('openrouter', messages, {}, keys, undefined, null, 'nvidia/nemotron-3.5-lightning:free'))

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).model).toBe('nvidia/nemotron-3.5-super-vl:free')
    expect(events.find(event => event.event === 'chunk')?.data.text).toBe('ok')
    expect(events.find(event => event.event === 'error')).toBeUndefined()
  })

  it('falls back to a catalog model after a transient network failure and wraps at the end of the list', async () => {
    global.fetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(streamResponse([
        'data: {"model":"nvidia/nemotron-3.5-lightning:free","choices":[{"delta":{"content":"recovered"}}]}\n\n',
      ]))

    const events = await collect(streamRemoteProvider(
      'openrouter',
      messages,
      {},
      keys,
      undefined,
      null,
      'inclusionai/ling-3.2-flash:free',
    ))

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).model).toBe('nvidia/nemotron-3.5-lightning:free')
    expect(events).toContainEqual({ event: 'chunk', data: { text: 'recovered' } })
    expect(events.some(event => event.event === 'error')).toBe(false)
  })

  it('keeps the image request on an image-capable catalog model', async () => {
    global.fetch.mockResolvedValue(streamResponse([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    ]))
    const imageMessages = [{ role: 'user', content: 'Look', attachments: [{ mimeType: 'image/png', data: 'BASE64' }] }]

    const events = await collect(streamRemoteProvider('openrouter', imageMessages, {}, keys, undefined, null, 'nvidia/nemotron-3.5-super-vl:free'))

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).model).toBe('nvidia/nemotron-3.5-super-vl:free')
    expect(events.find(event => event.event === 'chunk')?.data.text).toBe('ok')
  })

  it('does not fall back after partial output', async () => {
    global.fetch.mockResolvedValue(streamResponse([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"error":{"code":429,"message":"rate limit"}}\n\n',
    ]))

    const events = await collect(streamRemoteProvider('openrouter', messages, {}, keys, undefined, null, 'nvidia/nemotron-3.5-super-vl:free'))

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(events.find(event => event.event === 'chunk')?.data.text).toBe('partial')
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'rate_limited' } })
  })

  it('maps an error embedded in a 200 stream without falling across providers', async () => {
    global.fetch.mockImplementation(() => streamResponse([
      'data: {"error":{"code":429,"message":"rate limit"}}\n\n',
    ]))
    const events = await collect(streamRemoteProvider('openrouter', messages, {}, keys))
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'rate_limited' } })
    expect(global.fetch.mock.calls.map(call => JSON.parse(call[1].body).model)).toEqual([
      OPENROUTER_MODEL,
      OPENROUTER_MODEL_IDS[1],
    ])
  })

  it('tries the next key from the same provider before any output starts', async () => {
    global.fetch
      .mockResolvedValueOnce(streamResponse([], 401))
      .mockResolvedValueOnce(streamResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']))
    const events = await collect(streamRemoteProvider('openrouter', messages, {}, [
      ...keys,
      { id: 'fallback', key: 'other' },
    ]))
    expect(events.find(event => event.event === 'chunk')?.data.text).toBe('ok')
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer other')
  })

  it('does not change OpenRouter keys after partial output has started', async () => {
    global.fetch.mockResolvedValue(streamResponse([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"error":{"code":503,"message":"upstream unavailable"}}\n\n',
    ]))
    const events = await collect(streamRemoteProvider('openrouter', messages, {}, [
      ...keys,
      { id: 'fallback', key: 'other' },
    ]))

    expect(events.find(event => event.event === 'chunk')?.data.text).toBe('partial')
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'service_unavailable' } })
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    [401, 'api_key_invalid'],
    [429, 'rate_limited'],
    [503, 'service_unavailable'],
  ])('maps HTTP %i to %s', async (status, code) => {
    global.fetch.mockResolvedValue(streamResponse([], status))
    const events = await collect(streamRemoteProvider('openrouter', messages, {}, keys))
    expect(events.at(-1)).toEqual({ event: 'error', data: { code } })
  })

  it('honors caller aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(collect(streamRemoteProvider('openrouter', messages, {}, keys, controller.signal)))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('turns a stalled request into a timeout error', async () => {
    vi.useFakeTimers()
    global.fetch.mockImplementation((_url, request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    }))
    const pending = collect(streamRemoteProvider('openrouter', messages, {}, keys))
    await vi.advanceTimersByTimeAsync(180_000)
    await vi.advanceTimersByTimeAsync(180_000)
    await expect(pending).resolves.toEqual(expect.arrayContaining([
      { event: 'error', data: { code: 'timeout' } },
    ]))
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('validates a key with a zero-cost OpenRouter auth check', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ data: { label: 'Hera', limit: 0 } }))
    await expect(testOpenRouterKey(' secret ')).resolves.toMatchObject({ success: true })
    const [url, request] = global.fetch.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/auth/key')
    expect(request).toEqual(expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
    }))
    expect(request.body).toBeUndefined()
  })

  it('rejects a malformed OpenRouter auth response without calling the key invalid', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ unexpected: true }))
    await expect(testOpenRouterKey('secret')).resolves.toEqual({
      success: false,
      provider: 'openrouter',
      errorType: 'invalid_response',
    })
  })

  it('maps OpenRouter auth failures to invalid and rate_limit', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ error: { message: 'Invalid API key', code: 401 } }, 401))
    await expect(testOpenRouterKey('secret')).resolves.toEqual({
      success: false,
      provider: 'openrouter',
      errorType: 'invalid',
    })
    global.fetch.mockResolvedValue(jsonResponse({ error: { message: 'Rate limit exceeded', code: 429 } }, 429))
    await expect(testOpenRouterKey('secret')).resolves.toEqual({
      success: false,
      provider: 'openrouter',
      errorType: 'rate_limit',
    })
  })
})

describe('OpenRouter request guards', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('rejects PDFs before making a provider request', async () => {
    const pdfMessages = [{ role: 'user', content: 'Read', attachments: [{ mimeType: 'application/pdf', data: 'PDF' }] }]
    const events = await collect(streamRemoteProvider('openrouter', pdfMessages, {}, keys))
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'pdf_requires_gemini' } })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('ignores metadata-only image and PDF references left in history', async () => {
    // Geçmiş turların ek referansları data taşımaz (worker yalnız son mesajı
    // hidratlar); bu ref'ler isteği düşürmemeli.
    global.fetch.mockResolvedValue(streamResponse([
      'data: {"choices":[{"delta":{"content":"Metin yaniti"}}]}\n\n',
    ]))
    const historyMessages = [
      { role: 'user', content: 'eski gorsel', attachments: [{ id: 'a1', name: 'a.png', mimeType: 'image/png' }] },
      { role: 'model', content: 'tamam' },
      { role: 'user', content: 'eski pdf', attachments: [{ id: 'a2', name: 'b.pdf', mimeType: 'application/pdf' }] },
      { role: 'model', content: 'tamam' },
      { role: 'user', content: 'yeni soru' },
    ]

    const events = await collect(streamRemoteProvider('openrouter', historyMessages, {}, keys))

    expect(events.some(event => event.event === 'error')).toBe(false)
    expect(events).toContainEqual({ event: 'chunk', data: { text: 'Metin yaniti' } })
    expect(global.fetch).toHaveBeenCalled()
  })

  it('reports an invalid key without switching models', async () => {
    global.fetch.mockResolvedValue(streamResponse([], 401))
    const events = await collect(streamRemoteProvider('openrouter', messages, {}, keys))
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'api_key_invalid' } })
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
})
