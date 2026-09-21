import { describe, expect, it } from 'vitest'

import {
  HKDF_INFO,
  PBKDF2_ITERATIONS,
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_LENGTH,
  SUBKEY_ALGORITHMS,
  base64ToBytes,
  buildAad,
  bytesToBase64,
  computeKeyFingerprint,
  decryptBytes,
  decryptJson,
  deriveSubkey,
  deriveSubkeys,
  describeCryptoLayer,
  encryptBytes,
  encryptJson,
  generateDeviceKey,
  generateMasterSecretBytes,
  generateRecoveryCode,
  importMasterSecret,
  isValidRecoveryCode,
  normalizeRecoveryCode,
  openMasterSecretFromRecovery,
  randomBytes,
  sealMasterSecretForRecovery,
  unwrapMasterSecretFromDevice,
  wrapMasterSecretForDevice,
} from './syncCrypto'
import { deriveOpaqueId } from './syncModel'

/** Testte PBKDF2 tur sayisi dusurulur; uretim varsayilani 600.000'dir. */
const TEST_ITERATIONS = 1000

async function hazirla() {
  const masterBytes = generateMasterSecretBytes()
  const masterKey = await importMasterSecret(masterBytes)
  const keys = await deriveSubkeys(masterKey)
  return { masterBytes, masterKey, keys }
}

describe('syncCrypto yardimcilari', () => {
  it('base64 gidis-donus kayipsizdir', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42])
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes))
    expect(base64ToBytes('')).toEqual(new Uint8Array(0))
  })

  it('rastgele baytlar dogru uzunlukta ve farklidir', () => {
    const a = randomBytes(32)
    const b = randomBytes(32)
    expect(a.length).toBe(32)
    expect(bytesToBase64(a)).not.toBe(bytesToBase64(b))
  })

  it('AAD sahibine ve belgesine baglidir', () => {
    const aad = buildAad({ ownerUid: 'u1', opaqueEntityId: 'e1', entityType: 'session' })
    const ayni = buildAad({ ownerUid: 'u1', opaqueEntityId: 'e1', entityType: 'session' })
    const farkliBelge = buildAad({ ownerUid: 'u1', opaqueEntityId: 'e2', entityType: 'session' })
    expect(Array.from(aad)).toEqual(Array.from(ayni))
    expect(Array.from(aad)).not.toEqual(Array.from(farkliBelge))
    expect(new TextDecoder().decode(aad)).toContain('v1')
  })

  it('katman ozeti plan sabitlerini bildirir', () => {
    const ozet = describeCryptoLayer()
    expect(ozet.cipher).toBe('AES-256-GCM')
    expect(ozet.nonceBits).toBe(96)
    expect(ozet.kdf).toBe('PBKDF2-SHA-256')
    expect(ozet.iterations).toBe(PBKDF2_ITERATIONS)
    expect(ozet.iterations).toBe(600000)
    expect(ozet.recoveryCodeBits).toBe(160)
    expect(ozet.subkeys).toEqual(Object.keys(SUBKEY_ALGORITHMS))
  })
})

describe('syncCrypto anahtar hiyerarsisi', () => {
  it('cihaz anahtari disa aktarilamaz', async () => {
    const deviceKey = await generateDeviceKey()
    expect(deviceKey.extractable).toBe(false)
    expect(deviceKey.algorithm.name).toBe('AES-GCM')
    expect(deviceKey.algorithm.length).toBe(256)
    await expect(globalThis.crypto.subtle.exportKey('raw', deviceKey)).rejects.toBeTruthy()
  })

  it('ana sir 256-bit ve HKDF anahtaridir', async () => {
    const bytes = generateMasterSecretBytes()
    expect(bytes.length).toBe(32)
    const key = await importMasterSecret(bytes)
    expect(key.algorithm.name).toBe('HKDF')
    // Web Crypto HKDF anahtarlarini disa aktarilamaz kilar; sir ham bayt tasinir.
    expect(key.extractable).toBe(false)
    await expect(globalThis.crypto.subtle.exportKey('raw', key)).rejects.toBeTruthy()
  })

  it('bes gorev anahtari turetilir ve turleri dogrudur', async () => {
    const { keys } = await hazirla()
    expect(Object.keys(keys).sort()).toEqual([
      'backupKey', 'blobEncryptionKey', 'dataEncryptionKey', 'fingerprintKey', 'hmacIdKey',
    ])
    expect(keys.dataEncryptionKey.algorithm.name).toBe('AES-GCM')
    expect(keys.dataEncryptionKey.algorithm.length).toBe(256)
    expect(keys.blobEncryptionKey.algorithm.name).toBe('AES-GCM')
    expect(keys.backupKey.algorithm.name).toBe('AES-GCM')
    expect(keys.hmacIdKey.algorithm.name).toBe('HMAC')
    expect(keys.fingerprintKey.algorithm.name).toBe('HMAC')
    expect(keys.dataEncryptionKey.extractable).toBe(false)
  })

  it('gorev anahtarlari birbirinden farkli info ile ayrilir', async () => {
    const { masterKey, keys } = await hazirla()
    const yeniden = await deriveSubkey(masterKey, 'dataEncryptionKey')
    // Ayni info -> ayni anahtar: sifreli yuk baska anahtarla acilamaz.
    const metin = { a: 1 }
    const zarf = await encryptJson(keys.dataEncryptionKey, metin)
    await expect(decryptJson(yeniden, zarf)).resolves.toEqual(metin)
    await expect(decryptJson(keys.blobEncryptionKey, zarf)).rejects.toThrow('decrypt_failed')
    await expect(decryptJson(keys.backupKey, zarf)).rejects.toThrow('decrypt_failed')
  })

  it('bilinmeyen gorev anahtari reddedilir', async () => {
    const { masterKey } = await hazirla()
    await expect(deriveSubkey(masterKey, 'olmayanAnahtar')).rejects.toThrow('subkey_unknown')
  })

  it('HKDF info metinleri plan ile aynidir', () => {
    expect(HKDF_INFO.dataEncryptionKey).toBe('heraai-data-encryption')
    expect(HKDF_INFO.blobEncryptionKey).toBe('heraai-blob-encryption')
    expect(HKDF_INFO.hmacIdKey).toBe('heraai-opaque-id-hmac')
    expect(HKDF_INFO.fingerprintKey).toBe('heraai-key-fingerprint')
    expect(HKDF_INFO.backupKey).toBe('heraai-offline-backup')
  })

  it('cihaz zarfi ana sirri sarar ve geri acar', async () => {
    const deviceKey = await generateDeviceKey()
    const { masterBytes } = await hazirla()
    const envelope = await wrapMasterSecretForDevice(deviceKey, masterBytes)
    expect(envelope.algorithm).toBe('AES-256-GCM')
    expect(envelope.wrapped).toBeTruthy()

    const acilan = await unwrapMasterSecretFromDevice(deviceKey, envelope)
    expect(Array.from(acilan)).toEqual(Array.from(masterBytes))
    // Acilan baytlar yeniden HKDF anahtarina cevrilebilir.
    const yeniden = await importMasterSecret(acilan)
    expect(yeniden.algorithm.name).toBe('HKDF')
  })

  it('baska cihazin anahtari zarfi acamaz', async () => {
    const deviceA = await generateDeviceKey()
    const deviceB = await generateDeviceKey()
    const { masterBytes } = await hazirla()
    const envelope = await wrapMasterSecretForDevice(deviceA, masterBytes)
    await expect(unwrapMasterSecretFromDevice(deviceB, envelope)).rejects.toThrow('device_envelope_invalid')
  })

  it('bozuk cihaz zarfini reddeder', async () => {
    const deviceKey = await generateDeviceKey()
    await expect(unwrapMasterSecretFromDevice(deviceKey, {})).rejects.toThrow('device_envelope_invalid')
    await expect(unwrapMasterSecretFromDevice(deviceKey, null)).rejects.toThrow('device_envelope_invalid')
  })
})

describe('syncCrypto kurtarma kodu', () => {
  it('160-bit okunabilir kod uretir', () => {
    const code = generateRecoveryCode()
    expect(code).toHaveLength(RECOVERY_CODE_LENGTH + 7) // 32 karakter + 7 ayrac
    expect(normalizeRecoveryCode(code)).toHaveLength(RECOVERY_CODE_LENGTH)
    expect(isValidRecoveryCode(code)).toBe(true)
    expect(code).not.toMatch(/[IO01]/)
  })

  it('kodlar benzersizdir', () => {
    const kodlar = new Set(Array.from({ length: 25 }, () => generateRecoveryCode()))
    expect(kodlar.size).toBe(25)
  })

  it('normalize buyuk harfe cevirir ve ayraclari atar', () => {
    expect(normalizeRecoveryCode(' abcd-efgh 2345 ')).toBe('ABCDEFGH2345')
    expect(normalizeRecoveryCode(null)).toBe('')
  })

  it('gecersiz kodlari reddeder', () => {
    expect(isValidRecoveryCode('kisa')).toBe(false)
    expect(isValidRecoveryCode('ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6789')).toBe(true)
    expect(isValidRecoveryCode('ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-678I')).toBe(false)
    expect(isValidRecoveryCode(undefined)).toBe(false)
    expect(RECOVERY_CODE_ALPHABET).not.toContain('O')
  })

  it('ana sirri kurtarma koduyla sarar ve geri acar', async () => {
    const masterBytes = generateMasterSecretBytes()
    const code = generateRecoveryCode()
    const envelope = await sealMasterSecretForRecovery(masterBytes, code, { iterations: TEST_ITERATIONS })
    expect(envelope.kdf).toBe('PBKDF2-SHA-256')
    expect(envelope.iterations).toBe(TEST_ITERATIONS)
    expect(envelope.salt).toBeTruthy()

    const acilan = await openMasterSecretFromRecovery(envelope, code)
    expect(Array.from(acilan)).toEqual(Array.from(masterBytes))
    // Kullanici bosluklu/kucuk harfli yazsa da acilir.
    const rahat = await openMasterSecretFromRecovery(envelope, code.toLowerCase().replace(/-/g, ' '))
    expect(Array.from(rahat)).toEqual(Array.from(masterBytes))
  })

  it('yanlis kurtarma kodu zarfi acmaz', async () => {
    const masterBytes = generateMasterSecretBytes()
    const envelope = await sealMasterSecretForRecovery(masterBytes, generateRecoveryCode(), { iterations: TEST_ITERATIONS })
    await expect(openMasterSecretFromRecovery(envelope, generateRecoveryCode())).rejects.toThrow('recovery_code_invalid')
  })

  it('eksik zarf veya kisa kod reddedilir', async () => {
    const masterBytes = generateMasterSecretBytes()
    await expect(sealMasterSecretForRecovery(masterBytes, 'kisa')).rejects.toThrow('recovery_code_invalid')
    await expect(openMasterSecretFromRecovery({}, generateRecoveryCode())).rejects.toThrow('recovery_envelope_invalid')
    await expect(openMasterSecretFromRecovery(null, generateRecoveryCode())).rejects.toThrow('recovery_envelope_invalid')
  })
})

describe('syncCrypto veri sifreleme', () => {
  it('JSON yuku gidis-donus yapar', async () => {
    const { keys } = await hazirla()
    const yuk = { id: 'session_1', title: 'Sohbet', messages: [{ role: 'user', content: 'merhaba' }] }
    const zarf = await encryptJson(keys.dataEncryptionKey, yuk)
    expect(zarf.nonce).toBeTruthy()
    expect(zarf.ciphertext).toBeTruthy()
    expect(zarf.ciphertext).not.toContain('merhaba')
    await expect(decryptJson(keys.dataEncryptionKey, zarf)).resolves.toEqual(yuk)
  })

  it('her kayit icin taze nonce kullanilir', async () => {
    const { keys } = await hazirla()
    const yuk = { ayni: 'icerik' }
    const birinci = await encryptJson(keys.dataEncryptionKey, yuk)
    const ikinci = await encryptJson(keys.dataEncryptionKey, yuk)
    expect(birinci.nonce).not.toBe(ikinci.nonce)
    expect(birinci.ciphertext).not.toBe(ikinci.ciphertext)
  })

  it('AAD uyusmazligi sifre cozmeyi engeller', async () => {
    const { keys } = await hazirla()
    const aad = buildAad({ ownerUid: 'u1', opaqueEntityId: 'e1', entityType: 'session' })
    const zarf = await encryptJson(keys.dataEncryptionKey, { gizli: true }, aad)

    await expect(decryptJson(keys.dataEncryptionKey, zarf, aad)).resolves.toEqual({ gizli: true })
    // Baska belgeye kopyalanan yuk acilmaz.
    const baskaBelge = buildAad({ ownerUid: 'u1', opaqueEntityId: 'e2', entityType: 'session' })
    await expect(decryptJson(keys.dataEncryptionKey, zarf, baskaBelge)).rejects.toThrow('decrypt_failed')
    // Baska kullaniciya kopyalanan yuk acilmaz.
    const baskaUid = buildAad({ ownerUid: 'u2', opaqueEntityId: 'e1', entityType: 'session' })
    await expect(decryptJson(keys.dataEncryptionKey, zarf, baskaUid)).rejects.toThrow('decrypt_failed')
    // AAD'siz cozme de basarisizdir.
    await expect(decryptJson(keys.dataEncryptionKey, zarf)).rejects.toThrow('decrypt_failed')
  })

  it('bozuk sifreli metin hata verir', async () => {
    const { keys } = await hazirla()
    await expect(decryptJson(keys.dataEncryptionKey, { nonce: 'AA==', ciphertext: 'AA==' })).rejects.toThrow('decrypt_failed')
    await expect(decryptJson(keys.dataEncryptionKey, {})).rejects.toThrow('decrypt_failed')
  })

  it('ham bayt yuku sifrelenir ve acilir', async () => {
    const { keys } = await hazirla()
    const veri = randomBytes(256)
    const zarf = await encryptBytes(keys.blobEncryptionKey, veri)
    const acilan = await decryptBytes(keys.blobEncryptionKey, zarf)
    expect(Array.from(acilan)).toEqual(Array.from(veri))
    await expect(decryptBytes(keys.dataEncryptionKey, zarf)).rejects.toThrow('decrypt_failed')
  })

  it('API anahtari parmak izi deterministik ve tektir', async () => {
    const { keys } = await hazirla()
    const a = await computeKeyFingerprint(keys.fingerprintKey, 'AIza-ornek-anahtar-1234')
    const b = await computeKeyFingerprint(keys.fingerprintKey, 'AIza-ornek-anahtar-1234')
    const c = await computeKeyFingerprint(keys.fingerprintKey, 'AIza-ornek-anahtar-9999')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toContain('AIza')
  })

  it('hmacIdKey opak belge kimligi uretir', async () => {
    const { keys } = await hazirla()
    const opak = await deriveOpaqueId(keys.hmacIdKey, 'session', 'session_123')
    const ayni = await deriveOpaqueId(keys.hmacIdKey, 'session', 'session_123')
    expect(opak).toBe(ayni)
    expect(opak).toMatch(/^[0-9a-f]{64}$/)
  })
})
