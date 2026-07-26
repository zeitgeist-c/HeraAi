import { memo, useState } from 'react'
import { Check, Copy, FileText, Image as ImageIcon, Pencil, RefreshCw } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'

const COPY_TIMEOUT_MS = 2000

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

const ChatMessage = ({ message, onEdit, isPending, onRetry }) => {
  const { t } = useTranslation()
  const isBot = message.role === 'model'
  const [copied, setCopied] = useState(false)
  const sources = Array.isArray(message.sources) ? message.sources : []

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

          {message.content && (
            <div className="mt-1.5 flex justify-end gap-0.5">
              <button
                type="button"
                onClick={() => onRetry?.(message)}
                title={t('chat.tooltips.retry')}
                aria-label={t('chat.tooltips.retry')}
                className="hera-icon-button h-7 w-7"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onEdit?.(message.content)}
                title={t('chat.tooltips.edit')}
                aria-label={t('chat.tooltips.edit')}
                className="hera-icon-button h-7 w-7"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
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
        <div data-testid="assistant-content" className="prose prose-sm max-w-none break-words text-[14px] leading-relaxed text-foreground dark:prose-invert prose-headings:mb-2 prose-headings:mt-4 prose-headings:font-semibold prose-p:my-2 prose-p:leading-[1.65] prose-li:my-0.5 prose-a:text-primary prose-pre:m-0 prose-pre:bg-transparent prose-pre:p-0 prose-table:block prose-table:max-w-full prose-table:overflow-x-auto">
          {isPending ? (
            message.content
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
              {message.content}
            </ReactMarkdown>
          )}
        </div>
      )}

      {message.status === 'cancelled' && (
        <span className="mt-1 block text-[11px] text-muted-foreground">{t('chat.status.cancelled')}</span>
      )}
      {message.status === 'error' && (
        <span className="mt-1 block text-[11px] text-destructive">{t('chat.status.error')}</span>
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

      {message.content && (
        <div className="mt-1.5 flex min-h-8 items-center gap-0.5 border-t border-border/45 pt-1.5">
          <button
            type="button"
            onClick={handleCopyMessage}
            aria-label={t('chat.tooltips.copy')}
            className="hera-action-button"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? t('chat.tooltips.copied') : t('chat.tooltips.copy')}</span>
          </button>
          <button
            type="button"
            onClick={() => onRetry?.(message)}
            aria-label={t('chat.tooltips.retry')}
            className="hera-action-button"
            disabled={isPending}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>{t('chat.tooltips.retry_short')}</span>
          </button>
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
    prevProps.isPending === nextProps.isPending &&
    prevMessage.attachments === nextMessage.attachments
  )
}

export default memo(ChatMessage, areMessagesEqual)
