/**
 * HeraAi 1.10.0 - cloud data model (Stage 3).
 *
 * Defines the shape of everything kept in Firestore: document paths, plain technical
 * fields, the version stamp and opaque id derivation. Designed to stay within
 * Firestore's 1 MiB document limit and its free quota.
 *
 * Privacy principle: the server sees only opaque ids, classification labels and
 * version stamps. Chat text, title, API key or setting value appear in no plain field
 * - they are all inside `ciphertext`. Document ids do not leak the logical id either:
 * they are derived with `HMAC-SHA-256(hmacKey, "<entityType>:<logicalId>")`, so all
 * devices in the account reach the same id for the same object but the server cannot
 * tell which chat it belongs to.
 *
 * Timestamp collision: the version comparison runs on wall clock -> logical counter
 * -> device id; even if clocks go backwards the result is the same on all devices.
 */

import { SYNC_CLASS, classifyStorageKey } from './syncContract'

export const CLOUD_SCHEMA_VERSION = 1
export const CRYPTO_VERSION = 1

/** Device name upper bound; the UI and sync use the same value. */
export const MAX_DEVICE_LABEL_LENGTH = 40

/** Entity types (plan section 7). */
export const ENTITY_TYPES = Object.freeze([
  'setting',
  'session',
  'message_batch',
  'message',
  'api_key',
  'stats_day',
  'tombstone',
])

/** Firestore document paths. */
export const cloudPaths = {
  accountRoot: uid => `users/${uid}/account/root`,
  device: (uid, deviceId) => `users/${uid}/devices/${deviceId}`,
  entity: (uid, opaqueEntityId) => `users/${uid}/entities/${opaqueEntityId}`,
  entityChunk: (uid, opaqueEntityId, chunkId) => `users/${uid}/entities/${opaqueEntityId}/chunks/${chunkId}`,
  revision: (uid, opaqueEntityId, revisionId) => `users/${uid}/entities/${opaqueEntityId}/revisions/${revisionId}`,
  blob: (uid, opaqueAttachmentId) => `users/${uid}/blobs/${opaqueAttachmentId}`,
  blobChunk: (uid, opaqueAttachmentId, chunkIndex) => `users/${uid}/blobs/${opaqueAttachmentId}/chunks/${chunkIndex}`,
  backup: (uid, dateKey) => `users/${uid}/backups/${dateKey}`,
}

/**
 * Converts a contract storage key to a cloud entity type. An unknown key returns
 * `null` - data that is not synced is not written to the cloud.
 */
export function entityTypeForStorageKey(storageKey) {
  switch (classifyStorageKey(storageKey)) {
    case SYNC_CLASS.SETTING:
      return 'setting'
    case SYNC_CLASS.STATS:
      return 'stats_day'
    case SYNC_CLASS.ENTITY:
      return storageKey === 'sessions' ? 'session' : 'api_key'
    default:
      return null
  }
}

/** Namespace used in opaque id derivation: "<entityType>:<logicalId>". */
export function opaqueNamespace(entityType, logicalId) {
  return `${entityType}:${logicalId}`
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Converts a logical id (e.g. `session_123`) to an opaque document id.
 * Same account + same id => same output (deterministic), meaningless to the server.
 * `hmacKey` is the CryptoKey derived with HKDF in stage 4.
 */
export async function deriveOpaqueId(hmacKey, entityType, logicalId) {
  if (!hmacKey) throw new Error('opaque_id_key_missing')
  if (!ENTITY_TYPES.includes(entityType)) throw new Error('opaque_id_type_invalid')
  if (logicalId === undefined || logicalId === null || logicalId === '') {
    throw new Error('opaque_id_logical_missing')
  }
  const payload = new TextEncoder().encode(opaqueNamespace(entityType, logicalId))
  const signature = await globalThis.crypto.subtle.sign('HMAC', hmacKey, payload)
  return toHex(signature)
}

/**
 * Produces the change version. `logicalCounter` separates consecutive writes in the
 * same millisecond; `deviceId` is the final tie breaker.
 */
export function createEntityVersion({ wallTimeMs, logicalCounter = 0, deviceId }) {
  const time = Number(wallTimeMs)
  if (!Number.isFinite(time)) throw new Error('entity_version_time_invalid')
  if (!deviceId) throw new Error('entity_version_device_missing')
  const counter = Number.isFinite(Number(logicalCounter)) && Number(logicalCounter) >= 0
    ? Math.floor(Number(logicalCounter))
    : 0
  return { wallTimeMs: Math.floor(time), logicalCounter: counter, deviceId: String(deviceId) }
}

/**
 * Compares two versions: the higher wall clock wins, then the higher logical counter,
 * then the alphabetically greater device id.
 * @returns {number} 1 for a>b, -1 for a<b, 0 for equal
 */
export function compareEntityVersions(a, b) {
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  if (a.wallTimeMs !== b.wallTimeMs) return a.wallTimeMs > b.wallTimeMs ? 1 : -1
  if (a.logicalCounter !== b.logicalCounter) return a.logicalCounter > b.logicalCounter ? 1 : -1
  if (a.deviceId === b.deviceId) return 0
  return a.deviceId > b.deviceId ? 1 : -1
}

/** Is the incoming version newer than the local version? */
export function isIncomingNewer(incoming, local) {
  return compareEntityVersions(incoming, local) > 0
}

/** Version field to be written to Firestore. */
export function serializeEntityVersion(version) {
  return {
    wallTimeMs: version.wallTimeMs,
    logicalCounter: version.logicalCounter,
    deviceId: version.deviceId,
  }
}

/** Validates the version field read from Firestore; `null` when corrupt. */
export function parseEntityVersion(raw) {
  if (!raw || typeof raw !== 'object') return null
  const { wallTimeMs, logicalCounter, deviceId } = raw
  if (!Number.isFinite(Number(wallTimeMs)) || !deviceId) return null
  return {
    wallTimeMs: Math.floor(Number(wallTimeMs)),
    logicalCounter: Number.isFinite(Number(logicalCounter)) ? Math.floor(Number(logicalCounter)) : 0,
    deviceId: String(deviceId),
  }
}

/** `account/root` - plain technical fields only. */
export function buildAccountRootDocument({
  cryptoVersion = CRYPTO_VERSION,
  schemaVersion = CLOUD_SCHEMA_VERSION,
  createdAt,
  recoveryEnvelope = null,
  keyRotationIndex = 0,
  lastCleanupAt = null,
} = {}) {
  return {
    schemaVersion,
    cryptoVersion,
    createdAt: createdAt ?? null,
    recoveryEnvelope,
    keyRotationIndex,
    lastCleanupAt,
  }
}

/** `devices/{deviceId}` - device record and the wrapped master secret envelope. */
export function buildDeviceDocument({
  deviceId,
  label,
  browser = null,
  platform = null,
  createdAt,
  lastSeenAt = null,
  lastSyncedAt = null,
  deviceMasterKeyEnvelope = null,
  revokedAt = null,
  disabledAt = null,
} = {}) {
  if (!deviceId) throw new Error('device_id_missing')
  return {
    deviceId: String(deviceId),
    label: label || null,
    browser,
    platform,
    createdAt: createdAt ?? null,
    lastSeenAt,
    lastSyncedAt,
    deviceMasterKeyEnvelope,
    revokedAt,
    disabledAt,
  }
}

/**
 * `entities/{opaqueEntityId}` - plain technical fields + encrypted payload.
 * `ciphertext`/`nonce` are produced in stage 4; this function only builds the envelope.
 */
export function buildEntityDocument({
  ownerUid,
  entityType,
  entityVersion,
  sourceDeviceId,
  nonce,
  ciphertext,
  deleted = false,
  schemaVersion = CLOUD_SCHEMA_VERSION,
  cryptoVersion = CRYPTO_VERSION,
} = {}) {
  if (!ownerUid) throw new Error('entity_owner_missing')
  if (!ENTITY_TYPES.includes(entityType)) throw new Error('entity_type_invalid')
  if (!entityVersion) throw new Error('entity_version_missing')
  return {
    ownerUid,
    entityType,
    schemaVersion,
    cryptoVersion,
    entityVersion: serializeEntityVersion(entityVersion),
    sourceDeviceId: sourceDeviceId || entityVersion.deviceId,
    deleted: deleted === true,
    ciphertextSize: typeof ciphertext === 'string' ? ciphertext.length : 0,
    ...(nonce ? { nonce } : {}),
    ...(ciphertext ? { ciphertext } : {}),
  }
}

/** Delete record: the same envelope with `deleted: true`. */
export function buildTombstoneDocument(options = {}) {
  return buildEntityDocument({ ...options, entityType: 'tombstone', deleted: true })
}

/**
 * The previous version is kept only when an existing entity is updated; `revisions`
 * is not written on the first transfer (saves quota, avoids orphan subcollections).
 */
export function shouldWriteRevision({ isInitialSync }) {
  return isInitialSync !== true
}

/** Deterministic revision id from the version. */
export function buildRevisionId(entityVersion) {
  const v = createEntityVersion(entityVersion)
  return `${v.wallTimeMs}-${v.logicalCounter}-${v.deviceId}`
}

export const REVISION_RETENTION_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

/** Has the retention period expired? (Default: the last 7 days are kept.) */
export function isRevisionExpired(revisionWallTimeMs, nowMs, days = REVISION_RETENTION_DAYS) {
  if (!Number.isFinite(Number(revisionWallTimeMs))) return true
  const cutoff = Number(nowMs) - days * DAY_MS
  return Number(revisionWallTimeMs) < cutoff
}

/** Summary of the model (for diagnostics and tests). */
export function describeCloudModel() {
  return {
    schemaVersion: CLOUD_SCHEMA_VERSION,
    cryptoVersion: CRYPTO_VERSION,
    entityTypes: [...ENTITY_TYPES],
    revisionRetentionDays: REVISION_RETENTION_DAYS,
    collections: ['account', 'devices', 'entities', 'entities/*/chunks'],
  }
}
