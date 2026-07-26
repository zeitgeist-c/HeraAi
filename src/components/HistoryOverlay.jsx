import { History, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

function HistoryOverlay({ sessions, activeSessionId, onSelect, onDelete, onClose }) {
  const { t } = useTranslation()
  return (
    <div className="hera-panel flex h-screen min-w-0 flex-col bg-background text-foreground">
      <header className="hera-panel-header">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <History className="h-4 w-4" />
          </span>
          <h2 className="hera-panel-title truncate">{t('chat.history_title')}</h2>
        </div>
        <button type="button" onClick={onClose} className="hera-icon-button" aria-label={t('chat.tooltips.close')}>
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {sessions.length === 0 && (
          <div className="flex min-h-52 flex-col items-center justify-center rounded-2xl border border-dashed border-border px-5 text-center">
            <History className="mb-3 h-6 w-6 text-muted-foreground/55" />
            <p className="text-xs text-muted-foreground">{t('chat.no_history')}</p>
          </div>
        )}
        {[...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map((session) => (
          <div
            key={session.id}
            role="button"
            tabIndex={0}
            className={`group flex w-full items-center justify-between rounded-xl border p-3 text-left transition-all ${
              activeSessionId === session.id
                ? 'border-primary/30 bg-primary/[0.08] shadow-sm'
                : 'border-border/75 bg-card/70 hover:border-primary/20 hover:bg-card'
            }`}
            onClick={() => onSelect(session.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect(session.id)
              }
            }}
          >
            <span className="flex min-w-0 flex-1 flex-col pr-2">
              <span className="truncate text-[13px] font-medium">{session.title}</span>
              <span className="mt-1 text-[11px] text-muted-foreground">{new Date(session.updatedAt).toLocaleString()}</span>
            </span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onDelete(session.id)
              }}
              aria-label={t('chat.tooltips.delete_session')}
              className="hera-icon-button h-7 w-7 opacity-70 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

export default HistoryOverlay
