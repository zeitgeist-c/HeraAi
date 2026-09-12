import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { isAutoModelKey } from '../lib/models'

const PROVIDER_DOT = {
  gemini: 'bg-emerald-500',
  openrouter: 'bg-violet-500',
  ollama: 'bg-amber-500',
}

function candidateKey(candidate) {
  if (!candidate) return null
  if (typeof candidate === 'string') return candidate
  if (typeof candidate.key === 'string' && candidate.key) return candidate.key
  if (typeof candidate.modelId === 'string' && candidate.modelId) {
    if (typeof candidate.provider === 'string' && candidate.provider) {
      return `${candidate.provider}:${candidate.modelId}`
    }
    return candidate.modelId
  }
  return null
}

function candidateLabel(candidate, key) {
  if (candidate && typeof candidate === 'object' && typeof candidate.label === 'string' && candidate.label) {
    return candidate.label
  }
  return key
}

function ComparisonPanel({
  open,
  candidates = [],
  initialPair = [],
  availability = {},
  onStart,
  onClose,
}) {
  const { t } = useTranslation()
  const concreteCandidates = (Array.isArray(candidates) ? candidates : []).filter(candidate => {
    const modelId = typeof candidate === 'string' ? candidate : candidate?.modelId
    return !isAutoModelKey(modelId) && !isAutoModelKey(candidateKey(candidate))
  })

  const [firstKey, setFirstKey] = useState(initialPair?.[0] ?? '')
  const [secondKey, setSecondKey] = useState(initialPair?.[1] ?? '')

  useEffect(() => {
    if (!open) return undefined
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose])

  if (!open) return null

  const hasKeyFor = (key) => availability?.[key]?.hasKey ?? availability?.[key] ?? true
  const rowDisabled = (candidate, key) => (
    candidate?.disabled === true || hasKeyFor(key) === false
  )
  const rowReason = (candidate, key) => {
    if (typeof candidate?.disabledReason === 'string' && candidate.disabledReason) {
      return candidate.disabledReason
    }
    if (hasKeyFor(key) === false) return t('chat.comparison.unavailable')
    return ''
  }

  const firstDisabled = firstKey && concreteCandidates.some(candidate => (
    candidateKey(candidate) === firstKey && rowDisabled(candidate, firstKey)
  ))
  const secondDisabled = secondKey && concreteCandidates.some(candidate => (
    candidateKey(candidate) === secondKey && rowDisabled(candidate, secondKey)
  ))
  const isValid = Boolean(firstKey)
    && Boolean(secondKey)
    && firstKey !== secondKey
    && !firstDisabled
    && !secondDisabled

  const renderSelect = (value, onChange, label, badge, active) => {
    const selected = concreteCandidates.find(candidate => candidateKey(candidate) === value)
    const provider = selected && typeof selected === 'object' ? selected.provider : null
    const speed = selected && typeof selected === 'object' ? selected.speed : null
    return (
      <div className={`min-w-0 flex-1 rounded-xl border p-2 transition-colors ${active ? 'border-primary/50 bg-primary/[0.07]' : 'border-border/70 bg-background'}`}>
        <span className={`mb-1.5 inline-block rounded-md px-1.5 py-px text-[10px] font-extrabold tracking-wide ${active ? 'bg-gradient-to-r from-primary to-violet-500 text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>
          {badge}
        </span>
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={label}
          className="h-8 w-full min-w-0 cursor-pointer truncate rounded-lg border border-border/50 bg-secondary/60 px-1 text-xs font-semibold text-foreground dark:[color-scheme:dark] focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          <option value="">{label}</option>
          {concreteCandidates.map(candidate => {
            const key = candidateKey(candidate)
            if (!key) return null
            const disabled = rowDisabled(candidate, key)
            const reason = rowReason(candidate, key)
            const text = disabled && reason
              ? `${candidateLabel(candidate, key)} (${reason})`
              : candidateLabel(candidate, key)
            return (
              <option key={key} value={key} disabled={disabled}>
                {text}
              </option>
            )
          })}
        </select>
        <span className="mt-1 flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
          {provider && <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${PROVIDER_DOT[provider] || 'bg-muted-foreground'}`} />}
          <span className="min-w-0 flex-1 truncate">
            {provider ? t(`chat.model_providers.${provider}`, { defaultValue: provider }) : label}
            {speed ? ` · ${t(`chat.speeds.${speed}`)}` : ''}
          </span>
        </span>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('chat.comparison.title')}
        className="w-full max-w-lg rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-xl shadow-black/10"
      >
        <h2 className="text-sm font-semibold text-foreground">{t('chat.comparison.title')}</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {t('chat.comparison.two_requests_notice')}
        </p>
        <div className="mt-3 flex min-w-0 items-stretch gap-0">
          {renderSelect(firstKey, setFirstKey, t('chat.comparison.model_a'), 'A', Boolean(firstKey))}
          <span aria-hidden="true" className="-mx-2 flex w-7 shrink-0 items-center justify-center self-center">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-primary to-violet-500 text-[10px] font-extrabold text-primary-foreground shadow-sm shadow-primary/25 ring-4 ring-popover">
              VS
            </span>
          </span>
          {renderSelect(secondKey, setSecondKey, t('chat.comparison.model_b'), 'B', Boolean(secondKey))}
        </div>
        {firstKey && secondKey && firstKey === secondKey && (
          <p role="alert" className="mt-2 text-[11px] font-medium text-destructive">
            {t('chat.comparison.different_models')}
          </p>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => onClose?.()}
            className="hera-action-button"
          >
            <span>{t('chat.comparison.cancel')}</span>
          </button>
          <button
            type="button"
            disabled={!isValid}
            onClick={() => {
              if (isValid) onStart?.([firstKey, secondKey])
            }}
            className="hera-action-button bg-gradient-to-r from-primary to-violet-500 text-primary-foreground shadow-sm shadow-primary/25 hover:opacity-90 disabled:pointer-events-none disabled:opacity-45"
          >
            <span>{t('chat.comparison.start')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export default ComparisonPanel
