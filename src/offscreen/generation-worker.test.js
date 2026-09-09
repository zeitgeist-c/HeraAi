import { describe, expect, it, vi } from 'vitest'

import {
  HEARTBEAT_INTERVAL_MS,
  SNAPSHOT_THROTTLE_MS,
  createGenerationWorkerRuntime,
} from './generation-worker.js'
import { cleanupOrphanAttachments, putAttachment } from '../lib/attachmentStore.js'

function asyncEvents(events) {
  return (async function* generateEvents() {
    for (const event of events) yield event
  })()
}

function createEngines(events = []) {
  return {
    streamChat: vi.fn(() => asyncEvents(events)),
    streamVision: vi.fn(() => asyncEvents(events)),
    streamResearch: vi.fn(() => asyncEvents(events)),
  }
}

describe('generation worker runtime', () => {
  it('hydrates active attachment references and reports missing records explicitly', async () => {
    const ref = await putAttachment({
      blob: new Blob(['document'], { type: 'text/plain' }),
      modelText: 'Document body',
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 8,
      kind: 'text',
    })
    const engines = createEngines([])
    const runtime = createGenerationWorkerRuntime({ emit: vi.fn(), engines })
    await runtime.handleMessage({
      kind: 'start',
      jobId: 'hydrate-job',
      mode: 'chat',
      requestMessages: [{ role: 'user', content: 'Read it', attachments: [ref] }],
      attachmentIds: [ref.id],
    })
    expect(engines.streamChat.mock.calls[0][0][0].attachments[0]).toMatchObject({
      id: ref.id,
      modelText: 'Document body',
    })
    await cleanupOrphanAttachments([])

    const emit = vi.fn()
    const missingRuntime = createGenerationWorkerRuntime({ emit, engines: createEngines([]) })
    await missingRuntime.handleMessage({
      kind: 'start',
      jobId: 'missing-job',
      mode: 'chat',
      requestMessages: [{
        role: 'user',
        content: 'Read it',
        attachments: [{ ...ref, id: 'missing-id' }],
      }],
      attachmentIds: ['missing-id'],
    })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', code: 'attachment_missing' }))
  })

  it.each([
    ['chat', 'streamChat'],
    ['vision', 'streamVision'],
    ['web', 'streamResearch'],
  ])('selects the %s stream iterator and passes the request context', async (mode, engineName) => {
    const engines = createEngines([])
    const emit = vi.fn()
    const runtime = createGenerationWorkerRuntime({ emit, engines })
    const requestMessages = [{ role: 'user', content: 'hello' }]
    const geminiKeys = [{ id: 'g1', key: 'gemini-secret' }]
    const tavilyKeys = [{ id: 't1', key: 'tavily-secret' }]

    await runtime.handleMessage({
      kind: 'start',
      jobId: `job-${mode}`,
      mode,
      model: 'gemini-test',
      requestMessages,
      geminiKeys,
      tavilyKeys,
      systemInstruction: 'system',
      language: 'en',
    })

    expect(engines[engineName]).toHaveBeenCalledTimes(1)
    const args = engines[engineName].mock.calls[0]
    expect(args[0]).toBe(requestMessages)
    if (mode === 'web') {
      expect(args[1]).toBe(geminiKeys)
      expect(args[2]).toBe(tavilyKeys)
      expect(args[3]).toBeInstanceOf(AbortSignal)
      expect(args[4]).toBe('gemini-test')
      expect(args[5]).toEqual({ systemInstruction: 'system', language: 'en', fallbackGeminiKeys: [] })
    } else if (mode === 'vision') {
      expect(args[1]).toBeNull()
      expect(args[2]).toEqual({ systemInstruction: 'system', language: 'en', fallbackGeminiKeys: [] })
      expect(args[3]).toBe(geminiKeys)
      expect(args[4]).toBeInstanceOf(AbortSignal)
      expect(args[5]).toBe('gemini-test')
    } else {
      expect(args[1]).toEqual({ systemInstruction: 'system', language: 'en', fallbackGeminiKeys: [] })
      expect(args[2]).toBe(geminiKeys)
      expect(args[3]).toBeInstanceOf(AbortSignal)
      expect(args[4]).toBe('gemini-test')
    }
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'done',
      jobId: `job-${mode}`,
      cancelled: false,
    }))
  })

  it('forwards Gemini fallback keys into the request options', async () => {
    const engines = createEngines([])
    const emit = vi.fn()
    const runtime = createGenerationWorkerRuntime({ emit, engines })
    const fallbackGeminiKeys = [{ id: 'g9', key: 'fallback-secret' }]

    await runtime.handleMessage({
      kind: 'start',
      jobId: 'job-fallback',
      mode: 'chat',
      model: 'gpt-oss:120b',
      provider: 'ollama',
      requestMessages: [{ role: 'user', content: 'hello' }],
      providerKeys: [{ id: 'o1', key: 'ollama-secret' }],
      fallbackGeminiKeys,
      systemInstruction: 'system',
      language: 'en',
    })

    const args = engines.streamChat.mock.calls[0]
    expect(args[1]).toMatchObject({ fallbackGeminiKeys })
  })

  it('emits increasing full-content snapshots with a 150 ms throttle and a final flush', async () => {
    let currentTime = 1_000
    const timers = []
    const clearedTimers = []
    const events = [
      { event: 'chunk', data: { text: 'Hello' } },
      { event: 'chunk', data: { text: ' world' } },
      { event: 'sources', data: { sources: [{ index: 1, url: 'https://example.com' }] } },
    ]
    const emit = vi.fn()
    const runtime = createGenerationWorkerRuntime({
      emit,
      engines: createEngines(events),
      now: () => currentTime,
      setTimeoutFn: (callback, delay) => {
        const timer = { callback, delay }
        timers.push(timer)
        return timer
      },
      clearTimeoutFn: timer => clearedTimers.push(timer),
    })

    await runtime.handleMessage({ kind: 'start', jobId: 'job-snapshot', mode: 'chat' })

    const snapshots = emit.mock.calls
      .map(([event]) => event)
      .filter(event => event.kind === 'snapshot')
    expect(snapshots).toEqual([
      {
        kind: 'snapshot',
        jobId: 'job-snapshot',
        rev: 1,
        content: 'Hello',
        sources: [],
        status: 'running',
        resolvedModel: null,
      },
      {
        kind: 'snapshot',
        jobId: 'job-snapshot',
        rev: 2,
        content: 'Hello world',
        sources: [{ index: 1, url: 'https://example.com' }],
        status: 'running',
        resolvedModel: null,
      },
    ])
    expect(timers).toHaveLength(1)
    expect(timers[0].delay).toBe(SNAPSHOT_THROTTLE_MS)
    expect(clearedTimers).toContain(timers[0])
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'done',
      finalRev: 2,
      content: 'Hello world',
    }))

    currentTime += SNAPSHOT_THROTTLE_MS
  })

  it('forwards key status and emits only an error code after flushing pending content', async () => {
    const emit = vi.fn()
    const engines = createEngines([
      { event: 'chunk', data: { text: 'partial' } },
      { event: 'key_status', data: { provider: 'gemini', keyId: 'g1', status: 'quota_exceeded' } },
      { event: 'error', data: { code: 'quota_exceeded', message: 'localized secret text' } },
    ])
    const runtime = createGenerationWorkerRuntime({ emit, engines })

    await runtime.handleMessage({ kind: 'start', jobId: 'job-error', mode: 'chat' })

    expect(emit).toHaveBeenCalledWith({
      kind: 'key_status',
      jobId: 'job-error',
      provider: 'gemini',
      keyId: 'g1',
      status: 'quota_exceeded',
    })
    const errorEvent = emit.mock.calls.map(([event]) => event).find(event => event.kind === 'error')
    expect(errorEvent).toEqual(expect.objectContaining({
      jobId: 'job-error',
      code: 'quota_exceeded',
      errorCode: 'quota_exceeded',
      content: 'partial',
    }))
    expect(errorEvent).not.toHaveProperty('message')
    expect(emit.mock.calls.map(([event]) => event.kind)).not.toContain('done')
  })

  it('persists resolved model provenance in snapshots and terminal events', async () => {
    const emit = vi.fn()
    const runtime = createGenerationWorkerRuntime({
      emit,
      engines: createEngines([
        { event: 'model_resolved', data: { provider: 'openrouter', resolvedModel: 'meta-llama/free' } },
        { event: 'chunk', data: { text: 'routed' } },
      ]),
    })

    await runtime.handleMessage({ kind: 'start', jobId: 'job-resolved', mode: 'chat' })

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'snapshot',
      resolvedModel: 'meta-llama/free',
    }))
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'done',
      resolvedModel: 'meta-llama/free',
    }))
  })

  it('aborts the active iterator and reports a cancelled terminal event', async () => {
    let capturedSignal
    let currentTime = 10_000
    const emit = vi.fn()
    const engines = createEngines()
    engines.streamChat.mockImplementation((_messages, _options, _keys, signal) => {
      capturedSignal = signal
      return (async function* controlledStream() {
        yield { event: 'chunk', data: { text: 'visible' } }
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
        })
      })()
    })
    let heartbeatCallback = null
    const runtime = createGenerationWorkerRuntime({
      emit,
      engines,
      now: () => currentTime,
      setIntervalFn: (callback, delay) => {
        expect(delay).toBe(HEARTBEAT_INTERVAL_MS)
        heartbeatCallback = callback
        return 1
      },
      clearIntervalFn: vi.fn(),
    })

    const task = runtime.handleMessage({ kind: 'start', jobId: 'job-cancel', mode: 'chat' })
    await vi.waitFor(() => expect(capturedSignal).toBeInstanceOf(AbortSignal))
    expect(emit.mock.calls[0][0]).toEqual({
      kind: 'heartbeat',
      jobId: 'job-cancel',
      uptimeMs: 0,
    })
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'snapshot',
      content: 'visible',
    })))

    currentTime += HEARTBEAT_INTERVAL_MS
    heartbeatCallback()
    expect(emit).toHaveBeenCalledWith({
      kind: 'heartbeat',
      jobId: 'job-cancel',
      uptimeMs: HEARTBEAT_INTERVAL_MS,
    })

    expect(runtime.handleMessage({ kind: 'presented', jobId: 'job-cancel', rev: 1 })).toBe(true)
    expect(runtime.getActiveJob().presentedRevision).toBe(1)
    expect(runtime.handleMessage({ kind: 'cancel', jobId: 'job-cancel' })).toBe(true)
    await task

    expect(capturedSignal.aborted).toBe(true)
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'done',
      jobId: 'job-cancel',
      cancelled: true,
      content: 'visible',
      errorCode: null,
    }))
  })
})
