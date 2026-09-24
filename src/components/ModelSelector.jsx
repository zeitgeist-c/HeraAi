import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'

const PROVIDER_DOT = {
  gemini: 'bg-emerald-500',
  openrouter: 'bg-violet-500',
  ollama: 'bg-amber-500',
}

function ModelSelector({ selectedModel, models, modelLabels, onModelChange }) {
  const { t } = useTranslation()
  const normalizedModels = (models || []).map(model => typeof model === 'string'
    ? { modelId: model, provider: 'gemini', label: modelLabels[model] || model }
    : model)
  const providerOrder = ['gemini', 'openrouter', 'ollama']
  const groupedModels = providerOrder
    .map(provider => ({
      provider,
      models: normalizedModels.filter(model => model.provider === provider),
    }))
    .filter(group => group.models.length > 0)

  const [open, setOpen] = useState(false)
  const selectedProvider = normalizedModels.find(model => model.modelId === selectedModel)?.provider
  const [userCollapsed, setUserCollapsed] = useState(() => (
    providerOrder.filter(provider => provider !== selectedProvider)
  ))
  const rootRef = useRef(null)

  const isCollapsed = (provider) => userCollapsed.includes(provider)

  useEffect(() => {
    if (!open) return undefined
    const handlePointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open ])

  const selected = normalizedModels.find(model => model.modelId === selectedModel)
  const selectedLabel = selected?.label || modelLabels[selectedModel] || selectedModel
  const selectedDot = PROVIDER_DOT[selectedProvider] || 'bg-muted-foreground'

  const toggleProvider = (provider) => {
    setUserCollapsed(current => current.includes(provider)
      ? current.filter(item => item !== provider)
      : [...current, provider])
  }

  const chooseModel = (modelId) => {
    setOpen(false)
    if (modelId !== selectedModel) onModelChange(modelId)
  }

  return (
    <div ref={rootRef} className="group relative min-w-[132px] max-w-[170px]">
      <button
        type="button"
        data-testid="model-selector"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('chat.tooltips.model_selector')}
        title={t('chat.tooltips.model_selector')}
        onClick={() => setOpen(prev => !prev)}
        className="flex h-7 w-full items-center justify-between gap-1 truncate rounded-lg border border-border/70 bg-secondary/55 py-0 pl-2.5 pr-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-primary/30"
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {selectedDot && <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${selectedDot}`} />}
          <span className="min-w-0 flex-1 truncate">{selectedLabel}</span>
        </span>
        <ChevronDown className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={t('chat.tooltips.model_selector')}
          className="absolute bottom-full left-0 z-50 mb-1.5 max-h-56 w-48 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl shadow-black/10"
        >
          {groupedModels.map(group => {
            const collapsed = isCollapsed(group.provider)
            const headingId = `model-group-${group.provider}`
            return (
              <div key={group.provider}>
                <button
                  type="button"
                  id={headingId}
                  aria-expanded={!collapsed}
                  aria-controls={`${headingId}-models`}
                  onClick={() => toggleProvider(group.provider)}
                  className="flex w-full items-center justify-between gap-1.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-secondary/60"
                >
                  <span className="truncate rounded-full border border-border/70 bg-secondary px-2 py-px text-[10px] font-extrabold uppercase tracking-wide text-muted-foreground">
                    {t(`chat.model_providers.${group.provider}`)}
                  </span>
                  <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                </button>
                {!collapsed && (
                  <div id={`${headingId}-models`} role="group" aria-labelledby={headingId} className="pb-0.5">
                    {group.models.map(model => {
                      const isSelected = model.modelId === selectedModel
                      const dot = PROVIDER_DOT[model.provider] || 'bg-muted-foreground'
                      return (
                        <button
                          key={model.key || model.modelId}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          data-model-id={model.modelId}
                          onClick={() => chooseModel(model.modelId)}
                          className={`flex min-h-8 w-full items-center justify-between gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary/60 ${isSelected ? 'font-semibold text-primary' : 'text-foreground'}`}
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-1.5">
                            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
                            <span className="min-w-0 flex-1 truncate">
                              {model.label || modelLabels[model.modelId] || model.modelId}
                            </span>
                            {model.capabilities?.supportsImage === true && (
                              <span aria-hidden="true" className="shrink-0 text-[10px] leading-none">📷</span>
                            )}
                          </span>
                          {isSelected && <Check className="h-4 w-4 shrink-0" />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default ModelSelector
