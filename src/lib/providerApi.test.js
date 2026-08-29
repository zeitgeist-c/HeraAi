import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  OLLAMA_CLOUD_MODEL,
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

async function collect(stream) {
  const events = []
  for await (const event of stream) events.push(event)
  return events
}

const keys = [{ id: 'primary', key: 'secret', isPrimary: true }]
const messages = [{ role: 'user', content: 'Hello' }]

describe('OpenRouter provider adapter', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('parses fragmented SSE frames, comments, DONE and resolved model data', async () => {
    global.fetch.mockResolvedValue(streamResponse([
      ': keepalive\n\ndata: {"model":"meta-llama/free","choices":[{"delta":{"content":"Hel',
      'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n',
    ]))

    const events = await collect(streamRemoteProvider('openrouter', messages, {}, keys))

    expect(events).toEqual([
      { event: 'model_resolved', data: { provider: 'openrouter', requestedModel: OPENROUTER_MODEL, resolvedModel: 'meta-llama/free' } },
      { event: 'key_status', data: { provider: 'openrouter', keyId: 'primary', status: 'success' } },
      { event: 'chunk', data: { text: 'Hello' } },
      { event: 'chunk', data: { text: ' world' } },
    ])
    const body = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(body.model).toBe('openrouter/free')
  })

  it('maps an error embedded in a 200 stream without falling across providers', async () => {
    global.fetch.mockResolvedValue(streamResponse([
      'data: {"error":{"code":429,"message":"rate limit"}}\n\n',
    ]))
    const events = await collect(streamRemoteProvider('openrouter', messages, {}, keys))
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'rate_limited' } })
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
    await vi.advanceTimersByTimeAsync(120_000)
    await expect(pending).resolves.toEqual(expect.arrayContaining([
      { event: 'error', data: { code: 'timeout' } },
    ]))
  })

  it('validates a key with the quota-free current-key endpoint', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200 })
    await expect(testOpenRouterKey(' secret ')).resolves.toMatchObject({ success: true })
    expect(global.fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/key',
      expect.objectContaining({ headers: { Authorization: 'Bearer secret' } }),
    )
  })
})

describe('Ollama Cloud provider adapter', () => {
  beforeEach(() => { global.fetch = vi.fn() })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('parses fragmented NDJSON content, ignores thinking, and forwards raw image base64', async () => {
    global.fetch.mockResolvedValue(streamResponse([
      '{"model":"minimax-m3","message":{"thinking":"hidden","content":"Hel',
      'lo"}}\n{"message":{"content":" world"},"done":false}\n{"done":true}\n',
    ]))
    const withImage = [{ role: 'user', content: 'Look', attachments: [{ mimeType: 'image/png', data: 'BASE64' }] }]
    const events = await collect(streamRemoteProvider('ollama', withImage, {}, keys))

    expect(events.map(event => event.event)).toEqual(['model_resolved', 'key_status', 'chunk', 'chunk'])
    expect(events.filter(event => event.event === 'chunk').map(event => event.data.text).join('')).toBe('Hello world')
    const body = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(body).toMatchObject({ model: OLLAMA_CLOUD_MODEL, messages: [{ images: ['BASE64'] }] })
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

  it('uses a minimal direct minimax-m3 generation to test access', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200 })
    await expect(testOllamaKey(' secret ')).resolves.toMatchObject({ success: true })
    const [url, request] = global.fetch.mock.calls[0]
    expect(url).toBe('https://ollama.com/api/chat')
    expect(JSON.parse(request.body)).toEqual({
      model: 'minimax-m3',
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      stream: false,
      options: { num_predict: 1 },
    })
  })

  it('rejects PDFs before making a provider request', async () => {
    const pdfMessages = [{ role: 'user', content: 'Read', attachments: [{ mimeType: 'application/pdf', data: 'PDF' }] }]
    const events = await collect(streamRemoteProvider('ollama', pdfMessages, {}, keys))
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'pdf_requires_gemini' } })
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
