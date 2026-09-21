import {
  attachmentIdsFromSessions,
  getAttachment,
  putAttachment,
} from './attachmentStore'
import { processAttachmentFile } from './fileParsers'
import {
  downloadAppDataFile,
  deleteAppDataFile,
  findAppDataFile,
  getGoogleAccessToken,
  upsertAppDataFile,
} from './googleDriveClient'
import { decryptBytes, decryptJson, encryptBytes, encryptJson } from './syncCrypto'
import { aggregateDeviceStats, mergeSyncSnapshots, SYNC_SCHEMA_VERSION } from './syncMerge'

const SNAPSHOT_FILE_NAME = 'heraai-sync-v1.bin'
const SETTINGS_KEYS = [
  'theme',
  'startupBehavior',
  'systemInstruction',
  'systemInstructionDefaultVersion',
  'customPrimaryColor',
  'language',
  'showSources',
  'selectedModel',
  'selectedProvider',
  'modelSelectionMode',
  'comparisonModelKeys',
]
const VAULT_KEYS = ['geminiApiKeys', 'tavilyApiKeys', 'openRouterApiKeys', 'ollamaApiKeys']
const LOCAL_KEYS = [
  ...SETTINGS_KEYS,
  ...VAULT_KEYS,
  'sessions',
  'activeSessionId',
  'stats',
  'syncLocalStats',
  'syncStatsBaseline',
  'syncDeviceId',
  'syncSessionTombstones',
  'syncSettingsUpdatedAt',
  'syncVaultUpdatedAt',
  'syncKeyTombstones',
  'syncAttachmentIndex',
]

function storageGet(keys) {
  return globalThis.chrome.storage.local.get(keys)
}

function storageSet(values) {
  return globalThis.chrome.storage.local.set(values)
}

function createDeviceId() {
  return globalThis.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]))
}

function applyPositiveNumericDelta(target, current, baseline) {
  if (!current || typeof current !== 'object' || Array.isArray(current)) return target
  const result = target && typeof target === 'object' && !Array.isArray(target)
    ? structuredClone(target)
    : {}
  for (const [key, value] of Object.entries(current)) {
    const before = baseline?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (key === 'lastActive') result[key] = Math.max(Number(result[key]) || 0, value) || null
      else result[key] = (Number(result[key]) || 0) + Math.max(0, value - (Number(before) || 0))
    } else if (Array.isArray(value)) {
      if (key === 'recentFinalizedIds') {
        result[key] = Array.from(new Set([...(result[key] || []), ...value])).slice(-100)
      } else if (result[key] === undefined) result[key] = structuredClone(value)
    } else if (value && typeof value === 'object') {
      result[key] = applyPositiveNumericDelta(result[key], value, before)
    } else if (result[key] === undefined) {
      result[key] = value
    }
  }
  return result
}

function attachmentMetadataById(sessions) {
  const result = new Map()
  for (const session of sessions || []) {
    for (const message of session?.messages || []) {
      for (const attachment of message?.attachments || []) {
        if (attachment?.id && !result.has(attachment.id)) result.set(attachment.id, attachment)
      }
    }
  }
  return result
}

async function ensureDeviceId(stored) {
  if (stored.syncDeviceId) return stored.syncDeviceId
  const deviceId = createDeviceId()
  await storageSet({ syncDeviceId: deviceId })
  return deviceId
}

async function buildLocalSnapshot(stored) {
  const now = Date.now()
  const deviceId = await ensureDeviceId(stored)
  const localStats = stored.syncStatsBaseline
    ? applyPositiveNumericDelta(stored.syncLocalStats, stored.stats, stored.syncStatsBaseline)
    : (stored.syncLocalStats || stored.stats || null)
  return { snapshot: {
    schemaVersion: SYNC_SCHEMA_VERSION,
    updatedAt: now,
    settings: pick(stored, SETTINGS_KEYS),
    settingsUpdatedAt: Number(stored.syncSettingsUpdatedAt) || 0,
    sessions: Array.isArray(stored.sessions) ? stored.sessions : [],
    sessionTombstones: stored.syncSessionTombstones || {},
    statsByDevice: localStats ? {
      [deviceId]: { updatedAt: Number(localStats.lastActive) || now, stats: localStats },
    } : {},
    vault: pick(stored, VAULT_KEYS),
    vaultTombstones: stored.syncKeyTombstones || {},
    vaultUpdatedAt: Number(stored.syncVaultUpdatedAt) || 0,
    attachments: stored.syncAttachmentIndex || {},
  }, localStats }
}

async function readRemoteSnapshot(token, passphrase) {
  const file = await findAppDataFile(token, SNAPSHOT_FILE_NAME)
  if (!file) return { file: null, snapshot: null }
  const bytes = await downloadAppDataFile(token, file.id)
  const snapshot = await decryptJson(bytes, passphrase)
  if (snapshot?.schemaVersion !== SYNC_SCHEMA_VERSION) throw new Error('sync_version_unsupported')
  return { file, snapshot }
}

async function syncAttachments(token, passphrase, snapshot) {
  const metadata = attachmentMetadataById(snapshot.sessions)
  const requiredIds = attachmentIdsFromSessions(snapshot.sessions)
  const nextIndex = { ...(snapshot.attachments || {}) }
  let uploaded = 0
  let downloaded = 0

  for (const id of requiredIds) {
    const localRecord = await getAttachment(id)
    const cloudRecord = nextIndex[id]
    if (!localRecord && cloudRecord?.fileId) {
      const encrypted = await downloadAppDataFile(token, cloudRecord.fileId)
      const bytes = await decryptBytes(encrypted, passphrase)
      const info = metadata.get(id) || cloudRecord
      const file = new File([bytes], info.name || 'attachment', {
        type: info.mimeType || 'application/octet-stream',
      })
      await putAttachment(await processAttachmentFile(file), id)
      downloaded += 1
      continue
    }
    if (localRecord && !cloudRecord?.fileId) {
      const info = metadata.get(id) || {}
      const encrypted = await encryptBytes(new Uint8Array(await localRecord.blob.arrayBuffer()), passphrase)
      const driveFile = await upsertAppDataFile(
        token,
        `heraai-attachment-${id}.bin`,
        encrypted,
        { kind: 'attachment', attachmentId: String(id) },
      )
      nextIndex[id] = {
        fileId: driveFile.id,
        name: info.name || 'attachment',
        mimeType: info.mimeType || localRecord.blob.type || 'application/octet-stream',
        size: Number(info.size || localRecord.blob.size || 0),
        updatedAt: Date.now(),
      }
      uploaded += 1
    }
  }

  for (const [id, cloudRecord] of Object.entries(nextIndex)) {
    if (requiredIds.has(id)) continue
    if (cloudRecord?.fileId) await deleteAppDataFile(token, cloudRecord.fileId)
    delete nextIndex[id]
  }

  snapshot.attachments = nextIndex
  return { uploaded, downloaded }
}

async function applyMergedSnapshot(snapshot, stored, deviceId, localStats) {
  const stats = aggregateDeviceStats(snapshot.statsByDevice)
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : []
  const currentActiveExists = sessions.some(session => session.id === stored.activeSessionId)
  const nextActiveSessionId = currentActiveExists ? stored.activeSessionId : (sessions[0]?.id || null)
  await storageSet({
    ...snapshot.settings,
    ...snapshot.vault,
    sessions,
    activeSessionId: nextActiveSessionId,
    stats,
    syncLocalStats: localStats || snapshot.statsByDevice?.[deviceId]?.stats || stored.syncLocalStats || stored.stats || null,
    syncStatsBaseline: stats,
    syncSessionTombstones: snapshot.sessionTombstones,
    syncSettingsUpdatedAt: snapshot.settingsUpdatedAt,
    syncVaultUpdatedAt: snapshot.vaultUpdatedAt,
    syncKeyTombstones: snapshot.vaultTombstones || {},
    syncAttachmentIndex: snapshot.attachments,
    syncEnabled: true,
    syncLastSuccessAt: Date.now(),
  })
}

export async function synchronizeWithGoogleDrive(passphrase, { interactive = true } = {}) {
  if (String(passphrase || '').length < 8) throw new Error('sync_passphrase_too_short')
  const token = await getGoogleAccessToken(interactive)
  const stored = await storageGet(LOCAL_KEYS)
  const deviceId = await ensureDeviceId(stored)
  stored.syncDeviceId = deviceId
  const { snapshot: localSnapshot, localStats } = await buildLocalSnapshot(stored)
  const { file, snapshot: remoteSnapshot } = await readRemoteSnapshot(token, passphrase)
  if (!remoteSnapshot && localSnapshot.settingsUpdatedAt === 0) localSnapshot.settingsUpdatedAt = Date.now()
  if (!remoteSnapshot && localSnapshot.vaultUpdatedAt === 0) localSnapshot.vaultUpdatedAt = Date.now()
  const merged = mergeSyncSnapshots(localSnapshot, remoteSnapshot)
  const attachmentResult = await syncAttachments(token, passphrase, merged)
  const encrypted = await encryptJson(merged, passphrase)
  await upsertAppDataFile(token, SNAPSHOT_FILE_NAME, encrypted, { kind: 'snapshot', schemaVersion: '1' })
  await applyMergedSnapshot(merged, stored, deviceId, localStats)
  return {
    created: !file,
    sessions: merged.sessions.length,
    uploadedAttachments: attachmentResult.uploaded,
    downloadedAttachments: attachmentResult.downloaded,
    syncedAt: Date.now(),
  }
}

export async function recordSessionTombstones(sessionIds, deletedAt = Date.now()) {
  const ids = (Array.isArray(sessionIds) ? sessionIds : [sessionIds]).filter(Boolean)
  if (ids.length === 0) return
  const stored = await storageGet(['syncSessionTombstones'])
  const tombstones = { ...(stored.syncSessionTombstones || {}) }
  for (const id of ids) tombstones[id] = Math.max(Number(tombstones[id]) || 0, deletedAt)
  await storageSet({ syncSessionTombstones: tombstones })
}

export async function markSyncSettingsChanged() {
  await storageSet({ syncSettingsUpdatedAt: Date.now() })
}

export async function markSyncVaultChanged() {
  await storageSet({ syncVaultUpdatedAt: Date.now() })
}
