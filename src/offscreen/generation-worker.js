import { prepareSharedResearch, streamChat, streamResearch, streamVision } from '../lib/api.js'
import { blobToBase64, getAttachment } from '../lib/attachmentStore.js'
import { COMPARISON_SLOTS } from '../lib/comparison.js'

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
  const requestMessages = payload.requestMessagesHydrated === true
    ? payload.requestMessages
    : await hydrateRequestMessages(payload)
  const providerKeys = Array.isArray(payload.providerKeys)
    ? payload.providerKeys
    : (Array.isArray(payload.geminiKeys) ? payload.geminiKeys : [])
  const tavilyKeys = Array.isArray(payload.tavilyKeys) ? payload.tavilyKeys : []
  const requestOptions = {
    systemInstruction: payload.systemInstruction || '',
    language: payload.language || 'tr',
    fallbackGeminiKeys: Array.isArray(payload.fallbackGeminiKeys) ? payload.fallbackGeminiKeys : [],
  }

  if (payload.sharedResearch) {
    async function* preparedStream() {
      for (const status of payload.sharedResearch.keyStatuses || []) {
        yield { event: 'key_status', data: status }
      }
      if (payload.sharedResearch.errorCode) {
        yield { event: 'error', data: { code: payload.sharedResearch.errorCode } }
        return
      }
      for await (const event of engines.streamChat(
        payload.sharedResearch.messages || requestMessages,
        requestOptions,
        providerKeys,
        signal,
        payload.model,
        payload.provider,
      )) {
        yield event
        if (event?.event === 'error') return
      }
      yield { event: 'sources', data: { sources: payload.sharedResearch.sources || [] } }
    }
    return preparedStream()
  }

  if (payload.mode === 'web') {
    const researchOptions = payload.webContext
      ? { ...requestOptions, webContext: payload.webContext }
      : requestOptions
    return engines.streamResearch(
      requestMessages,
      providerKeys,
      tavilyKeys,
      signal,
      payload.model,
      researchOptions,
      payload.provider,
    )
  }
  if (payload.mode === 'vision') {
    return engines.streamVision(
      requestMessages,
      null,
      requestOptions,
      providerKeys,
      signal,
      payload.model,
      payload.provider,
    )
  }
  return engines.streamChat(
    requestMessages,
    requestOptions,
    providerKeys,
    signal,
    payload.model,
    payload.provider,
  )
}

export function isComparisonStartPayload(payload) {
  if (!payload || typeof payload !== 'object') return false
  if (payload.kind === 'comparison') return true
  return Array.isArray(payload.variants) && payload.variants.length > 0
}

function comparisonVariantDefs(payload) {
  const defs = Array.isArray(payload?.variants) ? payload.variants : []
  return COMPARISON_SLOTS.map(slot => {
    const def = defs.find(item => (
      item && (item.variantId === slot || item.slot === slot || item.id === slot)
    )) || {}
    return {
      ...def,
      variantId: slot,
      model: def.model ?? payload?.model ?? null,
      provider: def.provider ?? payload?.provider ?? null,
    }
  })
}

function createComparisonVariantState(def) {
  return {
    variantId: def.variantId,
    model: def.model,
    provider: def.provider,
    content: '',
    sources: [],
    resolvedModel: null,
    revision: 0,
    presentedRevision: 0,
    snapshotDirty: false,
    lastPostedAt: null,
    flushTimer: null,
    errorCode: null,
    status: 'running',
    terminal: false,
    requestOptions: {
      providerKeys: Array.isArray(def.providerKeys) ? def.providerKeys : null,
      fallbackGeminiKeys: Array.isArray(def.fallbackGeminiKeys) ? def.fallbackGeminiKeys : null,
    },
  }
}

function variantSummary(variant) {
  return {
    variantId: variant.variantId,
    status: variant.status,
    content: variant.content,
    sources: variant.sources,
    resolvedModel: variant.resolvedModel,
    revision: variant.revision,
    errorCode: variant.errorCode,
  }
}

export function createGenerationWorkerRuntime({
  emit = payload => globalThis.postMessage(payload),
  now = () => Date.now(),
  setTimeoutFn = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeoutFn = timerId => globalThis.clearTimeout(timerId),
  setIntervalFn = (callback, delay) => globalThis.setInterval(callback, delay),
  clearIntervalFn = timerId => globalThis.clearInterval(timerId),
  engines = { prepareSharedResearch, streamChat, streamResearch, streamVision },
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
      resolvedModel: job.resolvedModel,
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
      resolvedModel: job.resolvedModel,
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
      resolvedModel: job.resolvedModel,
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
      resolvedModel: job.resolvedModel,
      errorCode: null,
    })
  }

  const clearComparisonVariantTimers = job => {
    if (job?.kind !== 'comparison') return
    for (const variant of Object.values(job.variants || {})) {
      if (variant.flushTimer != null) {
        clearTimeoutFn(variant.flushTimer)
        variant.flushTimer = null
      }
    }
  }

  const clearComparisonJobTimers = job => {
    clearComparisonVariantTimers(job)
    if (job.heartbeatTimer != null) {
      clearIntervalFn(job.heartbeatTimer)
      job.heartbeatTimer = null
    }
  }

  const flushVariantSnapshot = (job, variant) => {
    if (job.terminal || variant.terminal || !variant.snapshotDirty) return false

    if (variant.flushTimer != null) {
      clearTimeoutFn(variant.flushTimer)
      variant.flushTimer = null
    }
    variant.snapshotDirty = false
    variant.revision += 1
    variant.lastPostedAt = now()
    emit({
      kind: 'snapshot',
      jobId: job.jobId,
      variantId: variant.variantId,
      rev: variant.revision,
      content: variant.content,
      sources: variant.sources,
      resolvedModel: variant.resolvedModel,
      status: 'running',
    })
    return true
  }

  const scheduleVariantSnapshot = (job, variant) => {
    if (job.terminal || variant.terminal || !variant.snapshotDirty) return

    if (variant.lastPostedAt == null || now() - variant.lastPostedAt >= SNAPSHOT_THROTTLE_MS) {
      flushVariantSnapshot(job, variant)
      return
    }
    if (variant.flushTimer != null) return

    const remainingDelay = Math.max(0, SNAPSHOT_THROTTLE_MS - (now() - variant.lastPostedAt))
    variant.flushTimer = setTimeoutFn(() => {
      variant.flushTimer = null
      flushVariantSnapshot(job, variant)
    }, remainingDelay)
  }

  const maybeFinishComparison = job => {
    if (job.terminal) return false
    const variants = COMPARISON_SLOTS.map(slot => job.variants[slot])
    if (variants.some(variant => !variant?.terminal)) return false

    job.terminal = true
    clearComparisonJobTimers(job)
    const summary = {}
    for (const slot of COMPARISON_SLOTS) summary[slot] = variantSummary(job.variants[slot])
    emit({
      kind: 'done',
      jobId: job.jobId,
      cancelled: Boolean(job.cancelRequested),
      finalRev: Math.max(0, ...variants.map(variant => variant.revision)),
      variants: summary,
      errorCode: null,
    })
    return true
  }

  const finishVariantCancelled = (job, variant) => {
    if (variant.terminal) return
    variant.terminal = true
    variant.status = 'cancelled'
    if (variant.flushTimer != null) {
      clearTimeoutFn(variant.flushTimer)
      variant.flushTimer = null
    }
    maybeFinishComparison(job)
  }

  const finishVariantWithError = (job, variant, error) => {
    if (variant.terminal) return

    flushVariantSnapshot(job, variant)
    variant.terminal = true
    variant.status = 'error'
    variant.revision += 1
    const code = normalizeErrorCode(error)
    variant.errorCode = code
    emit({
      kind: 'error',
      jobId: job.jobId,
      variantId: variant.variantId,
      code,
      errorCode: code,
      finalRev: variant.revision,
      content: variant.content,
      sources: variant.sources,
      resolvedModel: variant.resolvedModel,
    })
    maybeFinishComparison(job)
  }

  const finishVariantCompleted = (job, variant) => {
    if (variant.terminal) return

    flushVariantSnapshot(job, variant)
    variant.terminal = true
    variant.status = 'completed'
    maybeFinishComparison(job)
  }

  const runVariantStream = async (job, variant) => {
    try {
      const variantPayload = {
        ...job.payload,
        model: variant.model ?? job.payload.model,
        provider: variant.provider ?? job.payload.provider,
        ...(variant.requestOptions.providerKeys
          ? { providerKeys: variant.requestOptions.providerKeys }
          : {}),
        ...(variant.requestOptions.fallbackGeminiKeys
          ? { fallbackGeminiKeys: variant.requestOptions.fallbackGeminiKeys }
          : {}),
      }
      const stream = await selectStream(variantPayload, job.controller.signal, engines)
      for await (const event of stream) {
        if (job.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')

        if (event?.event === 'chunk') {
          const text = typeof event.data?.text === 'string' ? event.data.text : ''
          if (text) {
            variant.content += text
            variant.snapshotDirty = true
            scheduleVariantSnapshot(job, variant)
          }
          continue
        }

        if (event?.event === 'sources') {
          variant.sources = normalizeSources(event.data?.sources)
          variant.snapshotDirty = true
          scheduleVariantSnapshot(job, variant)
          continue
        }

        if (event?.event === 'model_resolved') {
          const resolvedModel = typeof event.data?.resolvedModel === 'string'
            ? event.data.resolvedModel.trim()
            : ''
          if (resolvedModel && resolvedModel !== variant.resolvedModel) {
            variant.resolvedModel = resolvedModel
            variant.snapshotDirty = true
            emit({
              kind: 'model_resolved',
              jobId: job.jobId,
              variantId: variant.variantId,
              provider: event.data?.provider || variant.provider || job.payload.provider || null,
              requestedModel: event.data?.requestedModel || variant.model || job.payload.model || null,
              resolvedModel,
            })
            scheduleVariantSnapshot(job, variant)
          }
          continue
        }

        if (event?.event === 'key_status') {
          emit({
            kind: 'key_status',
            jobId: job.jobId,
            variantId: variant.variantId,
            provider: event.data?.provider,
            keyId: event.data?.keyId,
            status: event.data?.status,
          })
          continue
        }

        if (event?.event === 'error') {
          finishVariantWithError(job, variant, event.data)
          return
        }
      }

      if (job.controller.signal.aborted || job.cancelRequested) {
        finishVariantCancelled(job, variant)
      } else {
        finishVariantCompleted(job, variant)
      }
    } catch (error) {
      if (job.controller.signal.aborted || job.cancelRequested || error?.name === 'AbortError') {
        finishVariantCancelled(job, variant)
      } else {
        finishVariantWithError(job, variant, error)
      }
    }
  }

  const runComparison = async job => {
    let hydratedRequestMessages
    try {
      hydratedRequestMessages = await hydrateRequestMessages(job.payload)
    } catch (error) {
      for (const slot of COMPARISON_SLOTS) {
        finishVariantWithError(job, job.variants[slot], error)
      }
      if (activeJob === job) activeJob = null
      return
    }
    job.payload = {
      ...job.payload,
      requestMessages: hydratedRequestMessages,
      requestMessagesHydrated: true,
      attachmentIds: [],
    }
    if (job.payload.mode === 'web' && typeof engines.prepareSharedResearch === 'function') {
      try {
        const sharedResearch = await engines.prepareSharedResearch(
          hydratedRequestMessages,
          job.payload.tavilyKeys || [],
          job.controller.signal,
          {
            language: job.payload.language,
            systemInstruction: job.payload.systemInstruction,
            webContext: job.payload.webContext,
          },
        )
        if (sharedResearch) job.payload = { ...job.payload, sharedResearch }
      } catch (error) {
        for (const slot of COMPARISON_SLOTS) {
          finishVariantWithError(job, job.variants[slot], error)
        }
        if (activeJob === job) activeJob = null
        return
      }
    }
    for (const slot of COMPARISON_SLOTS) {
      emit({
        kind: 'heartbeat',
        jobId: job.jobId,
        variantId: slot,
        uptimeMs: Math.max(0, now() - job.workerStartedAt),
      })
    }
    job.heartbeatTimer = setIntervalFn(() => {
      if (job.terminal) return
      for (const slot of COMPARISON_SLOTS) {
        emit({
          kind: 'heartbeat',
          jobId: job.jobId,
          variantId: slot,
          uptimeMs: Math.max(0, now() - job.workerStartedAt),
        })
      }
    }, HEARTBEAT_INTERVAL_MS)

    try {
      await Promise.all(COMPARISON_SLOTS.map(slot => runVariantStream(job, job.variants[slot])))
    } finally {
      clearComparisonJobTimers(job)
      if (activeJob === job) activeJob = null
    }
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

        if (event?.event === 'model_resolved') {
          const resolvedModel = typeof event.data?.resolvedModel === 'string'
            ? event.data.resolvedModel.trim()
            : ''
          if (resolvedModel && resolvedModel !== job.resolvedModel) {
            job.resolvedModel = resolvedModel
            job.snapshotDirty = true
            emit({
              kind: 'model_resolved',
              jobId: job.jobId,
              provider: event.data?.provider || job.payload.provider || null,
              requestedModel: event.data?.requestedModel || job.payload.model || null,
              resolvedModel,
            })
            scheduleSnapshot(job)
          }
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
      if (activeJob.kind === 'comparison') clearComparisonJobTimers(activeJob)
      else clearJobTimers(activeJob)
    }

    if (isComparisonStartPayload(payload)) {
      const job = {
        jobId: payload.jobId,
        kind: 'comparison',
        payload,
        controller: new AbortController(),
        variants: Object.fromEntries(
          comparisonVariantDefs(payload).map(def => [def.variantId, createComparisonVariantState(def)]),
        ),
        flushTimer: null,
        heartbeatTimer: null,
        workerStartedAt: now(),
        cancelRequested: false,
        terminal: false,
        task: null,
      }
      activeJob = job
      job.task = runComparison(job)
      return job.task
    }

    const job = {
      jobId: payload.jobId,
      payload,
      controller: new AbortController(),
      content: '',
      sources: [],
      resolvedModel: null,
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
    if (activeJob.kind === 'comparison') clearComparisonVariantTimers(activeJob)
    else clearSnapshotTimer(activeJob)
    activeJob.controller.abort()
    return true
  }

  const markPresented = payload => {
    if (!activeJob || activeJob.terminal) return false
    if (payload?.jobId && payload.jobId !== activeJob.jobId) return false

    const revision = Number(payload?.rev ?? payload?.revision)
    if (activeJob.kind === 'comparison') {
      if (payload?.variantId && activeJob.variants?.[payload.variantId]) {
        if (Number.isInteger(revision) && revision > activeJob.variants[payload.variantId].presentedRevision) {
          activeJob.variants[payload.variantId].presentedRevision = revision
        }
        return true
      }
      return true
    }
    if (Number.isInteger(revision) && revision > activeJob.presentedRevision) {
      activeJob.presentedRevision = revision
    }
    return true
  }

  const handleMessage = payload => {
    if (payload?.kind === 'start' || payload?.kind === 'comparison') return start(payload)
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
