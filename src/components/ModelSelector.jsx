import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'

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

  return (
    <label className="group relative flex min-w-[132px] max-w-[170px] items-center">
      <select
        data-testid="model-selector"
        aria-label={t('chat.tooltips.model_selector')}
        title={t('chat.tooltips.model_selector')}
        value={selectedModel}
        onChange={(event) => onModelChange(event.target.value)}
        className="h-7 w-full appearance-none truncate rounded-lg border border-border/70 bg-secondary/55 py-0 pl-2.5 pr-6 text-[11px] font-medium text-foreground transition-colors hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-primary/30"
      >
        {groupedModels.map(group => (
          <optgroup key={group.provider} label={t(`chat.model_providers.${group.provider}`)}>
            {group.models.map(model => (
              <option key={model.key || model.modelId} value={model.modelId}>
                {model.label || modelLabels[model.modelId] || model.modelId}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 h-3 w-3 text-muted-foreground transition-transform group-focus-within:rotate-180" />
    </label>
  )
}

export default ModelSelector
