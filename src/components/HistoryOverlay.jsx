import { History, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

function HistoryOverlay({ sessions, activeSessionId, onSelect, onDelete, onClose }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col h-screen bg-background text-foreground p-6 pt-12">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <History className="w-6 h-6 text-primary" />
          <h2 className="text-xl font-bold">{t('chat.history_title')}</h2>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-secondary rounded-full"><X className="w-5 h-5" /></button>
      </div>
      <div className="flex-1 overflow-y-auto space-y-2 pb-4 pr-1">
        {sessions.length === 0 && <p className="text-sm text-muted-foreground">{t('chat.no_history')}</p>}
        {[...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map(s => (
          <div key={s.id} className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer ${activeSessionId === s.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary/50'}`} onClick={() => onSelect(s.id)}>
            <div className="flex flex-col flex-1 overflow-hidden pr-2">
              <span className="text-sm font-medium truncate">{s.title}</span>
              <span className="text-[10px] text-muted-foreground">{new Date(s.updatedAt).toLocaleString()}</span>
            </div>
            <button onClick={(e) => { e.stopPropagation(); onDelete(s.id); }} className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

export default HistoryOverlay
