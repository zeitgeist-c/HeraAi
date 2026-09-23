import { useState } from 'react'
import { ChevronDown, Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { CHANGELOG } from '../data/changelog'
import { currentLanguage } from '../lib/language'

function formatDate(value, lang) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '')
  if (!match) return value || ''
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return date.toLocaleDateString(lang === 'tr' ? 'tr-TR' : 'en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

function ChangelogPanel({ onClose }) {
  const { t, i18n } = useTranslation()
  const lang = currentLanguage(i18n)
  const [openVersions, setOpenVersions] = useState(() => new Set([CHANGELOG[0]?.version]))
  const [latest] = CHANGELOG

  const toggleVersion = (version) => {
    setOpenVersions((previous) => {
      const next = new Set(previous)
      if (next.has(version)) next.delete(version)
      else next.add(version)
      return next
    })
  }

  const changesFor = (entry) => entry.changes[lang] || entry.changes.en || []

  return (
    <div className="hera-panel flex h-screen flex-col bg-background text-foreground">
      <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-3 py-2">
        <h2 className="text-sm font-semibold tracking-tight">{t('changelog.title')}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('chat.tooltips.close')}
          className="hera-icon-button h-8 w-8 hover:bg-secondary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {latest && (
          <section className="relative overflow-hidden rounded-xl border border-primary/25 bg-gradient-to-br from-primary/[0.14] via-primary/[0.05] to-transparent p-3">
            <div className="mb-1 flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-primary">
                {t('changelog.current_version', { version: latest.version })}
              </span>
            </div>
            <p className="mb-2 text-[11px] text-muted-foreground">{formatDate(latest.date, lang)}</p>
            <ul className="space-y-1.5">
              {changesFor(latest).map((change) => (
                <li key={change} className="flex items-start gap-2 text-xs leading-relaxed">
                  <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  <span>{change}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="relative space-y-2 pl-4 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-border">
          {CHANGELOG.slice(1).map((entry) => {
            const open = openVersions.has(entry.version)
            return (
              <section key={entry.version} className="relative">
                <span aria-hidden="true" className="absolute -left-4 top-3.5 h-[7px] w-[7px] rounded-full border-2 border-primary bg-background" />
                <button
                  type="button"
                  onClick={() => toggleVersion(entry.version)}
                  aria-expanded={open}
                  className="hera-section-card flex w-full items-center gap-2 p-2.5 text-left"
                >
                  <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[11px] font-semibold tabular-nums">
                    v{entry.version}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                    {formatDate(entry.date, lang)}
                  </span>
                  <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
                </button>
                {open && (
                  <ul className="hera-section-card mt-1.5 space-y-1.5 p-3">
                    {changesFor(entry).map((change) => (
                      <li key={change} className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                        <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
                        <span>{change}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default ChangelogPanel
