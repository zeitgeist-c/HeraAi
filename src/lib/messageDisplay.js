const LEGACY_OCR_PROMPTS = new Set([
  'Ekli görsel veya görsellerde yalnızca görünen metni yaz. Açıklama, özet, çeviri, yorum veya görselde görünmeyen hiçbir metin ekleme. Başlıkları, paragrafları, listeleri, satır sırasını ve okuma düzenini mümkün olduğunca koru. Okunamayan her bölümü [okunamadı] olarak belirt. Birden fazla görsel varsa ek sırasına göre işle ve sonuçları Görsel 1, Görsel 2 ve devam eden başlıklarla ayır.',
  'Extract only the visible text from the attached image or images. Do not add explanations, summaries, translations, interpretations, or any text that is not visible. Preserve headings, paragraphs, lists, line order, and reading order as closely as possible. Mark every unreadable section as [unreadable]. If there is more than one image, process them in attachment order and separate the results with the headings Image 1, Image 2, and so on.',
])

export function isLegacyOcrPromptMessage(message) {
  if (!message || message.role !== 'user') return false
  if (!Array.isArray(message.attachments) || !message.attachments.some(attachment => (
    attachment?.mimeType?.startsWith('image/')
  ))) return false

  const content = typeof message.content === 'string' ? message.content.trim() : ''
  return LEGACY_OCR_PROMPTS.has(content)
}

export function getMessageDisplayContent(message) {
  if (typeof message?.displayContent === 'string') return message.displayContent
  if (isLegacyOcrPromptMessage(message)) return ''
  return typeof message?.content === 'string' ? message.content : ''
}

export function getAutoMessageTitle(content, maxLength = 30) {
  if (typeof content !== 'string' || !content) return ''
  return content.length > maxLength ? `${content.slice(0, maxLength)}...` : content
}

export function isHiddenPromptAutoTitle(title, messages, maxLength = 30) {
  if (typeof title !== 'string' || !title) return false
  return (messages || []).some(message => (
    message?.role === 'user'
    && typeof message.content === 'string'
    && message.content
    && getMessageDisplayContent(message) === ''
    && getAutoMessageTitle(message.content, maxLength) === title
  ))
}
