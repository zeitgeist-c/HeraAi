/**
 * HeraAi 1.10.0 — 1.9.4 açık anahtar göçü (Aşama 6).
 *
 * Sıra önemlidir: önce geri dönüş yedeği yazılır, sonra şifreli kasa doldurulur,
 * sonra her kaydın gerçekten çözülebildiği doğrulanır ve ancak bundan sonra
 * `chrome.storage.local` içindeki açık anahtarlar silinir. Herhangi bir adım
 * başarısız olursa açık anahtarlar yerinde kalır — kullanıcı asla anahtarsız
 * kalmaz.
 *
 * Kullanıcı 1.9.4'e dönerse `apiKeys_v194_backup` alanından tek çağrıyla geri
 * yükleyebilir (`restoreLegacyKeysFromBackup`).
 */

import { PROVIDERS } from './keyVault'

/** 1.9.4'te anahtarların tutulduğu `chrome.storage.local` alanları. */
export const LEGACY_STORAGE_KEYS = Object.freeze({
  gemini: 'geminiApiKeys',
  tavily: 'tavilyApiKeys',
  openrouter: 'openRouterApiKeys',
  ollama: 'ollamaApiKeys',
})

/** Geri dönüş emniyeti: açık anahtarların silinmeden önceki kopyası. */
export const BACKUP_STORAGE_KEY = 'apiKeys_v194_backup'

/** Göç tamamlandı damgası (tekrar göçü engeller). */
export const MIGRATION_FLAG = 'vaultMigrationCompletedAt'

export function createStorageAdapter(area) {
  const alan = area ?? globalThis.chrome?.storage?.local
  if (!alan) {
    return {
      available: false,
      async get() { return {} },
      async set() { return undefined },
      async remove() { return undefined },
    }
  }
  return {
    available: true,
    get(keys) {
      return new Promise((resolve) => alan.get(keys, (result) => resolve(result || {})))
    },
    set(data) {
      return new Promise((resolve) => alan.set(data, () => resolve()))
    },
    remove(keys) {
      return new Promise((resolve) => alan.remove(keys, () => resolve()))
    },
  }
}

function dizi(deger) {
  return Array.isArray(deger) ? deger : []
}

/** `chrome.storage.local` içindeki açık anahtarları sağlayıcı bazında okur. */
export async function readLegacyKeys(storage) {
  const alanlar = Object.values(LEGACY_STORAGE_KEYS)
  const ham = await storage.get(alanlar)
  const sonuc = {}
  for (const saglayici of PROVIDERS) {
    const alanAdi = LEGACY_STORAGE_KEYS[saglayici]
    sonuc[saglayici] = dizi(ham?.[alanAdi]).filter(kayit => kayit && typeof kayit.key === 'string' && kayit.key.trim())
  }
  return sonuc
}

/**
 * Göç edilecek kayıtları düzleştirir. Saf fonksiyondur: aynı girdi her zaman
 * aynı planı üretir, bu yüzden doğrulama adımı plana karşı yapılabilir.
 */
export function buildMigrationPlan(legacy) {
  const kayitlar = []
  for (const saglayici of PROVIDERS) {
    for (const kayit of dizi(legacy?.[saglayici])) {
      kayitlar.push({
        provider: saglayici,
        id: kayit.id ?? null,
        key: kayit.key.trim(),
        masked: kayit.masked ?? null,
        isPrimary: Boolean(kayit.isPrimary),
        createdAt: Number.isFinite(kayit.createdAt) ? kayit.createdAt : null,
        lastUsedAt: kayit.lastUsedAt ?? null,
        lastSuccessAt: kayit.lastSuccessAt ?? null,
        lastErrorAt: kayit.lastErrorAt ?? null,
        lastErrorType: kayit.lastErrorType ?? null,
        cooldownUntil: kayit.cooldownUntil ?? null,
        failCount: kayit.failCount ?? 0,
      })
    }
  }
  const sayim = {}
  for (const kayit of kayitlar) sayim[kayit.provider] = (sayim[kayit.provider] || 0) + 1
  return { toMigrate: kayitlar, total: kayitlar.length, perProvider: sayim }
}

export async function hasCompletedMigration(storage) {
  const ham = await storage.get([MIGRATION_FLAG])
  return Boolean(ham?.[MIGRATION_FLAG])
}

export async function readBackup(storage) {
  const ham = await storage.get([BACKUP_STORAGE_KEY])
  return ham?.[BACKUP_STORAGE_KEY] ?? null
}

/**
 * Açık anahtarları şifreli kasaya taşır.
 *
 * @returns {{migrated:number, skipped:number, backupWritten:boolean, verified:number, reason?:string}}
 */
export async function migrateLegacyKeys({ storage, vault, now = Date.now() }) {
  const legacy = await readLegacyKeys(storage)
  const plan = buildMigrationPlan(legacy)

  if (plan.total === 0) {
    return { migrated: 0, skipped: 0, backupWritten: false, verified: 0, reason: 'nothing_to_migrate' }
  }

  // 1) Geri dönüş emniyeti: açık anahtarlar silinmeden önce kopyalanır.
  const mevcutYedek = await readBackup(storage)
  if (!mevcutYedek) {
    await storage.set({
      [BACKUP_STORAGE_KEY]: {
        savedAt: now,
        version: '1.9.4',
        keys: legacy,
      },
    })
  }

  // 2) Şifreli kasaya yaz (ana anahtar ve sıralama korunur).
  let migrated = 0
  let skipped = 0
  const yazilanlar = []

  for (const kayit of plan.toMigrate) {
    try {
      const yeniId = await vault.addKey(kayit.provider, kayit.key, {
        isPrimary: kayit.isPrimary,
        createdAt: kayit.createdAt ?? now,
      })
      yazilanlar.push({ ...kayit, yeniId })
      migrated += 1
    } catch (error) {
      if (error?.message === 'key_duplicate_error') {
        skipped += 1
        continue
      }
      throw error
    }
  }

  // 3) Doğrulama: yazılan her kayıt gerçekten çözülebiliyor mu?
  for (const kayit of yazilanlar) {
    const ham = await vault.getRawKey(kayit.provider, kayit.yeniId)
    if (ham !== kayit.key) throw new Error('migration_verification_failed')
  }

  // 4) Kullanım geçmişi taşınır (cooldown, hata sayaçları).
  for (const kayit of yazilanlar) {
    await vault.updateKeyMetadata(kayit.provider, kayit.yeniId, {
      lastUsedAt: kayit.lastUsedAt,
      lastSuccessAt: kayit.lastSuccessAt,
      lastErrorAt: kayit.lastErrorAt,
      lastErrorType: kayit.lastErrorType,
      cooldownUntil: kayit.cooldownUntil,
      failCount: kayit.failCount,
    })
  }

  // 5) Doğrulama geçti: açık alanlar temizlenir, göç damgalanır.
  await storage.remove(Object.values(LEGACY_STORAGE_KEYS))
  await storage.set({ [MIGRATION_FLAG]: now })

  return { migrated, skipped, backupWritten: true, verified: yazilanlar.length }
}

/**
 * Geri dönüş: yedekteki açık anahtarları `chrome.storage.local` alanlarına
 * geri yazar (1.9.4 uyumluluğu için).
 */
export async function restoreLegacyKeysFromBackup({ storage }) {
  const yedek = await readBackup(storage)
  if (!yedek?.keys) return { restored: 0, reason: 'no_backup' }

  const veri = {}
  let restored = 0
  for (const saglayici of PROVIDERS) {
    const kayitlar = dizi(yedek.keys[saglayici])
    if (kayitlar.length === 0) continue
    veri[LEGACY_STORAGE_KEYS[saglayici]] = kayitlar
    restored += kayitlar.length
  }

  if (restored > 0) {
    await storage.set(veri)
    await storage.remove([MIGRATION_FLAG])
  }
  return { restored, savedAt: yedek.savedAt ?? null }
}

/** Yedekte saklanan ham anahtar sayısı (arayüzde uyarı için). */
export function countBackupKeys(yedek) {
  if (!yedek?.keys) return 0
  let toplam = 0
  for (const saglayici of PROVIDERS) toplam += dizi(yedek.keys[saglayici]).length
  return toplam
}
