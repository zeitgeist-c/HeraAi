import { memo, useState } from 'react'
import { Bot, User, Copy, Check, RefreshCw, Image as ImageIcon, FileText, Pencil } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'

const COPY_TIMEOUT_MS = 2000

function CodeBlock({ className, children, ...props }) {
  const { t } = useTranslation()
  const match = /language-(\w+)/.exec(className || '')
  const codeString = String(children).replace(/\n$/, '')
  const [codeCopied, setCodeCopied] = useState(false)

  const handleCopyCode = () => {
    navigator.clipboard.writeText(codeString)
    setCodeCopied(true)
    toast.success(t('chat.tooltips.copied'))
    setTimeout(() => setCodeCopied(false), COPY_TIMEOUT_MS)
  }

  if (!match) {
    return (
      <code className="bg-secondary px-1.5 py-0.5 rounded text-[0.85em] font-mono text-primary" {...props}>
        {children}
      </code>
    )
  }

  return (
    <div className="relative group rounded-md bg-secondary/80 my-2 shadow-sm border border-border/50">
      <div className="flex items-center justify-between px-3 py-1.5 bg-secondary border-b border-border text-xs text-muted-foreground rounded-t-md">
        <span className="font-mono">{match[1]}</span>
        <button
          onClick={handleCopyCode}
          className="flex items-center gap-1.5 hover:text-foreground transition-colors"
          aria-label={t('chat.tooltips.copy_code')}
        >
          {codeCopied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
          {codeCopied ? t('chat.tooltips.copied') : t('chat.tooltips.copy')}
        </button>
      </div>
      <div className="p-3 overflow-x-auto">
        <code className={className} {...props}>
          {children}
        </code>
      </div>
    </div>
  )
}

const ChatMessage = ({ message, onEdit, isPending, onRetry }) => {
  const { t } = useTranslation()
  const isBot = message.role === 'model'
  const [copied, setCopied] = useState(false)
  const sources = Array.isArray(message.sources) ? message.sources : []

  const handleCopyMessage = () => {
    const text = message.content || ''
    navigator.clipboard.writeText(text)
    setCopied(true)
    toast.success(t('chat.tooltips.copied'))
    setTimeout(() => setCopied(false), COPY_TIMEOUT_MS)
  }

  return (
    <div className={`group flex gap-2.5 px-4 py-2.5 ${isBot ? 'bg-muted/50 rounded-lg' : ''} relative`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${isBot ? 'bg-primary/10 text-primary' : 'bg-secondary text-secondary-foreground'}`}>
        {isBot ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
      </div>
      <div className="flex-1 min-w-0 flex flex-col space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-muted-foreground">
            {isBot ? t('chat.gemini') : t('chat.you')}
          </span>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            {isBot && message.content && (
              <button onClick={handleCopyMessage}
                title={t('chat.tooltips.copy')}
                aria-label={t('chat.tooltips.copy')}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            )}
            {!isBot && message.content && (
              <>
                <button onClick={() => onRetry?.(message)}
                  title={t('chat.tooltips.retry')}
                  aria-label={t('chat.tooltips.retry')}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => onEdit?.(message.content)}
                  title={t('chat.tooltips.edit')}
                  aria-label={t('chat.tooltips.edit')}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        </div>

        {isBot && isPending && !message.content ? (
          <div className="space-y-1.5 min-h-[28px] pt-0.5">
            <div className="h-2.5 bg-muted-foreground/15 rounded w-3/4" />
            <div className="h-2.5 bg-muted-foreground/15 rounded w-1/2" />
            <span className="text-[11px] text-muted-foreground">{t('chat.status.thinking')}</span>
          </div>
        ) : (
          <div className="prose prose-sm dark:prose-invert prose-p:leading-relaxed prose-pre:bg-secondary prose-pre:p-0 w-full overflow-hidden break-words text-sm text-foreground">
            {isBot && isPending ? (
              <div className="whitespace-pre-wrap">
                {message.content}
              </div>
            ) : isBot ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSanitize]}
                components={{
                  code({ inline, className, children, ...props }) {
                    if (!inline && className) {
                      return <CodeBlock className={className} {...props}>{children}</CodeBlock>
                    }
                    return (
                      <code className="bg-secondary px-1.5 py-0.5 rounded text-[0.85em] font-mono text-primary" {...props}>
                        {children}
                      </code>
                    )
                  }
                }}
              >
                {message.content}
              </ReactMarkdown>
            ) : (
              <div className="whitespace-pre-wrap flex flex-col gap-2">
                <span>{message.content}</span>
                {message.attachments && message.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {message.attachments.map((att, idx) => (
                      <div key={idx} className="flex items-center gap-1 bg-secondary/50 px-2 py-1 rounded text-xs border border-border">
                        {att.mimeType.startsWith('image/') ? <ImageIcon className="w-3 h-3" /> : <FileText className="w-3 h-3" />}
                        <span className="truncate max-w-[120px]">{att.name || t('chat.attachment')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {isBot && message.status === 'cancelled' && (
          <span className="text-[11px] text-muted-foreground">{t('chat.status.cancelled')}</span>
        )}

        {isBot && message.status === 'error' && (
          <span className="text-[11px] text-destructive">{t('chat.status.error')}</span>
        )}

        {isBot && sources.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold text-muted-foreground">{t('chat.sources_label')}</span>
            <div className="flex flex-col gap-1.5">
              {sources.map((source) => (
                <a
                  key={`${source.index}-${source.url}`}
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-xs text-foreground no-underline hover:bg-secondary"
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                    {source.index}
                  </span>
                  <span className="truncate">{source.title || source.url}</span>
                </a>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
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
