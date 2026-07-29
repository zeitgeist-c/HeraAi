import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react'
import { flushSync } from 'react-dom'
import { Send, Square, Paperclip, Loader2, X, FileText, Languages, Lightbulb, Scissors, Globe, ScanText } from 'lucide-react'
import toast from 'react-hot-toast'

import { useTranslation } from 'react-i18next'

import SettingsPanel from './components/SettingsPanel'
import AppHeader from './components/AppHeader'
import ChatMessage from './components/ChatMessage'
import HistoryOverlay from './components/HistoryOverlay'
import StatsPanel from './components/StatsPanel'
import ShortcutsPanel from './components/ShortcutsPanel'
import WelcomeScreen from './components/WelcomeScreen'
import ModelSelector from './components/ModelSelector'
import { cancelCropOverlay, injectCropOverlay } from './lib/injectCropOverlay'
import { MODELS, DEFAULT_MODEL } from './lib/api'
import { fileToBase64 } from './lib/fileParsers'
import { exportSessions, importSessions } from './lib/importExport'
import {
  getAutoMessageTitle,
  getMessageDisplayContent,
  isHiddenPromptAutoTitle,
  isLegacyOcrPromptMessage,
} from './lib/messageDisplay'
import i18n from './i18n'
import { updateStats } from './lib/stats'

function appendToInputValue(current, text) {
  const safeCurrent = typeof current === 'string' ? current : ''
  const safeText = typeof text === 'string' ? text.trim() : ''
  if (!safeText) return safeCurrent
  const separator = safeCurrent.trim() ? '\n' : ''
  return `${safeCurrent}${separator}${safeText}`
}

const SCROLL_BOTTOM_THRESHOLD_PX = 96
const SCROLL_RESUME_THRESHOLD_PX = 2
const STREAM_SHORT_BUFFER = 240
const STREAM_LONG_BUFFER = 900
const MIN_THINKING_VISIBLE_MS = 500
const PARTIAL_PERSIST_INTERVAL_MS = 150
const BOOTSTRAP_STATE_TIMEOUT_MS = 5_000
const BOOTSTRAP_STATE_RETRY_DELAYS_MS = [250, 750, 1500]
const FINALIZATION_RETRY_DELAYS_MS = [250, 750, 1500]
const SESSION_TITLE_MAX_LENGTH = 80
const ACTIVE_GENERATION_STATUSES = new Set(['queued', 'running'])
const TERMINAL_GENERATION_STATUSES = new Set(['completed', 'cancelled', 'error', 'interrupted'])
const MODEL_LABELS = {
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
  'gemini-3.6-flash': 'Gemini 3.6 Flash',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
}

function normalizeConversationMessages(messages) {
  const normalized = []

  for (const message of messages || []) {
    if (!message || (message.role !== 'user' && message.role !== 'model')) continue

    const content = typeof message.content === 'string' ? message.content.trim() : ''
    const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0
    const isEmptyUiState = (
      message.role === 'model' &&
      ['thinking', 'streaming', 'cancelled_empty'].includes(message.status)
    )
    const isEmptyError = message.role === 'model' && message.status === 'error' && !content
    if (isEmptyUiState || isEmptyError) continue
    if (!content && !hasAttachments) continue

    if (message.role === 'model' && normalized.length === 0) continue
    normalized.push(message)
  }

  return normalized
}

function getScrollDistanceFromBottom(element) {
  if (!element) return 0
  return element.scrollHeight - element.scrollTop - element.clientHeight
}

function isScrollNearBottom(element) {
  return getScrollDistanceFromBottom(element) <= SCROLL_BOTTOM_THRESHOLD_PX
}

function clampScrollTop(element, nextTop) {
  const maxTop = Math.max(0, element.scrollHeight - element.clientHeight)
  return Math.min(Math.max(0, nextTop), maxTop)
}

function getStreamDisplayStep(bufferLength) {
  if (bufferLength > STREAM_LONG_BUFFER) return { characters: 36, delay: 60 }
  if (bufferLength > STREAM_SHORT_BUFFER) return { characters: 24, delay: 60 }
  return { characters: 2, delay: 30 }
}

function takeDisplayChunk(text, targetCount) {
  const characters = Array.from(text)
  if (characters.length <= targetCount) return text

  const maximumCount = Math.min(characters.length, Math.ceil(targetCount * 1.5))
  for (let index = targetCount; index < maximumCount; index += 1) {
    if (/\s/.test(characters[index])) {
      return characters.slice(0, index + 1).join('')
    }
  }

  return characters.slice(0, targetCount).join('')
}

function createUniqueMessageId(counterRef) {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  const fallbackCounter = counterRef.current++
  return `msg-${Date.now()}-${fallbackCounter}`
}

function repairMessageIds(messages, counterRef) {
  const seenIds = new Set()
  let changed = false

  const repairedMessages = (messages || []).map(message => {
    if (!message) return message

    const currentKey = message.id == null ? null : String(message.id)
    if (currentKey != null && !seenIds.has(currentKey)) {
      seenIds.add(currentKey)
      return message
    }

    const nextId = createUniqueMessageId(counterRef)
    seenIds.add(String(nextId))
    changed = true
    return { ...message, id: nextId }
  })

  return { messages: repairedMessages, changed }
}

function repairStoredSessions(sessions, counterRef, activeGeneration = null, newChatTitle = 'New Chat') {
  let changed = false
  const repairedSessions = (sessions || []).map(session => {
    const repaired = repairMessageIds(session?.messages, counterRef)
    const displaySafeMessages = repaired.messages.map(message => {
      if (!isLegacyOcrPromptMessage(message) || typeof message.displayContent === 'string') {
        return message
      }
      changed = true
      return { ...message, displayContent: '' }
    })
    const messages = displaySafeMessages.flatMap(message => {
      if (!message || message.role !== 'model') return message ? [message] : []
      const content = typeof message.content === 'string' ? message.content : ''
      const belongsToActiveGeneration = (
        activeGeneration
        && session?.id === activeGeneration.sessionId
        && message.id === activeGeneration.assistantMessageId
        && (
          ACTIVE_GENERATION_STATUSES.has(activeGeneration.status)
          || TERMINAL_GENERATION_STATUSES.has(activeGeneration.status)
        )
      )
      if (belongsToActiveGeneration) return [message]
      if (['thinking', 'streaming', 'cancelled_empty'].includes(message.status) && !content) {
        changed = true
        return []
      }
      if (['thinking', 'streaming'].includes(message.status) && content) {
        changed = true
        return [{ ...message, status: 'interrupted' }]
      }
      return [message]
    })
    const shouldResetHiddenPromptTitle = (
      session?.isTitleCustom !== true
      && isHiddenPromptAutoTitle(session?.title, messages)
    )
    if (
      !repaired.changed
      && !shouldResetHiddenPromptTitle
      && messages.length === repaired.messages.length
      && messages.every((message, index) => message === repaired.messages[index])
    ) {
      return session
    }
    changed = true
    return {
      ...session,
      ...(shouldResetHiddenPromptTitle ? { title: newChatTitle } : {}),
      messages,
    }
  })

  return { sessions: repairedSessions, changed }
}

function requestDisplayFrame(callback) {
  if (typeof window.requestAnimationFrame === 'function') {
    return {
      type: 'animation',
      id: window.requestAnimationFrame(callback),
    }
  }

  return {
    type: 'timer',
    id: window.setTimeout(() => callback(performance.now()), 16),
  }
}

function cancelDisplayFrame(frame) {
  if (!frame) return
  if (frame.type === 'animation' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(frame.id)
    return
  }
  window.clearTimeout(frame.id)
}

function getGenerationContent(generation) {
  if (!generation) return ''
  if (typeof generation.content === 'string') return generation.content
  return typeof generation.receivedContent === 'string' ? generation.receivedContent : ''
}

function sendRuntimeMessage(message) {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return Promise.reject(new Error('Chrome runtime messaging is unavailable'))
  }

  try {
    return Promise.resolve(chrome.runtime.sendMessage(message))
  } catch (error) {
    return Promise.reject(error)
  }
}

function sendRuntimeMessageWithTimeout(message, timeoutMs) {
  let timeoutId
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      const error = new Error(`Chrome runtime message timed out: ${message?.type || 'unknown'}`)
      error.name = 'RuntimeMessageTimeoutError'
      reject(error)
    }, timeoutMs)
  })

  return Promise.race([
    sendRuntimeMessage(message),
    timeout,
  ]).finally(() => {
    if (timeoutId != null) window.clearTimeout(timeoutId)
  })
}

function setChromeStorage(values) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.set) return Promise.resolve()
  try {
    return Promise.resolve(chrome.storage.local.set(values))
  } catch (error) {
    return Promise.reject(error)
  }
}

function createUserMessage({ id, content, displayContent, attachments, mode }) {
  return {
    id,
    role: 'user',
    content,
    ...(typeof displayContent === 'string' ? { displayContent } : {}),
    attachments,
    mode
  }
}

function createAssistantMessage({ id, requestId, userMessageId, startedAt }) {
  return {
    id,
    requestId,
    userMessageId,
    startedAt,
    role: 'model',
    content: '',
    status: 'thinking',
    sources: []
  }
}

function createSession({ id, title, messages, updatedAt = Date.now() }) {
  return {
    id,
    title,
    isTitleCustom: false,
    isStarred: false,
    updatedAt,
    messages,
  }
}

function normalizeSessionMetadata(session) {
  if (!session) return session
  const shouldResetHiddenPromptTitle = (
    session.isTitleCustom !== true
    && isHiddenPromptAutoTitle(session.title, session.messages)
  )
  return {
    ...session,
    ...(shouldResetHiddenPromptTitle ? { title: i18n.t('chat.new_chat') } : {}),
    isTitleCustom: session.isTitleCustom === true,
    isStarred: session.isStarred === true,
  }
}

function applySessionMetadataPatch(session, metadataPatch = {}) {
  const normalizedSession = normalizeSessionMetadata(session)
  if (!normalizedSession) return normalizedSession
  return {
    ...normalizedSession,
    ...metadataPatch,
    isTitleCustom: Object.prototype.hasOwnProperty.call(metadataPatch, 'isTitleCustom')
      ? metadataPatch.isTitleCustom === true
      : normalizedSession.isTitleCustom,
    isStarred: Object.prototype.hasOwnProperty.call(metadataPatch, 'isStarred')
      ? metadataPatch.isStarred === true
      : normalizedSession.isStarred,
  }
}

function sortSessionsByUpdatedAt(sessions) {
  return [...(sessions || [])].sort((a, b) => (
    Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0)
  ))
}

function App() {
  const { t } = useTranslation()
  const [appConfig, setAppConfig] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [messages, setMessages] = useState([])
  const [sessions, setSessions] = useState([])
  const [activeSessionId, setActiveSessionId] = useState(null)
  const [showHistory, setShowHistory] = useState(false)
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false)
  const [isBulkDeleting, setIsBulkDeleting] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [enableResearch, setEnableResearch] = useState(false)
  const [activeMode, setActiveMode] = useState(null)
  const [isCropActive, setIsCropActive] = useState(false)
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL)
  const msgIdCounter = useRef(0)
  const scrollRef = useRef(null)
  const fileInputRef = useRef(null)
  const streamBufferRef = useRef('')
  const displayedAssistantContentRef = useRef('')
  const streamDisplayFrameRef = useRef(null)
  const streamLastDisplayAtRef = useRef(0)
  const streamRevealNotBeforeRef = useRef(0)
  const streamDrainResolversRef = useRef([])
  const streamTargetMessageIdRef = useRef(null)
  const activeSessionIdRef = useRef(null)
  const sessionsRef = useRef([])
  const messagesRef = useRef([])
  const activeGenerationRef = useRef(null)
  const lastGenerationRevisionRef = useRef(0)
  const finalizingGenerationRef = useRef(null)
  const finalizationPromiseRef = useRef(null)
  const finalizationRetryRef = useRef({ jobId: null, attempts: 0, timerId: null })
  const finalizeGenerationHandlerRef = useRef(() => Promise.resolve())
  const generationStateHandlerRef = useRef(() => undefined)
  const cancellationPromiseRef = useRef(null)
  const cancelRequestedJobIdsRef = useRef(new Set())
  const handleSendRef = useRef(null)
  const presentationCancellationRef = useRef(null)
  const storageWriteQueueRef = useRef(Promise.resolve())
  const storageWriteEpochRef = useRef(0)
  const pendingStructuralStorageWriteRef = useRef(null)
  const persistedSessionIdsRef = useRef(new Set())
  const pendingSessionMetadataRef = useRef(new Map())
  const sessionMetadataRevisionRef = useRef(0)
  const partialPersistTimerRef = useRef(null)
  const lastPartialPersistAtRef = useRef(0)
  const flushVisibleSessionRef = useRef(() => Promise.resolve())
  const mountedRef = useRef(false)
  const panelVisibleRef = useRef(document.visibilityState !== 'hidden')
  const scheduledScrollFrameRef = useRef(null)
  const cropProcessingRef = useRef(false)
  const cropTargetRef = useRef(null)
  const cropTogglePendingRef = useRef(false)
  const autoScrollRef = useRef(true)
  const userPausedAutoScrollRef = useRef(false)
  const forceScrollToBottomRef = useRef(false)
  const prevIsGeneratingRef = useRef(false)
  const [showScrollDownBtn, setShowScrollDownBtn] = useState(false)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState([])
  const hasImageAttachment = attachments.some(att => (
    att?.mimeType?.startsWith('image/') && att?.data
  ))
  const [isGenerating, setIsGeneratingState] = useState(false)
  const isGeneratingRef = useRef(false)
  const setGenerating = useCallback((val) => {
    setIsGeneratingState(val)
    isGeneratingRef.current = val
  }, [])

  useEffect(() => { activeSessionIdRef.current = activeSessionId }, [activeSessionId])
  useEffect(() => { sessionsRef.current = sessions }, [sessions])
  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const scheduleScrollToBottom = useCallback(() => {
    const run = () => {
      scheduledScrollFrameRef.current = null
      const el = scrollRef.current
      if (!el) return
      el.scrollTop = el.scrollHeight
      autoScrollRef.current = true
      userPausedAutoScrollRef.current = false
      forceScrollToBottomRef.current = false
      setShowScrollDownBtn(false)
    }

    if (typeof window.requestAnimationFrame === 'function') {
      if (scheduledScrollFrameRef.current != null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(scheduledScrollFrameRef.current)
      }
      scheduledScrollFrameRef.current = window.requestAnimationFrame(run)
      return
    }

    run()
  }, [])

  const stickToBottomOnNextRender = useCallback(() => {
    autoScrollRef.current = true
    userPausedAutoScrollRef.current = false
    forceScrollToBottomRef.current = true
    setShowScrollDownBtn(false)
    scheduleScrollToBottom()
  }, [scheduleScrollToBottom])

  const pauseAutoScroll = useCallback(() => {
    if (scheduledScrollFrameRef.current != null && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(scheduledScrollFrameRef.current)
      scheduledScrollFrameRef.current = null
    }
    userPausedAutoScrollRef.current = true
    autoScrollRef.current = false
    forceScrollToBottomRef.current = false
    setShowScrollDownBtn(true)
  }, [])

  const scrollChatBy = useCallback((deltaY) => {
    const container = scrollRef.current
    if (!container || !deltaY) return

    if (deltaY < 0) {
      pauseAutoScroll()
    }

    container.scrollTop = clampScrollTop(container, container.scrollTop + deltaY)
    const distanceFromBottom = getScrollDistanceFromBottom(container)
    const isAtBottom = distanceFromBottom <= SCROLL_RESUME_THRESHOLD_PX
    const nearBottom = isScrollNearBottom(container)

    if (isAtBottom && deltaY > 0) {
      userPausedAutoScrollRef.current = false
      autoScrollRef.current = true
      setShowScrollDownBtn(false)
      return
    }

    if (userPausedAutoScrollRef.current) {
      autoScrollRef.current = false
      setShowScrollDownBtn(true)
      return
    }

    autoScrollRef.current = nearBottom
    setShowScrollDownBtn(!nearBottom)
  }, [pauseAutoScroll])

  const applyTheme = useCallback((themeValue, customPrimaryColor) => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');

    if (themeValue === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      root.classList.add(systemTheme);
    } else {
      root.classList.add(themeValue);
    }

    if (customPrimaryColor) {
      const hsl = hexToHSL(customPrimaryColor);
      root.style.setProperty('--primary', `${hsl.h} ${hsl.s}% ${hsl.l}%`);
      root.style.setProperty('--primary-hsl', `${hsl.h}, ${hsl.s}%, ${hsl.l}%`);
      root.style.setProperty('--primary-foreground', hsl.l > 62 ? '248 25% 10%' : '0 0% 100%');
    }
  }, [])

  const hexToHSL = (hex) => {
    let r = parseInt(hex.slice(1, 3), 16) / 255;
    let g = parseInt(hex.slice(3, 5), 16) / 255;
    let b = parseInt(hex.slice(5, 7), 16) / 255;

    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
      h = s = 0;
    } else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }

    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  const generateTitle = useCallback((msgs) => {
    const firstUserMsg = msgs.find(message => (
      message.role === 'user' && getMessageDisplayContent(message)
    ))
    const visibleContent = getMessageDisplayContent(firstUserMsg)
    if (visibleContent) return getAutoMessageTitle(visibleContent)
    return t('chat.new_chat')
  }, [t])

  const resolveSessionTitle = useCallback((session, nextMessages) => {
    const currentTitle = typeof session?.title === 'string' ? session.title.trim() : ''
    if (session?.isTitleCustom === true && currentTitle) return currentTitle
    return generateTitle(nextMessages)
  }, [generateTitle])

  const trackStructuralStorageWrite = useCallback((writePromise) => {
    pendingStructuralStorageWriteRef.current = writePromise
    const clearTrackedWrite = () => {
      if (pendingStructuralStorageWriteRef.current === writePromise) {
        pendingStructuralStorageWriteRef.current = null
      }
    }
    void writePromise.then(clearTrackedWrite, clearTrackedWrite)
    return writePromise
  }, [])

  const enqueueStorageWrite = useCallback((values) => {
    const writeEpoch = storageWriteEpochRef.current
    const write = async () => {
      if (writeEpoch !== storageWriteEpochRef.current) return false
      await setChromeStorage(values)
      if (Array.isArray(values?.sessions)) {
        values.sessions.forEach(session => {
          if (session?.id) persistedSessionIdsRef.current.add(session.id)
        })
      }
      return true
    }
    const queuedWrite = storageWriteQueueRef.current
      .catch(() => undefined)
      .then(write)
    storageWriteQueueRef.current = queuedWrite.catch(error => {
      console.error('Chrome storage write failed', error)
    })
    return Array.isArray(values?.sessions)
      ? trackStructuralStorageWrite(queuedWrite)
      : queuedWrite
  }, [trackStructuralStorageWrite])

  const mergeSessionMessages = useCallback((sessionId, nextMessages) => {
    if (!sessionId || !nextMessages?.length) return null
    const previous = sessionsRef.current
    const existing = previous.find(session => session.id === sessionId)
    if (nextMessages.length === 1 && nextMessages[0].role === 'model' && !existing) return null

    const nextSessions = [
      ...previous.filter(session => session.id !== sessionId),
      {
        ...normalizeSessionMetadata(existing),
        id: sessionId,
        title: resolveSessionTitle(existing, nextMessages),
        isTitleCustom: existing?.isTitleCustom === true,
        isStarred: existing?.isStarred === true,
        updatedAt: Date.now(),
        messages: nextMessages,
      },
    ]
    sessionsRef.current = nextSessions
    if (mountedRef.current) setSessions(nextSessions)
    return nextSessions
  }, [resolveSessionTitle])

  const writeSessionMessagesToLatestStorage = useCallback(async (
    sessionId,
    nextMessages,
    storagePatch,
    writeEpoch,
  ) => {
    if (writeEpoch !== storageWriteEpochRef.current) return false
    const localSession = sessionsRef.current.find(session => session?.id === sessionId)
    if (!localSession) return false

    let sourceSessions = sessionsRef.current
    let hasStoredSessionsSnapshot = false
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
      const stored = await chrome.storage.local.get(['sessions'])
      if (writeEpoch !== storageWriteEpochRef.current) return false
      if (Array.isArray(stored?.sessions)) {
        sourceSessions = stored.sessions
        hasStoredSessionsSnapshot = true
      }
    }

    const latestLocalSession = sessionsRef.current.find(session => session?.id === sessionId)
    if (!latestLocalSession || writeEpoch !== storageWriteEpochRef.current) return false

    const pendingMetadataSnapshot = new Map(pendingSessionMetadataRef.current)
    const appliedPendingMetadata = new Map()
    const sourceSessionIds = new Set(sourceSessions.map(session => session?.id).filter(Boolean))
    let mergedSourceSessions = sourceSessions.map(session => {
      const pendingMetadata = pendingMetadataSnapshot.get(session?.id)
      if (!pendingMetadata) return session
      appliedPendingMetadata.set(session.id, pendingMetadata)
      return applySessionMetadataPatch(session, pendingMetadata.patch)
    })

    pendingMetadataSnapshot.forEach((pendingMetadata, pendingSessionId) => {
      if (sourceSessionIds.has(pendingSessionId)) return
      if (
        hasStoredSessionsSnapshot
        && persistedSessionIdsRef.current.has(pendingSessionId)
      ) {
        if (
          pendingSessionMetadataRef.current.get(pendingSessionId)?.revision
          === pendingMetadata.revision
        ) {
          pendingSessionMetadataRef.current.delete(pendingSessionId)
        }
        return
      }

      const pendingLocalSession = sessionsRef.current.find(session => (
        session?.id === pendingSessionId
      ))
      if (!pendingLocalSession) return
      appliedPendingMetadata.set(pendingSessionId, pendingMetadata)
      mergedSourceSessions = [
        ...mergedSourceSessions,
        applySessionMetadataPatch(pendingLocalSession, pendingMetadata.patch),
      ]
    })

    const storedSession = mergedSourceSessions.find(session => session?.id === sessionId)
    const targetWasDeleted = (
      hasStoredSessionsSnapshot
      && !storedSession
      && persistedSessionIdsRef.current.has(sessionId)
    )
    if (targetWasDeleted) {
      if (appliedPendingMetadata.size > 0) {
        if (writeEpoch !== storageWriteEpochRef.current) return false
        await setChromeStorage({ sessions: mergedSourceSessions })
        mergedSourceSessions.forEach(session => {
          if (session?.id) persistedSessionIdsRef.current.add(session.id)
        })
        appliedPendingMetadata.forEach((pendingMetadata, pendingSessionId) => {
          if (
            pendingSessionMetadataRef.current.get(pendingSessionId)?.revision
            === pendingMetadata.revision
          ) {
            pendingSessionMetadataRef.current.delete(pendingSessionId)
          }
        })
      }
      return false
    }

    const metadataSource = normalizeSessionMetadata(storedSession || latestLocalSession)
    const nextSession = {
      ...metadataSource,
      id: sessionId,
      title: resolveSessionTitle(metadataSource, nextMessages),
      isTitleCustom: metadataSource?.isTitleCustom === true,
      isStarred: metadataSource?.isStarred === true,
      updatedAt: latestLocalSession.updatedAt || Date.now(),
      messages: nextMessages,
    }
    const nextSessions = storedSession
      ? mergedSourceSessions.map(session => (session?.id === sessionId ? nextSession : session))
      : [...mergedSourceSessions, nextSession]

    if (writeEpoch !== storageWriteEpochRef.current) return false
    await setChromeStorage({ sessions: nextSessions, ...storagePatch })
    nextSessions.forEach(session => {
      if (session?.id) persistedSessionIdsRef.current.add(session.id)
    })
    appliedPendingMetadata.forEach((pendingMetadata, pendingSessionId) => {
      if (
        pendingSessionMetadataRef.current.get(pendingSessionId)?.revision
        === pendingMetadata.revision
      ) {
        pendingSessionMetadataRef.current.delete(pendingSessionId)
      }
    })
    return true
  }, [resolveSessionTitle])

  const queueSessionMessageWrite = useCallback((sessionId, nextMessages, storagePatch = {}) => {
    if (!sessionId || !nextMessages?.length) return Promise.resolve(false)
    const writeEpoch = storageWriteEpochRef.current
    const write = () => writeSessionMessagesToLatestStorage(
      sessionId,
      nextMessages,
      storagePatch,
      writeEpoch,
    )
    const queuedWrite = storageWriteQueueRef.current
      .catch(() => undefined)
      .then(write)
    storageWriteQueueRef.current = queuedWrite.catch(error => {
      console.error('Chrome storage merged session write failed', error)
    })
    return queuedWrite
  }, [writeSessionMessagesToLatestStorage])

  const persistSessionMessages = useCallback((sessionId, nextMessages, extraStorage = {}) => {
    const nextSessions = mergeSessionMessages(sessionId, nextMessages)
    if (!nextSessions) return Promise.resolve(false)
    return queueSessionMessageWrite(sessionId, nextMessages, {
      activeSessionId: activeSessionIdRef.current || sessionId,
      ...extraStorage,
    })
  }, [mergeSessionMessages, queueSessionMessageWrite])

  const persistSessionMessagesFromLatestStorage = useCallback((sessionId, nextMessages) => (
    queueSessionMessageWrite(sessionId, nextMessages)
  ), [queueSessionMessageWrite])

  const updateSessionMetadata = useCallback((sessionId, metadataPatch) => {
    if (!sessionId || !metadataPatch) return Promise.resolve(false)
    const currentSession = sessionsRef.current.find(session => session?.id === sessionId)
    if (!currentSession) return Promise.resolve(false)

    const previousPendingMetadata = pendingSessionMetadataRef.current.get(sessionId)
    sessionMetadataRevisionRef.current += 1
    const pendingMetadata = {
      revision: sessionMetadataRevisionRef.current,
      patch: {
        ...(previousPendingMetadata?.patch || {}),
        ...metadataPatch,
      },
    }
    pendingSessionMetadataRef.current.set(sessionId, pendingMetadata)

    const nextLocalSessions = sessionsRef.current.map(session => (
      session?.id === sessionId
        ? applySessionMetadataPatch(session, metadataPatch)
        : session
    ))
    sessionsRef.current = nextLocalSessions
    if (mountedRef.current) setSessions(nextLocalSessions)

    const writeEpoch = storageWriteEpochRef.current
    const write = async () => {
      if (writeEpoch !== storageWriteEpochRef.current) return false
      if (typeof chrome === 'undefined' || !chrome.storage?.local?.get) return true

      const stored = await chrome.storage.local.get(['sessions'])
      if (writeEpoch !== storageWriteEpochRef.current) return false
      const storedSessions = Array.isArray(stored?.sessions) ? stored.sessions : []
      const storedSession = storedSessions.find(session => session?.id === sessionId)
      if (
        Array.isArray(stored?.sessions)
        && !storedSession
        && persistedSessionIdsRef.current.has(sessionId)
      ) {
        if (pendingSessionMetadataRef.current.get(sessionId)?.revision === pendingMetadata.revision) {
          pendingSessionMetadataRef.current.delete(sessionId)
        }
        return false
      }

      const latestPendingMetadata = pendingSessionMetadataRef.current.get(sessionId) || pendingMetadata
      const nextSession = applySessionMetadataPatch(
        storedSession || currentSession,
        latestPendingMetadata.patch,
      )
      const nextStoredSessions = storedSession
        ? storedSessions.map(session => (session?.id === sessionId ? nextSession : session))
        : [...storedSessions, nextSession]
      await setChromeStorage({ sessions: nextStoredSessions })
      persistedSessionIdsRef.current.add(sessionId)
      if (
        pendingSessionMetadataRef.current.get(sessionId)?.revision === latestPendingMetadata.revision
      ) {
        pendingSessionMetadataRef.current.delete(sessionId)
      }
      return true
    }

    const queuedWrite = storageWriteQueueRef.current
      .catch(() => undefined)
      .then(write)
    storageWriteQueueRef.current = queuedWrite.catch(error => {
      console.error('Chrome session metadata write failed', error)
    })
    return queuedWrite
  }, [])

  const renameSession = useCallback((sessionId, nextTitle) => {
    const normalizedTitle = typeof nextTitle === 'string'
      ? nextTitle.trim().slice(0, SESSION_TITLE_MAX_LENGTH)
      : ''
    if (!normalizedTitle) {
      toast.error(t('chat.session_title.empty_error', {
        defaultValue: 'Chat name cannot be empty.',
      }))
      return false
    }

    const currentSession = sessionsRef.current.find(session => session?.id === sessionId)
    if (!currentSession) return false
    if (currentSession.title === normalizedTitle && currentSession.isTitleCustom === true) {
      return true
    }

    void updateSessionMetadata(sessionId, {
      title: normalizedTitle,
      isTitleCustom: true,
    }).then((saved) => {
      if (saved) {
        toast.success(t('chat.session_title.renamed', {
          defaultValue: 'Chat renamed.',
        }))
      }
    }).catch(() => {
      toast.error(t('chat.session_title.save_error', {
        defaultValue: 'Chat name could not be saved.',
      }))
    })
    return true
  }, [t, updateSessionMetadata])

  const toggleStarSession = useCallback((sessionId) => {
    const currentSession = sessionsRef.current.find(session => session?.id === sessionId)
    if (!currentSession) return
    void updateSessionMetadata(sessionId, {
      isStarred: currentSession.isStarred !== true,
    }).catch(() => {
      toast.error(t('chat.bulk_delete.save_error', {
        defaultValue: 'Chat could not be updated.',
      }))
    })
  }, [t, updateSessionMetadata])

  const persistAuthoritativeSessionRepair = useCallback((authoritativeGeneration) => {
    const repaired = repairStoredSessions(
      sessionsRef.current,
      msgIdCounter,
      authoritativeGeneration,
      t('chat.new_chat'),
    )
    if (!repaired.changed) return Promise.resolve(false)

    sessionsRef.current = repaired.sessions
    if (mountedRef.current) setSessions(repaired.sessions)

    const activeSession = repaired.sessions.find(session => (
      session.id === activeSessionIdRef.current
    ))
    if (activeSession) {
      messagesRef.current = activeSession.messages || []
      if (mountedRef.current) setMessages(messagesRef.current)
    }

    return enqueueStorageWrite({
      sessions: repaired.sessions,
      activeSessionId: activeSessionIdRef.current,
    })
  }, [enqueueStorageWrite, t])

  const flushVisibleSession = useCallback((immediate = false) => {
    if (partialPersistTimerRef.current != null) {
      window.clearTimeout(partialPersistTimerRef.current)
      partialPersistTimerRef.current = null
    }
    lastPartialPersistAtRef.current = Date.now()
    if (immediate) {
      const precedingWrites = storageWriteQueueRef.current.catch(() => undefined)
      const pendingStructuralWrite = pendingStructuralStorageWriteRef.current
      const writeImmediately = () => {
        const latestSessionId = activeSessionIdRef.current
        const latestVisibleMessages = messagesRef.current
        if (!latestSessionId || !latestVisibleMessages?.length) return Promise.resolve(false)
        const nextSessions = mergeSessionMessages(latestSessionId, latestVisibleMessages)
        if (!nextSessions) return Promise.resolve(false)
        storageWriteEpochRef.current += 1
        const writeEpoch = storageWriteEpochRef.current
        return writeSessionMessagesToLatestStorage(
          latestSessionId,
          latestVisibleMessages,
          { activeSessionId: activeSessionIdRef.current || latestSessionId },
          writeEpoch,
        )
      }
      const immediateWrite = (
        pendingStructuralWrite
          ? pendingStructuralWrite.catch(() => undefined).then(writeImmediately)
          : writeImmediately()
      ).catch(error => {
          console.error('Immediate Chrome storage flush failed', error)
        })
      storageWriteQueueRef.current = Promise.all([precedingWrites, immediateWrite]).then(() => undefined)
      return immediateWrite
    }
    const sessionId = activeSessionIdRef.current
    const visibleMessages = messagesRef.current
    if (!sessionId || !visibleMessages?.length) return Promise.resolve()
    return persistSessionMessages(sessionId, visibleMessages)
  }, [mergeSessionMessages, persistSessionMessages, writeSessionMessagesToLatestStorage])

  useEffect(() => {
    flushVisibleSessionRef.current = flushVisibleSession
  }, [flushVisibleSession])

  useEffect(() => {
    if (!isGenerating || !activeSessionId || !messages.some(message => message.status === 'streaming')) {
      return undefined
    }
    if (partialPersistTimerRef.current != null) return undefined
    const elapsed = Date.now() - lastPartialPersistAtRef.current
    const delay = Math.max(0, PARTIAL_PERSIST_INTERVAL_MS - elapsed)
    partialPersistTimerRef.current = window.setTimeout(() => {
      partialPersistTimerRef.current = null
      lastPartialPersistAtRef.current = Date.now()
      void persistSessionMessages(activeSessionIdRef.current, messagesRef.current)
    }, delay)
    return undefined
  }, [activeSessionId, isGenerating, messages, persistSessionMessages])

  const appendAssistantTextToMessage = useCallback((messageId, text) => {
    if (!text || messageId == null) return

    setMessages(prev => {
      const next = prev.map(message => (
        message.id === messageId && message.role === 'model'
          ? { ...message, content: `${message.content || ''}${text}`, status: 'streaming' }
          : message
      ))
      messagesRef.current = next
      return next
    })
  }, [])

  const resolveStreamDrainWaiters = useCallback(() => {
    const resolvers = streamDrainResolversRef.current
    streamDrainResolversRef.current = []
    resolvers.forEach(resolve => resolve())
  }, [])

  const stopAssistantDisplayQueue = useCallback((discardPending = true) => {
    if (streamDisplayFrameRef.current != null) {
      cancelDisplayFrame(streamDisplayFrameRef.current)
      streamDisplayFrameRef.current = null
    }
    if (discardPending) streamBufferRef.current = ''
    streamLastDisplayAtRef.current = 0
    streamRevealNotBeforeRef.current = 0
    resolveStreamDrainWaiters()
  }, [resolveStreamDrainWaiters])

  const scheduleAssistantDisplayFrame = useCallback((messageId = streamTargetMessageIdRef.current) => {
    if (
      messageId == null ||
      !panelVisibleRef.current ||
      !streamBufferRef.current ||
      streamDisplayFrameRef.current != null
    ) {
      return
    }

    const pump = () => {
      streamDisplayFrameRef.current = null
      if (!panelVisibleRef.current) return
      if (!streamBufferRef.current) {
        resolveStreamDrainWaiters()
        return
      }

      const now = Date.now()
      const { characters, delay } = getStreamDisplayStep(streamBufferRef.current.length)
      const nextDisplayAt = Math.max(
        streamRevealNotBeforeRef.current,
        streamLastDisplayAtRef.current + delay,
      )
      if (now < nextDisplayAt) {
        streamDisplayFrameRef.current = requestDisplayFrame(pump)
        return
      }

      const nextSlice = takeDisplayChunk(streamBufferRef.current, characters)
      streamBufferRef.current = streamBufferRef.current.slice(nextSlice.length)
      displayedAssistantContentRef.current += nextSlice
      streamLastDisplayAtRef.current = now

      appendAssistantTextToMessage(messageId, nextSlice)

      if (streamBufferRef.current) {
        streamDisplayFrameRef.current = requestDisplayFrame(pump)
        return
      }

      resolveStreamDrainWaiters()
    }

    streamDisplayFrameRef.current = requestDisplayFrame(pump)
  }, [appendAssistantTextToMessage, resolveStreamDrainWaiters])

  const drainAssistantBuffer = useCallback(() => {
    if (!streamBufferRef.current && streamDisplayFrameRef.current == null) return Promise.resolve()
    return new Promise(resolve => {
      streamDrainResolversRef.current.push(resolve)
    })
  }, [])

  const updateVisibleGenerationMessage = useCallback((generation, updater) => {
    if (!generation || generation.sessionId !== activeSessionIdRef.current) return null
    const assistantMessageId = generation.assistantMessageId
    let found = false
    const currentMessages = messagesRef.current
    const nextMessages = currentMessages.map(message => {
      if (message.id !== assistantMessageId || message.role !== 'model') return message
      found = true
      return updater(message)
    })

    if (!found) {
      const created = createAssistantMessage({
        id: assistantMessageId,
        requestId: generation.requestId || generation.jobId,
        userMessageId: generation.userMessageId,
        startedAt: generation.startedAt || Date.now(),
      })
      nextMessages.push(updater(created))
    }

    messagesRef.current = nextMessages
    if (mountedRef.current) setMessages(nextMessages)
    return nextMessages
  }, [])

  const prepareGenerationPresentation = useCallback((generation) => {
    if (!generation || generation.sessionId !== activeSessionIdRef.current) return false
    const assistantMessageId = generation.assistantMessageId
    const existingMessage = messagesRef.current.find(message => (
      message.id === assistantMessageId && message.role === 'model'
    ))
    const fullContent = getGenerationContent(generation)
    const storedContent = typeof existingMessage?.content === 'string' ? existingMessage.content : ''
    const visibleContent = fullContent.startsWith(storedContent) ? storedContent : ''

    stopAssistantDisplayQueue(true)
    streamTargetMessageIdRef.current = assistantMessageId
    displayedAssistantContentRef.current = visibleContent
    streamLastDisplayAtRef.current = 0
    streamRevealNotBeforeRef.current = visibleContent ? 0 : Date.now() + MIN_THINKING_VISIBLE_MS

    updateVisibleGenerationMessage(generation, message => ({
      ...message,
      content: visibleContent,
      status: visibleContent ? 'streaming' : 'thinking',
      sources: Array.isArray(generation.sources) ? generation.sources : (message.sources || []),
      errorCode: null,
    }))
    return true
  }, [stopAssistantDisplayQueue, updateVisibleGenerationMessage])

  const queueGenerationContent = useCallback((generation) => {
    if (!generation || generation.sessionId !== activeSessionIdRef.current) return
    const fullContent = getGenerationContent(generation)
    const displayedContent = displayedAssistantContentRef.current
    const knownContent = `${displayedContent}${streamBufferRef.current}`

    if (fullContent.startsWith(knownContent)) {
      const suffix = fullContent.slice(knownContent.length)
      if (suffix) streamBufferRef.current += suffix
    } else if (fullContent.startsWith(displayedContent)) {
      streamBufferRef.current = fullContent.slice(displayedContent.length)
    } else {
      displayedAssistantContentRef.current = ''
      streamBufferRef.current = fullContent
      streamRevealNotBeforeRef.current = Date.now() + MIN_THINKING_VISIBLE_MS
      updateVisibleGenerationMessage(generation, message => ({
        ...message,
        content: '',
        status: 'thinking',
      }))
    }

    if (Array.isArray(generation.sources)) {
      updateVisibleGenerationMessage(generation, message => ({
        ...message,
        sources: generation.sources,
      }))
    }
    scheduleAssistantDisplayFrame(generation.assistantMessageId)
  }, [scheduleAssistantDisplayFrame, updateVisibleGenerationMessage])

  const finalizeGeneration = useCallback((generation) => {
    if (!generation?.jobId) return Promise.resolve()
    if (finalizationPromiseRef.current?.jobId === generation.jobId) {
      return finalizationPromiseRef.current.promise
    }
    finalizingGenerationRef.current = generation.jobId

    const finalizationPromise = (async () => {
      try {
        const startedVisible = generation.sessionId === activeSessionIdRef.current
        const presentationWasCancelled = presentationCancellationRef.current?.jobId === generation.jobId

        if (generation.status === 'cancelled' || presentationWasCancelled) {
          stopAssistantDisplayQueue(true)
        } else if (generation.status === 'interrupted') {
          stopAssistantDisplayQueue(true)
          if (startedVisible) displayedAssistantContentRef.current = getGenerationContent(generation)
        } else if (startedVisible) {
          queueGenerationContent(generation)
          await drainAssistantBuffer()
        }

        const presentationCancellation = presentationCancellationRef.current?.jobId === generation.jobId
          ? presentationCancellationRef.current
          : null
        if (
          startedVisible
          && !presentationCancellation
          && generation.status === 'error'
          && !displayedAssistantContentRef.current
        ) {
          const remainingThinkingTime = streamRevealNotBeforeRef.current - Date.now()
          if (remainingThinkingTime > 0) {
            await new Promise(resolve => window.setTimeout(resolve, remainingThinkingTime))
          }
        }

        if (!mountedRef.current) return

        // Resolve the target session after every presentation await. The active
        // session may have changed while the typing queue was draining.
        const storedSession = sessionsRef.current.find(session => session.id === generation.sessionId)
        const effectiveGenerationStatus = presentationCancellation ? 'cancelled' : generation.status
        const terminalStatus = effectiveGenerationStatus === 'completed'
          ? 'done'
          : effectiveGenerationStatus
        const fullContent = getGenerationContent(generation)
        const storedAssistant = storedSession?.messages?.find(message => (
          message.id === generation.assistantMessageId && message.role === 'model'
        ))
        const finalContent = effectiveGenerationStatus === 'cancelled'
          ? (
              presentationCancellation?.content
              ?? generation.cancelledVisibleContent
              ?? storedAssistant?.content
              ?? ''
            )
          : fullContent

        if (storedSession) {
          let found = false
          let nextMessages = (storedSession.messages || []).map(message => {
            if (message.id !== generation.assistantMessageId || message.role !== 'model') return message
            found = true
            return {
              ...message,
              content: finalContent,
              status: terminalStatus,
              sources: Array.isArray(generation.sources) ? generation.sources : (message.sources || []),
              errorCode: generation.errorCode || null,
            }
          })

          if (
            !found
            && (
              finalContent
              || effectiveGenerationStatus === 'error'
              || effectiveGenerationStatus === 'interrupted'
            )
          ) {
            nextMessages = [
              ...nextMessages,
              {
                ...createAssistantMessage({
                  id: generation.assistantMessageId,
                  requestId: generation.requestId || generation.jobId,
                  userMessageId: generation.userMessageId,
                  startedAt: generation.startedAt || Date.now(),
                }),
                content: finalContent,
                status: terminalStatus,
                sources: Array.isArray(generation.sources) ? generation.sources : [],
                errorCode: generation.errorCode || null,
              },
            ]
          }

          if (effectiveGenerationStatus === 'cancelled' && !finalContent) {
            nextMessages = nextMessages.filter(message => message.id !== generation.assistantMessageId)
          }

          if (partialPersistTimerRef.current != null) {
            window.clearTimeout(partialPersistTimerRef.current)
            partialPersistTimerRef.current = null
          }
          if (generation.sessionId === activeSessionIdRef.current) {
            messagesRef.current = nextMessages
            setMessages(nextMessages)
          }
          await persistSessionMessages(generation.sessionId, nextMessages)
        }

        const acknowledgement = await sendRuntimeMessage({
          type: 'DONE_ACK',
          jobId: generation.jobId,
          finalRevision: generation.revision || 0,
        })
        if (acknowledgement?.ok !== true) {
          const error = new Error(acknowledgement.errorCode || 'generation_ack_failed')
          error.name = 'GenerationAcknowledgementError'
          throw error
        }

        let acknowledgementReplacement = null
        if (acknowledgement.removed === false) {
          const state = await sendRuntimeMessage({ type: 'GET_STATE' })
          if (!state || !Object.prototype.hasOwnProperty.call(state, 'activeGeneration')) {
            throw new Error('Generation state response was invalid after acknowledgement')
          }
          const authoritativeGeneration = state.activeGeneration
          if (
            authoritativeGeneration?.jobId === generation.jobId
            && TERMINAL_GENERATION_STATUSES.has(authoritativeGeneration.status)
          ) {
            const error = new Error('generation_ack_not_removed')
            error.name = 'GenerationAcknowledgementError'
            throw error
          }
          acknowledgementReplacement = authoritativeGeneration || null
        }

        const isVisibleAtCommit = generation.sessionId === activeSessionIdRef.current
        if (effectiveGenerationStatus === 'error' && isVisibleAtCommit) {
          toast.error(t(`chat.generation_errors.${generation.errorCode || 'generation_failed'}`, {
            defaultValue: t('chat.connection_error'),
          }))
        } else if (effectiveGenerationStatus === 'interrupted' && isVisibleAtCommit) {
          toast.error(t('chat.status.interrupted'))
        }

        if (finalizationRetryRef.current.jobId === generation.jobId) {
          if (finalizationRetryRef.current.timerId != null) {
            window.clearTimeout(finalizationRetryRef.current.timerId)
          }
          finalizationRetryRef.current = { jobId: null, attempts: 0, timerId: null }
        }

        const wasTrackingAcknowledgedGeneration = activeGenerationRef.current?.jobId === generation.jobId
        if (wasTrackingAcknowledgedGeneration) {
          activeGenerationRef.current = null
          lastGenerationRevisionRef.current = 0
          streamTargetMessageIdRef.current = null
          stopAssistantDisplayQueue(true)
        }
        cancelRequestedJobIdsRef.current.delete(generation.jobId)
        if (presentationCancellationRef.current?.jobId === generation.jobId) {
          presentationCancellationRef.current = null
        }
        if (acknowledgementReplacement?.jobId) {
          generationStateHandlerRef.current(acknowledgementReplacement)
        } else if (wasTrackingAcknowledgedGeneration) {
          setGenerating(false)
        }
      } catch (error) {
        console.error('Generation finalization failed', error)
        if (!mountedRef.current || activeGenerationRef.current?.jobId !== generation.jobId) return

        const previousRetry = finalizationRetryRef.current
        const attempts = previousRetry.jobId === generation.jobId
          ? previousRetry.attempts + 1
          : 1
        const retryDelay = FINALIZATION_RETRY_DELAYS_MS[attempts - 1]

        if (retryDelay == null) {
          finalizationRetryRef.current = {
            jobId: generation.jobId,
            attempts,
            timerId: null,
          }
          setGenerating(false)
          toast.error(t('chat.connection_error'))
          return
        }

        setGenerating(true)
        const timerId = window.setTimeout(async () => {
          if (finalizationRetryRef.current.jobId !== generation.jobId) return
          finalizationRetryRef.current = {
            ...finalizationRetryRef.current,
            timerId: null,
          }
          if (!mountedRef.current || activeGenerationRef.current?.jobId !== generation.jobId) return

          let retryGeneration = activeGenerationRef.current
          try {
            const state = await sendRuntimeMessage({ type: 'GET_STATE' })
            if (state && Object.prototype.hasOwnProperty.call(state, 'activeGeneration')) {
              const authoritativeGeneration = state.activeGeneration
              if (!authoritativeGeneration) {
                finalizationRetryRef.current = { jobId: null, attempts: 0, timerId: null }
                activeGenerationRef.current = null
                lastGenerationRevisionRef.current = 0
                streamTargetMessageIdRef.current = null
                presentationCancellationRef.current = null
                cancelRequestedJobIdsRef.current.delete(generation.jobId)
                stopAssistantDisplayQueue(true)
                setGenerating(false)
                return
              }

              if (authoritativeGeneration.jobId !== generation.jobId) {
                finalizationRetryRef.current = { jobId: null, attempts: 0, timerId: null }
                activeGenerationRef.current = null
                lastGenerationRevisionRef.current = 0
                streamTargetMessageIdRef.current = null
                presentationCancellationRef.current = null
                cancelRequestedJobIdsRef.current.delete(generation.jobId)
                stopAssistantDisplayQueue(true)
                generationStateHandlerRef.current(authoritativeGeneration)
                return
              }

              retryGeneration = {
                ...retryGeneration,
                ...authoritativeGeneration,
              }
              activeGenerationRef.current = retryGeneration
              lastGenerationRevisionRef.current = Math.max(
                lastGenerationRevisionRef.current,
                Number(authoritativeGeneration.revision || 0),
              )
            }
          } catch (reconciliationError) {
            console.error('Generation finalization reconciliation failed', reconciliationError)
          }

          if (activeGenerationRef.current?.jobId === generation.jobId) {
            void finalizeGenerationHandlerRef.current(retryGeneration)
          }
        }, retryDelay)
        finalizationRetryRef.current = {
          jobId: generation.jobId,
          attempts,
          timerId,
        }
      } finally {
        if (finalizingGenerationRef.current === generation.jobId) {
          finalizingGenerationRef.current = null
        }
        if (finalizationPromiseRef.current?.jobId === generation.jobId) {
          finalizationPromiseRef.current = null
        }
      }
    })()

    finalizationPromiseRef.current = {
      jobId: generation.jobId,
      promise: finalizationPromise,
    }
    return finalizationPromise
  }, [drainAssistantBuffer, persistSessionMessages, queueGenerationContent, setGenerating, stopAssistantDisplayQueue, t])

  finalizeGenerationHandlerRef.current = finalizeGeneration

  const handleGenerationState = useCallback((incomingGeneration) => {
    if (!incomingGeneration?.jobId) return
    const currentGeneration = activeGenerationRef.current
    if (currentGeneration?.jobId && currentGeneration.jobId !== incomingGeneration.jobId) return

    const incomingRevision = Number(incomingGeneration.revision || 0)
    const isTerminal = TERMINAL_GENERATION_STATUSES.has(incomingGeneration.status)
    const isTerminalTransition = isTerminal && !TERMINAL_GENERATION_STATUSES.has(currentGeneration?.status)
    const isForwardStatusTransition = (
      currentGeneration?.status === 'queued'
      && incomingGeneration.status === 'running'
    )
    if (
      currentGeneration
      && (
        incomingRevision < lastGenerationRevisionRef.current
        || (
          incomingRevision === lastGenerationRevisionRef.current
          && !isTerminalTransition
          && !isForwardStatusTransition
        )
      )
    ) {
      return
    }

    const generation = { ...currentGeneration, ...incomingGeneration }
    activeGenerationRef.current = generation
    lastGenerationRevisionRef.current = Math.max(lastGenerationRevisionRef.current, incomingRevision)
    setGenerating(true)

    if (
      generation.sessionId === activeSessionIdRef.current
      && streamTargetMessageIdRef.current !== generation.assistantMessageId
    ) {
      prepareGenerationPresentation(generation)
    }

    if (generation.sessionId === activeSessionIdRef.current) {
      queueGenerationContent(generation)
    }

    if (isTerminal) finalizeGeneration(generation)
  }, [finalizeGeneration, prepareGenerationPresentation, queueGenerationContent, setGenerating])

  generationStateHandlerRef.current = handleGenerationState

  useEffect(() => {
    const markPanelHidden = () => {
      panelVisibleRef.current = false
      streamLastDisplayAtRef.current = 0
      void flushVisibleSessionRef.current(true)
      if (streamDisplayFrameRef.current != null) {
        cancelDisplayFrame(streamDisplayFrameRef.current)
        streamDisplayFrameRef.current = null
      }
    }

    const markPanelVisible = () => {
      if (document.visibilityState === 'hidden') return
      const wasVisible = panelVisibleRef.current
      panelVisibleRef.current = true
      if (!wasVisible) {
        const now = Date.now()
        streamLastDisplayAtRef.current = now
        if (streamTargetMessageIdRef.current != null && !displayedAssistantContentRef.current) {
          streamRevealNotBeforeRef.current = now + MIN_THINKING_VISIBLE_MS
        }
      }
      scheduleAssistantDisplayFrame()
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        markPanelHidden()
      } else {
        markPanelVisible()
      }
    }

    panelVisibleRef.current = document.visibilityState !== 'hidden'
    document.addEventListener('visibilitychange', handleVisibilityChange)
    document.addEventListener('freeze', markPanelHidden)
    document.addEventListener('resume', markPanelVisible)
    window.addEventListener('pagehide', markPanelHidden)
    window.addEventListener('pageshow', markPanelVisible)
    window.addEventListener('focus', markPanelVisible)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      document.removeEventListener('freeze', markPanelHidden)
      document.removeEventListener('resume', markPanelVisible)
      window.removeEventListener('pagehide', markPanelHidden)
      window.removeEventListener('pageshow', markPanelVisible)
      window.removeEventListener('focus', markPanelVisible)
    }
  }, [scheduleAssistantDisplayFrame])

  useEffect(() => () => {
    mountedRef.current = false
    void flushVisibleSessionRef.current(true)
    if (partialPersistTimerRef.current != null) {
      window.clearTimeout(partialPersistTimerRef.current)
      partialPersistTimerRef.current = null
    }
    if (finalizationRetryRef.current.timerId != null) {
      window.clearTimeout(finalizationRetryRef.current.timerId)
      finalizationRetryRef.current = { jobId: null, attempts: 0, timerId: null }
    }
    stopAssistantDisplayQueue(true)
  }, [stopAssistantDisplayQueue])

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return undefined
    const listener = (message) => {
      if (message?.type === 'ACTIVE_GEN_CHANGED') {
        handleGenerationState(message.snapshot || message.activeGeneration)
      } else if (message?.type === 'DONE' || message?.type === 'CANCEL_DONE') {
        handleGenerationState(message.activeGeneration || message.generation || message)
      } else if (message?.type === 'START_REJECTED') {
        toast.error(t(`chat.generation_errors.${message.errorCode || 'already_running'}`, {
          defaultValue: t('chat.connection_error'),
        }))
      }
      return false
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [handleGenerationState, t])

  const captureScreenshot = useCallback(async (coords) => {
    if (!coords) return null;
    const { x, y, width, height, pixelRatio, viewportWidth, viewportHeight } = coords;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const img = new Image();
    img.src = dataUrl;
    await new Promise(res => img.onload = res);

    const scaleX = viewportWidth ? img.naturalWidth / viewportWidth : pixelRatio;
    const scaleY = viewportHeight ? img.naturalHeight / viewportHeight : pixelRatio;
    const sourceX = Math.max(0, Math.round(x * scaleX));
    const sourceY = Math.max(0, Math.round(y * scaleY));
    const sourceWidth = Math.min(img.naturalWidth - sourceX, Math.round(width * scaleX));
    const sourceHeight = Math.min(img.naturalHeight - sourceY, Math.round(height * scaleY));

    const canvas = document.createElement('canvas');
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    const ctx = canvas.getContext('2d');

    ctx.drawImage(img, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    const croppedDataUrl = canvas.toDataURL('image/png');
    const base64Data = croppedDataUrl.split(',')[1];

    return {
      name: `screenshot-${Date.now()}.png`,
      mimeType: 'image/png',
      data: base64Data
    };
  }, [])

  const clearCropSelectionState = useCallback((requestId = null) => {
    const activeCrop = cropTargetRef.current
    if (requestId && activeCrop?.requestId !== requestId) return false
    cropTargetRef.current = null
    setIsCropActive(false)
    setActiveMode(previous => (previous === 'crop' ? null : previous))
    return true
  }, [])

  useEffect(() => {
    const listener = (msg) => {
      if (msg.type === 'HERAAI_CROP_CANCELLED') {
        clearCropSelectionState(msg.requestId || null)
        return false
      }
      if (msg.type === 'HERAAI_CROP_DONE' && !cropProcessingRef.current) {
        if (!clearCropSelectionState(msg.requestId || null)) return false
        cropProcessingRef.current = true;
        void (async () => {
          try {
            setGenerating(true);
            const attachment = await captureScreenshot(msg.coords);
            if (attachment) {
              setAttachments(prev => [...prev, attachment]);
            }
          } catch (err) {
            console.error("Screenshot error", err);
            toast.error(t('chat.file_error'))
          } finally {
            setGenerating(Boolean(activeGenerationRef.current?.jobId));
            cropProcessingRef.current = false;
          }
        })()
      }
      return false
    };
    if (chrome && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(listener);
    }
    return () => {
      if (chrome && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.removeListener(listener);
      }
    }
  }, [captureScreenshot, clearCropSelectionState, setGenerating, t])

  useEffect(() => () => {
    const activeCrop = cropTargetRef.current
    cropTargetRef.current = null
    if (!activeCrop?.tabId || typeof chrome === 'undefined' || !chrome.scripting?.executeScript) return
    try {
      const cancellation = chrome.scripting.executeScript({
        target: { tabId: activeCrop.tabId },
        func: cancelCropOverlay,
        args: [activeCrop.requestId],
      })
      cancellation?.catch?.(() => undefined)
    } catch (_error) {
      // The tab may have closed while the side panel was shutting down.
    }
  }, [])

  useEffect(() => {
    if (prevIsGeneratingRef.current && !isGenerating && activeMode && activeMode !== 'web') {
      setActiveMode(null);
    }
    prevIsGeneratingRef.current = isGenerating;
  }, [isGenerating, activeMode])

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      const translate = i18n.getFixedT(i18n.resolvedLanguage || i18n.language || 'tr')
      const id = Date.now().toString()
      const welcomeMessages = [{ id: createUniqueMessageId(msgIdCounter), role: 'model', content: translate('chat.welcome') }]
      activeSessionIdRef.current = id
      sessionsRef.current = [createSession({
        id,
        title: translate('chat.new_chat'),
        messages: welcomeMessages,
      })]
      messagesRef.current = welcomeMessages
      setActiveSessionId(id)
      setSessions(sessionsRef.current)
      setMessages(welcomeMessages)
      setIsLoading(false)
      return undefined
    }

    let disposed = false
    let initializationComplete = false
    let pendingGenerationChange
    let hasPendingGenerationChange = false
    let pendingSessionsChange
    let hasPendingSessionsChange = false
    let pendingActiveSessionIdChange
    let hasPendingActiveSessionIdChange = false
    let bootstrapStateRetryTimerId = null

    const clearBootstrapGeneration = (expectedJobId) => {
      if (activeGenerationRef.current?.jobId !== expectedJobId) return
      activeGenerationRef.current = null
      lastGenerationRevisionRef.current = 0
      streamTargetMessageIdRef.current = null
      presentationCancellationRef.current = null
      cancelRequestedJobIdsRef.current.delete(expectedJobId)
      stopAssistantDisplayQueue(true)
      setGenerating(false)
    }

    const applyBootstrapStateReconciliation = async (expectedJobId, authoritativeGeneration) => {
      if (disposed) return
      const trackedGeneration = activeGenerationRef.current
      if (trackedGeneration?.jobId && trackedGeneration.jobId !== expectedJobId) return

      if (!authoritativeGeneration) {
        clearBootstrapGeneration(expectedJobId)
        await persistAuthoritativeSessionRepair(null)
        return
      }

      if (authoritativeGeneration.jobId !== expectedJobId) {
        clearBootstrapGeneration(expectedJobId)
        await persistAuthoritativeSessionRepair(authoritativeGeneration)
        if (disposed) return
      }

      generationStateHandlerRef.current(authoritativeGeneration)
    }

    const scheduleBootstrapStateReconciliation = (expectedJobId, attempt = 0) => {
      const retryDelay = BOOTSTRAP_STATE_RETRY_DELAYS_MS[attempt]
      if (disposed || retryDelay == null) return

      bootstrapStateRetryTimerId = window.setTimeout(async () => {
        bootstrapStateRetryTimerId = null
        if (disposed || activeGenerationRef.current?.jobId !== expectedJobId) return

        try {
          const state = await sendRuntimeMessageWithTimeout(
            { type: 'GET_STATE' },
            BOOTSTRAP_STATE_TIMEOUT_MS,
          )
          if (!state || !Object.prototype.hasOwnProperty.call(state, 'activeGeneration')) {
            throw new Error('Generation state response was invalid during bootstrap retry')
          }
          await applyBootstrapStateReconciliation(expectedJobId, state.activeGeneration)
        } catch (error) {
          console.error('Generation state retry failed', error)
          scheduleBootstrapStateReconciliation(expectedJobId, attempt + 1)
        }
      }, retryDelay)
    }

    const initialize = async () => {
      let result = {}
      try {
        result = await chrome.storage.local.get([
          'theme',
          'startupBehavior',
          'systemInstruction',
          'chatHistory',
          'sessions',
          'activeSessionId',
          'activeGeneration',
          'customPrimaryColor',
          'language',
          'selectedText',
          'selectedModel',
        ])
      } catch (error) {
        console.error('Chrome storage initialization failed', error)
      }
      if (disposed) return

      const config = {
        theme: result.theme || 'system',
        startupBehavior: result.startupBehavior || 'resume',
        systemInstruction: result.systemInstruction || '',
        customPrimaryColor: result.customPrimaryColor || '#7c5cff',
        language: result.language || i18n.resolvedLanguage || i18n.language || 'tr',
      }
      const currentLanguage = i18n.resolvedLanguage || i18n.language
      if (currentLanguage !== config.language) {
        try {
          await i18n.changeLanguage(config.language)
        } catch (error) {
          console.error('Language initialization failed', error)
        }
        if (disposed) return
      }
      const translate = i18n.getFixedT(config.language)
      setAppConfig(config)
      applyTheme(config.theme, config.customPrimaryColor)
      const resolvedSelectedModel = result.selectedModel && MODELS.includes(result.selectedModel)
        ? result.selectedModel
        : DEFAULT_MODEL
      setSelectedModel(resolvedSelectedModel)
      if (result.selectedModel && result.selectedModel !== resolvedSelectedModel) {
        try {
          await chrome.storage.local.set({ selectedModel: resolvedSelectedModel })
        } catch (error) {
          console.error('Invalid stored model cleanup failed', error)
        }
      }

      const welcomeMessages = [{ id: createUniqueMessageId(msgIdCounter), role: 'model', content: translate('chat.welcome') }]
      // Do not repair transient assistant states until GET_STATE has supplied the
      // authoritative generation. A stale storage snapshot can otherwise preserve
      // an orphaned "thinking" message, or remove the placeholder for a newer job.
      const storedSessions = Array.isArray(result.sessions) ? result.sessions : []
      storedSessions.forEach(session => {
        if (session?.id) persistedSessionIdsRef.current.add(session.id)
      })
      let nextSessions = storedSessions.map(normalizeSessionMetadata)
      let nextActiveSessionId = null
      let nextMessages = welcomeMessages
      let shouldPersistSessions = false

      if (nextSessions.length > 0) {
        if (config.startupBehavior === 'resume') {
          const requestedId = result.activeSessionId || nextSessions[0].id
          const currentSession = nextSessions.find(session => session.id === requestedId) || nextSessions[0]
          nextActiveSessionId = currentSession.id
          nextMessages = currentSession.messages || welcomeMessages
        } else {
          nextActiveSessionId = Date.now().toString()
          const newSession = createSession({
            id: nextActiveSessionId,
            title: translate('chat.new_chat'),
            messages: welcomeMessages,
          })
          nextSessions = [...nextSessions, newSession]
          shouldPersistSessions = true
        }
      } else if (Array.isArray(result.chatHistory) && result.chatHistory.length > 1) {
        const repairedHistory = repairMessageIds(result.chatHistory, msgIdCounter).messages
        const historyId = Date.now().toString()
        const historySession = createSession({
          id: historyId,
          title: translate('chat.history_title'),
          messages: repairedHistory,
        })
        if (config.startupBehavior === 'resume') {
          nextActiveSessionId = historyId
          nextSessions = [historySession]
          nextMessages = repairedHistory
        } else {
          nextActiveSessionId = `${Date.now()}1`
          const welcomeSession = createSession({
            id: nextActiveSessionId,
            title: translate('chat.new_chat'),
            messages: welcomeMessages,
          })
          nextSessions = [historySession, welcomeSession]
        }
        shouldPersistSessions = true
      } else {
        nextActiveSessionId = Date.now().toString()
        nextSessions = [createSession({
          id: nextActiveSessionId,
          title: translate('chat.new_chat'),
          messages: welcomeMessages,
        })]
        shouldPersistSessions = true
      }

      if (result.selectedText) {
        setInput(previous => appendToInputValue(previous, result.selectedText))
        void chrome.storage.local.remove(['selectedText'])
      }

      let generation = result.activeGeneration || null
      let generationStateReconciliationFailed = false
      try {
        const state = await sendRuntimeMessageWithTimeout(
          { type: 'GET_STATE' },
          BOOTSTRAP_STATE_TIMEOUT_MS,
        )
        if (!state || !Object.prototype.hasOwnProperty.call(state, 'activeGeneration')) {
          throw new Error('Generation state response was invalid during bootstrap')
        }
        generation = state.activeGeneration
      } catch (error) {
        console.error('Generation state reconciliation failed', error)
        generationStateReconciliationFailed = true
      }
      if (disposed) return

      if (hasPendingGenerationChange) {
        if (!pendingGenerationChange) {
          generation = null
        } else if (
          !generation
          || pendingGenerationChange.jobId !== generation.jobId
          || Number(pendingGenerationChange.revision || 0) >= Number(generation.revision || 0)
        ) {
          generation = pendingGenerationChange
        }
      }

      // A START claim writes sessions, activeSessionId, and activeGeneration in
      // one storage transaction. If that transaction lands while the initial
      // read is pending, adopt all three fields together so finalization can
      // always resolve the generation's session.
      if (hasPendingSessionsChange) {
        nextSessions = Array.isArray(pendingSessionsChange)
          ? pendingSessionsChange.map(normalizeSessionMetadata)
          : []
        nextSessions.forEach(session => {
          if (session?.id) persistedSessionIdsRef.current.add(session.id)
        })
      }
      if (hasPendingActiveSessionIdChange) {
        nextActiveSessionId = pendingActiveSessionIdChange || null
      }

      const authoritativeSessionRepair = repairStoredSessions(
        nextSessions,
        msgIdCounter,
        generation,
        translate('chat.new_chat'),
      )
      nextSessions = authoritativeSessionRepair.sessions
      shouldPersistSessions = shouldPersistSessions || authoritativeSessionRepair.changed

      const repairedActiveSession = (
        nextSessions.find(session => session.id === nextActiveSessionId)
        || nextSessions[0]
      )
      if (repairedActiveSession) {
        nextActiveSessionId = repairedActiveSession.id
        nextMessages = repairedActiveSession.messages || welcomeMessages
      }

      activeSessionIdRef.current = nextActiveSessionId
      sessionsRef.current = nextSessions
      messagesRef.current = nextMessages
      setActiveSessionId(nextActiveSessionId)
      setSessions(nextSessions)
      setMessages(nextMessages)

      if (shouldPersistSessions) {
        void enqueueStorageWrite({ sessions: nextSessions, activeSessionId: nextActiveSessionId })
      }

      activeGenerationRef.current = null
      lastGenerationRevisionRef.current = 0
      initializationComplete = true
      if (generation?.jobId) {
        generationStateHandlerRef.current(generation)
      } else {
        setGenerating(false)
      }
      setIsLoading(false)
      if (
        generationStateReconciliationFailed
        && generation?.jobId
        && ACTIVE_GENERATION_STATUSES.has(generation.status)
      ) {
        scheduleBootstrapStateReconciliation(generation.jobId)
      }
    }

    const storageListener = (changes, namespace) => {
      if (namespace !== 'local') return
      if (changes.selectedText?.newValue) {
        setInput(previous => appendToInputValue(previous, changes.selectedText.newValue))
        void chrome.storage.local.remove(['selectedText'])
      }
      if (!initializationComplete) {
        if (changes.sessions) {
          pendingSessionsChange = changes.sessions.newValue
          hasPendingSessionsChange = true
        }
        if (changes.activeSessionId) {
          pendingActiveSessionIdChange = changes.activeSessionId.newValue
          hasPendingActiveSessionIdChange = true
        }
        if (changes.activeGeneration) {
          pendingGenerationChange = changes.activeGeneration.newValue || null
          hasPendingGenerationChange = true
        }
        return
      }
      if (changes.sessions && Array.isArray(changes.sessions.newValue)) {
        changes.sessions.newValue.forEach(session => {
          if (session?.id) persistedSessionIdsRef.current.add(session.id)
        })
        const storedById = new Map(
          changes.sessions.newValue
            .filter(session => session?.id)
            .map(session => [session.id, normalizeSessionMetadata(session)])
        )
        let metadataChanged = false
        const metadataSyncedSessions = sessionsRef.current.map(session => {
          const storedSession = storedById.get(session?.id)
          if (!storedSession) return session
          const storedTitle = typeof storedSession.title === 'string' && storedSession.title.trim()
            ? storedSession.title
            : session.title
          const isTitleCustom = storedSession.isTitleCustom === true
          const isStarred = storedSession.isStarred === true
          if (
            storedTitle === session.title
            && isTitleCustom === (session.isTitleCustom === true)
            && isStarred === (session.isStarred === true)
          ) {
            return session
          }
          metadataChanged = true
          return {
            ...session,
            title: storedTitle,
            isTitleCustom,
            isStarred,
          }
        })
        if (metadataChanged) {
          sessionsRef.current = metadataSyncedSessions
          setSessions(metadataSyncedSessions)
        }
      }
      if (changes.activeGeneration) {
        const nextGeneration = changes.activeGeneration.newValue || null
        if (nextGeneration) {
          const generationSessionMissing = !sessionsRef.current.some(session => (
            session.id === nextGeneration.sessionId
          ))
          const changedSessions = changes.sessions?.newValue
          const changedGenerationSession = generationSessionMissing && Array.isArray(changedSessions)
            ? changedSessions.find(session => session?.id === nextGeneration.sessionId)
            : null
          if (changedGenerationSession) {
            const nextSessions = [
              ...sessionsRef.current.filter(session => session.id !== nextGeneration.sessionId),
              changedGenerationSession,
            ]
            sessionsRef.current = nextSessions
            setSessions(nextSessions)

            if (changes.activeSessionId?.newValue === nextGeneration.sessionId) {
              activeSessionIdRef.current = nextGeneration.sessionId
              messagesRef.current = changedGenerationSession.messages || []
              setActiveSessionId(nextGeneration.sessionId)
              setMessages(messagesRef.current)
            }
          }
          generationStateHandlerRef.current(nextGeneration)
          return
        }

        const trackedGeneration = activeGenerationRef.current
        if (trackedGeneration && finalizingGenerationRef.current !== trackedGeneration.jobId) {
          if (finalizationRetryRef.current.timerId != null) {
            window.clearTimeout(finalizationRetryRef.current.timerId)
          }
          finalizationRetryRef.current = { jobId: null, attempts: 0, timerId: null }
          activeGenerationRef.current = null
          lastGenerationRevisionRef.current = 0
          streamTargetMessageIdRef.current = null
          presentationCancellationRef.current = null
          cancelRequestedJobIdsRef.current.delete(trackedGeneration.jobId)
          stopAssistantDisplayQueue(true)
          setGenerating(false)
          void persistAuthoritativeSessionRepair(null)
        }
      }
    }
    chrome.storage.onChanged.addListener(storageListener)
    void initialize()

    return () => {
      disposed = true
      if (bootstrapStateRetryTimerId != null) {
        window.clearTimeout(bootstrapStateRetryTimerId)
      }
      chrome.storage.onChanged.removeListener(storageListener)
    }
  }, [applyTheme, enqueueStorageWrite, persistAuthoritativeSessionRepair, setGenerating, stopAssistantDisplayQueue])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return

    if (forceScrollToBottomRef.current || autoScrollRef.current) {
      scheduleScrollToBottom()
      return
    }

    setShowScrollDownBtn(true)
  }, [messages, scheduleScrollToBottom])

  const cancelActiveGeneration = useCallback((reason = 'user') => {
    const generation = activeGenerationRef.current
    if (!generation?.jobId) {
      return Promise.resolve()
    }

    if (
      TERMINAL_GENERATION_STATUSES.has(generation.status)
      && finalizationRetryRef.current.jobId === generation.jobId
      && finalizationRetryRef.current.timerId != null
    ) {
      setGenerating(true)
      return Promise.resolve()
    }

    if (
      TERMINAL_GENERATION_STATUSES.has(generation.status)
      && finalizationPromiseRef.current?.jobId !== generation.jobId
      && finalizationRetryRef.current.jobId === generation.jobId
      && finalizationRetryRef.current.attempts > FINALIZATION_RETRY_DELAYS_MS.length
    ) {
      finalizationRetryRef.current = { jobId: null, attempts: 0, timerId: null }
    }

    if (
      generation.status === 'completed'
      && (
        finalizingGenerationRef.current === generation.jobId
        || finalizationPromiseRef.current?.jobId === generation.jobId
      )
    ) {
      if (presentationCancellationRef.current?.jobId !== generation.jobId) {
        const visibleContent = generation.sessionId === activeSessionIdRef.current
          ? displayedAssistantContentRef.current
          : getGenerationContent(generation)
        presentationCancellationRef.current = {
          jobId: generation.jobId,
          content: visibleContent,
        }
        stopAssistantDisplayQueue(true)
        if (generation.sessionId === activeSessionIdRef.current) {
          const nextMessages = updateVisibleGenerationMessage(generation, message => ({
            ...message,
            content: visibleContent,
            status: visibleContent ? 'cancelled' : 'cancelled_empty',
          }))
          if (nextMessages?.length) void persistSessionMessages(generation.sessionId, nextMessages)
        }
      }
      setGenerating(true)
      return finalizationPromiseRef.current?.jobId === generation.jobId
        ? finalizationPromiseRef.current.promise
        : finalizeGeneration(generation)
    }

    if (TERMINAL_GENERATION_STATUSES.has(generation.status)) {
      setGenerating(true)
      return finalizationPromiseRef.current?.jobId === generation.jobId
        ? finalizationPromiseRef.current.promise
        : finalizeGeneration(generation)
    }

    if (!ACTIVE_GENERATION_STATUSES.has(generation.status)) return Promise.resolve()
    if (cancellationPromiseRef.current?.jobId === generation.jobId) {
      return cancellationPromiseRef.current.promise
    }
    cancelRequestedJobIdsRef.current.add(generation.jobId)

    const visibleContent = generation.sessionId === activeSessionIdRef.current
      ? displayedAssistantContentRef.current
      : getGenerationContent(generation)
    activeGenerationRef.current = {
      ...generation,
      cancelledVisibleContent: visibleContent,
    }
    stopAssistantDisplayQueue(true)

    if (generation.sessionId === activeSessionIdRef.current) {
      const nextMessages = updateVisibleGenerationMessage(generation, message => ({
        ...message,
        content: visibleContent,
        status: visibleContent ? 'cancelled' : 'cancelled_empty',
      }))
      if (nextMessages?.length) void persistSessionMessages(generation.sessionId, nextMessages)
    }
    setGenerating(true)

    const clearTrackedGeneration = () => {
      if (activeGenerationRef.current?.jobId !== generation.jobId) return
      activeGenerationRef.current = null
      lastGenerationRevisionRef.current = 0
      streamTargetMessageIdRef.current = null
      presentationCancellationRef.current = null
      cancelRequestedJobIdsRef.current.delete(generation.jobId)
      stopAssistantDisplayQueue(true)
      setGenerating(false)
    }

    const applyAuthoritativeSnapshot = (snapshot) => {
      if (!snapshot) {
        clearTrackedGeneration()
        return 'cleared'
      }

      if (snapshot.jobId !== generation.jobId) {
        clearTrackedGeneration()
        handleGenerationState(snapshot)
        return TERMINAL_GENERATION_STATUSES.has(snapshot.status) ? 'terminal' : 'active'
      }

      if (TERMINAL_GENERATION_STATUSES.has(snapshot.status)) {
        handleGenerationState(snapshot)
        return 'terminal'
      }

      const reconciledGeneration = {
        ...activeGenerationRef.current,
        ...snapshot,
      }
      cancelRequestedJobIdsRef.current.delete(generation.jobId)
      activeGenerationRef.current = reconciledGeneration
      lastGenerationRevisionRef.current = Math.max(
        lastGenerationRevisionRef.current,
        Number(snapshot.revision || 0),
      )
      setGenerating(true)
      if (reconciledGeneration.sessionId === activeSessionIdRef.current) {
        prepareGenerationPresentation(reconciledGeneration)
        queueGenerationContent(reconciledGeneration)
      }
      return 'active'
    }

    const reconcileWithWorker = async () => {
      const state = await sendRuntimeMessage({ type: 'GET_STATE' })
      if (!state || !Object.prototype.hasOwnProperty.call(state, 'activeGeneration')) {
        throw new Error('Generation state response was invalid')
      }
      return applyAuthoritativeSnapshot(state.activeGeneration)
    }

    const cancellationPromise = (async () => {
      try {
        const response = await sendRuntimeMessage({
          type: 'CANCEL',
          jobId: generation.jobId,
          reason,
        })
        const responseGeneration = response?.activeGeneration
        let result
        if (
          responseGeneration?.jobId === generation.jobId
          && TERMINAL_GENERATION_STATUSES.has(responseGeneration.status)
        ) {
          result = applyAuthoritativeSnapshot(responseGeneration)
        } else {
          result = await reconcileWithWorker()
        }

        if (result === 'terminal' && finalizationPromiseRef.current?.jobId === generation.jobId) {
          await finalizationPromiseRef.current.promise
        }
      } catch (error) {
        console.error('Generation cancellation failed', error)
        try {
          const result = await reconcileWithWorker()
          if (result === 'terminal' && finalizationPromiseRef.current?.jobId === generation.jobId) {
            await finalizationPromiseRef.current.promise
          }
        } catch (reconciliationError) {
          console.error('Generation cancellation reconciliation failed', reconciliationError)
          if (mountedRef.current && activeGenerationRef.current?.jobId === generation.jobId) {
            setGenerating(true)
            toast.error(t('chat.connection_error'))
          }
        }
      } finally {
        if (cancellationPromiseRef.current?.jobId === generation.jobId) {
          cancellationPromiseRef.current = null
        }
      }
    })()

    cancellationPromiseRef.current = {
      jobId: generation.jobId,
      promise: cancellationPromise,
    }
    return cancellationPromise
  }, [finalizeGeneration, handleGenerationState, persistSessionMessages, prepareGenerationPresentation, queueGenerationContent, setGenerating, stopAssistantDisplayQueue, t, updateVisibleGenerationMessage])

  const startNewSession = useCallback(() => {
    void cancelActiveGeneration('new_chat')
    stopAssistantDisplayQueue(true)
    setGenerating(Boolean(activeGenerationRef.current?.jobId))
    streamTargetMessageIdRef.current = null

    const id = Date.now().toString()
    const welcomeMsg = [{ id: createUniqueMessageId(msgIdCounter), role: 'model', content: t('chat.welcome') }]
    const nextSessions = [
      ...sessionsRef.current,
      createSession({ id, title: t('chat.new_chat'), messages: welcomeMsg }),
    ]
    activeSessionIdRef.current = id
    sessionsRef.current = nextSessions
    messagesRef.current = welcomeMsg
    setActiveSessionId(id)
    setSessions(nextSessions)
    setMessages(welcomeMsg)
    void enqueueStorageWrite({ sessions: nextSessions, activeSessionId: id })
    setShowBulkDeleteConfirm(false)
    setShowHistory(false)
    stickToBottomOnNextRender()
  }, [cancelActiveGeneration, enqueueStorageWrite, setGenerating, stickToBottomOnNextRender, stopAssistantDisplayQueue, t])

  const loadSession = useCallback((id) => {
    const generation = activeGenerationRef.current
    const isSwitchingSession = activeSessionIdRef.current !== id
    if (generation && generation.sessionId !== id) {
      void cancelActiveGeneration('session_switch')
    }
    if (isSwitchingSession) stopAssistantDisplayQueue(true)
    setGenerating(Boolean(activeGenerationRef.current?.jobId))
    if (isSwitchingSession) streamTargetMessageIdRef.current = null

    const session = sessionsRef.current.find(item => item.id === id)
    if (session) {
      activeSessionIdRef.current = id
      messagesRef.current = session.messages || []
      setActiveSessionId(id)
      setMessages(messagesRef.current)
      stickToBottomOnNextRender()
      void enqueueStorageWrite({ activeSessionId: id })
      if (
        isSwitchingSession
        && generation?.sessionId === id
        && ACTIVE_GENERATION_STATUSES.has(generation.status)
      ) {
        setGenerating(true)
        prepareGenerationPresentation(generation)
        queueGenerationContent(generation)
      }
    }
    setShowBulkDeleteConfirm(false)
    setShowHistory(false)
  }, [cancelActiveGeneration, enqueueStorageWrite, prepareGenerationPresentation, queueGenerationContent, setGenerating, stickToBottomOnNextRender, stopAssistantDisplayQueue])

  const deleteSession = useCallback(async (id) => {
    try {
      if (activeGenerationRef.current?.sessionId === id) {
        await cancelActiveGeneration('session_deleted')
        if (activeGenerationRef.current?.jobId) {
          toast.error(t('chat.bulk_delete.cancel_failed', {
            defaultValue: 'The response could not be stopped, so the chat was not deleted.',
          }))
          return
        }
      }

      const write = async () => {
        let sourceSessions = sessionsRef.current
        if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
          const stored = await chrome.storage.local.get(['sessions'])
          if (Array.isArray(stored?.sessions)) sourceSessions = stored.sessions
        }

        const remainingSessions = sourceSessions
          .filter(session => session?.id !== id)
          .map(normalizeSessionMetadata)
        if (remainingSessions.length === sourceSessions.length) return null

        const wasActiveSession = activeSessionIdRef.current === id
        let nextSessions = remainingSessions
        let nextActiveSessionId = activeSessionIdRef.current
        let nextMessages = messagesRef.current

        if (wasActiveSession) {
          if (remainingSessions.length > 0) {
            const nextSession = remainingSessions[0]
            nextActiveSessionId = nextSession.id
            nextMessages = nextSession.messages || []
          } else {
            const newId = Date.now().toString()
            const welcomeMsg = [{ id: createUniqueMessageId(msgIdCounter), role: 'model', content: t('chat.welcome') }]
            const newSession = createSession({ id: newId, title: t('chat.new_chat'), messages: welcomeMsg })
            nextSessions = [newSession]
            nextActiveSessionId = newId
            nextMessages = welcomeMsg
          }
        }

        await setChromeStorage({ sessions: nextSessions, activeSessionId: nextActiveSessionId })
        nextSessions.forEach(session => {
          if (session?.id) persistedSessionIdsRef.current.add(session.id)
        })
        return { nextSessions, nextActiveSessionId, nextMessages, wasActiveSession }
      }

      const queuedWrite = storageWriteQueueRef.current
        .catch(() => undefined)
        .then(write)
      storageWriteQueueRef.current = queuedWrite.catch(error => {
        console.error('Chrome session deletion failed', error)
      })
      const result = await trackStructuralStorageWrite(queuedWrite)
      if (!result) return

      const remainingSessionIds = new Set(result.nextSessions.map(session => session?.id))
      pendingSessionMetadataRef.current.forEach((_pendingMetadata, pendingSessionId) => {
        if (!remainingSessionIds.has(pendingSessionId)) {
          pendingSessionMetadataRef.current.delete(pendingSessionId)
        }
      })
      sessionsRef.current = result.nextSessions
      activeSessionIdRef.current = result.nextActiveSessionId
      setSessions(result.nextSessions)
      setActiveSessionId(result.nextActiveSessionId)
      if (result.wasActiveSession) {
        messagesRef.current = result.nextMessages
        setMessages(result.nextMessages)
        stickToBottomOnNextRender()
      }
    } catch (error) {
      console.error('Chat deletion failed', error)
      toast.error(t('chat.bulk_delete.error', {
        defaultValue: 'Chat could not be deleted.',
      }))
    }
  }, [cancelActiveGeneration, stickToBottomOnNextRender, t, trackStructuralStorageWrite])

  const requestBulkDelete = useCallback(() => {
    const unstarredCount = sessionsRef.current.filter(session => session?.isStarred !== true).length
    if (unstarredCount === 0) {
      toast(t('chat.bulk_delete.none', {
        defaultValue: 'There are no unstarred chats to delete.',
      }))
      return
    }
    setShowHistory(true)
    setShowBulkDeleteConfirm(true)
  }, [t])

  const deleteUnstarredSessions = useCallback(async () => {
    if (isBulkDeleting) return

    const initialSessions = sessionsRef.current
    const initialUnstarredCount = initialSessions.filter(session => session?.isStarred !== true).length
    if (initialUnstarredCount === 0) {
      setShowBulkDeleteConfirm(false)
      return
    }

    setIsBulkDeleting(true)
    const currentActiveSessionId = activeSessionIdRef.current
    const generationSessionId = activeGenerationRef.current?.sessionId || null
    const generationSession = initialSessions.find(session => session?.id === generationSessionId)

    try {
      if (
        generationSessionId
        && generationSession?.isStarred !== true
      ) {
        await cancelActiveGeneration('clear_history')
        if (activeGenerationRef.current?.jobId) {
          toast.error(t('chat.bulk_delete.cancel_failed', {
            defaultValue: 'The response could not be stopped, so the chats were not deleted.',
          }))
          return
        }
      }

      const write = async () => {
        let storedSessions = null
        if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
          const stored = await chrome.storage.local.get(['sessions'])
          storedSessions = Array.isArray(stored?.sessions) ? stored.sessions : null
        }

        const localSessions = sessionsRef.current
        const localById = new Map(localSessions.map(session => [session?.id, session]))
        const sourceSessions = (storedSessions ?? localSessions)
          .map(normalizeSessionMetadata)
          .map(session => {
            const localSession = localById.get(session?.id)
            if (!localSession || session?.id !== generationSessionId) return session
            const generationMessages = session?.id === activeSessionIdRef.current
              ? messagesRef.current
              : localSession.messages
            return { ...session, messages: generationMessages || session.messages || [] }
          })
        const preservedSessions = sourceSessions.filter(session => session?.isStarred === true)
        const deletedCount = sourceSessions.length - preservedSessions.length

        let nextSessions = preservedSessions
        let nextActiveSessionId = currentActiveSessionId
        let nextMessages = messagesRef.current
        const preservedActiveSession = preservedSessions.find(session => session?.id === currentActiveSessionId)

        if (preservedActiveSession) {
          nextMessages = preservedActiveSession.messages || nextMessages
        } else if (preservedSessions.length > 0) {
          const nextSession = sortSessionsByUpdatedAt(preservedSessions)[0]
          nextActiveSessionId = nextSession.id
          nextMessages = nextSession.messages || []
        } else {
          const nextSessionId = Date.now().toString()
          const welcomeMessages = [{
            id: createUniqueMessageId(msgIdCounter),
            role: 'model',
            content: t('chat.welcome'),
          }]
          const nextSession = createSession({
            id: nextSessionId,
            title: t('chat.new_chat'),
            messages: welcomeMessages,
          })
          nextSessions = [nextSession]
          nextActiveSessionId = nextSessionId
          nextMessages = welcomeMessages
        }

        await setChromeStorage({
          sessions: nextSessions,
          activeSessionId: nextActiveSessionId,
        })
        nextSessions.forEach(session => {
          if (session?.id) persistedSessionIdsRef.current.add(session.id)
        })
        return {
          deletedCount,
          nextActiveSessionId,
          nextMessages,
          nextSessions,
          preservedActiveSession,
        }
      }

      const queuedWrite = storageWriteQueueRef.current
        .catch(() => undefined)
        .then(write)
      storageWriteQueueRef.current = queuedWrite.catch(error => {
        console.error('Chrome bulk session deletion failed', error)
      })
      const result = await trackStructuralStorageWrite(queuedWrite)

      const remainingSessionIds = new Set(result.nextSessions.map(session => session?.id))
      pendingSessionMetadataRef.current.forEach((_pendingMetadata, pendingSessionId) => {
        if (!remainingSessionIds.has(pendingSessionId)) {
          pendingSessionMetadataRef.current.delete(pendingSessionId)
        }
      })
      sessionsRef.current = result.nextSessions
      activeSessionIdRef.current = result.nextActiveSessionId
      messagesRef.current = result.nextMessages
      setSessions(result.nextSessions)
      setActiveSessionId(result.nextActiveSessionId)
      setMessages(result.nextMessages)
      if (!result.preservedActiveSession) stickToBottomOnNextRender()

      if (typeof chrome !== 'undefined' && chrome.storage?.local?.remove) {
        void chrome.storage.local.remove(['chatHistory']).catch(error => {
          console.error('Legacy chat history cleanup failed', error)
        })
      }

      setShowBulkDeleteConfirm(false)
      toast.success(t('chat.bulk_delete.success', {
        count: result.deletedCount,
        defaultValue: `${result.deletedCount} unstarred chats deleted.`,
      }))
    } catch (error) {
      console.error('Bulk chat deletion failed', error)
      toast.error(t('chat.bulk_delete.error', {
        defaultValue: 'Chats could not be deleted.',
      }))
    } finally {
      setIsBulkDeleting(false)
    }
  }, [cancelActiveGeneration, isBulkDeleting, stickToBottomOnNextRender, t, trackStructuralStorageWrite])

  const handleExport = useCallback(() => {
    if (sessions.length === 0) {
      toast.error(t('chat.no_history'))
      return
    }
    exportSessions(sessions)
    toast.success(t('chat.exported'))
  }, [sessions, t])

  const handleImport = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      await cancelActiveGeneration('import')
      if (activeGenerationRef.current?.jobId) {
        toast.error(t('chat.connection_error'))
        e.target.value = ''
        return
      }
      const importedSessions = await importSessions(file)
      const repairedImportedSessions = repairStoredSessions(
        importedSessions,
        msgIdCounter,
        null,
        t('chat.new_chat'),
      ).sessions
      const nextSessions = repairedImportedSessions.length > 0
        ? repairedImportedSessions.map(normalizeSessionMetadata)
        : [createSession({
            id: Date.now().toString(),
            title: t('chat.new_chat'),
            messages: [{
              id: createUniqueMessageId(msgIdCounter),
              role: 'model',
              content: t('chat.welcome'),
            }],
          })]
      const nextActiveSession = nextSessions[0]
      const saved = await enqueueStorageWrite({
        sessions: nextSessions,
        activeSessionId: nextActiveSession.id,
      })
      if (!saved) throw new Error(t('chat.import_error'))

      pendingSessionMetadataRef.current.clear()
      sessionsRef.current = nextSessions
      activeSessionIdRef.current = nextActiveSession.id
      messagesRef.current = nextActiveSession.messages || []
      setSessions(nextSessions)
      setActiveSessionId(nextActiveSession.id)
      setMessages(messagesRef.current)
      stickToBottomOnNextRender()
      toast.success(t('chat.imported'))
    } catch (err) {
      toast.error(err.message || t('chat.import_error'))
    }
    e.target.value = ''
  }, [cancelActiveGeneration, enqueueStorageWrite, stickToBottomOnNextRender, t])

  const handleSend = useCallback(async (directActionText = null, actionOptions = {}) => {
    const hasDirectActionText = typeof directActionText === 'string'
    const safeInput = typeof input === 'string' ? input : ''
    const userText = hasDirectActionText ? directActionText : safeInput.trim()
    const retryUserMessage = actionOptions?.retryUserMessage
    const sourceAttachments = retryUserMessage
      ? (Array.isArray(retryUserMessage.attachments) ? retryUserMessage.attachments : [])
      : attachments
    if (!userText && sourceAttachments.length === 0) return
    if (activeGenerationRef.current?.jobId || cancellationPromiseRef.current) {
      toast.error(t('chat.generation_errors.already_running', {
        defaultValue: t('chat.connection_error'),
      }))
      return
    }
    if (isGeneratingRef.current) return

    const supportedModes = new Set(['chat', 'vision', 'web'])
    const automaticMode = enableResearch ? 'web' : (sourceAttachments.length > 0 ? 'vision' : 'chat')
    const mode = supportedModes.has(actionOptions?.modeOverride)
      ? actionOptions.modeOverride
      : (supportedModes.has(retryUserMessage?.mode) ? retryUserMessage.mode : automaticMode)
    const requestModel = MODELS.includes(actionOptions?.modelOverride)
      ? actionOptions.modelOverride
      : selectedModel

    const messageAttachments = sourceAttachments.map(att => ({
      data: att.data,
      mimeType: att.mimeType,
      name: att.name
    }))

    updateStats(mode === 'web' ? ['message', 'search'] : 'message')
    const userMessageId = retryUserMessage?.id || createUniqueMessageId(msgIdCounter)
    const assistantMessageId = createUniqueMessageId(msgIdCounter)
    const requestId = `${Date.now()}-${assistantMessageId}`
    const jobId = requestId
    const startedAt = Date.now()
    const userMsg = retryUserMessage
      ? { ...retryUserMessage, content: userText, attachments: messageAttachments, mode }
      : createUserMessage({
          id: userMessageId,
          content: userText,
          displayContent: actionOptions?.displayContent,
          attachments: messageAttachments,
          mode,
        })
    const assistantMsg = createAssistantMessage({
      id: assistantMessageId,
      requestId,
      userMessageId,
      startedAt
    })
    const retryUserIndex = retryUserMessage
      ? messagesRef.current.findIndex(message => message.id === retryUserMessage.id)
      : -1
    const baseMessages = normalizeConversationMessages(
      retryUserIndex >= 0
        ? messagesRef.current.slice(0, retryUserIndex)
        : messagesRef.current
    )
    const requestMessages = [...baseMessages, userMsg]
    const requestSessionId = activeSessionIdRef.current
    const optimisticMessages = [...baseMessages, userMsg, assistantMsg]
    const requestSession = sessionsRef.current.find(session => session?.id === requestSessionId)
    const sessionTitle = resolveSessionTitle(requestSession, optimisticMessages)
    const generation = {
      jobId,
      requestId,
      sessionId: requestSessionId,
      userMessageId,
      assistantMessageId,
      startedAt,
      completedAt: null,
      mode,
      model: requestModel,
      language: appConfig?.language || i18n.language || 'tr',
      status: 'queued',
      revision: 0,
      content: '',
      sources: [],
      errorCode: null,
      cancelReason: null,
      updatedAt: startedAt,
    }

    activeGenerationRef.current = generation
    lastGenerationRevisionRef.current = 0
    finalizingGenerationRef.current = null
    if (finalizationRetryRef.current.timerId != null) {
      window.clearTimeout(finalizationRetryRef.current.timerId)
    }
    finalizationRetryRef.current = { jobId: null, attempts: 0, timerId: null }
    presentationCancellationRef.current = null
    streamTargetMessageIdRef.current = assistantMessageId
    streamBufferRef.current = ''
    displayedAssistantContentRef.current = ''
    streamLastDisplayAtRef.current = 0
    streamRevealNotBeforeRef.current = startedAt + MIN_THINKING_VISIBLE_MS
    streamDrainResolversRef.current = []
    messagesRef.current = optimisticMessages
    mergeSessionMessages(requestSessionId, optimisticMessages)
    lastPartialPersistAtRef.current = startedAt

    flushSync(() => {
      setGenerating(true)
      stickToBottomOnNextRender()
      setMessages(optimisticMessages)
      if (!retryUserMessage) {
        setInput('')
        setAttachments([])
      }
    })

    const persistLocalStartFailure = async (errorCode = 'generation_failed') => {
      const storedSession = sessionsRef.current.find(session => session.id === requestSessionId)
      if (storedSession) {
        let found = false
        let failedMessages = (storedSession.messages || []).map(message => {
          if (message.id !== assistantMessageId || message.role !== 'model') return message
          found = true
          return {
            ...message,
            status: 'error',
            errorCode,
          }
        })
        if (!found) {
          failedMessages = [
            ...failedMessages,
            {
              ...assistantMsg,
              status: 'error',
              errorCode,
            },
          ]
        }

        if (activeSessionIdRef.current === requestSessionId) {
          messagesRef.current = failedMessages
          if (mountedRef.current) setMessages(failedMessages)
        }
        mergeSessionMessages(requestSessionId, failedMessages)
        try {
          await persistSessionMessagesFromLatestStorage(requestSessionId, failedMessages)
        } catch (storageError) {
          console.error('Failed to persist generation start error', storageError)
        }
      }

      if (activeGenerationRef.current?.jobId === jobId) {
        activeGenerationRef.current = null
        lastGenerationRevisionRef.current = 0
        streamTargetMessageIdRef.current = null
        cancelRequestedJobIdsRef.current.delete(jobId)
        stopAssistantDisplayQueue(true)
        setGenerating(false)
      }
      if (activeSessionIdRef.current === requestSessionId) {
        toast.error(t(`chat.generation_errors.${errorCode}`, {
          defaultValue: t('chat.connection_error'),
        }))
      }
    }

    const applyAuthoritativeStartState = async (authoritativeGeneration, errorCode) => {
      if (!authoritativeGeneration) {
        await persistLocalStartFailure(errorCode)
        return
      }

      if (authoritativeGeneration.jobId !== jobId) {
        await persistLocalStartFailure(errorCode || 'already_running')
        activeGenerationRef.current = null
        lastGenerationRevisionRef.current = 0
        handleGenerationState(authoritativeGeneration)
        return
      }

      handleGenerationState(authoritativeGeneration)
    }

    let startDispatched = false
    try {
      await storageWriteQueueRef.current.catch(() => undefined)
      if (
        activeGenerationRef.current?.jobId !== jobId
        || cancelRequestedJobIdsRef.current.has(jobId)
        || cancellationPromiseRef.current?.jobId === jobId
      ) {
        return
      }
      startDispatched = true
      const response = await sendRuntimeMessage({
        type: 'HERA_GENERATION_START',
        jobId,
        requestId,
        sessionId: requestSessionId,
        userMessageId,
        assistantMessageId,
        startedAt,
        mode,
        model: requestModel,
        language: generation.language,
        sessionTitle,
        systemInstruction: appConfig?.systemInstruction || '',
        requestMessages,
      })
      if (response?.activeGeneration) {
        await applyAuthoritativeStartState(
          response.activeGeneration,
          response.errorCode || 'already_running',
        )
        return
      }
      if (response?.ok === false) {
        const error = new Error(response.errorCode || 'generation_failed')
        error.errorCode = response.errorCode || 'generation_failed'
        error.definitiveRejection = true
        throw error
      }

      const state = await sendRuntimeMessage({ type: 'GET_STATE' })
      if (!state || !Object.prototype.hasOwnProperty.call(state, 'activeGeneration')) {
        throw new Error('Generation state response was invalid')
      }
      await applyAuthoritativeStartState(state.activeGeneration, 'generation_failed')
    } catch (err) {
      console.error('Generation start failed', err)
      const errorCode = err?.errorCode || 'generation_failed'
      if (!startDispatched || err?.definitiveRejection) {
        await persistLocalStartFailure(errorCode)
        return
      }

      try {
        const state = await sendRuntimeMessage({ type: 'GET_STATE' })
        if (!state || !Object.prototype.hasOwnProperty.call(state, 'activeGeneration')) {
          throw new Error('Generation state response was invalid')
        }
        await applyAuthoritativeStartState(state.activeGeneration, errorCode)
      } catch (reconciliationError) {
        console.error('Generation start reconciliation failed', reconciliationError)
        if (mountedRef.current && activeGenerationRef.current?.jobId === jobId) {
          setGenerating(true)
          toast.error(t('chat.connection_error'))
        }
      }
    }
  }, [input, attachments, appConfig, enableResearch, selectedModel, handleGenerationState, mergeSessionMessages, persistSessionMessagesFromLatestStorage, resolveSessionTitle, setGenerating, stickToBottomOnNextRender, stopAssistantDisplayQueue, t])

  handleSendRef.current = handleSend


  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const handleFileChange = useCallback(async (e) => {
    const files = Array.from(e.target.files)
    if (!files.length) return

    setGenerating(true)

    const newAttachments = []
    for (const file of files) {
      try {
        const base64 = await fileToBase64(file)
        newAttachments.push({
          name: file.name,
          mimeType: file.type,
          data: base64
        })
      } catch (err) {
        console.error("File processing error", err)
        toast.error(t('chat.file_error'))
      }
    }

    setAttachments(prev => [...prev, ...newAttachments])
    setGenerating(Boolean(activeGenerationRef.current?.jobId))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [t, setGenerating])

  const handleScreenshot = useCallback(async () => {
    const activeCrop = cropTargetRef.current
    if (activeCrop) {
      activeCrop.cancelRequested = true
      setIsCropActive(false)
      setActiveMode(previous => (previous === 'crop' ? null : previous))

      if (activeCrop.phase !== 'active') return
      activeCrop.phase = 'cancelling'

      try {
        await chrome.scripting.executeScript({
          target: { tabId: activeCrop.tabId },
          func: cancelCropOverlay,
          args: [activeCrop.requestId],
        })
      } catch (error) {
        console.warn('Crop cancellation could not reach the original tab', error)
      } finally {
        if (cropTargetRef.current === activeCrop) {
          clearCropSelectionState(activeCrop.requestId)
        }
      }
      return
    }

    if (cropTogglePendingRef.current) return
    cropTogglePendingRef.current = true

    const cropOperation = {
      tabId: null,
      requestId: `crop-${createUniqueMessageId(msgIdCounter)}`,
      phase: 'resolving',
      cancelRequested: false,
    }
    cropTargetRef.current = cropOperation
    setIsCropActive(true)

    try {
      const windows = await chrome.windows.getAll()
      if (
        cropOperation.cancelRequested
        || !mountedRef.current
        || cropTargetRef.current !== cropOperation
      ) return

      const targetWindow = windows.find(w => w.type === 'normal')
      
      if (!targetWindow) {
        toast.error(t('chat.screenshot_no_tab'));
        return;
      }

      const [tab] = await chrome.tabs.query({ active: true, windowId: targetWindow.id });
      if (
        cropOperation.cancelRequested
        || !mountedRef.current
        || cropTargetRef.current !== cropOperation
      ) return

      if (!tab || !tab.id) {
        toast.error(t('chat.screenshot_no_tab'));
        return;
      }

      const url = tab.url || '';
      const blocked = url.startsWith('chrome://') || url.startsWith('about:') ||
        url.startsWith('edge://') || url === '';
      if (blocked) {
        toast.error(t('chat.screenshot_blocked'));
        return;
      }

      cropOperation.tabId = tab.id
      cropOperation.phase = 'starting'
      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: injectCropOverlay,
        args: [
          {
            confirm: t('chat.tooltips.crop_confirm'),
            cancel: t('chat.tooltips.crop_cancel')
          },
          appConfig?.customPrimaryColor || '#7c5cff',
          cropOperation.requestId,
        ]
      });

      const injectionState = injectionResults?.[0]?.result
      cropOperation.requestId = injectionState?.requestId || cropOperation.requestId
      if (injectionState?.active === false) {
        return
      }

      if (
        cropOperation.cancelRequested
        || !mountedRef.current
        || cropTargetRef.current !== cropOperation
      ) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: cropOperation.tabId },
            func: cancelCropOverlay,
            args: [cropOperation.requestId],
          })
        } catch (_error) {
          // The page may have closed or already removed the overlay.
        }
        return
      }

      cropOperation.phase = 'active'
      setIsCropActive(true)
      void updateStats('screenshot')
      toast(t('chat.tooltips.screenshot_hint'));
    } catch (e) {
      if (
        cropOperation.cancelRequested
        || !mountedRef.current
        || cropTargetRef.current !== cropOperation
      ) return

      console.error('Initiate screenshot error', e);
      const msg = e?.message || '';
      if (msg.includes('Cannot access') || msg.includes('chrome://')) {
        toast.error(t('chat.screenshot_blocked'));
      } else {
        toast.error(t('chat.file_error'));
      }
    } finally {
      cropTogglePendingRef.current = false
      if (cropTargetRef.current === cropOperation && cropOperation.phase !== 'active') {
        clearCropSelectionState(cropOperation.requestId)
      }
    }
  }, [appConfig, clearCropSelectionState, t])

  const removeAttachment = useCallback((index) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }, [])

  const handlePaste = useCallback(async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          setGenerating(true);
          try {
            const base64 = await fileToBase64(file);
            setAttachments(prev => [...prev, {
              name: `pasted-image-${Date.now()}`,
              mimeType: file.type,
              data: base64
            }]);
          } catch (err) {
            console.error("Paste error", err);
            toast.error(t('chat.file_error'));
          } finally {
            setGenerating(Boolean(activeGenerationRef.current?.jobId));
          }
        }
      }
    }
  }, [t, setGenerating])

  const cancelStream = useCallback(() => {
    if (activeGenerationRef.current?.jobId) {
      void cancelActiveGeneration('user')
      toast.success(t('chat.cancelled'))
    }
  }, [cancelActiveGeneration, t])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    autoScrollRef.current = true
    userPausedAutoScrollRef.current = false
    forceScrollToBottomRef.current = false
    setShowScrollDownBtn(false)
  }, [])

  const handleEditMessage = useCallback((text) => {
    setInput(text)
    setTimeout(() => {
      const textarea = document.querySelector('textarea')
      if (textarea) {
        textarea.focus()
        textarea.setSelectionRange(text.length, text.length)
      }
    }, 50)
  }, [])

  const handleRetryMessage = useCallback((message, modelOverride) => {
    if (!message || isGeneratingRef.current) return

    const retryOptions = (retryUserMessage) => ({
      retryUserMessage,
      ...(MODELS.includes(modelOverride) ? { modelOverride } : {}),
    })

    if (message.role === 'user' && (message.content || message.attachments?.length)) {
      handleSendRef.current?.(message.content || '', retryOptions(message))
      return
    }

    if (message.role === 'model') {
      const currentMessages = messagesRef.current
      const linkedUserMessage = message.userMessageId != null
        ? currentMessages.find((item) => item.role === 'user' && item.id === message.userMessageId)
        : null
      const messageIndex = currentMessages.findIndex((item) => item.id === message.id)
      const previousUserMessage = messageIndex > 0
        ? [...currentMessages.slice(0, messageIndex)].reverse().find((item) => item.role === 'user')
        : null
      const retryUserMessage = linkedUserMessage || previousUserMessage
      if (retryUserMessage && (retryUserMessage.content || retryUserMessage.attachments?.length)) {
        handleSendRef.current?.(retryUserMessage.content || '', retryOptions(retryUserMessage))
      }
    }
  }, [])

  const handleChatScroll = useCallback((event) => {
    const container = event.currentTarget
    const distanceFromBottom = getScrollDistanceFromBottom(container)
    const isAtBottom = distanceFromBottom <= SCROLL_RESUME_THRESHOLD_PX
    const nearBottom = isScrollNearBottom(container)

    if (isAtBottom) {
      userPausedAutoScrollRef.current = false
      autoScrollRef.current = true
      forceScrollToBottomRef.current = false
      setShowScrollDownBtn(false)
      return
    }

    if (scheduledScrollFrameRef.current != null && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(scheduledScrollFrameRef.current)
      scheduledScrollFrameRef.current = null
    }
    forceScrollToBottomRef.current = false
    if (userPausedAutoScrollRef.current) {
      autoScrollRef.current = false
      setShowScrollDownBtn(true)
      return
    }

    autoScrollRef.current = nearBottom
    setShowScrollDownBtn(!nearBottom)
  }, [])

  const handleChatWheel = useCallback((event) => {
    const container = scrollRef.current
    if (!container || event.deltaY >= 0) return
    if (container.scrollHeight <= container.clientHeight) return
    pauseAutoScroll()
  }, [pauseAutoScroll])

  const handleComposerWheel = useCallback((event) => {
    const container = scrollRef.current
    if (!container || !event.deltaY) return
    const canScroll = container.scrollHeight > container.clientHeight
    if (!canScroll) return
    event.preventDefault()
    scrollChatBy(event.deltaY)
  }, [scrollChatBy])

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'n' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        startNewSession()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [startNewSession])

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    )
  }

  if (!appConfig) {
    return (
      <div className="flex flex-col h-screen bg-background text-foreground overflow-y-auto">
        <SettingsPanel
          currentConfig={{}}
          currentModel={selectedModel}
          onSave={(newConfig) => {
            setAppConfig(newConfig)
            applyTheme(newConfig.theme, newConfig.customPrimaryColor)
            setShowSettings(false)
          }}
        />
      </div>
    )
  }

  if (showHistory) {
    return (
      <HistoryOverlay
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={loadSession}
        onDelete={deleteSession}
        onRename={renameSession}
        onToggleStar={toggleStarSession}
        onRequestBulkDelete={requestBulkDelete}
        bulkDeleteOpen={showBulkDeleteConfirm}
        onCancelBulkDelete={() => setShowBulkDeleteConfirm(false)}
        onConfirmBulkDelete={deleteUnstarredSessions}
        isBulkDeleting={isBulkDeleting}
        onClose={() => {
          setShowBulkDeleteConfirm(false)
          setShowHistory(false)
        }}
      />
    )
  }

  if (showStats) {
    return <StatsPanel onClose={() => setShowStats(false)} />
  }

  if (showShortcuts) {
    return <ShortcutsPanel onClose={() => setShowShortcuts(false)} />
  }

  const isWelcomeOnly = (
    messages.length === 1 &&
    messages[0]?.role === 'model' &&
    !messages[0]?.status &&
    !messages[0]?.attachments?.length
  )
  const activeSessionTitle = sessions.find(session => session?.id === activeSessionId)?.title
    || t('chat.new_chat')

  const getQuickActionClass = (isActive = false) => (
    `hera-icon-button h-8 w-8 border border-transparent active:scale-95 disabled:pointer-events-none disabled:opacity-35 ${
      isActive
        ? 'border-primary/25 bg-primary/[0.12] text-primary'
        : 'hover:border-border/70 hover:bg-secondary'
    }`
  )

  const handleModelChange = (nextModel) => {
    setSelectedModel(nextModel)
    if (chrome && chrome.storage) chrome.storage.local.set({ selectedModel: nextModel })
  }

  return (
    <div className="hera-panel flex h-screen min-h-0 min-w-0 flex-col overflow-hidden text-foreground">
      <AppHeader
        activeSessionTitle={activeSessionTitle}
        onRenameSession={(nextTitle) => renameSession(activeSessionId, nextTitle)}
        onNewChat={startNewSession}
        onHistory={() => setShowHistory(true)}
        onClear={requestBulkDelete}
        onExport={handleExport}
        onImport={handleImport}
        onSettings={() => setShowSettings(true)}
        onStats={() => setShowStats(true)}
        onShortcuts={() => setShowShortcuts(true)}
      />

      {showSettings && (
        <div className="absolute inset-0 z-50 overflow-y-auto bg-background">
          <SettingsPanel
            currentConfig={appConfig}
            currentModel={selectedModel}
            onClose={() => setShowSettings(false)}
            onSave={(newConfig) => {
              setAppConfig(newConfig)
              applyTheme(newConfig.theme, newConfig.customPrimaryColor)
              setShowSettings(false)
            }}
          />
        </div>
      )}

      <main
        className="relative min-h-0 flex-1 overscroll-contain overflow-x-hidden overflow-y-auto"
        style={{ overflowAnchor: 'none' }}
        ref={scrollRef}
        onScroll={handleChatScroll}
        onWheelCapture={handleChatWheel}
      >
        {showScrollDownBtn && (
          <div className="pointer-events-none sticky bottom-3 z-10 flex justify-center">
            <button
              type="button"
              onClick={() => scrollToBottom()}
              className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-primary/20 bg-popover px-3 py-1.5 text-[11px] font-medium text-foreground shadow-lg hover:bg-secondary"
            >
              ↓ {t('chat.new_messages')}
            </button>
          </div>
        )}

        {isWelcomeOnly ? (
          <WelcomeScreen
            onCrop={handleScreenshot}
            isCropActive={isCropActive}
            onResearch={() => {
              setEnableResearch(true)
              setActiveMode('web')
              document.querySelector('textarea')?.focus()
            }}
            onAttach={() => fileInputRef.current?.click()}
          />
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-5 pb-8">
            {messages.map((msg, idx) => {
              return (
                <ChatMessage
                  key={msg.id ?? idx}
                  message={msg}
                  onEdit={handleEditMessage}
                  onRetry={handleRetryMessage}
                  retryModels={MODELS}
                  modelLabels={MODEL_LABELS}
                  currentModel={selectedModel}
                  retryDisabled={isGenerating}
                />
              )
            })}
          </div>
        )}
      </main>

      <div className="p-4 bg-background shrink-0 border-t border-border/60" onWheel={handleComposerWheel}>
        <div className="hera-surface mx-auto w-full max-w-3xl overflow-hidden rounded-2xl transition-shadow focus-within:border-primary/35 focus-within:shadow-lg focus-within:shadow-primary/5">
          {attachments.length > 0 && (
            <div className="flex gap-1.5 overflow-x-auto border-b border-border/60 px-3 py-2">
              {attachments.map((att, idx) => (
                <div key={`${att.name}-${idx}`} className="group relative flex max-w-[170px] shrink-0 items-center gap-2 rounded-lg border border-border/70 bg-secondary/65 py-1 pl-1 pr-7">
                  {att.mimeType.startsWith('image/') ? (
                    <img src={`data:${att.mimeType};base64,${att.data}`} alt="" className="h-7 w-7 rounded-md object-cover" />
                  ) : (
                    <span className="flex h-7 w-7 items-center justify-center rounded-md bg-background/70">
                      <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    </span>
                  )}
                  <span className="truncate text-[11px]">{att.name}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(idx)}
                    aria-label={t('chat.tooltips.remove_attachment')}
                    className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            value={typeof input === 'string' ? input : ''}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={t('chat.placeholder')}
            className="min-h-[66px] max-h-48 w-full resize-none overflow-y-auto bg-transparent px-3.5 pb-2 pt-3 text-[14px] leading-relaxed placeholder:text-muted-foreground/70 focus:outline-none"
            rows="2"
          />

          <div className="flex min-w-0 items-center justify-between gap-2 px-2 pb-2">
            <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                className="hidden"
                accept="image/*,.pdf,.doc,.docx,.txt,.csv,.json,.xml,.html,.md"
                multiple
              />
              <button
                type="button"
                title={t('chat.tooltips.attach_file')}
                aria-label={t('chat.tooltips.attach_file')}
                onClick={() => fileInputRef.current?.click()}
                className={getQuickActionClass()}
                disabled={isGenerating}
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <button
                type="button"
                title={isCropActive
                  ? t('chat.quick_actions.crop_cancel_tooltip')
                  : t('chat.quick_actions.crop_tooltip')}
                aria-label={isCropActive
                  ? t('chat.quick_actions.crop_cancel_tooltip')
                  : t('chat.quick_actions.crop_tooltip')}
                aria-pressed={isCropActive}
                onClick={handleScreenshot}
                disabled={isGenerating && !isCropActive}
                className={getQuickActionClass(isCropActive)}
              >
                <Scissors className="h-4 w-4" />
              </button>
              <button
                type="button"
                title={t('chat.quick_actions.web_tooltip')}
                aria-label={t('chat.quick_actions.web_tooltip')}
                aria-pressed={enableResearch}
                onClick={() => {
                  const next = !enableResearch
                  setEnableResearch(next)
                  setActiveMode(next ? 'web' : null)
                }}
                disabled={isGenerating}
                className={getQuickActionClass(enableResearch)}
              >
                <Globe className="h-4 w-4" />
              </button>
              <button
                type="button"
                title={t('chat.quick_actions.ocr_tooltip')}
                aria-label={t('chat.quick_actions.ocr_tooltip')}
                aria-pressed={activeMode === 'ocr'}
                onClick={() => {
                  setActiveMode('ocr')
                  setInput('')
                  handleSend(t('chat.prompts.ocr'), {
                    modeOverride: 'vision',
                    displayContent: '',
                  })
                }}
                disabled={isGenerating || !hasImageAttachment}
                className={getQuickActionClass(activeMode === 'ocr')}
              >
                <ScanText className="h-4 w-4" />
              </button>
              <button
                type="button"
                title={t('chat.quick_actions.translate_tooltip')}
                aria-label={t('chat.quick_actions.translate_tooltip')}
                aria-pressed={activeMode === 'translate'}
                onClick={() => {
                  setActiveMode('translate')
                  const prompt = `${t('chat.prompts.translate')}:\n${input}`
                  setInput('')
                  handleSend(prompt)
                }}
                disabled={isGenerating}
                className={getQuickActionClass(activeMode === 'translate')}
              >
                <Languages className="h-4 w-4" />
              </button>
              <button
                type="button"
                title={t('chat.quick_actions.summarize_tooltip')}
                aria-label={t('chat.quick_actions.summarize_tooltip')}
                aria-pressed={activeMode === 'summarize'}
                onClick={() => {
                  setActiveMode('summarize')
                  const prompt = `${t('chat.prompts.summarize')}:\n${input}`
                  setInput('')
                  handleSend(prompt)
                }}
                disabled={isGenerating}
                className={getQuickActionClass(activeMode === 'summarize')}
              >
                <FileText className="h-4 w-4" />
              </button>
              <button
                type="button"
                title={t('chat.quick_actions.explain_tooltip')}
                aria-label={t('chat.quick_actions.explain_tooltip')}
                aria-pressed={activeMode === 'explain'}
                onClick={() => {
                  setActiveMode('explain')
                  const prompt = `${t('chat.prompts.explain')}:\n${input}`
                  setInput('')
                  handleSend(prompt)
                }}
                disabled={isGenerating}
                className={getQuickActionClass(activeMode === 'explain')}
              >
                <Lightbulb className="h-4 w-4" />
              </button>
            </div>

            <button
              type="button"
              onClick={() => isGenerating ? cancelStream() : handleSend()}
              disabled={!isGenerating && (!input.trim() && attachments.length === 0)}
              title={isGenerating ? t('chat.tooltips.stop') : t('chat.tooltips.send')}
              aria-label={isGenerating ? t('chat.tooltips.stop') : t('chat.tooltips.send')}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl shadow-sm transition-all active:scale-95 disabled:pointer-events-none disabled:opacity-35 ${
                isGenerating
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : 'bg-primary text-primary-foreground hover:brightness-105'
              }`}
            >
              {isGenerating ? <Square className="h-3.5 w-3.5 fill-current" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <div data-testid="composer-meta" className="mt-1.5 flex min-w-0 items-center justify-between gap-2">
          <ModelSelector
            selectedModel={selectedModel}
            models={MODELS}
            modelLabels={MODEL_LABELS}
            onModelChange={handleModelChange}
          />
          <p className="min-w-0 flex-1 truncate text-right text-[11px] leading-none text-muted-foreground/55" title={t('chat.powered_by')}>
            {t('chat.powered_by')}
          </p>
        </div>
      </div>
    </div>
  )
}

export default App
