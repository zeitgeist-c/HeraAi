/**
 * HeraAi 1.10.0 — istemci tarafı şifreleme ve anahtar yönetimi (Aşama 4).
 *
 * Anahtar hiyerarşisi (plan §8):
 *
 *   Kurtarma kodu (160-bit) ──PBKDF2-SHA-256(600k, 128-bit salt)──▶ kurtarma
 *        sarmalama anahtarı ──AES-256-GCM──▶ recoveryEnvelope
 *
 *   Bulut ana sırrı (256-bit, HKDF) ──HKDF-SHA-256(info)──▶ görev anahtarları
 *        ├─ dataEncryptionKey  (AES-GCM) ayar/sohbet/mesaj
 *        ├─ hmacIdKey          (HMAC)    opak belge kimliği
 *        ├─ fingerprintKey     (HMAC)    yinelenen API anahtarı parmak izi
 *        └─ backupKey          (AES-GCM) çevrimdışı yedek dosyası
 *
 *   Bulut ana sırrı ayrıca her cihazın yerel anahtarıyla sarmalanır
 *   (`deviceMasterKeyEnvelope`); cihaz anahtarı `extractable: false` üretilir ve
 *   cihazdan dışarı çıkmaz.
 *
 * Tüm şifreleme AES-256-GCM'dir, her kayıt için 96-bit taze nonce kullanılır ve
 * yük; `ownerUid|opaqueEntityId|entityType|vN` biçimindeki AAD'ye bağlanır —
 * şifreli metin başka bir belgeye kopyalanırsa çözme anında başarısız olur.
 *
 * Kurtarma kodu ve ana sır sunucuya asla açık halde gönderilmez.
 */

import { CLOUD_SCHEMA_VERSION, CRYPTO_VERSION } from './syncModel'

export const PBKDF2_ITERATIONS = 600_000
export const RECOVERY_SALT_LENGTH = 16
export const NONCE_LENGTH = 12
export const MASTER_SECRET_LENGTH = 32
export const RECOVERY_CODE_GROUPS = 8
export const RECOVERY_CODE_GROUP_SIZE = 4
export const RECOVERY_CODE_LENGTH = RECOVERY_CODE_GROUPS * RECOVERY_CODE_GROUP_SIZE
export const RECOVERY_CODE_MIN_LENGTH = 16

/** Karıştırılması kolay harfler (I/O/0/1) alfabede yok; 32 karakter = 5 bit. */
export const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** HKDF `info` parametreleri — sürümlenmiş sabit metinler. */
export const HKDF_INFO = Object.freeze({
  dataEncryptionKey: 'heraai-data-encryption',
  hmacIdKey: 'heraai-opaque-id-hmac',
  fingerprintKey: 'heraai-key-fingerprint',
  backupKey: 'heraai-offline-backup',
})

const HKDF_SALT = 'heraai-sync-v1'

/** Görev anahtarlarının Web Crypto algoritma tanımları. */
export const SUBKEY_ALGORITHMS = Object.freeze({
  dataEncryptionKey: { name: 'AES-GCM', length: 256 },
  hmacIdKey: { name: 'HMAC', hash: 'SHA-256' },
  fingerprintKey: { name: 'HMAC', hash: 'SHA-256' },
  backupKey: { name: 'AES-GCM', length: 256 },
})

export const CRYPTO_ERROR_CODES = new Set([
  'crypto_unavailable',
  'recovery_code_invalid',
  'recovery_envelope_invalid',
  'device_envelope_invalid',
  'decrypt_failed',
  'subkey_unknown',
])

function cryptoError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function subtle() {
  const value = globalThis.crypto?.subtle
  if (!value) throw cryptoError('crypto_unavailable')
  return value
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Kriptografik rastgele bayt dizisi. */
export function randomBytes(length) {
  const bytes = new Uint8Array(length)
  const source = globalThis.crypto
  if (!source?.getRandomValues) throw cryptoError('crypto_unavailable')
  source.getRandomValues(bytes)
  return bytes
}

/** Uint8Array veya ArrayBuffer -> base64 (Firestore'da taşınabilir metin). */
export function bytesToBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  // Tek tek string birleştirme büyük yedeklerde O(n²) bellek kopyası üretiyordu;
  // 32 KB'lık dilimlerle fromCharCode çağrısı aynı çıktıyı ~4x hızlı verir.
  const CHUNK = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/** base64 -> Uint8Array. */
export function base64ToBytes(value) {
  const binary = atob(String(value || ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------- cihaz anahtarı

/**
 * Cihaz yerel anahtarı: 256-bit AES-GCM, `extractable: false`.
 * Ana sırrı sarmak/açmak ve yerel API kasasını şifrelemek için kullanılır;
 * dışa aktarılamaz ve hiçbir zaman buluta gitmez.
 */
export async function generateDeviceKey() {
  return subtle().generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
  )
}

// ---------------------------------------------------------- bulut ana sırrı

/** İlk kurulumda üretilen 256-bit rastgele ana sır baytları. */
export function generateMasterSecretBytes() {
  return randomBytes(MASTER_SECRET_LENGTH)
}

/**
 * Baytları HKDF anahtarına aktarır. Yalnız türetim içindir: Web Crypto, HKDF
 * anahtarlarının dışa aktarılabilir olmasını yasaklar (`SyntaxError`), bu
 * yüzden ana sırrın kendisi gerektiğinde ham bayt olarak taşınır.
 */
export async function importMasterSecret(rawBytes) {
  return subtle().importKey('raw', rawBytes, 'HKDF', false, ['deriveKey', 'deriveBits'])
}

/** Cihaz anahtarıyla sarar; çıktı `devices/{deviceId}.deviceMasterKeyEnvelope`. */
export async function wrapMasterSecretForDevice(deviceKey, masterSecretBytes) {
  const nonce = randomBytes(NONCE_LENGTH)
  const wrapped = await subtle().encrypt(
    { name: 'AES-GCM', iv: nonce },
    deviceKey,
    masterSecretBytes,
  )
  return {
    version: CRYPTO_VERSION,
    algorithm: 'AES-256-GCM',
    nonce: bytesToBase64(nonce),
    wrapped: bytesToBase64(wrapped),
  }
}

/** Cihaz zarfını açar ve ana sır baytlarını döndürür. */
export async function unwrapMasterSecretFromDevice(deviceKey, envelope) {
  if (!envelope?.wrapped || !envelope?.nonce) throw cryptoError('device_envelope_invalid')
  try {
    const plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(envelope.nonce) },
      deviceKey,
      base64ToBytes(envelope.wrapped),
    )
    return new Uint8Array(plaintext)
  } catch {
    throw cryptoError('device_envelope_invalid')
  }
}

// ------------------------------------------------------------- görev anahtarları

/** Tek bir görev anahtarını HKDF ile türetir. */
export async function deriveSubkey(masterSecretKey, name) {
  const algorithm = SUBKEY_ALGORITHMS[name]
  if (!algorithm) throw cryptoError('subkey_unknown')
  const usages = algorithm.name === 'HMAC' ? ['sign'] : ['encrypt', 'decrypt']
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(HKDF_SALT),
      info: encoder.encode(HKDF_INFO[name]),
    },
    masterSecretKey,
    algorithm,
    false,
    usages,
  )
}

/** Tüm görev anahtarlarını tek çağrıda türetir. */
export async function deriveSubkeys(masterSecretKey) {
  const names = Object.keys(SUBKEY_ALGORITHMS)
  const keys = await Promise.all(names.map(name => deriveSubkey(masterSecretKey, name)))
  return Object.fromEntries(names.map((name, index) => [name, keys[index]]))
}

// ------------------------------------------------------------------ kurtarma

/** Okunabilir 160-bit kurtarma kodu (`XXXX-XXXX-...`). */
export function generateRecoveryCode() {
  const bytes = randomBytes(RECOVERY_CODE_LENGTH)
  // Alfabe 32 karakter olduğu için 256 % 32 === 0 — modulo yanlılığı yok.
  const chars = Array.from(bytes, byte => RECOVERY_CODE_ALPHABET[byte % RECOVERY_CODE_ALPHABET.length])
  const groups = []
  for (let i = 0; i < chars.length; i += RECOVERY_CODE_GROUP_SIZE) {
    groups.push(chars.slice(i, i + RECOVERY_CODE_GROUP_SIZE).join(''))
  }
  return groups.join('-')
}

/** Kullanıcı girişini karşılaştırılabilir hale getirir (büyük harf, ayraçsız). */
export function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Kapalı anahtar: yalnız alfabedeki karakterler ve yeterli uzunluk. */
export function isValidRecoveryCode(code) {
  const normalized = normalizeRecoveryCode(code)
  if (normalized.length < RECOVERY_CODE_MIN_LENGTH) return false
  return [...normalized].every(char => RECOVERY_CODE_ALPHABET.includes(char))
}

/** Kurtarma kodundan PBKDF2 ile sarmalama anahtarı türetir. */
export async function deriveRecoveryWrappingKey(code, salt, { iterations = PBKDF2_ITERATIONS } = {}) {
  const normalized = normalizeRecoveryCode(code)
  if (normalized.length < RECOVERY_CODE_MIN_LENGTH) throw cryptoError('recovery_code_invalid')
  if (!salt) throw cryptoError('recovery_code_invalid')
  const baseKey = await subtle().importKey('raw', encoder.encode(normalized), 'PBKDF2', false, ['deriveKey'])
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Ana sırrı kurtarma koduyla şifreleyip `account/root.recoveryEnvelope` üretir.
 * `iterations` yalnız testte düşürülür; üretimde varsayılan 600.000'dir.
 */
export async function sealMasterSecretForRecovery(masterSecretBytes, code, { iterations = PBKDF2_ITERATIONS } = {}) {
  if (!isValidRecoveryCode(code)) throw cryptoError('recovery_code_invalid')
  const salt = randomBytes(RECOVERY_SALT_LENGTH)
  const wrappingKey = await deriveRecoveryWrappingKey(code, salt, { iterations })
  const nonce = randomBytes(NONCE_LENGTH)
  const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv: nonce }, wrappingKey, masterSecretBytes)
  return {
    version: CRYPTO_VERSION,
    kdf: 'PBKDF2-SHA-256',
    iterations,
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
  }
}

/** Kurtarma zarfını açar ve ana sır baytlarını döndürür. */
export async function openMasterSecretFromRecovery(envelope, code) {
  if (!envelope?.ciphertext || !envelope?.nonce || !envelope?.salt) {
    throw cryptoError('recovery_envelope_invalid')
  }
  let salt
  try {
    salt = base64ToBytes(envelope.salt)
  } catch {
    throw cryptoError('recovery_envelope_invalid')
  }
  const wrappingKey = await deriveRecoveryWrappingKey(code, salt, {
    iterations: envelope.iterations || PBKDF2_ITERATIONS,
  })
  try {
    const plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(envelope.nonce) },
      wrappingKey,
      base64ToBytes(envelope.ciphertext),
    )
    return new Uint8Array(plaintext)
  } catch {
    throw cryptoError('recovery_code_invalid')
  }
}

// --------------------------------------------------------------- şifreleme

/**
 * AAD: şifreli metni sahibine ve belgesine bağlar. Kopyalanan bir yük başka
 * belgede çözülemez.
 */
export function buildAad({ ownerUid, opaqueEntityId, entityType, schemaVersion = CLOUD_SCHEMA_VERSION }) {
  return encoder.encode([ownerUid, opaqueEntityId, entityType, `v${schemaVersion}`].join('|'))
}

/** JSON yükünü AES-256-GCM ile şifreler (taze 96-bit nonce). */
export async function encryptJson(dataKey, payload, aad) {
  const nonce = randomBytes(NONCE_LENGTH)
  const plaintext = encoder.encode(JSON.stringify(payload))
  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv: nonce, ...(aad ? { additionalData: aad } : {}) },
    dataKey,
    plaintext,
  )
  return { nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(ciphertext) }
}

/** Şifreli yükü çözer; AAD uyuşmazlığı `decrypt_failed` üretir. */
export async function decryptJson(dataKey, envelope, aad) {
  if (!envelope?.ciphertext || !envelope?.nonce) throw cryptoError('decrypt_failed')
  try {
    const plaintext = await subtle().decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(envelope.nonce),
        ...(aad ? { additionalData: aad } : {}),
      },
      dataKey,
      base64ToBytes(envelope.ciphertext),
    )
    return JSON.parse(decoder.decode(plaintext))
  } catch {
    throw cryptoError('decrypt_failed')
  }
}

/** Ham bayt yükünü şifreler (ek dosya parçaları). */
export async function encryptBytes(key, bytes, aad) {
  const nonce = randomBytes(NONCE_LENGTH)
  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv: nonce, ...(aad ? { additionalData: aad } : {}) },
    key,
    bytes,
  )
  return { nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(ciphertext) }
}

/** Şifreli bayt yükünü çözer. */
export async function decryptBytes(key, envelope, aad) {
  if (!envelope?.ciphertext || !envelope?.nonce) throw cryptoError('decrypt_failed')
  try {
    const plaintext = await subtle().decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(envelope.nonce),
        ...(aad ? { additionalData: aad } : {}),
      },
      key,
      base64ToBytes(envelope.ciphertext),
    )
    return new Uint8Array(plaintext)
  } catch {
    throw cryptoError('decrypt_failed')
  }
}

/**
 * API anahtarının cihazlar arası yinelenme parmak izi. Aynı ham anahtar aynı
 * izi verir; sunucu ham değeri hiç görmez.
 */
export async function computeKeyFingerprint(fingerprintKey, rawApiKey) {
  const signature = await subtle().sign('HMAC', fingerprintKey, encoder.encode(String(rawApiKey)))
  return toHex(signature)
}

/** Şifreleme katmanının özeti (teşhis ve testler için). */
export function describeCryptoLayer() {
  return {
    cryptoVersion: CRYPTO_VERSION,
    cipher: 'AES-256-GCM',
    nonceBits: NONCE_LENGTH * 8,
    kdf: 'PBKDF2-SHA-256',
    iterations: PBKDF2_ITERATIONS,
    recoveryCodeBits: RECOVERY_CODE_LENGTH * 5,
    subkeys: Object.keys(SUBKEY_ALGORITHMS),
  }
}
