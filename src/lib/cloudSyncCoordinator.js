import { getCurrentAuthUser, waitForCurrentAuthUser } from './authService'
import { createFirestoreTransport } from './firestoreTransport'
import { getAttachment } from './attachmentStore'
import { normalizeSessionAttachmentMetadata } from './attachmentSyncPolicy'
import { buildBackupPayload, decryptBackup, encryptBackup } from './backupRestore'
import {
  VAULT_STORES,
  idbGet,
  idbPut,
} from './idb'
import {
  PROVIDERS,
  createKeyVault,
  loadOrCreateDeviceKey,
  openVaultDatabase,
} from './keyVault'
import { createStorageAdapter, migrateLegacyKeys } from './v194Migration'
import { getKeysByClass, SYNC_CLASS, isSyncedKey } from './syncContract'
import { createSyncEngine, QUEUE_OP } from './syncEngine'
import {
  buildAccountRootDocument,
  buildDeviceDocument,
  createEntityVersion,
  MAX_DEVICE_LABEL_LENGTH,
} from './syncModel'
import {
  deriveSubkeys,
  generateMasterSecretBytes,
  generateRecoveryCode,
  importMasterSecret,
  openMasterSecretFromRecovery,
  sealMasterSecretForRecovery,
  unwrapMasterSecretFromDevice,
  wrapMasterSecretForDevice,
} from './syncCrypto'
import {
  AUTO_SYNC_INTERVAL_KEY,
  AUTO_SYNC_USAGE_KEY,
  isSlowMode,
  normalizeAutoSyncMinutes,
  quotaUsageRatio,
} from './autoSyncScheduler'

const DEVICE_ID_KEY = 'syncDeviceId'
const SYNC_ENABLED_KEY = 'syncEnabled'
const SYNC_PAUSED_KEY = 'syncPaused'
const LAST_SYNC_KEY = 'syncLastSuccessAt'
const LAST_ERROR_KEY = 'syncLastError'
const BLOCKED_UNTIL_KEY = 'syncBlockedUntil'
const LEGACY_CLEANUP_KEY = 'legacyCloudCleanupCompletedAt'
const ATTACHMENT_POLICY_MIGRATION_KEY = 'attachmentCloudPolicyV2MigratedAt'
const KEY_CHANGE_MARKER = 'syncVaultUpdatedAt'
const KEY_TOMBSTONES = 'syncKeyTombstones'
const AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000
/** Panel ayarı: otomatik eşitleme aralığı (dakika; 0 = kapalı). Cihaza özel. */
const AUTO_SYNC_SETTING_KEY = AUTO_SYNC_INTERVAL_KEY
/** Eşitleme kilidi: aynı anda iki koşu olmaz. Bayat kilit devralınır. */
const SYNC_LEASE_KEY = 'syncLease'
const SYNC_LEASE_TTL_MS = 5 * 60 * 1000

let runtimePromise = null
let cachedSubkeys = null
let listenerInstalled = false
/** Aynı anda tek eşitleme koşusu (bellek kilidi). */
let activeRun = false
const remoteWrites = new Map()

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(keys, result => {
        const error = chrome.runtime?.lastError
        if (error) reject(new Error(error.message))
        else resolve(result || {})
      })
    } catch (error) {
      reject(error)
    }
  })
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(value, () => {
        const error = chrome.runtime?.lastError
        if (error) reject(new Error(error.message))
        else resolve()
      })
    } catch (error) {
      reject(error)
    }
  })
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.remove(keys, () => {
        const error = chrome.runtime?.lastError
        if (error) reject(new Error(error.message))
        else resolve()
      })
    } catch (error) {
      reject(error)
    }
  })
}

function randomId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function mapCloudSyncError(error) {
  const raw = String(error?.code || error?.message || '').toLowerCase()
  if (raw.includes('resource-exhausted') || raw.includes('quota')) return 'quota_exceeded'
  if (raw.includes('permission-denied')) return 'rules_denied'
  if (raw.includes('device_disabled')) return 'sync_device_disabled'
  if (raw.includes('unauthenticated') || raw.includes('signed_out')) return 'sync_signed_out'
  if (raw.includes('unavailable') || raw.includes('network') || raw.includes('offline')) return 'offline'
  if (raw.includes('version_unsupported')) return 'sync_version_unsupported'
  if (raw.includes('chunk_incomplete')) return 'sync_chunk_incomplete'
  if (raw.includes('payload_invalid')) return 'sync_payload_invalid'
  return 'sync_failed'
}

export function nextPacificQuotaReset(now = Date.now()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  })
  const partsAt = value => Object.fromEntries(
    formatter.formatToParts(new Date(value)).map(part => [part.type, part.value]),
  )
  const current = partsAt(now)
  const step = 60 * 1000
  const firstCandidate = Math.floor(now / step) * step + step
  for (let candidate = firstCandidate; candidate <= now + 48 * 60 * 60 * 1000; candidate += step) {
    const parts = partsAt(candidate)
    if (`${parts.year}-${parts.month}-${parts.day}` !== `${current.year}-${current.month}-${current.day}`
      && parts.hour === '01' && parts.minute === '00') return candidate
  }
  return now + 26 * 60 * 60 * 1000
}

export function cloudSyncWakeReason(status, now = Date.now()) {
  if (status?.[SYNC_ENABLED_KEY] !== true) return 'disabled'
  if (status?.[SYNC_PAUSED_KEY] === true) return 'paused'
  if (Number(status?.[BLOCKED_UNTIL_KEY]) > now) return 'quota_blocked'
  if (now - Number(status?.[LAST_SYNC_KEY] || 0) < AUTO_SYNC_INTERVAL_MS) return 'recently_synced'
  return null
}

/**
 * Kota Pasifik gece yarısında sıfırlandığı için sayaç da o güne göre tutulur;
 * gün değişince önceki günün sayacı kendiliğinden sıfırlanır.
 */
export function pacificDayKey(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now))
}

/** Bugünün kota sayacı (farklı günden kalan değer sıfır sayılır). */
export function currentUsage(storedUsage, now = Date.now()) {
  const dayKey = pacificDayKey(now)
  const value = storedUsage?.dayKey === dayKey ? storedUsage : null
  return {
    dayKey,
    reads: Math.max(0, Number(value?.reads) || 0),
    writes: Math.max(0, Number(value?.writes) || 0),
  }
}

/**
 * Koşu başına işlem sayacı (tahmini). Panel bu değeri gösterir ve yavaş mod
 * kararını verir. Tahmin: koşu başına 1 okuma (cihaz durumu) + 1 yazma
 * ("son görülme"); gönderilen kayıt başına 1 işlem okuması + 2 yazma
 * (kayıt + parça); çekilen kayıt başına 2 okuma (meta + parça).
 */
async function recordSyncUsage(result) {
  const stored = await storageGet([AUTO_SYNC_USAGE_KEY])
  const usage = currentUsage(stored[AUTO_SYNC_USAGE_KEY])
  const pushed = Math.max(0, Number(result?.pushed) || 0)
  const applied = Math.max(0, Number(result?.applied) || 0)
  await storageSet({
    [AUTO_SYNC_USAGE_KEY]: {
      dayKey: usage.dayKey,
      reads: usage.reads + 1 + pushed + applied * 2,
      writes: usage.writes + 1 + pushed * 2,
    },
  })
}

/** Panel ayarı + bugünkü kota kullanımı. */
export async function getAutoSyncSettings() {
  const stored = await storageGet([AUTO_SYNC_SETTING_KEY, AUTO_SYNC_USAGE_KEY])
  const usage = currentUsage(stored[AUTO_SYNC_USAGE_KEY])
  return {
    intervalMinutes: normalizeAutoSyncMinutes(stored[AUTO_SYNC_SETTING_KEY]),
    usage,
    ratio: quotaUsageRatio(usage),
    slowMode: isSlowMode(usage),
  }
}

/** Otomatik eşitleme aralığını kaydeder (cihaza özel; eşitlenmez). */
export async function setAutoSyncInterval(minutes) {
  const value = normalizeAutoSyncMinutes(minutes)
  await storageSet({ [AUTO_SYNC_SETTING_KEY]: value })
  return { intervalMinutes: value }
}

async function getOrCreateDeviceId() {
  const stored = await storageGet([DEVICE_ID_KEY])
  if (stored[DEVICE_ID_KEY]) return stored[DEVICE_ID_KEY]
  const deviceId = randomId()
  await storageSet({ [DEVICE_ID_KEY]: deviceId })
  return deviceId
}

function deviceLabel() {
  const platform = globalThis.navigator?.userAgentData?.platform
    || globalThis.navigator?.platform
    || 'Chrome'
  return `HeraAi - ${platform}`
}

async function markRemoteWrite(key, value) {
  remoteWrites.set(key, JSON.stringify(value))
  await storageSet({ [key]: value })
}

function consumeRemoteWrite(key, value) {
  const expected = remoteWrites.get(key)
  if (expected === undefined || expected !== JSON.stringify(value)) return false
  remoteWrites.delete(key)
  return true
}

async function createRuntime() {
  const db = await openVaultDatabase()
  const deviceKey = await loadOrCreateDeviceKey(db)
  const vault = createKeyVault({ db, deviceKey })
  const storage = createStorageAdapter()
  if (storage.available) await migrateLegacyKeys({ storage, vault })
  const deviceId = await getOrCreateDeviceId()
  const transport = createFirestoreTransport()

  async function normalizeSessionAttachments(session) {
    return normalizeSessionAttachmentMetadata(session, async id => Boolean(await getAttachment(id)))
  }

  async function readPayload(storageKey, logicalId) {
    if (storageKey === 'sessions') {
      const stored = await storageGet(['sessions'])
      const session = (stored.sessions || []).find(item => String(item.id) === String(logicalId))
      if (!session || session.syncPolicy === 'local_only') return null
      return { storageKey, logicalId, value: await normalizeSessionAttachments(session) }
    }
    if (storageKey.endsWith('ApiKeys')) {
      const provider = storageKey.replace('ApiKeys', '').replace('openRouter', 'openrouter')
      const metadata = (await vault.listKeys(provider)).find(item => item.id === logicalId)
      if (!metadata) return null
      const key = await vault.getRawKey(provider, logicalId)
      return { storageKey, logicalId, provider, metadata, key }
    }
    const stored = await storageGet([storageKey])
    return { storageKey, logicalId, value: stored[storageKey] }
  }

  async function readLocalVersion(_entityType, opaqueEntityId) {
    const record = await idbGet(db, VAULT_STORES.meta, `syncVersion:${opaqueEntityId}`)
    return record?.entityVersion || null
  }

  async function saveRemoteVersion(change) {
    await idbPut(db, VAULT_STORES.meta, {
      id: `syncVersion:${change.opaqueEntityId}`,
      entityVersion: change.entityVersion,
      savedAt: Date.now(),
    })
  }

  async function applyRemote(change) {
    const { payload, deleted } = change
    const storageKey = payload?.storageKey
    const logicalId = payload?.logicalId
    if (!storageKey || !isSyncedKey(storageKey)) return false

    if (storageKey === 'sessions') {
      const stored = await storageGet(['sessions'])
      const sessions = Array.isArray(stored.sessions) ? [...stored.sessions] : []
      const index = sessions.findIndex(item => String(item.id) === String(logicalId))
      if (deleted) {
        if (index >= 0) sessions.splice(index, 1)
      } else if (payload.value?.syncPolicy !== 'local_only') {
        const hydrated = await normalizeSessionAttachments(payload.value)
        if (index >= 0) sessions[index] = hydrated
        else sessions.push(hydrated)
      }
      await markRemoteWrite('sessions', sessions)
    } else if (storageKey.endsWith('ApiKeys')) {
      const provider = payload.provider
        || storageKey.replace('ApiKeys', '').replace('openRouter', 'openrouter')
      if (!PROVIDERS.includes(provider)) return false
      const existing = (await vault.listKeys(provider)).find(item => item.id === logicalId)
      if (deleted) {
        if (existing) await vault.removeKey(provider, logicalId)
      } else if (!existing && payload.key) {
        await vault.addKey(provider, payload.key, {
          id: logicalId,
          label: payload.metadata?.label,
          isPrimary: payload.metadata?.isPrimary,
          createdAt: payload.metadata?.createdAt,
          fingerprint: payload.metadata?.fingerprint,
          model: payload.metadata?.model,
        })
        await vault.updateKeyMetadata(provider, logicalId, payload.metadata || {})
      } else if (existing) {
        await vault.updateKeyMetadata(provider, logicalId, payload.metadata || {})
      }
      await markRemoteWrite(KEY_CHANGE_MARKER, Date.now())
    } else if (!deleted) {
      await markRemoteWrite(storageKey, payload.value)
    }

    await saveRemoteVersion(change)
    return true
  }

  const engine = createSyncEngine({
    db,
    deviceId,
    getUid: () => getCurrentAuthUser()?.uid || null,
    getSubkeys: async () => {
      if (!cachedSubkeys) throw new Error('sync_device_not_linked')
      return cachedSubkeys
    },
    readPayload,
    applyRemote,
    readLocalVersion,
    transport,
    isOnline: () => globalThis.navigator?.onLine !== false,
    onState: (state, detail) => {
      storageSet({ syncState: state, syncStateDetail: detail }).catch(() => undefined)
    },
  })

  const migrationState = await storageGet([ATTACHMENT_POLICY_MIGRATION_KEY, 'sessions'])
  if (!migrationState[ATTACHMENT_POLICY_MIGRATION_KEY]) {
    const sessions = Array.isArray(migrationState.sessions) ? migrationState.sessions : []
    const normalized = []
    const changedIds = []
    for (const session of sessions) {
      const next = await normalizeSessionAttachments(session)
      normalized.push(next)
      if (JSON.stringify(next) !== JSON.stringify(session)) changedIds.push(session.id)
    }
    if (changedIds.length > 0) {
      await markRemoteWrite('sessions', normalized)
      for (const sessionId of changedIds) {
        await engine.enqueue({
          storageKey: 'sessions',
          logicalId: sessionId,
          entityType: 'session',
          entityVersion: newVersion(deviceId),
        })
      }
    }
    await storageSet({ [ATTACHMENT_POLICY_MIGRATION_KEY]: Date.now() })
  }

  return { db, deviceKey, vault, deviceId, transport, engine, normalizeSessionAttachments }
}

async function getRuntime() {
  if (!runtimePromise) runtimePromise = createRuntime().catch(error => {
    runtimePromise = null
    throw error
  })
  return runtimePromise
}

async function cacheMasterSecret(masterBytes) {
  cachedSubkeys = await deriveSubkeys(await importMasterSecret(masterBytes))
}

/**
 * Kendi cihaz belgesini bir kez okur; "kullanılabilir" (eşitlemeye hazır) ile
 * "kapatılmış" durumunu ayırır. Kapalı cihaz kurtarma ekranına düşmemeli ama
 * eşitleme de yapmamalı — ayrım bu yüzden ayrı alanlarla raporlanır.
 */
async function loadLinkedDeviceState(runtime, user) {
  const device = await runtime.transport.getDevice(user.uid, runtime.deviceId)
  const hasEnvelope = Boolean(device?.deviceMasterKeyEnvelope)
  const revoked = Boolean(device?.revokedAt)
  const disabled = Boolean(device?.disabledAt)
  const usable = hasEnvelope && !revoked && !disabled
  if (usable && !cachedSubkeys) {
    const masterBytes = await unwrapMasterSecretFromDevice(
      runtime.deviceKey,
      device.deviceMasterKeyEnvelope,
    )
    await cacheMasterSecret(masterBytes)
  }
  return { linked: usable, hasEnvelope, revoked, disabled }
}

function newVersion(deviceId) {
  return createEntityVersion({ wallTimeMs: Date.now(), deviceId })
}

async function enqueueAllKeys(runtime) {
  const storageNames = {
    gemini: 'geminiApiKeys',
    tavily: 'tavilyApiKeys',
    openrouter: 'openRouterApiKeys',
    ollama: 'ollamaApiKeys',
  }
  for (const provider of PROVIDERS) {
    for (const key of await runtime.vault.listKeys(provider)) {
      await runtime.engine.enqueue({
        storageKey: storageNames[provider],
        logicalId: key.id,
        entityType: 'api_key',
        entityVersion: newVersion(runtime.deviceId),
      })
    }
  }
  const stored = await storageGet([KEY_TOMBSTONES])
  for (const combinedId of Object.keys(stored[KEY_TOMBSTONES] || {})) {
    const separator = combinedId.indexOf(':')
    const provider = combinedId.slice(0, separator)
    const logicalId = combinedId.slice(separator + 1)
    if (!storageNames[provider] || !logicalId) continue
    await runtime.engine.enqueue({
      storageKey: storageNames[provider],
      logicalId,
      entityType: 'api_key',
      op: QUEUE_OP.DELETE,
      entityVersion: newVersion(runtime.deviceId),
    })
  }
}

/**
 * Yerel sohbetleri kuyruğa alır (yerel-only hariç). Hesaba ilk bağlanmada
 * çağrılır: bağlanmadan önce oluşmuş sohbetler yoksa hiçbir cihaza gitmez.
 */
async function enqueueLocalSessions(runtime) {
  const stored = await storageGet(['sessions'])
  for (const session of stored.sessions || []) {
    if (!session?.id || session.syncPolicy === 'local_only') continue
    await runtime.engine.enqueue({
      storageKey: 'sessions',
      logicalId: session.id,
      entityType: 'session',
      entityVersion: newVersion(runtime.deviceId),
    })
  }
}

async function enqueueSnapshot(runtime) {
  const settings = getKeysByClass(SYNC_CLASS.SETTING)
  const stored = await storageGet([...settings, 'stats'])
  for (const key of settings) {
    if (stored[key] === undefined) continue
    await runtime.engine.enqueue({
      storageKey: key,
      logicalId: key,
      entityType: 'setting',
      entityVersion: newVersion(runtime.deviceId),
    })
  }
  await enqueueLocalSessions(runtime)
  if (stored.stats !== undefined) {
    await runtime.engine.enqueue({
      storageKey: 'stats',
      logicalId: 'stats',
      entityType: 'stats_day',
      entityVersion: newVersion(runtime.deviceId),
    })
  }
  await enqueueAllKeys(runtime)
}

export async function initializeCloudSync() {
  const user = await waitForCurrentAuthUser()
  if (!user) throw new Error('sync_signed_out')
  const runtime = await getRuntime()
  const existingAccount = await runtime.transport.getAccountRoot(user.uid)
  if (existingAccount) throw new Error('sync_account_exists')

  const masterBytes = generateMasterSecretBytes()
  const recoveryCode = generateRecoveryCode()
  const [recoveryEnvelope, deviceEnvelope] = await Promise.all([
    sealMasterSecretForRecovery(masterBytes, recoveryCode),
    wrapMasterSecretForDevice(runtime.deviceKey, masterBytes),
  ])
  const now = Date.now()
  await runtime.transport.setAccountRoot(user.uid, buildAccountRootDocument({
    createdAt: now,
    recoveryEnvelope,
  }))
  await runtime.transport.setDevice(user.uid, runtime.deviceId, buildDeviceDocument({
    deviceId: runtime.deviceId,
    label: deviceLabel(),
    platform: globalThis.navigator?.platform || null,
    browser: globalThis.navigator?.userAgent || null,
    createdAt: now,
    lastSeenAt: now,
    deviceMasterKeyEnvelope: deviceEnvelope,
  }))
  await cacheMasterSecret(masterBytes)
  await storageSet({ [SYNC_ENABLED_KEY]: true, [SYNC_PAUSED_KEY]: false })
  await enqueueSnapshot(runtime)
  await runCloudSync()
  return { recoveryCode }
}

export async function linkCloudSyncDevice(recoveryCode) {
  const user = await waitForCurrentAuthUser()
  if (!user) throw new Error('sync_signed_out')
  const runtime = await getRuntime()
  const account = await runtime.transport.getAccountRoot(user.uid)
  if (!account?.recoveryEnvelope) throw new Error('sync_account_missing')
  const masterBytes = await openMasterSecretFromRecovery(account.recoveryEnvelope, recoveryCode)
  const deviceEnvelope = await wrapMasterSecretForDevice(runtime.deviceKey, masterBytes)
  const now = Date.now()
  // Başka bir cihazdan verilmiş ad varsa korunur; yeniden bağlanma adı sıfırlamaz.
  const existingDevice = await runtime.transport.getDevice(user.uid, runtime.deviceId)
  await runtime.transport.setDevice(user.uid, runtime.deviceId, buildDeviceDocument({
    deviceId: runtime.deviceId,
    label: existingDevice?.label || deviceLabel(),
    platform: globalThis.navigator?.platform || null,
    browser: globalThis.navigator?.userAgent || null,
    createdAt: now,
    lastSeenAt: now,
    deviceMasterKeyEnvelope: deviceEnvelope,
  }))
  await cacheMasterSecret(masterBytes)
  await storageSet({ [SYNC_ENABLED_KEY]: true, [SYNC_PAUSED_KEY]: false })
  // Bağlanmadan önce bu cihazda oluşmuş sohbetler hesaba taşınır; yoksa geçmiş
  // yalnız bu cihazda kalır ve diğer cihazlarda hiç görünmez. Ayarlar bilinçli
  // olarak gönderilmez: yeni cihazın varsayılanları hesabınkini ezmemeli.
  await enqueueLocalSessions(runtime)
  await runCloudSync()
  return { linked: true }
}

export async function regenerateCloudRecoveryCode() {
  const user = await waitForCurrentAuthUser()
  if (!user) throw new Error('sync_signed_out')
  const runtime = await getRuntime()
  const account = await runtime.transport.getAccountRoot(user.uid)
  if (!account) throw new Error('sync_account_missing')
  const device = await runtime.transport.getDevice(user.uid, runtime.deviceId)
  if (!device?.deviceMasterKeyEnvelope || device.revokedAt) {
    throw new Error('sync_recovery_required')
  }
  if (device.disabledAt) throw new Error('sync_device_disabled')

  const masterBytes = await unwrapMasterSecretFromDevice(
    runtime.deviceKey,
    device.deviceMasterKeyEnvelope,
  )
  const recoveryCode = generateRecoveryCode()
  const recoveryEnvelope = await sealMasterSecretForRecovery(masterBytes, recoveryCode)
  await runtime.transport.setAccountRoot(user.uid, {
    recoveryEnvelope,
    keyRotationIndex: (Number(account.keyRotationIndex) || 0) + 1,
  })
  await cacheMasterSecret(masterBytes)
  return { recoveryCode }
}

export async function getCloudSyncStatus() {
  const user = await waitForCurrentAuthUser()
  const stored = await storageGet([
    SYNC_ENABLED_KEY,
    SYNC_PAUSED_KEY,
    LAST_SYNC_KEY,
    LAST_ERROR_KEY,
    BLOCKED_UNTIL_KEY,
    LEGACY_CLEANUP_KEY,
    DEVICE_ID_KEY,
  ])
  if (!user) return { signedIn: false, ...stored, state: 'signed_out' }
  const runtime = await getRuntime()
  const localStatus = {
    signedIn: true,
    user,
    enabled: stored[SYNC_ENABLED_KEY] === true,
    paused: stored[SYNC_PAUSED_KEY] === true,
    lastSyncAt: stored[LAST_SYNC_KEY] || null,
    lastError: stored[LAST_ERROR_KEY] || null,
    lastErrorCode: stored[LAST_ERROR_KEY] || null,
    blockedUntil: stored[BLOCKED_UNTIL_KEY] || null,
    legacyCleanupCompletedAt: stored[LEGACY_CLEANUP_KEY] || null,
    deviceId: runtime.deviceId,
    pending: await runtime.engine.pendingCount(),
  }
  if (Number(stored[BLOCKED_UNTIL_KEY]) > Date.now()) {
    return {
      ...localStatus,
      accountExists: null,
      linked: Boolean(cachedSubkeys),
      cloudUnavailable: true,
      lastError: 'quota_exceeded',
      lastErrorCode: 'quota_exceeded',
      state: 'quota_blocked',
    }
  }
  try {
    const account = await runtime.transport.getAccountRoot(user.uid)
    const deviceState = account ? await loadLinkedDeviceState(runtime, user) : null
    const linked = Boolean(deviceState?.hasEnvelope && !deviceState.revoked)
    return {
      ...localStatus,
      accountExists: Boolean(account),
      linked,
      deviceDisabled: Boolean(deviceState?.disabled),
      cloudUnavailable: false,
      state: deviceState?.linked
        ? runtime.engine.getStatus().state
        : deviceState?.disabled
          ? 'device_disabled'
          : account ? 'recovery_required' : 'setup_required',
    }
  } catch (error) {
    const errorCode = mapCloudSyncError(error)
    const blockedUntil = errorCode === 'quota_exceeded'
      ? nextPacificQuotaReset()
      : localStatus.blockedUntil
    await storageSet({
      [LAST_ERROR_KEY]: errorCode,
      ...(blockedUntil ? { [BLOCKED_UNTIL_KEY]: blockedUntil } : {}),
    })
    return {
      ...localStatus,
      accountExists: null,
      linked: Boolean(cachedSubkeys),
      cloudUnavailable: true,
      lastError: errorCode,
      lastErrorCode: errorCode,
      blockedUntil,
      state: errorCode,
    }
  }
}

async function performCloudSyncRun() {
  try {
    const user = await waitForCurrentAuthUser()
    if (!user) throw new Error('sync_signed_out')
    const runtime = await getRuntime()
    const stored = await storageGet([SYNC_ENABLED_KEY, SYNC_PAUSED_KEY, BLOCKED_UNTIL_KEY])
    if (stored[SYNC_ENABLED_KEY] !== true) throw new Error('sync_not_enabled')
    if (stored[SYNC_PAUSED_KEY] === true) return { skipped: 'paused' }
    if (Number(stored[BLOCKED_UNTIL_KEY]) > Date.now()) throw new Error('quota_exceeded')
    const deviceState = await loadLinkedDeviceState(runtime, user)
    if (deviceState.disabled) return { skipped: 'device_disabled' }
    if (!deviceState.linked) throw new Error('sync_recovery_required')
    const result = await runtime.engine.drain()
    // Atlanan tur (lease/kilit/oturum) basarili sayilmaz: aksi halde panel
    // "yeni eslendi" gosterir ve bekleyen anahtar silme isaretleri kaybolur.
    if (result?.skipped) return result
    const now = Date.now()
    await runtime.transport.setDevice(user.uid, runtime.deviceId, {
      lastSeenAt: now,
      lastSyncedAt: now,
    })
    await storageSet({ [LAST_SYNC_KEY]: now, [LAST_ERROR_KEY]: null, [BLOCKED_UNTIL_KEY]: null })
    await storageSet({ [KEY_TOMBSTONES]: {} })
    await recordSyncUsage(result)
    return result
  } catch (error) {
    const errorCode = mapCloudSyncError(error)
    const update = { [LAST_ERROR_KEY]: errorCode }
    if (errorCode === 'quota_exceeded') update[BLOCKED_UNTIL_KEY] = nextPacificQuotaReset()
    await storageSet(update)
    throw new Error(errorCode)
  }
}

/**
 * Eşitlemeyi çalıştırır. Aynı anda iki koşu olmaz:
 * - Bellek kilidi (`activeRun`) eşzamanlı çağrıları anında birleştirir; kontrol
 *   ilk `await`'ten önce yapıldığı için iki çağrı kilidi birlikte geçemez.
 * - Depolama kilidi (`syncLease`) service worker yeniden başladığında yarım
 *   kalan bir koşunun üstüne binilmesini önler; bayat kilit devralınır.
 */
export async function runCloudSync() {
  if (activeRun) return { skipped: 'already_running' }
  activeRun = true
  try {
    const lease = await storageGet([SYNC_LEASE_KEY])
    const leaseAt = Number(lease[SYNC_LEASE_KEY]) || 0
    if (leaseAt > 0 && Date.now() - leaseAt < SYNC_LEASE_TTL_MS) {
      return { skipped: 'already_running' }
    }
    await storageSet({ [SYNC_LEASE_KEY]: Date.now() })
    return await performCloudSyncRun()
  } finally {
    activeRun = false
    await storageSet({ [SYNC_LEASE_KEY]: 0 })
  }
}

export async function setCloudSyncPaused(paused) {
  await storageSet({ [SYNC_PAUSED_KEY]: paused === true })
  return { paused: paused === true }
}

export async function listCloudSyncDevices() {
  const user = await waitForCurrentAuthUser()
  if (!user) throw new Error('sync_signed_out')
  const runtime = await getRuntime()
  const devices = await runtime.transport.listDevices(user.uid)
  // Erişimi kaldırılmış cihaz arayüzde listelenmez: belge yalnız o cihazın
  // kendiliğinden geri bağlanmasını engelleyen kayıt olarak durur.
  return devices.filter(device => !device.revokedAt)
}

export async function revokeCloudSyncDevice(deviceId) {
  const user = await waitForCurrentAuthUser()
  if (!user) throw new Error('sync_signed_out')
  const runtime = await getRuntime()
  await runtime.transport.setDevice(user.uid, deviceId, { revokedAt: Date.now() })
  if (deviceId === runtime.deviceId) {
    cachedSubkeys = null
    await storageSet({ [SYNC_ENABLED_KEY]: false })
  }
  return { revoked: true }
}

/**
 * Cihazı hesap düzeyinde kapatır/açar. Kapatılan cihaz kendi belgesini okuyup
 * eşitlemeyi atlar; kayıt ve anahtar zarfı silinmez, yeniden açılabilir.
 */
export async function setCloudSyncDeviceEnabled(deviceId, enabled) {
  const user = await waitForCurrentAuthUser()
  if (!user) throw new Error('sync_signed_out')
  const runtime = await getRuntime()
  await runtime.transport.setDevice(user.uid, deviceId, {
    disabledAt: enabled === true ? null : Date.now(),
  })
  return { deviceId, enabled: enabled === true }
}

/** Cihaz adını yazar; boş ad reddedilir, uzunluk kırpılır. */
export async function renameCloudSyncDevice(deviceId, label) {
  const user = await waitForCurrentAuthUser()
  if (!user) throw new Error('sync_signed_out')
  const runtime = await getRuntime()
  const nextLabel = String(label ?? '').trim().slice(0, MAX_DEVICE_LABEL_LENGTH)
  if (!nextLabel) throw new Error('device_label_empty')
  await runtime.transport.setDevice(user.uid, deviceId, { label: nextLabel })
  return { deviceId, label: nextLabel }
}

export async function disconnectCloudSync() {
  const user = await waitForCurrentAuthUser()
  const runtime = await getRuntime()
  if (user) {
    await runtime.transport.setDevice(user.uid, runtime.deviceId, { revokedAt: Date.now() })
  }
  cachedSubkeys = null
  await storageSet({ [SYNC_ENABLED_KEY]: false, [SYNC_PAUSED_KEY]: false })
  return { disconnected: true }
}

export async function cleanLegacyCloudData() {
  const user = await waitForCurrentAuthUser()
  if (!user) throw new Error('sync_signed_out')
  const runtime = await getRuntime()
  const deviceState = await loadLinkedDeviceState(runtime, user)
  if (deviceState.disabled) throw new Error('sync_device_disabled')
  if (!deviceState.linked) throw new Error('sync_recovery_required')
  try {
    const counts = await runtime.transport.cleanLegacyCloudData(user.uid)
    const completedAt = Date.now()
    await storageSet({ [LEGACY_CLEANUP_KEY]: completedAt })
    return { counts, completedAt }
  } catch (error) {
    throw new Error(mapCloudSyncError(error))
  }
}

export async function exportEncryptedBackup() {
  const user = await waitForCurrentAuthUser()
  if (!user) throw new Error('sync_signed_out')
  const runtime = await getRuntime()
  const deviceState = await loadLinkedDeviceState(runtime, user)
  if (deviceState.disabled) throw new Error('sync_device_disabled')
  if (!deviceState.linked) throw new Error('sync_recovery_required')
  const settings = getKeysByClass(SYNC_CLASS.SETTING)
  const stored = await storageGet([...settings, 'sessions', 'stats'])
  const apiKeys = {}
  for (const provider of PROVIDERS) {
    apiKeys[provider] = []
    for (const metadata of await runtime.vault.listKeys(provider)) {
      apiKeys[provider].push({
        ...metadata,
        key: await runtime.vault.getRawKey(provider, metadata.id),
      })
    }
  }
  const settingsPayload = Object.fromEntries(
    settings.filter(key => stored[key] !== undefined).map(key => [key, stored[key]]),
  )
  const payload = buildBackupPayload({
    sessions: await Promise.all((stored.sessions || []).map(runtime.normalizeSessionAttachments)),
    apiKeys,
    settings: settingsPayload,
    stats: stored.stats || null,
    sourceDeviceId: runtime.deviceId,
  })
  return encryptBackup({ backupKey: cachedSubkeys.backupKey, payload })
}

export async function importEncryptedBackup(envelope) {
  const user = await waitForCurrentAuthUser()
  if (!user) throw new Error('sync_signed_out')
  const runtime = await getRuntime()
  const deviceState = await loadLinkedDeviceState(runtime, user)
  if (deviceState.disabled) throw new Error('sync_device_disabled')
  if (!deviceState.linked) throw new Error('sync_recovery_required')
  const payload = await decryptBackup({ backupKey: cachedSubkeys.backupKey, envelope })
  const data = payload?.data || {}
  const changes = { ...(data.settings || {}) }
  if (Array.isArray(data.sessions)) {
    changes.sessions = await Promise.all(data.sessions.map(runtime.normalizeSessionAttachments))
  }
  if (data.stats) changes.stats = data.stats
  await storageSet(changes)
  for (const provider of PROVIDERS) {
    const existing = new Set((await runtime.vault.listKeys(provider)).map(item => item.id))
    for (const key of data.apiKeys?.[provider] || []) {
      if (!key?.key || existing.has(key.id)) continue
      try {
        await runtime.vault.addKey(provider, key.key, {
          id: key.id,
          label: key.label,
          isPrimary: key.isPrimary,
          createdAt: key.createdAt,
          fingerprint: key.fingerprint,
          model: key.model,
        })
        await runtime.vault.updateKeyMetadata(provider, key.id, key)
      } catch (error) {
        if (error?.message !== 'key_duplicate_error') throw error
      }
    }
  }
  await storageSet({ [KEY_CHANGE_MARKER]: Date.now() })
  await enqueueSnapshot(runtime)
  await runCloudSync()
  return { counts: payload.counts || null }
}

async function enqueueStorageChange(changes) {
  const status = await storageGet([SYNC_ENABLED_KEY])
  if (status[SYNC_ENABLED_KEY] !== true) return
  const runtime = await getRuntime()

  for (const [key, change] of Object.entries(changes)) {
    if (consumeRemoteWrite(key, change.newValue)) continue
    if (key === KEY_CHANGE_MARKER) {
      await enqueueAllKeys(runtime)
      continue
    }
    if (!isSyncedKey(key) || key.endsWith('ApiKeys')) continue
    if (key === 'sessions') {
      const before = new Map((change.oldValue || []).map(item => [String(item.id), item]))
      const after = new Map((change.newValue || []).map(item => [String(item.id), item]))
      for (const [id, session] of after) {
        if (session?.syncPolicy === 'local_only') {
          // "Yalnız bu cihazda"ya çevrilen sohbetin bulut kopyası silinmeli;
          // aksi halde kurtarma koduyla bağlanan yeni cihaz onu geri getirir.
          const onceki = before.get(id)
          if (onceki && onceki.syncPolicy !== 'local_only') {
            await runtime.engine.enqueue({
              storageKey: 'sessions',
              logicalId: id,
              entityType: 'session',
              op: QUEUE_OP.DELETE,
              entityVersion: newVersion(runtime.deviceId),
            })
          }
          continue
        }
        if (JSON.stringify(before.get(id)) === JSON.stringify(session)) continue
        await runtime.engine.enqueue({
          storageKey: 'sessions',
          logicalId: id,
          entityType: 'session',
          entityVersion: newVersion(runtime.deviceId),
        })
      }
      for (const [id, session] of before) {
        if (after.has(id) || session?.syncPolicy === 'local_only') continue
        await runtime.engine.enqueue({
          storageKey: 'sessions',
          logicalId: id,
          entityType: 'session',
          op: QUEUE_OP.DELETE,
          entityVersion: newVersion(runtime.deviceId),
        })
      }
    } else {
      await runtime.engine.enqueue({
        storageKey: key,
        logicalId: key,
        entityType: key === 'stats' ? 'stats_day' : 'setting',
        op: change.newValue === undefined ? QUEUE_OP.DELETE : QUEUE_OP.PUT,
        entityVersion: newVersion(runtime.deviceId),
      })
    }
  }
}

export function installCloudSyncListeners() {
  if (listenerInstalled || !globalThis.chrome?.storage?.onChanged) return
  listenerInstalled = true
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return
    enqueueStorageChange(changes).catch(error => {
      storageSet({ [LAST_ERROR_KEY]: error?.message || 'sync_queue_failed' }).catch(() => undefined)
    })
  })
}

export async function wakeCloudSync() {
  const status = await storageGet([
    SYNC_ENABLED_KEY,
    SYNC_PAUSED_KEY,
    LAST_SYNC_KEY,
    BLOCKED_UNTIL_KEY,
  ])
  const skipReason = cloudSyncWakeReason(status)
  if (skipReason) return { skipped: skipReason }
  try {
    return await runCloudSync()
  } catch (error) {
    return { skipped: mapCloudSyncError(error) }
  }
}

export async function clearCloudSyncSession() {
  cachedSubkeys = null
  await storageRemove([LAST_ERROR_KEY])
}
