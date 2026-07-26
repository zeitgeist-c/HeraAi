import { useEffect, useState } from 'react'
import { Activity, Clock, Globe, MessageSquare, Mic, Scissors, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { getStats } from '../lib/stats'

function StatsPanel({ onClose }) {
  const { t } = useTranslation()
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getStats().then((data) => {
      setStats(data)
      setLoading(false)
    })
  }, [])

  const formatDate = (timestamp) => {
    if (!timestamp) return t('stats.never')
    return new Date(timestamp).toLocaleString()
  }

  const getLast7DaysMessages = () => {
    if (!stats?.messagesByDate) return 0
    const last7Days = []
    for (let i = 6; i >= 0; i--) {
      const date = new Date()
      date.setDate(date.getDate() - i)
      last7Days.push(stats.messagesByDate[date.toDateString()] || 0)
    }
    return last7Days.reduce((sum, count) => sum + count, 0)
  }

  if (loading) {
    return (
      <div className="hera-panel flex h-screen items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  const primaryStats = [
    { label: t('stats.total_messages'), value: stats?.totalMessages || 0, icon: MessageSquare },
    { label: t('stats.total_sessions'), value: stats?.totalSessions || 0, icon: Clock },
    { label: t('stats.last_7_days'), value: getLast7DaysMessages(), icon: Activity },
  ]
  const activityStats = [
    { label: t('stats.voice_inputs'), value: stats?.voiceInputs || 0, icon: Mic },
    { label: t('stats.screenshots'), value: stats?.screenshots || 0, icon: Scissors },
    { label: t('stats.searches'), value: stats?.searches || 0, icon: Globe },
  ]

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
        <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-3">
          {primaryStats.map(({ label, value, icon: Icon }) => (
            <div key={label} className="hera-section-card min-w-0 p-3">
              <div className="mb-3 flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="h-3.5 w-3.5" />
              </div>
              <span className="block text-xl font-semibold tracking-tight">{value}</span>
              <span className="mt-1 block truncate text-[11px] text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>

        <section className="hera-section-card p-3">
          <h3 className="mb-3 text-xs font-semibold">{t('stats.activity_title')}</h3>
          <div className="grid grid-cols-3 gap-2">
            {activityStats.map(({ label, value, icon: Icon }) => (
              <div key={label} className="min-w-0 rounded-xl bg-secondary/55 p-2.5">
                <Icon className="mb-2 h-3.5 w-3.5 text-muted-foreground" />
                <span className="block text-base font-semibold">{value}</span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        </section>

        <div className="hera-section-card flex items-center justify-between gap-4 p-3">
          <span className="text-xs text-muted-foreground">{t('stats.last_active')}</span>
          <span className="truncate text-right text-xs font-medium">{formatDate(stats?.lastActive)}</span>
        </div>
      </div>
    </div>
  )
}

export default StatsPanel
