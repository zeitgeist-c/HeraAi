import { streamChat, streamResearch, streamVision } from '../lib/api.js'
import { blobToBase64, getAttachment } from '../lib/attachmentStore.js'

export const SNAPSHOT_THROTTLE_MS = 150
export const HEARTBEAT_INTERVAL_MS = 15_000

const DEFAULT_ERROR_CODE = 'generation_failed'

function normalizeSources(sources) {
  return Array.isArray(sources) ? sources : []
}

function normalizeErrorCode(error) {
  const explicitCode = error?.code || error?.errorCode
  if (typeof explicitCode === 'string' && explicitCode.trim()) return explicitCode

  if (error?.name === 'StreamTimeoutError' || error?.name === 'TimeoutError') return 'timeout'
  if (error?.name === 'EmptyResponseError') return 'empty_response'

  const message = String(error?.message || '').toLowerCase()
  if (message.includes('timeout') || message.includes('timed out')) return 'timeout'
  if (message.includes('quota')) return 'quota_exceeded'
  if (message.includes('rate limit') || message.includes('rate_limit')) return 'rate_limited'
  if (message.includes('network') || message.includes('fetch')) return 'network_error'

  return DEFAULT_ERROR_CODE
}

async function hydrateRequestMessages(payload) {
  const original = Array.isArray(payload.requestMessages) ? payload.requestMessages : []
  const lastUserIndex = original.findLastIndex(message => message?.role === 'user')
  if (lastUserIndex < 0) return original
  const latestAttachments = Array.isArray(original[lastUserIndex]?.attachments)
    ? original[lastUserIndex].attachments
    : []
  const requestedIds = Array.isArray(payload.attachmentIds) && payload.attachmentIds.length > 0
    ? payload.attachmentIds
    : latestAttachments.map(attachment => attachment?.id).filter(Boolean)
  if (requestedIds.length === 0) return original

  const refsById = new Map(latestAttachments.filter(ref => ref?.id).map(ref => [ref.id, ref]))
  const hydrated = []
  let extractedChars = 0
  for (const id of requestedIds) {
    const ref = refsById.get(id)
      || original.flatMap(message => message?.attachments || []).find(attachment => attachment?.id === id)
    const record = await getAttachment(id)
    if (!ref || !record?.blob) {
      const error = new Error(`Attachment is missing: ${ref?.name || id}`)
      error.code = 'attachment_missing'
      throw error
    }
    const attachment = { ...ref, availability: 'ready' }
    if (typeof record.modelText === 'string') {
      extractedChars += record.modelText.length
      if (extractedChars > 1_000_000) {
        const error = new Error('Extracted attachment text exceeds the request limit.')
        error.code = 'attachment_text_too_large'
        throw error
      }
      attachment.modelText = record.modelText
    } else {
      attachment.data = await blobToBase64(record.blob)
    }
    hydrated.push(attachment)
  }

  return original.map((message, index) => {
    const stripped = (message?.attachments || []).map(({ data: _data, modelText: _modelText, ...ref }) => ref)
    return {
      ...message,
      attachments: index === lastUserIndex ? hydrated : stripped,
    }
  })
}

async function selectStream(payload, signal, engines) {
  const requestMessages = await hydrateRequestMessages(payload)
  const geminiKeys = Array.isArray(payload.geminiKeys) ? payload.geminiKeys : []
  const tavilyKeys = Array.isArray(payload.tavilyKeys) ? payload.tavilyKeys : []
  const requestOptions = {
    systemInstruction: payload.systemInstruction || '',
    language: payload.language || 'tr',
  }

  if (payload.mode === 'web') {
    const researchOptions = payload.webContext
      ? { ...requestOptions, webContext: payload.webContext }
      : requestOptions
    return engines.streamResearch(requestMessages, geminiKeys, tavilyKeys, signal, payload.model, researchOptions)
  }
  if (payload.mode === 'vision') {
    return engines.streamVision(requestMessages, null, requestOptions, geminiKeys, signal, payload.model)
  }
  return engines.streamChat(requestMessages, requestOptions, geminiKeys, signal, payload.model)
}

export function createGenerationWorkerRuntime({
  emit = payload => globalThis.postMessage(payload),
  now = () => Date.now(),
  setTimeoutFn = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeoutFn = timerId => globalThis.clearTimeout(timerId),
  setIntervalFn = (callback, delay) => globalThis.setInterval(callback, delay),
  clearIntervalFn = timerId => globalThis.clearInterval(timerId),
  engines = { streamChat, streamResearch, streamVision },
} = {}) {
  let activeJob = null

  const clearSnapshotTimer = job => {
    if (job.flushTimer == null) return
    clearTimeoutFn(job.flushTimer)
    job.flushTimer = null
  }

  const clearJobTimers = job => {
    clearSnapshotTimer(job)
    if (job.heartbeatTimer != null) {
      clearIntervalFn(job.heartbeatTimer)
      job.heartbeatTimer = null
    }
  }

  const flushSnapshot = job => {
    if (job.terminal || !job.snapshotDirty) return false

    clearSnapshotTimer(job)
    job.snapshotDirty = false
    job.revision += 1
    job.lastPostedAt = now()
    emit({
      kind: 'snapshot',
      jobId: job.jobId,
      rev: job.revision,
      content: job.content,
      sources: job.sources,
      status: 'running',
    })
    return true
  }

  const scheduleSnapshot = job => {
    if (job.terminal || !job.snapshotDirty) return

    if (job.lastPostedAt == null || now() - job.lastPostedAt >= SNAPSHOT_THROTTLE_MS) {
      flushSnapshot(job)
      return
    }
    if (job.flushTimer != null) return

    const remainingDelay = Math.max(0, SNAPSHOT_THROTTLE_MS - (now() - job.lastPostedAt))
    job.flushTimer = setTimeoutFn(() => {
      job.flushTimer = null
      flushSnapshot(job)
    }, remainingDelay)
  }

  const finishCancelled = job => {
    if (job.terminal) return
    job.terminal = true
    clearJobTimers(job)
    emit({
      kind: 'done',
      jobId: job.jobId,
      cancelled: true,
      finalRev: job.revision,
      content: job.content,
      sources: job.sources,
      errorCode: null,
    })
  }

  const finishWithError = (job, error) => {
    if (job.terminal) return

    flushSnapshot(job)
    job.terminal = true
    clearJobTimers(job)
    job.revision += 1
    const code = normalizeErrorCode(error)
    emit({
      kind: 'error',
      jobId: job.jobId,
      code,
      errorCode: code,
      finalRev: job.revision,
      content: job.content,
      sources: job.sources,
    })
  }

  const finishCompleted = job => {
    if (job.terminal) return

    flushSnapshot(job)
    job.terminal = true
    clearJobTimers(job)
    emit({
      kind: 'done',
      jobId: job.jobId,
      cancelled: false,
      finalRev: job.revision,
      content: job.content,
      sources: job.sources,
      errorCode: null,
    })
  }

  const runGeneration = async job => {
    emit({
      kind: 'heartbeat',
      jobId: job.jobId,
      uptimeMs: Math.max(0, now() - job.workerStartedAt),
    })
    job.heartbeatTimer = setIntervalFn(() => {
      if (job.terminal) return
      emit({
        kind: 'heartbeat',
        jobId: job.jobId,
        uptimeMs: Math.max(0, now() - job.workerStartedAt),
      })
    }, HEARTBEAT_INTERVAL_MS)

    try {
      const stream = await selectStream(job.payload, job.controller.signal, engines)
      for await (const event of stream) {
        if (job.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')

        if (event?.event === 'chunk') {
          const text = typeof event.data?.text === 'string' ? event.data.text : ''
          if (text) {
            job.content += text
            job.snapshotDirty = true
            scheduleSnapshot(job)
          }
          continue
        }

        if (event?.event === 'sources') {
          job.sources = normalizeSources(event.data?.sources)
          job.snapshotDirty = true
          scheduleSnapshot(job)
          continue
        }

        if (event?.event === 'key_status') {
          emit({
            kind: 'key_status',
            jobId: job.jobId,
            provider: event.data?.provider,
            keyId: event.data?.keyId,
            status: event.data?.status,
          })
          continue
        }

        if (event?.event === 'error') {
          finishWithError(job, event.data)
          return
        }
      }

      if (job.controller.signal.aborted || job.cancelRequested) {
        finishCancelled(job)
      } else {
        finishCompleted(job)
      }
    } catch (error) {
      if (job.controller.signal.aborted || job.cancelRequested || error?.name === 'AbortError') {
        finishCancelled(job)
      } else {
        finishWithError(job, error)
      }
    } finally {
      clearJobTimers(job)
      if (activeJob === job) activeJob = null
    }
  }

  const start = payload => {
    if (!payload?.jobId) return Promise.resolve(false)

    if (activeJob && !activeJob.terminal) {
      activeJob.cancelRequested = true
      activeJob.controller.abort()
      clearJobTimers(activeJob)
    }

    const job = {
      jobId: payload.jobId,
      payload,
      controller: new AbortController(),
      content: '',
      sources: [],
      revision: 0,
      presentedRevision: 0,
      snapshotDirty: false,
      lastPostedAt: null,
      flushTimer: null,
      heartbeatTimer: null,
      workerStartedAt: now(),
      cancelRequested: false,
      terminal: false,
      task: null,
    }
    activeJob = job
    job.task = runGeneration(job)
    return job.task
  }

  const cancel = payload => {
    if (!activeJob || activeJob.terminal) return false
    if (payload?.jobId && payload.jobId !== activeJob.jobId) return false

    activeJob.cancelRequested = true
    clearSnapshotTimer(activeJob)
    activeJob.controller.abort()
    return true
  }

  const markPresented = payload => {
    if (!activeJob || activeJob.terminal) return false
    if (payload?.jobId && payload.jobId !== activeJob.jobId) return false

    const revision = Number(payload?.rev ?? payload?.revision)
    if (Number.isInteger(revision) && revision > activeJob.presentedRevision) {
      activeJob.presentedRevision = revision
    }
    return true
  }

  const handleMessage = payload => {
    if (payload?.kind === 'start') return start(payload)
    if (payload?.kind === 'cancel') return cancel(payload)
    if (payload?.kind === 'presented') return markPresented(payload)
    return false
  }

  const dispose = () => {
    if (!activeJob || activeJob.terminal) return
    activeJob.cancelRequested = true
    clearJobTimers(activeJob)
    activeJob.controller.abort()
  }

  return {
    handleMessage,
    dispose,
    getActiveJob: () => activeJob,
  }
}

const isDedicatedWorkerScope = (
  typeof globalThis.document === 'undefined' &&
  typeof globalThis.postMessage === 'function' &&
  typeof globalThis.addEventListener === 'function'
)

if (isDedicatedWorkerScope) {
  const runtime = createGenerationWorkerRuntime()
  globalThis.addEventListener('message', event => {
    void runtime.handleMessage(event.data)
  })
}
