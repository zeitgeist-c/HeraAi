/**
 * HeraAi 1.10.0 — Sağlıklı API anahtarı rotasyonu ve dengeli kullanım (Aşama 9).
 *
 * Amaç: bir sağlayıcıdaki tek anahtarın kotasını tüketmek yerine istekleri o
 * sağlayıcının sağlıklı anahtarları arasında dağıtmak.
 *
 * Değişmezler:
 * - Havuzlar mutlak izole: her çağrı yalnız kendi sağlayıcısının listesiyle
 *   çalışır; başka sağlayıcının anahtarı listeye karışamaz.
 * - İstek ortasında anahtar değişmez: akış başladıktan sonra kullanılan anahtar
 *   sabit kalır (TTS parçaları, Tavily zinciri).
 * - `primary` modunda ana anahtar önce gelir; `balanced_rotation` modunda en
 *   uzun süredir kullanılmayan anahtar öne geçer.
 */

import { API_KEY_USAGE_MODES, normalizeApiKeyUsageMode } from './syncContract'

export const KEY_USAGE_MODE = Object.freeze({
  /** Ana anahtarlar önce; mevcut davranış korunur. */
  PRIMARY: 'primary',
  /** Anahtarlar sırayla; kota dengeli dağıtılır. */
  BALANCED_ROTATION: 'balanced_rotation',
})

/** Mod etiketleri (arayüz). */
export const KEY_USAGE_MODE_LABELS = Object.freeze({
  [KEY_USAGE_MODE.PRIMARY]: 'Ana anahtarları kullan',
  [KEY_USAGE_MODE.BALANCED_ROTATION]: 'Anahtarları sırayla kullan',
})

function sayi(deger) {
  const n = Number(deger)
  return Number.isFinite(n) ? n : null
}

/** Hiç kullanılmamış anahtar her zaman en eskidir. */
function kullanimZamani(kayit) {
  const t = sayi(kayit?.lastUsedAt)
  return t === null ? -1 : t
}

function kimlik(kayit) {
  return String(kayit?.id ?? '')
}

/**
 * `primary` sırası: ana anahtar önce, sonra `createdAt` artan, eşitlikte `id`.
 * Bu, 1.9.4'teki davranışla aynıdır.
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
 * Rotasyon sırası: en uzun süredir kullanılmayan anahtar önce.
 * Eşitlikte sabit `id` sırası kullanılır ki tüm cihazlar aynı sırayı görsün.
 */
export function orderByRotation(keys) {
  return [...(keys || [])].sort((a, b) => {
    const aT = kullanimZamani(a)
    const bT = kullanimZamani(b)
    if (aT !== bT) return aT - bT
    return kimlik(a) < kimlik(b) ? -1 : kimlik(a) > kimlik(b) ? 1 : 0
  })
}

/** Moda göre sıralama; bilinmeyen mod `primary` sayılır. */
export function orderKeysForRequest(keys, mode) {
  return normalizeApiKeyUsageMode(mode) === KEY_USAGE_MODE.BALANCED_ROTATION
    ? orderByRotation(keys)
    : orderByPrimary(keys)
}

/**
 * İstek için sıralı aday listesi üretir.
 *
 * @param {object} options
 * @param {Array} options.keys Sağlayıcının çözülmüş anahtarları.
 * @param {string} [options.mode] `primary` | `balanced_rotation`.
 * @param {string[]} [options.excludeIds] Bu istekte kullanılmayacak kimlikler.
 * @param {string[]} [options.reservedIds] Rezerve edilmiş kimlikler; varsa
 *   önce onlar denenir (akış ortasında anahtar değişmemesi için).
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
 * İstek başına anahtar rezervasyonu.
 *
 * Akış başladıktan sonra anahtar değişmez: `current()` her çağrıda aynı kaydı
 * döndürür, `advance()` yalnız istek yeniden başlatılırken çağrılır.
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
    /** Akış boyunca sabit kalan anahtar. */
    current: () => rezerve[sira] || rezerve[0],
    /** Sıradaki anahtara geçer (yalnız istek yeniden denendiğinde). */
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

/** Kullanım sonrası güncellenecek metadata (kasa `updateKeyMetadata` ile yazar). */
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

/** Kullanım modunun geçerliliğini denetler. */
export function isValidUsageMode(mode) {
  return API_KEY_USAGE_MODES.includes(mode)
}

/** Mod etiketi (arayüz için). */
export function usageModeLabel(mode) {
  return KEY_USAGE_MODE_LABELS[normalizeApiKeyUsageMode(mode)]
}

/** Rotasyon katmanının tanıtımı (test ve dokümantasyon). */
export function describeKeyRotation() {
  return {
    modes: Object.values(KEY_USAGE_MODE),
    labels: { ...KEY_USAGE_MODE_LABELS },
    strategy: 'least_recently_used',
    tieBreak: 'id',
    midStreamSwitch: false,
  }
}
