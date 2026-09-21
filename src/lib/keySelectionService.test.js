/**
 * HeraAi 1.10.0 — Anahtar seçim servisi testleri (Aşama 13).
 *
 * Gerçek kasa (fake-indexeddb + gerçek Web Crypto) kullanılır.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { createKeySelectionService, describeKeySelectionService } from './keySelectionService'
import { createKeyVault, resetDefaultVault } from './keyVault'
import { DB_NAMES, VAULT_STORES, VAULT_VERSION, idbClear, openDatabase } from './idb'
import { KEY_HEALTH } from './keyHealth'
import { KEY_USAGE_MODE } from './keyRotation'

const SAGLAYICI = 'gemini'
const DIGER = 'tavily'

let db
let vault
let kasa
let mod
let servis

async function anahtarEkle(id, ham, ek = {}) {
  await vault.addKey(SAGLAYICI, ham, { id, ...ek })
}

beforeEach(async () => {
  resetDefaultVault()
  db = await openDatabase({
    name: DB_NAMES.vault,
    version: VAULT_VERSION,
    stores: Object.values(VAULT_STORES),
  })
  await idbClear(db, VAULT_STORES.keys)
  await idbClear(db, VAULT_STORES.meta)
  const { generateDeviceKey } = await import('./syncCrypto')
  vault = createKeyVault({ db, deviceKey: await generateDeviceKey() })
  kasa = vault
  mod = KEY_USAGE_MODE.PRIMARY
  servis = createKeySelectionService({
    vault,
    readUsageMode: async () => mod,
    writeUsageMode: async value => {
      mod = value
    },
    now: () => 1000,
  })
})

describe('servis sözleşmesi', () => {
  it('plandaki tüm metotları sunar', () => {
    const katalog = describeKeySelectionService()
    for (const ad of katalog.methods) {
      expect(typeof servis[ad]).toBe('function')
    }
    expect(katalog.poolIsolation).toBe(true)
    expect(katalog.midStreamSwitch).toBe(false)
  })

  it('kasasız kurulumu reddeder', () => {
    expect(() => createKeySelectionService({})).toThrow('key_service_vault_missing')
  })
})

describe('rezervasyon', () => {
  it('sağlayıcı yoksa hata verir', async () => {
    await expect(servis.resolveKeyForOperation({})).rejects.toThrow('key_provider_missing')
  })

  it('havuz boşsa no_keys bildirir', async () => {
    const sonuc = await servis.resolveKeyForOperation({ provider: SAGLAYICI })
    expect(sonuc.ok).toBe(false)
    expect(sonuc.reason).toBe('no_keys')
  })

  it('anahtar seçer ve ham anahtarı akış boyunca okur', async () => {
    await anahtarEkle('k1', 'AIza-birinci', { isPrimary: true })
    const sonuc = await servis.resolveKeyForOperation({ provider: SAGLAYICI, operationId: 'op1' })
    expect(sonuc.ok).toBe(true)
    expect(sonuc.keyId).toBe('k1')
    expect(sonuc.operationId).toBe('op1')
    expect(await sonuc.readKey()).toBe('AIza-birinci')
    // Aynı rezervasyon tekrar okunduğunda aynı anahtarı verir.
    expect(await sonuc.readKey()).toBe('AIza-birinci')
  })

  it('sağlayıcı havuzları karışmaz', async () => {
    await anahtarEkle('g1', 'AIza-gemini', { isPrimary: true })
    await vault.addKey(DIGER, 'tvly-tavily', { id: 't1', isPrimary: true })

    const gemini = await servis.resolveKeyForOperation({ provider: SAGLAYICI })
    const tavily = await servis.resolveKeyForOperation({ provider: DIGER })
    expect(await gemini.readKey()).toBe('AIza-gemini')
    expect(await tavily.readKey()).toBe('tvly-tavily')
  })

  it('primary modunda ana anahtarı seçer', async () => {
    await anahtarEkle('k1', 'AIza-birinci', { isPrimary: false })
    await anahtarEkle('k2', 'AIza-ikinci', { isPrimary: true })
    const sonuc = await servis.resolveKeyForOperation({ provider: SAGLAYICI })
    expect(sonuc.keyId).toBe('k2')
    expect(sonuc.isPrimary).toBe(true)
    expect(sonuc.mode).toBe(KEY_USAGE_MODE.PRIMARY)
  })

  it('rotasyon modunda en eski kullanılanı seçer', async () => {
    await anahtarEkle('k1', 'AIza-birinci', { isPrimary: true })
    await anahtarEkle('k2', 'AIza-ikinci')
    await vault.updateKeyMetadata(SAGLAYICI, 'k1', { lastUsedAt: 900 })
    await vault.updateKeyMetadata(SAGLAYICI, 'k2', { lastUsedAt: 100 })

    mod = KEY_USAGE_MODE.BALANCED_ROTATION
    const sonuc = await servis.resolveKeyForOperation({ provider: SAGLAYICI })
    expect(sonuc.keyId).toBe('k2')
  })

  it('yedek sırasını bildirir', async () => {
    await anahtarEkle('k1', 'AIza-birinci', { isPrimary: true })
    await anahtarEkle('k2', 'AIza-ikinci')
    await anahtarEkle('k3', 'AIza-ucuncu')
    const sonuc = await servis.resolveKeyForOperation({ provider: SAGLAYICI })
    expect(sonuc.fallbackIds).toEqual(['k2', 'k3'])
  })

  it('hariç tutulan anahtarı seçmez', async () => {
    await anahtarEkle('k1', 'AIza-birinci', { isPrimary: true })
    await anahtarEkle('k2', 'AIza-ikinci')
    const sonuc = await servis.resolveKeyForOperation({
      provider: SAGLAYICI,
      excludeIds: ['k1'],
    })
    expect(sonuc.keyId).toBe('k2')
  })

  it('duraklatılmış anahtarı atlar', async () => {
    await anahtarEkle('k1', 'AIza-birinci', { isPrimary: true })
    await anahtarEkle('k2', 'AIza-ikinci')
    await vault.updateKeyMetadata(SAGLAYICI, 'k1', { status: KEY_HEALTH.PAUSED })
    const sonuc = await servis.resolveKeyForOperation({ provider: SAGLAYICI })
    expect(sonuc.keyId).toBe('k2')
  })

  it('beklemedeki anahtarı atlar', async () => {
    await anahtarEkle('k1', 'AIza-birinci', { isPrimary: true })
    await anahtarEkle('k2', 'AIza-ikinci')
    await vault.updateKeyMetadata(SAGLAYICI, 'k1', { status: KEY_HEALTH.COOLDOWN, cooldownUntil: 5000 })
    const sonuc = await servis.resolveKeyForOperation({ provider: SAGLAYICI })
    expect(sonuc.keyId).toBe('k2')
  })

  it('tüm anahtarlar beklemedeyse erken bitiş zamanını bildirir', async () => {
    await anahtarEkle('k1', 'AIza-birinci')
    await anahtarEkle('k2', 'AIza-ikinci')
    await vault.updateKeyMetadata(SAGLAYICI, 'k1', { status: KEY_HEALTH.COOLDOWN, cooldownUntil: 5000 })
    await vault.updateKeyMetadata(SAGLAYICI, 'k2', { status: KEY_HEALTH.COOLDOWN, cooldownUntil: 9000 })

    const sonuc = await servis.resolveKeyForOperation({ provider: SAGLAYICI })
    expect(sonuc.ok).toBe(false)
    expect(sonuc.reason).toBe('all_unavailable')
    expect(sonuc.allInCooldown).toBe(true)
    expect(sonuc.earliestCooldownEnd).toBe(5000)
  })

  it('geçersiz anahtarı hiç seçmez', async () => {
    await anahtarEkle('k1', 'AIza-birinci', { isPrimary: true })
    await vault.updateKeyMetadata(SAGLAYICI, 'k1', { status: KEY_HEALTH.INVALID })
    const sonuc = await servis.resolveKeyForOperation({ provider: SAGLAYICI })
    expect(sonuc.ok).toBe(false)
    expect(sonuc.reason).toBe('all_unavailable')
    expect(sonuc.allInCooldown).toBe(false)
  })

  it('ham anahtarla birlikte rezerve eder', async () => {
    await anahtarEkle('k1', 'AIza-birinci', { isPrimary: true })
    const sonuc = await servis.reserveRawKey({ provider: SAGLAYICI })
    expect(sonuc.key).toBe('AIza-birinci')
  })

  it('rezerve edilemezse ham anahtar alanı olmaz', async () => {
    const sonuc = await servis.reserveRawKey({ provider: SAGLAYICI })
    expect(sonuc.ok).toBe(false)
    expect(sonuc.key).toBeUndefined()
  })
})

describe('sonuç kaydı', () => {
  it('başarı sayaçları sıfırlar', async () => {
    await anahtarEkle('k1', 'AIza-birinci', { isPrimary: true })
    await vault.updateKeyMetadata(SAGLAYICI, 'k1', { status: KEY_HEALTH.COOLDOWN, cooldownUntil: 9000, failCount: 2 })

    await servis.recordSuccess({ provider: SAGLAYICI, keyId: 'k1' })
    const [kayit] = await vault.listKeys(SAGLAYICI)
    expect(kayit.status).toBe(KEY_HEALTH.READY)
    expect(kayit.failCount).toBe(0)
    expect(kayit.cooldownUntil).toBeNull()
  })

  it('429 hatasında bekleme kurar', async () => {
    await anahtarEkle('k1', 'AIza-birinci')
    await servis.recordFailure({ provider: SAGLAYICI, keyId: 'k1', status: 429 })
    const [kayit] = await vault.listKeys(SAGLAYICI)
    expect(kayit.status).toBe(KEY_HEALTH.COOLDOWN)
    expect(kayit.failCount).toBe(1)
    expect(kayit.cooldownUntil).toBe(1000 + 60_000)
  })

  it('401 anahtarı geçersiz yapar', async () => {
    await anahtarEkle('k1', 'AIza-birinci')
    await servis.recordFailure({ provider: SAGLAYICI, keyId: 'k1', status: 401 })
    const [kayit] = await vault.listKeys(SAGLAYICI)
    expect(kayit.status).toBe(KEY_HEALTH.INVALID)
  })

  it('ağ hatası sayacı artırmaz', async () => {
    await anahtarEkle('k1', 'AIza-birinci')
    await servis.recordFailure({ provider: SAGLAYICI, keyId: 'k1', errorType: 'network_error' })
    const [kayit] = await vault.listKeys(SAGLAYICI)
    expect(kayit.failCount).toBe(0)
    expect(kayit.status).toBe(KEY_HEALTH.TRANSIENT_ERROR)
  })

  it('retryAfterMs bekleme süresini belirler', async () => {
    await anahtarEkle('k1', 'AIza-birinci')
    await servis.recordFailure({ provider: SAGLAYICI, keyId: 'k1', status: 429, retryAfterMs: 120_000 })
    const [kayit] = await vault.listKeys(SAGLAYICI)
    expect(kayit.cooldownUntil).toBe(1000 + 120_000)
  })

  it('eksik parametrede hata verir', async () => {
    await expect(servis.recordSuccess({})).rejects.toThrow('key_record_missing')
    await expect(servis.recordFailure({ provider: SAGLAYICI })).rejects.toThrow('key_record_missing')
  })
})

describe('duraklatma ve strateji', () => {
  it('duraklatıp devam ettirir', async () => {
    await anahtarEkle('k1', 'AIza-birinci')
    await servis.pauseKey(SAGLAYICI, 'k1')
    let [kayit] = await vault.listKeys(SAGLAYICI)
    expect(kayit.status).toBe(KEY_HEALTH.PAUSED)

    await servis.resumeKey(SAGLAYICI, 'k1')
    ;[kayit] = await vault.listKeys(SAGLAYICI)
    expect(kayit.status).toBe(KEY_HEALTH.UNTESTED)
    expect(kayit.failCount).toBe(0)
  })

  it('global stratejiyi yazar ve okur', async () => {
    expect(await servis.getStrategy()).toBe(KEY_USAGE_MODE.PRIMARY)
    const yazilan = await servis.setGlobalStrategy('balanced_rotation')
    expect(yazilan).toBe(KEY_USAGE_MODE.BALANCED_ROTATION)
    expect(mod).toBe(KEY_USAGE_MODE.BALANCED_ROTATION)
    expect(await servis.getStrategy()).toBe(KEY_USAGE_MODE.BALANCED_ROTATION)
  })

  it('geçersiz stratejiyi primary olarak normalize eder', async () => {
    const yazilan = await servis.setGlobalStrategy('rastgele')
    expect(yazilan).toBe(KEY_USAGE_MODE.PRIMARY)
  })

  it('mod okunamazsa güvenli varsayılana düşer', async () => {
    const hatali = createKeySelectionService({
      vault,
      readUsageMode: async () => {
        throw new Error('okuma_hatasi')
      },
    })
    expect(await hatali.getStrategy()).toBe(KEY_USAGE_MODE.PRIMARY)
  })
})

describe('özet ve önizleme', () => {
  it('havuz özetini üretir', async () => {
    await anahtarEkle('k1', 'AIza-birinci')
    await anahtarEkle('k2', 'AIza-ikinci')
    await vault.updateKeyMetadata(SAGLAYICI, 'k2', { status: KEY_HEALTH.INVALID })
    const ozet = await servis.summarize(SAGLAYICI)
    expect(ozet.total).toBe(2)
    expect(ozet.invalid).toBe(1)
    expect(ozet.usable).toBe(1)
  })

  it('rotasyon sırasını önizler', async () => {
    await anahtarEkle('k1', 'AIza-birinci', { isPrimary: true })
    await anahtarEkle('k2', 'AIza-ikinci')
    const onizleme = await servis.previewOrder(SAGLAYICI)
    expect(onizleme.map(k => k.id)).toEqual(['k1', 'k2'])
    expect(onizleme[0].status).toBe(KEY_HEALTH.READY)
  })

  it('önizleme ham anahtar sızdırmaz', async () => {
    await anahtarEkle('k1', 'AIza-birinci')
    const onizleme = await servis.previewOrder(SAGLAYICI)
    expect(JSON.stringify(onizleme)).not.toContain('AIza-birinci')
  })
})

describe('kasa bütünlüğü', () => {
  it('kasa ham anahtarı yalnız istek anında çözer', async () => {
    await anahtarEkle('k1', 'AIza-birinci')
    const liste = await kasa.listKeys(SAGLAYICI)
    expect(JSON.stringify(liste)).not.toContain('AIza-birinci')
    expect(await kasa.getRawKey(SAGLAYICI, 'k1')).toBe('AIza-birinci')
  })
})
