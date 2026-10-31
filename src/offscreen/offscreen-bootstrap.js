const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000]

// Endless retry leaves an undeliverable terminal message as a permanent lock and
// blocks new jobs (startJob `already_running`); it gives up after a limited
// number of attempts.
const FORWARD_MAX_ATTEMPTS = 8

const createDefaultWorker = () => new Worker(
  new URL('./generation-worker.js', import.meta.url),
  { type: 'module' },
)

function hasResolvedKeys(message) {
  return (
    Object.prototype.hasOwnProperty.call(message || {}, 'providerKeys') ||
    Object.prototype.hasOwnProperty.call(message || {}, 'geminiKeys') ||
    Object.prototype.hasOwnProperty.call(message || {}, 'keysForGemini')
  )
}

function isServiceWorkerCommand(message) {
  return (
    message?.target === 'offscreen' &&
    message?.forwardedBy === 'service_worker'
  )
}

function normalizeStartMessage(message) {
  const { type: _type, keysForGemini, keysForTavily, ...payload } = message
  return {
    ...payload,
    kind: 'start',
    providerKeys: Array.isArray(message.providerKeys)
      ? message.providerKeys
      : (Array.isArray(message.geminiKeys) ? message.geminiKeys : (keysForGemini || [])),
    tavilyKeys: Array.isArray(message.tavilyKeys) ? message.tavilyKeys : (keysForTavily || []),
  }
}

export function createOffscreenBridge({
  runtime = globalThis.chrome?.runtime,
  createWorker = createDefaultWorker,
  setTimeoutFn = (callback, delay) => globalThis.setTimeout(callback, delay),
} = {}) {
  const jobs = new Map()
  const terminalForwardingJobs = new Set()
  let mounted = false
  let disposed = false

  const forwardWithRetry = async (
    payload,
    attempt = 0,
    {
      validateResponse = () => true,
      onDelivered = null,
      onGiveUp = null,
    } = {},
  ) => {
    if (disposed || typeof runtime?.sendMessage !== 'function') return false

    try {
      const response = await Promise.resolve(runtime.sendMessage(payload))
      if (runtime.lastError) throw new Error(runtime.lastError.message || 'Runtime message failed')
      if (!validateResponse(response)) throw new Error('Runtime message was not acknowledged')
      onDelivered?.(response)
      return true
    } catch {
      if (disposed) return false
      if (attempt + 1 >= FORWARD_MAX_ATTEMPTS) {
        onGiveUp?.()
        return false
      }
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
      setTimeoutFn(() => {
        void forwardWithRetry(payload, attempt + 1, { validateResponse, onDelivered, onGiveUp })
      }, delay)
      return false
    }
  }

  const terminateJob = (jobId, expectedWorker = null) => {
    const worker = jobs.get(jobId)
    if (!worker || (expectedWorker && worker !== expectedWorker)) return

    jobs.delete(jobId)
    worker.onmessage = null
    worker.onerror = null
    worker.onmessageerror = null
    worker.terminate()
  }

  const forwardTerminalMessage = (jobId, payload) => {
    terminalForwardingJobs.add(jobId)
    void forwardWithRetry(payload, 0, {
      validateResponse: response => response?.ok === true,
      onDelivered: () => terminalForwardingJobs.delete(jobId),
      onGiveUp: () => terminalForwardingJobs.delete(jobId),
    })
  }

  const forwardWorkerMessage = (jobId, worker, event) => {
    if (jobs.get(jobId) !== worker) return
    const data = event?.data || {}

    if (data.kind === 'snapshot') {
      void forwardWithRetry({
        type: 'SNAPSHOT',
        jobId,
        revision: data.rev ?? data.revision,
        content: data.content || '',
        sources: Array.isArray(data.sources) ? data.sources : [],
        resolvedModel: data.resolvedModel || null,
        status: 'running',
      }, 0, { validateResponse: response => response?.ok === true })
      return
    }

    if (data.kind === 'key_status') {
      void forwardWithRetry({
        type: 'KEY_STATUS',
        jobId,
        provider: data.provider,
        keyId: data.keyId,
        status: data.status,
      })
      return
    }

    if (data.kind === 'model_resolved') {
      void forwardWithRetry({
        type: 'MODEL_RESOLVED',
        jobId,
        provider: data.provider || null,
        requestedModel: data.requestedModel || null,
        resolvedModel: data.resolvedModel || null,
      })
      return
    }

    if (data.kind === 'heartbeat') {
      void forwardWithRetry({
        type: 'HEARTBEAT',
        jobId,
        uptimeMs: data.uptimeMs,
      }, 0, { validateResponse: response => response?.ok === true })
      return
    }

    if (data.kind === 'error') {
      const code = data.code || data.errorCode || 'generation_failed'
      const payload = {
        type: 'WORKER_ERROR',
        jobId,
        code,
        errorCode: code,
        finalRev: data.finalRev ?? data.revision ?? 0,
        content: data.content || '',
        sources: Array.isArray(data.sources) ? data.sources : [],
        resolvedModel: data.resolvedModel || null,
      }
      terminateJob(jobId, worker)
      forwardTerminalMessage(jobId, payload)
      return
    }

    if (data.kind === 'done') {
      const payload = {
        type: 'WORKER_DONE',
        jobId,
        cancelled: Boolean(data.cancelled),
        finalRev: data.finalRev ?? 0,
        content: data.content || '',
        sources: Array.isArray(data.sources) ? data.sources : [],
        resolvedModel: data.resolvedModel || null,
        errorCode: data.errorCode || null,
      }
      terminateJob(jobId, worker)
      forwardTerminalMessage(jobId, payload)
    }
  }

  const forwardWorkerFailure = (jobId, worker, event) => {
    if (jobs.get(jobId) !== worker) return
    event?.preventDefault?.()
    const payload = {
      type: 'WORKER_ERROR',
      jobId,
      code: 'generation_failed',
      errorCode: 'generation_failed',
      finalRev: 0,
      content: '',
      sources: [],
    }
    terminateJob(jobId, worker)
    forwardTerminalMessage(jobId, payload)
  }

  const startJob = message => {
    if (!message?.jobId || !hasResolvedKeys(message)) {
      return { ok: false, accepted: false, errorCode: 'invalid_request' }
    }

    if (jobs.has(message.jobId) || terminalForwardingJobs.has(message.jobId)) {
      return {
        ok: true,
        accepted: true,
        alreadyStarted: true,
        jobId: message.jobId,
      }
    }

    const conflictingJobId = jobs.keys().next().value
      || terminalForwardingJobs.values().next().value
    if (conflictingJobId) {
      return {
        ok: false,
        accepted: false,
        errorCode: 'already_running',
        activeJobId: conflictingJobId,
      }
    }

    try {
      const worker = createWorker()
      jobs.set(message.jobId, worker)
      worker.onmessage = event => forwardWorkerMessage(message.jobId, worker, event)
      worker.onerror = event => forwardWorkerFailure(message.jobId, worker, event)
      worker.onmessageerror = event => forwardWorkerFailure(message.jobId, worker, event)
      worker.postMessage(normalizeStartMessage(message))
      return { ok: true, accepted: true, jobId: message.jobId }
    } catch {
      terminateJob(message.jobId)
      return { ok: false, accepted: false, errorCode: 'worker_start_failed' }
    }
  }

  const cancelJob = message => {
    const worker = jobs.get(message?.jobId)
    if (!worker) return { ok: true, accepted: false, jobId: message?.jobId ?? null }
    worker.postMessage({ kind: 'cancel', jobId: message.jobId })
    return { ok: true, accepted: true, jobId: message.jobId }
  }

  const markPresented = message => {
    const worker = jobs.get(message?.jobId)
    if (!worker) return { ok: true, accepted: false, jobId: message?.jobId ?? null }
    worker.postMessage({
      kind: 'presented',
      jobId: message.jobId,
      rev: message.revision,
    })
    return { ok: true, accepted: true, jobId: message.jobId }
  }

  const bridgeState = () => ({
    ok: true,
    ready: true,
    activeJobIds: Array.from(jobs.keys()),
    terminalForwardingJobIds: Array.from(terminalForwardingJobs),
  })

  const handleRuntimeMessage = message => {
    if (!isServiceWorkerCommand(message)) return null
    if (message?.type === 'OFFSCREEN_PROBE') return bridgeState()
    if (message?.type === 'HERA_GENERATION_START') return startJob(message)
    if (message?.type === 'CANCEL') return cancelJob(message)
    if (message?.type === 'PRESENTED') return markPresented(message)
    return null
  }

  const runtimeListener = (message, sender, sendResponse) => {
    // Security: only messages coming from this extension's own contexts are handled.
    if (!sender || sender.id !== runtime.id) return false
    const response = handleRuntimeMessage(message)
    if (response == null) return false
    sendResponse?.(response)
    return false
  }

  const mount = () => {
    if (mounted || typeof runtime?.onMessage?.addListener !== 'function') return false
    runtime.onMessage.addListener(runtimeListener)
    mounted = true
    return true
  }

  const dispose = () => {
    disposed = true
    if (mounted && typeof runtime?.onMessage?.removeListener === 'function') {
      runtime.onMessage.removeListener(runtimeListener)
    }
    mounted = false
    for (const [jobId] of jobs) terminateJob(jobId)
    terminalForwardingJobs.clear()
  }

  return {
    mount,
    dispose,
    handleRuntimeMessage,
    getJobCount: () => jobs.size,
    getState: bridgeState,
  }
}

export let offscreenBridge = null

if (
  typeof globalThis.Worker === 'function' &&
  typeof globalThis.chrome?.runtime?.onMessage?.addListener === 'function'
) {
  offscreenBridge = createOffscreenBridge()
  offscreenBridge.mount()
}
