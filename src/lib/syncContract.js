/**
 * HeraAi 1.10.0 - sync contract (Stage 2).
 *
 * Defines in one place which `chrome.storage.local` key goes to the cloud, which stays
 * only on the device, and how each synced piece of data is merged. Later stages
 * (cloud data model, encryption, sync engine) read only this table; the
 * classification decision is not repeated in another file.
 *
 * Privacy: every synced payload is encrypted on the client; the server sees only
 * opaque ids and version stamps. Statistics never carry chat text, URLs or file content.
 *
 * An unclassified key is treated as `EXCLUDED` - when adding a new setting nothing
 * goes to the cloud without a row here (safe default).
 */

export const SYNC_SCHEMA_VERSION = 1

/** Data classes. */
export const SYNC_CLASS = {
  /** Single-value setting; the last writer wins. */
  SETTING: 'setting',
  /** Identified record collection; merged record by record. */
  ENTITY: 'entity',
  /** Counter tree; merged by summing. */
  STATS: 'stats',
  /** Stays on this device only. */
  LOCAL_ONLY: 'local_only',
  /** Not synced; legacy/obsolete data or device infrastructure. */
  EXCLUDED: 'excluded',
}

/** Merge strategies. */
export const MERGE_STRATEGY = {
  /** The newest `updatedAt` wins for the same key. */
  LAST_WRITE_WINS: 'last_write_wins',
  /** Union by record id; deletions are carried as tombstones. */
  ENTITY_UNION: 'entity_union',
  /** Daily counters are summed; id lists are united. */
  STATS_SUM: 'stats_sum',
  /** No merge. */
  NONE: 'none',
}

/**
 * Contract table: key -> { class, merge, tombstone, notes }.
 * `notes` is a maintenance description only; it does not change behaviour.
 */
const CONTRACT = {
  // ---- Synced settings (single value) ----
  theme: { class: SYNC_CLASS.SETTING, merge: MERGE_STRATEGY.LAST_WRITE_WINS },
  customPrimaryColor: { class: SYNC_CLASS.SETTING, merge: MERGE_STRATEGY.LAST_WRITE_WINS },
  language: { class: SYNC_CLASS.SETTING, merge: MERGE_STRATEGY.LAST_WRITE_WINS },
  startupBehavior: { class: SYNC_CLASS.SETTING, merge: MERGE_STRATEGY.LAST_WRITE_WINS },
  systemInstruction: { class: SYNC_CLASS.SETTING, merge: MERGE_STRATEGY.LAST_WRITE_WINS },
  systemInstructionDefaultVersion: { class: SYNC_CLASS.SETTING, merge: MERGE_STRATEGY.LAST_WRITE_WINS },
  showSources: { class: SYNC_CLASS.SETTING, merge: MERGE_STRATEGY.LAST_WRITE_WINS },
  selectedModel: { class: SYNC_CLASS.SETTING, merge: MERGE_STRATEGY.LAST_WRITE_WINS },
  selectedProvider: { class: SYNC_CLASS.SETTING, merge: MERGE_STRATEGY.LAST_WRITE_WINS },
  modelSelectionMode: { class: SYNC_CLASS.SETTING, merge: MERGE_STRATEGY.LAST_WRITE_WINS },

  // Settings to be added in stages 9-10; the key names are pinned here
  // so the contract
  // does not change when the sync engine is written.
  apiKeyUsageMode: { class: SYNC_CLASS.SETTING, merge: MERGE_STRATEGY.LAST_WRITE_WINS, notes: 'primary | balanced_rotation' },
  apiKeyWarningThresholds: { class: SYNC_CLASS.SETTING, merge: MERGE_STRATEGY.LAST_WRITE_WINS, notes: 'Kota/uyarı eşikleri' },
  localOnlyChatDefault: { class: SYNC_CLASS.SETTING, merge: MERGE_STRATEGY.LAST_WRITE_WINS, notes: 'Yeni sohbetin varsayılan eşitleme politikası' },

  // ---- Synced collections (per record) ----
  sessions: { class: SYNC_CLASS.ENTITY, merge: MERGE_STRATEGY.ENTITY_UNION, tombstone: true, notes: 'id bazlı; mesajlar kaydın içinde' },
  geminiApiKeys: { class: SYNC_CLASS.ENTITY, merge: MERGE_STRATEGY.ENTITY_UNION, tombstone: true, notes: 'ham anahtar şifreli taşınır' },
  tavilyApiKeys: { class: SYNC_CLASS.ENTITY, merge: MERGE_STRATEGY.ENTITY_UNION, tombstone: true },
  openRouterApiKeys: { class: SYNC_CLASS.ENTITY, merge: MERGE_STRATEGY.ENTITY_UNION, tombstone: true },
  ollamaApiKeys: { class: SYNC_CLASS.ENTITY, merge: MERGE_STRATEGY.ENTITY_UNION, tombstone: true },

  // ---- Synced statistics ----
  stats: { class: SYNC_CLASS.STATS, merge: MERGE_STRATEGY.STATS_SUM, notes: 'recentFinalizedIds birleşim, lastActive max' },

  // ---- Device only ----
  activeSessionId: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Açık sohbet seçimi cihaza özel' },
  selectedText: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Bağlam menüsü aktarımı' },
  pendingPageUrl: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Bağlam menüsü aktarımı' },
  activeGeneration: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Canlı üretim durumu' },

  // Stage 6-8 infrastructure; all of it is device specific.
  syncLease: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Eşitleme kilidi' },
  syncQueue: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Çevrimdışı kuyruk' },
  syncPullCursor: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Son çekme imleci' },
  syncAutoIntervalMinutes: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Otomatik eşitleme aralığı; cihazın kendi tercihi' },
  syncUsage: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Günlük kota sayacı' },
  modelPreferences: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Cihaz model katalog önbelleği ve seçimi; sır içermez' },
  cloudQuota: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Sunucunun doğrulanmış hesap tüketimi; istemci yetkisi değildir' },
  composerMaxHeight: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Yazı alanı yükseklik tercihi; cihaza özel' },
  deviceCryptoKey: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Cihaza özel sarma anahtarı' },

  // ---- Not synced (legacy/obsolete) ----
  chatHistory: { class: SYNC_CLASS.EXCLUDED, merge: MERGE_STRATEGY.NONE, notes: 'v1 kalıntısı; sessions içine göç edip silinir' },
}

/**
 * Field contract of the synced chat record (converted to a cloud document in stage
 * 3). It matches the `importExport.js` schema; if a field missing there is added,
 * export and sync diverge.
 */
export const SESSION_FIELD_CONTRACT = {
  identity: ['id', 'createdAt', 'updatedAt'],
  meta: ['title', 'isTitleCustom', 'isStarred'],
  policy: ['syncPolicy'],
  context: ['activeAttachmentIds', 'activeWebUrls'],
}

/** Field contract of the synced message. */
export const MESSAGE_FIELD_CONTRACT = {
  identity: ['id', 'role'],
  body: ['content', 'displayContent'],
  provenance: ['model', 'provider', 'resolvedModel', 'mode'],
  web: ['webUrls', 'displayWebUrls'],
  attachments: ['attachments', 'displayAttachmentIds'],
}

/**
 * Attachment policy: the message carries only metadata, binary data is synced
 * separately. Attachments above `maxSyncBytes` are not sent to the cloud and stay on the
 * device.
 */
export const ATTACHMENT_SYNC_POLICY = {
  metadataSynced: true,
  binarySynced: false,
  maxSyncBytes: 0,
  store: 'heraai-attachments',
  missingMetadata: ['id', 'name', 'mimeType', 'size', 'kind', 'availability'],
}

/** Returns the record's class; an unknown key becomes EXCLUDED with the safe default. */
export function classifyStorageKey(key) {
  const entry = CONTRACT[key]
  return entry ? entry.class : SYNC_CLASS.EXCLUDED
}

/** Returns the record's merge strategy. */
export function getMergeStrategy(key) {
  const entry = CONTRACT[key]
  return entry ? entry.merge : MERGE_STRATEGY.NONE
}

/** Are record deletions carried as tombstones? */
export function usesTombstone(key) {
  return CONTRACT[key]?.tombstone === true
}

/** Does the key go to the cloud? */
export function isSyncedKey(key) {
  const cls = classifyStorageKey(key)
  return cls === SYNC_CLASS.SETTING || cls === SYNC_CLASS.ENTITY || cls === SYNC_CLASS.STATS
}

/** Does the key stay on this device only? */
export function isLocalOnlyKey(key) {
  return classifyStorageKey(key) === SYNC_CLASS.LOCAL_ONLY
}

/** All keys in the given class. */
export function getKeysByClass(syncClass) {
  return Object.keys(CONTRACT).filter(key => CONTRACT[key].class === syncClass)
}

/** All synced keys (setting + collection + statistic). */
export function getSyncedKeys() {
  return Object.keys(CONTRACT).filter(isSyncedKey)
}

/** Keys that never go to the cloud (device only + excluded). */
export function getNonSyncedKeys() {
  return Object.keys(CONTRACT).filter(key => !isSyncedKey(key))
}

/**
 * Usage modes to be written in stage 9/10. Pinned here so the key usage mode does
 * not stay outside the sync contract.
 */
export const API_KEY_USAGE_MODES = Object.freeze(['primary', 'balanced_rotation'])

/** Validates a writable mode value; returns `primary` when invalid. */
export function normalizeApiKeyUsageMode(value) {
  return API_KEY_USAGE_MODES.includes(value) ? value : 'primary'
}

/** Per-chat sync policy; an unknown value becomes `synced`. */
export const SESSION_SYNC_POLICIES = Object.freeze(['synced', 'local_only'])

/** Validates a writable policy value. */
export function normalizeSessionSyncPolicy(value) {
  return SESSION_SYNC_POLICIES.includes(value) ? value : 'synced'
}

/** Summary of the contract (for diagnostics and tests). */
export function describeSyncContract() {
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    settings: getKeysByClass(SYNC_CLASS.SETTING),
    entities: getKeysByClass(SYNC_CLASS.ENTITY),
    stats: getKeysByClass(SYNC_CLASS.STATS),
    localOnly: getKeysByClass(SYNC_CLASS.LOCAL_ONLY),
    excluded: getKeysByClass(SYNC_CLASS.EXCLUDED),
  }
}
