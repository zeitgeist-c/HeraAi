import { useState, useEffect } from 'react'
import { Settings, Save, Sparkles, ArrowLeft, Globe, Server, CheckCircle, XCircle, Loader2, Key } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import i18n from '../i18n'
import { checkHealth, testKey } from '../lib/api'
import { getKeys, addKey, removeKey, setPrimary, getRawKey } from '../lib/keyManager'

const AVAILABLE_LANGUAGES = [
  { code: 'tr', name: 'Türkçe', flag: '🇹🇷' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
]

function SettingsPanel({ onSave, currentConfig, onClose }) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState('api')

  const [backendUrl, setBackendUrl] = useState(currentConfig?.backendUrl || 'http://localhost:3001')
  const [connectionStatus, setConnectionStatus] = useState(null)
  const [testingConnection, setTestingConnection] = useState(false)

  const [theme, setTheme] = useState(currentConfig?.theme || 'system')
  const [customPrimaryColor, setCustomPrimaryColor] = useState(currentConfig?.customPrimaryColor || '#0ea5e9')

  const [systemInstruction, setSystemInstruction] = useState(currentConfig?.systemInstruction || '')
  const [selectedLanguage, setSelectedLanguage] = useState(currentConfig?.language || 'tr')

  const [apiSubTab, setApiSubTab] = useState('backend')
  const [geminiKeys, setGeminiKeys] = useState([])
  const [tavilyKeys, setTavilyKeys] = useState([])
  const [newGeminiKey, setNewGeminiKey] = useState('')
  const [newTavilyKey, setNewTavilyKey] = useState('')
  const [testingKeyId, setTestingKeyId] = useState(null)

  const handleLanguageChange = (langCode) => {
    setSelectedLanguage(langCode)
    i18n.changeLanguage(langCode)
  }

  const handleTestConnection = async () => {
    setTestingConnection(true)
    setConnectionStatus(null)
    try {
      const ok = await checkHealth()
      if (ok) {
        setConnectionStatus('connected')
        toast.success(t('setup.api.connection_success'))
      } else {
        setConnectionStatus('failed')
        toast.error(t('setup.api.connection_failed'))
      }
    } catch {
      setConnectionStatus('failed')
      toast.error(t('setup.api.connection_failed'))
    } finally {
      setTestingConnection(false)
    }
  }

  useEffect(() => {
    async function load() {
      setGeminiKeys(await getKeys('gemini'))
      setTavilyKeys(await getKeys('tavily'))
    }
    load()
  }, [])

  const handleAddKey = async (provider) => {
    const rawKey = provider === 'gemini' ? newGeminiKey : newTavilyKey
    if (!rawKey.trim()) {
      toast.error(t('setup.keys.empty_error'))
      return
    }
    try {
      await addKey(provider, rawKey)
      toast.success(t('setup.keys.add_success'))
      if (provider === 'gemini') {
        setNewGeminiKey('')
        setGeminiKeys(await getKeys('gemini'))
      } else {
        setNewTavilyKey('')
        setTavilyKeys(await getKeys('tavily'))
      }
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
    if (provider === 'gemini') {
      setGeminiKeys(await getKeys('gemini'))
    } else {
      setTavilyKeys(await getKeys('tavily'))
    }
  }

  const handleSetPrimary = async (provider, id) => {
    await setPrimary(provider, id)
    if (provider === 'gemini') {
      setGeminiKeys(await getKeys('gemini'))
    } else {
      setTavilyKeys(await getKeys('tavily'))
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
      if (result.success) {
        toast.success(t('setup.keys.test_success'))
      } else {
        toast.error(t('setup.keys.test_failed'))
      }
    } catch {
      toast.error(t('setup.keys.test_failed'))
    } finally {
      setTestingKeyId(null)
    }
  }

  const handleSave = () => {
    const newConfig = {
      backendUrl,
      theme,
      startupBehavior: currentConfig?.startupBehavior || 'resume',
      systemInstruction,
      selectedModel: 'gemini-3.1-flash-lite',
      customPrimaryColor,
      language: selectedLanguage,
    }

    chrome.storage.local.set({ ...newConfig, apiProvider: 'google' }, () => {
      onSave(newConfig)
      toast.success(t('setup.api.saved_success'))
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
            <Server className="w-3.5 h-3.5" /> {t('setup.tabs.api')}
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
              <div className="flex rounded-lg bg-secondary/50 p-1">
                <button
                  onClick={() => setApiSubTab('backend')}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${apiSubTab === 'backend' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  <Server className="w-3.5 h-3.5" /> {t('setup.keys.backend_tab')}
                </button>
                <button
                  onClick={() => setApiSubTab('keys')}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${apiSubTab === 'keys' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  <Key className="w-3.5 h-3.5" /> {t('setup.keys.keys_tab')}
                </button>
              </div>

              {apiSubTab === 'backend' && (
                <>
                  <div className="flex flex-col gap-3">
                    <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                      <Globe className="w-4 h-4 text-primary" />
                      {t('setup.api.provider')}
                    </label>
                    <div className="p-2.5 rounded-lg border border-sky-500/30 bg-sky-500/5 text-sm text-muted-foreground">
                      {t('setup.api.provider_info')}
                    </div>
                  </div>

                  <div className="flex flex-col gap-3">
                    <label className="text-sm font-semibold text-foreground flex items-center gap-2">
                      <Server className="w-4 h-4 text-primary" />
                      {t('setup.api.backend_url')}
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        className="flex h-9 w-full rounded-lg border border-input bg-background/50 px-3 text-sm font-mono"
                        placeholder="http://localhost:3001"
                        value={backendUrl}
                        onChange={(e) => {
                          setBackendUrl(e.target.value)
                          setConnectionStatus(null)
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleTestConnection}
                        disabled={testingConnection}
                        className="h-9 px-3 bg-secondary text-secondary-foreground rounded-lg text-sm font-medium hover:bg-secondary/80 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {testingConnection ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                        {t('setup.api.test_connection')}
                      </button>
                      {connectionStatus === 'connected' && (
                        <span className="flex items-center gap-1 text-xs text-green-500">
                          <CheckCircle className="w-3.5 h-3.5" /> {t('setup.api.connected')}
                        </span>
                      )}
                      {connectionStatus === 'failed' && (
                        <span className="flex items-center gap-1 text-xs text-red-500">
                          <XCircle className="w-3.5 h-3.5" /> {t('setup.api.no_connection')}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {t('setup.api.security_note')}
                    </p>
                  </div>
                </>
              )}

              {apiSubTab === 'keys' && (
                <div className="flex flex-col gap-6">
                  <div className="flex flex-col gap-3">
                    <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                      <Key className="w-4 h-4 text-primary" />
                      {t('setup.keys.gemini_section')}
                    </h3>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        className="flex h-9 w-full rounded-lg border border-input bg-background/50 px-3 text-sm font-mono"
                        placeholder={t('setup.keys.add_placeholder')}
                        value={newGeminiKey}
                        onChange={(e) => setNewGeminiKey(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleAddKey('gemini')}
                      />
                      <button
                        onClick={() => handleAddKey('gemini')}
                        className="h-9 px-3 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/80 flex items-center gap-1.5"
                      >
                        {t('setup.keys.add_btn')}
                      </button>
                    </div>
                    {geminiKeys.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t('setup.keys.no_keys')}</p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {geminiKeys.map((key) => (
                          <div key={key.id} className="flex items-center justify-between p-2.5 rounded-lg border border-border bg-background/50">
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-mono text-foreground">{key.masked}</span>
                                {key.isPrimary && (
                                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-500 border border-green-500/20">
                                    {t('setup.keys.primary_badge')}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                                {key.lastUsedAt && (
                                  <span>{t('setup.keys.last_used')}: {new Date(key.lastUsedAt).toLocaleDateString()}</span>
                                )}
                                {key.cooldownUntil && key.cooldownUntil > Date.now() && (
                                  <span className="text-amber-500">{t('setup.keys.cooldown_until')}: {new Date(key.cooldownUntil).toLocaleTimeString()}</span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => handleTestKey('gemini', key.id)}
                                disabled={testingKeyId === `gemini:${key.id}`}
                                className="h-7 px-2 bg-secondary text-secondary-foreground rounded text-xs font-medium hover:bg-secondary/80 disabled:opacity-50 flex items-center gap-1"
                              >
                                {testingKeyId === `gemini:${key.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                                {testingKeyId === `gemini:${key.id}` ? t('setup.keys.testing') : t('setup.keys.test_btn')}
                              </button>
                              {!key.isPrimary && (
                                <button
                                  onClick={() => handleSetPrimary('gemini', key.id)}
                                  className="h-7 px-2 bg-secondary text-secondary-foreground rounded text-xs font-medium hover:bg-secondary/80"
                                >
                                  {t('setup.keys.set_primary')}
                                </button>
                              )}
                              <button
                                onClick={() => handleRemoveKey('gemini', key.id)}
                                className="h-7 px-2 bg-destructive/10 text-destructive rounded text-xs font-medium hover:bg-destructive/20"
                              >
                                {t('setup.keys.delete_btn')}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-3">
                    <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                      <Key className="w-4 h-4 text-primary" />
                      {t('setup.keys.tavily_section')}
                    </h3>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        className="flex h-9 w-full rounded-lg border border-input bg-background/50 px-3 text-sm font-mono"
                        placeholder={t('setup.keys.add_placeholder')}
                        value={newTavilyKey}
                        onChange={(e) => setNewTavilyKey(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleAddKey('tavily')}
                      />
                      <button
                        onClick={() => handleAddKey('tavily')}
                        className="h-9 px-3 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/80 flex items-center gap-1.5"
                      >
                        {t('setup.keys.add_btn')}
                      </button>
                    </div>
                    {tavilyKeys.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t('setup.keys.no_keys')}</p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {tavilyKeys.map((key) => (
                          <div key={key.id} className="flex items-center justify-between p-2.5 rounded-lg border border-border bg-background/50">
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-mono text-foreground">{key.masked}</span>
                                {key.isPrimary && (
                                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-500 border border-green-500/20">
                                    {t('setup.keys.primary_badge')}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                                {key.lastUsedAt && (
                                  <span>{t('setup.keys.last_used')}: {new Date(key.lastUsedAt).toLocaleDateString()}</span>
                                )}
                                {key.cooldownUntil && key.cooldownUntil > Date.now() && (
                                  <span className="text-amber-500">{t('setup.keys.cooldown_until')}: {new Date(key.cooldownUntil).toLocaleTimeString()}</span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => handleTestKey('tavily', key.id)}
                                disabled={testingKeyId === `tavily:${key.id}`}
                                className="h-7 px-2 bg-secondary text-secondary-foreground rounded text-xs font-medium hover:bg-secondary/80 disabled:opacity-50 flex items-center gap-1"
                              >
                                {testingKeyId === `tavily:${key.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                                {testingKeyId === `tavily:${key.id}` ? t('setup.keys.testing') : t('setup.keys.test_btn')}
                              </button>
                              {!key.isPrimary && (
                                <button
                                  onClick={() => handleSetPrimary('tavily', key.id)}
                                  className="h-7 px-2 bg-secondary text-secondary-foreground rounded text-xs font-medium hover:bg-secondary/80"
                                >
                                  {t('setup.keys.set_primary')}
                                </button>
                              )}
                              <button
                                onClick={() => handleRemoveKey('tavily', key.id)}
                                className="h-7 px-2 bg-destructive/10 text-destructive rounded text-xs font-medium hover:bg-destructive/20"
                              >
                                {t('setup.keys.delete_btn')}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
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
