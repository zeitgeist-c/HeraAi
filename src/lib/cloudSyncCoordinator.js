import { getCurrentAuthUser, waitForCurrentAuthUser } from './authService'
import { createFirestoreTransport } from './firestoreTransport'
import {
  ATTACHMENT_AVAILABILITY,
  ATTACHMENT_MANIFEST_STATUS,
  buildBlobManifest,
  computeSha256,
  decryptAttachmentChunks,
  decryptAttachmentName,
  encryptAttachmentChunks,
  encryptAttachmentName,
  isManifestReady,
  planAttachmentSync,
} from './attachmentSync'
import { getAttachment, putAttachment } from './attachmentStore'
import { processAttachmentFile } from './fileParsers'
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
  deriveOpaqueAttachmentId,
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

const DEVICE_ID_KEY = 'syncDeviceId'
const SYNC_ENABLED_KEY = 'syncEnabled'
const SYNC_PAUSED_KEY = 'syncPaused'
const LAST_SYNC_KEY = 'syncLastSuccessAt'
const LAST_ERROR_KEY = 'syncLastError'
const KEY_CHANGE_MARKER = 'syncVaultUpdatedAt'
const KEY_TOMBSTONES = 'syncKeyTombstones'

let runtimePromise = null
let cachedSubkeys = null
let syncTimer = null
let listenerInstalled = false
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

  async function syncSessionAttachments(session) {
    const user = await waitForCurrentAuthUser()
    if (!user || !cachedSubkeys?.blobEncryptionKey || !cachedSubkeys?.hmacIdKey) return session
    const availability = new Map()
    const attachments = new Map()
    for (const message of session?.messages || []) {
      for (const attachment of message?.attachments || []) {
        if (attachment?.id) attachments.set(attachment.id, attachment)
      }
    }
    for (const attachment of attachments.values()) {
      const local = await getAttachment(attachment.id)
      if (!local?.blob) {
        availability.set(attachment.id, attachment.availability || 'missing')
        continue
      }
      const plan = planAttachmentSync({ size: attachment.size || local.blob.size })
      if (!plan.syncBinary) {
        availability.set(attachment.id, ATTACHMENT_AVAILABILITY.LOCAL_ONLY)
        continue
      }
      const opaqueAttachmentId = await deriveOpaqueAttachmentId(
        cachedSubkeys.hmacIdKey,
        attachment.id,
      )
      const bytes = new Uint8Array(await local.blob.arrayBuffer())
      const sha256 = await computeSha256(bytes)
      const existing = await transport.getBlobManifest(user.uid, opaqueAttachmentId)
      if (!isManifestReady(existing) || existing.sha256 !== sha256) {
        const nameEnvelope = await encryptAttachmentName({
          blobKey: cachedSubkeys.blobEncryptionKey,
          name: attachment.name,
          ownerUid: user.uid,
          opaqueAttachmentId,
        })
        const baseManifest = buildBlobManifest({
          ownerUid: user.uid,
          opaqueAttachmentId,
          totalBytes: bytes.length,
          sha256,
          nameEnvelope,
          mimeType: attachment.mimeType,
          kind: attachment.kind,
          availability: ATTACHMENT_AVAILABILITY.SYNCED,
          status: ATTACHMENT_MANIFEST_STATUS.UPLOADING,
          sourceDeviceId: deviceId,
          createdAt: existing?.createdAt || Date.now(),
          updatedAt: Date.now(),
        })
        await transport.setBlobManifest(user.uid, opaqueAttachmentId, baseManifest)
        const chunks = await encryptAttachmentChunks({
          blobKey: cachedSubkeys.blobEncryptionKey,
          bytes,
          ownerUid: user.uid,
          opaqueAttachmentId,
        })
        for (const chunk of chunks) {
          await transport.setBlobChunk(user.uid, opaqueAttachmentId, chunk)
        }
        await transport.setBlobManifest(user.uid, opaqueAttachmentId, {
          ...baseManifest,
          status: ATTACHMENT_MANIFEST_STATUS.READY,
          updatedAt: Date.now(),
        })
      }
      availability.set(attachment.id, ATTACHMENT_AVAILABILITY.SYNCED)
    }
    return {
      ...session,
      messages: (session?.messages || []).map(message => ({
        ...message,
        attachments: (message?.attachments || []).map(attachment => ({
          ...attachment,
          ...(attachment?.id && availability.has(attachment.id)
            ? { availability: availability.get(attachment.id) }
            : {}),
        })),
      })),
    }
  }

  async function hydrateSessionAttachments(session) {
    const user = await waitForCurrentAuthUser()
    if (!user || !cachedSubkeys?.blobEncryptionKey || !cachedSubkeys?.hmacIdKey) return session
    const nextAvailability = new Map()
    const attachments = new Map()
    for (const message of session?.messages || []) {
      for (const attachment of message?.attachments || []) {
        if (attachment?.id && attachment.availability === ATTACHMENT_AVAILABILITY.SYNCED) {
          attachments.set(attachment.id, attachment)
        }
      }
    }
    for (const attachment of attachments.values()) {
      if (await getAttachment(attachment.id)) continue
      try {
        const opaqueAttachmentId = await deriveOpaqueAttachmentId(
          cachedSubkeys.hmacIdKey,
          attachment.id,
        )
        const manifest = await transport.getBlobManifest(user.uid, opaqueAttachmentId)
        if (!isManifestReady(manifest)) throw new Error('attachment_not_ready')
        const chunks = await transport.getBlobChunks(user.uid, opaqueAttachmentId)
        const bytes = await decryptAttachmentChunks({
          blobKey: cachedSubkeys.blobEncryptionKey,
          chunks,
          ownerUid: user.uid,
          opaqueAttachmentId,
        })
        const name = await decryptAttachmentName({
          blobKey: cachedSubkeys.blobEncryptionKey,
          envelope: manifest.nameEnvelope,
          ownerUid: user.uid,
          opaqueAttachmentId,
        })
        const blob = new Blob([bytes], { type: manifest.mimeType || attachment.mimeType })
        const file = new File([blob], name || attachment.name || 'attachment', { type: blob.type })
        await putAttachment(await processAttachmentFile(file), attachment.id)
      } catch (error) {
        console.error('attachment_sync_download_failed', error)
        nextAvailability.set(attachment.id, ATTACHMENT_AVAILABILITY.REMOTE_ONLY)
      }
    }
    if (nextAvailability.size === 0) return session
    return {
      ...session,
      messages: (session?.messages || []).map(message => ({
        ...message,
        attachments: (message?.attachments || []).map(attachment => ({
          ...attachment,
          ...(attachment?.id && nextAvailability.has(attachment.id)
            ? { availability: nextAvailability.get(attachment.id) }
            : {}),
        })),
      })),
    }
  }

  async function readPayload(storageKey, logicalId) {
    if (storageKey === 'sessions') {
      const stored = await storageGet(['sessions'])
      const session = (stored.sessions || []).find(item => String(item.id) === String(logicalId))
      if (!session || session.syncPolicy === 'local_only') return null
      return { storageKey, logicalId, value: await syncSessionAttachments(session) }
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
        const hydrated = await hydrateSessionAttachments(payload.value)
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

  return { db, deviceKey, vault, deviceId, transport, engine }
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

async function loadLinkedDevice(runtime, user) {
  const device = await runtime.transport.getDevice(user.uid, runtime.deviceId)
  if (!device?.deviceMasterKeyEnvelope || device.revokedAt) return false
  if (cachedSubkeys) return true
  const masterBytes = await unwrapMasterSecretFromDevice(
    runtime.deviceKey,
    device.deviceMasterKeyEnvelope,
  )
  await cacheMasterSecret(masterBytes)
  return true
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

async function enqueueSnapshot(runtime) {
  const settings = getKeysByClass(SYNC_CLASS.SETTING)
  const stored = await storageGet([...settings, 'sessions', 'stats'])
  for (const key of settings) {
    if (stored[key] === undefined) continue
    await runtime.engine.enqueue({
      storageKey: key,
      logicalId: key,
      entityType: 'setting',
      entityVersion: newVersion(runtime.deviceId),
    })
  }
  for (const session of stored.sessions || []) {
    if (!session?.id || session.syncPolicy === 'local_only') continue
    await runtime.engine.enqueue({
      storageKey: 'sessions',
      logicalId: session.id,
      entityType: 'session',
      entityVersion: newVersion(runtime.deviceId),
    })
  }
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
    DEVICE_ID_KEY,
  ])
  if (!user) return { signedIn: false, ...stored, state: 'signed_out' }
  const runtime = await getRuntime()
  const account = await runtime.transport.getAccountRoot(user.uid)
  const linked = account ? await loadLinkedDevice(runtime, user).catch(() => false) : false
  return {
    signedIn: true,
    user,
    accountExists: Boolean(account),
    linked,
    enabled: stored[SYNC_ENABLED_KEY] === true,
    paused: stored[SYNC_PAUSED_KEY] === true,
    lastSyncAt: stored[LAST_SYNC_KEY] || null,
    lastError: stored[LAST_ERROR_KEY] || null,
    deviceId: runtime.deviceId,
    pending: await runtime.engine.pendingCount(),
    state: linked ? runtime.engine.getStatus().state : account ? 'recovery_required' : 'setup_required',
  }
}

export async function runCloudSync() {
  const user = await waitForCurrentAuthUser()
  if (!user) throw new Error('sync_signed_out')
  const runtime = await getRuntime()
  const stored = await storageGet([SYNC_ENABLED_KEY, SYNC_PAUSED_KEY])
  if (stored[SYNC_ENABLED_KEY] !== true) throw new Error('sync_not_enabled')
  if (stored[SYNC_PAUSED_KEY] === true) return { skipped: 'paused' }
  if (!await loadLinkedDevice(runtime, user)) throw new Error('sync_recovery_required')
  try {
    const result = await runtime.engine.drain()
    const now = Date.now()
    await runtime.transport.setDevice(user.uid, runtime.deviceId, {
      lastSeenAt: now,
      lastSyncedAt: now,
    })
    await storageSet({ [LAST_SYNC_KEY]: now, [LAST_ERROR_KEY]: null })
    await storageSet({ [KEY_TOMBSTONES]: {} })
    return result
  } catch (error) {
    await storageSet({ [LAST_ERROR_KEY]: error?.message || 'sync_failed' })
    throw error
  }
}

export async function setCloudSyncPaused(paused) {
  await storageSet({ [SYNC_PAUSED_KEY]: paused === true })
  if (!paused) scheduleCloudSync(0)
  return { paused: paused === true }
}

export async function listCloudSyncDevices() {
  const user = await waitForCurrentAuthUser()
  if (!user) throw new Error('sync_signed_out')
  const runtime = await getRuntime()
  return runtime.transport.listDevices(user.uid)
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

export async function exportEncryptedBackup() {
  const user = await waitForCurrentAuthUser()
  if (!user) throw new Error('sync_signed_out')
  const runtime = await getRuntime()
  if (!await loadLinkedDevice(runtime, user)) throw new Error('sync_recovery_required')
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
    sessions: stored.sessions || [],
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
  if (!await loadLinkedDevice(runtime, user)) throw new Error('sync_recovery_required')
  const payload = await decryptBackup({ backupKey: cachedSubkeys.backupKey, envelope })
  const data = payload?.data || {}
  const changes = { ...(data.settings || {}) }
  if (Array.isArray(data.sessions)) changes.sessions = data.sessions
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

function scheduleCloudSync(delay = 1200) {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = null
    runCloudSync().catch(() => undefined)
  }, delay)
}

async function enqueueStorageChange(changes) {
  const status = await storageGet([SYNC_ENABLED_KEY, SYNC_PAUSED_KEY])
  if (status[SYNC_ENABLED_KEY] !== true || status[SYNC_PAUSED_KEY] === true) return
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
        if (session?.syncPolicy === 'local_only') continue
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
  scheduleCloudSync()
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
  const status = await storageGet([SYNC_ENABLED_KEY, SYNC_PAUSED_KEY])
  if (status[SYNC_ENABLED_KEY] === true && status[SYNC_PAUSED_KEY] !== true) {
    scheduleCloudSync(250)
  }
}

export async function clearCloudSyncSession() {
  cachedSubkeys = null
  await storageRemove([LAST_ERROR_KEY])
}
