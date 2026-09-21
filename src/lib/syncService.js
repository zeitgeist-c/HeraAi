/**
 * HeraAi 1.10.0 — Eşitleme servisi (Aşama 13).
 *
 * Plandaki `SyncService` arayüzü. Motoru, hesap bayraklarını ve arayüz
 * durumunu tek noktada birleştirir. Ağır işler (hesap kurulumu, cihaz
 * bağlama, cihaz kaldırma, geri yükleme) enjekte edilir; böylece servis
 * gerçek Firestore olmadan da test edilebilir ve Service Worker ile Side
 * Panel aynı sözleşmeyi paylaşır.
 */

import { ACCOUNT_STATE, SYNC_BADGE, resolveAccountState, syncBadgeFor } from './accountUiState'
import { SYNC_STATE } from './syncEngine'

/** Varsayılan hesap bayrakları. */
export const DEFAULT_ACCOUNT_FLAGS = Object.freeze({
  signedIn: false,
  recoveryAcknowledged: false,
  paused: false,
  uid: null,
  email: null,
  syncEnabled: true,
})

function bayraklariNormalle(raw) {
  return { ...DEFAULT_ACCOUNT_FLAGS, ...(raw || {}) }
}

export function createSyncService({
  engine,
  readFlags = async () => DEFAULT_ACCOUNT_FLAGS,
  writeFlags = async () => {},
  initializeAccount: initializeAccountFn = null,
  linkDevice: linkDeviceFn = null,
  disconnectDevice: disconnectDeviceFn = null,
  revokeDevice: revokeDeviceFn = null,
  restorePoint: restorePointFn = null,
  isOnline = () => true,
  now = () => Date.now(),
} = {}) {
  if (!engine?.runOnce || !engine?.getStatus) throw new Error('sync_service_engine_missing')

  let sonDurum = null

  async function flags() {
    try {
      return bayraklariNormalle(await readFlags())
    } catch {
      return { ...DEFAULT_ACCOUNT_FLAGS }
    }
  }

  /** Hesap kurulumu: kurtarma kodu üretilir, hesap kökü buluta yazılır. */
  async function initializeAccount(options = {}) {
    if (typeof initializeAccountFn !== 'function') throw new Error('sync_initialize_unavailable')
    const mevcut = await flags()
    if (mevcut.signedIn && mevcut.recoveryAcknowledged) {
      return { ok: false, reason: 'already_initialized' }
    }
    const sonuc = await initializeAccountFn(options)
    await writeFlags({
      signedIn: true,
      recoveryAcknowledged: false,
      uid: sonuc?.uid ?? mevcut.uid,
      email: sonuc?.email ?? mevcut.email,
    })
    return { ok: true, ...sonuc }
  }

  /** Yeni cihazı kurtarma koduyla bağlar. */
  async function linkDevice(recoveryCode, options = {}) {
    if (typeof linkDeviceFn !== 'function') throw new Error('sync_link_unavailable')
    const sonuc = await linkDeviceFn(recoveryCode, options)
    await writeFlags({
      signedIn: true,
      // Kurtarma kodu kullanıldıysa kod zaten kullanıcının elindedir.
      recoveryAcknowledged: true,
      uid: sonuc?.uid ?? null,
      email: sonuc?.email ?? null,
    })
    return { ok: true, ...sonuc }
  }

  /** Kullanıcı kurtarma kodunu kaydettiğini onaylar. */
  async function acknowledgeRecovery() {
    await writeFlags({ recoveryAcknowledged: true })
    return { ok: true }
  }

  /** Eşitlemeyi duraklatır; yerel veri akmaya devam eder. */
  async function pause() {
    await writeFlags({ paused: true })
    return { ok: true, paused: true }
  }

  /** Eşitlemeyi sürdürür ve hemen bir çevrim dener. */
  async function resume() {
    await writeFlags({ paused: false })
    return { ok: true, paused: false }
  }

  /** Tek çevrim; duraklatılmışsa hiç başlamaz. */
  async function syncNow() {
    const mevcut = await flags()
    if (mevcut.paused) return { skipped: 'paused' }
    const sonuc = await engine.runOnce()
    sonDurum = sonuc
    return sonuc
  }

  /** Arayüz için durum özeti. */
  async function getStatus() {
    const mevcut = await flags()
    const motor = engine.getStatus()
    const cevrimdisi = !isOnline()
    const badge = syncBadgeFor({
      syncState: motor.state,
      online: !cevrimdisi,
      paused: mevcut.paused,
    })
    return {
      accountState: resolveAccountState(mevcut),
      signedIn: mevcut.signedIn,
      email: mevcut.email,
      uid: mevcut.uid,
      paused: mevcut.paused,
      online: !cevrimdisi,
      syncState: motor.state,
      badge,
      lastRun: motor.lastRun || sonDurum || null,
      at: now(),
    }
  }

  /** Bu cihazın bağlantısını keser: yerel anahtarlar silinir, veriler kalır. */
  async function disconnect() {
    if (typeof disconnectDeviceFn === 'function') await disconnectDeviceFn()
    await writeFlags({
      signedIn: false,
      recoveryAcknowledged: false,
      paused: false,
      uid: null,
      email: null,
    })
    return { ok: true, accountState: ACCOUNT_STATE.DISCONNECTED }
  }

  /** Başka bir cihazın erişimini iptal eder; istenirse anahtarları döndürür. */
  async function revoke(deviceId, rotateKeys = false) {
    if (!deviceId) throw new Error('sync_device_id_missing')
    if (typeof revokeDeviceFn !== 'function') throw new Error('sync_revoke_unavailable')
    const sonuc = await revokeDeviceFn(deviceId, Boolean(rotateKeys))
    return { ok: true, rotated: Boolean(rotateKeys), ...sonuc }
  }

  /** Yedi günlük geri dönüş noktasından geri yükler. */
  async function restore(timestamp) {
    // `Number(null)` sıfır döner; boş değer açıkça reddedilir.
    if (timestamp === null || timestamp === undefined || !Number.isFinite(Number(timestamp))) {
      throw new Error('sync_restore_timestamp_invalid')
    }
    if (typeof restorePointFn !== 'function') throw new Error('sync_restore_unavailable')
    const sonuc = await restorePointFn(Number(timestamp))
    return { ok: true, ...sonuc }
  }

  /** Eşitlemeyi tamamen kapatır/açar (hesap bağlıyken). */
  async function setSyncEnabled(enabled) {
    await writeFlags({ syncEnabled: Boolean(enabled) })
    return { ok: true, syncEnabled: Boolean(enabled) }
  }

  return {
    initializeAccount,
    linkDevice,
    acknowledgeRecovery,
    pause,
    resume,
    syncNow,
    getStatus,
    disconnect,
    revoke,
    restore,
    setSyncEnabled,
  }
}

/** Servis arayüzünün tanıtımı (test ve dokümantasyon). */
export function describeSyncService() {
  return {
    methods: [
      'initializeAccount',
      'linkDevice',
      'acknowledgeRecovery',
      'pause',
      'resume',
      'syncNow',
      'getStatus',
      'disconnect',
      'revoke',
      'restore',
    ],
    badges: Object.values(SYNC_BADGE),
    states: Object.values(SYNC_STATE),
  }
}
