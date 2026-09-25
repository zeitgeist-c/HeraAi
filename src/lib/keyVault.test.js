import { describe, expect, it } from 'vitest'

import { VAULT_STORES, idbGetAll } from './idb'
import { openDatabase, idbPut } from './idb'
import { createKeyVault, loadOrCreateDeviceKey, maskKey } from './keyVault'
import { decryptJson, encryptJson, generateDeviceKey } from './syncCrypto'
import { KEY_HEALTH } from './keyHealth'

let sayac = 0

/** Her test kendi veritabanında çalışır; durum sızmaz. */
async function kasaKur() {
  const db = await openDatabase({
    name: `test-vault-${sayac++}`,
    version: 1,
    stores: Object.values(VAULT_STORES),
  })
  const deviceKey = await loadOrCreateDeviceKey(db)
  return { db, deviceKey, vault: createKeyVault({ db, deviceKey }) }
}

describe('keyVault maskeleme', () => {
  it('ilk 4 ve son 4 karakteri gosterir', () => {
    expect(maskKey('AIzaSyABCDEF1234567890xyz9')).toBe('AIza...xyz9')
    expect(maskKey('tvly-abcdefghij-AbC3')).toBe('tvly...AbC3')
    expect(maskKey('kisa')).toBe('***')
    expect(maskKey('')).toBe('***')
    expect(maskKey(null)).toBe('***')
  })
})

describe('keyVault sifreli saklama', () => {
  it('ham anahtar IndexedDB kaydinda acik metin durmaz', async () => {
    const { db, vault } = await kasaKur()
    const gizli = 'AIzaSyGIZLI-anahtar-1234567890'
    await vault.addKey('gemini', gizli)

    const kayitlar = await idbGetAll(db, VAULT_STORES.keys)
    expect(kayitlar).toHaveLength(1)

    const disaVuran = JSON.stringify(kayitlar)
    expect(disaVuran).not.toContain('AIzaSyGIZLI')
    expect(disaVuran).not.toContain(gizli)
    expect(kayitlar[0].ciphertext).toBeTruthy()
    expect(kayitlar[0].ciphertext.ciphertext).toBeTruthy()
    expect(kayitlar[0].masked).toBe('AIza...7890')
  })

  it('ham anahtar yalnizca istendiginde cozulur', async () => {
    const { vault } = await kasaKur()
    const gizli = 'AIza-istek-aninda-cozulur-1234'
    const id = await vault.addKey('gemini', gizli)

    expect(await vault.getRawKey('gemini', id)).toBe(gizli)
    expect(await vault.getRawKey('gemini', 'olmayan-id')).toBeNull()
  })

  it('liste cikitisi ham anahtar alani tasimaz', async () => {
    const { vault } = await kasaKur()
    await vault.addKey('gemini', 'AIza-liste-testi-1234567890')

    const [kayit] = await vault.listKeys('gemini')
    expect(kayit).not.toHaveProperty('key')
    expect(kayit).not.toHaveProperty('ciphertext')
    expect(kayit.masked).toBe('AIza...7890')
  })

  it('cihaz anahtari veritabaninda kalicidir', async () => {
    const db = await openDatabase({
      name: `test-vault-kalici-${sayac++}`,
      version: 1,
      stores: Object.values(VAULT_STORES),
    })
    const birinci = await loadOrCreateDeviceKey(db)
    const ikinci = await loadOrCreateDeviceKey(db)

    const imza = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: new Uint8Array(12) },
      ikinci,
      new TextEncoder().encode('ayni-anahtar'),
    )
    const acilan = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(12) },
      birinci,
      imza,
    )
    expect(new TextDecoder().decode(acilan)).toBe('ayni-anahtar')
  })

  it('baska cihaz anahtari kasayi acamaz', async () => {
    const { db, vault } = await kasaKur()
    const id = await vault.addKey('gemini', 'AIza-yabanci-cihaz-testi-123')

    const yabanci = createKeyVault({ db, deviceKey: await generateDeviceKey() })
    const liste = await yabanci.listKeys('gemini')
    expect(liste).toHaveLength(1) // metadata acik, icerik kapali

    await expect(yabanci.getRawKey('gemini', id)).rejects.toThrow('decrypt_failed')
    await expect(yabanci.resolveKeysForRequest('gemini')).rejects.toThrow('decrypt_failed')
  })
})

describe('keyVault ekleme ve mukerrer engelleme', () => {
  it('anahtar adini kirpar, sinirlar ve maskeli metadata ile dondurur', async () => {
    const { vault } = await kasaKur()
    await vault.addKey('gemini', 'AIza-isimli-anahtar-1234567890', {
      label: `  ${'A'.repeat(70)}  `,
    })

    const [kayit] = await vault.listKeys('gemini')
    expect(kayit.label).toBe('A'.repeat(60))
    expect(kayit.masked).toBe('AIza...7890')
  })

  it('bos anahtar reddedilir', async () => {
    const { vault } = await kasaKur()
    await expect(vault.addKey('gemini', '   ')).rejects.toThrow('key_empty_error')
    await expect(vault.addKey('gemini', null)).rejects.toThrow('key_empty_error')
  })

  it('ayni ham anahtar ikinci kez eklenmez', async () => {
    const { vault } = await kasaKur()
    await vault.addKey('gemini', 'AIza-ayni-anahtar-1234567890')
    await expect(vault.addKey('gemini', 'AIza-ayni-anahtar-1234567890')).rejects.toThrow('key_duplicate_error')
  })

  it('parmak izi eslesen anahtar mukerrer sayilir', async () => {
    const { vault } = await kasaKur()
    await vault.addKey('gemini', 'AIza-parmak-izli-1234567890', { fingerprint: 'fp-abc' })
    await expect(
      vault.addKey('gemini', 'AIza-baska-metin-ama-ayni-anahtar', { fingerprint: 'fp-abc' }),
    ).rejects.toThrow('key_duplicate_error')
  })

  it('bilinmeyen saglayici reddedilir', async () => {
    const { vault } = await kasaKur()
    await expect(vault.addKey('bilinmeyen', 'anahtar')).rejects.toThrow('Invalid provider')
    await expect(vault.listKeys('bilinmeyen')).rejects.toThrow('Invalid provider')
  })

  it('ilk anahtar ana anahtar olur', async () => {
    const { vault } = await kasaKur()
    await vault.addKey('gemini', 'AIza-birinci-anahtar-123456')
    await vault.addKey('gemini', 'AIza-ikinci-anahtar-1234567')

    const liste = await vault.listKeys('gemini')
    expect(liste[0].isPrimary).toBe(true)
    expect(liste[1].isPrimary).toBe(false)
  })
})

describe('keyVault saglayici havuzu izolasyonu', () => {
  it('havuzlar birbirine karismaz', async () => {
    const { vault } = await kasaKur()
    await vault.addKey('gemini', 'AIza-gemini-anahtari-123456')
    await vault.addKey('tavily', 'tvly-tavily-anahtari-1234')
    await vault.addKey('openrouter', 'sk-or-openrouter-12345678')
    await vault.addKey('ollama', 'ollama-anahtari-1234567890')

    expect((await vault.resolveKeysForRequest('gemini')).keys[0].key).toBe('AIza-gemini-anahtari-123456')
    expect((await vault.resolveKeysForRequest('tavily')).keys[0].key).toBe('tvly-tavily-anahtari-1234')
    expect((await vault.resolveKeysForRequest('openrouter')).keys[0].key).toBe('sk-or-openrouter-12345678')
    expect((await vault.resolveKeysForRequest('ollama')).keys[0].key).toBe('ollama-anahtari-1234567890')

    const sayim = await vault.countKeys()
    expect(sayim).toEqual({ gemini: 1, tavily: 1, openrouter: 1, ollama: 1 })
  })

  it('ayni saglayici icinde cooldown yalnizca kendi havuzunu etkiler', async () => {
    const { vault } = await kasaKur()
    await vault.addKey('gemini', 'AIza-gemini-beklemede-12345')
    await vault.addKey('tavily', 'tvly-tavily-hazir-12345678')
    const [geminiKayit] = await vault.listKeys('gemini')
    await vault.updateKeyMetadata('gemini', geminiKayit.id, { cooldownUntil: Date.now() + 60000 })

    const gemini = await vault.resolveKeysForRequest('gemini')
    expect(gemini.keys).toEqual([])
    expect(gemini.allInCooldown).toBe(true)

    const tavily = await vault.resolveKeysForRequest('tavily')
    expect(tavily.keys).toHaveLength(1)
    expect(tavily.allInCooldown).toBe(false)
  })
})

describe('keyVault siralama ve cooldown', () => {
  it('ana anahtar once, sonra createdAt artan gelir', async () => {
    const { vault } = await kasaKur()
    await vault.addKey('gemini', 'AIza-aaaaaaaaaaaaaaaaaa-A')
    await vault.addKey('gemini', 'AIza-bbbbbbbbbbbbbbbbbb-B')
    await vault.addKey('gemini', 'AIza-cccccccccccccccccc-C')

    const liste = await vault.listKeys('gemini')
    const cId = liste.find(k => k.masked.endsWith('-C'))?.id
      || liste.find(k => k.masked === 'AIza...-C')?.id
      || liste[2].id
    await vault.setPrimary('gemini', cId)

    const sirali = await vault.listKeys('gemini')
    expect(sirali[0].id).toBe(cId)
    expect(sirali[0].isPrimary).toBe(true)

    const istek = await vault.resolveKeysForRequest('gemini')
    expect(istek.keys[0].id).toBe(cId)
    expect(istek.keys).toHaveLength(3)
  })

  it('beklemedeki anahtar atlanir, kalanlar doner', async () => {
    const { vault } = await kasaKur()
    await vault.addKey('gemini', 'AIza-aaaaaaaaaaaaaaaaaa-A')
    await vault.addKey('gemini', 'AIza-bbbbbbbbbbbbbbbbbb-B')
    const liste = await vault.listKeys('gemini')
    await vault.updateKeyMetadata('gemini', liste[0].id, {
      cooldownUntil: Date.now() + 60000,
      lastErrorAt: Date.now(),
      lastErrorType: 'rate_limited',
    })

    const sonuc = await vault.resolveKeysForRequest('gemini')
    expect(sonuc.allInCooldown).toBe(false)
    expect(sonuc.keys).toHaveLength(1)
    expect(sonuc.keys[0].key).toBe('AIza-bbbbbbbbbbbbbbbbbb-B')
  })

  it('tum anahtarlar beklemedeyse en erken bitis bildirilir', async () => {
    const { vault } = await kasaKur()
    await vault.addKey('gemini', 'AIza-aaaaaaaaaaaaaaaaaa-A')
    await vault.addKey('gemini', 'AIza-bbbbbbbbbbbbbbbbbb-B')
    const liste = await vault.listKeys('gemini')
    const erken = Date.now() + 30000
    const gec = Date.now() + 120000
    await vault.updateKeyMetadata('gemini', liste[0].id, { cooldownUntil: gec })
    await vault.updateKeyMetadata('gemini', liste[1].id, { cooldownUntil: erken })

    const sonuc = await vault.resolveKeysForRequest('gemini')
    expect(sonuc.keys).toEqual([])
    expect(sonuc.allInCooldown).toBe(true)
    expect(sonuc.earliestCooldownEnd).toBe(erken)
  })

  it('bos havuz beklemede sayilmaz', async () => {
    const { vault } = await kasaKur()
    const sonuc = await vault.resolveKeysForRequest('gemini')
    expect(sonuc).toEqual({ keys: [], allInCooldown: false, earliestCooldownEnd: null })
  })
})

describe('keyVault kayit yonetimi', () => {
  it('metadata yalnizca izinli alanlarla guncellenir', async () => {
    const { vault } = await kasaKur()
    const id = await vault.addKey('gemini', 'AIza-metadata-testi-1234567')

    await vault.updateKeyMetadata('gemini', id, {
      lastUsedAt: 111,
      failCount: 3,
      isPrimary: false, // izinli alan degil: yok sayilir
      id: 'sahte-id',
    })

    const [kayit] = await vault.listKeys('gemini')
    expect(kayit.lastUsedAt).toBe(111)
    expect(kayit.failCount).toBe(3)
    expect(kayit.isPrimary).toBe(true)
    expect(kayit.id).toBe(id)
  })

  it('ana anahtar silinince yerine sirali ilk anahtar geçer', async () => {
    const { vault } = await kasaKur()
    const ilk = await vault.addKey('gemini', 'AIza-aaaaaaaaaaaaaaaaaa-A')
    const ikinci = await vault.addKey('gemini', 'AIza-bbbbbbbbbbbbbbbbbb-B')

    expect(await vault.removeKey('gemini', ilk)).toBe(true)
    const liste = await vault.listKeys('gemini')
    expect(liste).toHaveLength(1)
    expect(liste[0].id).toBe(ikinci)
    expect(liste[0].isPrimary).toBe(true)
  })

  it('olmayan kayit silinemez veya ana yapilamaz', async () => {
    const { vault } = await kasaKur()
    expect(await vault.removeKey('gemini', 'yok')).toBe(false)
    expect(await vault.setPrimary('gemini', 'yok')).toBe(false)
    expect(await vault.updateKeyMetadata('gemini', 'yok', { failCount: 1 })).toBe(false)
  })

  it('getAllKeysForRequest cooldown sirasini korur', async () => {
    const { vault } = await kasaKur()
    await vault.addKey('gemini', 'AIza-aaaaaaaaaaaaaaaaaa-A')
    await vault.addKey('gemini', 'AIza-bbbbbbbbbbbbbbbbbb-B')
    const liste = await vault.listKeys('gemini')
    await vault.updateKeyMetadata('gemini', liste[0].id, { cooldownUntil: Date.now() + 60000 })

    const hepsi = await vault.getAllKeysForRequest('gemini')
    expect(hepsi).toHaveLength(2) // beklemedekiler de listelenir
    expect(hepsi[0].key).toBe('AIza-aaaaaaaaaaaaaaaaaa-A')
  })
})

describe('keyVault mukerrer anahtar (esitleme cakismasi)', () => {
  it('ayni anahtar farkli kimlikle kayitliysa mevcut kaydi kullanir', async () => {
    const { vault } = await kasaKur()
    const anahtar = 'AIza-ayni-anahtar-iki-cihaz-1234'
    const yerelId = await vault.addKey('gemini', anahtar)

    const sonuc = await vault.ensureKey('gemini', anahtar, { id: 'gemini:baska-cihaz' })

    expect(sonuc).toEqual({ id: yerelId, created: false })
    const liste = await vault.listKeys('gemini')
    expect(liste).toHaveLength(1)
    expect(await vault.getRawKey('gemini', yerelId)).toBe(anahtar)
  })

  it('parmak izi eslesmesini de yakalar (metin farkli olsa bile)', async () => {
    const { vault } = await kasaKur()
    const yerelId = await vault.addKey('gemini', 'AIza-parmak-izli-anahtar-99', { fingerprint: 'fp-abc' })

    const sonuc = await vault.ensureKey('gemini', 'AIza-baska-metin-ayni-izi', {
      id: 'gemini:baska-cihaz',
      fingerprint: 'fp-abc',
    })

    expect(sonuc).toEqual({ id: yerelId, created: false })
  })

  it('yeni anahtari normal ekler', async () => {
    const { vault } = await kasaKur()

    const sonuc = await vault.ensureKey('gemini', 'AIza-yepyeni-anahtar-1234', { id: 'gemini:yeni' })

    expect(sonuc).toEqual({ id: 'gemini:yeni', created: true })
    expect(await vault.listKeys('gemini')).toHaveLength(1)
  })

  it('bos anahtari reddeder ve mukerrer saymaz', async () => {
    const { vault } = await kasaKur()

    await expect(vault.ensureKey('gemini', '   ', { id: 'gemini:bos' })).rejects.toThrow('key_empty_error')
  })
})

describe('keyVault hazir anahtar yokken neden ayrimi', () => {
  it('duraklatilmis anahtar hiz siniri sayilmaz', async () => {
    const { db, vault } = await kasaKur()
    const id = await vault.addKey('gemini', 'AIza-duraklatilmis-anahtar-1')
    const kayit = (await idbGetAll(db, VAULT_STORES.keys)).find(item => item.id === id)
    await idbPut(db, VAULT_STORES.keys, { ...kayit, status: KEY_HEALTH.PAUSED })

    const sonuc = await vault.resolveKeysForRequest('gemini')

    expect(sonuc.keys).toEqual([])
    // Kullanıcı anahtarı duraklattıysa "hız sınırında, sonra deneyin" denmez.
    expect(sonuc.allInCooldown).toBe(false)
    expect(sonuc.earliestCooldownEnd).toBeNull()
  })

  it('hepsi beklemedeyse hiz siniri bildirilir', async () => {
    const { vault } = await kasaKur()
    const id = await vault.addKey('gemini', 'AIza-beklemede-anahtar-1')
    const bitis = Date.now() + 60000
    await vault.updateKeyMetadata('gemini', id, { cooldownUntil: bitis })

    const sonuc = await vault.resolveKeysForRequest('gemini')

    expect(sonuc.keys).toEqual([])
    expect(sonuc.allInCooldown).toBe(true)
    expect(sonuc.earliestCooldownEnd).toBe(bitis)
  })
})

describe('cihaz anahtari yarisi', () => {
  it('eszamanli cagrilar ayni cihaz anahtarini paylasir', async () => {
    const db = await openDatabase({
      name: `test-vault-race-${sayac++}`,
      version: 1,
      stores: Object.values(VAULT_STORES),
    })

    const [ilk, ikinci] = await Promise.all([loadOrCreateDeviceKey(db), loadOrCreateDeviceKey(db)])

    // İki bağlam aynı anahtarı kullanmazsa kayıtlar birbirini çözemezdi.
    const zarf = await encryptJson(ilk, { key: 'paylasilan-cihaz-anahtari' })
    expect((await decryptJson(ikinci, zarf)).key).toBe('paylasilan-cihaz-anahtari')
  })
})
