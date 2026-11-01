import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { getKeys, getRawKey } from '../lib/keyManager'
import { MODEL_CATALOG } from '../lib/models'
import { discoverModels, isFreeModel, isPaidModel, mergeDiscoveryResults, MODEL_PREFERENCES_KEY } from '../lib/modelDiscovery'

const PROVIDERS = ['gemini', 'openrouter', 'ollama']
const COLLAPSE_AFTER = 5

const PROVIDER_DOT = { gemini: '#4285f4', openrouter: '#e35d8f', ollama: '#0f9f8f' }

export default function ModelManagement() {
  const { t } = useTranslation()
  const [preferences, setPreferences] = useState(null)
  const [query, setQuery] = useState('')
  const [freeOnly, setFreeOnly] = useState(false)
  const [busyProviders, setBusyProviders] = useState([])
  const [statuses, setStatuses] = useState({})
  const [collapsed, setCollapsed] = useState({ gemini: true })
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    chrome.storage.local.get([MODEL_PREFERENCES_KEY]).then(stored => {
      if (!disposed) setPreferences(stored[MODEL_PREFERENCES_KEY] || {
        models: [], enabledKeys: MODEL_CATALOG.map(model => model.key),
      })
    }).catch(() => { if (!disposed) setError(t('models_panel.save_error')) })
    return () => { disposed = true }
  }, [t])

  const save = async next => {
    if (savingRef.current) return false
    savingRef.current = true
    setSaving(true)
    try {
      await chrome.storage.local.set({ [MODEL_PREFERENCES_KEY]: next })
      setPreferences(next)
      return true
    } catch { setError(t('models_panel.save_error')); return false }
    finally { savingRef.current = false; setSaving(false) }
  }
  const refreshProvider = async provider => {
    if (busyProviders.includes(provider) || saving || !preferences) return
    setBusyProviders(previous => [...previous, provider])
    setError('')
    try {
      const keys = (await getKeys(provider)).filter(key => key.status !== 'paused' && key.status !== 'invalid')
      const results = []
      let failed = false
      for (const key of keys) {
        try {
          const raw = await getRawKey(provider, key.id)
          results.push(await discoverModels(provider, raw, key.id))
        } catch { failed = true }
      }
      const discovered = failed
        ? (preferences?.models || [])
        : mergeDiscoveryResults([
          ...results,
          (preferences?.models || []).filter(model => model.provider !== provider),
        ])
      const refreshedAt = { ...(preferences?.refreshedAt && typeof preferences.refreshedAt === 'object' ? preferences.refreshedAt : {}), [provider]: Date.now() }
      await save({ ...preferences, models: discovered, refreshedAt })
      setStatuses(previous => ({ ...previous, [provider]: failed ? 'error' : 'ok' }))
      if (failed) setError(t('models_panel.refresh_error', { providers: provider }))
    } catch { setError(t('models_panel.save_error')) }
    finally { setBusyProviders(previous => previous.filter(item => item !== provider)) }
  }
  const all = new Map(MODEL_CATALOG.map(model => [model.key, model]))
  for (const model of preferences?.models || []) all.set(model.key, model)
  const matchesQuery = model => `${model.provider} ${model.label} ${model.modelId}`.toLowerCase().includes(query.toLowerCase())
  const toggleModel = model => {
    const enabled = preferences?.enabledKeys?.includes(model.key) === true
    const enabledKeys = enabled ? preferences.enabledKeys.filter(key => key !== model.key) : [...preferences.enabledKeys, model.key]
    if (!enabledKeys.length) { setError(t('models_panel.keep_one')); return }
    void save({ ...preferences, enabledKeys })
  }
  const renderModelRow = model => {
    const enabled = preferences?.enabledKeys?.includes(model.key) === true
    const paid = isPaidModel(model)
    const free = isFreeModel(model)
    const label = `${model.label} · ${model.provider}`
    return <label key={model.key} className="flex items-start gap-2 border-b border-border py-2 text-xs">
      <input type="checkbox" aria-label={label} checked={enabled} disabled={!preferences || busyProviders.length > 0 || saving} onChange={() => toggleModel(model)} />
      <span className="min-w-0 break-words"><span className="block font-medium">{label}</span>
        <span className="block text-muted-foreground">{model.modelId}{free ? ` · ${t('models_panel.free')}` : ''}{paid ? ` · ${t('models_panel.paid')}` : ''}{model.capabilities?.supportsImage ? ` · ${t('models_panel.image')}` : ''}{model.contextLength ? ` · ${model.contextLength.toLocaleString()}` : ''}</span>
      </span>
    </label>
  }
  return (
    <section className="flex flex-col gap-3" aria-label={t('models_panel.title')}>
      <h2 className="text-sm font-semibold">{t('models_panel.title')}</h2>
      <p className="text-xs text-muted-foreground">{t('models_panel.description')}</p>
      <input aria-label={t('models_panel.search')} placeholder={t('models_panel.search')} value={query} onChange={event => setQuery(event.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm" />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={freeOnly} onChange={event => setFreeOnly(event.target.checked)} />
        {t('models_panel.free_only')}
      </label>
      {typeof preferences?.refreshedAt === 'number' && <p className="text-xs text-muted-foreground">{t('models_panel.refreshed', { date: new Date(preferences.refreshedAt).toLocaleString() })}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
        {PROVIDERS.map(provider => {
          let models = [...all.values()].filter(model => model.provider === provider && matchesQuery(model))
          if (provider === 'openrouter' && freeOnly) models = models.filter(model => !isPaidModel(model))
          const freeCount = models.filter(isFreeModel).length
          const isCollapsed = collapsed[provider] === true && !query
          const shown = isCollapsed ? models.slice(0, COLLAPSE_AFTER) : models
          const busy = busyProviders.includes(provider)
          const status = statuses[provider]
          const refreshedAt = preferences?.refreshedAt?.[provider]
          return <div key={provider} className="rounded-xl border border-border/70 bg-secondary/20 p-3">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: PROVIDER_DOT[provider] }} />
              <span className="text-xs font-semibold capitalize">{provider}</span>
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{t('models_panel.models_count', { count: models.length })}</span>
              {provider === 'openrouter' && freeCount > 0 && <span className="rounded-full border border-emerald-600/60 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">{t('models_panel.free_count', { count: freeCount })}</span>}
              <span className="ml-auto" />
              {status === 'error'
                ? <span className="text-[10px] text-destructive">{t('models_panel.status_error')}</span>
                : refreshedAt
                  ? <span className="text-[10px] text-muted-foreground">✓ {new Date(refreshedAt).toLocaleString()}</span>
                  : <span className="text-[10px] text-muted-foreground">{t('models_panel.status_never')}</span>}
              <button
                type="button"
                disabled={busy || saving || !preferences}
                onClick={() => void refreshProvider(provider)}
                aria-label={t('models_panel.refresh_provider', { provider })}
                className="rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-secondary disabled:opacity-50"
              >
                {busy ? t('models_panel.loading') : t('models_panel.refresh_short')}
              </button>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{t(`models_panel.note_${provider}`)}</p>
            <div className="mt-1">
              {shown.map(renderModelRow)}
              {!models.length && <p className="py-2 text-[11px] text-muted-foreground">{t('models_panel.empty_provider')}</p>}
            </div>
            {models.length > COLLAPSE_AFTER && !query && (
              <button type="button" onClick={() => setCollapsed(previous => ({ ...previous, [provider]: !previous[provider] }))} className="mt-1 text-[11px] font-medium text-primary hover:underline">
                {isCollapsed ? t('models_panel.show_more', { count: models.length - COLLAPSE_AFTER }) : t('models_panel.show_less')}
              </button>
            )}
          </div>
        })}
      </div>
    </section>
  )
}
