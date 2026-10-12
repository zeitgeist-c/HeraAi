import { memo, useEffect, useId, useRef, useState } from 'react'
import { Bot, Check, ChevronDown, Copy, FileText, Globe, Image as ImageIcon, Pencil, RefreshCw } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { useTranslation } from 'react-i18next'
import { notifyError, notifySuccess } from '../lib/notify'

import { getMessageDisplayContent } from '../lib/messageDisplay'
import ResponseDuration from './ResponseDuration'
import { GalleryLightbox } from './ImageLightbox'

const COPY_TIMEOUT_MS = 2000
const RETRY_MENU_ESTIMATED_HEIGHT_PX = 226
// Kullanıcı mesajı bu yükseklikten sonra kısaltılır: 12 satır × leading-relaxed
// (1.625 × 14px) ≈ 273px. Kısa mesajda ölçüm taşma bulmaz, düğme hiç çıkmaz.
const USER_MESSAGE_MAX_HEIGHT_PX = 273

async function copyText(text, { onSuccess, successMessage, errorMessage }) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable')
    await navigator.clipboard.writeText(text)
    onSuccess()
    notifySuccess(successMessage)
  } catch (error) {
    console.error('Clipboard copy failed', error)
    notifyError(errorMessage)
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
  showSources = false,
  searchMatch = false,
  searchCurrent = false,
  concealMeta = false,
}) => {
  const { t } = useTranslation()
  const isBot = message.role === 'model'
  const visibleContent = getMessageDisplayContent(message)
  // content her zaman dizge olmayabilir (bozuk içe aktarma, eşitlenen eski sürüm
  // kaydı, elle düzenlenmiş depo). ReactMarkdown dizge olmayan children'da
  // fırlatır ve tüm panel ErrorBoundary'ye düşerdi.
  const contentText = typeof message.content === 'string' ? message.content : ''
  const [copied, setCopied] = useState(false)
  const [retryMenuOpen, setRetryMenuOpen] = useState(false)
  const [retryMenuPlacement, setRetryMenuPlacement] = useState('up')
  // Kullanıcı mesajı kısaltma: yalnız görünüm — gönderilen/kaydedilen metin aynı kalır.
  // Elle seçim yoksa arama sonucu gelen mesaj açık kabul edilir (eşleşme gizli kalmasın).
  // Mesaj kimliği ebeveynin key'inde olduğundan başka mesaja geçince durum kendiliğinden sıfırlanır.
  const [userManualChoice, setUserManualChoice] = useState(null)
  const [userCollapsible, setUserCollapsible] = useState(false)
  const [previewIndex, setPreviewIndex] = useState(null)
  const userBodyRef = useRef(null)
  const userOpen = userManualChoice ?? searchCurrent
  const retryMenuId = useId()
  const retryMenuRef = useRef(null)
  const retryTriggerRef = useRef(null)
  const sources = Array.isArray(message.sources) ? message.sources : []
  const messageAttachments = Array.isArray(message.attachments) ? message.attachments : []
  const displayedAttachments = Array.isArray(message.displayAttachmentIds)
    ? messageAttachments.filter(attachment => message.displayAttachmentIds.includes(attachment?.id))
    : messageAttachments
  const displayedWebUrls = Array.isArray(message.displayWebUrls)
    ? message.displayWebUrls
    : (Array.isArray(message.webUrls) ? message.webUrls : [])
  const previewImages = displayedAttachments
    .map((attachment, displayedIndex) => ({ attachment, displayedIndex }))
    .filter(({ attachment }) => attachment?.mimeType?.startsWith('image/') && (attachment?.data || attachment?.id))
  const previewPositionOf = (displayedIndex) => previewImages.findIndex((entry) => entry.displayedIndex === displayedIndex)
  const isPending = message.status === 'thinking' || message.status === 'streaming'
  const availableRetryModels = Array.isArray(retryModels)
    ? retryModels.map(model => typeof model === 'string'
        ? { key: model, modelId: model, label: modelLabels[model] || model }
        : model)
    : []
  const hasRetryModelChoices = availableRetryModels.length > 0
  const concreteModelLabel = typeof message.model === 'string' && message.model
    ? (modelLabels[message.model] || message.model)
    : ''
  const requestedModelLabel = message.selectionMode === 'auto'
    ? `${t('chat.auto.label')} → ${concreteModelLabel}`
    : concreteModelLabel
  const usedModelLabel = message.resolvedModel && message.resolvedModel !== message.model
    ? `${requestedModelLabel || message.model} → ${modelLabels[message.resolvedModel] || message.resolvedModel}`
    : requestedModelLabel
  const autoRouteLabels = message.selectionMode === 'auto'
    ? [message.routerModel, message.resolvedModel]
      .filter((modelId, index, list) => (
        typeof modelId === 'string' && modelId && list.indexOf(modelId) === index
      ))
      .map(modelId => modelLabels[modelId] || modelId)
    : []
  const autoChainLabel = autoRouteLabels.length > 0
    ? `${t('chat.auto.label')} → ${autoRouteLabels.join(' → ')}`
    : ''
  const isContextExcluded = message.contextExcluded === true
  const errorMessage = message.errorCode
    ? t(`chat.generation_errors.${message.errorCode}`, { defaultValue: t('chat.status.error') })
    : t('chat.status.error')

  const handleCopyMessage = () => {
    copyText(visibleContent, {
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

  useEffect(() => {
    if (isBot || !visibleContent) return undefined
    const node = userBodyRef.current
    if (!node) return undefined

    const measure = () => {
      if (userOpen) return
      setUserCollapsible(node.scrollHeight > node.clientHeight + 1)
    }
    measure()

    const ResizeObserverClass = globalThis.ResizeObserver
    if (typeof ResizeObserverClass !== 'function') return undefined
    const observer = new ResizeObserverClass(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [isBot, visibleContent, userOpen])

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

  const renderRetryButton = () => (
    <button
      ref={retryTriggerRef}
      type="button"
      onClick={handleRetryTrigger}
      title={hasRetryModelChoices ? t('chat.retry_model.title') : t('chat.tooltips.retry')}
      aria-label={hasRetryModelChoices ? t('chat.retry_model.title') : t('chat.tooltips.retry')}
      aria-haspopup={hasRetryModelChoices ? 'dialog' : undefined}
      aria-expanded={hasRetryModelChoices ? retryMenuOpen : undefined}
      aria-controls={hasRetryModelChoices ? retryMenuId : undefined}
      className={`hera-icon-button relative h-7 w-7 ${
        retryMenuOpen ? 'bg-primary/10 text-primary' : ''
      }`}
      disabled={retryDisabled || isPending}
    >
      <RefreshCw className="h-3.5 w-3.5" />
      {hasRetryModelChoices && (
        <ChevronDown className="absolute bottom-0.5 right-0.5 h-2 w-2 opacity-65" />
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
            const modelId = model.modelId
            const isCurrentModel = modelId === currentModel
            const rowLabel = model.label || modelLabels[modelId] || modelId
            const showProvider = Boolean(model.provider)
            return (
              <button
                key={model.key || modelId}
                type="button"
                data-retry-model={modelId}
                data-current-model={isCurrentModel ? 'true' : undefined}
                onClick={() => handleRetryWithModel(modelId)}
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
                  {rowLabel}
                </span>
                {showProvider && (
                  <span aria-hidden="true" className="shrink-0 text-[10px] text-muted-foreground">
                    {t(`chat.model_providers.${model.provider}`)}
                  </span>
                )}
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
      <article
        data-testid="user-message"
        {...(message.id ? { id: `chat-msg-${message.id}` } : {})}
        {...(searchMatch ? { 'data-search-match': 'true' } : {})}
        {...(searchCurrent ? { 'data-search-current': 'true' } : {})}
        className="group flex w-full justify-end"
      >
        <div className={`max-w-[88%] rounded-2xl rounded-br-md border border-primary/10 bg-primary/[0.09] px-3.5 py-2.5 shadow-sm${searchCurrent ? ' ring-2 ring-primary/70' : searchMatch ? ' ring-1 ring-primary/30' : ''}`}>
          {visibleContent && (
            <div
              ref={userBodyRef}
              data-testid="user-message-body"
              className={`relative${userOpen ? '' : ' max-h-[273px] overflow-hidden'}`}
            >
              <div className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-foreground">
                {visibleContent}
              </div>
              {userCollapsible && !userOpen && (
                <div
                  aria-hidden="true"
                  data-testid="user-message-fade"
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-[74px]"
                  style={{ background: 'linear-gradient(to bottom, hsl(var(--primary) / 0), hsl(var(--primary) / 0.09))' }}
                />
              )}
            </div>
          )}

          {userCollapsible && (
            <button
              type="button"
              onClick={() => setUserManualChoice(!userOpen)}
              aria-expanded={userOpen}
              data-testid="user-message-toggle"
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-primary/25 bg-primary/[0.07] px-2.5 py-1.5 text-[12px] font-semibold text-primary transition-colors hover:bg-primary/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
            >
              <span>{userOpen ? t('chat.show_less_message') : t('chat.show_full_message')}</span>
              <ChevronDown className={`h-3.5 w-3.5 transition-transform${userOpen ? ' rotate-180' : ''}`} />
            </button>
          )}

          {(displayedAttachments.length > 0 || displayedWebUrls.length > 0) && (
            <div className={`${visibleContent ? 'mt-2 ' : ''}flex flex-wrap gap-1.5`}>
              {displayedAttachments.map((attachment, index) => {
                const previewPosition = previewPositionOf(index)
                const chipClassName = 'flex min-w-0 items-center gap-1.5 rounded-lg border border-border/70 bg-background/55 px-2 py-1 text-[11px] text-muted-foreground'
                const chipBody = (
                  <>
                    {attachment.mimeType?.startsWith('image/')
                      ? <ImageIcon className="h-3 w-3 shrink-0" />
                      : <FileText className="h-3 w-3 shrink-0" />}
                    <span className="max-w-[150px] truncate">{attachment.name || t('chat.attachment')}</span>
                    {attachment.availability && attachment.availability !== 'ready' && (
                      <span className="text-destructive">{t('chat.attachment_unavailable')}</span>
                    )}
                  </>
                )
                return previewPosition < 0 ? (
                  <div
                    key={`${attachment.name || 'attachment'}-${index}`}
                    className={chipClassName}
                  >
                    {chipBody}
                  </div>
                ) : (
                  <button
                    key={`${attachment.name || 'attachment'}-${index}`}
                    type="button"
                    onClick={() => setPreviewIndex(previewPosition)}
                    title={attachment.name}
                    className={`${chipClassName} cursor-pointer transition-colors hover:border-primary/35 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45`}
                  >
                    {chipBody}
                  </button>
                )
              })}
              {displayedWebUrls.map(url => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-w-0 items-center gap-1.5 rounded-lg border border-primary/20 bg-background/55 px-2 py-1 text-[11px] text-muted-foreground no-underline hover:border-primary/35 hover:text-foreground"
                >
                  <Globe className="h-3 w-3 shrink-0 text-primary" />
                  <span className="max-w-[180px] truncate">{url}</span>
                </a>
              ))}
            </div>
          )}

          {(visibleContent || displayedAttachments.length > 0 || displayedWebUrls.length > 0) && (
            <div className="relative mt-1.5 flex flex-col items-end gap-1.5">
              <div className="flex justify-end gap-0.5">
                {visibleContent && (
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
                {visibleContent && (
                  <button
                    type="button"
                    onClick={() => onEdit?.(visibleContent)}
                    title={t('chat.tooltips.edit')}
                    aria-label={t('chat.tooltips.edit')}
                    className="hera-icon-button h-7 w-7"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        {previewIndex !== null && previewImages.length > 0 && (
          <GalleryLightbox
            images={previewImages}
            index={Math.min(previewIndex, previewImages.length - 1)}
            onIndex={setPreviewIndex}
            onClose={() => setPreviewIndex(null)}
          />
        )}
      </article>
    )
  }

  return (
    <article
      data-testid="assistant-message"
      {...(message.id ? { id: `chat-msg-${message.id}` } : {})}
      {...(searchMatch ? { 'data-search-match': 'true' } : {})}
      {...(searchCurrent ? { 'data-search-current': 'true' } : {})}
      {...(isContextExcluded ? { 'data-context-excluded': 'true' } : {})}
      className={`group w-full min-w-0 py-1${searchCurrent ? ' rounded-xl ring-2 ring-primary/70' : searchMatch ? ' rounded-xl ring-1 ring-primary/30' : ''}${isContextExcluded ? ' opacity-60' : ''}`}
    >
      {isPending && !contentText ? (
        <div className="min-h-16 space-y-2 rounded-xl py-2">
          <div className="h-2.5 w-3/4 animate-pulse rounded-full bg-muted-foreground/15" />
          <div className="h-2.5 w-1/2 animate-pulse rounded-full bg-muted-foreground/15" />
          <span className="block pt-1 text-[11px] text-muted-foreground">
            {t(message.selectionMode === 'auto' ? 'chat.status.selecting_model' : 'chat.status.thinking')}
          </span>
        </div>
      ) : (
        <div data-testid="assistant-content" className="prose prose-sm max-w-none break-words text-[14px] leading-relaxed text-foreground dark:prose-invert prose-headings:mb-2 prose-headings:mt-4 prose-headings:font-semibold prose-p:my-2 prose-p:whitespace-pre-wrap prose-p:leading-[1.65] prose-li:my-0.5 prose-a:text-primary prose-pre:m-0 prose-pre:bg-transparent prose-pre:p-0 prose-table:block prose-table:max-w-full prose-table:overflow-x-auto">
          {isPending ? (
            <div className="whitespace-pre-wrap">{contentText}</div>
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
              {contentText}
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

      {showSources && sources.length > 0 && (
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
        <div className="relative mt-1.5 border-t border-border/45 pt-1.5">
          <div
            data-testid="response-action-pill"
            className="inline-flex max-w-full items-center gap-0.5 rounded-full border border-border/60 bg-background/40 py-0.5 pl-1 pr-2"
          >
            <button
              type="button"
              onClick={handleCopyMessage}
              title={t('chat.tooltips.copy')}
              aria-label={t('chat.tooltips.copy')}
              className="hera-icon-button h-7 w-7"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            {!concealMeta && renderRetryButton()}
            {(usedModelLabel || message.startedAt != null) && (
              <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border/70" />
            )}
            <ResponseDuration message={message} />
            {usedModelLabel && (
              <span
                data-testid="message-model"
                className="inline-flex min-h-6 min-w-0 max-w-full items-center gap-1 rounded-full border border-primary/25 bg-primary/[0.06] px-2 py-0.5 text-[10px] font-medium text-foreground"
                title={`${t('chat.model_used')}: ${usedModelLabel}`}
              >
                <Bot className="h-3 w-3 shrink-0 text-primary" />
                <span className="truncate">{usedModelLabel}</span>
              </span>
            )}
          </div>
          {autoChainLabel && (
            <span
              data-testid="auto-chain"
              className="mt-1 block max-w-full truncate text-left text-[10px] font-medium text-muted-foreground/70"
              title={`${t('chat.model_used')}: ${autoChainLabel}`}
            >
              {autoChainLabel}
            </span>
          )}
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
    prevMessage.displayContent === nextMessage.displayContent &&
    prevMessage.model === nextMessage.model &&
    prevMessage.resolvedModel === nextMessage.resolvedModel &&
    prevMessage.selectionMode === nextMessage.selectionMode &&
    prevMessage.selectionReasonCode === nextMessage.selectionReasonCode &&
    prevMessage.routerModel === nextMessage.routerModel &&
    prevMessage.contextExcluded === nextMessage.contextExcluded &&
    prevMessage.startedAt === nextMessage.startedAt &&
    prevMessage.completedAt === nextMessage.completedAt &&
    prevMessage.status === nextMessage.status &&
    prevMessage.sources === nextMessage.sources &&
    prevMessage.attachments === nextMessage.attachments &&
    prevMessage.displayAttachmentIds === nextMessage.displayAttachmentIds &&
    prevMessage.webUrls === nextMessage.webUrls &&
    prevMessage.displayWebUrls === nextMessage.displayWebUrls &&
    prevProps.currentModel === nextProps.currentModel &&
    prevProps.retryDisabled === nextProps.retryDisabled &&
    prevProps.showSources === nextProps.showSources &&
    prevProps.retryModels === nextProps.retryModels &&
    prevProps.modelLabels === nextProps.modelLabels &&
    prevProps.onEdit === nextProps.onEdit &&
    prevProps.onRetry === nextProps.onRetry &&
    prevProps.concealMeta === nextProps.concealMeta &&
    prevProps.searchMatch === nextProps.searchMatch &&
    prevProps.searchCurrent === nextProps.searchCurrent
  )
}

export default memo(ChatMessage, areMessagesEqual)
