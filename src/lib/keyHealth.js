/**
 * HeraAi 1.10.0 — API anahtarı tam güvenli yönetim paketi (Aşama 10).
 *
 * Üç parça:
 *  1. Anahtar sağlık durumları (`ready`, `untested`, `paused`, `cooldown`,
 *     `invalid`, `incompatible`, `transient_error`).
 *  2. Hata sınıflandırması ve artan bekleme politikası (401 → kalıcı geçersiz,
 *     429 → `Retry-After` ya da 1dk/5dk/15dk/1saat merdiveni).
 *  3. Gizli parmak izi ile mükerrer anahtar engelleme: açık anahtar veya
 *     standart hash yerine `HMAC-SHA-256(fingerprintKey, rawKey)`.
 *
 * Kural: yerel internet kesintisi ya da ağ zaman aşımı anahtarı "bozuk"
 * saymaz; bu tür hatalar diğer cihazlara küresel arıza olarak yansımaz.
 */

import { computeKeyFingerprint } from './syncCrypto'

export const KEY_HEALTH = Object.freeze({
  /** Sağlıklı; rotasyona girer. */
  READY: 'ready',
  /** Hiç denenmedi; rotasyona girer. */
  UNTESTED: 'untested',
  /** Kullanıcı duraklattı; rotasyona girmez. */
  PAUSED: 'paused',
  /** Geçici hız sınırı; süre dolunca kendiliğinden döner. */
  COOLDOWN: 'cooldown',
  /** 401: kalıcı geçersiz; rotasyondan çıkar. */
  INVALID: 'invalid',
  /** Anahtar sağlam ama ilgili modele yetkisi yok. */
  INCOMPATIBLE: 'incompatible',
  /** 5xx veya ağ hatası; geçici. */
  TRANSIENT_ERROR: 'transient_error',
})

/** Rotasyona girebilen durumlar. */
export const USABLE_HEALTH = Object.freeze([KEY_HEALTH.READY, KEY_HEALTH.UNTESTED])

/** Kalıcı olarak dışlanan durumlar (kullanıcı müdahalesi gerekir). */
export const PERMANENT_HEALTH = Object.freeze([KEY_HEALTH.INVALID, KEY_HEALTH.PAUSED])

/** Artan bekleme merdiveni (plan §14.2). */
export const COOLDOWN_LADDER_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000])

/** Ağ kaynaklı hatalar: anahtar sağlığını kalıcı bozmaz. */
export const NETWORK_ERROR_TYPES = Object.freeze([
  'network_error',
  'timeout',
  'offline',
  'failed_to_fetch',
])

function sayi(deger) {
  const n = Number(deger)
  return Number.isFinite(n) ? n : null
}

/** Ardışık hata sayısına karşılık gelen bekleme süresi. */
export function cooldownForAttempt(failCount) {
  const n = Math.max(1, Math.trunc(Number(failCount) || 1))
  const index = Math.min(n - 1, COOLDOWN_LADDER_MS.length - 1)
  return COOLDOWN_LADDER_MS[index]
}

/** `Retry-After` başlığını milisaniyeye çevirir (saniye ya da HTTP tarihi). */
export function parseRetryAfter(value, { now = Date.now() } = {}) {
  if (value === null || value === undefined || value === '') return null
  const saniye = Number(value)
  if (Number.isFinite(saniye) && saniye >= 0) return Math.round(saniye * 1000)
  const tarih = Date.parse(String(value))
  if (Number.isFinite(tarih)) {
    const fark = tarih - now
    return fark > 0 ? fark : 0
  }
  return null
}

/**
 * Hatayı sınıflandırır.
 *
 * @param {object} hata
 * @param {number} [hata.status] HTTP durum kodu.
 * @param {string} [hata.errorType] Sağlayıcıdan gelen tip (`quota_exceeded`...).
 * @param {string} [hata.message] Ham mesaj (sınıflandırma yedeği).
 * @param {string|number} [hata.retryAfter] `Retry-After` başlığı.
 * @param {number} [hata.failCount] Bu anahtarın ardışık hata sayısı.
 * @param {boolean} [hata.modelScoped] Hatanın yalnız bir model için geçerli olduğu bilgisi.
 */
export function classifyKeyError({
  status,
  errorType,
  message,
  retryAfter = null,
  failCount = 0,
  modelScoped = false,
  now = Date.now(),
} = {}) {
  const tip = String(errorType || '').toLowerCase()
  const mesaj = String(message || '').toLowerCase()
  const kod = sayi(status)

  // Ağ kaynaklı: anahtar suçlu değil, diğer cihazlara yansıtılmaz.
  // `failed_to_fetch` / `Failed to fetch` gibi yazım farkları normalize edilir.
  const mesajNorm = mesaj.replace(/[\s_-]+/g, '')
  const agHatasi = NETWORK_ERROR_TYPES.some(
    t => tip === t || mesajNorm.includes(t.replace(/[_-]/g, '')),
  )
  if (agHatasi) {
    return {
      health: KEY_HEALTH.TRANSIENT_ERROR,
      cooldownMs: cooldownForAttempt(1),
      countsAsFailure: false,
      global: false,
      reason: 'network',
    }
  }

  // 401: kalıcı geçersiz.
  if (kod === 401 || tip === 'unauthorized' || mesaj.includes('unauthorized')) {
    return {
      health: KEY_HEALTH.INVALID,
      cooldownMs: 0,
      countsAsFailure: true,
      global: true,
      reason: 'unauthorized',
    }
  }

  // 403 + model kapsamı: anahtar sağlam, yetki yok.
  if (kod === 403 || tip === 'forbidden' || mesaj.includes('forbidden')) {
    const uyumsuz = modelScoped || mesaj.includes('model') || mesaj.includes('permission')
    return {
      health: uyumsuz ? KEY_HEALTH.INCOMPATIBLE : KEY_HEALTH.INVALID,
      cooldownMs: 0,
      countsAsFailure: true,
      global: !uyumsuz,
      reason: uyumsuz ? 'model_incompatible' : 'forbidden',
    }
  }

  // 429: bekleme; `Retry-After` varsa o, yoksa artan merdiven.
  if (kod === 429 || tip === 'rate_limit' || tip === 'quota_exceeded' || mesaj.includes('rate limit')) {
    const baslik = parseRetryAfter(retryAfter, { now })
    return {
      health: KEY_HEALTH.COOLDOWN,
      cooldownMs: baslik !== null ? baslik : cooldownForAttempt(failCount + 1),
      countsAsFailure: true,
      global: true,
      reason: 'rate_limited',
    }
  }

  // 5xx ve sağlayıcı kaynaklı geçici hatalar.
  if ((kod && kod >= 500) || tip === 'server_error' || tip === 'unavailable') {
    return {
      health: KEY_HEALTH.TRANSIENT_ERROR,
      cooldownMs: cooldownForAttempt(Math.max(1, failCount)),
      countsAsFailure: true,
      global: false,
      reason: 'server_error',
    }
  }

  // İstek hatası: anahtar sağlıklı kalır.
  if (kod === 400 || tip === 'invalid_request') {
    return {
      health: KEY_HEALTH.READY,
      cooldownMs: 0,
      countsAsFailure: false,
      global: false,
      reason: 'bad_request',
    }
  }

  // Bilinmeyen: temkinli davran, kısa bekleme.
  return {
    health: KEY_HEALTH.TRANSIENT_ERROR,
    cooldownMs: cooldownForAttempt(1),
    countsAsFailure: true,
    global: false,
    reason: 'unknown',
  }
}

/** Anahtar şu anda kullanılabilir mi? */
export function isKeyUsable(meta, { now = Date.now() } = {}) {
  if (!meta) return false
  const durum = meta.status || KEY_HEALTH.UNTESTED
  if (PERMANENT_HEALTH.includes(durum)) return false
  if (durum === KEY_HEALTH.COOLDOWN) {
    const bitis = sayi(meta.cooldownUntil)
    if (bitis !== null && bitis > now) return false
    // Bekleme doldu: yeniden denenebilir.
    return true
  }
  if (durum === KEY_HEALTH.TRANSIENT_ERROR) {
    const bitis = sayi(meta.cooldownUntil)
    if (bitis !== null && bitis > now) return false
    return true
  }
  return true
}

/**
 * Sonucu anahtar metadata'sına uygular. Başarılı istek sayaç ve beklemeyi
 * sıfırlar; kalıcı hatalar rotasyondan çıkarır.
 */
export function applyKeyOutcome(
  meta = {},
  { success = true, status, errorType, message, retryAfter, modelScoped, now = Date.now() } = {},
) {
  if (success) {
    return {
      ...meta,
      status: KEY_HEALTH.READY,
      lastUsedAt: now,
      lastSuccessAt: now,
      lastErrorAt: null,
      lastErrorType: null,
      cooldownUntil: null,
      failCount: 0,
    }
  }

  const sinif = classifyKeyError({ status, errorType, message, retryAfter, failCount: meta.failCount || 0, modelScoped, now })
  const yeniFail = sinif.countsAsFailure ? (Number(meta.failCount) || 0) + 1 : Number(meta.failCount) || 0
  return {
    ...meta,
    status: sinif.health,
    lastUsedAt: now,
    lastErrorAt: now,
    lastErrorType: errorType || sinif.reason,
    cooldownUntil: sinif.cooldownMs > 0 ? now + sinif.cooldownMs : null,
    failCount: yeniFail,
    // Ağ hatası anahtarın kimliğini lekelemez.
    ...(sinif.global ? {} : { lastErrorScope: 'local' }),
  }
}

/** Kullanıcı anahtarı duraklatır (rotasyondan çıkar). */
export function pauseKey(meta = {}, { now = Date.now() } = {}) {
  return { ...meta, status: KEY_HEALTH.PAUSED, pausedAt: now }
}

/** Duraklatmayı kaldırır; anahtar yeniden rotasyona girer. */
export function resumeKey(meta = {}, { now = Date.now() } = {}) {
  return {
    ...meta,
    status: KEY_HEALTH.UNTESTED,
    resumedAt: now,
    cooldownUntil: null,
    failCount: 0,
  }
}

/**
 * Gizli parmak izi: aynı ham anahtar iki cihazda eklendiğinde açık anahtar
 * karşılaştırması yapılmaz, `HMAC-SHA-256(fingerprintKey, rawKey)` karşılaştırılır.
 */
export async function keyFingerprint(fingerprintKey, rawKey) {
  if (!fingerprintKey) throw new Error('fingerprint_key_missing')
  const ham = String(rawKey || '')
  if (!ham.trim()) throw new Error('fingerprint_raw_key_missing')
  return computeKeyFingerprint(fingerprintKey, ham)
}

/** Aynı parmak izine sahip mevcut kaydı bulur (mükerrer eklemeyi engeller). */
export function findDuplicateKey(fingerprint, kayitlar) {
  if (!fingerprint) return null
  for (const kayit of kayitlar || []) {
    if (kayit?.fingerprint && kayit.fingerprint === fingerprint) return kayit
  }
  return null
}

/** Sağlayıcı havuzunun özeti (arayüz rozetleri için). */
export function summarizePool(kayitlar, { now = Date.now() } = {}) {
  const ozet = {
    total: 0,
    usable: 0,
    ready: 0,
    untested: 0,
    paused: 0,
    cooldown: 0,
    invalid: 0,
    incompatible: 0,
    transient_error: 0,
  }
  for (const kayit of kayitlar || []) {
    ozet.total += 1
    const durum = kayit?.status || KEY_HEALTH.UNTESTED
    if (Object.prototype.hasOwnProperty.call(ozet, durum)) ozet[durum] += 1
    if (isKeyUsable(kayit, { now })) ozet.usable += 1
  }
  return ozet
}

/** Katmanın tanıtımı (test ve dokümantasyon). */
export function describeKeyHealth() {
  return {
    healths: Object.values(KEY_HEALTH),
    usable: [...USABLE_HEALTH],
    permanent: [...PERMANENT_HEALTH],
    cooldownLadderMs: [...COOLDOWN_LADDER_MS],
    fingerprint: 'hmac-sha-256',
  }
}
