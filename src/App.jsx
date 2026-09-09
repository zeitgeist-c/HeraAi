import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react'
import { flushSync } from 'react-dom'
import { Send, Square, Paperclip, Loader2, X, FileText, Languages, Lightbulb, Scissors, Globe, ScanText, Mic, Link2, ArrowUpToLine, ArrowDownToLine } from 'lucide-react'
import toast from 'react-hot-toast'

import { useTranslation } from 'react-i18next'

import SettingsPanel from './components/SettingsPanel'
import AppHeader from './components/AppHeader'
import ChatMessage from './components/ChatMessage'
import HistoryOverlay from './components/HistoryOverlay'
import StatsPanel from './components/StatsPanel'
import WelcomeScreen from './components/WelcomeScreen'
import ModelSelector from './components/ModelSelector'
import { cancelCropOverlay, injectCropOverlay } from './lib/injectCropOverlay'
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  MODEL_CATALOG,
  MODEL_CAPABILITIES,
  MODELS,
  getProviderForModel,
  resolveModelSelection,
} from './lib/models'
import {
  bytesToBase64,
  createAudioBufferFromPcm16,
  normalizeMarkdownForSpeech,
  recordedBlobToWav,
  splitSpeechText,
  TTS_MAX_CHARS,
} from './lib/audioUtils'
import { processAttachmentFile, validateAttachmentGroup } from './lib/fileParsers'
import {
  attachmentIdsFromSessions,
  cleanupOrphanAttachments,
  deleteAttachment,
  migrateLegacySessionAttachments,
  putAttachment,
} from './lib/attachmentStore'
import { exportSessions, exportSessionMarkdown, importSessions, sessionToMarkdown } from './lib/importExport'
import { findChatMatchIds } from './lib/chatSearch'
import {
  extractPublicUrls,
  isUrlOnlyText,
  listPublicUrls,
  MAX_PUBLIC_URLS,
  normalizePublicUrl,
  removePublicUrlFromText,
} from './lib/urlContext'
import {
  getAutoMessageTitle,
  getMessageDisplayContent,
  isHiddenPromptAutoTitle,
  isLegacyOcrPromptMessage,
} from './lib/messageDisplay'
import i18n from './i18n'
import { updateStats } from './lib/stats'
import { resolveKeysForRequest } from './lib/keyManager'
import { generateSpeech, transcribeAudio } from './lib/voiceApi'
import { resolveSystemInstructionConfig } from './lib/systemInstruction'
import {
  requestsPreviousImage,
  requestsPreviousWebSource,
  selectRequestContext,
} from './lib/contextSelection'
import {
  hasRetiredModelProvenance,
  sanitizeRetiredModelMessages,
  sanitizeRetiredModelSessions,
  stripRetiredModelProvenance,
} from './lib/modelMigration'

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
const DICTATION_MAX_DURATION_MS = 200000
const SUPPORTED_PASTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
function mergeAttachmentRefs(existing = [], additions = []) {
  const refs = new Map()
  for (const attachment of [...(existing || []), ...(additions || [])]) {
    if (!attachment) continue
    const key = attachment.id || `${attachment.name || ''}:${attachment.mimeType || ''}:${attachment.size || 0}`
    if (!refs.has(key)) refs.set(key, attachment)
  }
  return Array.from(refs.values())
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

function createUserMessage({
  id,
  content,
  displayContent,
  attachments,
  displayAttachmentIds,
  displayWebUrls,
  mode,
  webUrls,
}) {
  return {
    id,
    role: 'user',
    content,
    ...(typeof displayContent === 'string' ? { displayContent } : {}),
    attachments,
    displayAttachmentIds,
    displayWebUrls,
    mode,
    webUrls,
  }
}

function createAssistantMessage({ id, requestId, userMessageId, startedAt, model, provider, resolvedModel }) {
  return {
    id,
    requestId,
    userMessageId,
    startedAt,
    role: 'model',
    content: '',
    status: 'thinking',
    sources: [],
    ...(typeof model === 'string' && model ? { model } : {}),
    ...(typeof provider === 'string' && provider ? { provider } : {}),
    ...(typeof resolvedModel === 'string' && resolvedModel ? { resolvedModel } : {}),
  }
}

function createSession({ id, title, messages, updatedAt = Date.now(), activeAttachmentIds = [], activeWebUrls = [] }) {
  return {
    id,
    title,
    isTitleCustom: false,
    isStarred: false,
    updatedAt,
    messages,
    activeAttachmentIds,
    activeWebUrls,
  }
}

function activeAttachmentRefs(session) {
  const activeIds = new Set(session?.activeAttachmentIds || [])
  if (activeIds.size === 0) return []
  const refs = new Map()
  for (const message of session?.messages || []) {
    for (const attachment of message?.attachments || []) {
      if (attachment?.id && activeIds.has(attachment.id)) refs.set(attachment.id, attachment)
    }
  }
  return Array.from(activeIds).map(id => refs.get(id)).filter(Boolean)
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
    activeAttachmentIds: Array.isArray(session.activeAttachmentIds) ? session.activeAttachmentIds : [],
    activeWebUrls: Array.isArray(session.activeWebUrls) ? session.activeWebUrls : [],
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
  const localizedModelCatalog = useMemo(() => MODEL_CATALOG.map(model => ({
    ...model,
    label: model.labelKey ? t(model.labelKey) : model.label,
  })), [t])
  const localizedModelLabels = useMemo(() => Object.freeze(Object.fromEntries(
    localizedModelCatalog.map(model => [model.modelId, model.label]),
  )), [localizedModelCatalog])
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
  const [chatSearchOpen, setChatSearchOpen] = useState(false)
  const [chatSearchQuery, setChatSearchQuery] = useState('')
  const [chatSearchIndex, setChatSearchIndex] = useState(0)
  const [enableResearch, setEnableResearch] = useState(false)
  const [activeMode, setActiveMode] = useState(null)
  const [isCropActive, setIsCropActive] = useState(false)
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL)
  const [selectedProvider, setSelectedProvider] = useState(DEFAULT_PROVIDER)
  const msgIdCounter = useRef(0)
  const scrollRef = useRef(null)
  const composerInputRef = useRef(null)
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
  const [canScrollUp, setCanScrollUp] = useState(false)
  const [canScrollDown, setCanScrollDown] = useState(false)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState([])
  const [isFileDragActive, setIsFileDragActive] = useState(false)
  const fileDragDepthRef = useRef(0)
  const attachmentProcessingRef = useRef(false)
  const [dictationPhase, setDictationPhase] = useState('idle')
  const [dictationSeconds, setDictationSeconds] = useState(0)
  const dictationPhaseRef = useRef('idle')
  const dictationStreamRef = useRef(null)
  const dictationRecorderRef = useRef(null)
  const dictationChunksRef = useRef([])
  const dictationKeysRef = useRef([])
  const dictationShouldTranscribeRef = useRef(false)
  const dictationTimerRef = useRef(null)
  const dictationLimitRef = useRef(null)
  const dictationAbortRef = useRef(null)
  const dictationStartEpochRef = useRef(0)
  const micPermissionCancelRef = useRef(null)
  const [speechState, setSpeechState] = useState({ messageId: null, phase: 'idle' })
  const speechStateRef = useRef({ messageId: null, phase: 'idle' })
  const speechAbortRef = useRef(null)
  const speechSourceRef = useRef(null)
  const speechContextRef = useRef(null)
  const speechEpochRef = useRef(0)
  const hasImageAttachment = attachments.some(att => (
    att?.mimeType?.startsWith('image/')
  ))
  const draftWebUrls = enableResearch ? listPublicUrls(input) : []
  const [isGenerating, setIsGeneratingState] = useState(false)
  const isGeneratingRef = useRef(false)
  const setGenerating = useCallback((val) => {
    setIsGeneratingState(val)
    isGeneratingRef.current = val
  }, [])

  const focusComposer = useCallback((caretPosition = null) => {
    const textarea = composerInputRef.current
    if (!textarea) return
    textarea.focus()
    if (Number.isInteger(caretPosition)) {
      textarea.setSelectionRange(caretPosition, caretPosition)
    }
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

  useEffect(() => {
    focusComposer()
    const handleWindowFocus = () => {
      if (showSettings || showHistory || showStats) return
      focusComposer()
    }
    window.addEventListener('focus', handleWindowFocus)
    return () => window.removeEventListener('focus', handleWindowFocus)
  }, [focusComposer, showSettings, showHistory, showStats])

  const chatSearchMatchIds = useMemo(
    () => findChatMatchIds(messages, chatSearchQuery),
    [messages, chatSearchQuery],
  )
  const clampedChatSearchIndex = chatSearchMatchIds.length === 0
    ? 0
    : Math.min(chatSearchIndex, chatSearchMatchIds.length - 1)
  const currentChatSearchId = chatSearchOpen && chatSearchMatchIds.length > 0
    ? chatSearchMatchIds[clampedChatSearchIndex]
    : null
  const chatSearchCounterText = !chatSearchOpen || !chatSearchQuery.trim()
    ? ''
    : chatSearchMatchIds.length === 0
      ? t('chat.search_no_results')
      : `${clampedChatSearchIndex + 1}/${chatSearchMatchIds.length}`

  const stepChatSearch = useCallback((delta) => {
    if (chatSearchMatchIds.length === 0) return
    setChatSearchIndex(previous => (
      (previous + delta + chatSearchMatchIds.length) % chatSearchMatchIds.length
    ))
  }, [chatSearchMatchIds])

  const closeChatSearch = useCallback(() => {
    setChatSearchOpen(false)
    setChatSearchQuery('')
    setChatSearchIndex(0)
  }, [])

  useEffect(() => {
    setChatSearchIndex(0)
  }, [chatSearchQuery])

  useEffect(() => {
    if (!chatSearchOpen || !currentChatSearchId) return
    userPausedAutoScrollRef.current = true
    document.getElementById(`chat-msg-${currentChatSearchId}`)?.scrollIntoView?.({ block: 'center' })
  }, [chatSearchOpen, currentChatSearchId])

  const syncScrollControls = useCallback(() => {
    const element = scrollRef.current
    if (!element) {
      setCanScrollUp(false)
      setCanScrollDown(false)
      return
    }

    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
    const nextCanScrollUp = element.scrollTop > SCROLL_RESUME_THRESHOLD_PX
    const nextCanScrollDown = maxScrollTop - element.scrollTop > SCROLL_RESUME_THRESHOLD_PX
    setCanScrollUp(previous => previous === nextCanScrollUp ? previous : nextCanScrollUp)
    setCanScrollDown(previous => previous === nextCanScrollDown ? previous : nextCanScrollDown)
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
      syncScrollControls()
    }

    if (typeof window.requestAnimationFrame === 'function') {
      if (scheduledScrollFrameRef.current != null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(scheduledScrollFrameRef.current)
      }
      scheduledScrollFrameRef.current = window.requestAnimationFrame(run)
      return
    }

    run()
  }, [syncScrollControls])

  const stickToBottomOnNextRender = useCallback(() => {
    autoScrollRef.current = true
    userPausedAutoScrollRef.current = false
    forceScrollToBottomRef.current = true
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
    syncScrollControls()
  }, [syncScrollControls])

  const scrollChatBy = useCallback((deltaY) => {
    const container = scrollRef.current
    if (!container || !deltaY) return

    if (deltaY < 0) {
      pauseAutoScroll()
    }

    container.scrollTop = clampScrollTop(container, container.scrollTop + deltaY)
    syncScrollControls()
    const distanceFromBottom = getScrollDistanceFromBottom(container)
    const isAtBottom = distanceFromBottom <= SCROLL_RESUME_THRESHOLD_PX
    const nearBottom = isScrollNearBottom(container)

    if (isAtBottom && deltaY > 0) {
      userPausedAutoScrollRef.current = false
      autoScrollRef.current = true
      return
    }

    if (userPausedAutoScrollRef.current) {
      autoScrollRef.current = false
      return
    }

    autoScrollRef.current = nearBottom
  }, [pauseAutoScroll, syncScrollControls])

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
    const applyUpdate = (message) => {
      const updatedMessage = updater(message)
      return {
        ...updatedMessage,
        ...(typeof generation.model === 'string' && generation.model ? { model: generation.model } : {}),
        ...(typeof generation.provider === 'string' && generation.provider ? { provider: generation.provider } : {}),
        ...(typeof generation.resolvedModel === 'string' && generation.resolvedModel
          ? { resolvedModel: generation.resolvedModel }
          : {}),
      }
    }
    const currentMessages = messagesRef.current
    const nextMessages = currentMessages.map(message => {
      if (message.id !== assistantMessageId || message.role !== 'model') return message
      found = true
      return applyUpdate(message)
    })

    if (!found) {
      const created = createAssistantMessage({
        id: assistantMessageId,
        requestId: generation.requestId || generation.jobId,
        userMessageId: generation.userMessageId,
        startedAt: generation.startedAt || Date.now(),
        model: generation.model,
        provider: generation.provider,
        resolvedModel: generation.resolvedModel,
      })
      nextMessages.push(applyUpdate(created))
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
              ...(generation.model ? { model: generation.model } : {}),
              ...(generation.provider ? { provider: generation.provider } : {}),
              ...(generation.resolvedModel ? { resolvedModel: generation.resolvedModel } : {}),
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
                  model: generation.model,
                  provider: generation.provider,
                  resolvedModel: generation.resolvedModel,
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
    const blob = typeof canvas.toBlob === 'function'
      ? await new Promise((resolve, reject) => {
          canvas.toBlob(result => (result ? resolve(result) : reject(new Error('Screenshot encoding failed'))), 'image/png')
        })
      : (() => {
          const base64 = canvas.toDataURL('image/png').split(',')[1] || ''
          let bytes
          try {
            const binary = globalThis.atob(base64)
            bytes = new Uint8Array(binary.length)
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
          } catch {
            bytes = new TextEncoder().encode(base64)
          }
          return new Blob([bytes], { type: 'image/png' })
        })()
    return new File([blob], `screenshot-${Date.now()}.png`, { type: 'image/png' })
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
            const file = await captureScreenshot(msg.coords)
            if (file) {
              const ref = await putAttachment({
                blob: file,
                name: file.name,
                mimeType: 'image/png',
                size: file.size,
                kind: 'image',
              })
              setAttachments(previous => {
                const currentSession = sessionsRef.current.find(session => (
                  session?.id === activeSessionIdRef.current
                ))
                try {
                  validateAttachmentGroup([ref], [
                    ...activeAttachmentRefs(currentSession),
                    ...previous,
                  ])
                  return [...previous, ref]
                } catch (error) {
                  toast.error(t(`chat.generation_errors.${error?.code || 'attachment_invalid'}`))
                  void deleteAttachment(ref.id).catch(cleanupError => {
                    console.error('Rejected screenshot cleanup failed', cleanupError)
                  })
                  return previous
                }
              })
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
          'systemInstructionDefaultVersion',
          'chatHistory',
          'sessions',
          'activeSessionId',
          'activeGeneration',
          'customPrimaryColor',
          'language',
          'showSources',
          'selectedText',
          'selectedModel',
          'selectedProvider',
        ])
      } catch (error) {
        console.error('Chrome storage initialization failed', error)
      }
      if (disposed) return

      const systemInstructionConfig = resolveSystemInstructionConfig(result)
      const config = {
        theme: result.theme || 'system',
        startupBehavior: result.startupBehavior || 'resume',
        systemInstruction: systemInstructionConfig.systemInstruction,
        customPrimaryColor: result.customPrimaryColor || '#7c5cff',
        language: result.language || i18n.resolvedLanguage || i18n.language || 'tr',
        showSources: result.showSources === true,
      }
      if (systemInstructionConfig.shouldPersist) {
        try {
          await chrome.storage.local.set({
            systemInstruction: systemInstructionConfig.systemInstruction,
            systemInstructionDefaultVersion: systemInstructionConfig.systemInstructionDefaultVersion,
          })
        } catch (error) {
          console.error('System instruction default migration failed', error)
        }
        if (disposed) return
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
      const resolvedSelection = resolveModelSelection(result.selectedProvider, result.selectedModel)
      const resolvedSelectedModel = resolvedSelection.modelId
      setSelectedModel(resolvedSelectedModel)
      setSelectedProvider(resolvedSelection.provider)
      if (
        result.selectedModel !== resolvedSelectedModel
        || result.selectedProvider !== resolvedSelection.provider
      ) {
        try {
          await chrome.storage.local.set({
            selectedModel: resolvedSelectedModel,
            selectedProvider: resolvedSelection.provider,
          })
        } catch (error) {
          console.error('Stored model selection migration failed', error)
        }
      }

      const welcomeMessages = [{ id: createUniqueMessageId(msgIdCounter), role: 'model', content: translate('chat.welcome') }]
      // Do not repair transient assistant states until GET_STATE has supplied the
      // authoritative generation. A stale storage snapshot can otherwise preserve
      // an orphaned "thinking" message, or remove the placeholder for a newer job.
      let storedSessions = Array.isArray(result.sessions) ? result.sessions : []
      let legacyAttachmentsMigrated = false
      const retiredModelMigration = sanitizeRetiredModelSessions(storedSessions)
      storedSessions = retiredModelMigration.sessions
      try {
        const migration = await migrateLegacySessionAttachments(storedSessions)
        storedSessions = migration.sessions
        legacyAttachmentsMigrated = migration.changed
      } catch (error) {
        console.error('Legacy attachment migration failed', error)
      }
      storedSessions.forEach(session => {
        if (session?.id) persistedSessionIdsRef.current.add(session.id)
      })
      let nextSessions = storedSessions.map(normalizeSessionMetadata)
      let nextActiveSessionId = null
      let nextMessages = welcomeMessages
      let shouldPersistSessions = legacyAttachmentsMigrated || retiredModelMigration.changed

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
        const sanitizedHistory = sanitizeRetiredModelMessages(result.chatHistory).messages
        const repairedHistory = repairMessageIds(sanitizedHistory, msgIdCounter).messages
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
        focusComposer()
      }
      if (result.pendingPageUrl) {
        setInput(previous => appendToInputValue(previous, result.pendingPageUrl))
        void chrome.storage.local.remove(['pendingPageUrl'])
        focusComposer()
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
        const pendingMigration = sanitizeRetiredModelSessions(
          Array.isArray(pendingSessionsChange) ? pendingSessionsChange : [],
        )
        nextSessions = pendingMigration.sessions.map(normalizeSessionMetadata)
        shouldPersistSessions = shouldPersistSessions || pendingMigration.changed
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
      setAttachments([])

      if (shouldPersistSessions) {
        void enqueueStorageWrite({ sessions: nextSessions, activeSessionId: nextActiveSessionId })
      }

      if (generation?.jobId && hasRetiredModelProvenance(generation)) {
        try {
          const cancellation = await sendRuntimeMessage({
            type: 'CANCEL',
            jobId: generation.jobId,
            reason: 'model_retired',
          })
          generation = cancellation?.activeGeneration || null
          if (generation) generation = stripRetiredModelProvenance(generation).value
        } catch (error) {
          console.error('Retired model generation cancellation failed', error)
          generation = null
          void chrome.storage.local.remove(['activeGeneration'])
        }
      }
      void cleanupOrphanAttachments(nextSessions).catch(error => {
        console.error('Attachment cleanup failed', error)
      })

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
        focusComposer()
      }
      if (changes.pendingPageUrl?.newValue) {
        setInput(previous => appendToInputValue(previous, changes.pendingPageUrl.newValue))
        void chrome.storage.local.remove(['pendingPageUrl'])
        focusComposer()
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
  }, [applyTheme, enqueueStorageWrite, focusComposer, persistAuthoritativeSessionRepair, setGenerating, stopAssistantDisplayQueue])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return

    if (forceScrollToBottomRef.current || autoScrollRef.current) {
      scheduleScrollToBottom()
      return
    }

    syncScrollControls()
  }, [messages, scheduleScrollToBottom, syncScrollControls])

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return undefined

    syncScrollControls()
    const ResizeObserverClass = globalThis.ResizeObserver
    const resizeObserver = typeof ResizeObserverClass === 'function'
      ? new ResizeObserverClass(syncScrollControls)
      : null
    resizeObserver?.observe(container)
    window.addEventListener('resize', syncScrollControls)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', syncScrollControls)
    }
  }, [appConfig, isLoading, syncScrollControls])

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
    setAttachments([])
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
      setAttachments([])
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
        setAttachments([])
        stickToBottomOnNextRender()
      }
      void cleanupOrphanAttachments(result.nextSessions).catch(error => console.error('Attachment cleanup failed', error))
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
      setAttachments([])
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

  const handleExportMarkdown = useCallback(() => {
    const session = sessionsRef.current.find(item => item?.id === activeSessionIdRef.current)
    if (!session || (session.messages || []).length === 0) {
      toast.error(t('chat.no_history'))
      return
    }
    exportSessionMarkdown(session)
    toast.success(t('chat.exported'))
  }, [t])

  const handleCopyChat = useCallback(async () => {
    const session = sessionsRef.current.find(item => item?.id === activeSessionIdRef.current)
    if (!session || (session.messages || []).length === 0) {
      toast.error(t('chat.no_history'))
      return
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable')
      await navigator.clipboard.writeText(sessionToMarkdown(session))
      toast.success(t('chat.tooltips.copied'))
    } catch {
      toast.error(t('chat.tooltips.copy_failed'))
    }
  }, [t])

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
      const importedRawSessions = await importSessions(file)
      const importedMigration = await migrateLegacySessionAttachments(importedRawSessions)
      const importedSessions = importedMigration.sessions
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
      setAttachments([])
      stickToBottomOnNextRender()
      toast.success(t('chat.imported'))
    } catch (err) {
      toast.error(err.message || t('chat.import_error'))
    }
    e.target.value = ''
  }, [cancelActiveGeneration, enqueueStorageWrite, stickToBottomOnNextRender, t])

  const setSpeechStatus = useCallback((nextState) => {
    speechStateRef.current = nextState
    setSpeechState(nextState)
  }, [])

  const stopSpeech = useCallback(() => {
    speechEpochRef.current += 1
    speechAbortRef.current?.abort()
    speechAbortRef.current = null
    if (speechSourceRef.current) {
      const source = speechSourceRef.current
      speechSourceRef.current = null
      try { source.stop() } catch (_error) { /* already stopped */ }
    }
    setSpeechStatus({ messageId: null, phase: 'idle' })
  }, [setSpeechStatus])

  const reportVoiceKeyStatus = useCallback(({ keyId, status }) => {
    if (!keyId || !status || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return
    try {
      const request = chrome.runtime.sendMessage({ type: 'KEY_STATUS', provider: 'gemini', keyId, status })
      request?.catch?.(() => undefined)
    } catch (_error) {
      // Key metadata is helpful but must never make a voice operation fail.
    }
  }, [])

  const playPcm = useCallback((pcm, sampleRate, epoch) => new Promise((resolve, reject) => {
    const context = speechContextRef.current
    if (!context || epoch !== speechEpochRef.current) {
      resolve()
      return
    }
    try {
      const source = context.createBufferSource()
      source.buffer = createAudioBufferFromPcm16(context, pcm, sampleRate)
      source.connect(context.destination)
      speechSourceRef.current = source
      source.onended = () => {
        if (speechSourceRef.current === source) speechSourceRef.current = null
        source.disconnect?.()
        resolve()
      }
      source.start(0)
    } catch (error) {
      reject(error)
    }
  }), [])

  const handleToggleSpeech = useCallback(async (message) => {
    if (!message?.id || isGenerating || dictationPhaseRef.current !== 'idle') return
    if (speechStateRef.current.messageId === message.id && speechStateRef.current.phase !== 'idle') {
      stopSpeech()
      return
    }

    stopSpeech()
    const speechText = normalizeMarkdownForSpeech(message.content, t('chat.code_block_skipped'))
    if (!speechText) return
    if (speechText.length > TTS_MAX_CHARS) {
      toast.error(t('chat.speech_too_long'))
      return
    }

    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext
    if (!AudioContextClass) {
      toast.error(t('chat.speech_failed'))
      return
    }
    if (!speechContextRef.current || speechContextRef.current.state === 'closed') {
      speechContextRef.current = new AudioContextClass()
    }
    void speechContextRef.current.resume?.()

    const resolution = await resolveKeysForRequest('gemini')
    if (!resolution.keys.length) {
      toast.error(t(`chat.generation_errors.${resolution.allInCooldown ? 'all_keys_cooldown' : 'api_key_missing'}`))
      return
    }

    const epoch = speechEpochRef.current
    const controller = new AbortController()
    speechAbortRef.current = controller
    setSpeechStatus({ messageId: message.id, phase: 'loading' })
    try {
      const chunks = splitSpeechText(speechText)
      for (const chunk of chunks) {
        if (controller.signal.aborted || epoch !== speechEpochRef.current) return
        const result = await generateSpeech({
          text: chunk,
          keys: resolution.keys,
          signal: controller.signal,
          onKeyStatus: reportVoiceKeyStatus,
        })
        if (controller.signal.aborted || epoch !== speechEpochRef.current) return
        setSpeechStatus({ messageId: message.id, phase: 'playing' })
        await playPcm(result.pcm, result.sampleRate, epoch)
        if (controller.signal.aborted || epoch !== speechEpochRef.current) return
        setSpeechStatus({ messageId: message.id, phase: 'loading' })
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.error('Gemini speech generation failed', error)
        toast.error(t('chat.speech_failed'))
      }
    } finally {
      if (epoch === speechEpochRef.current) {
        speechAbortRef.current = null
        setSpeechStatus({ messageId: null, phase: 'idle' })
      }
    }
  }, [isGenerating, playPcm, reportVoiceKeyStatus, setSpeechStatus, stopSpeech, t])

  const clearDictationTimers = useCallback(() => {
    if (dictationTimerRef.current != null) window.clearInterval(dictationTimerRef.current)
    if (dictationLimitRef.current != null) window.clearTimeout(dictationLimitRef.current)
    dictationTimerRef.current = null
    dictationLimitRef.current = null
  }, [])

  const releaseDictationStream = useCallback(() => {
    dictationStreamRef.current?.getTracks?.().forEach(track => track.stop())
    dictationStreamRef.current = null
  }, [])

  const resetDictation = useCallback(() => {
    clearDictationTimers()
    releaseDictationStream()
    dictationRecorderRef.current = null
    dictationChunksRef.current = []
    dictationShouldTranscribeRef.current = false
    dictationPhaseRef.current = 'idle'
    setDictationPhase('idle')
    setDictationSeconds(0)
  }, [clearDictationTimers, releaseDictationStream])

  const processDictation = useCallback(async (blob) => {
    dictationPhaseRef.current = 'transcribing'
    setDictationPhase('transcribing')
    const controller = new AbortController()
    dictationAbortRef.current = controller
    try {
      const wav = await recordedBlobToWav(blob)
      const transcript = await transcribeAudio({
        wavBase64: bytesToBase64(wav),
        keys: dictationKeysRef.current,
        signal: controller.signal,
        onKeyStatus: reportVoiceKeyStatus,
      })
      if (controller.signal.aborted) return
      if (!transcript) {
        toast.error(t('chat.voice_empty'))
        return
      }
      setInput(current => appendToInputValue(current, transcript))
      await updateStats('voice')
      window.requestAnimationFrame(() => focusComposer())
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.error('Gemini dictation failed', error)
        toast.error(t('chat.voice_failed'))
      }
    } finally {
      if (dictationAbortRef.current === controller) dictationAbortRef.current = null
      resetDictation()
    }
  }, [focusComposer, reportVoiceKeyStatus, resetDictation, t])

  const stopDictationRecording = useCallback((shouldTranscribe = true) => {
    const recorder = dictationRecorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    dictationShouldTranscribeRef.current = shouldTranscribe
    clearDictationTimers()
    recorder.stop()
    releaseDictationStream()
  }, [clearDictationTimers, releaseDictationStream])

  const cancelDictation = useCallback(() => {
    dictationStartEpochRef.current += 1
    micPermissionCancelRef.current?.()
    micPermissionCancelRef.current = null
    if (dictationPhaseRef.current === 'recording') {
      stopDictationRecording(false)
      return
    }
    dictationAbortRef.current?.abort()
    resetDictation()
  }, [resetDictation, stopDictationRecording])

  const requestMicrophonePermission = useCallback(async () => {
    try {
      const permission = await navigator.permissions?.query?.({ name: 'microphone' })
      if (permission?.state === 'granted') return true
    } catch (_error) {
      // Open the permission page when the Permissions API cannot report state.
    }
    if (!chrome?.windows?.create || !chrome.runtime?.onMessage) return false

    const requestId = globalThis.crypto?.randomUUID?.() || `mic-${Date.now()}-${Math.random().toString(36).slice(2)}`
    return new Promise((resolve) => {
      let permissionWindowId = null
      let settled = false
      const cleanup = () => {
        chrome.runtime.onMessage.removeListener(handleMessage)
        chrome.windows.onRemoved?.removeListener?.(handleWindowRemoved)
        if (micPermissionCancelRef.current === cancelPermission) micPermissionCancelRef.current = null
      }
      const finish = (granted) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(granted)
      }
      const handleMessage = (message) => {
        if (message?.type !== 'HERAAI_MIC_PERMISSION_RESULT' || message.requestId !== requestId) return false
        finish(message.granted === true)
        return false
      }
      const handleWindowRemoved = (windowId) => {
        if (windowId === permissionWindowId) finish(false)
      }
      const cancelPermission = () => finish(false)
      micPermissionCancelRef.current = cancelPermission
      chrome.runtime.onMessage.addListener(handleMessage)
      chrome.windows.onRemoved?.addListener?.(handleWindowRemoved)
      Promise.resolve(chrome.windows.create({
        url: chrome.runtime.getURL(`mic-permission.html?requestId=${encodeURIComponent(requestId)}`),
        type: 'popup',
        width: 420,
        height: 360,
      })).then(windowInfo => {
        permissionWindowId = windowInfo?.id ?? null
      }).catch(() => finish(false))
    })
  }, [])

  const startDictation = useCallback(async () => {
    if (isGenerating || dictationPhaseRef.current !== 'idle') return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast.error(t('chat.voice_error'))
      return
    }
    const resolution = await resolveKeysForRequest('gemini')
    if (!resolution.keys.length) {
      toast.error(t(`chat.generation_errors.${resolution.allInCooldown ? 'all_keys_cooldown' : 'api_key_missing'}`))
      return
    }
    stopSpeech()
    const startEpoch = ++dictationStartEpochRef.current
    dictationPhaseRef.current = 'requesting'
    setDictationPhase('requesting')
    if (!await requestMicrophonePermission()) {
      if (startEpoch !== dictationStartEpochRef.current) return
      resetDictation()
      toast.error(t('chat.voice_permission_denied'))
      return
    }
    if (startEpoch !== dictationStartEpochRef.current) return

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      })
      if (startEpoch !== dictationStartEpochRef.current) {
        stream.getTracks().forEach(track => track.stop())
        return
      }
      const preferredMime = MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined
      const recorder = preferredMime ? new MediaRecorder(stream, { mimeType: preferredMime }) : new MediaRecorder(stream)
      dictationStreamRef.current = stream
      dictationRecorderRef.current = recorder
      dictationChunksRef.current = []
      dictationKeysRef.current = resolution.keys
      dictationShouldTranscribeRef.current = true
      recorder.ondataavailable = event => {
        if (event.data?.size) dictationChunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const shouldTranscribe = dictationShouldTranscribeRef.current
        const blob = new Blob(dictationChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        if (shouldTranscribe && blob.size > 0) void processDictation(blob)
        else resetDictation()
      }
      recorder.onerror = () => {
        toast.error(t('chat.voice_failed'))
        resetDictation()
      }
      recorder.start()
      dictationPhaseRef.current = 'recording'
      setDictationPhase('recording')
      setDictationSeconds(0)
      const startedAt = Date.now()
      dictationTimerRef.current = window.setInterval(() => {
        setDictationSeconds(Math.min(60, Math.floor((Date.now() - startedAt) / 1000)))
      }, 250)
      dictationLimitRef.current = window.setTimeout(() => stopDictationRecording(true), DICTATION_MAX_DURATION_MS)
    } catch (error) {
      console.error('Microphone recording failed', error)
      releaseDictationStream()
      resetDictation()
      toast.error(error?.name === 'NotAllowedError' ? t('chat.voice_permission_denied') : t('chat.voice_error'))
    }
  }, [isGenerating, processDictation, releaseDictationStream, requestMicrophonePermission, resetDictation, stopDictationRecording, stopSpeech, t])

  const handleDictationToggle = useCallback(() => {
    if (dictationPhaseRef.current === 'recording') stopDictationRecording(true)
    else if (['requesting', 'transcribing'].includes(dictationPhaseRef.current)) cancelDictation()
    else void startDictation()
  }, [cancelDictation, startDictation, stopDictationRecording])

  useEffect(() => {
    if (isGenerating) stopSpeech()
  }, [isGenerating, stopSpeech])

  useEffect(() => {
    const handleVoiceVisibility = () => {
      if (document.visibilityState !== 'hidden') return
      stopSpeech()
      cancelDictation()
    }
    document.addEventListener('visibilitychange', handleVoiceVisibility)
    window.addEventListener('pagehide', handleVoiceVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVoiceVisibility)
      window.removeEventListener('pagehide', handleVoiceVisibility)
      stopSpeech()
      cancelDictation()
      speechContextRef.current?.close?.()
      speechContextRef.current = null
    }
  }, [cancelDictation, stopSpeech])

  useEffect(() => {
    stopSpeech()
  }, [activeSessionId, stopSpeech])

  const handleSend = useCallback(async (directActionText = null, actionOptions = {}) => {
    if (dictationPhaseRef.current !== 'idle') return
    stopSpeech()
    const hasDirectActionText = typeof directActionText === 'string'
    const safeInput = typeof input === 'string' ? input : ''
    const userText = hasDirectActionText ? directActionText : safeInput.trim()
    const retryUserMessage = actionOptions?.retryUserMessage
    const requestSessionId = activeSessionIdRef.current
    const requestSession = sessionsRef.current.find(session => session?.id === requestSessionId)
    const activeContextAttachments = activeAttachmentRefs(requestSession)
    const existingContextUrls = Array.isArray(requestSession?.activeWebUrls)
      ? requestSession.activeWebUrls
      : []
    const draftAttachmentIds = attachments.map(attachment => attachment?.id).filter(Boolean)
    const draftAttachments = retryUserMessage
      ? (Array.isArray(retryUserMessage.attachments) ? retryUserMessage.attachments : [])
      : attachments
    const canReusePreviousImage = !retryUserMessage
      && requestsPreviousImage(userText)
      && activeContextAttachments.length > 0
    const canReusePreviousWeb = !retryUserMessage
      && requestsPreviousWebSource(userText)
      && existingContextUrls.length > 0
    if (!userText && draftAttachments.length === 0) return
    if (activeGenerationRef.current?.jobId || cancellationPromiseRef.current) {
      toast.error(t('chat.generation_errors.already_running', {
        defaultValue: t('chat.connection_error'),
      }))
      return
    }
    if (isGeneratingRef.current) return

    const supportedModes = new Set(['chat', 'vision', 'web'])
    const autoDetectedUrls = retryUserMessage ? [] : listPublicUrls(userText)
    const automaticMode = (enableResearch || canReusePreviousWeb || autoDetectedUrls.length > 0)
      ? 'web'
      : (draftAttachments.length > 0 || canReusePreviousImage ? 'vision' : 'chat')
    let mode = supportedModes.has(actionOptions?.modeOverride)
      ? actionOptions.modeOverride
      : (supportedModes.has(retryUserMessage?.mode) ? retryUserMessage.mode : automaticMode)
    const requestModel = MODELS.includes(actionOptions?.modelOverride)
      ? actionOptions.modelOverride
      : selectedModel
    const requestProvider = getProviderForModel(requestModel, selectedProvider)

    let explicitUrls = []
    try {
      explicitUrls = mode === 'web'
        ? (retryUserMessage && Array.isArray(retryUserMessage.webUrls)
            ? retryUserMessage.webUrls
            : extractPublicUrls(userText))
        : []
    } catch (error) {
      const autoTriggered = mode === 'web'
        && !enableResearch
        && !canReusePreviousWeb
        && !retryUserMessage
        && error?.code === 'url_private'
      if (autoTriggered) {
        explicitUrls = []
        mode = 'chat'
      } else {
        toast.error(t(`chat.generation_errors.${error?.code || 'url_invalid'}`, {
          defaultValue: error?.message || t('chat.connection_error'),
        }))
        return
      }
    }
    const contextSelection = retryUserMessage
      ? { attachments: draftAttachments, urls: explicitUrls }
      : selectRequestContext({
          text: userText,
          draftAttachments,
          previousAttachments: activeContextAttachments,
          explicitUrls,
          previousUrls: existingContextUrls,
          includePreviousWeb: mode === 'web',
        })
    const sourceAttachments = contextSelection.attachments
    const requestUrls = contextSelection.urls
    if (!userText && sourceAttachments.length === 0) return
    if (
      requestProvider !== 'gemini'
      && sourceAttachments.some(attachment => attachment?.mimeType === 'application/pdf')
    ) {
      toast.error(t('chat.generation_errors.pdf_requires_gemini'))
      return
    }
    if (
      MODEL_CAPABILITIES[requestModel]?.supportsImage === false
      && sourceAttachments.some(attachment => attachment?.mimeType?.startsWith('image/'))
    ) {
      toast.error(t('chat.generation_errors.image_not_supported'))
      return
    }
    try {
      validateAttachmentGroup([], sourceAttachments)
    } catch (error) {
      toast.error(t(`chat.generation_errors.${error?.code || 'attachment_invalid'}`, {
        defaultValue: error?.message || t('chat.file_error'),
      }))
      return
    }
    if (!retryUserMessage && requestUrls.length > MAX_PUBLIC_URLS) {
      toast.error(t('chat.generation_errors.url_limit_exceeded'))
      return
    }
    const modeRequestUrls = mode === 'web' ? requestUrls : []
    const webContext = {
      kind: mode === 'web' ? (requestUrls.length > 0 ? 'url' : 'search') : 'none',
      urls: requestUrls,
    }
    let requestText = userText
    let displayContent = actionOptions?.displayContent
    if (modeRequestUrls.length > 0 && isUrlOnlyText(userText, modeRequestUrls)) {
      requestText = t('chat.prompts.summarize_urls')
      displayContent = userText
    } else if (!requestText && sourceAttachments.length > 0) {
      requestText = modeRequestUrls.length > 0
        ? t('chat.prompts.summarize_context')
        : t('chat.prompts.summarize_files')
      displayContent = ''
    }

    const messageAttachments = sourceAttachments.map(att => ({
      ...(att.id ? { id: att.id } : {}),
      ...(att.data ? { data: att.data } : {}),
      mimeType: att.mimeType,
      name: att.name,
      size: Number(att.size || 0),
      kind: att.kind || (att.mimeType?.startsWith('image/') ? 'image' : 'binary'),
      availability: att.availability || 'ready',
    }))
    const attachmentIds = messageAttachments.map(attachment => attachment.id).filter(Boolean)
    const nextActiveAttachmentIds = retryUserMessage
      ? (requestSession?.activeAttachmentIds || [])
      : (attachmentIds.length > 0 ? attachmentIds : (requestSession?.activeAttachmentIds || []))
    const nextActiveWebUrls = retryUserMessage
      ? existingContextUrls
      : (modeRequestUrls.length > 0 ? modeRequestUrls : existingContextUrls)
    const displayAttachmentIds = retryUserMessage
      ? (Array.isArray(retryUserMessage.displayAttachmentIds)
          ? retryUserMessage.displayAttachmentIds
          : attachmentIds)
      : draftAttachmentIds
    const displayWebUrls = retryUserMessage
      ? (Array.isArray(retryUserMessage.displayWebUrls)
          ? retryUserMessage.displayWebUrls
           : modeRequestUrls)
      : explicitUrls

    updateStats(mode === 'web' ? ['message', 'search'] : 'message')
    const userMessageId = createUniqueMessageId(msgIdCounter)
    const assistantMessageId = createUniqueMessageId(msgIdCounter)
    const requestId = `${Date.now()}-${assistantMessageId}`
    const jobId = requestId
    const startedAt = Date.now()
    const userMsg = retryUserMessage
      ? {
          ...retryUserMessage,
          id: userMessageId,
          content: requestText,
          attachments: messageAttachments,
          displayAttachmentIds,
          displayWebUrls,
          mode,
          webUrls: requestUrls,
          retryOfMessageId: retryUserMessage.id,
        }
      : createUserMessage({
          id: userMessageId,
          content: requestText,
          displayContent,
          attachments: messageAttachments,
          displayAttachmentIds,
          displayWebUrls,
          mode,
          webUrls: requestUrls,
        })
    const assistantMsg = createAssistantMessage({
      id: assistantMessageId,
      requestId,
      userMessageId,
      startedAt,
      model: requestModel,
      provider: requestProvider,
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
    const optimisticMessages = retryUserMessage
      ? [...messagesRef.current, userMsg, assistantMsg]
      : [...baseMessages, userMsg, assistantMsg]
    sessionsRef.current = sessionsRef.current.map(session => session?.id === requestSessionId
      ? {
          ...session,
          activeAttachmentIds: nextActiveAttachmentIds,
          activeWebUrls: nextActiveWebUrls,
        }
      : session)
    if (mountedRef.current) setSessions(sessionsRef.current)
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
      provider: requestProvider,
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
        provider: requestProvider,
        language: generation.language,
        sessionTitle,
        systemInstruction: appConfig?.systemInstruction || '',
        requestMessages,
        attachmentIds,
        activeAttachmentIds: nextActiveAttachmentIds,
        activeWebUrls: nextActiveWebUrls,
        webContext,
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
  }, [input, attachments, appConfig, enableResearch, selectedModel, selectedProvider, handleGenerationState, mergeSessionMessages, persistSessionMessagesFromLatestStorage, resolveSessionTitle, setGenerating, stickToBottomOnNextRender, stopAssistantDisplayQueue, stopSpeech, t])

  handleSendRef.current = handleSend


  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (dictationPhaseRef.current !== 'idle') return
      handleSend()
    }
  }, [handleSend])

  const processAttachmentFiles = useCallback(async (files, { append = false } = {}) => {
    const candidates = Array.from(files || [])
    if (
      candidates.length === 0
      || attachmentProcessingRef.current
      || activeGenerationRef.current?.jobId
    ) return

    attachmentProcessingRef.current = true
    setGenerating(true)
    const previousDrafts = attachments
    const baseDrafts = append ? previousDrafts : []
    const currentSession = sessionsRef.current.find(session => session?.id === activeSessionIdRef.current)
    const contextAttachments = activeAttachmentRefs(currentSession)
    const accepted = []
    let totalTextChars = 0

    try {
      for (const file of candidates) {
        try {
          validateAttachmentGroup([file], [...contextAttachments, ...baseDrafts, ...accepted])
          const prepared = await processAttachmentFile(file)
          const nextTextChars = totalTextChars + Number(prepared.modelText?.length || 0)
          if (nextTextChars > 1_000_000) {
            const error = new Error('Extracted attachment text exceeds 1,000,000 characters.')
            error.code = 'attachment_text_too_large'
            throw error
          }
          accepted.push(await putAttachment(prepared))
          totalTextChars = nextTextChars
        } catch (error) {
          console.error('File processing error', error)
          toast.error(t(`chat.generation_errors.${error?.code || 'attachment_invalid'}`, {
            defaultValue: error?.message || t('chat.file_error'),
          }))
        }
      }

      if (accepted.length > 0) {
        setAttachments(previous => (append
          ? mergeAttachmentRefs(previous, accepted)
          : accepted))

        if (!append) {
          const keptIds = new Set(accepted.map(attachment => attachment.id).filter(Boolean))
          const referencedIds = attachmentIdsFromSessions(sessionsRef.current)
          for (const attachment of previousDrafts) {
            if (
              attachment?.id
              && !keptIds.has(attachment.id)
              && !referencedIds.has(attachment.id)
            ) {
              void deleteAttachment(attachment.id).catch(error => {
                console.error('Draft attachment cleanup failed', error)
              })
            }
          }
        }
      }
    } finally {
      attachmentProcessingRef.current = false
      setGenerating(Boolean(activeGenerationRef.current?.jobId))
    }
  }, [attachments, setGenerating, t])

  const handleFileChange = useCallback(async (event) => {
    await processAttachmentFiles(event.target.files, { append: false })
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [processAttachmentFiles])

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
    setAttachments(previous => {
      const removed = previous[index]
      const next = previous.filter((_, itemIndex) => itemIndex !== index)
      const referencedIds = attachmentIdsFromSessions(sessionsRef.current)
      if (removed?.id && !referencedIds.has(removed.id)) {
        void deleteAttachment(removed.id).catch(error => {
          console.error('Draft attachment cleanup failed', error)
        })
      }
      return next
    })
  }, [])

  const removeDraftWebUrl = useCallback((url) => {
    setInput(previous => removePublicUrlFromText(previous, url))
  }, [])

  const handlePaste = useCallback(async (event) => {
    const clipboardData = event.clipboardData
    const items = Array.from(clipboardData?.items || [])
    const pastedImages = items
      .filter(item => SUPPORTED_PASTED_IMAGE_TYPES.has(item.type))
      .map((item, index) => {
        const file = item.getAsFile()
        if (!file) return null
        const extension = file.type === 'image/jpeg' ? 'jpg' : (file.type === 'image/webp' ? 'webp' : 'png')
        return new File(
          [file],
          `pasted-image-${Date.now()}-${index + 1}.${extension}`,
          { type: file.type || 'image/png' },
        )
      })
      .filter(Boolean)
    if (pastedImages.length === 0) return

    event.preventDefault()
    const pastedText = clipboardData?.getData('text/plain') || ''
    if (pastedText) {
      const textarea = event.currentTarget
      const currentValue = typeof textarea.value === 'string' ? textarea.value : ''
      const selectionStart = Number.isInteger(textarea.selectionStart)
        ? textarea.selectionStart
        : currentValue.length
      const selectionEnd = Number.isInteger(textarea.selectionEnd)
        ? textarea.selectionEnd
        : selectionStart
      const nextValue = `${currentValue.slice(0, selectionStart)}${pastedText}${currentValue.slice(selectionEnd)}`
      const nextCaretPosition = selectionStart + pastedText.length
      setInput(nextValue)
      window.requestAnimationFrame(() => focusComposer(nextCaretPosition))
    }

    await processAttachmentFiles(pastedImages, { append: true })
  }, [focusComposer, processAttachmentFiles])

  const handleAddCurrentPage = useCallback(async () => {
    if (isGeneratingRef.current || dictationPhaseRef.current !== 'idle') return
    try {
      const queryTabs = typeof chrome !== 'undefined' ? chrome.tabs?.query : null
      if (typeof queryTabs !== 'function') {
        throw Object.assign(new Error('Tabs API is unavailable'), { code: 'url_invalid' })
      }
      const tabs = await queryTabs.call(chrome.tabs, { active: true, currentWindow: true })
      const url = tabs?.[0]?.url
      if (!url) {
        throw Object.assign(new Error('No page URL'), { code: 'url_invalid' })
      }
      const normalized = normalizePublicUrl(url)
      setInput(previous => appendToInputValue(previous, normalized))
      window.requestAnimationFrame(() => focusComposer())
    } catch (error) {
      toast.error(t(`chat.generation_errors.${error?.code || 'url_invalid'}`, {
        defaultValue: error?.message || t('chat.connection_error'),
      }))
    }
  }, [focusComposer, t])

  const hasDraggedFiles = useCallback(dataTransfer => (
    Array.from(dataTransfer?.types || []).includes('Files')
  ), [])

  const resetFileDrag = useCallback(() => {
    fileDragDepthRef.current = 0
    setIsFileDragActive(false)
  }, [])

  const handleFileDragEnter = useCallback((event) => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    if (isGenerating || dictationPhase !== 'idle' || showSettings) return
    fileDragDepthRef.current += 1
    setIsFileDragActive(true)
  }, [dictationPhase, hasDraggedFiles, isGenerating, showSettings])

  const handleFileDragOver = useCallback((event) => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = (
      isGenerating || dictationPhase !== 'idle' || showSettings
    ) ? 'none' : 'copy'
  }, [dictationPhase, hasDraggedFiles, isGenerating, showSettings])

  const handleFileDragLeave = useCallback((event) => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1)
    if (fileDragDepthRef.current === 0) setIsFileDragActive(false)
  }, [hasDraggedFiles])

  const handleFileDrop = useCallback(async (event) => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    const files = Array.from(event.dataTransfer?.files || [])
    resetFileDrag()
    if (isGenerating || dictationPhase !== 'idle' || showSettings) return
    await processAttachmentFiles(files, { append: true })
  }, [dictationPhase, hasDraggedFiles, isGenerating, processAttachmentFiles, resetFileDrag, showSettings])

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
    syncScrollControls()
  }, [syncScrollControls])

  const scrollToTop = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pauseAutoScroll()
    el.scrollTop = 0
    syncScrollControls()
  }, [pauseAutoScroll, syncScrollControls])

  const handleEditMessage = useCallback((text) => {
    setInput(text)
    setTimeout(() => {
      focusComposer(text.length)
    }, 50)
  }, [focusComposer])

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
    syncScrollControls()
    const distanceFromBottom = getScrollDistanceFromBottom(container)
    const isAtBottom = distanceFromBottom <= SCROLL_RESUME_THRESHOLD_PX
    const nearBottom = isScrollNearBottom(container)

    if (isAtBottom) {
      userPausedAutoScrollRef.current = false
      autoScrollRef.current = true
      forceScrollToBottomRef.current = false
      return
    }

    if (scheduledScrollFrameRef.current != null && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(scheduledScrollFrameRef.current)
      scheduledScrollFrameRef.current = null
    }
    forceScrollToBottomRef.current = false
    if (userPausedAutoScrollRef.current) {
      autoScrollRef.current = false
      return
    }

    autoScrollRef.current = nearBottom
  }, [syncScrollControls])

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

  const handleComposerPointerDown = useCallback((event) => {
    if (event.button !== 0) return
    if (event.target.closest?.('button, input, select, textarea, a, [role="button"]')) return
    focusComposer()
  }, [focusComposer])

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
    const nextProvider = getProviderForModel(nextModel)
    setSelectedModel(nextModel)
    setSelectedProvider(nextProvider)
    if (chrome && chrome.storage) {
      chrome.storage.local.set({ selectedModel: nextModel, selectedProvider: nextProvider })
    }
  }

  return (
    <div
      className="hera-panel relative flex h-screen min-h-0 min-w-0 flex-col overflow-hidden text-foreground"
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
      onDragEnd={resetFileDrag}
    >
      {isFileDragActive && (
        <div
          data-testid="file-drop-overlay"
          className="pointer-events-none absolute inset-2 z-[60] flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/90 p-6 backdrop-blur-sm"
        >
          <div className="rounded-xl bg-primary/10 px-5 py-3 text-center text-sm font-semibold text-primary shadow-sm">
            {t('chat.drop_files')}
          </div>
        </div>
      )}
      <AppHeader
        activeSessionTitle={activeSessionTitle}
        onRenameSession={(nextTitle) => renameSession(activeSessionId, nextTitle)}
        onNewChat={startNewSession}
        onHistory={() => setShowHistory(true)}
        onClear={requestBulkDelete}
        onExport={handleExport}
        onExportMarkdown={handleExportMarkdown}
        onCopyChat={handleCopyChat}
        onImport={handleImport}
        onSettings={() => setShowSettings(true)}
        onStats={() => setShowStats(true)}
        searchOpen={chatSearchOpen}
        searchQuery={chatSearchQuery}
        searchCounterText={chatSearchCounterText}
        onToggleSearch={() => {
          if (chatSearchOpen) closeChatSearch()
          else {
            setChatSearchIndex(0)
            setChatSearchOpen(true)
          }
        }}
        onSearchQueryChange={setChatSearchQuery}
        onSearchPrev={() => stepChatSearch(-1)}
        onSearchNext={() => stepChatSearch(1)}
        onCloseSearch={closeChatSearch}
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

      <div className="relative min-h-0 flex-1">
        <main
          className="h-full min-h-0 overscroll-contain overflow-x-hidden overflow-y-auto"
          style={{ overflowAnchor: 'none' }}
          ref={scrollRef}
          onScroll={handleChatScroll}
          onWheelCapture={handleChatWheel}
        >
          {isWelcomeOnly ? (
          <WelcomeScreen
            onCrop={handleScreenshot}
            isCropActive={isCropActive}
            onResearch={() => {
              setEnableResearch(true)
              setActiveMode('web')
              focusComposer()
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
                  searchMatch={chatSearchOpen && chatSearchMatchIds.includes(msg.id)}
                  searchCurrent={msg.id != null && msg.id === currentChatSearchId}
                  onEdit={handleEditMessage}
                  onRetry={handleRetryMessage}
                  retryModels={localizedModelCatalog}
                  modelLabels={localizedModelLabels}
                  currentModel={selectedModel}
                  retryDisabled={isGenerating}
                  showSources={appConfig.showSources}
                  speechEnabled
                  speechDisabled={isGenerating || dictationPhase !== 'idle'}
                  speechStatus={speechState.messageId === msg.id ? speechState.phase : 'idle'}
                  onToggleSpeech={handleToggleSpeech}
                />
              )
            })}
          </div>
          )}
        </main>

        {canScrollUp && (
          <button
            type="button"
            onClick={scrollToTop}
            title={t('chat.tooltips.scroll_to_start')}
            aria-label={t('chat.tooltips.scroll_to_start')}
            className="hera-icon-button absolute right-3 top-3 z-20 h-9 w-9 border border-primary/20 bg-popover shadow-lg hover:bg-secondary"
          >
            <ArrowUpToLine className="h-4 w-4" />
          </button>
        )}
        {canScrollDown && (
          <button
            type="button"
            onClick={scrollToBottom}
            title={t('chat.tooltips.scroll_to_end')}
            aria-label={t('chat.tooltips.scroll_to_end')}
            className="hera-icon-button absolute bottom-3 right-3 z-20 h-9 w-9 border border-primary/20 bg-popover shadow-lg hover:bg-secondary"
          >
            <ArrowDownToLine className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="p-4 bg-background shrink-0 border-t border-border/60" onWheel={handleComposerWheel}>
        <div
          className="hera-surface mx-auto w-full max-w-3xl overflow-hidden rounded-2xl transition-shadow focus-within:border-primary/35 focus-within:shadow-lg focus-within:shadow-primary/5"
          onPointerDown={handleComposerPointerDown}
        >
          {draftWebUrls.length > 0 && enableResearch && (
            <div className="flex gap-1.5 overflow-x-auto border-b border-border/60 px-3 py-2">
              {draftWebUrls.map(url => (
                <div key={url} className="group relative flex max-w-[240px] shrink-0 items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 py-1 pl-2 pr-7 text-[11px]">
                  <Globe className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <span className="truncate">{url}</span>
                  <button
                    type="button"
                    onClick={() => removeDraftWebUrl(url)}
                    aria-label={t('chat.tooltips.remove_link')}
                    className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="flex gap-1.5 overflow-x-auto border-b border-border/60 px-3 py-2">
              {attachments.map((att, idx) => (
                <div key={`${att.name}-${idx}`} className="group relative flex max-w-[170px] shrink-0 items-center gap-2 rounded-lg border border-border/70 bg-secondary/65 py-1 pl-1 pr-7">
                  {att.mimeType.startsWith('image/') && att.data ? (
                    <img src={`data:${att.mimeType};base64,${att.data}`} alt="" className="h-7 w-7 rounded-md object-cover" />
                  ) : (
                    <span className="flex h-7 w-7 items-center justify-center rounded-md bg-background/70">
                      <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    </span>
                  )}
                  <span className="truncate text-[11px]">{att.name}</span>
                  {att.availability && att.availability !== 'ready' && (
                    <span className="text-[10px] text-destructive">{t('chat.attachment_unavailable')}</span>
                  )}
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
            ref={composerInputRef}
            autoFocus
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
                accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp,.pdf,.docx,.xlsx,.xls,.txt,.csv,.json,.xml,.html,.htm,.md"
                multiple
              />
              <button
                type="button"
                title={t('chat.tooltips.attach_file')}
                aria-label={t('chat.tooltips.attach_file')}
                onClick={() => fileInputRef.current?.click()}
                className={getQuickActionClass()}
                disabled={isGenerating || dictationPhase !== 'idle'}
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <button
                  type="button"
                  title={dictationPhase === 'recording'
                    ? t('chat.tooltips.stop_recording')
                    : dictationPhase === 'requesting'
                      ? t('chat.tooltips.requesting_microphone')
                      : dictationPhase === 'transcribing'
                      ? t('chat.tooltips.cancel_transcription')
                      : t('chat.tooltips.voice_input')}
                  aria-label={dictationPhase === 'recording'
                    ? t('chat.tooltips.stop_recording')
                    : dictationPhase === 'requesting'
                      ? t('chat.tooltips.requesting_microphone')
                      : dictationPhase === 'transcribing'
                      ? t('chat.tooltips.cancel_transcription')
                      : t('chat.tooltips.voice_input')}
                  aria-pressed={dictationPhase !== 'idle'}
                  onClick={handleDictationToggle}
                  disabled={isGenerating}
                  className={getQuickActionClass(dictationPhase !== 'idle')}
                >
                  {['requesting', 'transcribing'].includes(dictationPhase)
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : dictationPhase === 'recording'
                      ? <Square className="h-3.5 w-3.5 fill-current" />
                      : <Mic className="h-4 w-4" />}
              </button>
              {dictationPhase === 'recording' && (
                <span className="shrink-0 px-1 text-[10px] font-medium tabular-nums text-destructive">
                  {String(Math.floor(dictationSeconds / 60)).padStart(2, '0')}:{String(dictationSeconds % 60).padStart(2, '0')}
                </span>
              )}
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
                disabled={(isGenerating || dictationPhase !== 'idle') && !isCropActive}
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
                disabled={isGenerating || dictationPhase !== 'idle'}
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
                disabled={isGenerating || dictationPhase !== 'idle' || !hasImageAttachment}
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
                disabled={isGenerating || dictationPhase !== 'idle'}
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
                disabled={isGenerating || dictationPhase !== 'idle'}
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
                disabled={isGenerating || dictationPhase !== 'idle'}
                className={getQuickActionClass(activeMode === 'explain')}
              >
                <Lightbulb className="h-4 w-4" />
              </button>
              <button
                type="button"
                title={t('chat.tooltips.add_current_page')}
                aria-label={t('chat.tooltips.add_current_page')}
                onClick={handleAddCurrentPage}
                disabled={isGenerating || dictationPhase !== 'idle'}
                className={getQuickActionClass()}
              >
                <Link2 className="h-4 w-4" />
              </button>
            </div>

            <button
              type="button"
              onClick={() => isGenerating ? cancelStream() : handleSend()}
              disabled={dictationPhase !== 'idle' || (!isGenerating && (!input.trim() && attachments.length === 0))}
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
            models={localizedModelCatalog}
            modelLabels={localizedModelLabels}
            onModelChange={handleModelChange}
          />
          <p data-testid="composer-disclaimer" className="min-w-0 flex-1 whitespace-pre-line text-right text-[11px] leading-tight text-muted-foreground/55" title={t('chat.ai_disclaimer')}>
            {t('chat.ai_disclaimer')}
          </p>
        </div>
      </div>
    </div>
  )
}

export default App
