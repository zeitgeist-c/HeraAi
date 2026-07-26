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
import { injectCropOverlay } from './lib/injectCropOverlay'
import { streamChat, streamResearch, streamVision, MODELS, DEFAULT_MODEL } from './lib/api'
import { fileToBase64 } from './lib/fileParsers'
import { exportSessions, importSessions } from './lib/importExport'
import i18n from './i18n'
import { updateStats } from './lib/stats'
import { resolveKeysForRequest, updateKeyMetadata } from './lib/keyManager'

function appendToInputValue(current, text) {
  const safeCurrent = typeof current === 'string' ? current : ''
  const safeText = typeof text === 'string' ? text.trim() : ''
  if (!safeText) return safeCurrent
  const separator = safeCurrent.trim() ? '\n' : ''
  return `${safeCurrent}${separator}${safeText}`
}

const SCROLL_BOTTOM_THRESHOLD_PX = 96
const SCROLL_RESUME_THRESHOLD_PX = 2
const REQUEST_TIMEOUT_MS = 90_000
const STREAM_SHORT_BUFFER = 160
const STREAM_LONG_BUFFER = 600
const MODEL_LABELS = {
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
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

function waitForVisiblePaint() {
  return new Promise(resolve => {
    if (typeof window.requestAnimationFrame !== 'function') {
      window.setTimeout(resolve, 0)
      return
    }

    window.requestAnimationFrame(() => window.setTimeout(resolve, 0))
  })
}

function getStreamDisplayStep(bufferLength) {
  if (bufferLength > STREAM_LONG_BUFFER) return { characters: 12, delay: 16 }
  if (bufferLength > STREAM_SHORT_BUFFER) return { characters: 6, delay: 20 }
  return { characters: 3, delay: 24 }
}

function takeUnicodeCharacters(text, count) {
  return Array.from(text).slice(0, count).join('')
}

function createUserMessage({ id, content, attachments, mode }) {
  return {
    id,
    role: 'user',
    content,
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

function finalizeAssistantMessage(message, { content, status, sources }) {
  return {
    ...message,
    content,
    status,
    sources
  }
}

function markAssistantError(message, content = '') {
  return finalizeAssistantMessage(message, {
    content,
    status: 'error',
    sources: Array.isArray(message.sources) ? message.sources : []
  })
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
  const [showStats, setShowStats] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [enableResearch, setEnableResearch] = useState(false)
  const [activeMode, setActiveMode] = useState(null)
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL)
  const msgIdCounter = useRef(0)
  const scrollRef = useRef(null)
  const fileInputRef = useRef(null)
  const streamingControllerRef = useRef(null)
  const streamBufferRef = useRef('')
  const displayedAssistantContentRef = useRef('')
  const streamFlushTimerRef = useRef(null)
  const streamDrainResolversRef = useRef([])
  const streamTargetMessageIdRef = useRef(null)
  const streamAbortReasonRef = useRef(null)
  const scheduledScrollFrameRef = useRef(null)
  const cropProcessingRef = useRef(false)
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
    const firstUserMsg = msgs.find(m => m.role === 'user')
    if (firstUserMsg && firstUserMsg.content) {
      return firstUserMsg.content.length > 30 ? firstUserMsg.content.substring(0, 30) + '...' : firstUserMsg.content
    }
    return t('chat.new_chat')
  }, [t])

  const persistCurrentSession = useCallback((nextMessages) => {
    if (!activeSessionId || !nextMessages?.length) return

    setSessions(prev => {
      const existing = prev.find(s => s.id === activeSessionId)

      if (nextMessages.length === 1 && nextMessages[0].role === 'model' && !existing) {
        return prev
      }

      const others = prev.filter(s => s.id !== activeSessionId)
      const newArr = [...others, {
        id: activeSessionId,
        title: generateTitle(nextMessages),
        updatedAt: Date.now(),
        messages: nextMessages
      }]

      if (chrome && chrome.storage) {
        chrome.storage.local.set({ sessions: newArr, activeSessionId })
      }

      return newArr
    })
  }, [activeSessionId, generateTitle])

  const appendAssistantTextToMessage = useCallback((messageId, text) => {
    if (!text || messageId == null) return

    setMessages(prev => prev.map(message => (
      message.id === messageId && message.role === 'model'
        ? { ...message, content: `${message.content || ''}${text}`, status: 'streaming' }
        : message
    )))
  }, [])

  const resolveStreamDrainWaiters = useCallback(() => {
    const resolvers = streamDrainResolversRef.current
    streamDrainResolversRef.current = []
    resolvers.forEach(resolve => resolve())
  }, [])

  const stopAssistantDisplayQueue = useCallback((discardPending = true) => {
    if (streamFlushTimerRef.current) {
      window.clearTimeout(streamFlushTimerRef.current)
      streamFlushTimerRef.current = null
    }
    if (discardPending) streamBufferRef.current = ''
    resolveStreamDrainWaiters()
  }, [resolveStreamDrainWaiters])

  const queueAssistantText = useCallback((messageId, text) => {
    if (!text || messageId == null) return

    streamBufferRef.current += text
    if (streamFlushTimerRef.current) return

    const pump = () => {
      const { characters, delay } = getStreamDisplayStep(streamBufferRef.current.length)
      const nextSlice = takeUnicodeCharacters(streamBufferRef.current, characters)
      streamBufferRef.current = streamBufferRef.current.slice(nextSlice.length)
      displayedAssistantContentRef.current += nextSlice
      appendAssistantTextToMessage(messageId, nextSlice)

      if (streamBufferRef.current) {
        streamFlushTimerRef.current = window.setTimeout(pump, delay)
        return
      }

      streamFlushTimerRef.current = null
      resolveStreamDrainWaiters()
    }

    streamFlushTimerRef.current = window.setTimeout(pump, 0)
  }, [appendAssistantTextToMessage, resolveStreamDrainWaiters])

  const drainAssistantBuffer = useCallback(() => {
    if (!streamBufferRef.current && !streamFlushTimerRef.current) return Promise.resolve()
    return new Promise(resolve => {
      streamDrainResolversRef.current.push(resolve)
    })
  }, [])

  useEffect(() => () => {
    stopAssistantDisplayQueue(true)
  }, [stopAssistantDisplayQueue])

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

  useEffect(() => {
    const listener = async (msg) => {
      if (msg.type === 'HERAAI_CROP_DONE' && !cropProcessingRef.current) {
        cropProcessingRef.current = true;
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
          setGenerating(false);
          cropProcessingRef.current = false;
        }
      }
    };
    if (chrome && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(listener);
    }
    return () => {
      if (chrome && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.removeListener(listener);
      }
    }
  }, [captureScreenshot, setGenerating, t])

  useEffect(() => {
    if (prevIsGeneratingRef.current && !isGenerating && activeMode && activeMode !== 'web') {
      setActiveMode(null);
    }
    prevIsGeneratingRef.current = isGenerating;
  }, [isGenerating, activeMode])

  useEffect(() => {
    if (chrome && chrome.storage) {
      chrome.storage.local.get(['theme', 'startupBehavior', 'systemInstruction', 'chatHistory', 'sessions', 'activeSessionId', 'customPrimaryColor', 'language', 'selectedText', 'selectedModel'], (result) => {
        const config = {
          theme: result.theme || 'system',
          startupBehavior: result.startupBehavior || 'resume',
          systemInstruction: result.systemInstruction || '',
          customPrimaryColor: result.customPrimaryColor || '#7c5cff',
          language: result.language || 'tr',
        }

        setAppConfig(config)
        applyTheme(config.theme, config.customPrimaryColor)

        if (result.language) {
          i18n.changeLanguage(result.language)
        }

        if (result.selectedModel && MODELS.includes(result.selectedModel)) {
          setSelectedModel(result.selectedModel)
        } else {
          setSelectedModel(DEFAULT_MODEL)
        }

        const welcomeMsg = [{ id: msgIdCounter.current++, role: 'model', content: t('chat.welcome') }]

        if (result.sessions && result.sessions.length > 0) {
          setSessions(result.sessions)

          if (config.startupBehavior === 'resume') {
            const currId = result.activeSessionId || result.sessions[0].id
            setActiveSessionId(currId)
            const currSession = result.sessions.find(s => s.id === currId) || result.sessions[0]
            setMessages(currSession.messages || welcomeMsg)
          } else {
            const id = Date.now().toString()
            setActiveSessionId(id)
            setSessions(prev => [...prev, { id, title: t('chat.new_chat'), updatedAt: Date.now(), messages: welcomeMsg }])
            setMessages(welcomeMsg)
          }

        } else if (result.chatHistory && result.chatHistory.length > 1) {
          const id = Date.now().toString()
          const newSession = { id, title: t('chat.history_title'), updatedAt: Date.now(), messages: result.chatHistory }
          setSessions([newSession])

          if (config.startupBehavior === 'resume') {
            setActiveSessionId(id)
            setMessages(result.chatHistory)
          } else {
            const newId = Date.now().toString() + '1'
            setActiveSessionId(newId)
            setSessions(prev => [...prev, { id: newId, title: t('chat.new_chat'), updatedAt: Date.now(), messages: welcomeMsg }])
            setMessages(welcomeMsg)
          }

        } else {
          const id = Date.now().toString()
          setActiveSessionId(id)
          setSessions([{ id, title: t('chat.new_chat'), updatedAt: Date.now(), messages: welcomeMsg }])
          setMessages(welcomeMsg)
        }
        setIsLoading(false)

        if (result.selectedText) {
          setInput(prev => appendToInputValue(prev, result.selectedText))
          chrome.storage.local.remove(['selectedText'])
        }
      })

      const storageListener = (changes, namespace) => {
        if (namespace === 'local' && changes.selectedText && changes.selectedText.newValue) {
          setInput(prev => appendToInputValue(prev, changes.selectedText.newValue));
          chrome.storage.local.remove(['selectedText']);
        }
      };

      chrome.storage.onChanged.addListener(storageListener)

      return () => {
        chrome.storage.onChanged.removeListener(storageListener)
      }
    } else {
      setIsLoading(false)
      const id = Date.now().toString()
      const welcomeMsg = [{ id: msgIdCounter.current++, role: 'model', content: t('chat.welcome') }]
      setActiveSessionId(id)
      setSessions([{ id, title: t('chat.new_chat'), updatedAt: Date.now(), messages: welcomeMsg }])
      setMessages(welcomeMsg)
    }
  }, [t, applyTheme])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return

    if (forceScrollToBottomRef.current || autoScrollRef.current) {
      container.scrollTop = container.scrollHeight
      forceScrollToBottomRef.current = false
      autoScrollRef.current = true
      userPausedAutoScrollRef.current = false
      setShowScrollDownBtn(false)
      return
    }

    setShowScrollDownBtn(true)
  }, [messages])

  const startNewSession = useCallback(() => {
    if (streamingControllerRef.current) {
      streamAbortReasonRef.current = 'session'
      streamingControllerRef.current.abort()
      streamingControllerRef.current = null
    }
    stopAssistantDisplayQueue(true)
    setGenerating(false)
    streamTargetMessageIdRef.current = null

    const id = Date.now().toString()
    const welcomeMsg = [{ id: msgIdCounter.current++, role: 'model', content: t('chat.welcome') }]
    setActiveSessionId(id)
    setSessions(prev => {
      const next = [...prev, { id, title: t('chat.new_chat'), updatedAt: Date.now(), messages: welcomeMsg }]
      if (chrome && chrome.storage) {
        chrome.storage.local.set({ sessions: next, activeSessionId: id })
      }
      return next
    })
    setMessages(welcomeMsg)
    setShowHistory(false)
    stickToBottomOnNextRender()
  }, [setGenerating, stickToBottomOnNextRender, stopAssistantDisplayQueue, t])

  const loadSession = useCallback((id) => {
    const session = sessions.find(s => s.id === id)
    if (session) {
      setActiveSessionId(id)
      setMessages(session.messages)
      stickToBottomOnNextRender()
      if (chrome && chrome.storage) {
        chrome.storage.local.set({ activeSessionId: id })
      }
    }
    setShowHistory(false)
  }, [sessions, stickToBottomOnNextRender])

  const deleteSession = useCallback((id) => {
    const remainingSessions = sessions.filter(s => s.id !== id)
    let nextSessions = remainingSessions
    let nextActiveSessionId = activeSessionId
    let nextMessages = messages

    if (activeSessionId === id) {
      if (remainingSessions.length > 0) {
        const nextSession = remainingSessions[0]
        nextActiveSessionId = nextSession.id
        nextMessages = nextSession.messages || []
      } else {
        const newId = Date.now().toString()
        const welcomeMsg = [{ id: msgIdCounter.current++, role: 'model', content: t('chat.welcome') }]
        const newSession = { id: newId, title: t('chat.new_chat'), updatedAt: Date.now(), messages: welcomeMsg }
        nextSessions = [newSession]
        nextActiveSessionId = newId
        nextMessages = welcomeMsg
      }
    }

    setSessions(nextSessions)
    setActiveSessionId(nextActiveSessionId)
    if (activeSessionId === id) {
      setMessages(nextMessages)
      stickToBottomOnNextRender()
    }
    if (chrome && chrome.storage) {
      chrome.storage.local.set({ sessions: nextSessions, activeSessionId: nextActiveSessionId })
    }
  }, [activeSessionId, messages, sessions, stickToBottomOnNextRender, t])

  const clearHistory = useCallback(() => {
    setSessions([])
    if (chrome && chrome.storage) {
      chrome.storage.local.remove(['sessions', 'activeSessionId', 'chatHistory'])
    }
    startNewSession()
    toast.success(t('chat.history_cleared'))
  }, [t, startNewSession])

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
      const importedSessions = await importSessions(file)
      setSessions(importedSessions)
      if (importedSessions.length > 0) {
        setActiveSessionId(importedSessions[0].id)
        setMessages(importedSessions[0].messages || [])
        stickToBottomOnNextRender()
        if (chrome && chrome.storage) {
          chrome.storage.local.set({ sessions: importedSessions, activeSessionId: importedSessions[0].id })
        }
      }
      toast.success(t('chat.imported'))
    } catch (err) {
      toast.error(err.message || t('chat.import_error'))
    }
    e.target.value = ''
  }, [stickToBottomOnNextRender, t])

  const handleSend = useCallback(async (directActionText = null, actionOptions = {}) => {
    const actualText = typeof directActionText === 'string' ? directActionText : null;
    const safeInput = typeof input === 'string' ? input : '';
    const userText = actualText || safeInput.trim();
    if ((!userText && attachments.length === 0) || isGeneratingRef.current) return

    const automaticMode = enableResearch ? 'web' : (attachments.length > 0 ? 'vision' : 'chat')
    const supportedModes = new Set(['chat', 'vision', 'web'])
    const mode = supportedModes.has(actionOptions?.modeOverride)
      ? actionOptions.modeOverride
      : automaticMode

    const messageAttachments = attachments.map(att => ({
      data: att.data,
      mimeType: att.mimeType,
      name: att.name
    }))

    updateStats(mode === 'web' ? ['message', 'search'] : 'message')
    const userMessageId = msgIdCounter.current++
    const assistantMessageId = msgIdCounter.current++
    const requestId = `${Date.now()}-${assistantMessageId}`
    const startedAt = Date.now()
    const userMsg = createUserMessage({
      id: userMessageId,
      content: userText,
      attachments: messageAttachments,
      mode
    })
    const assistantMsg = createAssistantMessage({
      id: assistantMessageId,
      requestId,
      userMessageId,
      startedAt
    })
    const baseMessages = normalizeConversationMessages(messages)
    const requestMessages = [...baseMessages, userMsg]
    let shouldDropEmptyAssistant = false
    let finalMessages = null
    let assistantContent = ''
    let assistantSources = []
    let assistantStatus = 'done'
    let requestTimedOut = false

    streamTargetMessageIdRef.current = assistantMessageId
    streamAbortReasonRef.current = null
    streamBufferRef.current = ''
    displayedAssistantContentRef.current = ''
    streamDrainResolversRef.current = []

    flushSync(() => {
      setGenerating(true)
      stickToBottomOnNextRender()
      setMessages([...baseMessages, userMsg, assistantMsg])
      setInput('')
      setAttachments([])
    })

    const controller = new AbortController()
    streamingControllerRef.current = controller
    const requestTimeoutId = window.setTimeout(() => {
      requestTimedOut = true
      streamAbortReasonRef.current = 'timeout'
      controller.abort()
    }, REQUEST_TIMEOUT_MS)

    try {
      await waitForVisiblePaint()
      if (controller.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }

      const geminiResolved = await resolveKeysForRequest('gemini')
      if (geminiResolved.allInCooldown) {
        const timeStr = new Date(geminiResolved.earliestCooldownEnd).toLocaleTimeString()
        const cooldownError = new Error(t('chat.all_keys_cooldown', { time: timeStr }))
        cooldownError.name = 'KeyCooldownError'
        throw cooldownError
      }

      let tavilyResolved = null
      if (mode === 'web') {
        tavilyResolved = await resolveKeysForRequest('tavily')
        if (tavilyResolved.allInCooldown) {
          const timeStr = new Date(tavilyResolved.earliestCooldownEnd).toLocaleTimeString()
          const cooldownError = new Error(t('chat.all_keys_cooldown', { time: timeStr }))
          cooldownError.name = 'KeyCooldownError'
          throw cooldownError
        }
      }

      const requestOptions = {
        systemInstruction: appConfig?.systemInstruction || '',
        language: appConfig?.language || i18n.language || 'tr',
      };

      const keysForGemini = geminiResolved.keys
      const keysForTavily = tavilyResolved ? tavilyResolved.keys : []

      const events = mode === 'web'
        ? streamResearch(requestMessages, keysForGemini, keysForTavily, controller.signal, selectedModel)
        : mode === 'vision'
          ? streamVision(requestMessages, null, requestOptions, keysForGemini, controller.signal, selectedModel)
          : streamChat(requestMessages, requestOptions, keysForGemini, controller.signal, selectedModel)

      for await (const evt of events) {
        if (evt.event === 'chunk') {
          const chunkText = evt.data.text || ''
          assistantContent += chunkText
          assistantStatus = 'streaming'
          queueAssistantText(assistantMessageId, chunkText)
        } else if (evt.event === 'sources') {
          assistantSources = evt.data.sources || []
          setMessages(prev => prev.map(message => (
            message.id === assistantMessageId && message.role === 'model'
              ? { ...message, sources: assistantSources }
              : message
          )))
        } else if (evt.event === 'error') {
          assistantStatus = 'error'
          toast.error(evt.data.message, { duration: 5000 })
          break;
        } else if (evt.event === 'key_status') {
          const { provider, keyId, status } = evt.data
          if (status === 'cooldown') {
            const cooldownMs = 60000
            updateKeyMetadata(provider, keyId, {
              cooldownUntil: Date.now() + cooldownMs,
              lastErrorAt: Date.now(),
              lastErrorType: 'rate_limited',
            })
          } else if (status === 'quota_exceeded') {
            const cooldownMs = 120000
            updateKeyMetadata(provider, keyId, {
              cooldownUntil: Date.now() + cooldownMs,
              lastErrorAt: Date.now(),
              lastErrorType: 'quota_exceeded',
            })
          } else if (status === 'success') {
            updateKeyMetadata(provider, keyId, {
              lastSuccessAt: Date.now(),
              failCount: 0,
              cooldownUntil: null,
              lastErrorType: null,
            })
          } else if (status === 'error') {
            updateKeyMetadata(provider, keyId, {
              lastErrorAt: Date.now(),
              lastErrorType: 'invalid',
            })
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        if (requestTimedOut || streamAbortReasonRef.current === 'timeout') {
          assistantStatus = 'error'
          toast.error(t('chat.connection_error'))
        } else {
          const displayedContent = displayedAssistantContentRef.current
          assistantStatus = displayedContent ? 'cancelled' : 'cancelled_empty'
          shouldDropEmptyAssistant = !displayedContent
        }
      } else {
        assistantStatus = 'error'
        if (err.name === 'KeyCooldownError') {
          toast.error(err.message)
        } else {
          console.error("handleSend Error", err)
          toast.error(t('chat.connection_error'))
        }
      }
    } finally {
      window.clearTimeout(requestTimeoutId)
      const wasCancelledBeforeDrain = streamAbortReasonRef.current === 'user' || streamAbortReasonRef.current === 'session'
      if (wasCancelledBeforeDrain) {
        stopAssistantDisplayQueue(true)
      } else {
        await drainAssistantBuffer()
      }

      const displayedAssistantContent = displayedAssistantContentRef.current
      const wasUserCancelled = streamAbortReasonRef.current === 'user' || streamAbortReasonRef.current === 'session'

      if (wasUserCancelled) {
        stopAssistantDisplayQueue(true)
        assistantStatus = displayedAssistantContent ? 'cancelled' : 'cancelled_empty'
        shouldDropEmptyAssistant = !displayedAssistantContent
      }

      if (assistantStatus === 'streaming') {
        assistantStatus = 'done'
      }

      setMessages(prev => {
        let next = prev.map(message => {
          if (message.id !== assistantMessageId || message.role !== 'model') return message
          return assistantStatus === 'error'
            ? markAssistantError({ ...message, sources: assistantSources }, message.content || displayedAssistantContent)
            : finalizeAssistantMessage(message, {
              content: message.content || displayedAssistantContent,
              status: assistantStatus,
              sources: assistantSources
            })
        })

        if (shouldDropEmptyAssistant) {
          next = next.filter(message => (
            message.id !== assistantMessageId || message.role !== 'model' || message.content
          ))
        }

        return next
      })

      const persistedAssistantContent = assistantStatus === 'done'
        ? assistantContent
        : displayedAssistantContent
      const shouldPersistAssistant = persistedAssistantContent || (assistantStatus !== 'error' && assistantStatus !== 'cancelled_empty')
      finalMessages = shouldPersistAssistant
        ? [...baseMessages, userMsg, { ...assistantMsg, content: persistedAssistantContent, status: assistantStatus, sources: assistantSources }]
        : [...baseMessages, userMsg]
      persistCurrentSession(finalMessages)
      setGenerating(false)
      streamingControllerRef.current = null
      streamTargetMessageIdRef.current = null
      streamAbortReasonRef.current = null
    }
  }, [input, attachments, messages, appConfig, enableResearch, selectedModel, queueAssistantText, drainAssistantBuffer, persistCurrentSession, setGenerating, stickToBottomOnNextRender, stopAssistantDisplayQueue, t])


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
    setGenerating(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [t, setGenerating])

  const handleScreenshot = useCallback(async () => {
    try {
      updateStats('screenshot')
      
      const windows = await chrome.windows.getAll()
      const targetWindow = windows.find(w => w.type === 'normal')
      
      if (!targetWindow) {
        toast.error(t('chat.screenshot_no_tab'));
        return;
      }

      const [tab] = await chrome.tabs.query({ active: true, windowId: targetWindow.id });

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

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: injectCropOverlay,
        args: [
          {
            confirm: t('chat.tooltips.crop_confirm'),
            cancel: t('chat.tooltips.crop_cancel')
          },
          appConfig?.customPrimaryColor || '#7c5cff'
        ]
      });

      toast(t('chat.tooltips.screenshot_hint'));
      setActiveMode('crop')
    } catch (e) {
      console.error('Initiate screenshot error', e);
      const msg = e?.message || '';
      if (msg.includes('Cannot access') || msg.includes('chrome://')) {
        toast.error(t('chat.screenshot_blocked'));
      } else {
        toast.error(t('chat.file_error'));
      }
    }
  }, [t, appConfig])

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
            setGenerating(false);
          }
        }
      }
    }
  }, [t, setGenerating])

  const cancelStream = useCallback(() => {
    if (streamingControllerRef.current) {
      const targetId = streamTargetMessageIdRef.current
      streamAbortReasonRef.current = 'user'
      streamingControllerRef.current.abort()
      streamingControllerRef.current = null
      stopAssistantDisplayQueue(true)
      setGenerating(false)
      if (targetId != null) {
        setMessages(prev => prev.map(message => (
          message.id === targetId && message.role === 'model'
            ? { ...message, status: message.content ? 'cancelled' : 'cancelled_empty' }
            : message
        )))
      }
      toast.success(t('chat.cancelled'))
    }
  }, [setGenerating, stopAssistantDisplayQueue, t])

  const scrollToBottom = useCallback((smooth = false) => {
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

  const handleRetryMessage = useCallback((message) => {
    if (!message || isGeneratingRef.current) return

    if (message.role === 'user' && message.content) {
      handleSend(message.content)
      return
    }

    if (message.role === 'model') {
      const messageIndex = messages.findIndex((item) => item.id === message.id)
      const previousUserMessage = messageIndex > 0
        ? [...messages.slice(0, messageIndex)].reverse().find((item) => item.role === 'user')
        : null
      if (previousUserMessage?.content) handleSend(previousUserMessage.content)
    }
  }, [handleSend, messages])

  const handleChatScroll = useCallback((event) => {
    const container = event.currentTarget
    const distanceFromBottom = getScrollDistanceFromBottom(container)
    const isAtBottom = distanceFromBottom <= SCROLL_RESUME_THRESHOLD_PX
    const nearBottom = isScrollNearBottom(container)

    if (isAtBottom) {
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
    return <HistoryOverlay sessions={sessions} activeSessionId={activeSessionId} onSelect={loadSession} onDelete={deleteSession} onClose={() => setShowHistory(false)} />
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
        onNewChat={startNewSession}
        onHistory={() => setShowHistory(true)}
        onClear={clearHistory}
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
              const isLastAssistant = idx === messages.length - 1 && msg.role === 'model'
              return (
                <ChatMessage
                  key={msg.id ?? idx}
                  message={msg}
                  isPending={isLastAssistant && isGenerating}
                  onEdit={handleEditMessage}
                  onRetry={handleRetryMessage}
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
                title={t('chat.quick_actions.crop_tooltip')}
                aria-label={t('chat.quick_actions.crop_tooltip')}
                aria-pressed={activeMode === 'crop'}
                onClick={handleScreenshot}
                disabled={isGenerating}
                className={getQuickActionClass(activeMode === 'crop')}
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
                  handleSend(t('chat.prompts.ocr'), { modeOverride: 'vision' })
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
