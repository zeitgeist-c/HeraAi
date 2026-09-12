export const MAX_ATTACHMENT_FILE_SIZE = 20 * 1024 * 1024
export const MAX_ATTACHMENT_GROUP_SIZE = 30 * 1024 * 1024
export const MAX_ATTACHMENT_COUNT = 10
export const MAX_EXTRACTED_TEXT_CHARS = 1_000_000

const MIME_BY_EXTENSION = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
})

const TEXT_MIME_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'application/json',
  'application/xml', 'text/xml', 'text/html',
])

const BINARY_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
])

export class AttachmentValidationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AttachmentValidationError'
    this.code = code
  }
}

function extensionOf(name = '') {
  return String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || ''
}

function bytesStartWith(bytes, signature) {
  return signature.every((value, index) => bytes[index] === value)
}

function bytesContainSignature(bytes, signature, maxStartIndex) {
  const lastStartIndex = Math.min(maxStartIndex, bytes.length - signature.length)
  for (let startIndex = 0; startIndex <= lastStartIndex; startIndex += 1) {
    if (signature.every((value, offset) => bytes[startIndex + offset] === value)) return true
  }
  return false
}

function hasValidSignature(bytes, mimeType) {
  if (mimeType === 'image/png') return bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (mimeType === 'image/jpeg') return bytesStartWith(bytes, [0xff, 0xd8, 0xff])
  if (mimeType === 'image/webp') {
    return bytesStartWith(bytes, [0x52, 0x49, 0x46, 0x46])
      && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  }
  if (mimeType === 'application/pdf') {
    return bytesContainSignature(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d], 1023)
  }
  if (mimeType.includes('wordprocessingml.document')) {
    return bytesStartWith(bytes, [0x50, 0x4b, 0x03, 0x04])
      || bytesStartWith(bytes, [0x50, 0x4b, 0x05, 0x06])
      || bytesStartWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  }
  if (mimeType.includes('spreadsheetml.sheet')) {
    return bytesStartWith(bytes, [0x50, 0x4b, 0x03, 0x04])
      || bytesStartWith(bytes, [0x50, 0x4b, 0x05, 0x06])
      || bytesStartWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  }
  if (mimeType === 'application/vnd.ms-excel') {
    return bytesStartWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  }
  return true
}

function normalizeDeclaredMime(type = '') {
  return String(type).split(';')[0].trim().toLowerCase()
}

export function resolveAttachmentType(file) {
  const extension = extensionOf(file?.name)
  if (extension === 'doc') {
    throw new AttachmentValidationError('attachment_unsupported', 'Legacy .doc files are not supported. Save the document as .docx.')
  }
  const extensionMime = MIME_BY_EXTENSION[extension]
  if (!extensionMime) throw new AttachmentValidationError('attachment_unsupported', 'Unsupported file type.')

  // Browser-provided MIME values are registry/OS dependent. A .pdf file is
  // canonicalized only after its actual header is verified below.
  if (extensionMime === 'application/pdf') return extensionMime

  const declaredMime = normalizeDeclaredMime(file?.type)
  const isGenericMime = !declaredMime || declaredMime === 'application/octet-stream'
  const declaredMatches = declaredMime === extensionMime
    || (extensionMime === 'application/xml' && declaredMime === 'text/xml')
    || (extensionMime === 'text/html' && declaredMime === 'application/xhtml+xml')
  if (!isGenericMime && !declaredMatches) {
    throw new AttachmentValidationError('attachment_type_mismatch', 'The file extension and MIME type do not match.')
  }
  return extensionMime
}

function decodeUtf8(buffer) {
  try {
    const bytes = new Uint8Array(buffer)
    if (bytes.includes(0)) throw new Error('Binary content')
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '')
  } catch {
    throw new AttachmentValidationError('attachment_invalid', 'The text file is not valid UTF-8.')
  }
}

function normalizePlainText(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim()
}

async function structuredHtmlText(html) {
  let sanitized
  if (typeof window !== 'undefined') {
    const module = await import('dompurify')
    const purifier = typeof module.default?.sanitize === 'function'
      ? module.default
      : module.default(window)
    sanitized = purifier.sanitize(html, {
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'img'],
        FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload'],
      })
  } else {
    sanitized = String(html)
      .replace(/<(script|style|iframe|object|embed|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<img\b[^>]*>/gi, '')
  }
  if (typeof DOMParser === 'undefined') return normalizePlainText(sanitized.replace(/<[^>]+>/g, ' '))

  const documentNode = new DOMParser().parseFromString(sanitized, 'text/html')
  const blocks = []
  const visit = node => {
    if (node.nodeType === 3) return node.textContent || ''
    if (node.nodeType !== 1) return ''
    const tag = node.tagName.toLowerCase()
    if (['script', 'style', 'img', 'svg'].includes(tag)) return ''
    const childText = Array.from(node.childNodes).map(visit).join(' ').replace(/\s+/g, ' ').trim()
    if (!childText) return ''
    if (/^h[1-6]$/.test(tag)) {
      blocks.push(`${'#'.repeat(Number(tag[1]))} ${childText}`)
      return ''
    }
    if (tag === 'li') {
      blocks.push(`- ${childText}`)
      return ''
    }
    if (tag === 'tr') {
      const cells = Array.from(node.children)
        .filter(child => ['td', 'th'].includes(child.tagName.toLowerCase()))
        .map(child => child.textContent.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
      if (cells.length) blocks.push(cells.join(' | '))
      return ''
    }
    if (['p', 'blockquote', 'pre'].includes(tag)) {
      blocks.push(childText)
      return ''
    }
    return childText
  }
  const remainder = visit(documentNode.body)
  if (remainder) blocks.push(remainder)
  return normalizePlainText(blocks.join('\n\n'))
}

async function normalizeTypedText(text, mimeType) {
  if (mimeType === 'application/json') {
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      throw new AttachmentValidationError('attachment_invalid', 'The JSON file is invalid.')
    }
  }
  if (mimeType === 'text/html') return structuredHtmlText(text)
  return normalizePlainText(text)
}

export function validateAttachmentGroup(files, existing = []) {
  const candidates = [...(existing || []), ...(files || [])]
  if (candidates.length > MAX_ATTACHMENT_COUNT) {
    throw new AttachmentValidationError('attachment_count_exceeded', `At most ${MAX_ATTACHMENT_COUNT} files can be attached.`)
  }
  const totalSize = candidates.reduce((sum, file) => sum + Number(file?.size || 0), 0)
  if (totalSize > MAX_ATTACHMENT_GROUP_SIZE) {
    throw new AttachmentValidationError('attachment_group_too_large', 'The attachment group exceeds 30 MB.')
  }
}

function readFileArrayBuffer(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error('File could not be read.'))
    reader.readAsArrayBuffer(file)
  })
}

export async function processAttachmentFile(file) {
  if (!file) {
    throw new AttachmentValidationError('attachment_invalid', 'The selected file cannot be read.')
  }
  if (Number(file.size || 0) > MAX_ATTACHMENT_FILE_SIZE) {
    throw new AttachmentValidationError('attachment_too_large', 'The file exceeds 20 MB.')
  }

  const mimeType = resolveAttachmentType(file)
  const buffer = await readFileArrayBuffer(file)
  const bytes = new Uint8Array(buffer.slice(0, 1029))
  if (BINARY_MIME_TYPES.has(mimeType) && !hasValidSignature(bytes, mimeType)) {
    throw new AttachmentValidationError('attachment_type_mismatch', 'The file signature does not match its type.')
  }

  let modelText
  let kind = 'binary'
  if (TEXT_MIME_TYPES.has(mimeType)) {
    kind = 'text'
    modelText = await normalizeTypedText(decodeUtf8(buffer), mimeType)
  } else if (mimeType.includes('wordprocessingml.document')) {
    kind = 'text'
    try {
      const mammoth = (await import('mammoth')).default
      const mammothInput = globalThis.Buffer
        ? { buffer: globalThis.Buffer.from(buffer) }
        : { arrayBuffer: buffer }
      const result = await mammoth.convertToHtml(
        mammothInput,
        { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })) },
      )
      modelText = await structuredHtmlText(result.value)
    } catch {
      throw new AttachmentValidationError('attachment_invalid', 'The DOCX file is invalid or corrupted.')
    }
  } else if (
    mimeType.includes('spreadsheetml.sheet')
    || mimeType === 'application/vnd.ms-excel'
  ) {
    kind = 'text'
    try {
      const { default: XLSX } = await import('xlsx')
      const workbook = XLSX.read(buffer, { type: 'array' })
      const sections = []
      for (const sheetName of workbook.SheetNames || []) {
        const sheet = workbook.Sheets[sheetName]
        if (!sheet) continue
        const csv = XLSX.utils.sheet_to_csv(sheet).trim()
        if (!csv) continue
        sections.push(`--- SHEET: ${sheetName} ---\n${csv}`)
      }
      modelText = normalizePlainText(sections.join('\n\n'))
    } catch {
      throw new AttachmentValidationError('attachment_invalid', 'The spreadsheet file is invalid or corrupted.')
    }
  } else if (mimeType.startsWith('image/')) kind = 'image'
  else if (mimeType === 'application/pdf') kind = 'pdf'

  if (typeof modelText === 'string' && modelText.length > MAX_EXTRACTED_TEXT_CHARS) {
    throw new AttachmentValidationError('attachment_text_too_large', 'Extracted text exceeds 1,000,000 characters.')
  }
  if (kind === 'text' && !modelText) {
    throw new AttachmentValidationError('attachment_empty', 'The file contains no readable text.')
  }

  return {
    blob: file.slice(0, file.size, mimeType), name: file.name, mimeType,
    size: file.size, kind, ...(modelText ? { modelText } : {}),
  }
}

export const fileToBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '')
  reader.onerror = reject
  reader.readAsDataURL(file)
})
