import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react'
import { Settings, Send, Paperclip, Trash2, Loader2, Sparkles, X, FileText, History, MessageSquarePlus, Languages, Lightbulb, Scissors, Globe, Bot, Download, Upload, MessageSquare, Keyboard } from 'lucide-react'
import toast from 'react-hot-toast'

import { useTranslation } from 'react-i18next'

import SettingsPanel from './components/SettingsPanel'
import ChatMessage from './components/ChatMessage'
import HistoryOverlay from './components/HistoryOverlay'
import StatsPanel from './components/StatsPanel'
import ShortcutsPanel from './components/ShortcutsPanel'
import { injectCropOverlay } from './lib/injectCropOverlay'
import { streamChat, streamResearch, streamVision } from './lib/api'
import { fileToBase64 } from './lib/fileParsers'
import { exportSessions, importSessions } from './lib/importExport'
import i18n from './i18n'
import { updateStats } from './lib/stats'

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
  const msgIdCounter = useRef(0)
  const scrollRef = useRef(null)
  const fileInputRef = useRef(null)
  const streamingControllerRef = useRef(null)
  const cropProcessingRef = useRef(false)
  const autoScrollRef = useRef(true)
  const [showScrollDownBtn, setShowScrollDownBtn] = useState(false)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState([])
  const [isGenerating, setIsGeneratingState] = useState(false)
  const isGeneratingRef = useRef(false)
  const setGenerating = useCallback((val) => {
    setIsGeneratingState(val)
    isGeneratingRef.current = val
  }, [])

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
      root.style.setProperty('--primary', customPrimaryColor);
      const hsl = hexToHSL(customPrimaryColor);
      root.style.setProperty('--primary-hsl', `${hsl.h}, ${hsl.s}%, ${hsl.l}%`);
      root.style.setProperty('--primary-foreground', hsl.l > 60 ? '0 0 0' : '0 0 100');
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

  const captureScreenshot = async (coords) => {
    if (!coords) return null;
    const { x, y, width, height, pixelRatio } = coords;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const img = new Image();
    img.src = dataUrl;
    await new Promise(res => img.onload = res);

    const canvas = document.createElement('canvas');
    canvas.width = width * pixelRatio;
    canvas.height = height * pixelRatio;
    const ctx = canvas.getContext('2d');

    ctx.drawImage(img, x * pixelRatio, y * pixelRatio, width * pixelRatio, height * pixelRatio, 0, 0, canvas.width, canvas.height);
    const croppedDataUrl = canvas.toDataURL('image/png');
    const base64Data = croppedDataUrl.split(',')[1];

    return {
      name: `screenshot-${Date.now()}.png`,
      mimeType: 'image/png',
      data: base64Data
    };
  }

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
          toast.error('Error taking screenshot');
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
  }, [])



  useEffect(() => {
    if (chrome && chrome.storage) {
      chrome.storage.local.get(['theme', 'startupBehavior', 'systemInstruction', 'chatHistory', 'sessions', 'activeSessionId', 'backendUrl', 'customPrimaryColor', 'language'], (result) => {
        const config = {
          backendUrl: result.backendUrl || 'http://localhost:3001',
          theme: result.theme || 'system',
          startupBehavior: result.startupBehavior || 'resume',
          systemInstruction: result.systemInstruction || '',
          customPrimaryColor: result.customPrimaryColor || '#0ea5e9',
          language: result.language || 'tr',
        }

        setAppConfig(config)
        applyTheme(config.theme, config.customPrimaryColor)

        if (result.language) {
          i18n.changeLanguage(result.language)
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
          const newSession = { id, title: t('chat.history_title') || 'Migrated Chat', updatedAt: Date.now(), messages: result.chatHistory }
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
      })

      const storageListener = (changes, namespace) => {
        if (namespace === 'local' && changes.selectedText && changes.selectedText.newValue) {
          setInput(prev => {
            const sep = prev.trim() ? '\n' : '';
            return prev + sep + changes.selectedText.newValue;
          });
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

  useEffect(() => {
    if (activeSessionId && messages.length > 0) {
      setSessions(prev => {
        const existing = prev.find(s => s.id === activeSessionId)
        const others = prev.filter(s => s.id !== activeSessionId)

        if (messages.length === 1 && messages[0].role === 'model' && !existing) {
          return prev;
        }

        const newArr = [...others, {
          id: activeSessionId,
          title: generateTitle(messages),
          updatedAt: Date.now(),
          messages: messages
        }]

        if (chrome && chrome.storage) {
          chrome.storage.local.set({ sessions: newArr, activeSessionId })
        }
        return newArr
      })
    }
  }, [messages, activeSessionId, generateTitle])

  useLayoutEffect(() => {
    if (!scrollRef.current || !autoScrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  const startNewSession = useCallback(() => {
    const id = Date.now().toString()
    const welcomeMsg = [{ id: msgIdCounter.current++, role: 'model', content: t('chat.welcome') }]
    setActiveSessionId(id)
    setSessions(prev => [...prev, { id, title: t('chat.new_chat'), updatedAt: Date.now(), messages: welcomeMsg }])
    setMessages(welcomeMsg)
    setShowHistory(false)
  }, [t])

  const loadSession = useCallback((id) => {
    const session = sessions.find(s => s.id === id)
    if (session) {
      setActiveSessionId(id)
      setMessages(session.messages)
      if (chrome && chrome.storage) {
        chrome.storage.local.set({ activeSessionId: id })
      }
    }
    setShowHistory(false)
  }, [sessions])

  const deleteSession = useCallback((id) => {
    setSessions(prev => {
      const newArr = prev.filter(s => s.id !== id)
      if (chrome && chrome.storage) {
        chrome.storage.local.set({ sessions: newArr })
      }
      return newArr
    })
    if (activeSessionId === id && sessions.length > 1) {
      startNewSession()
    } else if (sessions.length <= 1) {
      startNewSession()
    }
  }, [activeSessionId, sessions, startNewSession])

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
      toast.error(t('chat.no_history') || 'No history to export')
      return
    }
    exportSessions(sessions)
    toast.success('Chat history exported!')
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
        if (chrome && chrome.storage) {
          chrome.storage.local.set({ sessions: importedSessions, activeSessionId: importedSessions[0].id })
        }
      }
      toast.success('Chat history imported!')
    } catch (err) {
      toast.error(err.message || 'Failed to import')
    }
    e.target.value = ''
  }, [])

  const handleSend = useCallback(async (directActionText = null) => {
    const actualText = typeof directActionText === 'string' ? directActionText : null;
    const safeInput = typeof input === 'string' ? input : '';
    const userText = actualText || safeInput.trim();
    if ((!userText && attachments.length === 0) || isGenerating) return

    updateStats(enableResearch ? ['message', 'search'] : 'message')

    const messageAttachments = attachments.map(att => ({
      data: att.data,
      mimeType: att.mimeType,
      name: att.name
    }))

    const userMsg = { id: msgIdCounter.current++, role: 'user', content: userText, attachments: messageAttachments }

    setMessages(prev => [...prev, userMsg])
    setInput('')
    setAttachments([])
    setGenerating(true)

    setMessages(prev => [...prev, { id: msgIdCounter.current++, role: 'model', content: '' }])

    const controller = new AbortController()
    streamingControllerRef.current = controller

    try {
      const options = {
        systemInstruction: appConfig?.systemInstruction || '',
      };

      const events = enableResearch
        ? streamResearch(userText, controller.signal)
        : attachments.length > 0
          ? streamVision([...messages.slice(1), userMsg], attachments[0]?.data, options, controller.signal)
          : streamChat([...messages.slice(1), userMsg], options, controller.signal)

      for await (const evt of events) {
        if (evt.event === 'chunk') {
          setMessages(prev => {
            const newMessages = [...prev];
            const lastIndex = newMessages.length - 1;
            newMessages[lastIndex] = {
              ...newMessages[lastIndex],
              content: newMessages[lastIndex].content + evt.data.text
            };
            return newMessages;
          });
        } else if (evt.event === 'sources') {
          const sourcesHtml = '\n\n─── Kaynaklar ───\n' + evt.data.sources.map(s => `[${s.index}] ${s.title} → ${s.url}`).join('\n');
          setMessages(prev => {
            const newMessages = [...prev];
            const lastIndex = newMessages.length - 1;
            newMessages[lastIndex] = {
              ...newMessages[lastIndex],
              content: newMessages[lastIndex].content + sourcesHtml
            };
            return newMessages;
          });
        } else if (evt.event === 'error') {
          toast.error(evt.data.message, { duration: 5000 })
          break;
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error("handleSend Error", err)
      toast.error('Backend\'e bağlanılamadı. Sunucu çalışıyor mu?')
    } finally {
      setGenerating(false)
      streamingControllerRef.current = null
    }
  }, [input, attachments, isGenerating, messages, appConfig, enableResearch])

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
  }, [t])

  const handleScreenshot = useCallback(async () => {
    try {
      updateStats('screenshot')
      
      const windows = await chrome.windows.getAll()
      const targetWindow = windows.find(w => w.type === 'normal')
      
      if (!targetWindow) {
        toast.error(t('chat.screenshot_no_tab') || 'Aktif pencere bulunamadı.');
        return;
      }
      
      const [tab] = await chrome.tabs.query({ active: true, windowId: targetWindow.id });

      if (!tab || !tab.id) {
        toast.error(t('chat.screenshot_no_tab') || 'Aktif sekme bulunamadı.');
        return;
      }

      const url = tab.url || '';
      const blocked = url.startsWith('chrome://') || url.startsWith('about:') ||
        url.startsWith('edge://') || url === '';
      if (blocked) {
        toast.error(t('chat.screenshot_blocked') || 'Bu sayfa türünde ekran kırpma kullanılamaz. Lütfen normal bir web sayfasına gidin.');
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
          appConfig?.customPrimaryColor || '#0ea5e9'
        ]
      });

      toast(t('chat.tooltips.screenshot_hint') || 'Sayfa üzerinde kırpmak istediğiniz alanı çizin.');
    } catch (e) {
      console.error('Initiate screenshot error', e);
      const msg = e?.message || '';
      if (msg.includes('Cannot access') || msg.includes('chrome://')) {
        toast.error(t('chat.screenshot_blocked') || 'Bu sayfa türünde ekran kırpma kullanılamaz.');
      } else {
        toast.error(t('chat.file_error') || 'Ekran kırpma başlatılamadı.');
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
  }, [t])

  const cancelStream = useCallback(() => {
    if (streamingControllerRef.current) {
      streamingControllerRef.current.abort()
      streamingControllerRef.current = null
      setGenerating(false)
      toast.success('İstek iptal edildi')
    }
  }, [])

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    autoScrollRef.current = true
    setShowScrollDownBtn(false)
  }, [])

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    const onScroll = () => {
      const threshold = 80
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold
      autoScrollRef.current = nearBottom
      if (nearBottom) {
        setShowScrollDownBtn(false)
      } else {
        setShowScrollDownBtn(prev => isGeneratingRef.current || prev ? true : false)
      }
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [])

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

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b bg-background/95 backdrop-blur z-10 shrink-0 shadow-sm">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" />
          <h1 className="font-semibold text-base tracking-tight">HeraAi</h1>
        </div>
        <div className="flex items-center gap-1">
          <button
            title={t('chat.tooltips.new_chat') || "New Chat"}
            onClick={startNewSession}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
          >
            <MessageSquarePlus className="w-4 h-4" />
          </button>
          <button
            title={t('chat.tooltips.history') || "History"}
            onClick={() => setShowHistory(true)}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
          >
            <History className="w-4 h-4" />
          </button>
          <button
            title={t('chat.tooltips.clear_chat')}
            onClick={clearHistory}
            className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button
            title="Export Chat"
            onClick={handleExport}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
          >
            <Download className="w-4 h-4" />
          </button>
          <label className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors cursor-pointer">
            <Upload className="w-4 h-4" />
            <input
              type="file"
              accept=".json"
              onChange={handleImport}
              className="hidden"
            />
          </label>
          <button
            title={t('chat.tooltips.settings') || 'Settings'}
            onClick={() => setShowSettings(true)}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
          >
            <Settings className="w-4 h-4" />
          </button>
          <button
            title={t('chat.tooltips.statistics') || 'Statistics'}
            onClick={() => setShowStats(true)}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
          >
            <MessageSquare className="w-4 h-4" />
          </button>
          <button
            title={t('chat.tooltips.shortcuts') || 'Shortcuts'}
            onClick={() => setShowShortcuts(true)}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
          >
            <Keyboard className="w-4 h-4" />
          </button>
        </div>
      </header>

      {showSettings && (
        <div className="absolute inset-0 z-50 bg-background overflow-y-auto animate-in fade-in duration-200">
          <button
            onClick={() => setShowSettings(false)}
            className="absolute top-4 right-4 p-2 rounded-full hover:bg-secondary text-muted-foreground hover:text-foreground z-50 transition-colors"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
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

      <main className="flex-1 overflow-y-auto relative" ref={scrollRef}>
        {showScrollDownBtn && (
          <div className="sticky bottom-4 z-10 flex justify-center pointer-events-none">
            <button
              onClick={() => scrollToBottom()}
              className="pointer-events-auto flex items-center gap-2 px-4 py-1.5 bg-primary text-primary-foreground text-xs font-medium rounded-full shadow-lg hover:bg-primary/90 transition-all animate-in fade-in"
            >
              ↓ {t('chat.new_messages') || 'Yeni mesajlar'}
            </button>
          </div>
        )}
        <div className="p-4 space-y-4">
          {messages.map((msg, idx) => {
            const isLastAssistant = idx === messages.length - 1 && msg.role === 'model'
            return (
              <ChatMessage
                key={msg.id ?? idx}
                message={msg}
                isPending={isLastAssistant && isGenerating}
                onCancel={isLastAssistant ? cancelStream : undefined}
                onEdit={(text) => {
                  setInput(text)
                  setTimeout(() => {
                    const textarea = document.querySelector('textarea')
                    if (textarea) { textarea.focus(); textarea.setSelectionRange(text.length, text.length) }
                  }, 50)
                }}
              />
            )
          })}
        </div>
      </main>

      <div className="p-4 bg-background border-t shadow-sm shrink-0">
        {attachments.length > 0 && (
          <div className="flex gap-2 mb-2 overflow-x-auto pb-1">
            {attachments.map((att, idx) => (
              <div key={idx} className="relative group bg-secondary border border-border rounded-lg p-1.5 flex items-center gap-2 pr-6 max-w-[150px] shrink-0">
                {att.mimeType.startsWith('image/') ? (
                  <img src={`data:${att.mimeType};base64,${att.data}`} alt="preview" className="w-6 h-6 object-cover rounded" />
                ) : (
                  <FileText className="w-5 h-5 text-muted-foreground" />
                )}
                <span className="text-xs truncate">{att.name}</span>
                <button
                  onClick={() => removeAttachment(idx)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded-full bg-background/80 hover:bg-destructive hover:text-destructive-foreground opacity-0 group-hover:opacity-100 transition-all"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1 scrollbar-hide">
          <button
            title={t('chat.tooltips.screenshot') || 'Ekrandan alan seç'}
            onClick={handleScreenshot}
            disabled={isGenerating}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-secondary/80 hover:bg-primary/20 hover:text-primary active:scale-95 backdrop-blur-sm rounded-xl transition-all border border-border/50 shadow-sm text-xs font-medium text-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Scissors className="w-3.5 h-3.5" />
            <span>{t('chat.quick_actions.crop') || 'Kırp'}</span>
          </button>

          <button
            title={enableResearch ? (t('chat.tooltips.disable_research') || 'Web araştırmasını kapat') : (t('chat.tooltips.enable_research') || 'Web\'de araştır')}
            onClick={() => setEnableResearch(prev => !prev)}
            disabled={isGenerating}
            aria-pressed={enableResearch}
            className={`flex items-center gap-1 px-2.5 py-1.5 backdrop-blur-sm rounded-xl transition-all border shadow-sm text-xs font-medium active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed ${
              enableResearch
                ? 'bg-primary/20 border-primary text-primary shadow-primary/20'
                : 'bg-secondary/80 hover:bg-primary/20 hover:text-primary border-border/50 text-muted-foreground'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>{t('chat.quick_actions.web') || 'Web'}</span>
          </button>

          <button
            title={t('chat.prompts.translate') || 'Seçili metni/görseli çevir'}
            onClick={() => {
              const p = (t('chat.prompts.translate') || 'Translate') + ':\n' + input;
              setInput('');
              handleSend(p);
            }}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-secondary/80 hover:bg-primary/20 hover:text-primary active:scale-95 backdrop-blur-sm rounded-xl transition-all border border-border/50 shadow-sm text-xs font-medium text-muted-foreground"
          >
            <Languages className="w-3.5 h-3.5" />
            <span>{t('chat.quick_actions.translate') || 'Çevir'}</span>
          </button>

          <button
            title={t('chat.tooltips.summarize') || 'İçeriği özetle'}
            onClick={() => {
              const p = (t('chat.prompts.summarize') || 'Summarize') + ':\n' + input;
              setInput('');
              handleSend(p);
            }}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-secondary/80 hover:bg-primary/20 hover:text-primary active:scale-95 backdrop-blur-sm rounded-xl transition-all border border-border/50 shadow-sm text-xs font-medium text-muted-foreground"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>{t('chat.quick_actions.summarize') || 'Özet'}</span>
          </button>

          <button
            title={t('chat.prompts.explain') || 'İçeriği açıkla'}
            onClick={() => {
              const p = (t('chat.prompts.explain') || 'Explain') + ':\n' + input;
              setInput('');
              handleSend(p);
            }}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-secondary/80 hover:bg-primary/20 hover:text-primary active:scale-95 backdrop-blur-sm rounded-xl transition-all border border-border/50 shadow-sm text-xs font-medium text-muted-foreground"
          >
            <Lightbulb className="w-3.5 h-3.5" />
            <span>{t('chat.quick_actions.explain') || 'Açıkla'}</span>
          </button>
        </div>

        <div className="relative flex flex-col bg-background/50 backdrop-blur-sm border rounded-xl shadow-md focus-within:ring-2 focus-within:ring-primary/50 focus-within:border-primary transition-all">
          <textarea
            value={typeof input === 'string' ? input : ''}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={t('chat.placeholder')}
            className="min-h-[52px] max-h-48 w-full resize-none bg-transparent px-4 py-3 text-sm focus:outline-none placeholder:text-muted-foreground scrollbar-thin overflow-y-auto"
            rows="2"
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                className="hidden"
                accept="image/*,.pdf,.doc,.docx,.txt,.csv,.json,.xml,.html,.md"
                multiple
              />
              <button
                title={t('chat.tooltips.attach_file')}
                onClick={() => fileInputRef.current?.click()}
                className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors"
                disabled={isGenerating}
              >
                <Paperclip className="w-4 h-4" />
              </button>
            </div>
            <button
              onClick={handleSend}
              disabled={(!input.trim() && attachments.length === 0) || isGenerating}
              className="flex items-center justify-center p-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none transition-all shadow-sm"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="text-center mt-2">
          <span className="text-[10px] text-muted-foreground/60">{t('chat.powered_by')}</span>
        </div>
      </div>
    </div>
  )
}

export default App
