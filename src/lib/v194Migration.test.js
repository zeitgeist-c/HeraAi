import { describe, expect, it } from 'vitest'

import { VAULT_STORES, openDatabase } from './idb'
import { createKeyVault, loadOrCreateDeviceKey } from './keyVault'
import {
  BACKUP_STORAGE_KEY,
  LEGACY_STORAGE_KEYS,
  MIGRATION_FLAG,
  buildMigrationPlan,
  countBackupKeys,
  hasCompletedMigration,
  migrateLegacyKeys,
  readBackup,
  readLegacyKeys,
  restoreLegacyKeysFromBackup,
} from './v194Migration'

let sayac = 0

function bellekStorage(baslangic = {}) {
  const veri = { ...baslangic }
  return {
    available: true,
    veri,
    async get(keys) {
      const sonuc = {}
      for (const anahtar of keys) {
        if (veri[anahtar] !== undefined) sonuc[anahtar] = veri[anahtar]
      }
      return sonuc
    },
    async set(data) {
      Object.assign(veri, data)
    },
    async remove(keys) {
      for (const anahtar of keys) delete veri[anahtar]
    },
  }
}

async function kasaKur() {
  const db = await openDatabase({
    name: `test-migration-${sayac++}`,
    version: 1,
    stores: Object.values(VAULT_STORES),
  })
  const deviceKey = await loadOrCreateDeviceKey(db)
  return { db, vault: createKeyVault({ db, deviceKey }) }
}

function ornekVeri() {
  return {
    [LEGACY_STORAGE_KEYS.gemini]: [
      { id: 'g1', key: 'AIza-gemini-ana-1234567890', masked: 'AIza...7890', isPrimary: true, createdAt: 1000, lastUsedAt: 5000, failCount: 0 },
      { id: 'g2', key: 'AIza-gemini-yedek-12345678', masked: 'AIza...5678', isPrimary: false, createdAt: 2000, cooldownUntil: 9000, failCount: 2, lastErrorType: 'rate_limited' },
    ],
    [LEGACY_STORAGE_KEYS.tavily]: [
      { id: 't1', key: 'tvly-tavily-anahtar-12345', masked: 'tvly...2345', isPrimary: true, createdAt: 1500 },
    ],
    [LEGACY_STORAGE_KEYS.openrouter]: [],
    [LEGACY_STORAGE_KEYS.ollama]: [
      { id: 'o1', key: 'ollama-anahtar-123456789', masked: 'olla...6789', isPrimary: true, createdAt: 1200 },
    ],
  }
}

describe('v194Migration okuma ve plan', () => {
  it('eksik veya bozuk alanlari bos dizi sayar', async () => {
    const storage = bellekStorage({
      [LEGACY_STORAGE_KEYS.gemini]: 'bozuk',
      [LEGACY_STORAGE_KEYS.tavily]: [{ key: '   ' }, { id: 'x' }, null],
    })
    const sonuc = await readLegacyKeys(storage)
    expect(sonuc.gemini).toEqual([])
    expect(sonuc.tavily).toEqual([])
    expect(sonuc.openrouter).toEqual([])
    expect(sonuc.ollama).toEqual([])
  })

  it('plan saglayici bazinda sayim uretir ve anahtarlari kirpar', () => {
    const plan = buildMigrationPlan({
      gemini: [{ id: 'g1', key: '  AIza-bosluklu-1234567890  ', isPrimary: true, createdAt: 1000 }],
      tavily: [{ id: 't1', key: 'tvly-x-1234567890' }],
    })

    expect(plan.total).toBe(2)
    expect(plan.perProvider).toEqual({ gemini: 1, tavily: 1 })
    expect(plan.toMigrate[0].key).toBe('AIza-bosluklu-1234567890')
    expect(plan.toMigrate[1].isPrimary).toBe(false)
    expect(plan.toMigrate[1].createdAt).toBeNull()
  })

  it('plan deterministiktir', () => {
    const girdi = { gemini: [{ id: 'g1', key: 'AIza-a-1234567890', createdAt: 5 }] }
    expect(buildMigrationPlan(girdi)).toEqual(buildMigrationPlan(girdi))
  })
})

describe('v194Migration goc akisi', () => {
  it('anahtarlari sifreli kasaya tasir ve acik alanlari temizler', async () => {
    const storage = bellekStorage(ornekVeri())
    const { vault } = await kasaKur()

    const sonuc = await migrateLegacyKeys({ storage, vault, now: 777 })

    expect(sonuc.migrated).toBe(4)
    expect(sonuc.skipped).toBe(0)
    expect(sonuc.backupWritten).toBe(true)
    expect(sonuc.verified).toBe(4)

    // Açık alanlar silindi, damga yazıldı.
    for (const alan of Object.values(LEGACY_STORAGE_KEYS)) {
      expect(storage.veri[alan]).toBeUndefined()
    }
    expect(storage.veri[MIGRATION_FLAG]).toBe(777)
    expect(await hasCompletedMigration(storage)).toBe(true)

    // Kasadan doğru anahtarlar çözülür.
    const gemini = await vault.resolveKeysForRequest('gemini')
    expect(gemini.keys.map(k => k.key)).toEqual([
      'AIza-gemini-ana-1234567890',
      'AIza-gemini-yedek-12345678',
    ])
    expect(gemini.keys[0].isPrimary).toBe(true)
    expect((await vault.resolveKeysForRequest('tavily')).keys).toHaveLength(1)
    expect((await vault.resolveKeysForRequest('ollama')).keys).toHaveLength(1)
  })

  it('goc sirasindaki gecici geri donus yedegi basaridan sonra silinir', async () => {
    const storage = bellekStorage(ornekVeri())
    const { vault } = await kasaKur()

    await migrateLegacyKeys({ storage, vault, now: 777 })

    const yedek = await readBackup(storage)
    expect(yedek).toBeNull()
    expect(countBackupKeys(yedek)).toBe(0)
  })

  it('siralama ve kullanim gecmisi korunur', async () => {
    const storage = bellekStorage(ornekVeri())
    const { vault } = await kasaKur()
    await migrateLegacyKeys({ storage, vault, now: 777 })

    const gemini = await vault.listKeys('gemini')
    expect(gemini[0].createdAt).toBe(1000)
    expect(gemini[1].createdAt).toBe(2000)
    expect(gemini[1].cooldownUntil).toBe(9000)
    expect(gemini[1].failCount).toBe(2)
    expect(gemini[1].lastErrorType).toBe('rate_limited')
    expect(gemini[0].lastUsedAt).toBe(5000)
  })

  it('hic anahtar yoksa yedek yazilmaz ve alanlar korunur', async () => {
    const storage = bellekStorage({ [LEGACY_STORAGE_KEYS.gemini]: [] })
    const { vault } = await kasaKur()

    const sonuc = await migrateLegacyKeys({ storage, vault, now: 777 })

    expect(sonuc.reason).toBe('nothing_to_migrate')
    expect(sonuc.backupWritten).toBe(false)
    expect(storage.veri[BACKUP_STORAGE_KEY]).toBeUndefined()
    expect(storage.veri[MIGRATION_FLAG]).toBe(777)
  })

  it('mukerrer anahtar atlanir, goc tamamlanir', async () => {
    const storage = bellekStorage(ornekVeri())
    const { vault } = await kasaKur()
    await vault.addKey('gemini', 'AIza-gemini-ana-1234567890')

    const sonuc = await migrateLegacyKeys({ storage, vault, now: 777 })

    expect(sonuc.migrated).toBe(3)
    expect(sonuc.skipped).toBe(1)
    expect(storage.veri[MIGRATION_FLAG]).toBe(777)
  })

  it('eski surumden kalan acik yedegi temizler', async () => {
    const storage = bellekStorage({
      ...ornekVeri(),
      [BACKUP_STORAGE_KEY]: { savedAt: 111, version: '1.9.4', keys: { gemini: [{ id: 'eski', key: 'AIza-eski-1234567890' }] } },
    })
    const { vault } = await kasaKur()
    await migrateLegacyKeys({ storage, vault, now: 777 })

    const yedek = await readBackup(storage)
    expect(yedek).toBeNull()
  })
})

describe('v194Migration geri donus', () => {
  it('yedekteki anahtarlari eski alanlara geri yazar', async () => {
    const legacy = ornekVeri()
    const storage = bellekStorage({
      [BACKUP_STORAGE_KEY]: {
        savedAt: 777,
        version: '1.9.4',
        keys: {
          gemini: legacy[LEGACY_STORAGE_KEYS.gemini],
          tavily: legacy[LEGACY_STORAGE_KEYS.tavily],
          openrouter: legacy[LEGACY_STORAGE_KEYS.openrouter],
          ollama: legacy[LEGACY_STORAGE_KEYS.ollama],
        },
      },
    })

    const sonuc = await restoreLegacyKeysFromBackup({ storage })

    expect(sonuc.restored).toBe(4)
    expect(storage.veri[LEGACY_STORAGE_KEYS.gemini]).toHaveLength(2)
    expect(storage.veri[LEGACY_STORAGE_KEYS.gemini][0].key).toBe('AIza-gemini-ana-1234567890')
    expect(storage.veri[LEGACY_STORAGE_KEYS.tavily]).toHaveLength(1)
    expect(storage.veri[MIGRATION_FLAG]).toBeUndefined()
    expect(await hasCompletedMigration(storage)).toBe(false)
  })

  it('yedek yoksa geri yukleme yapilmaz', async () => {
    const storage = bellekStorage({})
    const sonuc = await restoreLegacyKeysFromBackup({ storage })
    expect(sonuc).toEqual({ restored: 0, reason: 'no_backup' })
  })

  it('yedekteki bos saglayicilar geri yazilmaz', async () => {
    const storage = bellekStorage({
      [BACKUP_STORAGE_KEY]: { savedAt: 5, version: '1.9.4', keys: { gemini: [{ id: 'g', key: 'AIza-x-1234567890' }], tavily: [] } },
    })
    const sonuc = await restoreLegacyKeysFromBackup({ storage })
    expect(sonuc.restored).toBe(1)
    expect(storage.veri[LEGACY_STORAGE_KEYS.tavily]).toBeUndefined()
  })
})
