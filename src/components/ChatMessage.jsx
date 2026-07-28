import { memo, useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Copy, FileText, Image as ImageIcon, Pencil, RefreshCw } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'

const COPY_TIMEOUT_MS = 2000
const RETRY_MENU_ESTIMATED_HEIGHT_PX = 226

async function copyText(text, { onSuccess, successMessage, errorMessage }) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable')
    await navigator.clipboard.writeText(text)
    onSuccess()
    toast.success(successMessage)
  } catch (error) {
    console.error('Clipboard copy failed', error)
    toast.error(errorMessage)
  }
}

function CodeBlock({ className, children, ...props }) {
  const { t } = useTranslation()
  const match = /language-(\w+)/.exec(className || '')
  const codeString = String(children).replace(/\n$/, '')
  const [codeCopied, setCodeCopied] = useState(false)

  const handleCopyCode = () => {
    copyText(codeString, {
      onSuccess: () => {
        setCodeCopied(true)
        setTimeout(() => setCodeCopied(false), COPY_TIMEOUT_MS)
      },
      successMessage: t('chat.tooltips.copied'),
      errorMessage: t('chat.tooltips.copy_failed'),
    })
  }

  if (!match) {
    return (
      <code className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[0.86em] text-primary" {...props}>
        {children}
      </code>
    )
  }

  return (
    <div className="my-3 max-w-full overflow-hidden rounded-xl border border-border/90 bg-[hsl(var(--surface-soft))] shadow-sm">
      <div className="flex min-h-9 items-center justify-between border-b border-border/80 bg-secondary/55 px-3">
        <span className="font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {match[1]}
        </span>
        <button
          type="button"
          onClick={handleCopyCode}
          className="hera-action-button -mr-1"
          aria-label={t('chat.tooltips.copy_code')}
        >
          {codeCopied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
          <span>{codeCopied ? t('chat.tooltips.copied') : t('chat.tooltips.copy')}</span>
        </button>
      </div>
      <pre className="m-0 max-w-full overflow-x-auto bg-transparent p-3 text-[12px] leading-relaxed">
        <code className={className} {...props}>{children}</code>
      </pre>
    </div>
  )
}

const ChatMessage = ({
  message,
  onEdit,
  onRetry,
  retryModels = [],
  modelLabels = {},
  currentModel,
  retryDisabled = false,
}) => {
  const { t } = useTranslation()
  const isBot = message.role === 'model'
  const [copied, setCopied] = useState(false)
  const [retryMenuOpen, setRetryMenuOpen] = useState(false)
  const [retryMenuPlacement, setRetryMenuPlacement] = useState('up')
  const retryMenuId = useId()
  const retryMenuRef = useRef(null)
  const retryTriggerRef = useRef(null)
  const sources = Array.isArray(message.sources) ? message.sources : []
  const isPending = message.status === 'thinking' || message.status === 'streaming'
  const availableRetryModels = Array.isArray(retryModels) ? retryModels : []
  const hasRetryModelChoices = availableRetryModels.length > 0
  const errorMessage = message.errorCode
    ? t(`chat.generation_errors.${message.errorCode}`, { defaultValue: t('chat.status.error') })
    : t('chat.status.error')

  const handleCopyMessage = () => {
    copyText(message.content || '', {
      onSuccess: () => {
        setCopied(true)
        setTimeout(() => setCopied(false), COPY_TIMEOUT_MS)
      },
      successMessage: t('chat.tooltips.copied'),
      errorMessage: t('chat.tooltips.copy_failed'),
    })
  }

  useEffect(() => {
    if (!retryMenuOpen) return undefined

    const preferredModelButton = retryMenuRef.current?.querySelector('[data-current-model="true"]')
      || retryMenuRef.current?.querySelector('[data-retry-model]')
    preferredModelButton?.focus()

    const handleOutsideClick = (event) => {
      if (retryMenuRef.current?.contains(event.target)) return
      if (retryTriggerRef.current?.contains(event.target)) return
      setRetryMenuOpen(false)
    }
    const handleFocusChange = (event) => {
      if (retryMenuRef.current?.contains(event.target)) return
      if (retryTriggerRef.current?.contains(event.target)) return
      setRetryMenuOpen(false)
    }
    const handleEscape = (event) => {
      if (event.key !== 'Escape') return
      setRetryMenuOpen(false)
      retryTriggerRef.current?.focus()
    }

    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('focusin', handleFocusChange)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('focusin', handleFocusChange)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [retryMenuOpen])

  const handleRetryTrigger = () => {
    if (retryDisabled || isPending) return
    if (!hasRetryModelChoices) {
      onRetry?.(message)
      return
    }
    if (!retryMenuOpen) {
      const triggerBounds = retryTriggerRef.current?.getBoundingClientRect()
      const scrollBounds = retryTriggerRef.current?.closest('main')?.getBoundingClientRect()
      if (triggerBounds) {
        const topBoundary = scrollBounds?.top ?? 0
        const bottomBoundary = scrollBounds?.bottom ?? window.innerHeight
        const spaceAbove = triggerBounds.top - topBoundary
        const spaceBelow = bottomBoundary - triggerBounds.bottom
        setRetryMenuPlacement(
          spaceAbove >= RETRY_MENU_ESTIMATED_HEIGHT_PX || spaceAbove >= spaceBelow ? 'up' : 'down'
        )
      }
    }
    setRetryMenuOpen(open => !open)
  }

  const handleRetryWithModel = (model) => {
    setRetryMenuOpen(false)
    onRetry?.(message, model)
  }

  const renderRetryButton = (compact = false) => (
    <button
      ref={retryTriggerRef}
      type="button"
      onClick={handleRetryTrigger}
      title={hasRetryModelChoices ? t('chat.retry_model.title') : t('chat.tooltips.retry')}
      aria-label={hasRetryModelChoices ? t('chat.retry_model.title') : t('chat.tooltips.retry')}
      aria-haspopup={hasRetryModelChoices ? 'dialog' : undefined}
      aria-expanded={hasRetryModelChoices ? retryMenuOpen : undefined}
      aria-controls={hasRetryModelChoices ? retryMenuId : undefined}
      className={`${compact ? 'hera-icon-button relative h-7 w-7' : 'hera-action-button'} ${
        retryMenuOpen ? 'bg-primary/10 text-primary' : ''
      }`}
      disabled={retryDisabled || isPending}
    >
      <RefreshCw className="h-3.5 w-3.5" />
      {compact && hasRetryModelChoices && (
        <ChevronDown className="absolute bottom-0.5 right-0.5 h-2 w-2 opacity-65" />
      )}
      {!compact && (
        <>
          <span>{t('chat.tooltips.retry_short')}</span>
          {hasRetryModelChoices && <ChevronDown className="h-3 w-3 opacity-65" />}
        </>
      )}
    </button>
  )

  const renderRetryMenu = (alignment) => {
    if (!retryMenuOpen || !hasRetryModelChoices) return null

    return (
      <div
        ref={retryMenuRef}
        id={retryMenuId}
        role="dialog"
        aria-label={t('chat.retry_model.title')}
        className={`hera-menu absolute z-30 w-[240px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border/80 bg-popover/95 shadow-xl shadow-black/10 backdrop-blur-xl ${
          alignment === 'right' ? 'right-0' : 'left-0'
        } ${
          retryMenuPlacement === 'up' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
        }`}
      >
        <div className="border-b border-border/60 bg-primary/[0.055] px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <RefreshCw className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-foreground">{t('chat.retry_model.title')}</p>
              <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{t('chat.retry_model.description')}</p>
            </div>
          </div>
        </div>
        <div className="space-y-0.5 p-1.5">
          {availableRetryModels.map((model) => {
            const isCurrentModel = model === currentModel
            return (
              <button
                key={model}
                type="button"
                data-retry-model={model}
                data-current-model={isCurrentModel ? 'true' : undefined}
                onClick={() => handleRetryWithModel(model)}
                disabled={retryDisabled || isPending}
                className={`flex min-h-9 w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:pointer-events-none disabled:opacity-45 ${
                  isCurrentModel
                    ? 'border-primary/20 bg-primary/[0.09] text-foreground'
                    : 'border-transparent text-foreground hover:border-border/70 hover:bg-secondary/80'
                }`}
              >
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                  isCurrentModel
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border/90 bg-background/70'
                }`}>
                  {isCurrentModel && <Check className="h-2.5 w-2.5" />}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {modelLabels[model] || model}
                </span>
                {isCurrentModel && (
                  <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold text-primary">
                    {t('chat.retry_model.default')}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  if (!isBot) {
    return (
      <article className="group flex w-full justify-end">
        <div className="max-w-[88%] rounded-2xl rounded-br-md border border-primary/10 bg-primary/[0.09] px-3.5 py-2.5 shadow-sm">
          <div className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-foreground">
            {message.content}
          </div>

          {message.attachments?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {message.attachments.map((attachment, index) => (
                <div
                  key={`${attachment.name || 'attachment'}-${index}`}
                  className="flex min-w-0 items-center gap-1.5 rounded-lg border border-border/70 bg-background/55 px-2 py-1 text-[11px] text-muted-foreground"
                >
                  {attachment.mimeType.startsWith('image/')
                    ? <ImageIcon className="h-3 w-3 shrink-0" />
                    : <FileText className="h-3 w-3 shrink-0" />}
                  <span className="max-w-[150px] truncate">{attachment.name || t('chat.attachment')}</span>
                </div>
              ))}
            </div>
          )}

          {(message.content || message.attachments?.length > 0) && (
            <div className="relative mt-1.5 flex flex-col items-end gap-1.5">
              <div className="flex justify-end gap-0.5">
                {message.content && (
                  <button
                    type="button"
                    onClick={handleCopyMessage}
                    title={t('chat.tooltips.copy')}
                    aria-label={t('chat.tooltips.copy')}
                    className="hera-icon-button h-7 w-7"
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                )}
                {renderRetryButton(true)}
                {message.content && (
                  <button
                    type="button"
                    onClick={() => onEdit?.(message.content)}
                    title={t('chat.tooltips.edit')}
                    aria-label={t('chat.tooltips.edit')}
                    className="hera-icon-button h-7 w-7"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {renderRetryMenu('right')}
            </div>
          )}
        </div>
      </article>
    )
  }

  return (
    <article data-testid="assistant-message" className="group w-full min-w-0 py-1">
      {isPending && !message.content ? (
        <div className="min-h-16 space-y-2 rounded-xl py-2">
          <div className="h-2.5 w-3/4 animate-pulse rounded-full bg-muted-foreground/15" />
          <div className="h-2.5 w-1/2 animate-pulse rounded-full bg-muted-foreground/15" />
          <span className="block pt-1 text-[11px] text-muted-foreground">{t('chat.status.thinking')}</span>
        </div>
      ) : (
        <div data-testid="assistant-content" className="prose prose-sm max-w-none break-words text-[14px] leading-relaxed text-foreground dark:prose-invert prose-headings:mb-2 prose-headings:mt-4 prose-headings:font-semibold prose-p:my-2 prose-p:whitespace-pre-wrap prose-p:leading-[1.65] prose-li:my-0.5 prose-a:text-primary prose-pre:m-0 prose-pre:bg-transparent prose-pre:p-0 prose-table:block prose-table:max-w-full prose-table:overflow-x-auto">
          {isPending ? (
            <div className="whitespace-pre-wrap">{message.content}</div>
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSanitize]}
              components={{
                code({ inline, className, children, ...props }) {
                  if (!inline && className) {
                    return <CodeBlock className={className} {...props}>{children}</CodeBlock>
                  }
                  return (
                    <code className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[0.86em] text-primary" {...props}>
                      {children}
                    </code>
                  )
                },
              }}
            >
              {message.content || ''}
            </ReactMarkdown>
          )}
        </div>
      )}

      {message.status === 'cancelled' && (
        <span className="mt-1 block text-[11px] text-muted-foreground">{t('chat.status.cancelled')}</span>
      )}
      {message.status === 'error' && (
        <span className="mt-1 block text-[11px] text-destructive">{errorMessage}</span>
      )}
      {message.status === 'interrupted' && (
        <span className="mt-1 block text-[11px] text-amber-500">{t('chat.status.interrupted')}</span>
      )}

      {sources.length > 0 && (
        <div className="mt-3">
          <span className="mb-1.5 block text-[11px] font-semibold text-muted-foreground">{t('chat.sources_label')}</span>
          <div className="flex flex-wrap gap-1.5">
            {sources.map((source) => (
              <a
                key={`${source.index}-${source.url}`}
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-border/80 bg-card/70 px-2 py-1.5 text-[11px] text-foreground no-underline transition-colors hover:border-primary/25 hover:bg-secondary"
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[9px] font-semibold text-primary">
                  {source.index}
                </span>
                <span className="max-w-[240px] truncate">{source.title || source.url}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {(message.content || message.status === 'interrupted' || message.status === 'error') && (
        <div className="relative mt-1.5 flex flex-col items-start gap-1.5 border-t border-border/45 pt-1.5">
          <div className="flex min-h-8 items-center gap-0.5">
            <button
              type="button"
              onClick={handleCopyMessage}
              aria-label={t('chat.tooltips.copy')}
              className="hera-action-button"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copied ? t('chat.tooltips.copied') : t('chat.tooltips.copy')}</span>
            </button>
            {renderRetryButton()}
          </div>
          {renderRetryMenu('left')}
        </div>
      )}
    </article>
  )
}

function areMessagesEqual(prevProps, nextProps) {
  const prevMessage = prevProps.message
  const nextMessage = nextProps.message

  return (
    prevMessage.id === nextMessage.id &&
    prevMessage.role === nextMessage.role &&
    prevMessage.content === nextMessage.content &&
    prevMessage.status === nextMessage.status &&
    prevMessage.sources === nextMessage.sources &&
    prevMessage.attachments === nextMessage.attachments &&
    prevProps.currentModel === nextProps.currentModel &&
    prevProps.retryDisabled === nextProps.retryDisabled &&
    prevProps.retryModels === nextProps.retryModels &&
    prevProps.modelLabels === nextProps.modelLabels &&
    prevProps.onEdit === nextProps.onEdit &&
    prevProps.onRetry === nextProps.onRetry
  )
}

export default memo(ChatMessage, areMessagesEqual)
