/**
 * Panel içi otomatik eşitleme zamanlayıcısı.
 *
 * Neden panel içinde: `chrome.alarms` yeni bir izin gerektirir ve Chrome, izin
 * eklenen eklentiyi devre dışı bırakıp kullanıcıdan onay ister (20 cihazda 20
 * kez elle onay). Panelin kendi zamanlayıcısı izinsiz çalışır ve zaten doğru
 * davranışı verir: panel kapalıyken hiç koşmaz, yani boşuna kota harcamaz.
 *
 * Maliyet notu: boş çekme sorgusu da en az bir okuma sayılır. Cihaz kontrolü,
 * son görülme yazması ve yeni gateway sayaçları ayrıca işlem üretir. Yerel
 * sayaç tahmindir; sunucunun hesap kotası veya Firebase faturalaması değildir.
 */
import { isSyncedKey } from './syncContract'

/** Panel ayarının depolama anahtarı (cihaza özel, eşitlenmez). */
export const AUTO_SYNC_INTERVAL_KEY = 'syncAutoIntervalMinutes'
/** Günlük kota kullanım sayacı (cihaza özel, eşitlenmez). */
export const AUTO_SYNC_USAGE_KEY = 'syncUsage'

/** Seçilebilir aralıklar (dakika); 0 = kapalı. */
export const AUTO_SYNC_OPTIONS_MINUTES = Object.freeze([0, 60, 120, 360])
export const DEFAULT_AUTO_SYNC_MINUTES = 60
/** Her koşuya eklenen rastgele kayma: 20 cihaz aynı saniyede yüklenmesin. */
export const AUTO_SYNC_JITTER_MS = 3 * 60 * 1000
/** Yerel değişiklikten sonra gönderim gecikmesi (üst üste değişiklik birleşir). */
export const LOCAL_CHANGE_SYNC_DELAY_MS = 60 * 1000
/** Bu süre boyunca kullanıcı etkin değilse periyodik koşu atlanır. */
export const AUTO_SYNC_IDLE_MS = 10 * 60 * 1000
/** Kota yarısı dolduğunda aralık bu katsayıyla uzar (yavaş mod). */
export const AUTO_SYNC_SLOW_FACTOR = 4
export const AUTO_SYNC_SLOW_THRESHOLD = 0.5
/** Firestore Spark ücretsiz kotası (günlük). */
export const FREE_TIER_READS_PER_DAY = 50_000
export const FREE_TIER_WRITES_PER_DAY = 20_000

/** Yazılabilir bir aralığı doğrular; bilinmeyen değer varsayılana düşer. */
export function normalizeAutoSyncMinutes(value) {
  const minutes = Number(value)
  return AUTO_SYNC_OPTIONS_MINUTES.includes(minutes) ? minutes : DEFAULT_AUTO_SYNC_MINUTES
}

/**
 * Yazılan depolama yaması eşitlenen bir anahtara dokunuyor mu?
 * Yalnızca eşitlenen anahtarlar otomatik eşitlemeyi tetikler; `activeSessionId`
 * gibi cihaza özel anahtarlar boşuna koşu başlatmaz.
 */
export function touchesSyncedKeys(values) {
  if (!values || typeof values !== 'object') return false
  return Object.keys(values).some(isSyncedKey)
}

/** Günlük kota kullanım oranları (1'i aşan değer taşma demektir). */
export function quotaUsageRatio(usage) {
  const reads = Math.max(0, Number(usage?.reads) || 0)
  const writes = Math.max(0, Number(usage?.writes) || 0)
  const readRatio = reads / FREE_TIER_READS_PER_DAY
  const writeRatio = writes / FREE_TIER_WRITES_PER_DAY
  return { reads: readRatio, writes: writeRatio, worst: Math.max(readRatio, writeRatio) }
}

/** Kota yarısı doldu mu? Doluysa aralık uzatılır ve panel uyarır. */
export function isSlowMode(usage) {
  return quotaUsageRatio(usage).worst >= AUTO_SYNC_SLOW_THRESHOLD
}

/**
 * Aralık + rastgele kayma (kapalıysa 0).
 * Not: değer burada doğrulanmaz — yavaş mod katsayısıyla çarpılmış (örneğin 240
 * dakika) ara değerler de geçmelidir; seçilebilir değerlerin doğrulaması
 * `normalizeAutoSyncMinutes` ile yapılır.
 */
export function autoSyncDelayMs(minutes, random = Math.random, jitterMs = AUTO_SYNC_JITTER_MS) {
  const base = Math.max(0, Number(minutes) || 0) * 60_000
  if (base === 0) return 0
  const kayma = Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * jitterMs)
  return base + kayma
}

/** Periyodik koşu atlanmalı mı? ('hidden' | 'idle' | null) */
export function autoSyncSkipReason({ hidden, lastActivityAt, now, idleMs = AUTO_SYNC_IDLE_MS }) {
  if (hidden) return 'hidden'
  if (Number.isFinite(lastActivityAt) && Number.isFinite(now) && now - lastActivityAt >= idleMs) {
    return 'idle'
  }
  return null
}

/**
 * Zamanlayıcıyı kurar. Tüm yan etkiler enjekte edilir; bu yüzden birim testte
 * sahte zamanlayıcı ve sahte depo ile birebir doğrulanabilir.
 *
 * @param {object} deps
 * @param {() => Promise<unknown>} deps.requestSync  eşitlemeyi tetikler
 * @param {() => Promise<unknown>} [deps.requestSyncAfterChange]  yerel değişiklik
 *   sonrası tetikleyici (varsayılan: `requestSync`); çağıran taraf bunu
 *   aralık eşiğine takılmayan yoldan gönderebilir.
 * @param {() => boolean} deps.isHidden              panel gizli mi
 * @param {() => number} deps.getLastActivityAt      son kullanıcı etkinliği (ms)
 * @param {() => object|null} deps.getUsage          günlük kota sayacı
 * @param {() => number} deps.getIntervalMinutes     seçili aralık (dakika)
 */
export function createAutoSyncScheduler({
  requestSync,
  requestSyncAfterChange = null,
  isHidden = () => false,
  getLastActivityAt = () => Date.now(),
  getUsage = () => null,
  getIntervalMinutes = () => DEFAULT_AUTO_SYNC_MINUTES,
  random = Math.random,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = id => clearTimeout(id),
} = {}) {
  let periodicTimer = null
  let changeTimer = null
  let stopped = true

  function clearPeriodic() {
    if (periodicTimer != null) {
      cancel(periodicTimer)
      periodicTimer = null
    }
  }

  function clearChange() {
    if (changeTimer != null) {
      cancel(changeTimer)
      changeTimer = null
    }
  }

  function skipReason() {
    return autoSyncSkipReason({ hidden: isHidden(), lastActivityAt: getLastActivityAt(), now: now() })
  }

  async function fire(trigger = requestSync) {
    try {
      await trigger()
    } catch {
      // Sessiz: sonraki turda yeniden denenir; kota/oturum hataları zaten
      // koordinatörde ele alınıp panelde gösteriliyor.
    }
  }

  /** Bir sonraki periyodik koşuyu planlar (kapalıysa plan yapmaz). */
  function planNext() {
    clearPeriodic()
    if (stopped) return
    const minutes = normalizeAutoSyncMinutes(getIntervalMinutes())
    if (minutes === 0) return
    const factor = isSlowMode(getUsage()) ? AUTO_SYNC_SLOW_FACTOR : 1
    periodicTimer = schedule(() => {
      periodicTimer = null
      void tick()
    }, autoSyncDelayMs(minutes * factor, random))
  }

  /** Periyodik tur: gizli/boşta ise atlar, ardından yenisini planlar. */
  async function tick() {
    if (stopped) return
    if (!skipReason()) await fire()
    planNext()
  }

  /** Yerel değişiklikten sonra tek koşu; üst üste değişiklik tek koşuda birleşir. */
  function noteLocalChange() {
    if (stopped || changeTimer != null) return
    changeTimer = schedule(() => {
      changeTimer = null
      if (stopped || skipReason()) return
      void fire(requestSyncAfterChange || requestSync)
    }, LOCAL_CHANGE_SYNC_DELAY_MS)
  }

  function start() {
    if (!stopped) return
    stopped = false
    planNext()
  }

  function stop() {
    stopped = true
    clearPeriodic()
    clearChange()
  }

  return { start, stop, noteLocalChange, tick, planNext }
}
