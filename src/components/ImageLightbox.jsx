import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, FileText, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAttachmentSrc } from '../lib/useAttachmentSrc'

export function GalleryLightbox({ images, index, onIndex, onClose }) {
  const { t } = useTranslation()
  const current = images?.[index]
  const { src, missing } = useAttachmentSrc(current?.attachment)

  useEffect(() => {
    const last = (images?.length || 1) - 1
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.()
      else if (event.key === 'ArrowLeft') onIndex?.(Math.max(0, index - 1))
      else if (event.key === 'ArrowRight') onIndex?.(Math.min(last, index + 1))
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [index, images, onIndex, onClose])

  if (!current) return null
  const prevDisabled = index <= 0
  const nextDisabled = index >= (images?.length || 1) - 1
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={() => onClose?.()}
      role="dialog"
      aria-modal="true"
      aria-label={current?.attachment?.name || 'preview'}
      data-testid="image-lightbox"
    >
      <button
        type="button"
        onClick={() => onClose?.()}
        aria-label={t('chat.close')}
        className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        <X className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onIndex?.(index - 1)
        }}
        disabled={prevDisabled}
        aria-label={t('chat.lightbox_previous')}
        data-testid="gallery-prev"
        className="absolute left-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/25 disabled:opacity-30 disabled:hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      {src ? (
        <img
          src={src}
          alt={current?.attachment?.name || ''}
          data-testid="image-lightbox-img"
          onClick={(event) => event.stopPropagation()}
          className="max-h-[85vh] max-w-full rounded-lg object-contain shadow-2xl"
        />
      ) : missing ? (
        <div data-testid="image-lightbox-missing" className="rounded-lg bg-white/10 px-4 py-3 text-[13px] text-white">
          {t('chat.attachment_missing')}
        </div>
      ) : (
        <div data-testid="image-lightbox-loading" className="h-40 w-40 animate-pulse rounded-lg bg-white/10" />
      )}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onIndex?.(index + 1)
        }}
        disabled={nextDisabled}
        aria-label={t('chat.lightbox_next')}
        data-testid="gallery-next"
        className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/25 disabled:opacity-30 disabled:hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        <ChevronRight className="h-5 w-5" />
      </button>
      <span data-testid="gallery-counter" className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-2.5 py-0.5 text-[12px] text-white">
        {`${index + 1} / ${images?.length || 0}`}
      </span>
    </div>
  )
}

function FileChip({ attachment, onRemove }) {
  const { t } = useTranslation()
  return (
    <div className="group relative flex max-w-[170px] shrink-0 items-center gap-2 rounded-lg border border-border/70 bg-secondary/65 py-1 pl-1 pr-7">
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-background/70">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
      <span className="truncate text-[11px]">{attachment?.name}</span>
      {attachment?.availability && attachment.availability !== 'ready' && (
        <span className="text-[10px] text-destructive">{t('chat.attachment_unavailable')}</span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('chat.tooltips.remove_attachment')}
        className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

function ImageThumb({ attachment, onOpen }) {
  const { src } = useAttachmentSrc(attachment)
  return (
    <button
      type="button"
      onClick={() => src && onOpen?.()}
      title={attachment?.name}
      aria-label={attachment?.name}
      disabled={!src}
      className="block h-14 w-14 overflow-hidden rounded-lg border border-border/70 bg-secondary/65 transition-colors enabled:hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:cursor-wait"
    >
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="block h-full w-full animate-pulse bg-secondary" />
      )}
    </button>
  )
}

function StripItem({ attachment, draftIndex, imagePosition, removeLabel, onOpenImage, onRemove }) {
  if (imagePosition < 0) {
    return (
      <FileChip
        attachment={attachment}
        onRemove={() => onRemove?.(draftIndex)}
      />
    )
  }
  return (
    <div className="group relative shrink-0">
      <ImageThumb attachment={attachment} onOpen={() => onOpenImage?.(imagePosition)} />
      <button
        type="button"
        onClick={() => onRemove?.(draftIndex)}
        aria-label={removeLabel}
        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground shadow transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

/**
 * Draft strip: images are square thumbnails (unnamed) that open the arrow-key gallery on click;
 * other files are name chips. Removal comes from the top.
 */
export function AttachmentGallery({ attachments, onRemove }) {
  const { t } = useTranslation()
  const items = Array.isArray(attachments) ? attachments : []
  const images = items
    .map((attachment, draftIndex) => ({ attachment, draftIndex }))
    .filter(({ attachment }) => attachment?.mimeType?.startsWith('image/') && (attachment?.data || attachment?.id))
  const [openIndex, setOpenIndex] = useState(null)

  const closeGallery = useCallback(() => setOpenIndex(null), [])
  const goGallery = useCallback((nextIndex) => {
    setOpenIndex((current) => {
      const target = typeof nextIndex === 'number' ? nextIndex : current
      if (target === null || target === undefined) return current
      return Math.max(0, Math.min(images.length - 1, target))
    })
  }, [images.length])
  const removeLabel = t('chat.tooltips.remove_attachment')

  return (
    <div className="flex gap-1.5 overflow-x-auto border-b border-border/60 px-3 py-2">
      {items.map((attachment, draftIndex) => (
        <StripItem
          key={`${attachment?.name || 'file'}-${draftIndex}`}
          attachment={attachment}
          draftIndex={draftIndex}
          imagePosition={images.findIndex((entry) => entry.draftIndex === draftIndex)}
          removeLabel={removeLabel}
          onOpenImage={setOpenIndex}
          onRemove={onRemove}
        />
      ))}
      {openIndex !== null && images.length > 0 && (
        <GalleryLightbox
          images={images}
          index={Math.min(openIndex, images.length - 1)}
          onIndex={goGallery}
          onClose={closeGallery}
        />
      )}
    </div>
  )
}
