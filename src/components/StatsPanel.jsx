import { useEffect, useState } from 'react'
import { Activity, Clock, Globe, MessageSquare, Mic, Percent, Scissors, Timer, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { formatDurationMs } from '../lib/duration'
import { getStatsSnapshot } from '../lib/stats'

const RANGES = ['7d', '30d', 'all']

function formatBucketLabel(key, lang) {
  const locale = lang === 'tr' ? 'tr-TR' : 'en-US'
  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '')
  if (dayMatch) {
    const date = new Date(Number(dayMatch[1]), Number(dayMatch[2]) - 1, Number(dayMatch[3]))
    return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
  }
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(key || '')
  if (monthMatch) {
    const date = new Date(Number(monthMatch[1]), Number(monthMatch[2]) - 1, 1)
    return date.toLocaleDateString(locale, { month: 'short', year: '2-digit' })
  }
  return key
}

function ActivityChart({ activity, maxActivity, chartSummary, total, t, lang }) {
  const peak = activity.reduce(
    (best, item) => ((item.count || 0) > (best.count || 0) ? item : best),
    activity[0],
  )
  const points = activity.map((item, index) => {
    const x = activity.length === 1 ? 150 : (index / (activity.length - 1)) * 300
    const ratio = maxActivity > 0 ? (item.count || 0) / maxActivity : 0
    const y = 96 - ratio * 84
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const line = points.join(' L')
  return (
    <section className="hera-section-card overflow-hidden p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold">{t('stats.activity.chart_title')}</h3>
        <span className="text-[11px] text-muted-foreground">
          {total} {t('stats.activity.total_suffix')}
        </span>
      </div>
      <div
        role="img"
        aria-label={`${t('stats.activity.chart_label')}: ${chartSummary}`}
        className="relative h-28 overflow-hidden rounded-lg bg-gradient-to-b from-primary/15 to-transparent"
      >
        <svg viewBox="0 0 300 110" preserveAspectRatio="none" className="absolute inset-0 h-full w-full text-primary" aria-hidden="true">
          <path d={`M0,104 L${line} L300,104 Z`} fill="currentColor" opacity="0.18" />
          <path d={`M${line}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        </svg>
        {peak && (peak.count || 0) > 0 && (
          <span className="absolute right-2 top-2 rounded-full border border-border bg-background/80 px-2 py-0.5 text-[10px] font-medium backdrop-blur">
            {t('stats.activity.peak', { label: formatBucketLabel(peak.key, lang), count: peak.count })}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex gap-1">
        {activity.map((item) => (
          <span key={item.key} className="min-w-0 flex-1 truncate text-center text-[10px] text-muted-foreground">
            {formatBucketLabel(item.key, lang)}
          </span>
        ))}
      </div>
      <ul className="sr-only">
        {activity.map((item) => (
          <li key={item.key}>
            {item.label}: {item.count}
          </li>
        ))}
      </ul>
    </section>
  )
}

function formatRate(rate) {
  if (rate == null || !Number.isFinite(rate)) return '—'
  return `${Math.round(rate * 100)}%`
}

function formatDuration(value) {
  if (value == null) return '—'
  return formatDurationMs(value) || '—'
}

function StatsPanel({ onClose }) {
  const { t, i18n } = useTranslation()
  const [range, setRange] = useState('7d')
  const [snapshot, setSnapshot] = useState(null)

  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => getStatsSnapshot({ range }))
      .then((data) => {
        if (cancelled) return
        setSnapshot(data)
      })
    return () => {
      cancelled = true
    }
  }, [range])

  const loading = snapshot == null || snapshot.range !== range

  const formatDate = (timestamp) => {
    if (!timestamp) return t('stats.never')
    return new Date(timestamp).toLocaleString()
  }

  const rangeLabels = {
    '7d': t('stats.range.last_7_days'),
    '30d': t('stats.range.last_30_days'),
    all: t('stats.range.all_time'),
  }

  const renderBody = () => {
    if (loading || !snapshot) {
      return (
        <div className="flex items-center justify-center py-16">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )
    }

    if (!snapshot.hasAnyData) {
      return <p className="hera-section-card p-4 text-sm text-muted-foreground">{t('stats.empty.message')}</p>
    }

    const tools = snapshot.tools || { voice: 0, screenshot: 0, search: 0 }
    const toolTotal = (tools.voice || 0) + (tools.screenshot || 0) + (tools.search || 0)
    const showLegacyNote = range === 'all' && snapshot.promptsTotal === 0 && toolTotal > 0

    const summaryCards = [
      { label: t('stats.total_messages'), value: snapshot.promptsTotal ?? 0, icon: MessageSquare },
      { label: t('stats.cards.sessions'), value: snapshot.sessionCount ?? 0, icon: Clock },
      { label: t('stats.cards.avg_duration'), value: formatDuration(snapshot.avgSuccessDurationMs), icon: Timer },
      { label: t('stats.cards.success_rate'), value: formatRate(snapshot.successRate), icon: Percent },
    ]
    const toolStats = [
      { label: t('stats.voice_inputs'), value: tools.voice || 0, icon: Mic },
      { label: t('stats.screenshots'), value: tools.screenshot || 0, icon: Scissors },
      { label: t('stats.searches'), value: tools.search || 0, icon: Globe },
    ]

    const activity = snapshot.activity || []
    const maxActivity = Math.max(1, ...activity.map((item) => item.count || 0))
    const chartSummary = activity.map((item) => `${item.label}: ${item.count}`).join(', ')

    const models = snapshot.models || []
    const providerLabel = (provider) => t(`chat.model_providers.${provider}`, { defaultValue: provider })

    return (
      <div className="space-y-3">
        {showLegacyNote && (
          <p className="hera-section-card p-3 text-xs text-muted-foreground">{t('stats.legacy.note')}</p>
        )}

        <div className="grid grid-cols-2 gap-2 min-[360px]:grid-cols-4">
          {summaryCards.map(({ label, value, icon: Icon }) => (
            <div key={label} className="hera-section-card min-w-0 p-3">
              <div className="mb-3 flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="h-3.5 w-3.5" />
              </div>
              <span className="block text-xl font-semibold tracking-tight">{value}</span>
              <span className="mt-1 block truncate text-[11px] text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>

        {activity.length > 0 && (
          <ActivityChart
            activity={activity}
            maxActivity={maxActivity}
            chartSummary={chartSummary}
            total={snapshot.promptsTotal ?? 0}
            t={t}
            lang={i18n.language}
          />
        )}

        <section className="hera-section-card p-3">
          <h3 className="mb-3 text-xs font-semibold">{t('stats.models.title')}</h3>
          {models.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('stats.models.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-muted-foreground">
                    <th scope="col" className="pb-2 pr-2 font-medium">
                      {t('stats.models.columns.model')}
                    </th>
                    <th scope="col" className="pb-2 pr-2 text-right font-medium">
                      {t('stats.models.columns.attempts')}
                    </th>
                    <th scope="col" className="pb-2 pr-2 text-right font-medium">
                      {t('stats.models.columns.avg_duration')}
                    </th>
                    <th scope="col" className="pb-2 text-right font-medium">
                      {t('stats.models.columns.success_rate')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((model) => (
                    <tr key={model.modelKey} className="border-t border-border">
                      <td className="py-2 pr-2">
                        <span className="block truncate font-medium">{model.modelId}</span>
                        <span className="block text-[11px] text-muted-foreground">{providerLabel(model.provider)}</span>
                      </td>
                      <td className="py-2 pr-2 text-right">{model.attempts}</td>
                      <td className="py-2 pr-2 text-right">{formatDuration(model.avgSuccessDurationMs)}</td>
                      <td className="py-2 text-right">{formatRate(model.successRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="hera-section-card p-3">
          <h3 className="mb-3 text-xs font-semibold">{t('stats.activity_title')}</h3>
          <div className="grid grid-cols-3 gap-2">
            {toolStats.map(({ label, value, icon: Icon }) => (
              <div key={label} className="min-w-0 rounded-xl bg-secondary/55 p-2.5">
                <Icon className="mb-2 h-3.5 w-3.5 text-muted-foreground" />
                <span className="block text-base font-semibold">{value}</span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="hera-panel flex h-screen flex-col bg-background text-foreground">
      <header className="hera-panel-header">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Activity className="h-4 w-4" />
          </span>
          <h2 className="hera-panel-title truncate">{t('stats.title')}</h2>
        </div>
        <button type="button" onClick={onClose} className="hera-icon-button" aria-label={t('chat.tooltips.close')}>
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        <div role="group" aria-label={t('stats.title')} className="flex gap-1.5">
          {RANGES.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={range === item}
              onClick={() => setRange(item)}
              className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium ${
                range === item ? 'bg-primary text-primary-foreground' : 'bg-secondary/60 text-muted-foreground'
              }`}
            >
              {rangeLabels[item]}
            </button>
          ))}
        </div>

        {renderBody()}

        <div className="hera-section-card flex items-center justify-between gap-4 p-3">
          <span className="text-xs text-muted-foreground">{t('stats.last_active')}</span>
          <span className="truncate text-right text-xs font-medium">{formatDate(snapshot?.lastActive)}</span>
        </div>
      </div>
    </div>
  )
}

export default StatsPanel
