import { useState } from 'react'
import { Settings, Save, Sparkles, ArrowLeft, Globe, Server, CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import i18n from '../i18n'
import { checkHealth } from '../lib/api'

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
