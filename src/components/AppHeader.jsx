import { useEffect, useRef, useState } from 'react'
import {
  BarChart3,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileDown,
  History,
  Menu,
  MessageSquarePlus,
  Pencil,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

const MAX_SESSION_TITLE_LENGTH = 80

function AppHeader({
  activeSessionTitle,
  onRenameSession,
  onNewChat,
  onHistory,
  onClear,
  onExport,
  onExportMarkdown,
  onCopyChat,
  onImport,
  onSettings,
  onStats,
  searchOpen = false,
  searchQuery = '',
  searchCounterText = '',
  onToggleSearch,
  onSearchQueryChange,
  onSearchPrev,
  onSearchNext,
  onCloseSearch,
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleError, setTitleError] = useState(false)
  const menuRef = useRef(null)
  const importInputRef = useRef(null)
  const titleInputRef = useRef(null)
  const renameTriggerRef = useRef(null)
  const restoreTitleFocusRef = useRef(false)

  const displayedTitle = activeSessionTitle?.trim() || t('chat.new_chat')

  useEffect(() => {
    if (isEditingTitle) {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
      return
    }

    if (restoreTitleFocusRef.current) {
      restoreTitleFocusRef.current = false
      renameTriggerRef.current?.focus()
    }
  }, [isEditingTitle])

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

  const startEditingTitle = () => {
    setTitleDraft(displayedTitle)
    setTitleError(false)
    setIsEditingTitle(true)
  }

  const cancelEditingTitle = ({ restoreFocus = false } = {}) => {
    restoreTitleFocusRef.current = restoreFocus
    setTitleDraft(displayedTitle)
    setTitleError(false)
    setIsEditingTitle(false)
  }

  const saveTitle = ({ keepOpenOnInvalid = false, restoreFocus = false } = {}) => {
    const nextTitle = titleDraft.trim()
    if (!nextTitle) {
      if (keepOpenOnInvalid) {
        setTitleError(true)
        titleInputRef.current?.focus()
      } else {
        cancelEditingTitle({ restoreFocus })
      }
      return
    }

    restoreTitleFocusRef.current = restoreFocus
    setTitleError(false)
    setIsEditingTitle(false)
    if (nextTitle !== displayedTitle) onRenameSession?.(nextTitle)
  }

  const runAndClose = (callback) => {
    setMenuOpen(false)
    callback()
  }

  const menuItems = [
    { label: t('chat.tooltips.export'), icon: Download, action: onExport },
    { label: t('chat.tooltips.statistics'), icon: BarChart3, action: onStats },
    { label: t('chat.tooltips.settings'), icon: Settings, action: onSettings },
  ]

  return (
    <header className="relative z-30 flex h-12 shrink-0 items-center justify-between border-b border-border/70 bg-background/80 px-3 backdrop-blur-xl">
      <div className={`min-w-0 items-center gap-2 pr-2 ${searchOpen ? 'hidden' : 'flex flex-1'}`}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-violet-500 text-primary-foreground shadow-sm shadow-primary/25">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          {isEditingTitle ? (
            <div className="min-w-0">
              <input
                ref={titleInputRef}
                type="text"
                value={titleDraft}
                maxLength={MAX_SESSION_TITLE_LENGTH}
                aria-label={t('chat.session_title.input_label')}
                aria-invalid={titleError}
                aria-describedby={titleError ? 'header-session-title-error' : undefined}
                onChange={(event) => {
                  setTitleDraft(event.target.value)
                  if (titleError) setTitleError(false)
                }}
                onBlur={() => saveTitle()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    saveTitle({ keepOpenOnInvalid: true, restoreFocus: true })
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelEditingTitle({ restoreFocus: true })
                  }
                }}
                className={`h-6 w-full rounded-md border bg-background px-1.5 text-sm font-semibold leading-none tracking-tight outline-none transition-colors focus:ring-2 focus:ring-ring/40 ${
                  titleError ? 'border-destructive' : 'border-primary/40'
                }`}
              />
              {titleError && (
                <span id="header-session-title-error" className="sr-only">
                  {t('chat.session_title.empty_error')}
                </span>
              )}
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              <p className="truncate text-sm font-semibold leading-none tracking-tight" title={displayedTitle}>
                {displayedTitle}
              </p>
              <button
                ref={renameTriggerRef}
                type="button"
                onClick={startEditingTitle}
                title={t('chat.tooltips.rename_session')}
                aria-label={t('chat.tooltips.rename_session')}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Pencil className="h-3 w-3" />
              </button>
            </div>
          )}
          <p className="mt-1 truncate text-[11px] leading-none text-muted-foreground">
            HeraAi · {t('chat.assistant_label')}
          </p>
        </div>
      </div>

      {searchOpen && (
        <div className="mx-1 flex min-w-0 flex-1 items-center gap-1 rounded-xl border border-primary/25 bg-secondary/50 px-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            data-testid="chat-search-input"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (e.shiftKey) onSearchPrev?.()
                else onSearchNext?.()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onCloseSearch?.()
              }
            }}
            placeholder={t('chat.search_messages_placeholder')}
            autoFocus
            className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
          />
          <span data-testid="chat-search-count" className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {searchCounterText}
          </span>
          <button
            type="button"
            data-testid="chat-search-prev"
            title={t('chat.search_prev')}
            aria-label={t('chat.search_prev')}
            onClick={onSearchPrev}
            className="hera-icon-button h-6 w-6"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-testid="chat-search-next"
            title={t('chat.search_next')}
            aria-label={t('chat.search_next')}
            onClick={onSearchNext}
            className="hera-icon-button h-6 w-6"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-testid="chat-search-close"
            title={t('chat.tooltips.close')}
            aria-label={t('chat.tooltips.close')}
            onClick={onCloseSearch}
            className="hera-icon-button h-6 w-6"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          data-testid="chat-search-toggle"
          title={t('chat.tooltips.search_messages')}
          aria-label={t('chat.tooltips.search_messages')}
          aria-pressed={searchOpen}
          onClick={onToggleSearch}
          className={`hera-icon-button ${searchOpen ? 'bg-primary/10 text-primary' : ''}`}
        >
          <Search className="h-4 w-4" />
        </button>
        <button
          type="button"
          data-testid="header-export-markdown"
          title={t('chat.tooltips.export_markdown')}
          aria-label={t('chat.tooltips.export_markdown')}
          onClick={onExportMarkdown}
          className="hera-icon-button"
        >
          <FileDown className="h-4 w-4" />
        </button>
        <button
          type="button"
          data-testid="header-copy-chat"
          title={t('chat.tooltips.copy_chat')}
          aria-label={t('chat.tooltips.copy_chat')}
          onClick={onCopyChat}
          className="hera-icon-button"
        >
          <Copy className="h-4 w-4" />
        </button>
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
              className="hera-menu absolute right-0 top-10 w-40 overflow-hidden rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl shadow-black/10"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => runAndClose(onHistory)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium transition-colors hover:bg-secondary"
              >
                <History className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 truncate">{t('chat.tooltips.history')}</span>
              </button>

              <button
                type="button"
                role="menuitem"
                onClick={() => importInputRef.current?.click()}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium transition-colors hover:bg-secondary"
              >
                <Upload className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 truncate">{t('chat.tooltips.import')}</span>
              </button>

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
