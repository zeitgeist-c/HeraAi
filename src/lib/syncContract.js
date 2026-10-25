/**
 * HeraAi 1.10.0 — eşitleme sözleşmesi (Aşama 2).
 *
 * Hangi `chrome.storage.local` anahtarının buluta gittiğini, hangisinin yalnız
 * cihazda kaldığını ve eşitlenen her verinin nasıl birleştirileceğini tek yerde
 * tanımlar. Sonraki aşamalar (bulut veri modeli, şifreleme, eşitleme motoru)
 * yalnızca bu tabloyu okur; sınıflandırma kararı başka bir dosyada tekrarlanmaz.
 *
 * Gizlilik: eşitlenen her yük istemci tarafında şifrelenir; sunucu yalnızca
 * opak kimlikler ve sürüm damgaları görür. İstatistikler hiçbir koşulda sohbet
 * metni, URL veya dosya içeriği taşımaz.
 *
 * Sınıflandırılmamış bir anahtar `EXCLUDED` sayılır — yeni bir ayar eklerken
 * buraya satır eklenmeden hiçbir şey buluta gitmez (güvenli varsayılan).
 */

export const SYNC_SCHEMA_VERSION = 1

/** Veri sınıfları. */
export const SYNC_CLASS = {
  /** Tek değerlik ayar; son yazan kazanır. */
  SETTING: 'setting',
  /** Kimlikli kayıt koleksiyonu; kayıt bazında birleştirilir. */
  ENTITY: 'entity',
  /** Sayaç ağacı; toplanarak birleştirilir. */
  STATS: 'stats',
  /** Yalnız bu cihazda kalır. */
  LOCAL_ONLY: 'local_only',
  /** Eşitlenmez; eski/artık veri veya cihaz altyapısı. */
  EXCLUDED: 'excluded',
}

/** Birleştirme stratejileri. */
export const MERGE_STRATEGY = {
  /** Aynı anahtar için en yeni `updatedAt` kazanır. */
  LAST_WRITE_WINS: 'last_write_wins',
  /** Kayıt kimliği bazında birleşim; silmeler tombstone ile taşınır. */
  ENTITY_UNION: 'entity_union',
  /** Günlük sayaçlar toplanır; kimlik listeleri birleşir. */
  STATS_SUM: 'stats_sum',
  /** Birleştirme yok. */
  NONE: 'none',
}

/**
 * Sözleşme tablosu: anahtar -> { class, merge, tombstone, notes }.
 * `notes` yalnızca bakım için açıklamadır; davranışı değiştirmez.
 */
const CONTRACT = {
  // ---- Eşitlenen ayarlar (tek değer) ----
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

  // Aşama 9-10'da eklenecek ayarlar; anahtar adları burada sabitlenir ki
  // eşitleme motoru yazıldığında sözleşme değişmesin.
  apiKeyUsageMode: { class: SYNC_CLASS.SETTING, merge: MERGE_STRATEGY.LAST_WRITE_WINS, notes: 'primary | balanced_rotation' },
  apiKeyWarningThresholds: { class: SYNC_CLASS.SETTING, merge: MERGE_STRATEGY.LAST_WRITE_WINS, notes: 'Kota/uyarı eşikleri' },
  localOnlyChatDefault: { class: SYNC_CLASS.SETTING, merge: MERGE_STRATEGY.LAST_WRITE_WINS, notes: 'Yeni sohbetin varsayılan eşitleme politikası' },

  // ---- Eşitlenen koleksiyonlar (kayıt bazlı) ----
  sessions: { class: SYNC_CLASS.ENTITY, merge: MERGE_STRATEGY.ENTITY_UNION, tombstone: true, notes: 'id bazlı; mesajlar kaydın içinde' },
  geminiApiKeys: { class: SYNC_CLASS.ENTITY, merge: MERGE_STRATEGY.ENTITY_UNION, tombstone: true, notes: 'ham anahtar şifreli taşınır' },
  tavilyApiKeys: { class: SYNC_CLASS.ENTITY, merge: MERGE_STRATEGY.ENTITY_UNION, tombstone: true },
  openRouterApiKeys: { class: SYNC_CLASS.ENTITY, merge: MERGE_STRATEGY.ENTITY_UNION, tombstone: true },
  ollamaApiKeys: { class: SYNC_CLASS.ENTITY, merge: MERGE_STRATEGY.ENTITY_UNION, tombstone: true },

  // ---- Eşitlenen istatistikler ----
  stats: { class: SYNC_CLASS.STATS, merge: MERGE_STRATEGY.STATS_SUM, notes: 'recentFinalizedIds birleşim, lastActive max' },

  // ---- Yalnız cihazda ----
  activeSessionId: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Açık sohbet seçimi cihaza özel' },
  selectedText: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Bağlam menüsü aktarımı' },
  pendingPageUrl: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Bağlam menüsü aktarımı' },
  activeGeneration: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Canlı üretim durumu' },

  // Aşama 6-8 altyapısı; hepsi cihaza özel.
  syncLease: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Eşitleme kilidi' },
  syncQueue: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Çevrimdışı kuyruk' },
  syncPullCursor: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Son çekme imleci' },
  syncAutoIntervalMinutes: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Otomatik eşitleme aralığı; cihazın kendi tercihi' },
  syncUsage: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Günlük kota sayacı' },
  modelPreferences: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Cihaz model katalog önbelleği ve seçimi; sır içermez' },
  cloudQuota: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Sunucunun doğrulanmış hesap tüketimi; istemci yetkisi değildir' },
  composerMaxHeight: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Yazı alanı yükseklik tercihi; cihaza özel' },
  deviceCryptoKey: { class: SYNC_CLASS.LOCAL_ONLY, merge: MERGE_STRATEGY.NONE, notes: 'Cihaza özel sarma anahtarı' },

  // ---- Eşitlenmeyen (eski/artık) ----
  chatHistory: { class: SYNC_CLASS.EXCLUDED, merge: MERGE_STRATEGY.NONE, notes: 'v1 kalıntısı; sessions içine göç edip silinir' },
}

/**
 * Eşitlenen sohbet kaydının alan sözleşmesi (Aşama 3'te bulut belgesine
 * dönüştürülür). `importExport.js` şemasıyla aynıdır; orada olmayan alan
 * eklenirse dışa aktarma ve eşitleme ayrışır.
 */
export const SESSION_FIELD_CONTRACT = {
  identity: ['id', 'createdAt', 'updatedAt'],
  meta: ['title', 'isTitleCustom', 'isStarred'],
  policy: ['syncPolicy'],
  context: ['activeAttachmentIds', 'activeWebUrls'],
}

/** Eşitlenen mesajın alan sözleşmesi. */
export const MESSAGE_FIELD_CONTRACT = {
  identity: ['id', 'role'],
  body: ['content', 'displayContent'],
  provenance: ['model', 'provider', 'resolvedModel', 'mode'],
  web: ['webUrls', 'displayWebUrls'],
  attachments: ['attachments', 'displayAttachmentIds'],
}

/**
 * Ek dosya politikası: mesaj yalnızca metadata taşır, ikili veri ayrı eşitlenir.
 * `maxSyncBytes` üstündeki ekler buluta gönderilmez ve cihazda kalır.
 */
export const ATTACHMENT_SYNC_POLICY = {
  metadataSynced: true,
  binarySynced: false,
  maxSyncBytes: 0,
  store: 'heraai-attachments',
  missingMetadata: ['id', 'name', 'mimeType', 'size', 'kind', 'availability'],
}

/** Kaydın sınıfını döndürür; bilinmeyen anahtar güvenli varsayılanla EXCLUDED olur. */
export function classifyStorageKey(key) {
  const entry = CONTRACT[key]
  return entry ? entry.class : SYNC_CLASS.EXCLUDED
}

/** Kaydın birleştirme stratejisini döndürür. */
export function getMergeStrategy(key) {
  const entry = CONTRACT[key]
  return entry ? entry.merge : MERGE_STRATEGY.NONE
}

/** Kayıt silmeleri tombstone ile mi taşınır? */
export function usesTombstone(key) {
  return CONTRACT[key]?.tombstone === true
}

/** Anahtar buluta gidiyor mu? */
export function isSyncedKey(key) {
  const cls = classifyStorageKey(key)
  return cls === SYNC_CLASS.SETTING || cls === SYNC_CLASS.ENTITY || cls === SYNC_CLASS.STATS
}

/** Anahtar yalnız bu cihazda mı kalıyor? */
export function isLocalOnlyKey(key) {
  return classifyStorageKey(key) === SYNC_CLASS.LOCAL_ONLY
}

/** Verilen sınıftaki tüm anahtarlar. */
export function getKeysByClass(syncClass) {
  return Object.keys(CONTRACT).filter(key => CONTRACT[key].class === syncClass)
}

/** Eşitlenen anahtarların tamamı (ayar + koleksiyon + istatistik). */
export function getSyncedKeys() {
  return Object.keys(CONTRACT).filter(isSyncedKey)
}

/** Buluta hiç gitmeyen anahtarlar (cihaza özel + hariç tutulan). */
export function getNonSyncedKeys() {
  return Object.keys(CONTRACT).filter(key => !isSyncedKey(key))
}

/**
 * Aşama 9/10'da yazılacak çalışma modları. Burada sabitlenir ki anahtar
 * kullanım modu eşitleme sözleşmesinin dışında kalmasın.
 */
export const API_KEY_USAGE_MODES = Object.freeze(['primary', 'balanced_rotation'])

/** Yazılabilir bir mod değerini doğrular; geçersizse `primary` döner. */
export function normalizeApiKeyUsageMode(value) {
  return API_KEY_USAGE_MODES.includes(value) ? value : 'primary'
}

/** Sohbet bazlı eşitleme politikası; bilinmeyen değer `synced` olur. */
export const SESSION_SYNC_POLICIES = Object.freeze(['synced', 'local_only'])

/** Yazılabilir bir politika değerini doğrular. */
export function normalizeSessionSyncPolicy(value) {
  return SESSION_SYNC_POLICIES.includes(value) ? value : 'synced'
}

/** Sözleşmenin özeti (teşhis ve testler için). */
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
