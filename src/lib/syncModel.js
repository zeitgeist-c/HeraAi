/**
 * HeraAi 1.10.0 — bulut veri modeli (Aşama 3).
 *
 * Firestore'da tutulan her şeyin biçimini tanımlar: belge yolları, açık teknik
 * alanlar, sürüm damgası ve opak kimlik türetimi. Firestore'un 1 MiB belge
 * sınırına ve ücretsiz kotasına uyacak şekilde tasarlanmıştır.
 *
 * Gizlilik ilkesi: sunucu yalnızca opak kimlikleri, sınıflandırma etiketlerini
 * ve sürüm damgalarını görür. Sohbet metni, başlık, API anahtarı veya ayar
 * değeri hiçbir açık alanda yer almaz — hepsi `ciphertext` içindedir.
 * Belge kimlikleri de mantıksal kimliği sızdırmaz: `HMAC-SHA-256(hmacKey,
 * "<entityType>:<logicalId>")` ile türetilir, yani hesaptaki tüm cihazlar aynı
 * nesne için aynı kimliğe ulaşır ama sunucu hangi sohbete ait olduğunu bilemez.
 *
 * Zaman damgası çakışması: sürüm karşılaştırması duvar saati → mantıksal sayaç →
 * cihaz kimliği sırasıyla yapılır; saatleri geri gitse bile sonuç tüm cihazlarda
 * aynı çıkar.
 */

import { SYNC_CLASS, classifyStorageKey } from './syncContract'

export const CLOUD_SCHEMA_VERSION = 1
export const CRYPTO_VERSION = 1

/** Varlık türleri (plan §7). */
export const ENTITY_TYPES = Object.freeze([
  'setting',
  'session',
  'message_batch',
  'message',
  'api_key',
  'stats_day',
  'tombstone',
])

/** Firestore belge yolları. */
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
 * Sözleşmedeki depolama anahtarını bulut varlık türüne çevirir.
 * Bilinmeyen anahtar `null` döner — eşitlenmeyen veri buluta yazılmaz.
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

/** Opak kimlik türetiminde kullanılan ad alanı: "<entityType>:<logicalId>". */
export function opaqueNamespace(entityType, logicalId) {
  return `${entityType}:${logicalId}`
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Mantıksal kimliği (örn. `session_123`) opak belge kimliğine çevirir.
 * Aynı hesap + aynı kimlik => aynı çıktı (deterministik), sunucu için anlamsız.
 * `hmacKey` Aşama 4'te HKDF ile türetilen CryptoKey'tir.
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
 * Değişiklik sürümü üretir. `logicalCounter` aynı milisaniyedeki ardışık
 * yazımları ayırır; `deviceId` son beraberlik bozucudur.
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
 * İki sürümü karşılaştırır: yüksek duvar saati, sonra yüksek mantıksal sayaç,
 * sonra alfabetik olarak büyük cihaz kimliği kazanır.
 * @returns {number} a>b için 1, a<b için -1, eşitlik için 0
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

/** Gelen sürüm yerel sürümden daha mı yeni? */
export function isIncomingNewer(incoming, local) {
  return compareEntityVersions(incoming, local) > 0
}

/** Firestore'a yazılacak sürüm alanı. */
export function serializeEntityVersion(version) {
  return {
    wallTimeMs: version.wallTimeMs,
    logicalCounter: version.logicalCounter,
    deviceId: version.deviceId,
  }
}

/** Firestore'dan okunan sürüm alanını doğrular; bozuksa `null`. */
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

/** `account/root` — yalnız teknik açık alanlar. */
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

/** `devices/{deviceId}` — cihaz kaydı ve sarılmış ana sır zarfı. */
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
  }
}

/**
 * `entities/{opaqueEntityId}` — açık teknik alanlar + şifreli yük.
 * `ciphertext`/`nonce` Aşama 4'te üretilir; bu fonksiyon yalnız zarfı kurar.
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

/** Silme kaydı: aynı zarf, `deleted: true`. */
export function buildTombstoneDocument(options = {}) {
  return buildEntityDocument({ ...options, entityType: 'tombstone', deleted: true })
}

/**
 * Yalnızca mevcut bir varlık güncellenirken önceki sürüm saklanır; ilk
 * aktarımda `revisions` yazılmaz (kota tasarrufu, yetim alt koleksiyon riski).
 */
export function shouldWriteRevision({ isInitialSync }) {
  return isInitialSync !== true
}

/** Sürümden deterministik revizyon kimliği. */
export function buildRevisionId(entityVersion) {
  const v = createEntityVersion(entityVersion)
  return `${v.wallTimeMs}-${v.logicalCounter}-${v.deviceId}`
}

export const REVISION_RETENTION_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

/** Saklama süresi dolmuş mu? (Varsayılan: son 7 gün korunur.) */
export function isRevisionExpired(revisionWallTimeMs, nowMs, days = REVISION_RETENTION_DAYS) {
  if (!Number.isFinite(Number(revisionWallTimeMs))) return true
  const cutoff = Number(nowMs) - days * DAY_MS
  return Number(revisionWallTimeMs) < cutoff
}

/** Yedek belgesinin tarih anahtarı (yerel gün). */
export function backupDateKey(date) {
  const d = date instanceof Date ? date : new Date(date)
  const pad = value => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Modelin özeti (teşhis ve testler için). */
export function describeCloudModel() {
  return {
    schemaVersion: CLOUD_SCHEMA_VERSION,
    cryptoVersion: CRYPTO_VERSION,
    entityTypes: [...ENTITY_TYPES],
    revisionRetentionDays: REVISION_RETENTION_DAYS,
    collections: ['account', 'devices', 'entities', 'entities/*/chunks'],
  }
}
