import { useState, useEffect } from 'react'
import {
  Settings,
  Save,
  Sparkles,
  ArrowLeft,
  Loader2,
  Key,
  Eye,
  EyeOff,
  ShieldAlert,
  ChevronDown,
  ExternalLink,
  Pause,
  Play,
  Cloud,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { notifyError, notifySuccess } from '../lib/notify'
import i18n from '../i18n'
import { testKey } from '../lib/api'
import { getKeys, addKey, removeKey, setPrimary, getRawKey, updateKeyMetadata } from '../lib/keyManager'
import SyncPanel from './SyncPanel'

const AVAILABLE_LANGUAGES = [
  { code: 'tr', name: 'Türkçe', flag: '🇹🇷' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
]

const KEY_PROVIDERS = [
  { id: 'gemini', keyUrl: 'https://aistudio.google.com/api-keys' },
  { id: 'openrouter', keyUrl: 'https://openrouter.ai/settings/keys' },
  { id: 'ollama', keyUrl: 'https://ollama.com/settings/keys' },
  { id: 'tavily', keyUrl: 'https://app.tavily.com/home' },
]

function computeStatus(key) {
  const now = Date.now()
  if (key.status === 'paused') return 'paused'
  if (key.status === 'invalid') return 'invalid'
  if (key.status === 'cooldown' && key.cooldownUntil && key.cooldownUntil > now) return 'rate_limited'
  if (key.lastErrorType === 'rate_limited' && key.cooldownUntil && key.cooldownUntil > now) return 'rate_limited'
  if (key.lastErrorType === 'quota_exceeded') return 'quota_exceeded'
  if (key.lastErrorType === 'invalid') return 'invalid'
  if (['network', 'timeout', 'model_unavailable', 'service_unavailable', 'billing_required', 'permission_denied'].includes(key.lastErrorType)) {
    return key.lastSuccessAt ? 'success' : 'pending'
  }
  if (key.lastErrorAt && (!key.lastSuccessAt || key.lastErrorAt > key.lastSuccessAt)) return 'pending'
  if (key.lastSuccessAt) return 'success'
  return 'pending'
}

function statusPillClasses(status) {
  if (status === 'success') return 'bg-green-500/10 text-green-500 border-green-500/20'
  if (status === 'rate_limited') return 'bg-amber-500/10 text-amber-500 border-amber-500/20'
  if (status === 'quota_exceeded') return 'bg-red-500/10 text-red-500 border-red-500/20'
  if (status === 'invalid') return 'bg-red-500/10 text-red-500 border-red-500/20'
  if (status === 'paused') return 'bg-slate-500/10 text-slate-500 border-slate-500/20'
  return 'bg-secondary text-muted-foreground border-border'
}

function friendlyTestMessage(t, errorType) {
  switch (errorType) {
    case 'invalid': return t('setup.keys.test_invalid')
    case 'quota': return t('setup.keys.test_quota')
    case 'rate_limit': return t('setup.keys.test_rate_limit')
    case 'network': return t('setup.keys.test_network')
    case 'timeout': return t('setup.keys.test_timeout')
    case 'model_unavailable': return t('setup.keys.test_model_unavailable')
    case 'service_unavailable': return t('setup.keys.test_service_unavailable')
    case 'billing_required': return t('setup.keys.test_billing_required')
    case 'permission_denied': return t('setup.keys.test_permission_denied')
    default: return t('setup.keys.test_unknown')
  }
}

function SettingsPanel({ onSave, currentConfig, onClose, currentModel }) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState('api')

  const [theme, setTheme] = useState(currentConfig?.theme || 'system')
  const [customPrimaryColor, setCustomPrimaryColor] = useState(currentConfig?.customPrimaryColor || '#7c5cff')

  const [systemInstruction, setSystemInstruction] = useState(currentConfig?.systemInstruction || '')
  const [selectedLanguage, setSelectedLanguage] = useState(currentConfig?.language || 'tr')
  const [showSources, setShowSources] = useState(currentConfig?.showSources === true)
  const [apiKeyUsageMode, setApiKeyUsageMode] = useState(
    currentConfig?.apiKeyUsageMode === 'balanced_rotation' ? 'balanced_rotation' : 'primary',
  )

  const [geminiKeys, setGeminiKeys] = useState([])
  const [tavilyKeys, setTavilyKeys] = useState([])
  const [openRouterKeys, setOpenRouterKeys] = useState([])
  const [ollamaKeys, setOllamaKeys] = useState([])
  const [newGeminiKey, setNewGeminiKey] = useState('')
  const [newTavilyKey, setNewTavilyKey] = useState('')
  const [newOpenRouterKey, setNewOpenRouterKey] = useState('')
  const [newOllamaKey, setNewOllamaKey] = useState('')
  const [testingKeyId, setTestingKeyId] = useState(null)
  const [testingAllProvider, setTestingAllProvider] = useState(null)
  const [showGeminiInput, setShowGeminiInput] = useState(false)
  const [showTavilyInput, setShowTavilyInput] = useState(false)
  const [showOpenRouterInput, setShowOpenRouterInput] = useState(false)
  const [showOllamaInput, setShowOllamaInput] = useState(false)
  const [expandedProviders, setExpandedProviders] = useState(['gemini'])

  const handleLanguageChange = (langCode) => {
    setSelectedLanguage(langCode)
    i18n.changeLanguage(langCode)
  }

  useEffect(() => {
    async function load() {
      // Kasa erişilemezse (ör. sekme kapanırken IndexedDB kesilirse) arayüz
      // çökmemeli: liste boş kalır, hata konsola düşer.
      try {
        setGeminiKeys(await getKeys('gemini'))
        setTavilyKeys(await getKeys('tavily'))
        setOpenRouterKeys(await getKeys('openrouter'))
        setOllamaKeys(await getKeys('ollama'))
      } catch (error) {
        console.error('key_vault_load_failed', error)
      }
    }
    load()
  }, [])

  const refreshKeys = async (provider) => {
    try {
      if (provider === 'gemini') setGeminiKeys(await getKeys('gemini'))
      else if (provider === 'tavily') setTavilyKeys(await getKeys('tavily'))
      else if (provider === 'openrouter') setOpenRouterKeys(await getKeys('openrouter'))
      else if (provider === 'ollama') setOllamaKeys(await getKeys('ollama'))
    } catch (error) {
      console.error('key_vault_refresh_failed', error)
    }
  }

  const handleAddKey = async (provider) => {
    const rawKeys = {
      gemini: newGeminiKey,
      tavily: newTavilyKey,
      openrouter: newOpenRouterKey,
      ollama: newOllamaKey,
    }
    const rawKey = rawKeys[provider] || ''
    if (!rawKey.trim()) {
      notifyError(t('setup.keys.empty_error'))
      return
    }
    try {
      await addKey(provider, rawKey)
      notifySuccess(t('setup.keys.add_success'))
      if (provider === 'gemini') setNewGeminiKey('')
      else if (provider === 'tavily') setNewTavilyKey('')
      else if (provider === 'openrouter') setNewOpenRouterKey('')
      else if (provider === 'ollama') setNewOllamaKey('')
      await refreshKeys(provider)
    } catch (err) {
      if (err.message === 'key_duplicate_error') {
        notifyError(t('setup.keys.duplicate_error'))
      } else {
        notifyError(t('setup.keys.add_failed'))
      }
    }
  }

  const handleRemoveKey = async (provider, id) => {
    await removeKey(provider, id)
    notifySuccess(t('setup.keys.delete_success'))
    await refreshKeys(provider)
  }

  const handleSetPrimary = async (provider, id) => {
    await setPrimary(provider, id)
    await refreshKeys(provider)
  }

  const handleTogglePaused = async (provider, key) => {
    await updateKeyMetadata(provider, key.id, {
      status: key.status === 'paused' ? 'ready' : 'paused',
      ...(key.status === 'paused' ? { cooldownUntil: null, failCount: 0 } : {}),
    })
    await refreshKeys(provider)
  }

  const applyTestResult = async (provider, id, result) => {
    if (result.success) {
      await updateKeyMetadata(provider, id, {
        lastSuccessAt: Date.now(),
        lastErrorAt: null,
        lastErrorType: null,
        cooldownUntil: null,
        failCount: 0,
      })
    } else {
      const mappedType = result.errorType === 'rate_limit'
        ? 'rate_limited'
        : result.errorType === 'quota'
          ? 'quota_exceeded'
          : result.errorType || 'unknown'
      const updates = {
        lastErrorAt: Date.now(),
        lastErrorType: mappedType,
        failCount: 1,
      }
      if (result.errorType === 'rate_limit') {
        updates.cooldownUntil = Date.now() + 60000
      }
      await updateKeyMetadata(provider, id, updates)
    }
  }

  const handleTestKey = async (provider, id) => {
    const keyId = `${provider}:${id}`
    setTestingKeyId(keyId)
    try {
      const rawKey = await getRawKey(provider, id)
      if (!rawKey) {
        notifyError(t('setup.keys.test_failed'))
        return
      }
      const result = await testKey(provider, rawKey, currentModel)
      await applyTestResult(provider, id, result)
      await refreshKeys(provider)
      if (result.success) {
        notifySuccess(t('setup.keys.test_success'))
      } else {
        notifyError(friendlyTestMessage(t, result.errorType))
      }
    } catch {
      notifyError(t('setup.keys.test_failed'))
    } finally {
      setTestingKeyId(null)
    }
  }

  const handleTestAll = async (provider) => {
    const keysList = {
      gemini: geminiKeys,
      tavily: tavilyKeys,
      openrouter: openRouterKeys,
      ollama: ollamaKeys,
    }[provider] || []
    if (keysList.length === 0) return
    setTestingAllProvider(provider)
    try {
      for (const key of keysList) {
        const rawKey = await getRawKey(provider, key.id)
        if (!rawKey) continue
        try {
          const result = await testKey(provider, rawKey, currentModel)
          await applyTestResult(provider, key.id, result)
          await refreshKeys(provider)
        } catch {
          // ignore per-key surprise; leave the stored status alone
        }
      }
    } finally {
      setTestingAllProvider(null)
    }
  }

  const handleSave = () => {
    const newConfig = {
      theme,
      startupBehavior: currentConfig?.startupBehavior || 'resume',
      systemInstruction,
      customPrimaryColor,
      language: selectedLanguage,
      showSources,
      apiKeyUsageMode,
    }

    chrome.storage.local.set(newConfig, () => {
      onSave(newConfig)
      notifySuccess(t('setup.api.saved_success'))
    })
  }

  const renderKeyRow = (provider, key) => {
    const status = computeStatus(key)
    const statusLabel = t(`setup.keys.status_${status}`)
    const testing = testingKeyId === `${provider}:${key.id}`
    const minutesAgo = key.lastErrorAt ? Math.max(0, Math.floor((Date.now() - key.lastErrorAt) / 60000)) : null

    return (
      <div key={key.id} className="overflow-hidden rounded-xl border border-border/75 bg-gradient-to-b from-primary/[0.08] to-transparent bg-background/50">
        <div className="flex items-center gap-2 px-3 pt-2.5">
          <Key className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate font-mono text-sm tracking-wide text-foreground">{key.masked}</span>
          {key.isPrimary && (
            <span className="shrink-0 rounded-full bg-gradient-to-r from-primary to-violet-500 px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
              {t('setup.keys.primary_badge')}
            </span>
          )}
          <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${statusPillClasses(status)}`}>
            {statusLabel}
          </span>
        </div>
        <div className="flex items-center gap-3 px-3 pt-1 text-[10px] text-muted-foreground flex-wrap">
          {key.lastUsedAt && (
            <span>{t('setup.keys.last_used')}: {new Date(key.lastUsedAt).toLocaleDateString()}</span>
          )}
          {key.cooldownUntil && key.cooldownUntil > Date.now() && (
            <span className="text-amber-500">{t('setup.keys.cooldown_until')}: {new Date(key.cooldownUntil).toLocaleTimeString()}</span>
          )}
          {minutesAgo != null && (
            <span>{t('setup.keys.last_error', { minutes: minutesAgo })}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 p-2">
          <button
            onClick={() => handleTestKey(provider, key.id)}
            disabled={testing || testingAllProvider === provider}
            className="flex h-8 flex-1 items-center justify-center gap-1 rounded-lg bg-gradient-to-r from-primary to-violet-500 text-xs font-semibold text-primary-foreground shadow-sm shadow-primary/25 hover:opacity-90 disabled:pointer-events-none disabled:opacity-45"
          >
            {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
            {testing ? t('setup.keys.testing') : t('setup.keys.test_btn')}
          </button>
          <button
            type="button"
            onClick={() => handleTogglePaused(provider, key)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/70 hover:bg-secondary/60"
            title={key.status === 'paused' ? t('setup.keys.resume') : t('setup.keys.pause')}
            aria-label={key.status === 'paused' ? t('setup.keys.resume') : t('setup.keys.pause')}
          >
            {key.status === 'paused' ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </button>
          {!key.isPrimary && (
            <button
              onClick={() => handleSetPrimary(provider, key.id)}
              className="h-8 shrink-0 rounded-lg border border-border/70 px-2.5 text-xs font-medium hover:bg-secondary/60"
            >
              {t('setup.keys.set_primary')}
            </button>
          )}
          <button
            onClick={() => handleRemoveKey(provider, key.id)}
            className="h-8 shrink-0 rounded-lg border border-destructive/30 px-2.5 text-xs font-medium text-destructive hover:bg-destructive/10"
          >
            {t('setup.keys.delete_btn')}
          </button>
        </div>
      </div>
    )
  }

  const renderKeySection = (provider) => {
    const providerConfig = KEY_PROVIDERS.find(item => item.id === provider)
    const providerState = {
      gemini: [geminiKeys, newGeminiKey, setNewGeminiKey, showGeminiInput, setShowGeminiInput],
      tavily: [tavilyKeys, newTavilyKey, setNewTavilyKey, showTavilyInput, setShowTavilyInput],
      openrouter: [openRouterKeys, newOpenRouterKey, setNewOpenRouterKey, showOpenRouterInput, setShowOpenRouterInput],
      ollama: [ollamaKeys, newOllamaKey, setNewOllamaKey, showOllamaInput, setShowOllamaInput],
    }[provider]
    const [keysList, inputValue, setInputValue, showInput, setShowInput] = providerState
    const testingAll = testingAllProvider === provider
    const readyCount = keysList.filter(key => computeStatus(key) === 'success').length

    return (
      <div className="flex flex-col gap-3 rounded-xl border border-border/75 bg-background/35 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">
            {t('setup.keys.new_key_title')}
          </span>
          <a
            className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
            href={providerConfig.keyUrl}
            target="_blank"
            rel="noreferrer"
          >
            {t(`setup.keys.${provider}_key_link`)}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <div className="flex items-stretch gap-0 overflow-hidden rounded-lg border border-primary/30 focus-within:ring-2 focus-within:ring-primary/30">
          <div className="relative min-w-0 flex-1">
            <input
              type={showInput ? 'text' : 'password'}
              className="flex h-9 w-full border-0 bg-background/50 pl-3 pr-9 text-sm font-mono focus:outline-none"
              placeholder={t('setup.keys.add_placeholder')}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddKey(provider)}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShowInput(prev => !prev)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
              aria-label={showInput ? t('setup.keys.hide_key') : t('setup.keys.show_key')}
              title={showInput ? t('setup.keys.hide_key') : t('setup.keys.show_key')}
            >
              {showInput ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <button
            onClick={() => handleAddKey(provider)}
            className="shrink-0 bg-gradient-to-r from-primary to-violet-500 px-3.5 text-sm font-semibold text-primary-foreground hover:opacity-90 flex items-center gap-1.5"
          >
            {t('setup.keys.add_btn')}
          </button>
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          {t('setup.keys.test_usage_warning')}
        </p>
        {keysList.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('setup.keys.no_keys')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t('setup.keys.summary', { total: keysList.length, ready: readyCount })}
              </span>
              <button
                onClick={() => handleTestAll(provider)}
                disabled={testingAll}
                className="h-7 px-2 bg-secondary/80 text-secondary-foreground rounded text-xs font-medium hover:bg-secondary flex items-center gap-1 disabled:opacity-50"
              >
                {testingAll ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                {testingAll ? t('setup.keys.testing') : t('setup.keys.test_all_btn')}
              </button>
            </div>
            {keysList.map((key) => renderKeyRow(provider, key))}
          </div>
        )}
      </div>
    )
  }

  const renderProviderCard = (provider) => {
    const keysList = {
      gemini: geminiKeys,
      tavily: tavilyKeys,
      openrouter: openRouterKeys,
      ollama: ollamaKeys,
    }[provider] || []
    const isExpanded = expandedProviders.includes(provider)
    const headingId = `provider-heading-${provider}`
    const panelId = `provider-panel-${provider}`

    return (
      <section key={provider} className={`overflow-hidden rounded-xl border bg-background/35 transition-colors ${isExpanded ? 'border-primary/30 shadow-sm shadow-primary/10' : 'border-border/75'}`}>
        <button
          id={headingId}
          type="button"
          onClick={() => setExpandedProviders(current => current.includes(provider) ? current.filter(item => item !== provider) : [...current, provider])}
          aria-expanded={isExpanded}
          aria-controls={panelId}
          className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-secondary/45"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Key className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate text-xs font-semibold text-foreground">
              {t(`setup.keys.${provider}_section`)}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
              {keysList.length}
            </span>
            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
          </span>
        </button>
        <div
          id={panelId}
          role="region"
          aria-labelledby={headingId}
          hidden={!isExpanded}
          className="border-t border-border/70 p-3"
        >
          {renderKeySection(provider)}
        </div>
      </section>
    )
  }

  return (
    <div className="hera-panel flex h-full min-h-screen w-full flex-col bg-background text-foreground">
      <header className="hera-panel-header">
        <div className="flex min-w-0 items-center gap-2.5">
          {onClose ? (
            <button type="button" onClick={onClose} className="hera-icon-button -ml-1" aria-label={t('common.back')}>
              <ArrowLeft className="h-4 w-4" />
            </button>
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Settings className="h-4 w-4" />
            </span>
          )}
          <h1 className="hera-panel-title truncate">{t('setup.title')}</h1>
        </div>
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-lg flex-1 flex-col gap-3 overflow-y-auto p-3 pb-8">
        <div className="flex shrink-0 rounded-xl border border-border/60 bg-secondary/55 p-1">
          <button
            type="button"
            onClick={() => setActiveTab('api')}
            className={`flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors ${activeTab === 'api' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Key className="h-3.5 w-3.5" /> {t('setup.tabs.api')}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('settings')}
            className={`flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors ${activeTab === 'settings' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Sparkles className="h-3.5 w-3.5" /> {t('setup.tabs.general')}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('sync')}
            className={`flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors ${activeTab === 'sync' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Cloud className="h-3.5 w-3.5" /> {t('setup.tabs.sync')}
          </button>
        </div>

        <div className="hera-section-card min-h-[300px] shrink-0 p-3.5">
          {activeTab === 'api' && (
            <div className="hera-fade-in flex flex-col gap-4">
              <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-3 text-amber-700 dark:text-amber-300">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="text-[11px] leading-relaxed">{t('setup.keys.security_warning')}</p>
              </div>
              <div className="rounded-xl border border-primary/20 bg-primary/[0.05] p-3">
                <p className="text-xs font-semibold text-foreground">{t('setup.keys.usage_mode_title')}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{t('setup.keys.usage_mode_description')}</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {[
                    ['primary', t('setup.keys.usage_mode_primary')],
                    ['balanced_rotation', t('setup.keys.usage_mode_balanced')],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setApiKeyUsageMode(value)}
                      aria-pressed={apiKeyUsageMode === value}
                      className={`min-h-10 rounded-lg border px-2 text-[11px] font-semibold transition-colors ${
                        apiKeyUsageMode === value
                          ? 'border-primary/40 bg-primary/10 text-primary'
                          : 'border-border/70 bg-background/50 text-muted-foreground hover:bg-secondary/60'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-2">
                {KEY_PROVIDERS.map(({ id }) => renderProviderCard(id))}
              </div>
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="hera-fade-in flex flex-col gap-5">
              <div className="flex flex-col gap-3">
                <label className="flex items-center gap-2 text-xs font-semibold text-foreground">
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
                      type="button"
                      onClick={() => setTheme(opt.id)}
                      className={`min-h-9 rounded-lg border px-1.5 text-[11px] font-medium transition-all ${theme === opt.id ? 'border-primary/35 bg-primary/10 text-primary' : 'border-border/80 hover:bg-secondary'}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center justify-between rounded-xl border border-border/70 bg-secondary/35 p-2.5">
                  <span className="text-[11px] font-medium text-muted-foreground">{t('setup.general.accent_color')}</span>
                  <div className="flex items-center gap-1.5">
                    {['#7c5cff', '#2563eb', '#0f9f8f', '#e35d8f'].map((color) => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setCustomPrimaryColor(color)}
                        aria-label={`${t('setup.general.accent_color')} ${color}`}
                        className={`h-6 w-6 rounded-full border-2 transition-transform hover:scale-105 ${
                          customPrimaryColor === color ? 'border-foreground' : 'border-transparent'
                        }`}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                    <input
                      type="color"
                      value={customPrimaryColor}
                      onChange={(event) => setCustomPrimaryColor(event.target.value)}
                      aria-label={t('setup.general.custom_accent_color')}
                      className="h-6 w-6 cursor-pointer overflow-hidden rounded-full border-0 bg-transparent p-0"
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <label className="flex items-center gap-2 text-xs font-semibold text-foreground">
                  {t('setup.general.language_title')}
                </label>
                <select
                  value={selectedLanguage}
                  onChange={(e) => handleLanguageChange(e.target.value)}
                  className="h-9 rounded-lg border border-input bg-background/60 px-3 text-xs"
                >
                  {AVAILABLE_LANGUAGES.map(lang => (
                    <option key={lang.code} value={lang.code}>{lang.flag} {lang.name}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between gap-4 rounded-xl border border-border/70 bg-secondary/35 p-3">
                <div className="min-w-0">
                  <span className="block text-xs font-semibold text-foreground">
                    {t('setup.general.sources_title')}
                  </span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                    {t('setup.general.sources_description')}
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={showSources}
                  aria-label={t('setup.general.sources_title')}
                  onClick={() => setShowSources(value => !value)}
                  className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                    showSources
                      ? 'border-primary bg-primary'
                      : 'border-border bg-muted/80'
                  }`}
                >
                  <span
                    className={`pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform duration-200 ${
                      showSources ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              <p className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3 text-[11px] leading-relaxed text-muted-foreground">
                {t('setup.general.voice_api_notice')}
              </p>

              <div className="flex flex-col gap-3">
                <label className="flex items-center gap-2 text-xs font-semibold text-foreground">
                  {t('setup.ai.system_prompt_title')}
                </label>
                <textarea
                  data-testid="system-instruction-input"
                  value={systemInstruction}
                  onChange={(e) => setSystemInstruction(e.target.value)}
                  placeholder={t('setup.ai.system_prompt_placeholder')}
                  className="min-h-[90px] w-full resize-y rounded-xl border border-input bg-background/60 px-3 py-2.5 text-xs leading-relaxed"
                />
              </div>
            </div>
          )}
          {activeTab === 'sync' && <SyncPanel />}
        </div>

        {activeTab !== 'sync' && <button
          type="button"
          onClick={handleSave}
          className="inline-flex h-10 w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-xs font-semibold text-primary-foreground shadow-md shadow-primary/15 transition-all hover:brightness-105 active:scale-[0.99]"
        >
          <Save className="h-4 w-4" />
          {t('setup.api.save_btn')}
        </button>}
      </div>
    </div>
  )
}

export default SettingsPanel
