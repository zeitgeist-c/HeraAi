import { useState, useEffect } from 'react'
import { Settings, Key, Save, Trash2, Sparkles, Bot, Globe, ArrowLeft, Search, RefreshCw, Filter } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import i18n from '../i18n'
import { fetchOpenRouterModels, clearModelsCache } from '../lib/openRouterModels'
import { fetchOllamaModels } from '../lib/ollama'

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

const AVAILABLE_MODELS = [
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', category: 'Google', supports: ['pdf', 'image', 'text'] },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', category: 'Google', supports: ['pdf', 'image', 'text'] },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', provider: 'google', category: 'Google', supports: ['pdf', 'image', 'text'] },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'google', category: 'Google', supports: ['pdf', 'image', 'text'] },
  { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash Exp', provider: 'google', category: 'Google', supports: ['pdf', 'image', 'text'] },
  { id: 'gemini-2.0-pro-exp', name: 'Gemini 2.0 Pro Exp', provider: 'google', category: 'Google', supports: ['pdf', 'image', 'text'] },
  { id: 'gemini-2.0-flash-thinking', name: 'Gemini 2.0 Flash Thinking', provider: 'google', category: 'Google', supports: ['pdf', 'image', 'text'] },
  { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', provider: 'google', category: 'Google', supports: ['pdf', 'image', 'text'] },
  { id: 'gemini-1.5-flash-8b', name: 'Gemini 1.5 Flash 8B', provider: 'google', category: 'Google', supports: ['pdf', 'image', 'text'] },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', provider: 'google', category: 'Google', supports: ['pdf', 'image', 'text'] },
  { id: 'gemini-1.5-pro-exp', name: 'Gemini 1.5 Pro Exp', provider: 'google', category: 'Google', supports: ['pdf', 'image', 'text'] },
  { id: 'gemini-1.5-flash-exp', name: 'Gemini 1.5 Flash Exp', provider: 'google', category: 'Google', supports: ['pdf', 'image', 'text'] },
  { id: 'gemini-exp-1206', name: 'Gemini Exp 1206', provider: 'google', category: 'Google', supports: ['pdf', 'image', 'text'] },
  { id: 'gemini-exp-1121', name: 'Gemini Exp 1121', provider: 'google', category: 'Google', supports: ['pdf', 'image', 'text'] },
  { id: 'learnrm-32b', name: 'LearnRM 32B', provider: 'google', category: 'Google', supports: ['pdf', 'image', 'text'] },
]

const PRICE_FILTERS = {
  google: [],
  openrouter: [
    { id: 'all', label: 'Tümü' },
    { id: 'free', label: '💚 Ücretsiz' },
    { id: 'paid', label: '💰 Ücretli' },
  ],
  ollama: [
    { id: 'all', label: 'Tümü' },
    { id: 'cloud', label: '☁️ Cloud' },
    { id: 'local', label: '💾 Local' },
  ]
}

const DEFAULT_MODEL = 'gemini-2.5-flash'

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
  const [selectedModel, setSelectedModel] = useState(currentConfig?.selectedModel || DEFAULT_MODEL)
  const [selectedLanguage, setSelectedLanguage] = useState(currentConfig?.language || 'tr')
  const [apiProvider, setApiProvider] = useState(currentConfig?.apiProvider || 'google')
  const [openRouterKey, setOpenRouterKey] = useState(currentConfig?.openRouterKey || '')
  const [ollamaKey, setOllamaKey] = useState(currentConfig?.ollamaKey || '')

  const [openRouterModels, setOpenRouterModels] = useState([])
  const [ollamaModels, setOllamaModels] = useState([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const [priceFilter, setPriceFilter] = useState('all')

  const filteredStaticModels = AVAILABLE_MODELS.filter(m => 
    m.provider === apiProvider
  )

  const filterOpenRouterModels = (models) => {
    return models.filter(m => {
      const matchesSearch = 
        modelSearch === '' ||
        m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
        m.id.toLowerCase().includes(modelSearch.toLowerCase())
      
      const promptPrice = m.pricing?.prompt
      const isFree = promptPrice === 0 || promptPrice === '0' || promptPrice === null || promptPrice === undefined
      
      const matchesPrice = 
        priceFilter === 'all' ||
        (priceFilter === 'free' && isFree) ||
        (priceFilter === 'paid' && !isFree)
      
      return matchesSearch && matchesPrice
    })
  }

  const filteredOpenRouterModels = filterOpenRouterModels(openRouterModels)
  const filteredOllamaModels = (() => {
    return ollamaModels.filter(m => {
      const matchesSearch = 
        modelSearch === '' ||
        m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
        m.id.toLowerCase().includes(modelSearch.toLowerCase())
      
      const isCloud = m.id.includes('-cloud')
      
      const matchesPrice = 
        priceFilter === 'all' ||
        (priceFilter === 'cloud' && isCloud) ||
        (priceFilter === 'local' && !isCloud)
      
      return matchesSearch && matchesPrice
    })
  })()

  useEffect(() => {
    let cancelled = false
    const loadModels = async () => {
      if (apiProvider === 'openrouter' && openRouterKey) {
        if (cancelled) return
        setModelsLoading(true)
        
        try {
          const models = await fetchOpenRouterModels(openRouterKey)
          if (cancelled) return
          
          setOpenRouterModels(models)
          const validModel = models.some(m => m.id === selectedModel)
          if (!validModel && models.length > 0) {
            setSelectedModel(models[0].id)
          }
        } catch (err) {
          if (!cancelled) {
            console.error('Failed to load OpenRouter models:', err)
            toast.error('OpenRouter model listesi yüklenemedi')
          }
        } finally {
          if (!cancelled) {
            setModelsLoading(false)
          }
        }
      } else if (apiProvider === 'ollama') {
        if (cancelled) return
        setModelsLoading(true)
        
        try {
          const models = await fetchOllamaModels(ollamaKey)
          if (cancelled) return
          
          setOllamaModels(models)
          const validModel = models.some(m => m.id === selectedModel)
          if (!validModel && models.length > 0) {
            setSelectedModel(models[0].id)
          }
        } catch (err) {
          if (!cancelled) {
            console.error('Failed to load Ollama models:', err)
            toast.error('Ollama model listesi yüklenemedi')
          }
        } finally {
          if (!cancelled) {
            setModelsLoading(false)
          }
        }
      }
    }
    
    loadModels()
    
    return () => {
      cancelled = true
    }
  }, [apiProvider, openRouterKey, ollamaKey, selectedModel])

  const getDefaultModelForProvider = (provider) => {
    if (provider === 'openrouter' && openRouterModels.length > 0) {
      return openRouterModels[0].id
    }
    if (provider === 'ollama' && ollamaModels.length > 0) {
      return ollamaModels[0].id
    }
    const providerModels = AVAILABLE_MODELS.filter(m => m.provider === provider)
    return providerModels[0]?.id || DEFAULT_MODEL
  }

  const handleApiProviderChange = (newProvider) => {
    setApiProvider(newProvider)
    const currentModelValid = 
      (apiProvider === 'openrouter' && openRouterModels.some(m => m.id === selectedModel)) ||
      (apiProvider === 'ollama' && ollamaModels.some(m => m.id === selectedModel)) ||
      AVAILABLE_MODELS.some(m => m.id === selectedModel && m.provider === newProvider)
    if (!currentModelValid) {
      setSelectedModel(getDefaultModelForProvider(newProvider))
    }
  }

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

  const handleRefreshModels = () => {
    if (apiProvider === 'openrouter') {
      clearModelsCache()
      setModelsLoading(true)
      fetchOpenRouterModels(openRouterKey)
        .then(setOpenRouterModels)
        .catch(err => toast.error('Model listesi yüklenemedi'))
        .finally(() => setModelsLoading(false))
    } else if (apiProvider === 'ollama') {
      setModelsLoading(true)
      fetchOllamaModels(ollamaKey)
        .then(setOllamaModels)
        .catch(err => toast.error('Model listesi yüklenemedi'))
        .finally(() => setModelsLoading(false))
    }
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
      selectedModel: selectedModel,
      customPrimaryColor: customPrimaryColor,
      language: selectedLanguage,
      apiProvider: apiProvider,
      openRouterKey: openRouterKey,
      ollamaKey: ollamaKey
    }

    chrome.storage.local.set(newConfig, () => {
      onSave(newConfig)
      toast.success(t('setup.api.saved_success') || 'Settings saved!')
    })
  }

  const renderModelSupports = (model) => {
    const supportedModalities = model.supportedModalities || []
    const supports = model.supports || {}
    
    const hasImage = supportedModalities.includes('image') || supports.image
    const hasPdf = supportedModalities.includes('file') || supports.pdf
    const promptPrice = model.pricing?.prompt
    const isFree = promptPrice === 0 || promptPrice === '0' || promptPrice === null || promptPrice === undefined
    
    return (
      <div className="flex items-center gap-1.5 mt-0.5">
        {hasImage && (
          <span className="px-1 py-0.5 bg-green-500/20 text-green-400 rounded text-[10px]">📷</span>
        )}
        {hasPdf && (
          <span className="px-1 py-0.5 bg-red-500/20 text-red-400 rounded text-[10px]">📄</span>
        )}
        {!hasImage && !hasPdf && (
          <span className="px-1 py-0.5 bg-blue-500/20 text-blue-400 rounded text-[10px]">📝</span>
        )}
        {isFree && (
          <span className="px-1 py-0.5 bg-emerald-500/20 text-emerald-400 rounded text-[10px]">💚</span>
        )}
      </div>
    )
  }

  const renderProviderBadge = (provider) => {
    const colors = {
      openai: 'bg-purple-500/20 text-purple-400',
      anthropic: 'bg-orange-500/20 text-orange-400',
      google: 'bg-blue-500/20 text-blue-400',
      deepseek: 'bg-cyan-500/20 text-cyan-400',
      'meta-llama': 'bg-pink-500/20 text-pink-400',
      mistralai: 'bg-rose-500/20 text-rose-400',
      qwen: 'bg-amber-500/20 text-amber-400',
      xai: 'bg-gray-500/20 text-gray-400',
      minimax: 'bg-teal-500/20 text-teal-400',
      moonshotai: 'bg-indigo-500/20 text-indigo-400',
      cohere: 'bg-violet-500/20 text-violet-400',
      stepfun: 'bg-green-500/20 text-green-400',
      'arcee-ai': 'bg-cyan-500/20 text-cyan-400',
      nvidia: 'bg-yellow-500/20 text-yellow-400',
    }
    const colorClass = colors[provider] || 'bg-gray-500/20 text-gray-400'
    return (
      <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${colorClass}`}>
        {provider}
      </span>
    )
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
            onClick={() => setActiveTab('models')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${activeTab === 'models' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Bot className="w-3.5 h-3.5" /> Modeller
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
                <div className="flex gap-2">
                  <button
                    onClick={() => handleApiProviderChange('google')}
                    className={`flex-1 p-2.5 rounded-lg border text-sm font-medium transition-all ${apiProvider === 'google' ? 'border-sky-500 bg-sky-500/10' : 'border-border hover:bg-secondary'}`}
                  >
                    Gemini
                  </button>
                  <button
                    onClick={() => handleApiProviderChange('openrouter')}
                    className={`flex-1 p-2.5 rounded-lg border text-sm font-medium transition-all ${apiProvider === 'openrouter' ? 'border-sky-500 bg-sky-500/10' : 'border-border hover:bg-secondary'}`}
                  >
                    OpenRouter
                  </button>
                  <button
                    onClick={() => handleApiProviderChange('ollama')}
                    className={`flex-1 p-2.5 rounded-lg border text-sm font-medium transition-all ${apiProvider === 'ollama' ? 'border-sky-500 bg-sky-500/10' : 'border-border hover:bg-secondary'}`}
                  >
                    Ollama
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Key className="w-4 h-4 text-primary" />
                  {apiProvider === 'google' ? 'Google API Key' : apiProvider === 'openrouter' ? 'OpenRouter API Key' : 'Ollama API Key'}
                </label>
                {apiProvider === 'google' && (
                  <>
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
                  </>
                )}
                {apiProvider === 'openrouter' && (
                  <input
                    type="password"
                    className="flex h-9 w-full rounded-lg border border-input bg-background/50 px-3 text-sm"
                    placeholder="sk-or-v1-..."
                    value={openRouterKey}
                    onChange={(e) => setOpenRouterKey(e.target.value)}
                  />
                )}
                {apiProvider === 'ollama' && (
                  <input
                    type="password"
                    className="flex h-9 w-full rounded-lg border border-input bg-background/50 px-3 text-sm"
                    placeholder="ollama API key..."
                    value={ollamaKey}
                    onChange={(e) => setOllamaKey(e.target.value)}
                  />
                )}
              </div>
            </div>
          )}

          {activeTab === 'models' && (
            <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
              <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Bot className="w-4 h-4 text-primary" />
                AI Model Seç
              </label>
              
              {(apiProvider === 'openrouter' || apiProvider === 'ollama') && (
                <>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                      type="text"
                      placeholder="Model ara..."
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      className="w-full h-9 pl-9 pr-3 rounded-lg border border-input bg-background/50 text-sm"
                    />
                  </div>
                  
                  <div className="flex flex-col gap-2 p-2 bg-secondary/30 rounded-lg">
                    <div className="flex items-center gap-2">
                      <Filter className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-xs font-medium text-muted-foreground">Fiyat</span>
                    </div>
                    
                    <div className="flex flex-wrap gap-1">
                      {(PRICE_FILTERS[apiProvider] || []).map(f => (
                        <button
                          key={f.id}
                          onClick={() => setPriceFilter(f.id)}
                          className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-all ${priceFilter === f.id ? 'bg-emerald-500 text-white' : 'bg-background text-muted-foreground hover:text-foreground border border-border'}`}
                        >
                          {f.label}
                        </button>
                      ))}
                      {apiProvider === 'google' && (
                        <span className="text-[10px] text-muted-foreground">Gemini için filtre yok</span>
                      )}
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {modelsLoading ? 'Yükleniyor...' : 
                        apiProvider === 'ollama' ? 
                          `${filteredOllamaModels.length} / ${ollamaModels.length} model` :
                          apiProvider === 'openrouter' ?
                          `${filteredOpenRouterModels.length} / ${openRouterModels.length} model` :
                          `${filteredStaticModels.length} model`
                      }
                    </span>
                    {apiProvider !== 'google' && (
                      <button
                        onClick={handleRefreshModels}
                        disabled={modelsLoading}
                        className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors disabled:opacity-50"
                        title="Model listesini yenile"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${modelsLoading ? 'animate-spin' : ''}`} />
                      </button>
                    )}
                  </div>
                </>
)}
               
              <div className="grid grid-cols-1 gap-1.5 max-h-72 overflow-y-auto">
                {apiProvider === 'ollama' ? (
                  modelsLoading ? (
                    <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
                      Model listesi yükleniyor...
                    </div>
                  ) : filteredOllamaModels.length === 0 ? (
                    <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
                      Model bulunamadı
                    </div>
                  ) : (
                    filteredOllamaModels.map(model => (
                      <label
                        key={model.id}
                        className="flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors text-xs"
                        style={selectedModel === model.id ? { 
                          borderColor: customPrimaryColor, 
                          backgroundColor: customPrimaryColor + '10' 
                        } : { 
                          borderColor: 'hsl(var(--border))', 
                          backgroundColor: 'hsl(var(--secondary))' 
                        }}
                      >
                        <input
                          type="radio"
                          name="selected_model"
                          checked={selectedModel === model.id}
                          onChange={() => setSelectedModel(model.id)}
                          className="w-3 h-3"
                          style={{ accentColor: customPrimaryColor }}
                        />
                        <div className="flex flex-col flex-1 min-w-0">
                          <span className="font-medium truncate">{model.name}</span>
                          {renderModelSupports(model)}
                        </div>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-purple-500/20 text-purple-400">
                          Ollama
                        </span>
                      </label>
                    ))
                  )
                ) : apiProvider === 'openrouter' ? (
                  modelsLoading ? (
                    <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
                      Model listesi yükleniyor...
                    </div>
                  ) : filteredOpenRouterModels.length === 0 ? (
                    <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
                      Model bulunamadı
                    </div>
                  ) : (
                    filteredOpenRouterModels.map(model => (
                      <label
                        key={model.id}
                        className="flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors text-xs"
                        style={selectedModel === model.id ? { 
                          borderColor: customPrimaryColor, 
                          backgroundColor: customPrimaryColor + '10' 
                        } : { 
                          borderColor: 'hsl(var(--border))', 
                          backgroundColor: 'hsl(var(--secondary))' 
                        }}
                      >
                        <input
                          type="radio"
                          name="selected_model"
                          checked={selectedModel === model.id}
                          onChange={() => setSelectedModel(model.id)}
                          className="w-3 h-3"
                          style={{ accentColor: customPrimaryColor }}
                        />
                        <div className="flex flex-col flex-1 min-w-0">
                          <span className="font-medium truncate">{model.name}</span>
                          {renderModelSupports(model)}
                        </div>
                        {renderProviderBadge(model.provider)}
                      </label>
                    ))
                  )
                ) : (
                  filteredStaticModels.map(model => (
                    <label
                      key={model.id}
                      className="flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors text-xs"
                      style={selectedModel === model.id ? { 
                        borderColor: customPrimaryColor, 
                        backgroundColor: customPrimaryColor + '10' 
                      } : { 
                        borderColor: 'hsl(var(--border))', 
                        backgroundColor: 'hsl(var(--secondary))' 
                      }}
                    >
                      <input
                        type="radio"
                        name="selected_model"
                        checked={selectedModel === model.id}
                        onChange={() => setSelectedModel(model.id)}
                        className="w-3 h-3"
                        style={{ accentColor: customPrimaryColor }}
                      />
                      <div className="flex flex-col flex-1 min-w-0">
                        <span className="font-medium truncate">{model.name}</span>
                        <div className="flex gap-1 mt-0.5">
                          {model.supports?.includes('pdf') && (
                            <span className="px-1 py-0.5 bg-red-500/20 text-red-400 rounded text-[10px]">📄</span>
                          )}
                          {model.supports?.includes('image') && (
                            <span className="px-1 py-0.5 bg-green-500/20 text-green-400 rounded text-[10px]">📷</span>
                          )}
                        </div>
                      </div>
                      <span className="text-muted-foreground text-[10px]">{model.category}</span>
                    </label>
                  ))
                )}
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
          disabled={apiProvider === 'google' && keys.length === 0 && !newKey.trim()}
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