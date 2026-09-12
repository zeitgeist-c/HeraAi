import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { isAutoModelKey } from '../lib/models'

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

  const renderSelect = (value, onChange, label) => (
    <label className="block min-w-0 flex-1">
      <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className="h-9 w-full min-w-0 rounded-lg border border-border/70 bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
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
    </label>
  )

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('chat.comparison.title')}
        className="w-full max-w-md rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-xl shadow-black/10"
      >
        <h2 className="text-sm font-semibold text-foreground">{t('chat.comparison.title')}</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {t('chat.comparison.two_requests_notice')}
        </p>
        <div className="mt-3 flex min-w-0 gap-2">
          {renderSelect(firstKey, setFirstKey, t('chat.comparison.model_a'))}
          {renderSelect(secondKey, setSecondKey, t('chat.comparison.model_b'))}
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
            className="hera-action-button bg-primary text-primary-foreground hover:brightness-105 disabled:pointer-events-none disabled:opacity-45"
          >
            <span>{t('chat.comparison.start')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export default ComparisonPanel
