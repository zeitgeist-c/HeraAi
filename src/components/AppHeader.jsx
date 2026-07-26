import { useEffect, useRef, useState } from 'react'
import {
  BarChart3,
  Download,
  History,
  Keyboard,
  Menu,
  MessageSquarePlus,
  Settings,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

function AppHeader({
  onNewChat,
  onHistory,
  onClear,
  onExport,
  onImport,
  onSettings,
  onStats,
  onShortcuts,
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)
  const importInputRef = useRef(null)

  useEffect(() => {
    if (!menuOpen) return undefined

    const handlePointerDown = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false)
    }
    const handleEscape = (event) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [menuOpen])

  const runAndClose = (callback) => {
    setMenuOpen(false)
    callback()
  }

  const menuItems = [
    { label: t('chat.tooltips.history'), icon: History, action: onHistory },
    { label: t('chat.tooltips.export'), icon: Download, action: onExport },
    { label: t('chat.tooltips.statistics'), icon: BarChart3, action: onStats },
    { label: t('chat.tooltips.shortcuts'), icon: Keyboard, action: onShortcuts },
    { label: t('chat.tooltips.settings'), icon: Settings, action: onSettings },
  ]

  return (
    <header className="relative z-30 flex h-12 shrink-0 items-center justify-between border-b border-border/70 bg-background/80 px-3 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-violet-500 text-primary-foreground shadow-sm shadow-primary/25">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-none tracking-tight">HeraAi</p>
          <p className="mt-1 text-[11px] leading-none text-muted-foreground">{t('chat.assistant_label')}</p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          title={t('chat.tooltips.new_chat')}
          aria-label={t('chat.tooltips.new_chat')}
          onClick={onNewChat}
          className="hera-icon-button text-primary hover:bg-primary/10 hover:text-primary"
        >
          <MessageSquarePlus className="h-4 w-4" />
        </button>

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            title={t('chat.tooltips.more')}
            aria-label={t('chat.tooltips.more')}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((open) => !open)}
            className="hera-icon-button"
          >
            <Menu className="h-4 w-4" />
          </button>

          {menuOpen && (
            <div
              role="menu"
              aria-label={t('chat.tooltips.more')}
              className="hera-menu absolute right-0 top-10 w-56 overflow-hidden rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl shadow-black/10"
            >
              {menuItems.map(({ label, icon: Icon, action }) => (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  onClick={() => runAndClose(action)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium transition-colors hover:bg-secondary"
                >
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <span className="flex-1 truncate">{label}</span>
                </button>
              ))}

              <button
                type="button"
                role="menuitem"
                onClick={() => importInputRef.current?.click()}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium transition-colors hover:bg-secondary"
              >
                <Upload className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 truncate">{t('chat.tooltips.import')}</span>
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept=".json"
                onChange={(event) => {
                  setMenuOpen(false)
                  onImport(event)
                  event.target.value = ''
                }}
                className="hidden"
              />

              <div className="my-1 border-t border-border/70" />
              <button
                type="button"
                role="menuitem"
                onClick={() => runAndClose(onClear)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4" />
                <span>{t('chat.tooltips.clear_chat')}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

export default AppHeader
