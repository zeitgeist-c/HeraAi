import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OPENROUTER_MODEL_IDS, configureModelCatalog } from './models.js'

import {
  OLLAMA_CLOUD_MODEL,
  OLLAMA_TEST_MODEL,
  OPENROUTER_MODEL,
  streamRemoteProvider,
  testOllamaKey,
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

describe('personal catalog request isolation', () => {
  afterEach(() => { configureModelCatalog(null); vi.restoreAllMocks() })
  it('falls back only to another selected model using its own discovered key', async () => {
    const model = (id, keyId) => ({ key: `openrouter:${id}`, provider: 'openrouter', modelId: id, sourceKeyIds: [keyId], capabilities: {} })
    configureModelCatalog({ models: [model('selected-a', 'a'), model('selected-b', 'b')], enabledKeys: ['openrouter:selected-a', 'openrouter:selected-b'] })
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ error: { message: 'Unavailable' } }, 503))
      .mockResolvedValueOnce(streamResponse(['data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n']))
    const events = await collect(streamRemoteProvider('openrouter', messages, {}, [{ id: 'a', key: 'secret-a' }, { id: 'b', key: 'secret-b' }], undefined, null, 'selected-a'))
    expect(global.fetch.mock.calls.map(([, options]) => [JSON.parse(options.body).model, options.headers.Authorization])).toEqual([
      ['selected-a', 'Bearer secret-a'], ['selected-b', 'Bearer secret-b'],
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
      ': keepalive\n\ndata: {"model":"google/gemma-4-26b-a4b-it:free","choices":[{"delta":{"content":"Hel',
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
      'data: {"model":"nvidia/nemotron-3-super-120b-a12b:free","choices":[{"delta":{"content":"hi"}}]}\n\n',
    ]))

    const events = await collect(streamRemoteProvider('openrouter', messages, {}, keys, undefined, null, 'nvidia/nemotron-3-super-120b-a12b:free'))

    const body = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(body.model).toBe('nvidia/nemotron-3-super-120b-a12b:free')
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
        'data: {"model":"nvidia/nemotron-3-super-120b-a12b:free","choices":[{"delta":{"content":"ok"}}]}\n\n',
      ]))

    const events = await collect(streamRemoteProvider('openrouter', messages, {}, keys, undefined, null, 'google/gemma-4-26b-a4b-it:free'))

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).model).toBe('google/gemma-4-26b-a4b-it:free')
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).model).toBe('nvidia/nemotron-3-super-120b-a12b:free')
    expect(events).toEqual(expect.arrayContaining([
      { event: 'model_resolved', data: { provider: 'openrouter', requestedModel: 'google/gemma-4-26b-a4b-it:free', resolvedModel: 'nvidia/nemotron-3-super-120b-a12b:free' } },
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

    const events = await collect(streamRemoteProvider('openrouter', messages, {}, keys, undefined, null, 'google/gemma-4-26b-a4b-it:free'))

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).model).toBe('nvidia/nemotron-3-super-120b-a12b:free')
    expect(events.find(event => event.event === 'chunk')?.data.text).toBe('ok')
    expect(events.find(event => event.event === 'error')).toBeUndefined()
  })

  it('falls back to a catalog model after a transient network failure and wraps at the end of the list', async () => {
    global.fetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(streamResponse([
        'data: {"model":"google/gemma-4-26b-a4b-it:free","choices":[{"delta":{"content":"recovered"}}]}\n\n',
      ]))

    const events = await collect(streamRemoteProvider(
      'openrouter',
      messages,
      {},
      keys,
      undefined,
      null,
      'nvidia/nemotron-3.5-lightning:free',
    ))

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).model).toBe('google/gemma-4-26b-a4b-it:free')
    expect(events).toContainEqual({ event: 'chunk', data: { text: 'recovered' } })
    expect(events.some(event => event.event === 'error')).toBe(false)
  })

  it('keeps the image request on the single image-capable catalog model', async () => {
    global.fetch.mockResolvedValue(streamResponse([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    ]))
    const imageMessages = [{ role: 'user', content: 'Look', attachments: [{ mimeType: 'image/png', data: 'BASE64' }] }]

    const events = await collect(streamRemoteProvider('openrouter', imageMessages, {}, keys, undefined, null, 'google/gemma-4-26b-a4b-it:free'))

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).model).toBe('google/gemma-4-26b-a4b-it:free')
    expect(events.find(event => event.event === 'chunk')?.data.text).toBe('ok')
  })

  it('does not fall back after partial output', async () => {
    global.fetch.mockResolvedValue(streamResponse([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"error":{"code":429,"message":"rate limit"}}\n\n',
    ]))

    const events = await collect(streamRemoteProvider('openrouter', messages, {}, keys, undefined, null, 'nvidia/nemotron-3-super-120b-a12b:free'))

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

  it('validates a key with a one-token OpenRouter generation against a catalog model', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'O' } }] }))
    await expect(testOpenRouterKey(' secret ')).resolves.toMatchObject({ success: true })
    const [url, request] = global.fetch.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(request).toEqual(expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
    }))
    expect(JSON.parse(request.body)).toMatchObject({
      model: OPENROUTER_MODEL,
      stream: false,
      max_tokens: 1,
    })
  })

  it('rejects a malformed successful OpenRouter response without calling the key invalid', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ unexpected: true }))
    await expect(testOpenRouterKey('secret')).resolves.toEqual({
      success: false,
      provider: 'openrouter',
      errorType: 'invalid_response',
    })
  })
})

describe('Ollama Cloud provider adapter', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('parses fragmented NDJSON content and ignores thinking', async () => {
    global.fetch.mockResolvedValue(streamResponse([
      '{"model":"nemotron-3-ultra","message":{"thinking":"hidden","content":"Hel',
      'lo"}}\n{"message":{"content":" world"},"done":false}\n{"done":true}\n',
    ]))
    const events = await collect(streamRemoteProvider('ollama', messages, {}, keys))

    expect(events.map(event => event.event)).toEqual(['model_resolved', 'key_status', 'chunk', 'chunk'])
    expect(events.filter(event => event.event === 'chunk').map(event => event.data.text).join('')).toBe('Hello world')
    const body = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(body).toMatchObject({ model: OLLAMA_CLOUD_MODEL, messages: [{ content: 'Hello' }] })
  })

  it.each([
    'nemotron-3-ultra',
    'gpt-oss:120b',
  ])('sends the selected Ollama Cloud model %s through the direct API', async modelId => {
    global.fetch.mockResolvedValue(streamResponse([
      `{"model":"${modelId}","message":{"content":"ok"}}\n`,
    ]))

    const events = await collect(streamRemoteProvider(
      'ollama',
      messages,
      {},
      keys,
      undefined,
      null,
      modelId,
    ))

    expect(JSON.parse(global.fetch.mock.calls[0][1].body).model).toBe(modelId)
    expect(events[0]).toEqual({
      event: 'model_resolved',
      data: {
        provider: 'ollama',
        requestedModel: modelId,
        resolvedModel: modelId,
      },
    })
  })

  it('surfaces a stream error after partial output without trying another key', async () => {
    global.fetch.mockResolvedValue(streamResponse([
      '{"message":{"content":"partial"}}\n{"error":"upstream failed"}\n',
    ]))
    const events = await collect(streamRemoteProvider('ollama', messages, {}, [
      ...keys,
      { id: 'fallback', key: 'other' },
    ]))
    expect(events.find(event => event.event === 'chunk')?.data.text).toBe('partial')
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'generation_failed' } })
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('tries the next Ollama key when the primary fails before output starts', async () => {
    global.fetch
      .mockResolvedValueOnce(streamResponse([], 429))
      .mockResolvedValueOnce(streamResponse(['{"message":{"content":"ok"}}\n']))
    const events = await collect(streamRemoteProvider('ollama', messages, {}, [
      ...keys,
      { id: 'fallback', key: 'other' },
    ]))

    expect(events.find(event => event.event === 'chunk')?.data.text).toBe('ok')
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer other')
  })

  it.each([
    [401, 'api_key_invalid'],
    [404, 'model_unavailable'],
    [429, 'rate_limited'],
    [502, 'service_unavailable'],
  ])('maps HTTP %i to %s', async (status, code) => {
    global.fetch.mockResolvedValue(streamResponse([], status))
    const events = await collect(streamRemoteProvider('ollama', messages, {}, keys))
    expect(events.at(-1)).toEqual({ event: 'error', data: { code } })
  })

  it('validates an Ollama key with a one-token low-thinking GPT-OSS 20B request', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ message: { content: 'O' }, done: true }))
    await expect(testOllamaKey(' secret ')).resolves.toMatchObject({ success: true })
    const [url, request] = global.fetch.mock.calls[0]
    expect(url).toBe('https://ollama.com/api/chat')
    expect(request).toEqual(expect.objectContaining({
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json',
      },
    }))
    expect(JSON.parse(request.body)).toEqual({
      model: OLLAMA_TEST_MODEL,
      messages: [{ role: 'user', content: 'OK' }],
      stream: false,
      think: 'low',
      options: { num_predict: 1 },
    })
  })

  it('reports a 401 from the Ollama generation check as an invalid key', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401))

    await expect(testOllamaKey('bad-key')).resolves.toEqual({
      success: false,
      provider: 'ollama',
      errorType: 'invalid',
    })
  })

  it('rejects a malformed successful Ollama response without calling the key invalid', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ done: true }))
    await expect(testOllamaKey('secret')).resolves.toEqual({
      success: false,
      provider: 'ollama',
      errorType: 'invalid_response',
    })
  })

  it('keeps Ollama model-access and service failures distinct from invalid keys', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ error: 'model not found' }, 404))
    await expect(testOllamaKey('secret')).resolves.toMatchObject({ errorType: 'model_unavailable' })

    global.fetch.mockResolvedValueOnce(jsonResponse({ error: 'upstream unavailable' }, 502))
    await expect(testOllamaKey('secret')).resolves.toMatchObject({ errorType: 'service_unavailable' })
  })

  it('rejects images before making an Ollama request', async () => {
    const imageMessages = [{ role: 'user', content: 'Look', attachments: [{ mimeType: 'image/png', data: 'BASE64' }] }]
    const events = await collect(streamRemoteProvider('ollama', imageMessages, {}, keys))
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'image_not_supported' } })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('rejects PDFs before making a provider request', async () => {
    const pdfMessages = [{ role: 'user', content: 'Read', attachments: [{ mimeType: 'application/pdf', data: 'PDF' }] }]
    const events = await collect(streamRemoteProvider('ollama', pdfMessages, {}, keys))
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'pdf_requires_gemini' } })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('ignores metadata-only image and PDF references left in history', async () => {
    // Geçmiş turların ek referansları data taşımaz (worker yalnız son mesajı
    // hidratlar); bu ref'ler isteği düşürmemeli.
    global.fetch.mockResolvedValue(streamResponse([
      `${JSON.stringify({ model: 'gpt-oss:120b', message: { content: 'Metin yaniti' } })}\n`,
    ]))
    const historyMessages = [
      { role: 'user', content: 'eski gorsel', attachments: [{ id: 'a1', name: 'a.png', mimeType: 'image/png' }] },
      { role: 'model', content: 'tamam' },
      { role: 'user', content: 'eski pdf', attachments: [{ id: 'a2', name: 'b.pdf', mimeType: 'application/pdf' }] },
      { role: 'model', content: 'tamam' },
      { role: 'user', content: 'yeni soru' },
    ]

    const events = await collect(streamRemoteProvider('ollama', historyMessages, {}, keys))

    expect(events.some(event => event.event === 'error')).toBe(false)
    expect(events).toContainEqual({ event: 'chunk', data: { text: 'Metin yaniti' } })
    expect(global.fetch).toHaveBeenCalled()
  })
})
