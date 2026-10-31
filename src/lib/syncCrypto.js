/**
 * HeraAi 1.10.0 - client-side encryption and key management (Stage 4).
 *
 * Key hierarchy (plan section 8):
 *
 * Recovery code (160-bit) --PBKDF2-SHA-256(600k, 128-bit salt)--> recovery
 * wrapping key --AES-256-GCM--> recoveryEnvelope
 *
 * Cloud master secret (256-bit, HKDF) --HKDF-SHA-256(info)--> task keys
 * |- dataEncryptionKey  (AES-GCM) settings/chat/message
 * |- hmacIdKey          (HMAC)    opaque document id
 * |- fingerprintKey     (HMAC)    duplicate API key fingerprint
 * `- backupKey          (AES-GCM) offline backup file
 *
 * The cloud master secret is also wrapped with each device's local key
 * (`deviceMasterKeyEnvelope`); the device key is generated with `extractable: false`
 * and never leaves the device.
 *
 * Every ciphertext is AES-256-GCM with a fresh 96-bit nonce per record, and the
 * payload is bound to the AAD `ownerUid|opaqueEntityId|entityType|vN` - if the
 * ciphertext is copied into another document decryption fails at once.
 *
 * The recovery code and the master secret are never sent to the server in the clear.
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

/** Easily confused letters (I/O/0/1) are not in the alphabet; 32 characters = 5 bits. */
export const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** HKDF `info` parameters - versioned constant strings. */
export const HKDF_INFO = Object.freeze({
  dataEncryptionKey: 'heraai-data-encryption',
  hmacIdKey: 'heraai-opaque-id-hmac',
  fingerprintKey: 'heraai-key-fingerprint',
  backupKey: 'heraai-offline-backup',
})

const HKDF_SALT = 'heraai-sync-v1'

/** Web Crypto algorithm definitions of the task keys. */
export const SUBKEY_ALGORITHMS = Object.freeze({
  dataEncryptionKey: { name: 'AES-GCM', length: 256 },
  hmacIdKey: { name: 'HMAC', hash: 'SHA-256' },
  fingerprintKey: { name: 'HMAC', hash: 'SHA-256' },
  backupKey: { name: 'AES-GCM', length: 256 },
})

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

/** Uint8Array or ArrayBuffer -> base64 (portable text in Firestore). */
export function bytesToBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  // Joining strings one by one produced an O(n^2) memory copy on large backups;
  // a
  // fromCharCode call over 32 KB slices gives the same output ~4x faster.
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

// ---------------------------------------------------------------- device key

/**
 * Device local key: 256-bit AES-GCM, `extractable: false`.
 * Used to wrap/unwrap the master secret and to encrypt the local API vault; it cannot
 * be exported and never goes to the cloud.
 */
export async function generateDeviceKey() {
  return subtle().generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
  )
}

// ---------------------------------------------------------- cloud master
// secret

/** 256-bit random master secret bytes generated during first setup. */
export function generateMasterSecretBytes() {
  return randomBytes(MASTER_SECRET_LENGTH)
}

/**
 * Imports the bytes as an HKDF key. Derivation only: Web Crypto forbids HKDF keys
 * from being extractable (`SyntaxError`), so the master secret itself is carried as
 * raw bytes when needed.
 */
export async function importMasterSecret(rawBytes) {
  return subtle().importKey('raw', rawBytes, 'HKDF', false, ['deriveKey', 'deriveBits'])
}

/** Wraps with the device key; output is `devices/{deviceId}.deviceMasterKeyEnvelope`. */
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

/** Unwraps the device envelope and returns the master secret bytes. */
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

// ------------------------------------------------------------- task keys

/** Derives a single task key with HKDF. */
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

/** Derives all task keys in one call. */
export async function deriveSubkeys(masterSecretKey) {
  const names = Object.keys(SUBKEY_ALGORITHMS)
  const keys = await Promise.all(names.map(name => deriveSubkey(masterSecretKey, name)))
  return Object.fromEntries(names.map((name, index) => [name, keys[index]]))
}

// ------------------------------------------------------------------ kurtarma

/** Okunabilir 160-bit kurtarma kodu (`XXXX-XXXX-...`). */
export function generateRecoveryCode() {
  const bytes = randomBytes(RECOVERY_CODE_LENGTH)
  // Because the alphabet has 32 characters 256 % 32 === 0 - there is no
  // modulo bias.
  const chars = Array.from(bytes, byte => RECOVERY_CODE_ALPHABET[byte % RECOVERY_CODE_ALPHABET.length])
  const groups = []
  for (let i = 0; i < chars.length; i += RECOVERY_CODE_GROUP_SIZE) {
    groups.push(chars.slice(i, i + RECOVERY_CODE_GROUP_SIZE).join(''))
  }
  return groups.join('-')
}

/** Makes user input comparable (uppercase, no separators). */
export function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Closed key: only alphabet characters and sufficient length. */
export function isValidRecoveryCode(code) {
  const normalized = normalizeRecoveryCode(code)
  if (normalized.length < RECOVERY_CODE_MIN_LENGTH) return false
  return [...normalized].every(char => RECOVERY_CODE_ALPHABET.includes(char))
}

/** Derives the wrapping key from the recovery code with PBKDF2. */
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
 * Encrypts the master secret with the recovery code and produces
 * `account/root.recoveryEnvelope`.
 * `iterations` is lowered only in tests; the production default is 600,000.
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

/** Unwraps the recovery envelope and returns the master secret bytes. */
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

// ---------------------------------------------------------------
// encryption

/**
 * AAD: binds the ciphertext to its owner and document. A copied payload cannot be
 * decrypted in another document.
 */
export function buildAad({ ownerUid, opaqueEntityId, entityType, schemaVersion = CLOUD_SCHEMA_VERSION }) {
  return encoder.encode([ownerUid, opaqueEntityId, entityType, `v${schemaVersion}`].join('|'))
}

/** Encrypts a JSON payload with AES-256-GCM (fresh 96-bit nonce). */
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

/** Decrypts an encrypted payload; an AAD mismatch yields `decrypt_failed`. */
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

/** Encrypts a raw byte payload (attachment chunks). */
export async function encryptBytes(key, bytes, aad) {
  const nonce = randomBytes(NONCE_LENGTH)
  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv: nonce, ...(aad ? { additionalData: aad } : {}) },
    key,
    bytes,
  )
  return { nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(ciphertext) }
}

/** Decrypts an encrypted byte payload. */
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
 * Cross-device duplication fingerprint of an API key. The same raw key gives the same
 * fingerprint; the server never sees the raw value.
 */
export async function computeKeyFingerprint(fingerprintKey, rawApiKey) {
  const signature = await subtle().sign('HMAC', fingerprintKey, encoder.encode(String(rawApiKey)))
  return toHex(signature)
}

/** Summary of the encryption layer (for diagnostics and tests). */
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
