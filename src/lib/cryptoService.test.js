/**
 * HeraAi 1.10.0 — Kripto servisi testleri (Aşama 13).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { assertCryptoService, createCryptoService, describeCryptoService } from './cryptoService'
import { RECOVERY_CODE_LENGTH } from './syncCrypto'

let servis

beforeEach(() => {
  servis = createCryptoService()
})

describe('servis sözleşmesi', () => {
  it('plandaki tüm metotları sunar', () => {
    expect(() => assertCryptoService(servis)).not.toThrow()
    const katalog = describeCryptoService()
    expect(katalog.methods).toContain('createDeviceKey')
    expect(katalog.methods).toContain('deriveSubKeys')
    expect(katalog.methods).toContain('createRecoveryEnvelope')
    expect(katalog.methods).toContain('deriveSecretFingerprint')
    expect(katalog.keyHierarchy).toContain('masterSecret')
  })

  it('eksik metotta açık hata verir', () => {
    expect(() => assertCryptoService({})).toThrow('crypto_service_missing_createDeviceKey')
    expect(() => assertCryptoService(null)).toThrow('crypto_service_missing')
  })
})

describe('cihaz anahtarı ve ana sır', () => {
  it('cihaz anahtarı üretir', async () => {
    const anahtar = await servis.createDeviceKey()
    expect(anahtar.type).toBe('secret')
    expect(anahtar.algorithm.name).toBe('AES-GCM')
    expect(anahtar.extractable).toBe(false)
  })

  it('ana sır üretir ve alt anahtarları türetir', async () => {
    const sır = await servis.createCloudMasterSecret()
    expect(sır.bytes.length).toBe(32)
    const alt = await servis.deriveSubKeys(sır.key)
    expect(alt.dataEncryptionKey.algorithm.name).toBe('AES-GCM')
    expect(alt.blobEncryptionKey.algorithm.name).toBe('AES-GCM')
    expect(alt.hmacIdKey.algorithm.name).toBe('HMAC')
    expect(alt.fingerprintKey.algorithm.name).toBe('HMAC')
    expect(alt.backupKey.algorithm.name).toBe('AES-GCM')
  })

  it('aynı ana sırdan aynı alt anahtarlar türetilir', async () => {
    const sır = await servis.createCloudMasterSecret()
    const a = await servis.deriveSubKeys(sır.key)
    const b = await servis.deriveSubKeys(sır.key)
    // Anahtarlar aynı: aynı düz metni şifreleyip çapraz çözebilmeliyiz.
    const aad = new TextEncoder().encode('aad')
    const zarf = await servis.encryptEntity(a.dataEncryptionKey, { x: 1 }, aad)
    const cozulen = await servis.decryptEntity(b.dataEncryptionKey, zarf, aad)
    expect(cozulen.x).toBe(1)
  })
})

describe('kurtarma akışı', () => {
  it('kod üretir ve doğrular', () => {
    const kod = servis.createRecoveryCode()
    // Gösterim gruplu (`XXXX-XXXX-...`); uzunluk ayraçsız ölçülür.
    expect(kod).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){7}$/)
    expect(kod.replace(/[^A-Z0-9]/g, '')).toHaveLength(RECOVERY_CODE_LENGTH)
    expect(servis.isValidRecoveryCode(kod)).toBe(true)
    expect(servis.isValidRecoveryCode('kisa')).toBe(false)
  })

  it('kodla zarf kurup geri açar', async () => {
    const sır = await servis.createCloudMasterSecret()
    const kod = servis.createRecoveryCode()
    const zarf = await servis.createRecoveryEnvelope(sır.bytes, kod)

    const acilan = await servis.unlockWithRecoveryCode(zarf, kod)
    expect(acilan.bytes).toEqual(sır.bytes)
    expect(acilan.key.algorithm.name).toBe('HKDF')
  })

  it('yanlış kodla açmaz', async () => {
    const sır = await servis.createCloudMasterSecret()
    const zarf = await servis.createRecoveryEnvelope(sır.bytes, servis.createRecoveryCode())
    const yanlis = servis.createRecoveryCode()
    await expect(servis.unlockWithRecoveryCode(zarf, yanlis)).rejects.toThrow()
  })

  it('kodu normalize eder', () => {
    const kod = servis.createRecoveryCode()
    const duz = kod.replace(/[^A-Z0-9]/g, '')
    // `normalizeRecoveryCode` tireleri ve küçük harfi temizler, gruplama yapmaz.
    expect(servis.normalizeRecoveryCode(kod.toLowerCase())).toBe(duz)
    expect(servis.normalizeRecoveryCode(kod)).toBe(duz)
    expect(servis.isValidRecoveryCode(duz)).toBe(true)
  })
})

describe('cihaz sarması', () => {
  it('ana sırrı cihaz anahtarıyla sarıp geri açar', async () => {
    const cihaz = await servis.createDeviceKey()
    const sır = await servis.createCloudMasterSecret()
    const zarf = await servis.wrapMasterSecretForDevice(cihaz, sır.bytes)
    expect(typeof zarf).toBe('object')

    const acilan = await servis.unwrapMasterSecretWithDevice(cihaz, zarf)
    expect(acilan.bytes).toEqual(sır.bytes)
  })

  it('başka cihaz anahtarı kasayı açamaz', async () => {
    const cihaz = await servis.createDeviceKey()
    const yabanci = await servis.createDeviceKey()
    const sır = await servis.createCloudMasterSecret()
    const zarf = await servis.wrapMasterSecretForDevice(cihaz, sır.bytes)
    await expect(servis.unwrapMasterSecretWithDevice(yabanci, zarf)).rejects.toThrow()
  })
})

describe('varlık şifreleme', () => {
  it('şifreleyip geri çözer', async () => {
    const sır = await servis.createCloudMasterSecret()
    const { dataEncryptionKey } = await servis.deriveSubKeys(sır.key)
    const aad = new TextEncoder().encode('owner|entity|session|v1')
    const zarf = await servis.encryptEntity(dataEncryptionKey, { baslik: 'gizli' }, aad)
    expect(zarf.nonce).toBeTruthy()
    expect(zarf.ciphertext).toBeTruthy()
    const cozulen = await servis.decryptEntity(dataEncryptionKey, zarf, aad)
    expect(cozulen.baslik).toBe('gizli')
  })

  it('AAD uyuşmazlığında reddeder', async () => {
    const sır = await servis.createCloudMasterSecret()
    const { dataEncryptionKey } = await servis.deriveSubKeys(sır.key)
    const zarf = await servis.encryptEntity(
      dataEncryptionKey,
      { x: 1 },
      new TextEncoder().encode('aad-1'),
    )
    await expect(
      servis.decryptEntity(dataEncryptionKey, zarf, new TextEncoder().encode('aad-2')),
    ).rejects.toThrow()
  })

  it('ham bayt şifreleme turu çalışır', async () => {
    const sır = await servis.createCloudMasterSecret()
    const { blobEncryptionKey } = await servis.deriveSubKeys(sır.key)
    const ham = new Uint8Array([1, 2, 3, 4, 5])
    const zarf = await servis.encryptBytes(blobEncryptionKey, ham, null)
    const cozulen = await servis.decryptBytes(blobEncryptionKey, zarf, null)
    expect([...cozulen]).toEqual([1, 2, 3, 4, 5])
  })
})

describe('kimlik ve parmak izi', () => {
  it('opak kimlik deterministik ve tipe bağlıdır', async () => {
    const sır = await servis.createCloudMasterSecret()
    const { hmacIdKey } = await servis.deriveSubKeys(sır.key)
    const a = await servis.deriveOpaqueId(hmacIdKey, 'session', 'abc')
    const b = await servis.deriveOpaqueId(hmacIdKey, 'session', 'abc')
    const c = await servis.deriveOpaqueId(hmacIdKey, 'setting', 'abc')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('ek kimliği ayrı ad alanında üretilir', async () => {
    const sır = await servis.createCloudMasterSecret()
    const { hmacIdKey } = await servis.deriveSubKeys(sır.key)
    const varlik = await servis.deriveOpaqueId(hmacIdKey, 'session', 'ek-1')
    const ek = await servis.deriveOpaqueAttachmentId(hmacIdKey, 'ek-1')
    expect(ek).not.toBe(varlik)
  })

  it('gizli parmak izi ham anahtarı sızdırmaz', async () => {
    const sır = await servis.createCloudMasterSecret()
    const { fingerprintKey } = await servis.deriveSubKeys(sır.key)
    const iz = await servis.deriveSecretFingerprint(fingerprintKey, 'AIza-gizli')
    expect(iz).toHaveLength(64)
    expect(iz).not.toContain('AIza')
  })
})

describe('hata tanıma', () => {
  it('bilinen kripto hatalarını tanır', () => {
    const hata = new Error('decrypt_failed')
    hata.code = 'decrypt_failed'
    expect(servis.isKnownError(hata)).toBe(true)
    expect(servis.isKnownError(new Error('baska'))).toBe(false)
    expect(servis.isKnownError(null)).toBe(false)
  })
})
