const PREVIOUS_IMAGE_PATTERN = /(?:^|\s)(?:önceki|önceden gönderdiğim|eski|ilk|previous|earlier|old|first)\s+(?:ekli\s+)?(?:görsel|resim|fotoğraf|foto|image|picture|photo)/i
const PREVIOUS_WEB_PATTERN = /(?:^|\s)(?:önceki|önceden gönderdiğim|eski|ilk|previous|earlier|old|first)\s+(?:web\s+)?(?:link|bağlantı|url|sayfa|page)/i

// In Turkish 'İ' (U+0130) does not match 'i' with the /i flag; we lower the
// text with the Turkish locale and search the patterns in lowercase.
function normalizeForMatch(text) {
  return (typeof text === 'string' ? text : '').toLocaleLowerCase('tr')
}

export function requestsPreviousImage(text) {
  return PREVIOUS_IMAGE_PATTERN.test(normalizeForMatch(text))
}

export function requestsPreviousWebSource(text) {
  return PREVIOUS_WEB_PATTERN.test(normalizeForMatch(text))
}

export function selectRequestContext({
  text = '',
  draftAttachments = [],
  previousAttachments = [],
  explicitUrls = [],
  previousUrls = [],
  includePreviousWeb = false,
}) {
  const attachments = requestsPreviousImage(text)
    ? [...previousAttachments, ...draftAttachments]
    : [...draftAttachments]
  const urls = includePreviousWeb && requestsPreviousWebSource(text)
    ? Array.from(new Set([...previousUrls, ...explicitUrls].filter(Boolean)))
    : [...explicitUrls]

  return { attachments, urls }
}
