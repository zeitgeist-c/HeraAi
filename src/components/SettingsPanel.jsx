import { useState, useEffect } from 'react'
import { Settings, Save, Sparkles, ArrowLeft, Loader2, Key, Eye, EyeOff, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import i18n from '../i18n'
import { testKey } from '../lib/api'
import { getKeys, addKey, removeKey, setPrimary, getRawKey, updateKeyMetadata } from '../lib/keyManager'

const AVAILABLE_LANGUAGES = [
  { code: 'tr', name: 'Türkçe', flag: '🇹🇷' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
]

function computeStatus(key) {
  const now = Date.now()
  if (key.lastErrorType === 'rate_limited' && key.cooldownUntil && key.cooldownUntil > now) return 'rate_limited'
  if (key.lastErrorType === 'quota_exceeded') return 'quota_exceeded'
  if (key.lastErrorType === 'invalid') return 'invalid'
  if (key.lastErrorAt && (!key.lastSuccessAt || key.lastErrorAt > key.lastSuccessAt)) return 'invalid'
  if (key.lastSuccessAt) return 'success'
  return 'pending'
}

function statusPillClasses(status) {
  if (status === 'success') return 'bg-green-500/10 text-green-500 border-green-500/20'
  if (status === 'rate_limited') return 'bg-amber-500/10 text-amber-500 border-amber-500/20'
  if (status === 'quota_exceeded') return 'bg-red-500/10 text-red-500 border-red-500/20'
  if (status === 'invalid') return 'bg-red-500/10 text-red-500 border-red-500/20'
  return 'bg-secondary text-muted-foreground border-border'
}

function friendlyTestMessage(t, errorType) {
  switch (errorType) {
    case 'invalid': return t('setup.keys.test_invalid')
    case 'quota': return t('setup.keys.test_quota')
    case 'rate_limit': return t('setup.keys.test_rate_limit')
    case 'network': return t('setup.keys.test_network')
    case 'timeout': return t('setup.keys.test_timeout')
    default: return t('setup.keys.test_unknown')
  }
}

function SettingsPanel({ onSave, currentConfig, onClose }) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState('api')

  const [theme, setTheme] = useState(currentConfig?.theme || 'system')
  const [customPrimaryColor, setCustomPrimaryColor] = useState(currentConfig?.customPrimaryColor || '#0ea5e9')

  const [systemInstruction, setSystemInstruction] = useState(currentConfig?.systemInstruction || '')
  const [selectedLanguage, setSelectedLanguage] = useState(currentConfig?.language || 'tr')

  const [geminiKeys, setGeminiKeys] = useState([])
  const [tavilyKeys, setTavilyKeys] = useState([])
  const [newGeminiKey, setNewGeminiKey] = useState('')
  const [newTavilyKey, setNewTavilyKey] = useState('')
  const [testingKeyId, setTestingKeyId] = useState(null)
  const [testingAllProvider, setTestingAllProvider] = useState(null)
  const [showGeminiInput, setShowGeminiInput] = useState(false)
  const [showTavilyInput, setShowTavilyInput] = useState(false)

  const handleLanguageChange = (langCode) => {
    setSelectedLanguage(langCode)
    i18n.changeLanguage(langCode)
  }

  useEffect(() => {
    async function load() {
      setGeminiKeys(await getKeys('gemini'))
      setTavilyKeys(await getKeys('tavily'))
    }
    load()
  }, [])

  const refreshKeys = async (provider) => {
    if (provider === 'gemini') setGeminiKeys(await getKeys('gemini'))
    else setTavilyKeys(await getKeys('tavily'))
  }

  const handleAddKey = async (provider) => {
    const rawKey = provider === 'gemini' ? newGeminiKey : newTavilyKey
    if (!rawKey.trim()) {
      toast.error(t('setup.keys.empty_error'))
      return
    }
    try {
      await addKey(provider, rawKey)
      toast.success(t('setup.keys.add_success'))
      if (provider === 'gemini') setNewGeminiKey('')
      else setNewTavilyKey('')
      await refreshKeys(provider)
    } catch (err) {
      if (err.message === 'key_duplicate_error') {
        toast.error(t('setup.keys.duplicate_error'))
      } else {
        toast.error(t('setup.keys.add_failed'))
      }
    }
  }

  const handleRemoveKey = async (provider, id) => {
    await removeKey(provider, id)
    toast.success(t('setup.keys.delete_success'))
    await refreshKeys(provider)
  }

  const handleSetPrimary = async (provider, id) => {
    await setPrimary(provider, id)
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
          : 'invalid'
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
        toast.error(t('setup.keys.test_failed'))
        return
      }
      const result = await testKey(provider, rawKey)
      await applyTestResult(provider, id, result)
      await refreshKeys(provider)
      if (result.success) {
        toast.success(t('setup.keys.test_success'))
      } else {
        toast.error(friendlyTestMessage(t, result.errorType))
      }
    } catch {
      toast.error(t('setup.keys.test_failed'))
    } finally {
      setTestingKeyId(null)
    }
  }

  const handleTestAll = async (provider) => {
    const keysList = provider === 'gemini' ? geminiKeys : tavilyKeys
    if (keysList.length === 0) return
    setTestingAllProvider(provider)
    try {
      for (const key of keysList) {
        const rawKey = await getRawKey(provider, key.id)
        if (!rawKey) continue
        try {
          const result = await testKey(provider, rawKey)
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
    }

    chrome.storage.local.set({ ...newConfig, apiProvider: 'google' }, () => {
      onSave(newConfig)
      toast.success(t('setup.api.saved_success'))
    })
  }

  const renderKeyRow = (provider, key) => {
    const status = computeStatus(key)
    const statusLabel = t(`setup.keys.status_${status}`)
    const testing = testingKeyId === `${provider}:${key.id}`
    const minutesAgo = key.lastErrorAt ? Math.max(0, Math.floor((Date.now() - key.lastErrorAt) / 60000)) : null

    return (
      <div key={key.id} className="flex flex-col gap-2 p-2.5 rounded-lg border border-border bg-background/50">
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-mono text-foreground">{key.masked}</span>
              {key.isPrimary && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-500 border border-green-500/20">
                  {t('setup.keys.primary_badge')}
                </span>
              )}
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${statusPillClasses(status)}`}>
                {statusLabel}
              </span>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground flex-wrap">
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
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => handleTestKey(provider, key.id)}
              disabled={testing || testingAllProvider === provider}
              className="h-7 px-2 bg-secondary text-secondary-foreground rounded text-xs font-medium hover:bg-secondary/80 disabled:opacity-50 flex items-center gap-1"
            >
              {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {testing ? t('setup.keys.testing') : t('setup.keys.test_btn')}
            </button>
            {!key.isPrimary && (
              <button
                onClick={() => handleSetPrimary(provider, key.id)}
                className="h-7 px-2 bg-secondary text-secondary-foreground rounded text-xs font-medium hover:bg-secondary/80"
              >
                {t('setup.keys.set_primary')}
              </button>
            )}
            <button
              onClick={() => handleRemoveKey(provider, key.id)}
              className="h-7 px-2 bg-destructive/10 text-destructive rounded text-xs font-medium hover:bg-destructive/20"
            >
              {t('setup.keys.delete_btn')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const renderKeySection = (provider) => {
    const keysList = provider === 'gemini' ? geminiKeys : tavilyKeys
    const inputValue = provider === 'gemini' ? newGeminiKey : newTavilyKey
    const setInputValue = provider === 'gemini' ? setNewGeminiKey : setNewTavilyKey
    const showInput = provider === 'gemini' ? showGeminiInput : showTavilyInput
    const setShowInput = provider === 'gemini' ? setShowGeminiInput : setShowTavilyInput
    const testingAll = testingAllProvider === provider

    return (
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Key className="w-4 h-4 text-primary" />
          {t(`setup.keys.${provider}_section`)}
        </h3>
        <div className="flex gap-2">
          <div className="relative flex-1 min-w-0">
            <input
              type={showInput ? 'text' : 'password'}
              className="flex h-9 w-full rounded-lg border border-input bg-background/50 pl-3 pr-9 text-sm font-mono"
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
            className="h-9 px-3 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/80 flex items-center gap-1.5"
          >
            {t('setup.keys.add_btn')}
          </button>
        </div>
        {keysList.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('setup.keys.no_keys')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <button
              onClick={() => handleTestAll(provider)}
              disabled={testingAll}
              className="self-end h-7 px-2 bg-secondary/80 text-secondary-foreground rounded text-xs font-medium hover:bg-secondary flex items-center gap-1 disabled:opacity-50"
            >
              {testingAll ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {testingAll ? t('setup.keys.testing') : t('setup.keys.test_all_btn')}
            </button>
            {keysList.map((key) => renderKeyRow(provider, key))}
          </div>
        )}
      </div>
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
            <span className="text-sm">{t('common.back')}</span>
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
            <Key className="w-3.5 h-3.5" /> {t('setup.tabs.api')}
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${activeTab === 'settings' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Sparkles className="w-3.5 h-3.5" /> {t('setup.tabs.general')}
          </button>
        </div>

        <div className="bg-card border rounded-xl p-4 shadow-sm min-h-[300px]">
          {activeTab === 'api' && (
            <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-2 duration-200">
              <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-300">
                <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
                <p className="text-xs leading-relaxed">{t('setup.keys.security_warning')}</p>
              </div>
              <div className="flex flex-col gap-6">
                {renderKeySection('gemini')}
                {renderKeySection('tavily')}
              </div>
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-2 duration-200">
              <div className="flex flex-col gap-3">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2">
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
                      className={`p-2 rounded-lg border text-xs font-medium transition-all ${theme === opt.id ? 'border-sky-500 bg-sky-500/10' : 'border-border hover:bg-secondary'}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                  {t('setup.general.language_title')}
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
                  {t('setup.ai.system_prompt_title')}
                </label>
                <textarea
                  value={systemInstruction}
                  onChange={(e) => setSystemInstruction(e.target.value)}
                  placeholder={t('setup.ai.system_prompt_placeholder')}
                  className="min-h-[80px] w-full resize-y rounded-lg border border-input bg-background/50 px-3 py-2 text-sm"
                />
              </div>
            </div>
          )}
        </div>

        <button
          onClick={handleSave}
          className="inline-flex items-center justify-center rounded-lg text-sm font-bold transition-all bg-sky-500 text-white hover:bg-sky-600 h-10 px-4 gap-2 shadow-md"
        >
          <Save className="w-4 h-4" />
          {t('setup.api.save_btn')}
        </button>
      </div>
    </div>
  )
}

export default SettingsPanel