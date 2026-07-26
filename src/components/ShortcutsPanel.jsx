import { Keyboard, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

function ShortcutsPanel({ onClose }) {
  const { t } = useTranslation()
  const shortcuts = [
    { id: 'new_chat', keys: ['Ctrl', 'N'], description: t('shortcuts.new_chat') },
    { id: 'send_message', keys: ['Enter'], description: t('shortcuts.send_message') },
    { id: 'send_multiline', keys: ['Shift', 'Enter'], description: t('shortcuts.send_multiline') },
    { id: 'voice_input', keys: [t('shortcuts.click'), t('shortcuts.mic')], description: t('shortcuts.voice_input') },
    { id: 'web_search', keys: [t('shortcuts.click'), t('shortcuts.web')], description: t('shortcuts.web_search') },
  ]

  return (
    <div className="hera-panel flex h-screen flex-col bg-background text-foreground">
      <header className="hera-panel-header">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Keyboard className="h-4 w-4" />
          </span>
          <h2 className="hera-panel-title truncate">{t('shortcuts.title')}</h2>
        </div>
        <button type="button" onClick={onClose} className="hera-icon-button" aria-label={t('chat.tooltips.close')}>
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {shortcuts.map((shortcut) => (
          <div key={shortcut.id} className="hera-section-card flex min-h-14 items-center justify-between gap-4 px-3 py-2.5">
            <span className="min-w-0 text-xs text-foreground">{shortcut.description}</span>
            <span className="flex shrink-0 items-center gap-1">
              {shortcut.keys.map((key) => (
                <kbd key={key} className="min-w-7 rounded-md border border-border bg-secondary/70 px-1.5 py-1 text-center font-mono text-[10px] font-medium text-muted-foreground shadow-sm">
                  {key}
                </kbd>
              ))}
            </span>
          </div>
        ))}

        <p className="rounded-xl bg-primary/[0.07] p-3 text-[11px] leading-relaxed text-muted-foreground">
          {t('shortcuts.coming_soon')}
        </p>
      </div>
    </div>
  )
}

export default ShortcutsPanel
