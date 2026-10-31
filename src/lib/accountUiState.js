/**
 * HeraAi 1.10.0 - state model of the "Account and Sync" UI (Stage 11).
 *
 * The UI component uses these pure functions: which screen to show, the sync badge text, the
 * first merge summary, the recovery kit text and the local chat policy. That keeps the
 * decisions testable and leaves the component with drawing only.
 */

import { SESSION_SYNC_POLICIES, normalizeSessionSyncPolicy } from './syncContract'
import { SYNC_STATE } from './syncEngine'
import { RECOVERY_CODE_GROUPS, RECOVERY_CODE_GROUP_SIZE } from './syncCrypto'

/** The three states of the account screen. */
export const ACCOUNT_STATE = Object.freeze({
  /** Not signed in. */
  DISCONNECTED: 'disconnected',
  /** Signed in but the recovery code has not been confirmed. */
  ONBOARDING: 'onboarding',
  /** Tam kurulum. */
  CONNECTED: 'connected',
})

/** Sync status badge. */
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

/** Local chat policy labels. */
export const SESSION_POLICY_LABELS = Object.freeze({
  synced: 'Bu sohbeti eşitle',
  local_only: 'Yalnız bu cihazda tut',
})

function sayi(deger) {
  const n = Number(deger)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Which screen to show?
 * If there is no sign-in `disconnected`; if signed in but the recovery code is not confirmed
 * `onboarding`; otherwise `connected`.
 */
export function resolveAccountState({ signedIn, recoveryAcknowledged } = {}) {
  if (!signedIn) return ACCOUNT_STATE.DISCONNECTED
  return recoveryAcknowledged === true ? ACCOUNT_STATE.CONNECTED : ACCOUNT_STATE.ONBOARDING
}

/**
 * Badge: if sync is paused, offline or failing those come before the "syncing" information; the
 * user must see the blocker first.
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

/** First merge summary: how much data will be carried over? */
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

/** Masked account info: first three characters + `***` + domain (`exa***@gmail.com`). */
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

/** Splits the recovery code into readable groups. */
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
 * Recovery kit text: the user downloads it as `.txt`.
 * The recovery code alone does not open the account; the device key is required too.
 */
export function recoveryKitText({ code, email, createdAt = null, locale = 'en' } = {}) {
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

/** Is the grouped display of the recovery code correct? */
export function recoveryCodeGroups(code) {
  const temiz = String(code || '').replace(/[^A-Za-z0-9]/g, '')
  return {
    groups: RECOVERY_CODE_GROUPS,
    groupSize: RECOVERY_CODE_GROUP_SIZE,
    complete: temiz.length === RECOVERY_CODE_GROUPS * RECOVERY_CODE_GROUP_SIZE,
    formatted: formatRecoveryCode(temiz),
  }
}

/** Local chat policy label. */
export function sessionPolicyLabel(policy) {
  return SESSION_POLICY_LABELS[normalizeSessionSyncPolicy(policy)]
}

/** Is the chat kept on this device only? */
export function isLocalOnlySession(policy) {
  return normalizeSessionSyncPolicy(policy) === 'local_only'
}

/** Menu options for changing the policy. */
export function sessionPolicyOptions() {
  return SESSION_SYNC_POLICIES.map(deger => ({
    value: deger,
    label: SESSION_POLICY_LABELS[deger],
  }))
}

/**
 * Row model for the "Manage devices" list.
 * Our own device is marked; a revoked device is shown separately.
 */
export function deviceRow({ device, currentDeviceId } = {}) {
  if (!device?.deviceId) return null
  const kendisi = device.deviceId === currentDeviceId
  return {
    deviceId: device.deviceId,
    label: device.name || device.deviceId.slice(0, 8),
    isCurrent: kendisi,
    revoked: Boolean(device.revokedAt),
    disabled: Boolean(device.disabledAt),
    lastSeenAt: device.lastSeenAt || null,
    canRevoke: !kendisi && !device.revokedAt,
    canToggle: !device.revokedAt,
    canRename: !device.revokedAt,
    canForceRemove: !kendisi,
  }
}

/** Destructive actions that need confirmation. */
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

/** Confirmation text; an unknown action returns `null`. */
export function confirmationFor(action) {
  return DESTRUCTIVE_CONFIRMATIONS[action] || null
}

/** Introduction of the UI layer (tests and documentation). */
export function describeAccountUi() {
  return {
    states: Object.values(ACCOUNT_STATE),
    badges: Object.values(SYNC_BADGE),
    policies: [...SESSION_SYNC_POLICIES],
    destructiveActions: Object.values(DESTRUCTIVE_ACTIONS),
  }
}
