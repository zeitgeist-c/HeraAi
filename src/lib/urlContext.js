export const MAX_PUBLIC_URLS = 10

export class UrlValidationError extends Error {
  constructor(code, message, url = '') {
    super(message)
    this.name = 'UrlValidationError'
    this.code = code
    this.url = url
  }
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || parts[0] === 0
}

// ::ffff:127.0.0.1 ve hex esdegeri (::ffff:7f00:1) gibi IPv4'e eslenmis
// IPv6 literalleri ozel aga gider; cozup IPv4 kurallariyla karsilastiririz.
function isPrivateMappedIpv6(host) {
  const match = /^::ffff:(.+)$/.exec(host)
  if (!match) return false
  const tail = match[1]
  if (tail.includes('.')) return isPrivateIpv4(tail)
  const groups = tail.split(':')
  if (groups.length === 2) {
    const high = parseInt(groups[0], 16)
    const low = parseInt(groups[1], 16)
    if (Number.isInteger(high) && Number.isInteger(low)) {
      return isPrivateIpv4([high >> 8, high & 255, low >> 8, low & 255].join('.'))
    }
  }
  return true
}

function isPrivateHostname(hostname) {
  // Sondaki nokta (localhost.) tarayicida ayni adrese cozulur; once temizle.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  const isIpv6Literal = host.includes(':')
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === '::1'
    || host === '::'
    || (isIpv6Literal && host.startsWith('fe80:'))
    || (isIpv6Literal && (host.startsWith('fc') || host.startsWith('fd')))
    || (isIpv6Literal && isPrivateMappedIpv6(host))
    || isPrivateIpv4(host)
}

function trimUrlCandidate(candidate) {
  return String(candidate || '').trim().replace(/^[<({["']+/, '').replace(/[>)}\]"',.!?:;]+$/, '')
}

function collectUrlCandidates(text) {
  const input = String(text || '')
  const candidates = []
  const markdownSpans = []

  for (const match of input.matchAll(/\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi)) {
    const start = match.index || 0
    const end = start + match[0].length
    markdownSpans.push([start, end])
    candidates.push({ candidate: match[1], start, end })
  }
  for (const match of input.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const start = match.index || 0
    const end = start + match[0].length
    if (markdownSpans.some(([spanStart, spanEnd]) => start >= spanStart && end <= spanEnd)) continue
    candidates.push({ candidate: match[0], start, end })
  }
  return candidates.sort((left, right) => left.start - right.start)
}

export function normalizePublicUrl(candidate) {
  const raw = trimUrlCandidate(candidate)
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new UrlValidationError('url_invalid', 'The URL is invalid.', raw)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new UrlValidationError('url_invalid', 'Only HTTP and HTTPS URLs are supported.', raw)
  }
  if (parsed.username || parsed.password) {
    throw new UrlValidationError('url_private', 'URLs containing credentials are not allowed.', raw)
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new UrlValidationError('url_private', 'Local and private network URLs are not allowed.', raw)
  }
  parsed.hash = ''
  return parsed.href
}

export function extractPublicUrls(text, maxUrls = MAX_PUBLIC_URLS) {
  const urls = []
  const seen = new Set()
  for (const { candidate } of collectUrlCandidates(text)) {
    const normalized = normalizePublicUrl(candidate)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    urls.push(normalized)
  }
  if (urls.length > maxUrls) {
    throw new UrlValidationError('url_limit_exceeded', `At most ${maxUrls} public URLs can be read in one request.`)
  }
  return urls
}

export function listPublicUrls(text) {
  const urls = []
  const seen = new Set()
  for (const { candidate } of collectUrlCandidates(text)) {
    try {
      const normalized = normalizePublicUrl(candidate)
      if (seen.has(normalized)) continue
      seen.add(normalized)
      urls.push(normalized)
    } catch {
      // Incomplete/private candidates stay in the textarea and are validated on send.
    }
  }
  return urls
}

export function removePublicUrlFromText(text, targetUrl) {
  const input = String(text || '')
  const normalizedTarget = normalizePublicUrl(targetUrl)
  const spans = collectUrlCandidates(input)
    .filter(({ candidate }) => {
      try {
        return normalizePublicUrl(candidate) === normalizedTarget
      } catch {
        return false
      }
    })
    .map(({ start, end }) => [start, end])
    .sort((left, right) => right[0] - left[0])

  let next = input
  for (const [start, end] of spans) next = `${next.slice(0, start)}${next.slice(end)}`
  return next.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim()
}

export function isUrlOnlyText(text, urls) {
  let remainder = String(text || '')
  for (const url of urls || []) {
    const variants = [url, url.endsWith('/') ? url.slice(0, -1) : url]
    for (const variant of variants) {
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      remainder = remainder.replace(new RegExp(escaped, 'gi'), '')
    }
  }
  remainder = remainder.replace(/\[[^\]]*\]\(\s*\)/g, '').replace(/[\s,;:.!?()[\]{}<>-]+/g, '')
  return remainder.length === 0
}

const AUTO_WEB_SEARCH_PHRASES = Object.freeze([
  'bugün',
  'bugun',
  'yarın',
  'yarin',
  'dün',
  'dun',
  'güncel',
  'guncel',
  'son dakika',
  'son durum',
  'son haber',
  'haberler',
  'gündem',
  'şu an',
  'suan',
  'şuan',
  'bu yıl',
  'bu yil',
  'geçen yıl',
  'gecen yil',
  'kaç tl',
  'kac tl',
  'kaç dolar',
  'kac dolar',
  'kaç para',
  'kac para',
  'dolar kuru',
  'euro kuru',
  'döviz',
  'doviz',
  'altın fiyat',
  'altin fiyat',
  'altın ons',
  'altin ons',
  'fiyat',
  'fiyatı ne',
  'fiyati ne',
  'hava durumu',
  'sıcaklık',
  'sicaklik',
  'kaç derece',
  'kac derece',
  'kim kazandı',
  'kim kazandi',
  'kaç kaç',
  'kac kac',
  'puan durumu',
  'sıralama',
  'siralama',
  'borsa',
  'hisse senedi',
  'bitcoin',
  'kripto',
  'enflasyon',
  'faiz',
  'seçim sonuçları',
  'secim sonuclari',
  'deprem',
  'nöbetçi',
  'nobetci',
  'vizyonda',
  'çıkış tarihi',
  'cikis tarihi',
  'çıkacak',
  'cikacak',
  'çıkar mı',
  'cikar mi',
  'yayınlanacak',
  'yayinlanacak',
  'yayın tarihi',
  'yayin tarihi',
  'ne zaman',
  'olacak mı',
  'olacak mi',
  'ne oldu',
  'duyuru',
  'açıklan',
  'aciklan',
  'ertelendi',
  'ertelenecek',
  'son sürüm',
  'son surum',
  'sonuçlar',
  'sonuclar',
  'latest',
  'current price',
  'weather in',
  'who won',
  'stock price',
  'breaking news',
  'news about',
  'when will',
  'release date',
  'will be released',
  'has been released',
  'announc',
  'delay',
  'postpon',
  'what happened',
])

const EXPLICIT_SEARCH_PATTERN = /araştır|arastir|internette (bak|ara)|web'?de ara|google'?da ara|kaynak bul/i
const CURRENT_YEAR_PATTERN = /\b20[2-9]\d\b/

export function needsWebSearch(text) {
  const normalized = String(text || '').toLocaleLowerCase('tr')
  if (!normalized.trim()) return false
  // Kod istekleri arastirmaya gitmez.
  if (/```/.test(text)) return false
  if (EXPLICIT_SEARCH_PATTERN.test(normalized)) return true
  if (AUTO_WEB_SEARCH_PHRASES.some(phrase => normalized.includes(phrase))) return true
  return CURRENT_YEAR_PATTERN.test(normalized)
}
