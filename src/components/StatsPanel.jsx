import { useState, useEffect } from 'react'
import { MessageSquare, Clock, Mic, Scissors, Globe, Trash2, X } from 'lucide-react'
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
      const dateStr = date.toDateString()
      last7Days.push(stats.messagesByDate[dateStr] || 0)
    }
    return last7Days.reduce((a, b) => a + b, 0)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-background text-foreground p-6 pt-12">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-6 h-6 text-primary" />
          <h2 className="text-xl font-bold">{t('stats.title')}</h2>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-secondary rounded-full">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-card border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <MessageSquare className="w-4 h-4 text-primary" />
              <span className="text-sm text-muted-foreground">{t('stats.total_messages')}</span>
            </div>
            <span className="text-2xl font-bold">{stats?.totalMessages || 0}</span>
          </div>

          <div className="bg-card border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Clock className="w-4 h-4 text-primary" />
              <span className="text-sm text-muted-foreground">{t('stats.total_sessions')}</span>
            </div>
            <span className="text-2xl font-bold">{stats?.totalSessions || 0}</span>
          </div>
        </div>

        <div className="bg-card border rounded-xl p-4">
          <span className="text-sm text-muted-foreground block mb-2">{t('stats.last_7_days')}</span>
          <span className="text-2xl font-bold">{getLast7DaysMessages()}</span>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="bg-card border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1">
              <Mic className="w-4 h-4 text-primary" />
              <span className="text-xs text-muted-foreground">{t('stats.voice_inputs')}</span>
            </div>
            <span className="text-lg font-bold">{stats?.voiceInputs || 0}</span>
          </div>

          <div className="bg-card border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1">
              <Scissors className="w-4 h-4 text-primary" />
              <span className="text-xs text-muted-foreground">{t('stats.screenshots')}</span>
            </div>
            <span className="text-lg font-bold">{stats?.screenshots || 0}</span>
          </div>

          <div className="bg-card border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1">
              <Globe className="w-4 h-4 text-primary" />
              <span className="text-xs text-muted-foreground">{t('stats.searches')}</span>
            </div>
            <span className="text-lg font-bold">{stats?.searches || 0}</span>
          </div>
        </div>

        <div className="bg-card border rounded-xl p-4">
          <span className="text-sm text-muted-foreground block mb-1">{t('stats.last_active')}</span>
          <span className="text-sm font-medium">{formatDate(stats?.lastActive)}</span>
        </div>
      </div>
    </div>
  )
}

export default StatsPanel
