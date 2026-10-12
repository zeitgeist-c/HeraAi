import { useEffect, useState } from 'react'

import { getAttachment } from './attachmentStore'

function resolveInlineSrc(attachment) {
  if (!attachment) return null
  if (attachment.data) return `data:${attachment.mimeType || 'image/png'};base64,${attachment.data}`
  return null
}

/**
 * Ekin görüntü adresini çözer: satır içi veri varsa anında, yalnız kimlik
 * varsa IndexedDB'den okuyup nesne adresi üretir.
 */
export function useAttachmentSrc(attachment) {
  const [state, setState] = useState({ url: null, missing: false })
  const inlineSrc = resolveInlineSrc(attachment)
  useEffect(() => {
    if (inlineSrc || !attachment?.id) return undefined
    let cancelled = false
    let url = null
    void getAttachment(attachment.id)
      .then((record) => {
        if (cancelled) return
        if (!record?.blob) {
          setState({ url: null, missing: true })
          return
        }
        url = URL.createObjectURL(record.blob)
        if (!cancelled) setState({ url, missing: false })
        else URL.revokeObjectURL(url)
      })
      .catch(() => {
        if (!cancelled) setState({ url: null, missing: true })
      })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [inlineSrc, attachment?.id])
  return { src: inlineSrc || state.url, missing: !inlineSrc && state.missing }
}
