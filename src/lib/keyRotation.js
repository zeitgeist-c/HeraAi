/**
 * HeraAi 1.10.0 - healthy API key rotation and balanced usage (Stage 9).
 *
 * Goal: instead of draining the quota of a single key at a provider, spread the
 * requests across that provider's healthy keys.
 *
 * Invariants:
 * - Pools are strictly isolated: every call works only with its own provider's list;
 * another provider's key cannot leak into it.
 * - The key does not change mid-request: once the stream has started the key in use
 * stays fixed (Tavily chain).
 * - In `primary` mode the main key comes first; in `balanced_rotation` mode the key
 * unused for the longest time moves ahead.
 */

import { API_KEY_USAGE_MODES, normalizeApiKeyUsageMode } from './syncContract'

export const KEY_USAGE_MODE = Object.freeze({
  /** Main keys first; the existing behaviour is preserved. */
  PRIMARY: 'primary',
  /** Keys in turn; the quota is spread evenly. */
  BALANCED_ROTATION: 'balanced_rotation',
})

/** Mode labels (UI). */
export const KEY_USAGE_MODE_LABELS = Object.freeze({
  [KEY_USAGE_MODE.PRIMARY]: 'Ana anahtarları kullan',
  [KEY_USAGE_MODE.BALANCED_ROTATION]: 'Anahtarları sırayla kullan',
})

function sayi(deger) {
  const n = Number(deger)
  return Number.isFinite(n) ? n : null
}

/** A key that was never used is always the oldest. */
function kullanimZamani(kayit) {
  const t = sayi(kayit?.lastUsedAt)
  return t === null ? -1 : t
}

function kimlik(kayit) {
  return String(kayit?.id ?? '')
}

/**
 * `primary` order: main key first, then `createdAt` ascending, `id` on ties.
 * This is the same as the 1.9.4 behaviour.
 */
export function orderByPrimary(keys) {
  return [...(keys || [])].sort((a, b) => {
    const birincilFark = Number(Boolean(b?.isPrimary)) - Number(Boolean(a?.isPrimary))
    if (birincilFark !== 0) return birincilFark
    const aT = sayi(a?.createdAt)
    const bT = sayi(b?.createdAt)
    if (aT !== bT) {
      if (aT === null) return -1
      if (bT === null) return 1
      return aT - bT
    }
    return kimlik(a) < kimlik(b) ? -1 : kimlik(a) > kimlik(b) ? 1 : 0
  })
}

/**
 * Rotation order: the key unused for the longest time first.
 * On ties a fixed `id` order is used so every device sees the same order.
 */
export function orderByRotation(keys) {
  return [...(keys || [])].sort((a, b) => {
    const aT = kullanimZamani(a)
    const bT = kullanimZamani(b)
    if (aT !== bT) return aT - bT
    return kimlik(a) < kimlik(b) ? -1 : kimlik(a) > kimlik(b) ? 1 : 0
  })
}

/** Ordering by mode; an unknown mode counts as `primary`. */
export function orderKeysForRequest(keys, mode) {
  return normalizeApiKeyUsageMode(mode) === KEY_USAGE_MODE.BALANCED_ROTATION
    ? orderByRotation(keys)
    : orderByPrimary(keys)
}

/**
 * Produces the ordered candidate list for the request.
 *
 * @param {object} options
 * @param {Array} options.keys The provider's resolved keys.
 * @param {string} [options.mode] `primary` | `balanced_rotation`.
 * @param {string[]} [options.excludeIds] Ids not to be used in this request.
 * @param {string[]} [options.reservedIds] Reserved ids; if present they are tried
 * first (so the key does not change mid-stream).
 */
export function selectCandidates({ keys, mode, excludeIds = [], reservedIds = [] } = {}) {
  const disarida = new Set((excludeIds || []).map(String))
  const rezerve = new Set((reservedIds || []).map(String))
  const uygun = (keys || []).filter(k => k?.key && !disarida.has(kimlik(k)))
  const sirali = orderKeysForRequest(uygun, mode)
  if (rezerve.size === 0) return sirali
  const oncelikli = sirali.filter(k => rezerve.has(kimlik(k)))
  const digerleri = sirali.filter(k => !rezerve.has(kimlik(k)))
  return [...oncelikli, ...digerleri]
}

/**
 * Per-request key reservation.
 *
 * The key does not change after the stream starts: `current()` returns the same
 * record on every call, `advance()` is called only when the request is restarted.
 */
export function createKeyLease({ keys, mode, excludeIds = [], count = 1 } = {}) {
  const adaylar = selectCandidates({ keys, mode, excludeIds })
  if (adaylar.length === 0) {
    return { keys: [], exhausted: true, current: () => null, advance: () => null, used: () => [] }
  }
  const istenen = Math.max(1, Math.min(Number(count) || 1, adaylar.length))
  const rezerve = adaylar.slice(0, istenen)
  let sira = 0
  return {
    keys: rezerve,
    exhausted: false,
    /** The key that stays fixed for the whole stream. */
    current: () => rezerve[sira] || rezerve[0],
    /** Moves to the next key (only when the request is retried). */
    advance: () => {
      if (sira < rezerve.length - 1) {
        sira += 1
        return rezerve[sira]
      }
      return null
    },
    used: () => rezerve.map(k => kimlik(k)),
  }
}

/** Metadata to be updated after use (the vault writes it via `updateKeyMetadata`). */
export function usageMetadata({ now = Date.now(), success = true, errorType = null, cooldownMs = 0 } = {}) {
  const meta = { lastUsedAt: now }
  if (success) {
    meta.lastSuccessAt = now
    meta.lastErrorAt = null
    meta.lastErrorType = null
    meta.cooldownUntil = null
    meta.failCount = 0
    meta.status = 'ready'
    return meta
  }
  meta.lastErrorAt = now
  meta.lastErrorType = errorType || 'unknown'
  if (cooldownMs > 0) meta.cooldownUntil = now + cooldownMs
  meta.status = cooldownMs > 0 ? 'cooldown' : 'error'
  return meta
}

/** Validates the usage mode. */
export function isValidUsageMode(mode) {
  return API_KEY_USAGE_MODES.includes(mode)
}

/** Mode label (for the UI). */
export function usageModeLabel(mode) {
  return KEY_USAGE_MODE_LABELS[normalizeApiKeyUsageMode(mode)]
}

/** Introduction of the rotation layer (tests and documentation). */
export function describeKeyRotation() {
  return {
    modes: Object.values(KEY_USAGE_MODE),
    labels: { ...KEY_USAGE_MODE_LABELS },
    strategy: 'least_recently_used',
    tieBreak: 'id',
    midStreamSwitch: false,
  }
}
