import { useState } from 'react'
import { Settings, Key, Save, Trash2, Sparkles, Globe, ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import i18n from '../i18n'

const AVAILABLE_LANGUAGES = [
  { code: 'tr', name: 'Türkçe', flag: '🇹🇷' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
  { code: 'es', name: 'Español', flag: '🇪🇸' },
  { code: 'ru', name: 'Русский', flag: '🇷🇺' },
  { code: 'ar', name: 'العربية', flag: '🇸🇦' },
  { code: 'zh', name: '中文', flag: '🇨🇳' },
  { code: 'ja', name: '日本語', flag: '🇯🇵' },
  { code: 'ko', name: '한국어', flag: '🇰🇷' },
  { code: 'pt', name: 'Português', flag: '🇵🇹' },
  { code: 'it', name: 'Italiano', flag: '🇮🇹' },
]

const FIXED_MODEL = {
  id: 'gemini-3.1-flash-lite',
  name: 'Gemini 3.1 Flash Lite',
  provider: 'google',
  supports: ['pdf', 'image', 'text']
}

function SettingsPanel({ onSave, currentConfig, onClose }) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState('api')

  const [keys, setKeys] = useState(currentConfig?.apiKeys || [])
  const [activeIndex, setActiveIndex] = useState(currentConfig?.activeKeyIndex || 0)
  const [newKey, setNewKey] = useState('')

  const [theme, setTheme] = useState(currentConfig?.theme || 'system')
  const [customPrimaryColor, setCustomPrimaryColor] = useState(currentConfig?.customPrimaryColor || '#0ea5e9')
  const [startupBehavior, setStartupBehavior] = useState(currentConfig?.startupBehavior || 'resume')

  const [systemInstruction, setSystemInstruction] = useState(currentConfig?.systemInstruction || '')
  const [selectedLanguage, setSelectedLanguage] = useState(currentConfig?.language || 'tr')

  const handleLanguageChange = (langCode) => {
    setSelectedLanguage(langCode)
    i18n.changeLanguage(langCode)
  }

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

  const getFinalIndex = () => {
    if (newKey.trim() && !keys.includes(newKey.trim())) {
      return keys.length === 0 ? 0 : activeIndex
    }
    return activeIndex
  }

  const handleSave = async () => {
    let finalKeys = [...keys]
    let finalIndex = activeIndex

    if (newKey.trim() && !keys.includes(newKey.trim())) {
      finalKeys.push(newKey.trim())
      if (finalKeys.length === 1) finalIndex = 0
    }

    const newConfig = {
      apiKeys: finalKeys,
      activeKeyIndex: finalIndex,
      geminiApiKey: finalKeys[finalIndex] || null,
      theme,
      startupBehavior,
      systemInstruction,
      selectedModel: FIXED_MODEL.id,
      customPrimaryColor: customPrimaryColor,
      language: selectedLanguage,
      apiProvider: 'google'
    }

    chrome.storage.local.set(newConfig, () => {
      onSave(newConfig)
      toast.success(t('setup.api.saved_success') || 'Settings saved!')
    })
  }

  return (
    <div className="flex flex-col bg-background text-foreground p-4 pt-6 items-center justify-start gap-4 overflow-y-auto w-full h-full">
      <div className="w-full max-w-lg flex flex-col gap-4">
        {onClose && (
          <button
            onClick={onClose}
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="text-sm">{t('common.back') || 'Geri'}</span>
          </button>
        )}
        
        <div className="flex items-center gap-3">
          <div className="bg-primary/20 p-2 rounded-xl">
            <Settings className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">{t('setup.title')}</h1>
        </div>

        <div className="flex rounded-lg bg-secondary/50 p-1">
          <button
            onClick={() => setActiveTab('api')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${activeTab === 'api' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Key className="w-3.5 h-3.5" /> API
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${activeTab === 'settings' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Sparkles className="w-3.5 h-3.5" /> Ayarlar
          </button>
        </div>

        <div className="bg-card border rounded-xl p-4 shadow-sm min-h-[300px]">
          {activeTab === 'api' && (
            <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-2 duration-200">
              <div className="flex flex-col gap-3">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Globe className="w-4 h-4 text-primary" />
                  AI Sağlayıcı
                </label>
                <div className="p-2.5 rounded-lg border border-sky-500/30 bg-sky-500/5 text-sm text-muted-foreground">
                  Google Gemini ({FIXED_MODEL.id})
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Key className="w-4 h-4 text-primary" />
                  Google API Key (AI Studio)
                </label>
                {keys.length > 0 && (
                  <div className="space-y-2 max-h-32 overflow-y-auto">
                    {keys.map((k, idx) => (
                      <div 
                        key={idx} 
                        onClick={() => setActiveIndex(idx)}
                        className={`flex items-center justify-between p-2 rounded-lg border cursor-pointer transition-colors ${activeIndex === idx ? 'border-sky-500' : 'border-border bg-muted/30 hover:bg-muted/50'}`}
                        style={activeIndex === idx ? { borderColor: customPrimaryColor, backgroundColor: customPrimaryColor + '10' } : {}}
                      >
                        <div className="flex items-center gap-2 flex-1 overflow-hidden">
                          <div 
                            className={`w-3 h-3 rounded-full border-2 flex-shrink-0 ${activeIndex === idx ? 'border-sky-500' : 'border-muted-foreground'}`}
                            style={activeIndex === idx ? { borderColor: customPrimaryColor, backgroundColor: customPrimaryColor + '20' } : {}}
                          >
                            {activeIndex === idx && (
                              <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: customPrimaryColor }} />
                            )}
                          </div>
                          <span className="text-xs font-mono truncate">{k.slice(0, 12)}...{k.slice(-4)}</span>
                        </div>
                        <button 
                          onClick={(e) => { e.stopPropagation(); handleRemoveKey(idx); }} 
                          className="p-1 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    type="password"
                    className="flex h-9 w-full rounded-lg border border-input bg-background/50 px-3 text-sm"
                    placeholder="AIzaSy..."
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddKey()}
                  />
                  <button onClick={handleAddKey} className="h-9 px-3 bg-secondary text-secondary-foreground rounded-lg text-sm font-medium hover:bg-secondary/80">
                    Ekle
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-2 duration-200">
              <div className="flex flex-col gap-3">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                  Tema
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'system', label: 'Sistem' },
                    { id: 'light', label: 'Açık' },
                    { id: 'dark', label: 'Koyu' }
                  ].map(opt => (
                    <button
                      key={opt.id}
                      onClick={() => setTheme(opt.id)}
                      className={`p-2 rounded-lg border text-xs font-medium transition-all ${theme === opt.id ? 'border-sky-500 bg-sky-500/10' : 'border-border hover:bg-secondary'}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                  Dil
                </label>
                <select
                  value={selectedLanguage}
                  onChange={(e) => handleLanguageChange(e.target.value)}
                  className="h-9 rounded-lg border border-input bg-background/50 px-3 text-sm"
                >
                  {AVAILABLE_LANGUAGES.map(lang => (
                    <option key={lang.code} value={lang.code}>{lang.flag} {lang.name}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-3">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                  Sistem Talimatı
                </label>
                <textarea
                  value={systemInstruction}
                  onChange={(e) => setSystemInstruction(e.target.value)}
                  placeholder="AI nasıl davranmalı, kim olmalı..."
                  className="min-h-[80px] w-full resize-y rounded-lg border border-input bg-background/50 px-3 py-2 text-sm"
                />
              </div>
            </div>
          )}
        </div>

        <button
          onClick={handleSave}
          disabled={keys.length === 0 && !newKey.trim()}
          className="inline-flex items-center justify-center rounded-lg text-sm font-bold transition-all bg-sky-500 text-white hover:bg-sky-600 h-10 px-4 gap-2 shadow-md disabled:opacity-50 disabled:pointer-events-none"
        >
          <Save className="w-4 h-4" />
          Kaydet
        </button>
      </div>
    </div>
  )
}

export default SettingsPanel
