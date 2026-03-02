import { useState, useEffect, useRef, memo } from 'react'
import { Settings, Key, Save, Send, Paperclip, Bot, User, Trash2, Loader2, Sparkles, X, Image as ImageIcon, FileText, Copy, Check, History, MessageSquarePlus, Zap, Languages, Lightbulb, Scissors, Pencil } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import toast from 'react-hot-toast'

import { useTranslation } from 'react-i18next';

function SettingsPanel({ onSave, currentConfig }) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState('api') // api, general, ai

  // API State
  const [keys, setKeys] = useState(currentConfig?.apiKeys || [])
  const [activeIndex, setActiveIndex] = useState(currentConfig?.activeKeyIndex || 0)
  const [newKey, setNewKey] = useState('')

  // General State
  const [theme, setTheme] = useState(currentConfig?.theme || 'system')
  const [startupBehavior, setStartupBehavior] = useState(currentConfig?.startupBehavior || 'resume')

  // AI State
  const [systemInstruction, setSystemInstruction] = useState(currentConfig?.systemInstruction || '')
  const [aiTemperature, setAiTemperature] = useState(currentConfig?.aiTemperature ?? 0.7)

  const handleAddKey = () => {
    if (!newKey.trim() || keys.includes(newKey.trim())) return
    const updated = [...keys, newKey.trim()]
    setKeys(updated)
    setNewKey('')
    if (updated.length === 1) setActiveIndex(0)
  }

  const handleRemoveKey = (index) => {
    const updated = keys.filter((_, i) => i !== index)
    let newActive = activeIndex
    if (index === activeIndex) {
      newActive = Math.max(0, updated.length - 1)
    } else if (index < activeIndex) {
      newActive = activeIndex - 1
    }
    setKeys(updated)
    setActiveIndex(newActive)
  }

  const handleSave = () => {
    let finalKeys = [...keys]
    let finalIndex = activeIndex

    if (newKey.trim() && !keys.includes(newKey.trim())) {
      finalKeys.push(newKey.trim())
      if (finalKeys.length === 1) finalIndex = 0
    }

    const newConfig = {
      apiKeys: finalKeys,
      activeKeyIndex: finalIndex,
      geminiApiKey: finalKeys[finalIndex] || null, // backward compatibility
      theme,
      startupBehavior,
      systemInstruction,
      aiTemperature: parseFloat(aiTemperature)
    }

    chrome.storage.local.set(newConfig, () => {
      onSave(newConfig)
      toast.success(t('setup.api.saved_success') || 'Settings saved!')
    })
  }

  return (
    <div className="flex flex-col bg-background text-foreground p-6 pt-8 items-center justify-start gap-4 overflow-y-auto w-full">
      <div className="w-full max-w-lg flex flex-col gap-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="bg-primary/20 p-2 rounded-xl">
            <Settings className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">{t('setup.title')}</h1>
        </div>

        {/* Custom Tabs */}
        <div className="flex rounded-lg bg-secondary/50 p-1">
          <button
            onClick={() => setActiveTab('api')}
            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === 'api' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Key className="w-4 h-4" /> {t('setup.tabs.api')}
          </button>
          <button
            onClick={() => setActiveTab('general')}
            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === 'general' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Sparkles className="w-4 h-4" /> {t('setup.tabs.general')}
          </button>
          <button
            onClick={() => setActiveTab('ai')}
            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === 'ai' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Bot className="w-4 h-4" /> {t('setup.tabs.ai')}
          </button>
        </div>

        {/* Tab Content */}
        <div className="bg-card border rounded-xl p-5 shadow-sm min-h-[300px]">

          {/* API Keys Tab */}
          {activeTab === 'api' && (
            <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-2 duration-200">
              <label className="text-sm font-semibold text-foreground flex items-center gap-2 border-b pb-2 mb-2">
                <Key className="w-4 h-4 text-primary" />
                {t('setup.api.keys_management')}
              </label>

              {keys.length > 0 && (
                <div className="space-y-2 mb-2">
                  {keys.map((k, idx) => (
                    <div key={idx} className={`flex items-center justify-between p-2.5 rounded-lg border transition-colors ${activeIndex === idx ? 'border-primary bg-primary/5' : 'border-border bg-muted/30 hover:bg-muted/50'}`}>
                      <div className="flex items-center gap-3 overflow-hidden cursor-pointer flex-1" onClick={() => setActiveIndex(idx)}>
                        <div className={`w-4 h-4 rounded-full border flex items-center justify-center ${activeIndex === idx ? 'border-primary' : 'border-muted-foreground'}`}>
                          {activeIndex === idx && <div className="w-2 h-2 rounded-full bg-primary" />}
                        </div>
                        <span className="text-sm font-mono tracking-wider truncate">{k.slice(0, 8)}••••••••{k.slice(-4)}</span>
                        {activeIndex === idx && <span className="text-[10px] bg-primary/20 text-primary font-bold px-2 py-0.5 rounded ml-auto">{t('setup.api.active')}</span>}
                      </div>
                      <button onClick={() => handleRemoveKey(idx)} className="p-1.5 ml-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive rounded-md transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <input
                  type="password"
                  className="flex h-10 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  placeholder={t('setup.api.add_placeholder')}
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddKey()}
                />
                <button onClick={handleAddKey} className="h-10 px-4 bg-secondary text-secondary-foreground rounded-lg text-sm font-semibold hover:bg-secondary/80 flex items-center justify-center shrink-0 transition-colors">{t('setup.api.add_btn')}</button>
              </div>
              <p className="text-xs text-muted-foreground/80 mt-1 pl-1">
                {t('setup.api.description')}
              </p>
            </div>
          )}

          {/* General Tab */}
          {activeTab === 'general' && (
            <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-2 duration-200">
              {/* Theme Settings */}
              <div className="flex flex-col gap-3">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2 border-b pb-2">
                  <Sparkles className="w-4 h-4 text-primary" />
                  {t('setup.general.theme_title')}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'system', label: t('setup.general.theme_system') },
                    { id: 'light', label: t('setup.general.theme_light') },
                    { id: 'dark', label: t('setup.general.theme_dark') }
                  ].map(opt => (
                    <button
                      key={opt.id}
                      onClick={() => setTheme(opt.id)}
                      className={`p-2 rounded-lg border text-sm text-center transition-all ${theme === opt.id ? 'border-primary bg-primary/10 font-bold text-primary shadow-sm' : 'border-border hover:bg-secondary text-muted-foreground'}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Startup Behavior */}
              <div className="flex flex-col gap-3 mt-2">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2 border-b pb-2">
                  <History className="w-4 h-4 text-primary" />
                  {t('setup.general.startup_title')}
                </label>
                <div className="flex flex-col gap-2">
                  {[
                    { id: 'resume', label: t('setup.general.startup_resume') },
                    { id: 'new', label: t('setup.general.startup_new') }
                  ].map(opt => (
                    <label key={opt.id} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${startupBehavior === opt.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary'}`}>
                      <input
                        type="radio"
                        name="startup_behavior"
                        checked={startupBehavior === opt.id}
                        onChange={() => setStartupBehavior(opt.id)}
                        className="text-primary focus:ring-primary w-4 h-4"
                      />
                      <span className="text-sm font-medium">{opt.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* AI Settings Tab */}
          {activeTab === 'ai' && (
            <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-2 duration-200">

              {/* System Prompt */}
              <div className="flex flex-col gap-3">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2 border-b pb-2">
                  <Bot className="w-4 h-4 text-primary" />
                  {t('setup.ai.system_prompt_title')}
                </label>
                <textarea
                  value={systemInstruction}
                  onChange={(e) => setSystemInstruction(e.target.value)}
                  placeholder={t('setup.ai.system_prompt_placeholder')}
                  className="min-h-[100px] w-full resize-y rounded-lg border border-input bg-background/50 px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
              </div>

              {/* Temperature */}
              <div className="flex flex-col gap-4 mt-2">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2 border-b pb-2">
                  <Zap className="w-4 h-4 text-primary" />
                  {t('setup.ai.temp_title')}
                </label>
                <div className="flex flex-col gap-2 px-1">
                  <div className="flex justify-between items-center text-xs font-semibold text-muted-foreground mb-1">
                    <span>{t('setup.ai.temp_precise')} (0.0)</span>
                    <span className="text-primary font-bold">{aiTemperature}</span>
                    <span>{t('setup.ai.temp_creative')} (1.0)</span>
                  </div>
                  <input
                    type="range"
                    min="0" max="1" step="0.1"
                    value={aiTemperature}
                    onChange={(e) => setAiTemperature(e.target.value)}
                    className="w-full accent-primary h-2 bg-secondary rounded-lg appearance-none cursor-pointer"
                  />
                </div>
              </div>

            </div>
          )}

        </div>

        {/* Global Save Button */}
        <button
          onClick={handleSave}
          disabled={activeTab === 'api' && keys.length === 0 && !newKey.trim()}
          className="inline-flex items-center justify-center rounded-lg text-sm font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-12 px-4 py-2 gap-2 w-full mt-2 shadow-md hover:shadow-lg shrink-0"
        >
          <Save className="w-5 h-5" />
          {t('setup.api.save_btn')}
        </button>
      </div>
    </div>
  )
}

// Content script function to inject for crop overlay
function injectCropOverlay() {
  if (document.getElementById('heraai-crop-overlay')) {
    document.getElementById('heraai-crop-overlay').remove();
  }

  const overlay = document.createElement('div');
  overlay.id = 'heraai-crop-overlay';
  Object.assign(overlay.style, {
    position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    zIndex: '2147483647', cursor: 'crosshair', pointerEvents: 'auto',
    backgroundColor: 'rgba(0,0,0,0.4)', userSelect: 'none'
  });

  const selection = document.createElement('div');
  Object.assign(selection.style, {
    position: 'absolute', border: '2px dashed #0ea5e9',
    backgroundColor: 'transparent', display: 'none', cursor: 'move',
    boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)'
  });


  const btnContainer = document.createElement('div');
  Object.assign(btnContainer.style, {
    position: 'absolute', bottom: '-40px', right: '0', display: 'flex', gap: '8px', zIndex: '2'
  });

  const btnConfirm = document.createElement('button');
  btnConfirm.innerHTML = '✔ Onayla';
  Object.assign(btnConfirm.style, {
    padding: '6px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px', fontWeight: 'bold', fontFamily: 'sans-serif'
  });

  const btnCancel = document.createElement('button');
  btnCancel.innerHTML = '✖ İptal';
  Object.assign(btnCancel.style, {
    padding: '6px 14px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px', fontWeight: 'bold', fontFamily: 'sans-serif'
  });

  btnContainer.appendChild(btnCancel);
  btnContainer.appendChild(btnConfirm);
  selection.appendChild(btnContainer);

  const handles = ['nw', 'ne', 'sw', 'se'].map(pos => {
    const handle = document.createElement('div');
    Object.assign(handle.style, {
      position: 'absolute', width: '10px', height: '10px', backgroundColor: '#0ea5e9', border: '1px solid #fff', cursor: `${pos}-resize`, zIndex: '1'
    });
    if (pos.includes('n')) handle.style.top = '-5px';
    if (pos.includes('s')) handle.style.bottom = '-5px';
    if (pos.includes('w')) handle.style.left = '-5px';
    if (pos.includes('e')) handle.style.right = '-5px';
    selection.appendChild(handle);
    return { el: handle, pos };
  });

  overlay.appendChild(selection);
  document.body.appendChild(overlay);

  let startX, startY, isDrawing = false, isDragging = false, isResizing = null;
  let rect = { x: 0, y: 0, w: 0, h: 0 };

  const updateSelection = () => {
    selection.style.left = rect.x + 'px';
    selection.style.top = rect.y + 'px';
    selection.style.width = rect.w + 'px';
    selection.style.height = rect.h + 'px';
  };

  overlay.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // only left click
    if (e.target === btnConfirm || e.target === btnCancel) return;

    const handle = handles.find(h => h.el === e.target);
    if (handle) {
      isResizing = handle.pos;
      startX = e.clientX; startY = e.clientY;
      return;
    }

    if (e.target === selection) {
      isDragging = true;
      startX = e.clientX; startY = e.clientY;
      return;
    }

    // start new drawing
    isDrawing = true;
    startX = e.clientX; startY = e.clientY;
    rect = { x: startX, y: startY, w: 0, h: 0 };
    selection.style.display = 'block';
    updateSelection();
  });

  const mousemove = (e) => {
    if (isDrawing) {
      rect.x = Math.min(startX, e.clientX);
      rect.y = Math.min(startY, e.clientY);
      rect.w = Math.abs(e.clientX - startX);
      rect.h = Math.abs(e.clientY - startY);
      updateSelection();
    } else if (isDragging) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      rect.x += dx;
      rect.y += dy;
      startX = e.clientX; startY = e.clientY;
      updateSelection();
    } else if (isResizing) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (isResizing.includes('e')) { rect.w += dx; }
      if (isResizing.includes('w')) { rect.x += dx; rect.w -= dx; }
      if (isResizing.includes('s')) { rect.h += dy; }
      if (isResizing.includes('n')) { rect.y += dy; rect.h -= dy; }
      startX = e.clientX; startY = e.clientY;

      if (rect.w < 0) { rect.x += rect.w; rect.w = Math.abs(rect.w); isResizing = isResizing.replace('e', 'W').replace('w', 'e').toLowerCase(); }
      if (rect.h < 0) { rect.y += rect.h; rect.h = Math.abs(rect.h); isResizing = isResizing.replace('n', 'S').replace('s', 'n').toLowerCase(); }

      updateSelection();
    }
  };

  const mouseup = () => {
    isDrawing = false;
    isDragging = false;
    isResizing = null;
  };

  window.addEventListener('mousemove', mousemove);
  window.addEventListener('mouseup', mouseup);

  const cleanup = () => {
    window.removeEventListener('mousemove', mousemove);
    window.removeEventListener('mouseup', mouseup);
    if (document.body.contains(overlay)) {
      document.body.removeChild(overlay);
    }
  };

  btnCancel.onclick = (e) => {
    e.stopPropagation();
    cleanup();
  };

  btnConfirm.onclick = (e) => {
    e.stopPropagation();
    if (rect.w < 10 || rect.h < 10) {
      cleanup();
      return;
    }

    selection.style.boxShadow = 'none';
    selection.style.border = 'none';
    btnContainer.style.display = 'none';
    handles.forEach(h => h.el.style.display = 'none');

    // Give browser a quick tick to hide UI before capture
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'HERAAI_CROP_DONE',
        coords: {
          x: rect.x, y: rect.y, width: rect.w, height: rect.h,
          pixelRatio: window.devicePixelRatio
        }
      });
      cleanup();
    }, 50);
  };
}

const ChatMessage = memo(({ message, onEdit }) => {
  const { t } = useTranslation()
  const isBot = message.role === 'model'
  const [copied, setCopied] = useState(false)

  const handleCopyMessage = () => {
    const text = message.content || ''
    navigator.clipboard.writeText(text)
    setCopied(true)
    toast.success(t('chat.tooltips.copied'))
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={`group flex gap-3 p-4 ${isBot ? 'bg-muted/50 rounded-lg' : ''} relative`}>
      <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${isBot ? 'bg-primary/10 text-primary' : 'bg-secondary text-secondary-foreground'}`}>
        {isBot ? <Bot className="w-5 h-5" /> : <User className="w-5 h-5" />}
      </div>
      <div className="flex-1 min-w-0 flex flex-col pt-1 space-y-2">
        <span className="text-xs font-semibold text-muted-foreground">
          {isBot ? t('chat.gemini') : t('chat.you')}
        </span>
        <div className="prose prose-sm dark:prose-invert prose-p:leading-relaxed prose-pre:bg-secondary prose-pre:p-0 w-full overflow-hidden break-words text-sm text-foreground">
          {isBot ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code({ node, inline, className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '')
                  const codeString = String(children).replace(/\n$/, '')
                  const [codeCopied, setCodeCopied] = useState(false)

                  const handleCopyCode = () => {
                    navigator.clipboard.writeText(codeString)
                    setCodeCopied(true)
                    toast.success(t('chat.tooltips.copied'))
                    setTimeout(() => setCodeCopied(false), 2000)
                  }

                  if (!inline && match) {
                    return (
                      <div className="relative group rounded-md bg-secondary/80 my-2 shadow-sm border border-border/50">
                        <div className="flex items-center justify-between px-3 py-1.5 bg-secondary border-b border-border text-xs text-muted-foreground rounded-t-md">
                          <span className="font-mono">{match[1]}</span>
                          <button
                            onClick={handleCopyCode}
                            className="flex items-center gap-1.5 hover:text-foreground transition-colors"
                            aria-label="Copy code"
                          >
                            {codeCopied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                            {codeCopied ? t('chat.tooltips.copied') : t('chat.tooltips.copy')}
                          </button>
                        </div>
                        <div className="p-3 overflow-x-auto">
                          <code className={className} {...props}>
                            {children}
                          </code>
                        </div>
                      </div>
                    )
                  }
                  return (
                    <code className="bg-secondary px-1.5 py-0.5 rounded text-[0.85em] font-mono text-primary" {...props}>
                      {children}
                    </code>
                  )
                }
              }}
            >
              {message.content}
            </ReactMarkdown>
          ) : (
            <div className="whitespace-pre-wrap flex flex-col gap-2">
              <span>{message.content}</span>
              {message.attachments && message.attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {message.attachments.map((att, idx) => (
                    <div key={idx} className="flex items-center gap-1 bg-secondary/50 px-2 py-1 rounded text-xs border border-border">
                      {att.mimeType.startsWith('image/') ? <ImageIcon className="w-3 h-3" /> : <FileText className="w-3 h-3" />}
                      <span className="truncate max-w-[120px]">{att.name || t('chat.attachment')}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Action row — appears on hover */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity pt-1">
          <button
            onClick={handleCopyMessage}
            title={t('chat.tooltips.copy')}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground bg-secondary/60 hover:bg-secondary border border-border/50 rounded-md px-2 py-1 transition-all"
          >
            {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
            {copied ? t('chat.tooltips.copied') : t('chat.tooltips.copy')}
          </button>
          {!isBot && message.content && (
            <button
              onClick={() => onEdit && onEdit(message.content)}
              title={t('chat.tooltips.edit') || 'Edit and Resend'}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary bg-secondary/60 hover:bg-primary/10 border border-border/50 rounded-md px-2 py-1 transition-all"
            >
              <Pencil className="w-3 h-3" />
              {t('chat.tooltips.edit') || 'Düzenle'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
})

import { initGemini, streamChatResponse } from './lib/gemini'
import { extractTextFromPdf, fileToBase64 } from './lib/fileParsers'

function HistoryOverlay({ sessions, activeSessionId, onSelect, onDelete, onClose }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col h-screen bg-background text-foreground p-6 pt-12">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <History className="w-6 h-6 text-primary" />
          <h2 className="text-xl font-bold">{t('chat.history_title') || 'Chat History'}</h2>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-secondary rounded-full"><X className="w-5 h-5" /></button>
      </div>
      <div className="flex-1 overflow-y-auto space-y-2 pb-4 pr-1">
        {sessions.length === 0 && <p className="text-sm text-muted-foreground">{t('chat.no_history') || 'No history found.'}</p>}
        {[...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map(s => (
          <div key={s.id} className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer ${activeSessionId === s.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary/50'}`} onClick={() => onSelect(s.id)}>
            <div className="flex flex-col flex-1 overflow-hidden pr-2">
              <span className="text-sm font-medium truncate">{s.title}</span>
              <span className="text-[10px] text-muted-foreground">{new Date(s.updatedAt).toLocaleString()}</span>
            </div>
            <button onClick={(e) => { e.stopPropagation(); onDelete(s.id); }} className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function App() {
  const { t } = useTranslation()
  const [appConfig, setAppConfig] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  // Wait to initialize messages since `t` might not be ready if done outside
  const [messages, setMessages] = useState([])
  const [sessions, setSessions] = useState([])
  const [activeSessionId, setActiveSessionId] = useState(null)
  const [showHistory, setShowHistory] = useState(false)

  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState([])
  const [isGenerating, setIsGenerating] = useState(false)
  const scrollRef = useRef(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    // Listen for HERAAI_CROP_DONE message
    const listener = async (msg) => {
      if (msg.type === 'HERAAI_CROP_DONE') {
        const { x, y, width, height, pixelRatio } = msg.coords;
        try {
          setIsGenerating(true);
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab) return;

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

          setAttachments(prev => [...prev, {
            name: `screenshot-${Date.now()}.png`,
            mimeType: 'image/png',
            data: base64Data
          }]);
        } catch (err) {
          console.error("Screenshot error", err);
          toast.error(t('chat.file_error') || 'Error taking screenshot');
        } finally {
          setIsGenerating(false);
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
  }, []);

  useEffect(() => {
    // Check if running in Chrome Extension environment
    if (chrome && chrome.storage) {
      chrome.storage.local.get(['geminiApiKey', 'apiKeys', 'activeKeyIndex', 'theme', 'startupBehavior', 'aiTemperature', 'systemInstruction', 'chatHistory', 'sessions', 'activeSessionId'], (result) => {
        let loadedKeys = result.apiKeys || []
        let loadedIndex = result.activeKeyIndex || 0

        // Single Key Migration
        if (loadedKeys.length === 0 && result.geminiApiKey) {
          loadedKeys = [result.geminiApiKey]
          loadedIndex = 0
        }

        const config = {
          apiKeys: loadedKeys,
          activeKeyIndex: loadedIndex,
          theme: result.theme || 'system',
          startupBehavior: result.startupBehavior || 'resume',
          aiTemperature: result.aiTemperature ?? 0.7,
          systemInstruction: result.systemInstruction || ''
        }

        setAppConfig(config)
        applyTheme(config.theme)

        if (loadedKeys.length > 0) {
          initGemini(loadedKeys[loadedIndex])
        } else {
          setShowSettings(true)
        }

        // Sessions Migration & Startup Behavior
        if (result.sessions && result.sessions.length > 0) {
          setSessions(result.sessions)

          if (config.startupBehavior === 'resume') {
            const currId = result.activeSessionId || result.sessions[0].id
            setActiveSessionId(currId)
            const currSession = result.sessions.find(s => s.id === currId) || result.sessions[0]
            setMessages(currSession.messages || [{ role: 'model', content: t('chat.welcome') }])
          } else {
            // Force new session if behavior is 'new'
            const id = Date.now().toString()
            setActiveSessionId(id)
            const welcomeMsg = [{ role: 'model', content: t('chat.welcome') }]
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
            const welcomeMsg = [{ role: 'model', content: t('chat.welcome') }]
            setSessions(prev => [...prev, { id: newId, title: t('chat.new_chat'), updatedAt: Date.now(), messages: welcomeMsg }])
            setMessages(welcomeMsg)
          }

        } else {
          const id = Date.now().toString()
          setActiveSessionId(id)
          const welcomeMsg = [{ role: 'model', content: t('chat.welcome') }]
          setSessions([{ id, title: t('chat.new_chat'), updatedAt: Date.now(), messages: welcomeMsg }])
          setMessages(welcomeMsg)
        }
        setIsLoading(false)
      })

      // Listen for context menu selections
      const storageListener = (changes, namespace) => {
        if (namespace === 'local' && changes.selectedText && changes.selectedText.newValue) {
          setInput(prev => {
            const sep = prev.trim() ? '\n' : '';
            return prev + sep + changes.selectedText.newValue;
          });
          chrome.storage.local.remove(['selectedText']); // clear it after consuming
        }
      };

      chrome.storage.onChanged.addListener(storageListener)

      // Cleanup listener on unmount
      return () => {
        chrome.storage.onChanged.removeListener(storageListener)
      }
    } else {
      setIsLoading(false)
      const id = Date.now().toString()
      setActiveSessionId(id)
      const welcomeMsg = [{ role: 'model', content: t('chat.welcome') }]
      setSessions([{ id, title: t('chat.new_chat'), updatedAt: Date.now(), messages: welcomeMsg }])
      setMessages(welcomeMsg)
    }
  }, [t])

  const applyTheme = (themeValue) => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');

    if (themeValue === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      root.classList.add(systemTheme);
    } else {
      root.classList.add(themeValue);
    }
  }

  const generateTitle = (msgs) => {
    const firstUserMsg = msgs.find(m => m.role === 'user')
    if (firstUserMsg && firstUserMsg.content) {
      return firstUserMsg.content.length > 30 ? firstUserMsg.content.substring(0, 30) + '...' : firstUserMsg.content
    }
    return t('chat.new_chat')
  }

  useEffect(() => {
    // Save history
    if (activeSessionId && messages.length > 0) {
      setSessions(prev => {
        const existing = prev.find(s => s.id === activeSessionId)
        const others = prev.filter(s => s.id !== activeSessionId)

        if (messages.length === 1 && messages[0].role === 'model' && !existing) {
          return prev; // don't clutter with empty sessions
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

    // Auto-scroll
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const startNewSession = () => {
    const id = Date.now().toString()
    setActiveSessionId(id)
    const welcomeMsg = [{ role: 'model', content: t('chat.welcome') }]
    setSessions(prev => [...prev, { id, title: t('chat.new_chat'), updatedAt: Date.now(), messages: welcomeMsg }])
    setMessages(welcomeMsg)
    setShowHistory(false)
  }

  const loadSession = (id) => {
    const session = sessions.find(s => s.id === id)
    if (session) {
      setActiveSessionId(id)
      setMessages(session.messages)
      if (chrome && chrome.storage) {
        chrome.storage.local.set({ activeSessionId: id })
      }
    }
    setShowHistory(false)
  }

  const deleteSession = (id) => {
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
  }

  const clearHistory = () => {
    setSessions([])
    if (chrome && chrome.storage) {
      chrome.storage.local.remove(['sessions', 'activeSessionId', 'chatHistory'])
    }
    startNewSession()
    toast.success(t('chat.history_cleared'))
  }

  const handleSend = async (directActionText = null) => {
    const userText = directActionText || input.trim();
    if ((!userText && attachments.length === 0) || isGenerating) return

    // Prepare attachments to store in message history
    const messageAttachments = attachments.map(att => ({
      data: att.data,
      mimeType: att.mimeType,
      name: att.name
    }))

    const userMsg = { role: 'user', content: userText, attachments: messageAttachments }

    setMessages(prev => [...prev, userMsg])
    setInput('')
    setAttachments([])
    setIsGenerating(true)

    // Add an empty model message block to append streamed chunks
    setMessages(prev => [...prev, { role: 'model', content: '' }])

    const historyToPass = messages.slice(1); // skip the hardcoded first greeting for API

    try {
      const advancedOptions = {
        aiTemperature: appConfig?.aiTemperature,
        systemInstruction: appConfig?.systemInstruction
      };

      await streamChatResponse(
        historyToPass,
        userText,
        messageAttachments,
        advancedOptions,
        (chunk) => {
          setMessages(prev => {
            const newMessages = [...prev];
            const lastIndex = newMessages.length - 1;
            newMessages[lastIndex] = {
              ...newMessages[lastIndex],
              content: newMessages[lastIndex].content + chunk
            };
            return newMessages;
          });
        },
        (errorMsg) => {
          toast.error(errorMsg)
          setMessages(prev => {
            const newMessages = [...prev];
            const lastIndex = newMessages.length - 1;
            newMessages[lastIndex] = {
              ...newMessages[lastIndex],
              content: newMessages[lastIndex].content + `\n\n**${t('chat.error_prefix')}** ${errorMsg}`
            };
            return newMessages;
          });
        }
      )
    } catch (err) {
      console.error("handleSend Error", err)
      toast.error(err.message || "Execution error")
    } finally {
      setIsGenerating(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleFileChange = async (e) => {
    const files = Array.from(e.target.files)
    if (!files.length) return

    setIsGenerating(true) // Show loading state while parsing

    const newAttachments = []
    for (const file of files) {
      try {
        if (file.type === 'application/pdf') {
          const text = await extractTextFromPdf(file)
          setInput(prev => prev + `\n\n[Content from ${file.name}]:\n${text}\n`)
        } else if (file.type.startsWith('image/')) {
          const base64 = await fileToBase64(file)
          newAttachments.push({
            name: file.name,
            mimeType: file.type,
            data: base64
          })
        }
      } catch (err) {
        console.error("File processing error", err)
        toast.error(t('chat.file_error'))
      }
    }

    setAttachments(prev => [...prev, ...newAttachments])
    setIsGenerating(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleScreenshot = async () => {
    try {
      // Query the LAST FOCUSED normal window's active tab
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

      if (!tab || !tab.id) {
        toast.error(t('chat.screenshot_no_tab') || 'Aktif sekme bulunamadı.');
        return;
      }

      // chrome://, about://, edge:// etc. pages cannot be scripted
      const url = tab.url || '';
      const blocked = url.startsWith('chrome://') || url.startsWith('about:') ||
        url.startsWith('edge://') || url.startsWith('chrome-extension://') ||
        url === '';
      if (blocked) {
        toast.error(t('chat.screenshot_blocked') || 'Bu sayfa türünde ekran kırpma kullanılamaz. Lütfen normal bir web sayfasına gidin.');
        return;
      }

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: injectCropOverlay
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
  }


  const removeAttachment = (index) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }

  const handlePaste = async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          setIsGenerating(true);
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
            setIsGenerating(false);
          }
        }
      }
    }
  }



  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    )
  }

  if (!appConfig || appConfig.apiKeys.length === 0) {
    return (
      <div className="flex flex-col h-screen bg-background text-foreground overflow-y-auto">
        <SettingsPanel
          currentConfig={appConfig}
          onSave={(newConfig) => {
            setAppConfig(newConfig)
            applyTheme(newConfig.theme)
            if (newConfig.apiKeys.length > 0) {
              initGemini(newConfig.apiKeys[newConfig.activeKeyIndex])
              setShowSettings(false)
            }
          }}
        />
      </div>
    )
  }

  if (showHistory) {
    return <HistoryOverlay sessions={sessions} activeSessionId={activeSessionId} onSelect={loadSession} onDelete={deleteSession} onClose={() => setShowHistory(false)} />
  }

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      {/* Header */}
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
            title={t('chat.tooltips.settings')}
            onClick={() => setShowSettings(true)}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Settings Overlay */}
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
            onSave={(newConfig) => {
              setAppConfig(newConfig)
              applyTheme(newConfig.theme)
              if (newConfig.apiKeys.length > 0) {
                initGemini(newConfig.apiKeys[newConfig.activeKeyIndex])
              }
              setShowSettings(false)
            }}
          />
        </div>
      )}

      {/* Chat Area */}
      <main className="flex-1 overflow-y-auto p-4 space-y-4" ref={scrollRef}>
        {messages.map((msg, idx) => (
          <ChatMessage
            key={idx}
            message={msg}
            onEdit={(text) => {
              setInput(text)
              // Focus the textarea after setting input
              setTimeout(() => {
                const textarea = document.querySelector('textarea')
                if (textarea) { textarea.focus(); textarea.setSelectionRange(text.length, text.length) }
              }, 50)
            }}
          />
        ))}
        {isGenerating && (
          <div className="flex gap-3 p-4 bg-muted/50 rounded-lg animate-pulse">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <Bot className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1 space-y-2 py-1">
              <div className="h-2 bg-muted-foreground/20 rounded w-1/4"></div>
              <div className="h-2 bg-muted-foreground/20 rounded w-1/2"></div>
            </div>
          </div>
        )}
      </main>

      {/* Input Area */}
      <div className="p-4 bg-background border-t shadow-sm shrink-0">

        {/* Attachment Previews */}
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

        {/* Prompt Library */}
        <div className="flex gap-2 mb-3 overflow-x-auto pb-1 scrollbar-hide">
          <button
            title={t('chat.prompts.summarize') || 'Summarize'}
            onClick={() => {
              const p = (t('chat.prompts.summarize') || 'Summarize') + ':\n' + input;
              setInput('');
              handleSend(p);
            }}
            className="flex items-center justify-center p-2 bg-secondary/80 hover:bg-primary/20 hover:text-primary backdrop-blur-sm rounded-xl transition-all border border-border/50 shadow-sm"
          ><FileText className="w-4 h-4" /></button>

          <button
            title={t('chat.prompts.translate') || 'Translate'}
            onClick={() => {
              const p = (t('chat.prompts.translate') || 'Translate') + ':\n' + input;
              setInput('');
              handleSend(p);
            }}
            className="flex items-center justify-center p-2 bg-secondary/80 hover:bg-primary/20 hover:text-primary backdrop-blur-sm rounded-xl transition-all border border-border/50 shadow-sm"
          ><Languages className="w-4 h-4" /></button>

          <button
            title={t('chat.prompts.explain') || 'Explain'}
            onClick={() => {
              const p = (t('chat.prompts.explain') || 'Explain') + ':\n' + input;
              setInput('');
              handleSend(p);
            }}
            className="flex items-center justify-center p-2 bg-secondary/80 hover:bg-primary/20 hover:text-primary backdrop-blur-sm rounded-xl transition-all border border-border/50 shadow-sm"
          ><Lightbulb className="w-4 h-4" /></button>

          <button
            title={t('chat.tooltips.screenshot') || 'Screenshot'}
            onClick={handleScreenshot}
            className="flex items-center justify-center p-2 bg-secondary/80 hover:bg-primary/20 hover:text-primary backdrop-blur-sm rounded-xl transition-all border border-border/50 shadow-sm"
            disabled={isGenerating}
          ><Scissors className="w-4 h-4" /></button>
        </div>

        <div className="relative flex flex-col bg-background/50 backdrop-blur-sm border rounded-xl shadow-md focus-within:ring-2 focus-within:ring-primary/50 focus-within:border-primary transition-all">
          <textarea
            value={input}
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
                accept="image/*,.pdf"
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
