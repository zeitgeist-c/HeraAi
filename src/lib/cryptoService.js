/**
 * HeraAi 1.10.0 — Kripto servisi (Aşama 13).
 *
 * Plandaki `CryptoService` arayüzünün tek giriş noktası. Alt katman
 * `syncCrypto` fonksiyonlarını sarar; böylece çağıranlar hangi primitifin
 * kullanıldığını bilmez ve anahtar hiyerarşisi tek yerden yönetilir.
 *
 * Anahtar hiyerarşisi:
 *   cihaz anahtarı (cihazda, dışa aktarılamaz)
 *     └─ sarar → ana sır (cloudMasterSecret)
 *          └─ HKDF → veri / blob / HMAC kimlik / parmak izi / yedek anahtarları
 */

import {
  CRYPTO_ERROR_CODES,
  computeKeyFingerprint,
  decryptBytes,
  decryptJson,
  deriveSubkeys,
  encryptBytes,
  encryptJson,
  generateDeviceKey,
  generateMasterSecretBytes,
  generateRecoveryCode,
  importMasterSecret,
  isValidRecoveryCode,
  normalizeRecoveryCode,
  openMasterSecretFromRecovery,
  sealMasterSecretForRecovery,
  unwrapMasterSecretFromDevice,
  wrapMasterSecretForDevice,
} from './syncCrypto'
import { deriveOpaqueAttachmentId, deriveOpaqueId } from './syncModel'

/** Servis hatalarını tek tipe indirger. */
function servisHatasi(kod) {
  const error = new Error(kod)
  error.code = kod
  return error
}

export function createCryptoService() {
  return {
    // ---- Cihaz ve ana sır ----
    /** Cihaz anahtarı: kasayı açar, hiçbir zaman dışa aktarılmaz. */
    createDeviceKey: () => generateDeviceKey(),

    /** Ana sır: rastgele 32 bayt + ondan türeyen HKDF anahtarı. */
    async createCloudMasterSecret() {
      const bytes = generateMasterSecretBytes()
      const key = await importMasterSecret(bytes)
      return { bytes, key }
    },

    /** Ana sırdan görev anahtarlarını türetir. */
    deriveSubKeys: masterSecretKey => deriveSubkeys(masterSecretKey),

    // ---- Kurtarma ----
    /** 160-bit kurtarma kodu üretir (32 karakter, karıştırılması kolay harfler yok). */
    createRecoveryCode: () => generateRecoveryCode(),

    normalizeRecoveryCode: code => normalizeRecoveryCode(code),

    isValidRecoveryCode: code => isValidRecoveryCode(code),

    /** Kurtarma kodunu PBKDF2 ile sarıp zarf üretir. */
    createRecoveryEnvelope: (masterSecretBytes, recoveryCode, options) =>
      sealMasterSecretForRecovery(masterSecretBytes, recoveryCode, options),

    /** Kurtarma koduyla ana sırrı açar. */
    async unlockWithRecoveryCode(envelope, recoveryCode) {
      const bytes = await openMasterSecretFromRecovery(envelope, recoveryCode)
      return { bytes, key: await importMasterSecret(bytes) }
    },

    // ---- Cihaz sarması ----
    wrapMasterSecretForDevice: (deviceKey, masterSecretBytes) =>
      wrapMasterSecretForDevice(deviceKey, masterSecretBytes),

    async unwrapMasterSecretWithDevice(deviceKey, envelope) {
      const bytes = await unwrapMasterSecretFromDevice(deviceKey, envelope)
      return { bytes, key: await importMasterSecret(bytes) }
    },

    // ---- Varlık şifreleme ----
    encryptEntity: (dataKey, payload, aad) => encryptJson(dataKey, payload, aad),

    decryptEntity: (dataKey, envelope, aad) => decryptJson(dataKey, envelope, aad),

    encryptBytes: (key, bytes, aad) => encryptBytes(key, bytes, aad),

    decryptBytes: (key, envelope, aad) => decryptBytes(key, envelope, aad),

    // ---- Kimlikler ve parmak izi ----
    /** Opak varlık kimliği: `HMAC(hmacKey, "<entityType>:<logicalId>")`. */
    deriveOpaqueId: (hmacKey, entityType, logicalId) => deriveOpaqueId(hmacKey, entityType, logicalId),

    /** Ek dosyalar için opak kimlik. */
    deriveOpaqueAttachmentId: (hmacKey, attachmentId) => deriveOpaqueAttachmentId(hmacKey, attachmentId),

    /** Gizli parmak izi: mükerrer API anahtarını açık metin karşılaştırmadan bulur. */
    deriveSecretFingerprint: (fingerprintKey, rawKey) => computeKeyFingerprint(fingerprintKey, rawKey),

    // ---- Yardımcı ----
    isKnownError: error => CRYPTO_ERROR_CODES.has(error?.code || error?.message),
  }
}

/** Kripto servisinin tanıtımı (test ve dokümantasyon). */
export function describeCryptoService() {
  return {
    methods: [
      'createDeviceKey',
      'createCloudMasterSecret',
      'deriveSubKeys',
      'createRecoveryCode',
      'createRecoveryEnvelope',
      'unlockWithRecoveryCode',
      'wrapMasterSecretForDevice',
      'unwrapMasterSecretWithDevice',
      'encryptEntity',
      'decryptEntity',
      'deriveOpaqueId',
      'deriveSecretFingerprint',
    ],
    keyHierarchy: ['deviceKey', 'masterSecret', 'dataKey', 'blobKey', 'hmacKey', 'fingerprintKey', 'backupKey'],
  }
}

/** Servis örneğini üretir; bilinmeyen hata kodlarını dışa taşımaz. */
export function assertCryptoService(service) {
  const gerekli = describeCryptoService().methods
  for (const ad of gerekli) {
    if (typeof service?.[ad] !== 'function') throw servisHatasi(`crypto_service_missing_${ad}`)
  }
  return true
}
