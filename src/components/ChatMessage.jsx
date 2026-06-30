import { memo, useState } from 'react'
import { Bot, User, Copy, Check, Image as ImageIcon, FileText, Pencil } from 'lucide-react'
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

const ChatMessage = memo(({ message, onEdit, isPending, onCancel }) => {
  const { t } = useTranslation()
  const isBot = message.role === 'model'
  const [copied, setCopied] = useState(false)

  const handleCopyMessage = () => {
    const text = message.content || ''
    navigator.clipboard.writeText(text)
    setCopied(true)
    toast.success(t('chat.tooltips.copied'))
    setTimeout(() => setCopied(false), COPY_TIMEOUT_MS)
  }

  return (
    <div className={`group flex gap-3 p-4 ${isBot ? 'bg-muted/50 rounded-lg' : ''} relative`}>
      <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${isBot ? 'bg-primary/10 text-primary' : 'bg-secondary text-secondary-foreground'}`}>
        {isBot ? <Bot className="w-5 h-5" /> : <User className="w-5 h-5" />}
      </div>
      <div className="flex-1 min-w-0 flex flex-col pt-1 space-y-2">
        <span className="text-xs font-semibold text-muted-foreground">
          {isBot ? t('chat.gemini') : t('chat.you')}
        </span>

        {isBot && isPending && !message.content ? (
          <div className="flex flex-col gap-3 min-h-[72px]">
            <div className="space-y-2">
              <div className="h-3 bg-muted-foreground/15 rounded w-3/4 animate-pulse" />
              <div className="h-3 bg-muted-foreground/15 rounded w-1/2 animate-pulse" />
            </div>
            {onCancel && (
              <div className="flex justify-end">
                <button
                  onClick={onCancel}
                  className="px-2.5 py-1 text-xs bg-destructive/15 text-destructive rounded-md hover:bg-destructive/25 transition-colors"
                >
                  {t('chat.tooltips.stop_recording')}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="prose prose-sm dark:prose-invert prose-p:leading-relaxed prose-pre:bg-secondary prose-pre:p-0 w-full overflow-hidden break-words text-sm text-foreground">
            {isBot ? (
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

        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity pt-1">
          <button
            onClick={handleCopyMessage}
            title={t('chat.tooltips.copy')}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground bg-secondary/60 hover:bg-secondary border border-border/50 rounded-md px-2 py-1 transition-all"
          >
            {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
            {copied ? t('chat.tooltips.copied') : t('chat.tooltips.copy')}
          </button>
          {!isBot && message.content && (
            <button
              onClick={() => onEdit && onEdit(message.content)}
              title={t('chat.tooltips.edit')}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary bg-secondary/60 hover:bg-primary/10 border border-border/50 rounded-md px-2 py-1 transition-all"
            >
              <Pencil className="w-3 h-3" />
              {t('chat.tooltips.edit')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
})

export default ChatMessage
