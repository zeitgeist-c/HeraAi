/**
 * HeraAi 1.10.0 — "Hesap ve Eşitleme" arayüzünün durum modeli (Aşama 11).
 *
 * Arayüz bileşeni bu saf fonksiyonları kullanır: hangi ekranın gösterileceği,
 * eşitleme rozetinin metni, ilk birleştirme özeti, kurtarma kiti metni ve
 * yerel sohbet politikası. Böylece kararlar test edilebilir kalır, bileşen
 * yalnızca çizim yapar.
 */

import { SESSION_SYNC_POLICIES, normalizeSessionSyncPolicy } from './syncContract'
import { SYNC_STATE } from './syncEngine'
import { RECOVERY_CODE_GROUPS, RECOVERY_CODE_GROUP_SIZE } from './syncCrypto'

/** Hesap ekranının üç hâli. */
export const ACCOUNT_STATE = Object.freeze({
  /** Giriş yapılmamış. */
  DISCONNECTED: 'disconnected',
  /** Giriş yapıldı ama kurtarma kodu onaylanmadı. */
  ONBOARDING: 'onboarding',
  /** Tam kurulum. */
  CONNECTED: 'connected',
})

/** Eşitleme durumu rozeti. */
export const SYNC_BADGE = Object.freeze({
  UP_TO_DATE: 'up_to_date',
  SYNCING: 'syncing',
  OFFLINE: 'offline',
  ERROR: 'error',
  PAUSED: 'paused',
})

export const SYNC_BADGE_LABELS = Object.freeze({
  [SYNC_BADGE.UP_TO_DATE]: 'Güncel',
  [SYNC_BADGE.SYNCING]: 'Eşitleniyor',
  [SYNC_BADGE.OFFLINE]: 'Çevrimdışı',
  [SYNC_BADGE.ERROR]: 'Hata',
  [SYNC_BADGE.PAUSED]: 'Duraklatıldı',
})

export const ACCOUNT_STATE_LABELS = Object.freeze({
  [ACCOUNT_STATE.DISCONNECTED]: 'Bağlı değil',
  [ACCOUNT_STATE.ONBOARDING]: 'İlk kurulum',
  [ACCOUNT_STATE.CONNECTED]: 'Bağlı',
})

/** Yerel sohbet politikası etiketleri. */
export const SESSION_POLICY_LABELS = Object.freeze({
  synced: 'Bu sohbeti eşitle',
  local_only: 'Yalnız bu cihazda tut',
})

function sayi(deger) {
  const n = Number(deger)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Hangi ekran gösterilecek?
 * Giriş yoksa `disconnected`; giriş var ama kurtarma kodu onaylanmadıysa
 * `onboarding`; aksi halde `connected`.
 */
export function resolveAccountState({ signedIn, recoveryAcknowledged } = {}) {
  if (!signedIn) return ACCOUNT_STATE.DISCONNECTED
  return recoveryAcknowledged === true ? ACCOUNT_STATE.CONNECTED : ACCOUNT_STATE.ONBOARDING
}

/**
 * Rozet: eşitleme duraklatıldıysa, çevrimdışıysa ya da hata varsa bunlar
 * "eşitleniyor" bilgisinden önce gelir; kullanıcı önce engeli görmeli.
 */
export function syncBadgeFor({ syncState, online = true, paused = false } = {}) {
  if (paused) return SYNC_BADGE.PAUSED
  if (!online) return SYNC_BADGE.OFFLINE
  if (syncState === SYNC_STATE.ERROR) return SYNC_BADGE.ERROR
  if (syncState === SYNC_STATE.SYNCING) return SYNC_BADGE.SYNCING
  if (syncState === SYNC_STATE.OFFLINE) return SYNC_BADGE.OFFLINE
  return SYNC_BADGE.UP_TO_DATE
}

export function syncBadgeLabel(badge) {
  return SYNC_BADGE_LABELS[badge] || SYNC_BADGE_LABELS[SYNC_BADGE.UP_TO_DATE]
}

/** İlk birleştirme özeti: ne kadar veri taşınacak? */
export function firstMergeSummary({ sessions = 0, settings = 0, apiKeys = 0 } = {}) {
  const sohbet = sayi(sessions)
  const ayar = sayi(settings)
  const anahtar = sayi(apiKeys)
  return {
    sessions: sohbet,
    settings: ayar,
    apiKeys: anahtar,
    total: sohbet + ayar + anahtar,
    isEmpty: sohbet + ayar + anahtar === 0,
    label: `${sohbet} sohbet · ${ayar} ayar · ${anahtar} API anahtarı`,
  }
}

/** Maskelenmiş hesap bilgisi: `mah***@gmail.com`. */
export function maskAccount(email) {
  const ham = String(email || '').trim()
  if (!ham) return ''
  const at = ham.indexOf('@')
  if (at <= 0) return ham.length <= 2 ? '***' : `${ham.slice(0, 2)}***`
  const kullanici = ham.slice(0, at)
  const alan = ham.slice(at)
  if (kullanici.length <= 2) return `***${alan}`
  return `${kullanici.slice(0, 3)}***${alan}`
}

/** Kurtarma kodunu okunaklı gruplara ayırır. */
export function formatRecoveryCode(code) {
  const temiz = String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  const gruplar = []
  for (let i = 0; i < temiz.length; i += RECOVERY_CODE_GROUP_SIZE) {
    gruplar.push(temiz.slice(i, i + RECOVERY_CODE_GROUP_SIZE))
  }
  return gruplar.join('-')
}

/**
 * Kurtarma kiti metni: kullanıcı `.txt` olarak indirir.
 * Kurtarma kodu tek başına hesabı açmaz; cihaz anahtarı da gerekir.
 */
export function recoveryKitText({ code, email, createdAt = null, locale = 'tr' } = {}) {
  const duzenli = formatRecoveryCode(code)
  const tarih = createdAt ? new Date(createdAt).toISOString().slice(0, 10) : ''
  const baslik = locale === 'tr' ? 'HeraAi Kurtarma Kiti' : 'HeraAi Recovery Kit'
  const satirlar = [
    baslik,
    '='.repeat(baslik.length),
    '',
    locale === 'tr' ? `Hesap: ${maskAccount(email)}` : `Account: ${maskAccount(email)}`,
    tarih ? (locale === 'tr' ? `Oluşturma: ${tarih}` : `Created: ${tarih}`) : null,
    '',
    locale === 'tr' ? 'Kurtarma kodu:' : 'Recovery code:',
    duzenli,
    '',
    locale === 'tr'
      ? 'Bu kod, şifreli eşitleme verilerinize yeni bir cihazdan erişmenizi sağlar.'
      : 'This code lets you access your encrypted sync data from a new device.',
    locale === 'tr'
      ? 'Güvenli bir yerde saklayın; kaybederseniz bulut verileri kurtarılamaz.'
      : 'Store it safely; if lost, cloud data cannot be recovered.',
    locale === 'tr'
      ? 'HeraAi bu kodu göremez ve sizin adınıza saklayamaz.'
      : 'HeraAi cannot see or store this code on your behalf.',
    '',
  ]
  return satirlar.filter(s => s !== null).join('\n')
}

/** Kurtarma kodunun gruplu gösterimi doğru mu? */
export function recoveryCodeGroups(code) {
  const temiz = String(code || '').replace(/[^A-Za-z0-9]/g, '')
  return {
    groups: RECOVERY_CODE_GROUPS,
    groupSize: RECOVERY_CODE_GROUP_SIZE,
    complete: temiz.length === RECOVERY_CODE_GROUPS * RECOVERY_CODE_GROUP_SIZE,
    formatted: formatRecoveryCode(temiz),
  }
}

/** Yerel sohbet politikası etiketi. */
export function sessionPolicyLabel(policy) {
  return SESSION_POLICY_LABELS[normalizeSessionSyncPolicy(policy)]
}

/** Sohbet yalnız bu cihazda mı tutuluyor? */
export function isLocalOnlySession(policy) {
  return normalizeSessionSyncPolicy(policy) === 'local_only'
}

/** Politikayı değiştirmek için menü seçenekleri. */
export function sessionPolicyOptions() {
  return SESSION_SYNC_POLICIES.map(deger => ({
    value: deger,
    label: SESSION_POLICY_LABELS[deger],
  }))
}

/**
 * "Cihazları yönet" listesi için satır modeli.
 * Kendi cihazımız işaretlenir; iptal edilmiş cihaz ayrı gösterilir.
 */
export function deviceRow({ device, currentDeviceId } = {}) {
  if (!device?.deviceId) return null
  const kendisi = device.deviceId === currentDeviceId
  return {
    deviceId: device.deviceId,
    label: device.name || device.deviceId.slice(0, 8),
    isCurrent: kendisi,
    revoked: Boolean(device.revokedAt),
    lastSeenAt: device.lastSeenAt || null,
    canRevoke: !kendisi && !device.revokedAt,
    canForceRemove: !kendisi,
  }
}

/** Onay gerektiren yıkıcı işlemler. */
export const DESTRUCTIVE_ACTIONS = Object.freeze({
  DISCONNECT_DEVICE: 'disconnect_device',
  DELETE_ALL_CLOUD_DATA: 'delete_all_cloud_data',
  FORCE_REMOVE_DEVICE: 'force_remove_device',
})

export const DESTRUCTIVE_CONFIRMATIONS = Object.freeze({
  [DESTRUCTIVE_ACTIONS.DISCONNECT_DEVICE]: {
    title: 'Bu cihazın bağlantısını kes',
    body: 'Bu cihazdaki şifreli anahtarlar silinir. Yerel sohbetleriniz ve ayarlarınız korunur.',
    confirmLabel: 'Bağlantıyı kes',
  },
  [DESTRUCTIVE_ACTIONS.DELETE_ALL_CLOUD_DATA]: {
    title: 'Hesaptaki tüm bulut verilerini sil',
    body: 'Buluttaki tüm şifreli veriler silinir. Bu işlem geri alınamaz; diğer cihazlar yerel kopyalarını korur.',
    confirmLabel: 'Tümünü sil',
  },
  [DESTRUCTIVE_ACTIONS.FORCE_REMOVE_DEVICE]: {
    title: 'Cihazı zorla kaldır',
    body: 'Cihazın erişimi iptal edilir ve eşitleme anahtarı yenilenir. Cihaz yeniden bağlanmadan veri göremez.',
    confirmLabel: 'Zorla kaldır',
  },
})

/** Onay metni; bilinmeyen işlem `null` döner. */
export function confirmationFor(action) {
  return DESTRUCTIVE_CONFIRMATIONS[action] || null
}

/** Arayüz katmanının tanıtımı (test ve dokümantasyon). */
export function describeAccountUi() {
  return {
    states: Object.values(ACCOUNT_STATE),
    badges: Object.values(SYNC_BADGE),
    policies: [...SESSION_SYNC_POLICIES],
    destructiveActions: Object.values(DESTRUCTIVE_ACTIONS),
  }
}
