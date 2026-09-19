import { afterEach, describe, expect, it, vi } from 'vitest'

import { createOffscreenBridge } from './offscreen-bootstrap.js'

class FakeWorker {
  constructor() {
    this.postMessage = vi.fn()
    this.terminate = vi.fn()
    this.onmessage = null
    this.onerror = null
    this.onmessageerror = null
  }

  emit(data) {
    this.onmessage?.({ data })
  }
}

function createRuntime() {
  let listener = null
  return {
    id: 'test-extension-id',
    sendMessage: vi.fn().mockResolvedValue({ ok: true }),
    onMessage: {
      addListener: vi.fn(nextListener => { listener = nextListener }),
      removeListener: vi.fn(nextListener => {
        if (listener === nextListener) listener = null
      }),
    },
    getListener: () => (message, sender, sendResponse) => listener(message, sender || { id: 'test-extension-id' }, sendResponse),
  }
}

function dispatchRuntime(runtime, message) {
  let response
  const sendResponse = vi.fn(value => { response = value })
  const keepChannelOpen = runtime.getListener()(message, { id: runtime.id }, sendResponse)
  return { keepChannelOpen, response, sendResponse }
}

function serviceWorkerCommand(message) {
  return {
    target: 'offscreen',
    forwardedBy: 'service_worker',
    ...message,
  }
}

describe('offscreen bootstrap bridge', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects messages whose sender is not this extension', () => {
    const runtime = createRuntime()
    const bridge = createOffscreenBridge({
      runtime,
      createWorker: () => new FakeWorker(),
    })
    expect(bridge.mount()).toBe(true)
    expect(runtime.getListener()(
      serviceWorkerCommand({ type: 'OFFSCREEN_PROBE' }),
      { id: 'baska-bir-eklenti' },
    )).toBe(false)
  })

  it('starts only resolved jobs and forwards worker protocol messages to the service worker', () => {
    const runtime = createRuntime()
    const workers = []
    const bridge = createOffscreenBridge({
      runtime,
      createWorker: () => {
        const worker = new FakeWorker()
        workers.push(worker)
        return worker
      },
    })

    expect(bridge.mount()).toBe(true)
    expect(runtime.onMessage.addListener).toHaveBeenCalledTimes(1)
    expect(runtime.getListener()({ type: 'HERA_GENERATION_START', jobId: 'panel-copy' })).toBe(false)
    expect(runtime.getListener()({
      type: 'HERA_GENERATION_START',
      jobId: 'panel-copy-with-keys',
      geminiKeys: [],
    })).toBe(false)
    expect(runtime.getListener()({
      type: 'HERA_GENERATION_START',
      target: 'offscreen',
      jobId: 'missing-forwarder',
      geminiKeys: [],
    })).toBe(false)
    expect(runtime.getListener()({
      type: 'HERA_GENERATION_START',
      forwardedBy: 'service_worker',
      jobId: 'missing-target',
      geminiKeys: [],
    })).toBe(false)
    expect(workers).toHaveLength(0)

    const startMessage = serviceWorkerCommand({
      type: 'HERA_GENERATION_START',
      jobId: 'job-1',
      mode: 'vision',
      model: 'gemini-test',
      requestMessages: [{ role: 'user', content: 'describe', attachments: [] }],
      geminiKeys: [{ id: 'g1', key: 'secret' }],
      tavilyKeys: [],
      systemInstruction: 'system',
      language: 'tr',
    })
    expect(runtime.getListener()(startMessage)).toBe(false)
    expect(workers).toHaveLength(1)
    const worker = workers[0]
    expect(worker.postMessage).toHaveBeenCalledWith({
      jobId: 'job-1',
      mode: 'vision',
      model: 'gemini-test',
      requestMessages: startMessage.requestMessages,
      geminiKeys: startMessage.geminiKeys,
      providerKeys: startMessage.geminiKeys,
      tavilyKeys: [],
      systemInstruction: 'system',
      language: 'tr',
      target: 'offscreen',
      forwardedBy: 'service_worker',
      kind: 'start',
    })
    expect(worker.postMessage.mock.calls[0][0]).not.toHaveProperty('type')
  })

  it('handshakes readiness, acknowledges START, and treats a repeated START as idempotent', () => {
    const runtime = createRuntime()
    const workers = []
    const bridge = createOffscreenBridge({
      runtime,
      createWorker: () => {
        const worker = new FakeWorker()
        workers.push(worker)
        return worker
      },
    })
    bridge.mount()

    const initialProbe = dispatchRuntime(runtime, serviceWorkerCommand({ type: 'OFFSCREEN_PROBE' }))
    expect(initialProbe.keepChannelOpen).toBe(false)
    expect(initialProbe.response).toEqual({
      ok: true,
      ready: true,
      activeJobIds: [],
      terminalForwardingJobIds: [],
    })

    const start = serviceWorkerCommand({
      type: 'HERA_GENERATION_START',
      jobId: 'job-idempotent',
      geminiKeys: [],
    })
    expect(dispatchRuntime(runtime, start).response).toEqual({
      ok: true,
      accepted: true,
      jobId: 'job-idempotent',
    })
    expect(dispatchRuntime(runtime, start).response).toEqual({
      ok: true,
      accepted: true,
      alreadyStarted: true,
      jobId: 'job-idempotent',
    })
    expect(workers).toHaveLength(1)
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1)

    expect(dispatchRuntime(runtime, serviceWorkerCommand({ type: 'OFFSCREEN_PROBE' })).response)
      .toMatchObject({ activeJobIds: ['job-idempotent'], terminalForwardingJobIds: [] })
    expect(dispatchRuntime(runtime, serviceWorkerCommand({
      type: 'HERA_GENERATION_START',
      jobId: 'job-conflict',
      geminiKeys: [],
    })).response).toEqual({
      ok: false,
      accepted: false,
      errorCode: 'already_running',
      activeJobId: 'job-idempotent',
    })
    expect(workers).toHaveLength(1)
  })

  it('keeps a terminal-forwarding tombstone visible to probes until the service worker acknowledges it', async () => {
    let resolveTerminal
    const runtime = createRuntime()
    runtime.sendMessage.mockImplementation(message => {
      if (message.type !== 'WORKER_DONE') return Promise.resolve({ ok: true })
      return new Promise(resolve => { resolveTerminal = resolve })
    })
    const worker = new FakeWorker()
    const bridge = createOffscreenBridge({ runtime, createWorker: () => worker })
    bridge.mount()
    dispatchRuntime(runtime, serviceWorkerCommand({
      type: 'HERA_GENERATION_START',
      jobId: 'job-terminal-race',
      geminiKeys: [],
    }))

    worker.emit({
      kind: 'done',
      cancelled: false,
      finalRev: 2,
      content: 'complete',
      sources: [],
    })

    expect(bridge.getJobCount()).toBe(0)
    expect(dispatchRuntime(runtime, serviceWorkerCommand({ type: 'OFFSCREEN_PROBE' })).response)
      .toMatchObject({ activeJobIds: [], terminalForwardingJobIds: ['job-terminal-race'] })

    resolveTerminal({ ok: true, accepted: true })
    await Promise.resolve()
    await Promise.resolve()

    expect(dispatchRuntime(runtime, serviceWorkerCommand({ type: 'OFFSCREEN_PROBE' })).response)
      .toMatchObject({ activeJobIds: [], terminalForwardingJobIds: [] })
  })

  it('routes snapshots, key status, heartbeat, presented, cancel and done messages', () => {
    const runtime = createRuntime()
    const worker = new FakeWorker()
    const bridge = createOffscreenBridge({ runtime, createWorker: () => worker })
    bridge.mount()
    runtime.getListener()(serviceWorkerCommand({
      type: 'HERA_GENERATION_START',
      jobId: 'job-route',
      mode: 'chat',
      geminiKeys: [],
    }))

    worker.emit({ kind: 'snapshot', rev: 3, content: 'full text', sources: [] })
    worker.emit({ kind: 'key_status', provider: 'gemini', keyId: 'g1', status: 'success' })
    worker.emit({
      kind: 'model_resolved',
      provider: 'openrouter',
      requestedModel: 'openrouter/free',
      resolvedModel: 'meta-llama/free',
    })
    worker.emit({ kind: 'heartbeat', uptimeMs: 15_000 })

    expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SNAPSHOT',
      jobId: 'job-route',
      revision: 3,
      content: 'full text',
      sources: [],
      status: 'running',
      resolvedModel: null,
    })
    expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: 'KEY_STATUS',
      jobId: 'job-route',
      provider: 'gemini',
      keyId: 'g1',
      status: 'success',
    })
    expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: 'MODEL_RESOLVED',
      jobId: 'job-route',
      provider: 'openrouter',
      requestedModel: 'openrouter/free',
      resolvedModel: 'meta-llama/free',
    })
    expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: 'HEARTBEAT',
      jobId: 'job-route',
      uptimeMs: 15_000,
    })

    expect(runtime.getListener()({ type: 'PRESENTED', jobId: 'job-route', revision: 3 })).toBe(false)
    expect(runtime.getListener()({ type: 'CANCEL', jobId: 'job-route' })).toBe(false)
    expect(worker.postMessage).not.toHaveBeenCalledWith({ kind: 'presented', jobId: 'job-route', rev: 3 })
    expect(worker.postMessage).not.toHaveBeenCalledWith({ kind: 'cancel', jobId: 'job-route' })
    runtime.getListener()(serviceWorkerCommand({ type: 'PRESENTED', jobId: 'job-route', revision: 3 }))
    runtime.getListener()(serviceWorkerCommand({ type: 'CANCEL', jobId: 'job-route' }))
    expect(worker.postMessage).toHaveBeenCalledWith({ kind: 'presented', jobId: 'job-route', rev: 3 })
    expect(worker.postMessage).toHaveBeenCalledWith({ kind: 'cancel', jobId: 'job-route' })

    worker.emit({
      kind: 'done',
      cancelled: true,
      finalRev: 3,
      content: 'full text',
      sources: [],
      errorCode: null,
      resolvedModel: null,
    })
    expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: 'WORKER_DONE',
      jobId: 'job-route',
      cancelled: true,
      finalRev: 3,
      content: 'full text',
      sources: [],
      errorCode: null,
      resolvedModel: null,
    })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(bridge.getJobCount()).toBe(0)
  })

  it('normalizes worker failures to code-only WORKER_ERROR events and cleans up', () => {
    const runtime = createRuntime()
    const worker = new FakeWorker()
    const bridge = createOffscreenBridge({ runtime, createWorker: () => worker })
    bridge.mount()
    runtime.getListener()(serviceWorkerCommand({
      type: 'HERA_GENERATION_START',
      jobId: 'job-error',
      geminiKeys: [],
    }))

    worker.emit({
      kind: 'error',
      code: 'timeout',
      finalRev: 4,
      content: 'partial',
      sources: [],
      resolvedModel: null,
    })

    expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: 'WORKER_ERROR',
      jobId: 'job-error',
      code: 'timeout',
      errorCode: 'timeout',
      finalRev: 4,
      content: 'partial',
      sources: [],
      resolvedModel: null,
    })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(bridge.getJobCount()).toBe(0)
  })

  it('maps native worker errors to generation_failed and terminates the worker', () => {
    const runtime = createRuntime()
    const worker = new FakeWorker()
    const bridge = createOffscreenBridge({ runtime, createWorker: () => worker })
    bridge.mount()
    runtime.getListener()(serviceWorkerCommand({
      type: 'HERA_GENERATION_START',
      jobId: 'job-native-error',
      geminiKeys: [],
    }))
    const preventDefault = vi.fn()

    worker.onerror({ preventDefault })

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: 'WORKER_ERROR',
      jobId: 'job-native-error',
      code: 'generation_failed',
      errorCode: 'generation_failed',
      finalRev: 0,
      content: '',
      sources: [],
    })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('retries a failed heartbeat with exponential backoff', async () => {
    vi.useFakeTimers()
    const runtime = createRuntime()
    runtime.sendMessage
      .mockRejectedValueOnce(new Error('service worker asleep'))
      .mockRejectedValueOnce(new Error('service worker still asleep'))
      .mockRejectedValueOnce(new Error('service worker still asleep'))
      .mockRejectedValueOnce(new Error('service worker still asleep'))
      .mockResolvedValue(undefined)
    const worker = new FakeWorker()
    const bridge = createOffscreenBridge({ runtime, createWorker: () => worker })
    bridge.mount()
    runtime.getListener()(serviceWorkerCommand({
      type: 'HERA_GENERATION_START',
      jobId: 'job-retry',
      geminiKeys: [],
    }))

    worker.emit({ kind: 'heartbeat', uptimeMs: 15_000 })
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(999)
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(runtime.sendMessage).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(runtime.sendMessage).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runtime.sendMessage).toHaveBeenCalledTimes(5)

    bridge.dispose()
  })
})

describe('offscreen bootstrap comparison bridge', () => {
  const comparisonStart = (jobId = 'job-comparison') => serviceWorkerCommand({
    type: 'HERA_GENERATION_START',
    jobId,
    kind: 'comparison',
    mode: 'chat',
    requestMessages: [{ role: 'user', content: 'compare' }],
    providerKeys: [{ id: 'g1', key: 'secret' }],
    tavilyKeys: [],
    variants: [
      { variantId: 'a', model: 'gemini-3.6-flash', provider: 'gemini' },
      { variantId: 'b', model: 'openrouter/free', provider: 'openrouter' },
    ],
  })

  it('starts one comparison job that counts as the single active job', () => {
    const runtime = createRuntime()
    const worker = new FakeWorker()
    const bridge = createOffscreenBridge({ runtime, createWorker: () => worker })
    bridge.mount()

    const response = dispatchRuntime(runtime, comparisonStart()).response
    expect(response).toEqual({ ok: true, accepted: true, jobId: 'job-comparison' })

    const posted = worker.postMessage.mock.calls[0][0]
    expect(posted.kind).toBe('comparison')
    expect(posted.variants).toEqual([
      { variantId: 'a', model: 'gemini-3.6-flash', provider: 'gemini' },
      { variantId: 'b', model: 'openrouter/free', provider: 'openrouter' },
    ])
    expect(posted).not.toHaveProperty('type')

    // The comparison job still triggers the already_running guard.
    expect(dispatchRuntime(runtime, serviceWorkerCommand({
      type: 'HERA_GENERATION_START',
      jobId: 'job-other',
      geminiKeys: [],
    })).response).toEqual({
      ok: false,
      accepted: false,
      errorCode: 'already_running',
      activeJobId: 'job-comparison',
    })
    expect(bridge.getJobCount()).toBe(1)
  })

  it('forwards variantId on snapshot, model_resolved, per-variant error and aggregate done', () => {
    const runtime = createRuntime()
    const worker = new FakeWorker()
    const bridge = createOffscreenBridge({ runtime, createWorker: () => worker })
    bridge.mount()
    dispatchRuntime(runtime, comparisonStart())

    worker.emit({ kind: 'snapshot', variantId: 'a', rev: 1, content: 'A', sources: [] })
    worker.emit({
      kind: 'model_resolved',
      variantId: 'b',
      provider: 'openrouter',
      requestedModel: 'openrouter/free',
      resolvedModel: 'meta-llama/free',
    })
    expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SNAPSHOT',
      jobId: 'job-comparison',
      variantId: 'a',
      revision: 1,
      content: 'A',
      sources: [],
      status: 'running',
      resolvedModel: null,
    })
    expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: 'MODEL_RESOLVED',
      jobId: 'job-comparison',
      variantId: 'b',
      provider: 'openrouter',
      requestedModel: 'openrouter/free',
      resolvedModel: 'meta-llama/free',
    })

    // A single variant failing is non-terminal: the worker stays alive.
    worker.emit({
      kind: 'error',
      variantId: 'a',
      code: 'timeout',
      finalRev: 2,
      content: 'partial A',
      sources: [],
      resolvedModel: null,
    })
    expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: 'WORKER_ERROR',
      jobId: 'job-comparison',
      variantId: 'a',
      code: 'timeout',
      errorCode: 'timeout',
      finalRev: 2,
      content: 'partial A',
      sources: [],
      resolvedModel: null,
    })
    expect(worker.terminate).not.toHaveBeenCalled()
    expect(bridge.getJobCount()).toBe(1)

    // The aggregate done carries the variants summary and terminates the job.
    const summary = {
      a: { variantId: 'a', status: 'error', content: 'partial A', sources: [], resolvedModel: null, revision: 2, errorCode: 'timeout' },
      b: { variantId: 'b', status: 'completed', content: 'full B', sources: [], resolvedModel: null, revision: 1, errorCode: null },
    }
    worker.emit({ kind: 'done', cancelled: false, finalRev: 2, variants: summary })
    expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: 'WORKER_DONE',
      jobId: 'job-comparison',
      cancelled: false,
      finalRev: 2,
      content: '',
      sources: [],
      resolvedModel: null,
      errorCode: null,
      variants: summary,
    })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(bridge.getJobCount()).toBe(0)
  })

  it('keeps single-job forwards free of variantId', () => {
    const runtime = createRuntime()
    const worker = new FakeWorker()
    const bridge = createOffscreenBridge({ runtime, createWorker: () => worker })
    bridge.mount()
    dispatchRuntime(runtime, serviceWorkerCommand({
      type: 'HERA_GENERATION_START',
      jobId: 'job-single',
      geminiKeys: [],
    }))

    worker.emit({ kind: 'snapshot', rev: 1, content: 'text', sources: [] })
    expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SNAPSHOT',
      jobId: 'job-single',
      revision: 1,
      content: 'text',
      sources: [],
      status: 'running',
      resolvedModel: null,
    })
  })
})
