import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { getKeys, getRawKey } from '../lib/keyManager'
import { MODEL_CATALOG } from '../lib/models'
import { discoverModels, mergeDiscoveryResults, MODEL_PREFERENCES_KEY } from '../lib/modelDiscovery'

export default function ModelManagement() {
  const { t } = useTranslation()
  const [preferences, setPreferences] = useState(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
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
  const refresh = async () => {
    setBusy(true)
    setError('')
    try {
      const results = []
      const failures = []
      const refreshedProviders = new Set()
      for (const provider of ['gemini', 'openrouter', 'ollama']) {
        const keys = (await getKeys(provider)).filter(key => key.status !== 'paused' && key.status !== 'invalid')
        let complete = true
        for (const key of keys) {
          try {
            const raw = await getRawKey(provider, key.id)
            results.push(await discoverModels(provider, raw, key.id))
          } catch { complete = false; failures.push(provider) }
        }
        if (complete) refreshedProviders.add(provider)
      }
      const discovered = mergeDiscoveryResults([
        ...(results || []),
        (preferences?.models || []).filter(model => !refreshedProviders.has(model.provider)),
      ])
      await save({ ...preferences, models: discovered, refreshedAt: Date.now() })
      if (failures.length) setError(t('models_panel.refresh_error', { providers: [...new Set(failures)].join(', ') }))
    } catch { setError(t('models_panel.save_error')) }
    finally { setBusy(false) }
  }
  const all = new Map(MODEL_CATALOG.map(model => [model.key, model]))
  for (const model of preferences?.models || []) all.set(model.key, model)
  const visible = [...all.values()].filter(model => `${model.provider} ${model.label} ${model.modelId}`.toLowerCase().includes(query.toLowerCase()))
  return (
    <section className="flex flex-col gap-3" aria-label={t('models_panel.title')}>
      <h2 className="text-sm font-semibold">{t('models_panel.title')}</h2>
      <p className="text-xs text-muted-foreground">{t('models_panel.description')}</p>
      <button type="button" disabled={busy || saving || !preferences} onClick={refresh} className="rounded-lg border border-border px-3 py-2 text-xs disabled:opacity-50">{t(busy ? 'models_panel.loading' : 'models_panel.refresh')}</button>
      {preferences?.refreshedAt && <p className="text-xs text-muted-foreground">{t('models_panel.refreshed', { date: new Date(preferences.refreshedAt).toLocaleString() })}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <input aria-label={t('models_panel.search')} placeholder={t('models_panel.search')} value={query} onChange={event => setQuery(event.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm" />
      <div className="max-h-96 overflow-y-auto">
        {visible.map(model => {
          const enabled = preferences?.enabledKeys?.includes(model.key) === true
          const paid = model.pricing && (Number(model.pricing.prompt) > 0 || Number(model.pricing.completion) > 0)
          return <label key={model.key} className="flex items-start gap-2 border-b border-border py-2 text-xs">
            <input type="checkbox" checked={enabled} disabled={!preferences || busy || saving} onChange={() => {
              const enabledKeys = enabled ? preferences.enabledKeys.filter(key => key !== model.key) : [...preferences.enabledKeys, model.key]
              if (!enabledKeys.length) { setError(t('models_panel.keep_one')); return }
              void save({ ...preferences, enabledKeys })
            }} />
            <span className="min-w-0 break-words"><span className="block font-medium">{model.label} · {model.provider}</span>
              <span className="block text-muted-foreground">{model.modelId}{paid ? ` · ${t('models_panel.paid')}` : ''}{model.capabilities?.supportsImage ? ` · ${t('models_panel.image')}` : ''}{model.contextLength ? ` · ${model.contextLength.toLocaleString()}` : ''}</span>
            </span>
          </label>
        })}
      </div>
    </section>
  )
}
