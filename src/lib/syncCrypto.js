const FORMAT_VERSION = 1
const SALT_LENGTH = 16
const IV_LENGTH = 12
const PBKDF2_ITERATIONS = 250000

function requireCrypto() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error('secure_crypto_unavailable')
  }
  return globalThis.crypto
}

async function deriveKey(passphrase, salt) {
  const cryptoApi = requireCrypto()
  const material = await cryptoApi.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(passphrase || '')),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return cryptoApi.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptBytes(bytes, passphrase) {
  if (!String(passphrase || '').trim()) throw new Error('sync_passphrase_required')
  const cryptoApi = requireCrypto()
  const salt = cryptoApi.getRandomValues(new Uint8Array(SALT_LENGTH))
  const iv = cryptoApi.getRandomValues(new Uint8Array(IV_LENGTH))
  const key = await deriveKey(passphrase, salt)
  const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const encrypted = new Uint8Array(await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload))
  const result = new Uint8Array(1 + SALT_LENGTH + IV_LENGTH + encrypted.length)
  result[0] = FORMAT_VERSION
  result.set(salt, 1)
  result.set(iv, 1 + SALT_LENGTH)
  result.set(encrypted, 1 + SALT_LENGTH + IV_LENGTH)
  return result
}

export async function decryptBytes(bytes, passphrase) {
  if (!String(passphrase || '').trim()) throw new Error('sync_passphrase_required')
  const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (payload.length <= 1 + SALT_LENGTH + IV_LENGTH || payload[0] !== FORMAT_VERSION) {
    throw new Error('sync_data_invalid')
  }
  const salt = payload.slice(1, 1 + SALT_LENGTH)
  const iv = payload.slice(1 + SALT_LENGTH, 1 + SALT_LENGTH + IV_LENGTH)
  const encrypted = payload.slice(1 + SALT_LENGTH + IV_LENGTH)
  try {
    const key = await deriveKey(passphrase, salt)
    return new Uint8Array(await requireCrypto().subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted))
  } catch {
    throw new Error('sync_passphrase_invalid')
  }
}

export async function encryptJson(value, passphrase) {
  return encryptBytes(new TextEncoder().encode(JSON.stringify(value)), passphrase)
}

export async function decryptJson(bytes, passphrase) {
  const decrypted = await decryptBytes(bytes, passphrase)
  try {
    return JSON.parse(new TextDecoder().decode(decrypted))
  } catch {
    throw new Error('sync_data_invalid')
  }
}
