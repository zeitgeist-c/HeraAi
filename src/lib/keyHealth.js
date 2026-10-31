/**
 * HeraAi 1.10.0 - full secure API key management package (Stage 10).
 *
 * Three parts:
 * 1. Key health states (`ready`, `untested`, `paused`, `cooldown`,
 * `invalid`, `incompatible`, `transient_error`).
 * 2. Error classification and backoff policy (401 -> permanently invalid,
 * 429 -> `Retry-After` or the 1m/5m/15m/1h ladder).
 * 3. Duplicate key prevention with a secret fingerprint: instead of the plain key or
 * a standard hash, `HMAC-SHA-256(fingerprintKey, rawKey)`.
 *
 * Rule: a local internet outage or a network timeout does not count as a "broken"
 * key; such errors are not propagated to other devices as a global failure.
 */

import { computeKeyFingerprint } from './syncCrypto'

export const KEY_HEALTH = Object.freeze({
  /** Healthy; takes part in rotation. */
  READY: 'ready',
  /** Never tested; takes part in rotation. */
  UNTESTED: 'untested',
  /** Paused by the user; does not take part in rotation. */
  PAUSED: 'paused',
  /** Temporary rate limit; returns by itself when the period expires. */
  COOLDOWN: 'cooldown',
  /** 401: permanently invalid; removed from rotation. */
  INVALID: 'invalid',
  /** The key is fine but has no permission for the model in question. */
  INCOMPATIBLE: 'incompatible',
  /** 5xx or a network error; temporary. */
  TRANSIENT_ERROR: 'transient_error',
})

/** Rotasyona girebilen durumlar. */
export const USABLE_HEALTH = Object.freeze([KEY_HEALTH.READY, KEY_HEALTH.UNTESTED])

/** States excluded permanently (user action required). */
export const PERMANENT_HEALTH = Object.freeze([KEY_HEALTH.INVALID, KEY_HEALTH.PAUSED])

/** Growing backoff ladder (plan section 14.2). */
export const COOLDOWN_LADDER_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000])

/** Network-borne errors: do not damage the key health permanently. */
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

/** The backoff period that corresponds to the number of consecutive failures. */
export function cooldownForAttempt(failCount) {
  const n = Math.max(1, Math.trunc(Number(failCount) || 1))
  const index = Math.min(n - 1, COOLDOWN_LADDER_MS.length - 1)
  return COOLDOWN_LADDER_MS[index]
}

/** Converts the `Retry-After` header to milliseconds (seconds or an HTTP date). */
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
 * Classifies the error.
 *
 * @param {object} hata
 * @param {number} [hata.status] HTTP status code.
 * @param {string} [hata.errorType] Type coming from the provider (`quota_exceeded`...).
 * @param {string} [hata.message] Raw message (classification fallback).
 * @param {string|number} [hata.retryAfter] `Retry-After` header.
 * @param {number} [hata.failCount] Consecutive failure count of this key.
 * @param {boolean} [hata.modelScoped] Whether the error applies to only one model.
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

  // Network-borne: the key is not at fault and it is not propagated to other
  // devices.
  // Spelling differences such as `failed_to_fetch` / `Failed to fetch` are
  // normalized.
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

  // 401: permanently invalid.
  if (kod === 401 || tip === 'unauthorized' || mesaj.includes('unauthorized')) {
    return {
      health: KEY_HEALTH.INVALID,
      cooldownMs: 0,
      countsAsFailure: true,
      global: true,
      reason: 'unauthorized',
    }
  }

  // 403 + model scope: the key is fine, there is no permission.
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

  // 429: wait; use `Retry-After` when present, otherwise the growing ladder.
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

  // 5xx and provider-borne temporary errors.
  if ((kod && kod >= 500) || tip === 'server_error' || tip === 'unavailable') {
    return {
      health: KEY_HEALTH.TRANSIENT_ERROR,
      cooldownMs: cooldownForAttempt(Math.max(1, failCount)),
      countsAsFailure: true,
      global: false,
      reason: 'server_error',
    }
  }

  // Request error: the key stays healthy.
  if (kod === 400 || tip === 'invalid_request') {
    return {
      health: KEY_HEALTH.READY,
      cooldownMs: 0,
      countsAsFailure: false,
      global: false,
      reason: 'bad_request',
    }
  }

  // Unknown: act cautiously, short backoff.
  return {
    health: KEY_HEALTH.TRANSIENT_ERROR,
    cooldownMs: cooldownForAttempt(1),
    countsAsFailure: true,
    global: false,
    reason: 'unknown',
  }
}

/** Is the key usable right now? */
export function isKeyUsable(meta, { now = Date.now() } = {}) {
  if (!meta) return false
  const durum = meta.status || KEY_HEALTH.UNTESTED
  if (PERMANENT_HEALTH.includes(durum)) return false
  if (durum === KEY_HEALTH.COOLDOWN) {
    const bitis = sayi(meta.cooldownUntil)
    if (bitis !== null && bitis > now) return false
    // The wait expired: it can be retried.
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
 * Applies the result to the key metadata. A successful request resets the counter and
 * the backoff; permanent errors remove the key from rotation.
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
    // A network error does not taint the key's identity.
    ...(sinif.global ? {} : { lastErrorScope: 'local' }),
  }
}

/** The user pauses the key (removed from rotation). */
export function pauseKey(meta = {}, { now = Date.now() } = {}) {
  return { ...meta, status: KEY_HEALTH.PAUSED, pausedAt: now }
}

/** Clears the pause; the key re-enters rotation. */
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
 * Secret fingerprint: when the same raw key is added on two devices the plain key is
 * not compared, `HMAC-SHA-256(fingerprintKey, rawKey)` is compared.
 */
export async function keyFingerprint(fingerprintKey, rawKey) {
  if (!fingerprintKey) throw new Error('fingerprint_key_missing')
  const ham = String(rawKey || '')
  if (!ham.trim()) throw new Error('fingerprint_raw_key_missing')
  return computeKeyFingerprint(fingerprintKey, ham)
}

/** Finds the existing record with the same fingerprint (prevents duplicate insertion). */
export function findDuplicateKey(fingerprint, kayitlar) {
  if (!fingerprint) return null
  for (const kayit of kayitlar || []) {
    if (kayit?.fingerprint && kayit.fingerprint === fingerprint) return kayit
  }
  return null
}

/** Summary of the provider pool (for the UI badges). */
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

/** Introduction of the layer (tests and documentation). */
export function describeKeyHealth() {
  return {
    healths: Object.values(KEY_HEALTH),
    usable: [...USABLE_HEALTH],
    permanent: [...PERMANENT_HEALTH],
    cooldownLadderMs: [...COOLDOWN_LADDER_MS],
    fingerprint: 'hmac-sha-256',
  }
}
