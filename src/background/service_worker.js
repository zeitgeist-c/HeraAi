import { getKeys, resolveKeysForRequest, updateKeyMetadata } from '../lib/keyManager.js';
import {
  MODEL_CATALOG,
  PROVIDERS,
  getProviderForModel,
} from '../lib/models.js';
import {
  COMPARISON_SLOTS,
  allVariantsTerminal,
  applyBothSelection,
  applyWinnerSelection,
  createComparisonJob,
  isComparisonJob,
} from '../lib/comparison.js';
import {
  classifyWithGemmaRouter,
  selectLocalFallback,
} from '../lib/autoRouter.js';
import {
  hasRetiredModelProvenance,
  stripRetiredModelProvenance,
} from '../lib/modelMigration.js';
import {
  getAutoMessageTitle,
  getMessageDisplayContent,
  isHiddenPromptAutoTitle,
} from '../lib/messageDisplay.js';
import {
  AUTH_ERROR_CODES,
  getCurrentAuthUser,
  signInWithGoogle,
  signOutFromGoogle,
} from '../lib/authService.js';
import {
  cleanLegacyCloudData,
  clearCloudSyncSession,
  disconnectCloudSync,
  exportEncryptedBackup,
  getCloudSyncStatus,
  initializeCloudSync,
  importEncryptedBackup,
  installCloudSyncListeners,
  linkCloudSyncDevice,
  listCloudSyncDevices,
  regenerateCloudRecoveryCode,
  renameCloudSyncDevice,
  revokeCloudSyncDevice,
  runCloudSync,
  setCloudSyncDeviceEnabled,
  setCloudSyncPaused,
  wakeCloudSync,
} from '../lib/cloudSyncCoordinator.js';

const OFFSCREEN_PATH = 'offscreen.html';
const OFFSCREEN_REASON = 'WORKERS';
const OFFSCREEN_JUSTIFICATION = 'Stream chat completions off the panel context for persistent generation.';
const OFFSCREEN_COMMAND_RETRY_DELAYS_MS = [25, 75, 150];
const HEARTBEAT_STALE_AFTER_MS = 45_000;
const ACTIVE_GENERATION_STATUSES = new Set(['queued', 'running']);
const ACKNOWLEDGEABLE_STATUSES = new Set(['completed', 'cancelled', 'error', 'interrupted']);
const VALID_KEY_PROVIDERS = new Set(['gemini', 'tavily', 'openrouter', 'ollama']);

function compatibleAutoModels({ availableProviders, mimeTypes, mode, tavilyAvailable }) {
  const providers = new Set(availableProviders || []);
  const hasPdf = mimeTypes.includes('application/pdf');
  const hasImage = mimeTypes.some(mime => mime.startsWith('image/'));
  return MODEL_CATALOG.filter(model => {
    if (!providers.has(model.provider)) return false;
    if (hasPdf && model.capabilities?.supportsPdf !== true) return false;
    if (hasImage && model.capabilities?.supportsImage !== true) return false;
    if (mode === 'web' && !tavilyAvailable && model.capabilities?.supportsUrlContext !== true) return false;
    return true;
  });
}

let generationQueue = Promise.resolve();
const latestKeyStatuses = new Map();

const openHeraTab = () => chrome.tabs.create({
  url: chrome.runtime.getURL('index.html'),
});

function enqueueGenerationTask(task) {
  const result = generationQueue.then(task, task);
  generationQueue = result.catch(() => undefined);
  return result;
}

function getLastRuntimeError() {
  try {
    return chrome.runtime?.lastError || null;
  } catch (_error) {
    return null;
  }
}

function callChromeApi(method, receiver, args = []) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const callback = (value) => {
      const lastError = getLastRuntimeError();
      if (lastError) {
        settleReject(new Error(lastError.message || String(lastError)));
        return;
      }
      settleResolve(value);
    };

    try {
      const returned = method.call(receiver, ...args, callback);
      if (returned && typeof returned.then === 'function') {
        returned.then(settleResolve, settleReject);
      } else if (returned !== undefined) {
        settleResolve(returned);
      }
    } catch (error) {
      settleReject(error);
    }
  });
}

async function callPromiseChromeApi(method, receiver, args = []) {
  const result = await Promise.resolve(method.call(receiver, ...args));
  const lastError = getLastRuntimeError();
  if (lastError) throw new Error(lastError.message || String(lastError));
  return result;
}

const storageGet = (keys) => callChromeApi(
  chrome.storage.local.get,
  chrome.storage.local,
  [keys],
);

const storageSet = (value) => callChromeApi(
  chrome.storage.local.set,
  chrome.storage.local,
  [value],
);

const storageRemove = (keys) => callChromeApi(
  chrome.storage.local.remove,
  chrome.storage.local,
  [keys],
);

const sendRuntimeMessage = (message) => callPromiseChromeApi(
  chrome.runtime.sendMessage,
  chrome.runtime,
  [message],
);

const wait = (delayMs) => new Promise(resolve => setTimeout(resolve, delayMs));

async function sendOffscreenCommandWithRetry(message, validateResponse) {
  let lastError = null;

  for (let attempt = 0; attempt <= OFFSCREEN_COMMAND_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await sendRuntimeMessage({
        ...message,
        target: 'offscreen',
        forwardedBy: 'service_worker',
      });
      if (validateResponse(response)) return response;
      lastError = new Error(`Offscreen command ${message.type} was not acknowledged`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < OFFSCREEN_COMMAND_RETRY_DELAYS_MS.length) {
      await wait(OFFSCREEN_COMMAND_RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError || new Error(`Offscreen command ${message.type} failed`);
}

function isOffscreenProbeResponse(response) {
  return (
    response?.ok === true
    && response.ready === true
    && Array.isArray(response.activeJobIds)
    && Array.isArray(response.terminalForwardingJobIds)
  );
}

async function probeOffscreenDocument() {
  return sendOffscreenCommandWithRetry(
    { type: 'OFFSCREEN_PROBE' },
    isOffscreenProbeResponse,
  );
}

function offscreenJobPresence(probe, jobId) {
  if (!probe || !jobId) return { active: false, terminalForwarding: false };
  return {
    active: probe.activeJobIds.includes(jobId),
    terminalForwarding: probe.terminalForwardingJobIds.includes(jobId),
  };
}

async function inspectOffscreenJob(jobId) {
  const documentExists = await hasOffscreenDocument();
  if (!documentExists) {
    return {
      documentExists: false,
      responsive: false,
      active: false,
      terminalForwarding: false,
    };
  }

  try {
    const probe = await probeOffscreenDocument();
    return {
      documentExists: true,
      responsive: true,
      ...offscreenJobPresence(probe, jobId),
    };
  } catch (_error) {
    return {
      documentExists: true,
      responsive: false,
      active: false,
      terminalForwarding: false,
    };
  }
}

async function broadcastRuntimeMessage(message) {
  try {
    return await sendRuntimeMessage(message);
  } catch (_error) {
    // A panel is not necessarily open. Persistent state remains authoritative.
    return undefined;
  }
}

function withoutSensitiveGenerationData(generation) {
  if (!generation || typeof generation !== 'object') return {};

  const {
    geminiKeys: _geminiKeys,
    tavilyKeys: _tavilyKeys,
    providerKeys: _providerKeys,
    openRouterKeys: _openRouterKeys,
    ollamaKeys: _ollamaKeys,
    keysForGemini: _keysForGemini,
    keysForTavily: _keysForTavily,
    geminiApiKeys: _geminiApiKeys,
    tavilyApiKeys: _tavilyApiKeys,
    openRouterKey: _openRouterKey,
    requestMessages: _requestMessages,
    apiKey: _apiKey,
    apiKeys: _apiKeys,
    ...safeGeneration
  } = generation;
  return safeGeneration;
}

async function getActiveGeneration() {
  const result = await storageGet(['activeGeneration']);
  return result?.activeGeneration || null;
}

async function setActiveGeneration(activeGeneration) {
  await storageSet({
    activeGeneration: withoutSensitiveGenerationData(activeGeneration),
  });
}

function normalizedRevision(value, fallback = 0) {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision : fallback;
}

function generationSnapshot(activeGeneration) {
  if (!activeGeneration) return null;
  return withoutSensitiveGenerationData(activeGeneration);
}

function offscreenDocumentUrl() {
  return chrome.runtime.getURL(OFFSCREEN_PATH);
}

async function hasOffscreenDocument() {
  const documentUrl = offscreenDocumentUrl();

  if (typeof chrome.runtime?.getContexts === 'function') {
    try {
      const contexts = await callPromiseChromeApi(chrome.runtime.getContexts, chrome.runtime, [{
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [documentUrl],
      }]);
      return Array.isArray(contexts) && contexts.length > 0;
    } catch (_error) {
      // Chrome 114-115 does not expose runtime.getContexts; use clients below.
    }
  }

  if (globalThis.clients?.matchAll) {
    try {
      const clients = await globalThis.clients.matchAll({
        includeUncontrolled: true,
        type: 'window',
      });
      return clients.some(client => (
        client.url === documentUrl
        || client.url.startsWith(`${documentUrl}?`)
        || client.url.startsWith(`${documentUrl}#`)
      ));
    } catch (_error) {
      // Fall through to the newer feature-detected API.
    }
  }

  if (typeof chrome.offscreen?.hasDocument === 'function') {
    try {
      return Boolean(await callPromiseChromeApi(
        chrome.offscreen.hasDocument,
        chrome.offscreen,
      ));
    } catch (_error) {
      return false;
    }
  }

  return false;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) {
    throw new Error('Offscreen API is unavailable');
  }

  if (await hasOffscreenDocument()) return false;

  try {
    await callPromiseChromeApi(chrome.offscreen.createDocument, chrome.offscreen, [{
      url: OFFSCREEN_PATH,
      reasons: [OFFSCREEN_REASON],
      justification: OFFSCREEN_JUSTIFICATION,
    }]);
    return true;
  } catch (error) {
    // Another service-worker wakeup may have completed creation first.
    if (await hasOffscreenDocument()) return false;
    throw error;
  }
}

async function closeOffscreenDocument() {
  if (!chrome.offscreen?.closeDocument) return false;
  if (!await hasOffscreenDocument()) return false;

  try {
    await callPromiseChromeApi(chrome.offscreen.closeDocument, chrome.offscreen);
    return true;
  } catch (_error) {
    return false;
  }
}

function createQueuedGeneration(message, storedGeneration = null) {
  const now = Date.now();
  const stored = storedGeneration?.jobId === message.jobId
    ? withoutSensitiveGenerationData(storedGeneration)
    : {};

  return {
    ...stored,
    jobId: message.jobId,
    requestId: message.requestId ?? stored.requestId ?? message.jobId,
    sessionId: message.sessionId ?? stored.sessionId ?? null,
    userMessageId: message.userMessageId ?? stored.userMessageId ?? null,
    assistantMessageId: message.assistantMessageId ?? stored.assistantMessageId ?? null,
    startedAt: message.startedAt ?? stored.startedAt ?? now,
    completedAt: null,
    streamCompletedAt: null,
    mode: message.mode ?? stored.mode ?? 'chat',
    model: message.model ?? stored.model ?? null,
    provider: message.provider ?? stored.provider ?? getProviderForModel(message.model),
    resolvedModel: message.resolvedModel ?? stored.resolvedModel ?? null,
    selectionMode: message.selectionMode ?? stored.selectionMode ?? 'manual',
    selectionReasonCode: message.selectionReasonCode ?? stored.selectionReasonCode ?? null,
    routerModel: message.routerModel ?? stored.routerModel ?? null,
    language: message.language ?? stored.language ?? 'tr',
    ...(message.kind === 'comparison' || stored.kind === 'comparison'
      ? {
          kind: 'comparison',
          comparisonId: message.comparisonId ?? stored.comparisonId ?? message.jobId,
          variants: message.variants != null
            ? createComparisonJob({ jobId: message.jobId, variants: message.variants }).variants
            : (stored.variants ?? createComparisonJob({ jobId: message.jobId }).variants),
          selection: message.selection ?? stored.selection ?? { winnerSlot: null, decidedAt: null },
        }
      : {}),
    status: 'queued',
    revision: normalizedRevision(stored.revision),
    content: typeof stored.content === 'string' ? stored.content : '',
    sources: Array.isArray(stored.sources) ? stored.sources : [],
    errorCode: null,
    cancelReason: null,
    lastSnapshotAt: stored.lastSnapshotAt ?? null,
    lastHeartbeatAt: stored.lastHeartbeatAt ?? null,
    presentedRevision: normalizedRevision(stored.presentedRevision),
    updatedAt: now,
  };
}

function createRunningGeneration(queuedGeneration) {
  const now = Date.now();
  return {
    ...withoutSensitiveGenerationData(queuedGeneration),
    status: 'running',
    updatedAt: now,
  };
}

function getStartRequestMessages(message) {
  const requestMessages = Array.isArray(message.requestMessages)
    ? message.requestMessages.filter(item => (
        item
        && (item.role === 'user' || item.role === 'model')
        && item.id !== message.assistantMessageId
      ))
    : [];
  const explicitUserMessage = message.userMessage?.role === 'user'
    ? message.userMessage
    : null;
  const existingUserIndex = requestMessages.findIndex(item => (
    item.role === 'user' && item.id === message.userMessageId
  ));

  if (explicitUserMessage && existingUserIndex >= 0) {
    requestMessages[existingUserIndex] = explicitUserMessage;
  } else if (explicitUserMessage) {
    requestMessages.push(explicitUserMessage);
  }

  return requestMessages;
}

function getStartUserMessage(message, requestMessages) {
  return requestMessages.find(item => (
    item.role === 'user' && item.id === message.userMessageId
  )) || [...requestMessages].reverse().find(item => item.role === 'user') || null;
}

function deriveSessionTitle(message, existingSession, requestMessages) {
  if (
    existingSession?.isTitleCustom === true
    && typeof existingSession.title === 'string'
    && existingSession.title.trim()
  ) {
    return existingSession.title;
  }
  if (
    typeof message.sessionTitle === 'string'
    && message.sessionTitle.trim()
    && !isHiddenPromptAutoTitle(message.sessionTitle, requestMessages)
  ) {
    return message.sessionTitle;
  }
  if (
    typeof existingSession?.title === 'string'
    && existingSession.title
    && !isHiddenPromptAutoTitle(existingSession.title, requestMessages)
  ) {
    return existingSession.title;
  }

  const firstUserMessage = requestMessages.find(item => (
    item.role === 'user' && getMessageDisplayContent(item).trim()
  ));
  const firstUserContent = getMessageDisplayContent(firstUserMessage).trim();
  return getAutoMessageTitle(firstUserContent) || 'New Chat';
}

function createThinkingPlaceholder(message, queuedGeneration) {
  return {
    id: message.assistantMessageId,
    requestId: queuedGeneration.requestId,
    userMessageId: message.userMessageId,
    startedAt: queuedGeneration.startedAt,
    role: 'model',
    content: '',
    status: 'thinking',
    sources: [],
    ...(typeof queuedGeneration.model === 'string' && queuedGeneration.model
      ? { model: queuedGeneration.model }
      : {}),
    ...(typeof queuedGeneration.provider === 'string' && queuedGeneration.provider
      ? { provider: queuedGeneration.provider }
      : {}),
    ...(typeof queuedGeneration.resolvedModel === 'string' && queuedGeneration.resolvedModel
      ? { resolvedModel: queuedGeneration.resolvedModel }
      : {}),
    ...(queuedGeneration.selectionMode === 'auto' ? { selectionMode: 'auto' } : {}),
    ...(queuedGeneration.selectionReasonCode
      ? { selectionReasonCode: queuedGeneration.selectionReasonCode }
      : {}),
    ...(queuedGeneration.routerModel ? { routerModel: queuedGeneration.routerModel } : {}),
  };
}

function createComparisonThinkingPlaceholder(message, queuedGeneration, slot) {
  const base = createThinkingPlaceholder(message, queuedGeneration);
  const variant = queuedGeneration.variants?.[slot] || {};
  return {
    ...base,
    id: `${message.assistantMessageId}:${slot}`,
    comparisonId: queuedGeneration.comparisonId ?? queuedGeneration.jobId,
    variantId: slot,
    comparisonSelected: false,
    contextExcluded: false,
    ...(typeof variant.model === 'string' && variant.model
      ? { model: variant.model }
      : {}),
    ...(typeof variant.provider === 'string' && variant.provider
      ? { provider: variant.provider }
      : {}),
  };
}

function createThinkingPlaceholders(message, queuedGeneration) {
  if (!isComparisonJob(queuedGeneration)) return [createThinkingPlaceholder(message, queuedGeneration)];
  return COMPARISON_SLOTS.map(slot => createComparisonThinkingPlaceholder(message, queuedGeneration, slot));
}

function generationLivenessTimestamp(activeGeneration) {
  const candidates = [
    activeGeneration?.lastHeartbeatAt,
    activeGeneration?.handoffCompletedAt,
    activeGeneration?.updatedAt,
    activeGeneration?.startedAt,
  ].map(Number).filter(Number.isFinite);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function isGenerationHeartbeatStale(activeGeneration, now = Date.now()) {
  if (activeGeneration?.status !== 'running') return false;
  const livenessTimestamp = generationLivenessTimestamp(activeGeneration);
  return livenessTimestamp == null || now - livenessTimestamp > HEARTBEAT_STALE_AFTER_MS;
}

async function markGenerationInterrupted(activeGeneration, reason) {
  const now = Date.now();
  const interruptedGeneration = {
    ...withoutSensitiveGenerationData(activeGeneration),
    status: 'interrupted',
    interruptedAt: now,
    interruptReason: reason,
    lastSnapshotAt: activeGeneration.lastSnapshotAt ?? now,
    updatedAt: now,
  };
  await setActiveGeneration(interruptedGeneration);
  return interruptedGeneration;
}

function applyVariantReport(currentVariant, details = {}) {
  const currentRevision = normalizedRevision(currentVariant?.revision);
  const revision = normalizedRevision(
    details.finalRev ?? details.finalRevision ?? details.revision,
    currentRevision,
  );
  const acceptsReportedContent = revision >= currentRevision;
  return {
    ...currentVariant,
    revision: Math.max(currentRevision, revision),
    content: acceptsReportedContent && typeof details.content === 'string'
      ? details.content
      : (currentVariant?.content || ''),
    sources: acceptsReportedContent && Array.isArray(details.sources)
      ? details.sources
      : (Array.isArray(currentVariant?.sources) ? currentVariant.sources : []),
    resolvedModel: details.resolvedModel || currentVariant?.resolvedModel || null,
  };
}

async function writeComparisonVariantError(activeGeneration, variantId, errorCode, details = {}, now = Date.now()) {
  const nextVariant = {
    ...applyVariantReport(activeGeneration.variants[variantId], details),
    status: 'error',
    errorCode: errorCode || 'generation_failed',
    completedAt: now,
  };
  const nextVariants = { ...activeGeneration.variants, [variantId]: nextVariant };
  const terminal = allVariantsTerminal({ ...activeGeneration, variants: nextVariants });
  const nextGeneration = {
    ...withoutSensitiveGenerationData(activeGeneration),
    variants: nextVariants,
    status: terminal ? 'error' : activeGeneration.status,
    ...(terminal ? { streamCompletedAt: now, completedAt: now } : {}),
    lastSnapshotAt: now,
    updatedAt: now,
  };

  await setActiveGeneration(nextGeneration);
  const snapshot = generationSnapshot(nextGeneration);
  if (terminal) {
    await broadcastRuntimeMessage({
      type: 'DONE',
      forwardedBy: 'service_worker',
      jobId: nextGeneration.jobId,
      comparisonId: nextGeneration.comparisonId ?? nextGeneration.jobId,
      status: 'error',
      finalRev: nextGeneration.revision,
      finalRevision: nextGeneration.revision,
      errorCode: nextGeneration.errorCode || errorCode || 'generation_failed',
      activeGeneration: snapshot,
      snapshot,
    });
    await closeOffscreenDocument();
  } else {
    await broadcastRuntimeMessage({
      type: 'ACTIVE_GEN_CHANGED',
      forwardedBy: 'service_worker',
      jobId: nextGeneration.jobId,
      comparisonId: nextGeneration.comparisonId ?? nextGeneration.jobId,
      variantId,
      revision: nextVariant.revision,
      content: nextVariant.content,
      sources: nextVariant.sources,
      status: nextGeneration.status,
      snapshot,
    });
  }
  return nextGeneration;
}

async function writeComparisonVariantDone(activeGeneration, variantId, details = {}, now = Date.now()) {
  const nextVariant = {
    ...applyVariantReport(activeGeneration.variants[variantId], details),
    status: details.cancelled ? 'cancelled' : 'completed',
    ...(details.cancelled ? {} : { errorCode: null }),
    completedAt: now,
  };
  const nextVariants = { ...activeGeneration.variants, [variantId]: nextVariant };
  return persistComparisonVariants(activeGeneration, nextVariants, {
    cancelled: Boolean(details.cancelled),
    now,
  });
}

async function applyComparisonDoneSummary(activeGeneration, summary = {}, details = {}, now = Date.now()) {
  const nextVariants = { ...activeGeneration.variants };
  for (const slot of COMPARISON_SLOTS) {
    const reported = summary[slot];
    if (!reported || !nextVariants[slot]) continue;
    nextVariants[slot] = {
      ...applyVariantReport(nextVariants[slot], reported),
      status: reported.status === 'error'
        ? 'error'
        : (reported.status === 'cancelled' ? 'cancelled' : 'completed'),
      errorCode: reported.status === 'error'
        ? (reported.errorCode || 'generation_failed')
        : null,
      completedAt: now,
    };
  }
  return persistComparisonVariants(activeGeneration, nextVariants, {
    cancelled: Boolean(details.cancelled),
    now,
  });
}

async function persistComparisonVariants(activeGeneration, nextVariants, { cancelled = false, now = Date.now() } = {}) {
  const terminal = allVariantsTerminal({ ...activeGeneration, variants: nextVariants });
  const revision = Math.max(
    normalizedRevision(activeGeneration.revision),
    ...COMPARISON_SLOTS.map(slot => normalizedRevision(nextVariants[slot]?.revision)),
  );
  const nextGeneration = {
    ...withoutSensitiveGenerationData(activeGeneration),
    variants: nextVariants,
    status: terminal ? (cancelled ? 'cancelled' : 'completed') : activeGeneration.status,
    revision,
    ...(terminal ? { streamCompletedAt: now, completedAt: now } : {}),
    lastSnapshotAt: now,
    updatedAt: now,
    presentedRevision: Math.max(normalizedRevision(activeGeneration.presentedRevision), revision),
  };

  await setActiveGeneration(nextGeneration);
  const snapshot = generationSnapshot(nextGeneration);
  if (!terminal) {
    await broadcastRuntimeMessage({
      type: 'ACTIVE_GEN_CHANGED',
      forwardedBy: 'service_worker',
      jobId: nextGeneration.jobId,
      comparisonId: nextGeneration.comparisonId ?? nextGeneration.jobId,
      revision,
      status: nextGeneration.status,
      snapshot,
    });
    return { terminal: false, activeGeneration: snapshot, nextGeneration };
  }

  if (cancelled) {
    await broadcastRuntimeMessage({
      type: 'CANCEL_DONE',
      forwardedBy: 'service_worker',
      jobId: nextGeneration.jobId,
      comparisonId: nextGeneration.comparisonId ?? nextGeneration.jobId,
      status: 'cancelled',
      finalRev: nextGeneration.revision,
      finalRevision: nextGeneration.revision,
      activeGeneration: snapshot,
      snapshot,
    });
  } else {
    await broadcastRuntimeMessage({
      type: 'DONE',
      forwardedBy: 'service_worker',
      jobId: nextGeneration.jobId,
      comparisonId: nextGeneration.comparisonId ?? nextGeneration.jobId,
      status: 'completed',
      finalRev: nextGeneration.revision,
      finalRevision: nextGeneration.revision,
      errorCode: null,
      activeGeneration: snapshot,
      snapshot,
    });
  }
  await closeOffscreenDocument();
  return { terminal: true, activeGeneration: snapshot, nextGeneration };
}

async function handleSelectComparisonWinner(message) {
  const comparisonId = message?.comparisonId ?? message?.jobId ?? null;
  const winnerSlot = message?.winnerSlot;
  if (!comparisonId || !COMPARISON_SLOTS.includes(winnerSlot)) {
    return { ok: false, errorCode: 'invalid_request' };
  }

  const storedState = await storageGet(['sessions', 'activeGeneration']);
  const sessions = Array.isArray(storedState?.sessions) ? storedState.sessions : [];
  let matched = false;
  const nextSessions = sessions.map(session => {
    if (
      (message.sessionId && session?.id !== message.sessionId)
      || !Array.isArray(session?.messages)
      || !session.messages.some(item => item?.comparisonId === comparisonId)
    ) {
      return session;
    }
    matched = true;
    return {
      ...session,
      messages: applyWinnerSelection(session.messages, comparisonId, winnerSlot),
      updatedAt: Date.now(),
    };
  });
  if (!matched) return { ok: false, errorCode: 'not_found' };

  const activeGeneration = storedState?.activeGeneration || null;
  const activeMatches = activeGeneration && (
    activeGeneration.comparisonId === comparisonId || activeGeneration.jobId === comparisonId
  );
  const value = {
    sessions: nextSessions,
    ...(activeMatches
      ? {
          activeGeneration: {
            ...withoutSensitiveGenerationData(activeGeneration),
            selection: { winnerSlot, decidedAt: Date.now() },
            updatedAt: Date.now(),
          },
        }
      : {}),
  };
  // Both session messages and the stored selection update in a single write.
  await storageSet(value);

  await broadcastRuntimeMessage({
    type: 'COMPARISON_WINNER_SELECTED',
    forwardedBy: 'service_worker',
    jobId: activeMatches ? activeGeneration.jobId : null,
    comparisonId,
    winnerSlot,
  });
  return { ok: true, comparisonId, winnerSlot };
}

async function handleResolveComparisonBoth(message) {
  const comparisonId = message?.comparisonId ?? message?.jobId ?? null;
  if (!comparisonId) {
    return { ok: false, errorCode: 'invalid_request' };
  }

  const storedState = await storageGet(['sessions', 'activeGeneration']);
  const sessions = Array.isArray(storedState?.sessions) ? storedState.sessions : [];
  let matched = false;
  const nextSessions = sessions.map(session => {
    if (
      (message.sessionId && session?.id !== message.sessionId)
      || !Array.isArray(session?.messages)
      || !session.messages.some(item => item?.comparisonId === comparisonId)
    ) {
      return session;
    }
    matched = true;
    return {
      ...session,
      messages: applyBothSelection(session.messages, comparisonId),
      updatedAt: Date.now(),
    };
  });
  if (!matched) return { ok: false, errorCode: 'not_found' };

  const activeGeneration = storedState?.activeGeneration || null;
  const activeMatches = activeGeneration && (
    activeGeneration.comparisonId === comparisonId || activeGeneration.jobId === comparisonId
  );
  const value = {
    sessions: nextSessions,
    ...(activeMatches
      ? {
          activeGeneration: {
            ...withoutSensitiveGenerationData(activeGeneration),
            selection: { winnerSlot: 'both', decidedAt: Date.now() },
            updatedAt: Date.now(),
          },
        }
      : {}),
  };
  // Both session messages and the stored selection update in a single write.
  await storageSet(value);

  await broadcastRuntimeMessage({
    type: 'COMPARISON_BOTH_SELECTED',
    forwardedBy: 'service_worker',
    jobId: activeMatches ? activeGeneration.jobId : null,
    comparisonId,
    winnerSlot: 'both',
  });
  return { ok: true, comparisonId, winnerSlot: 'both' };
}

async function handleGetModelAvailability() {
  const providers = [...new Set(MODEL_CATALOG.map(model => model.provider))];
  const entries = await Promise.all(providers.map(async provider => {
    try {
      return [provider, await getKeys(provider)];
    } catch (_error) {
      return [provider, []];
    }
  }));
  const keysByProvider = Object.fromEntries(entries);
  return {
    ok: true,
    models: MODEL_CATALOG.map(model => ({
      modelKey: model.key,
      provider: model.provider,
      hasKey: (keysByProvider[model.provider] || []).length > 0,
      supportsImage: Boolean(model.capabilities?.supportsImage),
      supportsPdf: Boolean(model.capabilities?.supportsPdf),
    })),
  };
}

async function writeTerminalError(activeGeneration, errorCode, details = {}) {
  const now = Date.now();
  if (
    isComparisonJob(activeGeneration)
    && typeof details?.variantId === 'string'
    && activeGeneration.variants?.[details.variantId]
  ) {
    return writeComparisonVariantError(activeGeneration, details.variantId, errorCode, details, now);
  }
  const currentRevision = normalizedRevision(activeGeneration.revision);
  const revision = normalizedRevision(
    details.finalRev ?? details.finalRevision,
    currentRevision,
  );
  const acceptsReportedContent = revision >= currentRevision;
  const nextGeneration = {
    ...withoutSensitiveGenerationData(activeGeneration),
    status: 'error',
    revision: Math.max(currentRevision, revision),
    content: acceptsReportedContent && typeof details.content === 'string'
      ? details.content
      : (activeGeneration.content || ''),
    sources: acceptsReportedContent && Array.isArray(details.sources)
      ? details.sources
      : (Array.isArray(activeGeneration.sources) ? activeGeneration.sources : []),
    resolvedModel: details.resolvedModel || activeGeneration.resolvedModel || null,
    errorCode: errorCode || 'generation_failed',
    streamCompletedAt: now,
    completedAt: now,
    lastSnapshotAt: now,
    updatedAt: now,
    ...(details.earliestCooldownEnd != null
      ? { earliestCooldownEnd: details.earliestCooldownEnd }
      : {}),
  };

  await setActiveGeneration(nextGeneration);
  await broadcastRuntimeMessage({
    type: 'DONE',
    forwardedBy: 'service_worker',
    jobId: nextGeneration.jobId,
    status: 'error',
    finalRev: nextGeneration.revision,
    finalRevision: nextGeneration.revision,
    content: nextGeneration.content,
    sources: nextGeneration.sources,
    errorCode: nextGeneration.errorCode,
    activeGeneration: generationSnapshot(nextGeneration),
    snapshot: generationSnapshot(nextGeneration),
  });
  await closeOffscreenDocument();
  return nextGeneration;
}

async function handleGenerationStart(message) {
  if (
    !message.jobId
    || !message.sessionId
    || !message.userMessageId
    || !message.assistantMessageId
  ) {
    await broadcastRuntimeMessage({
      type: 'START_REJECTED',
      forwardedBy: 'service_worker',
      jobId: message.jobId ?? null,
      errorCode: 'invalid_request',
    });
    return { ok: false, errorCode: 'invalid_request' };
  }

  const storedState = await storageGet([
    'activeGeneration',
    'sessions',
    'activeSessionId',
    'autoRouterHealth',
  ]);
  const storedGeneration = storedState?.activeGeneration || null;
  if (
    storedGeneration
    && storedGeneration.jobId !== message.jobId
  ) {
    await broadcastRuntimeMessage({
      type: 'START_REJECTED',
      forwardedBy: 'service_worker',
      jobId: message.jobId,
      activeJobId: storedGeneration.jobId,
      errorCode: 'already_running',
    });
    return {
      ok: false,
      errorCode: 'already_running',
      activeGeneration: generationSnapshot(storedGeneration),
    };
  }

  if (storedGeneration?.jobId === message.jobId && storedGeneration.status === 'running') {
    const offscreen = await inspectOffscreenJob(storedGeneration.jobId);
    const coordinatorHasJob = offscreen.active || offscreen.terminalForwarding;
    const heartbeatHealthy = offscreen.terminalForwarding
      || !isGenerationHeartbeatStale(storedGeneration);
    if (offscreen.responsive && coordinatorHasJob && heartbeatHealthy) {
      return {
        ok: true,
        alreadyStarted: true,
        activeGeneration: generationSnapshot(storedGeneration),
      };
    }

    const interruptedGeneration = await markGenerationInterrupted(
      storedGeneration,
      !offscreen.documentExists
        ? 'offscreen_missing'
        : !offscreen.responsive
          ? 'offscreen_unresponsive'
          : !coordinatorHasJob
            ? 'worker_missing'
            : 'heartbeat_stale',
    );
    if (offscreen.documentExists) await closeOffscreenDocument();
    return {
      ok: true,
      interrupted: true,
      activeGeneration: generationSnapshot(interruptedGeneration),
    };
  }

  if (
    storedGeneration?.jobId === message.jobId
    && ACKNOWLEDGEABLE_STATUSES.has(storedGeneration.status)
  ) {
    return {
      ok: true,
      alreadyFinished: true,
      activeGeneration: generationSnapshot(storedGeneration),
    };
  }

  const requestMessages = getStartRequestMessages(message);
  const userMessage = getStartUserMessage(message, requestMessages);
  if (!userMessage) {
    await broadcastRuntimeMessage({
      type: 'START_REJECTED',
      forwardedBy: 'service_worker',
      jobId: message.jobId,
      errorCode: 'invalid_request',
    });
    return { ok: false, errorCode: 'invalid_request' };
  }

  if (userMessage.id !== message.userMessageId) {
    const userIndex = requestMessages.lastIndexOf(userMessage);
    requestMessages[userIndex] = { ...userMessage, id: message.userMessageId };
  }

  let startMessage = message;
  if (message.selectionMode === 'auto') {
    const providerIds = [PROVIDERS.GEMINI, PROVIDERS.OPENROUTER, PROVIDERS.OLLAMA];
    const providerEntries = await Promise.all(providerIds.map(async providerId => ([
      providerId,
      await resolveKeysForRequest(providerId),
    ])));
    const providerResolutions = Object.fromEntries(providerEntries);
    const tavilyResolution = await resolveKeysForRequest('tavily');
    const attachmentMimeTypes = requestMessages.flatMap(requestMessage => (
      Array.isArray(requestMessage?.attachments)
        ? requestMessage.attachments.map(attachment => attachment?.mimeType).filter(Boolean)
        : []
    ));
    const latestUserMessage = [...requestMessages].reverse().find(item => item?.role === 'user');
    const metadata = {
      text: String(latestUserMessage?.content || ''),
      mode: message.mode || 'chat',
      turnCount: requestMessages.filter(item => item?.role === 'user').length,
      mimeTypes: attachmentMimeTypes,
    };
    const availableProviders = providerIds.filter(providerId => (
      (providerResolutions[providerId]?.keys || []).length > 0
    ));
    const candidates = compatibleAutoModels({
      availableProviders,
      mimeTypes: attachmentMimeTypes,
      mode: metadata.mode,
      tavilyAvailable: (tavilyResolution.keys || []).length > 0,
    });
    const routerDecision = await classifyWithGemmaRouter({
      ...metadata,
      candidates,
      geminiKeys: providerResolutions[PROVIDERS.GEMINI]?.keys || [],
      health: storedState?.autoRouterHealth || {},
    });
    const localDecision = routerDecision?.fallback === true
      ? selectLocalFallback({
          ...metadata,
          candidates,
          hasTavilyKeys: (tavilyResolution.keys || []).length > 0,
        })
      : routerDecision;
    const selectedModel = candidates.find(candidate => candidate.key === localDecision?.modelKey);
    if (!selectedModel) {
      await broadcastRuntimeMessage({
        type: 'START_REJECTED',
        forwardedBy: 'service_worker',
        jobId: message.jobId,
        errorCode: 'api_key_missing',
      });
      return { ok: false, errorCode: 'api_key_missing' };
    }
    startMessage = {
      ...message,
      model: selectedModel.modelId,
      provider: selectedModel.provider,
      selectionMode: 'auto',
      selectionReasonCode: localDecision.reasonCode,
      routerModel: routerDecision?.routerModel || null,
    };
    await storageSet({
      autoRouterHealth: routerDecision?.updatedHealth || storedState?.autoRouterHealth || {},
    });
  }

  const queuedGeneration = createQueuedGeneration(startMessage, storedGeneration);
  const storedSessions = Array.isArray(storedState?.sessions) ? storedState.sessions : [];
  const existingSession = storedSessions.find(session => session?.id === message.sessionId);
  const optimisticMessages = [
    ...requestMessages,
    ...createThinkingPlaceholders(startMessage, queuedGeneration),
  ];
  const nextSession = {
    ...(existingSession || {}),
    id: message.sessionId,
    title: deriveSessionTitle(startMessage, existingSession, requestMessages),
    isTitleCustom: existingSession?.isTitleCustom === true,
    isStarred: existingSession?.isStarred === true,
    updatedAt: queuedGeneration.updatedAt,
    messages: optimisticMessages,
    activeAttachmentIds: Array.isArray(startMessage.activeAttachmentIds)
      ? startMessage.activeAttachmentIds
      : (Array.isArray(startMessage.attachmentIds) ? startMessage.attachmentIds : (existingSession?.activeAttachmentIds || [])),
    activeWebUrls: Array.isArray(startMessage.activeWebUrls)
      ? startMessage.activeWebUrls
      : (startMessage.webContext?.kind === 'none'
          ? (existingSession?.activeWebUrls || [])
          : (Array.isArray(startMessage.webContext?.urls) ? startMessage.webContext.urls : (existingSession?.activeWebUrls || []))),
  };
  const nextSessions = [
    ...storedSessions.filter(session => session?.id !== message.sessionId),
    nextSession,
  ];

  // Claim the single generation and persist its optimistic UI in one write.
  await storageSet({
    sessions: nextSessions,
    activeSessionId: message.sessionId,
    activeGeneration: queuedGeneration,
  });

  const runningGeneration = createRunningGeneration(queuedGeneration);
  await setActiveGeneration(runningGeneration);

  try {
    const provider = runningGeneration.provider || getProviderForModel(runningGeneration.model);
    const providerResolution = await resolveKeysForRequest(provider);
    if (providerResolution.allInCooldown) {
      const failedGeneration = await writeTerminalError(
        runningGeneration,
        'all_keys_cooldown',
        { earliestCooldownEnd: providerResolution.earliestCooldownEnd },
      );
      return {
        ok: false,
        errorCode: 'all_keys_cooldown',
        activeGeneration: generationSnapshot(failedGeneration),
      };
    }

    let geminiFallbackResolution = { keys: [] };
    if (provider !== 'gemini') {
      geminiFallbackResolution = await resolveKeysForRequest('gemini');
    }

    let tavilyResolution = { keys: [], allInCooldown: false };
    if (runningGeneration.mode === 'web') {
      tavilyResolution = await resolveKeysForRequest('tavily');
      if (tavilyResolution.allInCooldown && startMessage.webContext?.kind !== 'url') {
        const failedGeneration = await writeTerminalError(
          runningGeneration,
          'all_keys_cooldown',
          { earliestCooldownEnd: tavilyResolution.earliestCooldownEnd },
        );
        return {
          ok: false,
          errorCode: 'all_keys_cooldown',
          activeGeneration: generationSnapshot(failedGeneration),
        };
      }
    }

    let comparisonVariants = null;
    if (isComparisonJob(runningGeneration)) {
      comparisonVariants = [];
      for (const [index, slot] of COMPARISON_SLOTS.entries()) {
        const variant = runningGeneration.variants[slot];
        const variantProvider = variant.provider || getProviderForModel(variant.model);
        const variantResolution = await resolveKeysForRequest(variantProvider);
        let variantKeys = variantResolution.keys || [];
        if (
          index === 1
          && variantProvider === runningGeneration.variants.a?.provider
          && variantKeys.length > 1
        ) {
          variantKeys = [...variantKeys.slice(1), variantKeys[0]];
        }
        let fallbackGeminiKeys = [];
        if (variantProvider !== PROVIDERS.GEMINI) {
          fallbackGeminiKeys = (await resolveKeysForRequest(PROVIDERS.GEMINI)).keys || [];
        }
        comparisonVariants.push({
          variantId: slot,
          model: variant.model,
          provider: variantProvider,
          providerKeys: variantKeys,
          fallbackGeminiKeys,
        });
      }
    }

    await ensureOffscreenDocument();
    await probeOffscreenDocument();
    await sendOffscreenCommandWithRetry({
      type: 'HERA_GENERATION_START',
      jobId: runningGeneration.jobId,
      requestId: runningGeneration.requestId,
      sessionId: runningGeneration.sessionId,
      userMessageId: runningGeneration.userMessageId,
      assistantMessageId: runningGeneration.assistantMessageId,
      startedAt: runningGeneration.startedAt,
      requestMessages,
      attachmentIds: Array.isArray(startMessage.attachmentIds) ? startMessage.attachmentIds : [],
      webContext: startMessage.webContext || { kind: 'none', urls: [] },
      provider,
      providerKeys: providerResolution.keys || [],
      fallbackGeminiKeys: geminiFallbackResolution.keys || [],
      tavilyKeys: tavilyResolution.keys || [],
      model: runningGeneration.model,
      mode: runningGeneration.mode,
      systemInstruction: startMessage.systemInstruction || '',
      language: runningGeneration.language,
      ...(isComparisonJob(runningGeneration)
        ? {
            kind: 'comparison',
            comparisonId: runningGeneration.comparisonId ?? runningGeneration.jobId,
            variants: comparisonVariants,
          }
        : {}),
    }, response => (
      response?.ok === true
      && response.accepted === true
      && response.jobId === runningGeneration.jobId
    ));

    const handoffCompletedAt = Date.now();
    const handedOffGeneration = {
      ...runningGeneration,
      handoffCompletedAt,
      updatedAt: handoffCompletedAt,
    };
    await setActiveGeneration(handedOffGeneration);

    return {
      ok: true,
      activeGeneration: generationSnapshot(handedOffGeneration),
    };
  } catch (_error) {
    const failedGeneration = await writeTerminalError(
      runningGeneration,
      'generation_failed',
    );
    return {
      ok: false,
      errorCode: 'generation_failed',
      activeGeneration: generationSnapshot(failedGeneration),
    };
  }
}

async function handleSnapshot(message) {
  const activeGeneration = await getActiveGeneration();
  if (
    !activeGeneration
    || activeGeneration.jobId !== message.jobId
    || !ACTIVE_GENERATION_STATUSES.has(activeGeneration.status)
  ) {
    return { ok: true, accepted: false, ignored: true };
  }

  if (
    isComparisonJob(activeGeneration)
    && typeof message.variantId === 'string'
    && activeGeneration.variants?.[message.variantId]
  ) {
    return handleComparisonSnapshot(activeGeneration, message.variantId, message);
  }

  const revision = normalizedRevision(message.revision, -1);
  const currentRevision = normalizedRevision(activeGeneration.revision);
  if (revision <= currentRevision) {
    return {
      ok: true,
      accepted: false,
      revision: currentRevision,
    };
  }

  const now = Date.now();
  const nextGeneration = {
    ...withoutSensitiveGenerationData(activeGeneration),
    status: 'running',
    revision,
    content: typeof message.content === 'string'
      ? message.content
      : (activeGeneration.content || ''),
    sources: Array.isArray(message.sources)
      ? message.sources
      : (Array.isArray(activeGeneration.sources) ? activeGeneration.sources : []),
    resolvedModel: message.resolvedModel || activeGeneration.resolvedModel || null,
    lastSnapshotAt: now,
    presentedRevision: revision,
    updatedAt: now,
  };

  // This write must resolve before either the panel update or PRESENTED ack.
  await setActiveGeneration(nextGeneration);

  const snapshot = generationSnapshot(nextGeneration);
  await broadcastRuntimeMessage({
    type: 'ACTIVE_GEN_CHANGED',
    forwardedBy: 'service_worker',
    jobId: nextGeneration.jobId,
    revision,
    content: nextGeneration.content,
    sources: nextGeneration.sources,
    status: nextGeneration.status,
    snapshot,
  });
  await broadcastRuntimeMessage({
    type: 'PRESENTED',
    target: 'offscreen',
    forwardedBy: 'service_worker',
    jobId: nextGeneration.jobId,
    revision,
  });

  return { ok: true, accepted: true, revision };
}

async function handleComparisonSnapshot(activeGeneration, variantId, message) {
  const variant = activeGeneration.variants[variantId];
  const revision = normalizedRevision(message.revision, -1);
  const currentRevision = normalizedRevision(variant.revision);
  if (revision <= currentRevision) {
    return {
      ok: true,
      accepted: false,
      revision: currentRevision,
    };
  }

  const now = Date.now();
  const nextVariant = {
    ...applyVariantReport(variant, message),
    status: 'running',
  };
  const nextGeneration = {
    ...withoutSensitiveGenerationData(activeGeneration),
    variants: { ...activeGeneration.variants, [variantId]: nextVariant },
    status: 'running',
    revision: Math.max(normalizedRevision(activeGeneration.revision), revision),
    lastSnapshotAt: now,
    presentedRevision: revision,
    updatedAt: now,
  };

  // This write must resolve before either the panel update or PRESENTED ack.
  await setActiveGeneration(nextGeneration);

  const snapshot = generationSnapshot(nextGeneration);
  await broadcastRuntimeMessage({
    type: 'ACTIVE_GEN_CHANGED',
    forwardedBy: 'service_worker',
    jobId: nextGeneration.jobId,
    comparisonId: nextGeneration.comparisonId ?? nextGeneration.jobId,
    variantId,
    revision,
    content: nextVariant.content,
    sources: nextVariant.sources,
    status: nextGeneration.status,
    snapshot,
  });
  await broadcastRuntimeMessage({
    type: 'PRESENTED',
    target: 'offscreen',
    forwardedBy: 'service_worker',
    jobId: nextGeneration.jobId,
    variantId,
    revision,
  });

  return { ok: true, accepted: true, revision };
}

async function handleHeartbeat(message) {
  const activeGeneration = await getActiveGeneration();
  if (
    !activeGeneration
    || activeGeneration.jobId !== message.jobId
    || !ACTIVE_GENERATION_STATUSES.has(activeGeneration.status)
  ) {
    return { ok: true, accepted: false, ignored: true };
  }

  const receivedAt = Date.now();
  const nextGeneration = {
    ...withoutSensitiveGenerationData(activeGeneration),
    lastHeartbeatAt: receivedAt,
    updatedAt: receivedAt,
    ...(Number.isFinite(message.uptimeMs) ? { workerUptimeMs: message.uptimeMs } : {}),
  };
  await setActiveGeneration(nextGeneration);
  return { ok: true, accepted: true, receivedAt };
}

async function handleModelResolved(message) {
  const activeGeneration = await getActiveGeneration();
  const resolvedModel = typeof message.resolvedModel === 'string'
    ? message.resolvedModel.trim()
    : '';
  if (
    !resolvedModel
    || !activeGeneration
    || activeGeneration.jobId !== message.jobId
    || !ACTIVE_GENERATION_STATUSES.has(activeGeneration.status)
  ) {
    return { ok: true, accepted: false, ignored: true };
  }

  const nextGeneration = {
    ...withoutSensitiveGenerationData(activeGeneration),
    resolvedModel,
    updatedAt: Date.now(),
  };
  if (
    isComparisonJob(activeGeneration)
    && typeof message.variantId === 'string'
    && nextGeneration.variants?.[message.variantId]
  ) {
    nextGeneration.variants = {
      ...nextGeneration.variants,
      [message.variantId]: {
        ...nextGeneration.variants[message.variantId],
        resolvedModel,
      },
    };
  }
  await setActiveGeneration(nextGeneration);
  await broadcastRuntimeMessage({
    type: 'MODEL_RESOLVED',
    forwardedBy: 'service_worker',
    jobId: nextGeneration.jobId,
    ...(typeof message.variantId === 'string' && message.variantId ? { variantId: message.variantId } : {}),
    provider: message.provider || nextGeneration.provider || null,
    requestedModel: message.requestedModel || nextGeneration.model || null,
    resolvedModel,
  });
  return { ok: true, accepted: true, resolvedModel };
}

function keyMetadataForStatus(status, now) {
  if (status === 'cooldown' || status === 'rate_limit' || status === 'rate_limited') {
    return {
      cooldownUntil: now + 60_000,
      lastErrorAt: now,
      lastErrorType: 'rate_limited',
    };
  }
  if (status === 'quota' || status === 'quota_exceeded') {
    return {
      cooldownUntil: now + 120_000,
      lastErrorAt: now,
      lastErrorType: 'quota_exceeded',
    };
  }
  if (status === 'success') {
    return {
      lastSuccessAt: now,
      failCount: 0,
      cooldownUntil: null,
      lastErrorType: null,
    };
  }
  if (status === 'network') {
    return {
      lastErrorAt: now,
      lastErrorType: 'network',
      cooldownUntil: null,
    };
  }
  if (status === 'error' || status === 'invalid') {
    return {
      lastErrorAt: now,
      lastErrorType: 'invalid',
    };
  }
  return null;
}

async function handleKeyStatus(message) {
  const activeGeneration = await getActiveGeneration();
  if (
    !VALID_KEY_PROVIDERS.has(message.provider)
    || !message.keyId
    || !message.status
    || (message.jobId && activeGeneration?.jobId !== message.jobId)
  ) {
    return { ok: true, accepted: false, ignored: true };
  }

  const updatedAt = Date.now();
  const metadata = keyMetadataForStatus(message.status, updatedAt);
  if (metadata) {
    await updateKeyMetadata(message.provider, message.keyId, metadata);
  }

  const keyStatus = {
    jobId: message.jobId ?? activeGeneration?.jobId ?? null,
    provider: message.provider,
    keyId: message.keyId,
    status: message.status,
    updatedAt,
  };
  latestKeyStatuses.set(`${message.provider}:${message.keyId}`, keyStatus);

  await broadcastRuntimeMessage({
    type: 'KEY_STATUS',
    forwardedBy: 'service_worker',
    ...keyStatus,
  });
  return { ok: true, accepted: true, keyStatus };
}

async function handleWorkerDone(message) {
  const activeGeneration = await getActiveGeneration();
  if (!activeGeneration || activeGeneration.jobId !== message.jobId) {
    return { ok: true, accepted: false, ignored: true };
  }
  if (ACKNOWLEDGEABLE_STATUSES.has(activeGeneration.status)) {
    return {
      ok: true,
      accepted: false,
      ignored: true,
      activeGeneration: generationSnapshot(activeGeneration),
    };
  }

  if (isComparisonJob(activeGeneration)) {
    return handleComparisonDone(activeGeneration, message);
  }

  const now = Date.now();
  const currentRevision = normalizedRevision(activeGeneration.revision);
  const reportedRevision = normalizedRevision(message.finalRev, currentRevision);
  const acceptsReportedContent = reportedRevision >= currentRevision;
  const nextGeneration = {
    ...withoutSensitiveGenerationData(activeGeneration),
    status: message.cancelled ? 'cancelled' : 'completed',
    revision: Math.max(currentRevision, reportedRevision),
    content: acceptsReportedContent && typeof message.content === 'string'
      ? message.content
      : (activeGeneration.content || ''),
    sources: acceptsReportedContent && Array.isArray(message.sources)
      ? message.sources
      : (Array.isArray(activeGeneration.sources) ? activeGeneration.sources : []),
    resolvedModel: message.resolvedModel || activeGeneration.resolvedModel || null,
    errorCode: null,
    cancelReason: message.cancelled
      ? (activeGeneration.cancelReason ?? message.reason ?? null)
      : null,
    streamCompletedAt: now,
    completedAt: now,
    lastSnapshotAt: now,
    updatedAt: now,
    presentedRevision: Math.max(
      normalizedRevision(activeGeneration.presentedRevision),
      Math.max(currentRevision, reportedRevision),
    ),
  };

  await setActiveGeneration(nextGeneration);

  if (message.cancelled) {
    await broadcastRuntimeMessage({
      type: 'CANCEL_DONE',
      forwardedBy: 'service_worker',
      jobId: nextGeneration.jobId,
      status: 'cancelled',
      finalRev: nextGeneration.revision,
      finalRevision: nextGeneration.revision,
      content: nextGeneration.content,
      sources: nextGeneration.sources,
      cancelReason: nextGeneration.cancelReason,
      activeGeneration: generationSnapshot(nextGeneration),
      snapshot: generationSnapshot(nextGeneration),
    });
  } else {
    await broadcastRuntimeMessage({
      type: 'DONE',
      forwardedBy: 'service_worker',
      jobId: nextGeneration.jobId,
      status: 'completed',
      finalRev: nextGeneration.revision,
      finalRevision: nextGeneration.revision,
      content: nextGeneration.content,
      sources: nextGeneration.sources,
      errorCode: null,
      activeGeneration: generationSnapshot(nextGeneration),
      snapshot: generationSnapshot(nextGeneration),
    });
  }

  await closeOffscreenDocument();
  return {
    ok: true,
    accepted: true,
    activeGeneration: generationSnapshot(nextGeneration),
  };
}

async function handleComparisonDone(activeGeneration, message) {
  if (
    message?.variants
    && typeof message.variants === 'object'
    && !Array.isArray(message.variants)
  ) {
    const { terminal, activeGeneration: snapshot } = await applyComparisonDoneSummary(
      activeGeneration,
      message.variants,
      message,
    );
    return {
      ok: true,
      accepted: true,
      ...(terminal ? {} : { partial: true }),
      activeGeneration: snapshot,
    };
  }
  if (typeof message?.variantId === 'string' && activeGeneration.variants?.[message.variantId]) {
    const { terminal, activeGeneration: snapshot } = await writeComparisonVariantDone(
      activeGeneration,
      message.variantId,
      message,
    );
    return {
      ok: true,
      accepted: true,
      ...(terminal ? {} : { partial: true }),
      activeGeneration: snapshot,
    };
  }
  return { ok: true, accepted: false, ignored: true };
}

async function handleWorkerError(message) {
  const activeGeneration = await getActiveGeneration();
  if (!activeGeneration || activeGeneration.jobId !== message.jobId) {
    return { ok: true, accepted: false, ignored: true };
  }
  if (ACKNOWLEDGEABLE_STATUSES.has(activeGeneration.status)) {
    return {
      ok: true,
      accepted: false,
      ignored: true,
      activeGeneration: generationSnapshot(activeGeneration),
    };
  }

  const nextGeneration = await writeTerminalError(
    activeGeneration,
    message.errorCode || message.code || 'generation_failed',
    message,
  );
  return {
    ok: true,
    accepted: true,
    activeGeneration: generationSnapshot(nextGeneration),
  };
}

async function handleCancel(message) {
  const activeGeneration = await getActiveGeneration();
  if (
    !activeGeneration
    || (message.jobId && activeGeneration.jobId !== message.jobId)
  ) {
    return { ok: true, accepted: false, ignored: true };
  }

  if (!ACTIVE_GENERATION_STATUSES.has(activeGeneration.status)) {
    return {
      ok: true,
      accepted: false,
      activeGeneration: generationSnapshot(activeGeneration),
    };
  }

  const reason = message.reason || 'user';
  await broadcastRuntimeMessage({
    type: 'CANCEL',
    target: 'offscreen',
    forwardedBy: 'service_worker',
    jobId: activeGeneration.jobId,
    reason,
  });

  const now = Date.now();
  const nextGeneration = {
    ...withoutSensitiveGenerationData(activeGeneration),
    status: 'cancelled',
    cancelReason: reason,
    streamCompletedAt: now,
    completedAt: now,
    lastSnapshotAt: now,
    updatedAt: now,
  };
  await setActiveGeneration(nextGeneration);

  await broadcastRuntimeMessage({
    type: 'CANCEL_DONE',
    forwardedBy: 'service_worker',
    jobId: nextGeneration.jobId,
    status: 'cancelled',
    finalRev: normalizedRevision(nextGeneration.revision),
    finalRevision: normalizedRevision(nextGeneration.revision),
    content: nextGeneration.content || '',
    sources: Array.isArray(nextGeneration.sources) ? nextGeneration.sources : [],
    cancelReason: reason,
    activeGeneration: generationSnapshot(nextGeneration),
    snapshot: generationSnapshot(nextGeneration),
  });
  await closeOffscreenDocument();

  return {
    ok: true,
    accepted: true,
    activeGeneration: generationSnapshot(nextGeneration),
  };
}

async function handleDoneAck(message) {
  const activeGeneration = await getActiveGeneration();
  if (
    !activeGeneration
    || activeGeneration.jobId !== message.jobId
    || !ACKNOWLEDGEABLE_STATUSES.has(activeGeneration.status)
  ) {
    return { ok: true, removed: false, ignored: true };
  }

  const expectedRevision = normalizedRevision(activeGeneration.revision);
  const acknowledgedRevision = message.finalRevision ?? message.finalRev;
  if (
    acknowledgedRevision != null
    && normalizedRevision(acknowledgedRevision, -1) !== expectedRevision
  ) {
    return {
      ok: false,
      removed: false,
      errorCode: 'revision_mismatch',
      expectedRevision,
    };
  }

  await storageRemove(['activeGeneration']);
  return { ok: true, removed: true };
}

async function handleGetState() {
  let activeGeneration = await getActiveGeneration();

  if (activeGeneration && hasRetiredModelProvenance(activeGeneration)) {
    if (ACTIVE_GENERATION_STATUSES.has(activeGeneration.status)) {
      const cancellation = await handleCancel({
        jobId: activeGeneration.jobId,
        reason: 'model_retired',
      });
      activeGeneration = cancellation.activeGeneration || null;
    }
    if (activeGeneration) {
      const sanitized = stripRetiredModelProvenance(activeGeneration);
      activeGeneration = sanitized.value;
      if (sanitized.changed) await setActiveGeneration(activeGeneration);
    }
  }

  if (activeGeneration && ACTIVE_GENERATION_STATUSES.has(activeGeneration.status)) {
    const queuedWithoutCoordinator = activeGeneration.status === 'queued';
    const offscreen = queuedWithoutCoordinator
      ? {
          documentExists: await hasOffscreenDocument(),
          responsive: false,
          active: false,
          terminalForwarding: false,
        }
      : await inspectOffscreenJob(activeGeneration.jobId);
    const coordinatorHasJob = offscreen.active || offscreen.terminalForwarding;
    const staleHeartbeat = !offscreen.terminalForwarding
      && isGenerationHeartbeatStale(activeGeneration);
    if (
      queuedWithoutCoordinator
      || !offscreen.documentExists
      || !offscreen.responsive
      || !coordinatorHasJob
      || staleHeartbeat
    ) {
      const interruptReason = queuedWithoutCoordinator
        ? 'queued_without_coordinator'
        : !offscreen.documentExists
          ? 'offscreen_missing'
          : !offscreen.responsive
            ? 'offscreen_unresponsive'
            : !coordinatorHasJob
              ? 'worker_missing'
              : 'heartbeat_stale';
      activeGeneration = await markGenerationInterrupted(activeGeneration, interruptReason);
      if (offscreen.documentExists) await closeOffscreenDocument();
    }
  }

  return {
    type: 'STATE',
    ok: true,
    activeGeneration: generationSnapshot(activeGeneration),
    keyStatuses: Array.from(latestKeyStatuses.values()),
  };
}

const AUTH_REQUEST_TYPES = new Set(['AUTH_SIGN_IN', 'AUTH_SIGN_OUT', 'AUTH_GET_STATE']);
const SYNC_REQUEST_TYPES = new Set([
  'SYNC_GET_STATUS',
  'SYNC_INITIALIZE',
  'SYNC_LINK_DEVICE',
  'SYNC_NOW',
  'SYNC_SET_PAUSED',
  'SYNC_LIST_DEVICES',
  'SYNC_REVOKE_DEVICE',
  'SYNC_SET_DEVICE_ENABLED',
  'SYNC_RENAME_DEVICE',
  'SYNC_DISCONNECT',
  'SYNC_EXPORT_BACKUP',
  'SYNC_IMPORT_BACKUP',
  'SYNC_REGENERATE_RECOVERY',
  'SYNC_WAKE',
  'SYNC_CLEAN_LEGACY_CLOUD_DATA',
]);

/**
 * Kimlik dogrulama istekleri generation kuyruguna girmez; dogrudan yanitlanir.
 * Hata kodlari yalnizca authService'in tanimladigi sinirli kume ile disari cikar.
 */
async function handleAuthRequest(message) {
  try {
    if (message.type === 'AUTH_GET_STATE') {
      return { ok: true, user: getCurrentAuthUser() };
    }
    if (message.type === 'AUTH_SIGN_IN') {
      const user = await signInWithGoogle();
      await wakeCloudSync().catch(() => undefined);
      return { ok: true, user: user || null };
    }
    if (message.type === 'AUTH_SIGN_OUT') {
      await clearCloudSyncSession();
      await signOutFromGoogle();
      return { ok: true, user: null };
    }
    return { ok: false, errorCode: 'auth_unknown_request', user: null };
  } catch (error) {
    const code = AUTH_ERROR_CODES.has(error?.code) ? error.code : 'auth_failed';
    return { ok: false, errorCode: code, user: null };
  }
}

async function handleSyncRequest(message) {
  try {
    switch (message.type) {
      case 'SYNC_GET_STATUS':
        return { ok: true, status: await getCloudSyncStatus() };
      case 'SYNC_INITIALIZE':
        return { ok: true, ...(await initializeCloudSync()) };
      case 'SYNC_LINK_DEVICE':
        return { ok: true, ...(await linkCloudSyncDevice(message.recoveryCode)) };
      case 'SYNC_NOW':
        return { ok: true, result: await runCloudSync(), status: await getCloudSyncStatus() };
      case 'SYNC_SET_PAUSED':
        return { ok: true, ...(await setCloudSyncPaused(message.paused)) };
      case 'SYNC_LIST_DEVICES':
        return { ok: true, devices: await listCloudSyncDevices() };
      case 'SYNC_REVOKE_DEVICE':
        return { ok: true, ...(await revokeCloudSyncDevice(message.deviceId)) };
      case 'SYNC_SET_DEVICE_ENABLED':
        return { ok: true, ...(await setCloudSyncDeviceEnabled(message.deviceId, message.enabled)) };
      case 'SYNC_RENAME_DEVICE':
        return { ok: true, ...(await renameCloudSyncDevice(message.deviceId, message.label)) };
      case 'SYNC_DISCONNECT':
        return { ok: true, ...(await disconnectCloudSync()) };
      case 'SYNC_EXPORT_BACKUP':
        return { ok: true, backup: await exportEncryptedBackup() };
      case 'SYNC_IMPORT_BACKUP':
        return { ok: true, ...(await importEncryptedBackup(message.backup)) };
      case 'SYNC_REGENERATE_RECOVERY':
        return { ok: true, ...(await regenerateCloudRecoveryCode()) };
      case 'SYNC_WAKE':
        return { ok: true, result: await wakeCloudSync() };
      case 'SYNC_CLEAN_LEGACY_CLOUD_DATA':
        return { ok: true, ...(await cleanLegacyCloudData()) };
      default:
        return { ok: false, errorCode: 'sync_unknown_request' };
    }
  } catch (error) {
    const errorCode = error?.code || error?.message || 'sync_failed';
    const expectedCodes = new Set([
      'quota_exceeded', 'rules_denied', 'sync_signed_out', 'offline',
      'sync_version_unsupported', 'sync_chunk_incomplete', 'sync_payload_invalid',
      'sync_device_disabled',
    ]);
    if (!expectedCodes.has(errorCode)) console.error('Sync request error', error);
    return { ok: false, errorCode };
  }
}

function handleProtocolMessage(message) {
  switch (message.type) {
    case 'HERA_GENERATION_START':
      return handleGenerationStart(message);
    case 'GET_STATE':
      return handleGetState();
    case 'SNAPSHOT':
      return handleSnapshot(message);
    case 'KEY_STATUS':
      return handleKeyStatus(message);
    case 'MODEL_RESOLVED':
      return handleModelResolved(message);
    case 'HEARTBEAT':
      return handleHeartbeat(message);
    case 'WORKER_DONE':
      return handleWorkerDone(message);
    case 'WORKER_ERROR':
      return handleWorkerError(message);
    case 'CANCEL':
      return handleCancel(message);
    case 'SELECT_COMPARISON_WINNER':
      return handleSelectComparisonWinner(message);
    case 'RESOLVE_COMPARISON_BOTH':
      return handleResolveComparisonBoth(message);
    case 'GET_MODEL_AVAILABILITY':
      return handleGetModelAvailability();
    case 'DONE_ACK':
    case 'CANCEL_DONE_ACK':
      return handleDoneAck(message);
    default:
      return Promise.resolve({ ok: false, errorCode: 'unsupported_message' });
  }
}

if (typeof chrome.storage?.local?.setAccessLevel === 'function') {
  Promise.resolve(chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }))
    .catch(error => console.error('Storage access level could not be restricted', error));
}

installCloudSyncListeners();

// Prefer the native side panel. Browsers without this Chrome-specific API
// open Hera in a regular extension tab instead.
if (chrome.sidePanel?.setPanelBehavior) {
  Promise.resolve(
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }),
  ).catch((error) => console.error(error));
} else {
  chrome.action.onClicked.addListener(() => {
    openHeraTab().catch((error) => console.error(error));
  });
}

// Create a context menu item on installation.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'heraai-send',
    title: "HeraAi'a Gönder",
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'heraai-page',
    title: "Sayfayı HeraAi'ye Gönder",
    contexts: ['page'],
  });
});

// Preserve the selected-text context-menu flow.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'heraai-send' && info.selectionText) {
    chrome.storage.local.set({ selectedText: info.selectionText }, () => {
      if (tab?.windowId && chrome.sidePanel?.open) {
        chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {
          // Writing to storage is enough for the side panel to pick up later.
        });
      } else {
        openHeraTab().catch((error) => console.error(error));
      }
    });
  }
  if (info.menuItemId === 'heraai-page' && info.pageUrl) {
    chrome.storage.local.set({ pendingPageUrl: info.pageUrl }, () => {
      if (tab?.windowId && chrome.sidePanel?.open) {
        chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {
          // Writing to storage is enough for the side panel to pick up later.
        });
      } else {
        openHeraTab().catch((error) => console.error(error));
      }
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Guvenlik: yalnizca bu eklentinin kendi baglamlarindan gelen mesajlar islenir
  if (!sender || sender.id !== chrome.runtime.id) return;

  if (message?.type === 'HERAAI_CROP_DONE' || message?.type === 'HERAAI_CROP_CANCELLED') {
    void broadcastRuntimeMessage(message);
    return false;
  }

  if (!message?.type || message.forwardedBy === 'service_worker') return false;

  if (AUTH_REQUEST_TYPES.has(message.type)) {
    handleAuthRequest(message)
      .then(
        response => sendResponse(response),
        error => {
          console.error('Auth request error', error);
          sendResponse({ ok: false, errorCode: 'auth_failed', user: null });
        },
      );
    return true;
  }

  if (SYNC_REQUEST_TYPES.has(message.type)) {
    handleSyncRequest(message).then(
      response => sendResponse(response),
      () => sendResponse({ ok: false, errorCode: 'sync_failed' }),
    );
    return true;
  }

  const supportedTypes = new Set([
    'HERA_GENERATION_START',
    'GET_STATE',
    'SNAPSHOT',
    'KEY_STATUS',
    'MODEL_RESOLVED',
    'HEARTBEAT',
    'WORKER_DONE',
    'WORKER_ERROR',
    'CANCEL',
    'DONE_ACK',
    'CANCEL_DONE_ACK',
    'SELECT_COMPARISON_WINNER',
    'RESOLVE_COMPARISON_BOTH',
    'GET_MODEL_AVAILABILITY',
  ]);
  if (!supportedTypes.has(message.type)) return false;

  enqueueGenerationTask(() => handleProtocolMessage(message))
    .then(
      response => sendResponse(response),
      (error) => {
        console.error('Generation protocol error', error);
        sendResponse({
          ok: false,
          errorCode: 'generation_failed',
        });
      },
    );
  return true;
});
