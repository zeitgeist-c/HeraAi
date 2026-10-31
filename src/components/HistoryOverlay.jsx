import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Cloud, HardDrive, History, Loader2, Pencil, Star, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { findChatMatchIds } from '../lib/chatSearch'

const MAX_SESSION_TITLE_LENGTH = 80

function HistoryOverlay({
  sessions,
  activeSessionId,
  onSelect,
  onDelete,
  onRename,
  onToggleStar,
  onToggleSyncPolicy,
  onRequestBulkDelete,
  bulkDeleteOpen,
  onCancelBulkDelete,
  onConfirmBulkDelete,
  isBulkDeleting,
  onClose,
}) {
  const { t } = useTranslation()
  const [editingSessionId, setEditingSessionId] = useState(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleError, setTitleError] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [includeStarred, setIncludeStarred] = useState(false)
  const editInputRef = useRef(null)
  const renameTriggerRefs = useRef(new Map())
  const lastEditedSessionIdRef = useRef(null)
  const restoreRenameFocusRef = useRef(false)
  const bulkDeleteTriggerRef = useRef(null)
  const closeButtonRef = useRef(null)
  const bulkDeleteDialogRef = useRef(null)
  const cancelBulkDeleteRef = useRef(null)
  const bulkDeleteWasOpenRef = useRef(false)

  // History lists only chats that have really started (at least one user message).
  const startedSessions = sessions.filter(session => (
    (session?.messages || []).some(message => message?.role === 'user')
  ))
  const sortedSessions = [...startedSessions].sort((a, b) => b.updatedAt - a.updatedAt)
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase('tr')
  const filteredSessions = normalizedQuery
    ? sortedSessions.filter(session => (
      (session.title || '').toLocaleLowerCase('tr').includes(normalizedQuery)
      || findChatMatchIds(session.messages, normalizedQuery).length > 0
    ))
    : sortedSessions
  const starredSessions = filteredSessions.filter((session) => session.isStarred)
  const otherSessions = filteredSessions.filter((session) => !session.isStarred)
  const unstarredCount = sessions.filter(session => !session.isStarred).length
  const protectedCount = sessions.filter(session => session.isStarred).length
  const deleteCount = includeStarred ? sessions.length : unstarredCount

  useEffect(() => {
    if (editingSessionId) {
      lastEditedSessionIdRef.current = editingSessionId
      editInputRef.current?.focus()
      editInputRef.current?.select()
      return
    }

    const lastEditedSessionId = lastEditedSessionIdRef.current
    if (lastEditedSessionId && restoreRenameFocusRef.current) {
      restoreRenameFocusRef.current = false
      lastEditedSessionIdRef.current = null
      renameTriggerRefs.current.get(lastEditedSessionId)?.focus()
    } else if (lastEditedSessionId) {
      lastEditedSessionIdRef.current = null
    }
  }, [editingSessionId])

  useEffect(() => {
    if (!bulkDeleteOpen) {
      if (bulkDeleteWasOpenRef.current) {
        const bulkDeleteTrigger = bulkDeleteTriggerRef.current
        if (bulkDeleteTrigger && !bulkDeleteTrigger.disabled) bulkDeleteTrigger.focus()
        else closeButtonRef.current?.focus()
      }
      bulkDeleteWasOpenRef.current = false
      return undefined
    }

    if (!bulkDeleteWasOpenRef.current) {
      bulkDeleteWasOpenRef.current = true
      cancelBulkDeleteRef.current?.focus()
    }
    const handleEscape = (event) => {
      if (event.key === 'Escape' && !isBulkDeleting) onCancelBulkDelete?.()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [bulkDeleteOpen, isBulkDeleting, onCancelBulkDelete])

  const keepFocusInBulkDeleteDialog = (event) => {
    if (event.key !== 'Tab') return
    const focusableElements = bulkDeleteDialogRef.current?.querySelectorAll(
      'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )
    if (!focusableElements?.length) return

    const firstElement = focusableElements[0]
    const lastElement = focusableElements[focusableElements.length - 1]
    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault()
      lastElement.focus()
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault()
      firstElement.focus()
    }
  }

  const startRenaming = (session) => {
    setEditingSessionId(session.id)
    setTitleDraft(session.title || t('chat.new_chat'))
    setTitleError(false)
  }

  const cancelRenaming = ({ restoreFocus = false } = {}) => {
    restoreRenameFocusRef.current = restoreFocus
    setEditingSessionId(null)
    setTitleDraft('')
    setTitleError(false)
  }

  const saveTitle = (session, { keepOpenOnInvalid = false, restoreFocus = false } = {}) => {
    const nextTitle = titleDraft.trim()
    if (!nextTitle) {
      if (keepOpenOnInvalid) {
        setTitleError(true)
        editInputRef.current?.focus()
      } else {
        cancelRenaming({ restoreFocus })
      }
      return
    }

    restoreRenameFocusRef.current = restoreFocus
    setEditingSessionId(null)
    setTitleDraft('')
    setTitleError(false)
    if (nextTitle !== session.title) onRename?.(session.id, nextTitle)
  }

  const renderSession = (session) => {
    const isEditing = editingSessionId === session.id
    const isActive = activeSessionId === session.id
    return (
      <div
        key={session.id}
        className={`group flex w-full items-center rounded-xl border p-2.5 text-left transition-all ${
          isActive
            ? 'border-primary/30 bg-primary/[0.08] shadow-sm'
            : 'border-border/75 bg-card/70 hover:border-primary/20 hover:bg-card'
        }`}
      >
        {isEditing ? (
          <div className="min-w-0 flex-1 pr-2">
            <input
              ref={editInputRef}
              type="text"
              value={titleDraft}
              maxLength={MAX_SESSION_TITLE_LENGTH}
              aria-label={t('chat.session_title.input_label')}
              aria-invalid={titleError}
              aria-describedby={titleError ? `session-title-error-${session.id}` : undefined}
              onChange={(event) => {
                setTitleDraft(event.target.value)
                if (titleError) setTitleError(false)
              }}
              onBlur={() => saveTitle(session)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  saveTitle(session, { keepOpenOnInvalid: true, restoreFocus: true })
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelRenaming({ restoreFocus: true })
                }
              }}
              className={`h-8 w-full rounded-lg border bg-background px-2 text-[13px] font-medium outline-none transition-colors focus:ring-2 focus:ring-ring/40 ${
                titleError ? 'border-destructive' : 'border-primary/40'
              }`}
            />
            {titleError && (
              <p id={`session-title-error-${session.id}`} className="mt-1 text-[10px] text-destructive">
                {t('chat.session_title.empty_error')}
              </p>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onSelect(session.id)}
            className="min-w-0 flex-1 rounded-lg px-0.5 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-current={isActive ? 'true' : undefined}
          >
            <span className="flex min-w-0 flex-col pr-2">
              <span className="truncate text-[13px] font-medium">{session.title}</span>
              <span className="mt-1 text-[11px] text-muted-foreground">
                {new Date(session.updatedAt).toLocaleString()}
              </span>
            </span>
          </button>
        )}

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => onToggleSyncPolicy?.(session.id)}
            aria-label={t(session.syncPolicy === 'local_only' ? 'chat.sync_policy.enable' : 'chat.sync_policy.disable')}
            title={t(session.syncPolicy === 'local_only' ? 'chat.sync_policy.enable' : 'chat.sync_policy.disable')}
            aria-pressed={session.syncPolicy !== 'local_only'}
            className={`hera-icon-button h-7 w-7 opacity-70 group-hover:opacity-100 ${
              session.syncPolicy === 'local_only' ? 'text-amber-500' : 'text-primary'
            }`}
          >
            {session.syncPolicy === 'local_only' ? <HardDrive className="h-3.5 w-3.5" /> : <Cloud className="h-3.5 w-3.5" />}
          </button>
          <button
            ref={(node) => {
              if (node) renameTriggerRefs.current.set(session.id, node)
              else renameTriggerRefs.current.delete(session.id)
            }}
            type="button"
            onClick={() => startRenaming(session)}
            aria-label={t('chat.tooltips.rename_session')}
            title={t('chat.tooltips.rename_session')}
            className="hera-icon-button h-7 w-7 opacity-70 group-hover:opacity-100"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onToggleStar?.(session.id)}
            aria-label={t(session.isStarred ? 'chat.tooltips.unstar_session' : 'chat.tooltips.star_session')}
            title={t(session.isStarred ? 'chat.tooltips.unstar_session' : 'chat.tooltips.star_session')}
            aria-pressed={Boolean(session.isStarred)}
            className={`hera-icon-button h-7 w-7 opacity-70 group-hover:opacity-100 ${
              session.isStarred ? 'text-amber-500 hover:bg-amber-500/10 hover:text-amber-500' : ''
            }`}
          >
            <Star className="h-3.5 w-3.5" fill={session.isStarred ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            onClick={() => onDelete(session.id)}
            aria-label={t('chat.tooltips.delete_session')}
            title={t('chat.tooltips.delete_session')}
            className="hera-icon-button h-7 w-7 opacity-70 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    )
  }

  const sections = [
    { key: 'starred', title: t('chat.history_groups.starred'), sessions: starredSessions },
    { key: 'other', title: t('chat.history_groups.other'), sessions: otherSessions },
  ].filter((section) => section.sessions.length > 0)

  return (
    <div className="hera-panel relative flex h-screen min-w-0 flex-col bg-background text-foreground">
      <header className="hera-panel-header">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <History className="h-4 w-4" />
          </span>
          <h2 className="hera-panel-title truncate">{t('chat.history_title')}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            ref={bulkDeleteTriggerRef}
            type="button"
            onClick={() => { setIncludeStarred(false); onRequestBulkDelete() }}
            disabled={startedSessions.length === 0 || isBulkDeleting}
            aria-haspopup="dialog"
            className="flex h-9 items-center gap-1.5 rounded-xl border border-destructive/25 px-3 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{t('chat.bulk_delete.action')}</span>
          </button>
          <button ref={closeButtonRef} type="button" onClick={onClose} className="hera-icon-button" aria-label={t('chat.tooltips.close')}>
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="px-3 pb-2 pt-1">
        <input
          data-testid="history-search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('chat.history_search_placeholder')}
          className="h-9 w-full rounded-xl border border-input bg-background/60 px-3 text-xs"
        />
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {startedSessions.length === 0 && (
          <div className="flex min-h-52 flex-col items-center justify-center rounded-2xl border border-dashed border-border px-5 text-center">
            <History className="mb-3 h-6 w-6 text-muted-foreground/55" />
            <p className="text-xs text-muted-foreground">{t('chat.no_history')}</p>
          </div>
        )}
        <div className="space-y-4">
          {sections.map((section) => (
            <section key={section.key} aria-labelledby={`history-group-${section.key}`}>
              <h3
                id={`history-group-${section.key}`}
                className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
              >
                {section.title}
              </h3>
              <div className="space-y-2">{section.sessions.map(renderSession)}</div>
            </section>
          ))}
        </div>
      </div>

      {bulkDeleteOpen && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isBulkDeleting) onCancelBulkDelete?.()
          }}
        >
          <div
            ref={bulkDeleteDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-delete-title"
            aria-describedby="bulk-delete-description"
            onKeyDown={keepFocusInBulkDeleteDialog}
            className="w-full max-w-sm rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-2xl shadow-black/20"
          >
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
                <AlertTriangle className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h3 id="bulk-delete-title" className="text-sm font-semibold">
                  {t(includeStarred ? 'chat.bulk_delete.all_title' : 'chat.bulk_delete.title')}
                </h3>
                <p id="bulk-delete-description" className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t(includeStarred ? 'chat.bulk_delete.all_description' : 'chat.bulk_delete.description', { count: deleteCount })}
                </p>
                {!includeStarred && protectedCount > 0 && (
                  <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                    <Star className="h-3 w-3" fill="currentColor" />
                    {t('chat.bulk_delete.protected', { count: protectedCount })}
                  </p>
                )}
              </div>
            </div>
            <label className="mt-3 flex items-center gap-2 text-xs">
              <input type="checkbox" checked={includeStarred} disabled={isBulkDeleting} onChange={event => setIncludeStarred(event.target.checked)} />
              {t('chat.bulk_delete.include_starred')}
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                ref={cancelBulkDeleteRef}
                type="button"
                onClick={onCancelBulkDelete}
                disabled={isBulkDeleting}
                className="h-9 rounded-xl border border-border px-3 text-xs font-semibold transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {t('chat.bulk_delete.cancel')}
              </button>
              <button
                type="button"
                onClick={() => onConfirmBulkDelete(includeStarred)}
                disabled={isBulkDeleting || deleteCount === 0}
                className="flex h-9 items-center gap-1.5 rounded-xl bg-destructive px-3 text-xs font-semibold text-destructive-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBulkDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {t(isBulkDeleting ? 'chat.bulk_delete.deleting' : includeStarred ? 'chat.bulk_delete.all_confirm' : 'chat.bulk_delete.confirm', {
                  count: deleteCount,
                })}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default HistoryOverlay
