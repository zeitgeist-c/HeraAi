/**
 * HeraAi 1.10.0 — Ek dosyalarının eşitlenmesi ve depolama yönetimi (Aşama 8).
 *
 * Görsel, PDF ve metin ekleri Firestore ücretsiz kotasını tüketmeden cihazlar
 * arasında taşınır. Kurallar (plan §12):
 *
 * - Yerelde 20 MiB'a kadar ek saklanır.
 * - Buluta yalnız 3 MiB'a kadar olan eklerin **gövdesi** gider.
 * - 3 MiB üzerindeki ekler cihazda kalır; buluta yalnız metaveri ve
 *   `local_only` bayrağı eşitlenir, diğer cihazlar "bu cihazda var" görür.
 * - Gövde 700 KiB'lik parçalara bölünür, her parça `blobEncryptionKey` ve
 *   benzersiz nonce ile AES-256-GCM şifrelenir.
 * - Parçalar yüklendikten sonra manifest `status: "ready"` olur.
 * - Aynı SHA-256 içeriğe sahip ekler bulutta tek blob altında referanslanır.
 */

import {
  buildAad,
  decryptBytes,
  encryptBytes,
  randomBytes,
  bytesToBase64,
  base64ToBytes,
} from './syncCrypto'
import { CLOUD_SCHEMA_VERSION, CRYPTO_VERSION, cloudPaths } from './syncModel'
import { ATTACHMENT_SYNC_POLICY } from './syncContract'

/** Boyut sınırları (plan §12). */
export const ATTACHMENT_LIMITS = Object.freeze({
  /** Yerel depolama üst sınırı. */
  localMaxBytes: 20 * 1024 * 1024,
  /** Buluta eşitlenen ekler için üst sınır. */
  cloudMaxBytes: 3 * 1024 * 1024,
  /** Parça boyutu. */
  chunkBytes: 700 * 1024,
})

/** Ekin buluttaki durumu. */
export const ATTACHMENT_AVAILABILITY = Object.freeze({
  /** Gövde bulutta; her cihaz indirebilir. */
  SYNCED: 'synced',
  /** Gövde yalnız bu cihazda; bulutta metaveri var. */
  LOCAL_ONLY: 'local_only',
  /** Parçalar yükleniyor; manifest henüz hazır değil. */
  PENDING: 'pending',
  /** Gövde bulutta ama bu cihazda yok. */
  REMOTE_ONLY: 'remote_only',
})

/** Eşitleme kararı. */
export const ATTACHMENT_SYNC_MODE = Object.freeze({
  /** Gövde parçalanıp buluta gönderilir. */
  CHUNKED: 'chunked',
  /** Yalnız metaveri gider. */
  METADATA_ONLY: 'metadata_only',
})

export const ATTACHMENT_MANIFEST_STATUS = Object.freeze({
  UPLOADING: 'uploading',
  READY: 'ready',
})

/** Sözleşmedeki sınırla uyum denetimi (test ve dokümantasyon). */
export function describeAttachmentSync() {
  return {
    localMaxBytes: ATTACHMENT_LIMITS.localMaxBytes,
    cloudMaxBytes: ATTACHMENT_LIMITS.cloudMaxBytes,
    chunkBytes: ATTACHMENT_LIMITS.chunkBytes,
    maxSyncBytes: ATTACHMENT_SYNC_POLICY.maxSyncBytes,
    store: ATTACHMENT_SYNC_POLICY.store,
    availability: Object.values(ATTACHMENT_AVAILABILITY),
  }
}

function sayi(deger) {
  const n = Number(deger)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/**
 * Ekin nasıl eşitleneceğine karar verir.
 * 3 MiB üzerindeki ekler cihazda kalır; buluta yalnız metaveri gider.
 */
export function planAttachmentSync({ size, chunkBytes = ATTACHMENT_LIMITS.chunkBytes } = {}) {
  const boyut = sayi(size)
  if (boyut > ATTACHMENT_LIMITS.localMaxBytes) {
    return {
      mode: ATTACHMENT_SYNC_MODE.METADATA_ONLY,
      reason: 'over_local_limit',
      chunkCount: 0,
      availability: ATTACHMENT_AVAILABILITY.LOCAL_ONLY,
      syncBinary: false,
    }
  }
  if (boyut > ATTACHMENT_SYNC_POLICY.maxSyncBytes) {
    return {
      mode: ATTACHMENT_SYNC_MODE.METADATA_ONLY,
      reason: 'over_cloud_limit',
      chunkCount: 0,
      availability: ATTACHMENT_AVAILABILITY.LOCAL_ONLY,
      syncBinary: false,
    }
  }
  return {
    mode: ATTACHMENT_SYNC_MODE.CHUNKED,
    reason: null,
    chunkCount: chunkCount(boyut, chunkBytes),
    availability: ATTACHMENT_AVAILABILITY.SYNCED,
    syncBinary: true,
  }
}

/** Parça sayısı; boş içerik de tek parça üretir. */
export function chunkCount(size, chunkBytes = ATTACHMENT_LIMITS.chunkBytes) {
  const boyut = sayi(size)
  const parca = sayi(chunkBytes) || ATTACHMENT_LIMITS.chunkBytes
  if (boyut === 0) return 1
  return Math.ceil(boyut / parca)
}

/** Ham baytları sabit boyutlu parçalara böler. */
export function splitIntoChunks(bytes, chunkBytes = ATTACHMENT_LIMITS.chunkBytes) {
  const ham = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  const parca = sayi(chunkBytes) || ATTACHMENT_LIMITS.chunkBytes
  if (ham.length === 0) return [new Uint8Array(0)]
  const sonuc = []
  for (let i = 0; i < ham.length; i += parca) {
    sonuc.push(ham.subarray(i, Math.min(i + parca, ham.length)))
  }
  return sonuc
}

/** Parçaları tek bayt dizisinde birleştirir. */
export function mergeChunks(chunks) {
  const parcalar = (chunks || []).map(parca =>
    parca instanceof Uint8Array ? parca : new Uint8Array(parca || []),
  )
  const toplam = parcalar.reduce((acc, parca) => acc + parca.length, 0)
  const sonuc = new Uint8Array(toplam)
  let konum = 0
  for (const parca of parcalar) {
    sonuc.set(parca, konum)
    konum += parca.length
  }
  return sonuc
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** İçerik parmak izi: deduplication anahtarı. */
export async function computeSha256(bytes) {
  const ham = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  const ozet = await globalThis.crypto.subtle.digest('SHA-256', ham)
  return hex(ozet)
}

/**
 * Ekin AAD'si: parça indeksi bağlama eklenir ki bir parça başka bir ekin
 * yerine geçirilemesin (parça karıştırma saldırısı).
 */
export function attachmentAad({ ownerUid, opaqueAttachmentId, chunkIndex = null }) {
  const temel = buildAad({ ownerUid, opaqueEntityId: opaqueAttachmentId, entityType: 'attachment' })
  if (chunkIndex === null) return temel
  const ek = new TextEncoder().encode(`|chunk:${chunkIndex}`)
  const sonuc = new Uint8Array(temel.length + ek.length)
  sonuc.set(temel, 0)
  sonuc.set(ek, temel.length)
  return sonuc
}

/**
 * Ek gövdesini şifreli parçalara çevirir.
 * Dönen her parça `{ index, nonce, ciphertext, byteLength }` taşır.
 */
export async function encryptAttachmentChunks({
  blobKey,
  bytes,
  ownerUid,
  opaqueAttachmentId,
  chunkBytes = ATTACHMENT_LIMITS.chunkBytes,
} = {}) {
  if (!blobKey) throw new Error('attachment_blob_key_missing')
  if (!ownerUid) throw new Error('attachment_owner_missing')
  if (!opaqueAttachmentId) throw new Error('attachment_id_missing')

  const parcalar = splitIntoChunks(bytes, chunkBytes)
  const sonuc = []
  for (let i = 0; i < parcalar.length; i += 1) {
    const aad = attachmentAad({ ownerUid, opaqueAttachmentId, chunkIndex: i })
    const zarf = await encryptBytes(blobKey, parcalar[i], aad)
    sonuc.push({
      index: i,
      nonce: zarf.nonce,
      ciphertext: zarf.ciphertext,
      byteLength: parcalar[i].length,
    })
  }
  return sonuc
}

/** Şifreli parçaları çözer ve birleştirir; bozuk parça `attachment_chunk_failed` üretir. */
export async function decryptAttachmentChunks({
  blobKey,
  chunks,
  ownerUid,
  opaqueAttachmentId,
} = {}) {
  if (!blobKey) throw new Error('attachment_blob_key_missing')
  const liste = [...(chunks || [])].sort((a, b) => sayi(a.index) - sayi(b.index))
  const parcalar = []
  for (const parca of liste) {
    const aad = attachmentAad({ ownerUid, opaqueAttachmentId, chunkIndex: sayi(parca.index) })
    try {
      parcalar.push(await decryptBytes(blobKey, { nonce: parca.nonce, ciphertext: parca.ciphertext }, aad))
    } catch {
      throw new Error('attachment_chunk_failed')
    }
  }
  return mergeChunks(parcalar)
}

/** Ek dosya adını `blobEncryptionKey` ile şifreler (buluta düz ad gitmez). */
export async function encryptAttachmentName({ blobKey, name, ownerUid, opaqueAttachmentId } = {}) {
  if (!blobKey) throw new Error('attachment_blob_key_missing')
  const aad = attachmentAad({ ownerUid, opaqueAttachmentId })
  const zarf = await encryptBytes(blobKey, new TextEncoder().encode(String(name || '')), aad)
  return { nonce: zarf.nonce, ciphertext: zarf.ciphertext }
}

/** Şifreli dosya adını çözer. */
export async function decryptAttachmentName({
  blobKey,
  envelope,
  ownerUid,
  opaqueAttachmentId,
} = {}) {
  if (!blobKey) throw new Error('attachment_blob_key_missing')
  if (!envelope?.ciphertext) return ''
  const aad = attachmentAad({ ownerUid, opaqueAttachmentId })
  try {
    const bayt = await decryptBytes(blobKey, envelope, aad)
    return new TextDecoder().decode(bayt)
  } catch {
    throw new Error('attachment_name_failed')
  }
}

/**
 * Blob manifesti: parçalar yüklendikten sonra `status: "ready"` yapılır.
 * `sha256` düz metin içeriğin parmak izidir; mükerrer ekler bu değerle
 * bulutta tek blob altında referanslanır.
 */
export function buildBlobManifest({
  ownerUid,
  opaqueAttachmentId,
  totalBytes,
  chunkBytes = ATTACHMENT_LIMITS.chunkBytes,
  sha256,
  nameEnvelope = null,
  mimeType = null,
  kind = null,
  availability = ATTACHMENT_AVAILABILITY.SYNCED,
  status = ATTACHMENT_MANIFEST_STATUS.UPLOADING,
  sourceDeviceId = null,
  createdAt = null,
  updatedAt = null,
  schemaVersion = CLOUD_SCHEMA_VERSION,
  cryptoVersion = CRYPTO_VERSION,
} = {}) {
  if (!ownerUid) throw new Error('attachment_owner_missing')
  if (!opaqueAttachmentId) throw new Error('attachment_id_missing')
  if (!sha256) throw new Error('attachment_hash_missing')
  const boyut = sayi(totalBytes)
  return {
    ownerUid,
    opaqueAttachmentId,
    schemaVersion,
    cryptoVersion,
    totalBytes: boyut,
    chunkBytes: sayi(chunkBytes) || ATTACHMENT_LIMITS.chunkBytes,
    chunkCount: chunkCount(boyut, chunkBytes),
    sha256,
    nameEnvelope,
    mimeType,
    kind,
    availability,
    status,
    sourceDeviceId,
    createdAt,
    updatedAt,
  }
}

/** Manifestin indirilebilir olduğunu bildirir. */
export function isManifestReady(manifest) {
  return (
    manifest?.status === ATTACHMENT_MANIFEST_STATUS.READY &&
    manifest?.availability === ATTACHMENT_AVAILABILITY.SYNCED &&
    sayi(manifest?.chunkCount) > 0
  )
}

/**
 * Tembel indirme kararı (plan §12): sohbet listesi açılırken gövdeler
 * indirilmez; yalnız kullanıcı eki açtığında çekilir.
 */
export function shouldFetchAttachment({ manifest, hasLocalBody, requested = false } = {}) {
  if (!requested) return false
  if (hasLocalBody) return false
  return isManifestReady(manifest)
}

/**
 * Mükerrer ek tespiti: aynı `sha256` daha önce yüklendiyse gövde tekrar
 * gönderilmez, yalnız yeni kayıt mevcut blob'a referans verir.
 */
export function findDuplicateAttachment(manifest, candidates) {
  const ozet = manifest?.sha256
  if (!ozet) return null
  for (const aday of candidates || []) {
    if (!aday || aday.opaqueAttachmentId === manifest.opaqueAttachmentId) continue
    if (aday.sha256 !== ozet) continue
    if (!isManifestReady(aday)) continue
    return aday
  }
  return null
}

/** Yükün buluta gönderilmeyeceği durumda cihazda kalma kararı. */
export function attachmentAvailabilityFor({ size }) {
  return planAttachmentSync({ size }).availability
}

/** Firestore yolları: manifest ve parçalar. */
export function attachmentPaths(uid, opaqueAttachmentId, chunkIndex = null) {
  if (chunkIndex === null) return cloudPaths.blob(uid, opaqueAttachmentId)
  return cloudPaths.blobChunk(uid, opaqueAttachmentId, chunkIndex)
}

/** Parçalar için taze nonce üretir (test ve dış kullanım). */
export function freshNonce() {
  return bytesToBase64(randomBytes(12))
}

/** Base64 parçayı ham bayta çevirir (indirme yolu). */
export function chunkFromBase64(value) {
  return base64ToBytes(value)
}
