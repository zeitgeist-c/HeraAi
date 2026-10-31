/**
 * HeraAi 1.10.0 - 1.9.4 plaintext key migration (Stage 6).
 *
 * Order matters: a temporary rollback copy is written, the encrypted vault is filled,
 * every record is verified to decrypt, and only then are the plaintext keys and the
 * temporary copy deleted together. If any step fails the plaintext source fields stay
 * in place; after a successful migration no unencrypted key is left in persistent storage.
 */

import { PROVIDERS } from './keyVault'

/** `chrome.storage.local` fields where 1.9.4 kept the keys. */
export const LEGACY_STORAGE_KEYS = Object.freeze({
  gemini: 'geminiApiKeys',
  tavily: 'tavilyApiKeys',
  openrouter: 'openRouterApiKeys',
  ollama: 'ollamaApiKeys',
})

/** Rollback safety: a copy of the plaintext keys before they are deleted. */
export const BACKUP_STORAGE_KEY = 'apiKeys_v194_backup'

/** Migration completed stamp (prevents a second migration). */
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
    async get(keys) {
      return (await alan.get(keys)) || {}
    },
    async set(data) {
      await alan.set(data)
    },
    async remove(keys) {
      await alan.remove(keys)
    },
  }
}

function dizi(deger) {
  return Array.isArray(deger) ? deger : []
}

/** Reads the plaintext keys in `chrome.storage.local` per provider. */
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
 * Flattens the records to be migrated. It is a pure function: the same input always
 * produces the same plan, so the verification step can run against the plan.
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
 * Moves the plaintext keys into the encrypted vault.
 *
 * @returns {{migrated:number, skipped:number, backupWritten:boolean, verified:number, reason?:string}}
 */
export async function migrateLegacyKeys({ storage, vault, now = Date.now() }) {
  if (await hasCompletedMigration(storage)) {
    // 1.10.1 clears the plaintext rollback copy 1.10.0 left behind.
    await storage.remove([BACKUP_STORAGE_KEY])
    return { migrated: 0, skipped: 0, backupWritten: false, verified: 0, reason: 'already_migrated' }
  }
  const legacy = await readLegacyKeys(storage)
  const plan = buildMigrationPlan(legacy)

  if (plan.total === 0) {
    await storage.set({ [MIGRATION_FLAG]: now })
    return { migrated: 0, skipped: 0, backupWritten: false, verified: 0, reason: 'nothing_to_migrate' }
  }

  // 1) Rollback safety: the plaintext keys are copied before deletion.
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

  // 2) Write to the encrypted vault (main key and ordering
  // preserved).
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

  // 3) Verification: can every written record really be
  // decrypted?
  for (const kayit of yazilanlar) {
    const ham = await vault.getRawKey(kayit.provider, kayit.yeniId)
    if (ham !== kayit.key) throw new Error('migration_verification_failed')
  }

  // 4) Usage history is carried over (cooldown, error counters).
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

  // 5) Verification passed: the plaintext fields and the temporary rollback
  // copy are
  // cleared. No unencrypted API key is left in persistent storage.
  await storage.remove([...Object.values(LEGACY_STORAGE_KEYS), BACKUP_STORAGE_KEY])
  await storage.set({ [MIGRATION_FLAG]: now })

  return { migrated, skipped, backupWritten: true, verified: yazilanlar.length }
}

/**
 * Restores only the temporary copy left by a half-finished older migration.
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

/** Number of raw keys kept in the backup (for the UI warning). */
export function countBackupKeys(yedek) {
  if (!yedek?.keys) return 0
  let toplam = 0
  for (const saglayici of PROVIDERS) toplam += dizi(yedek.keys[saglayici]).length
  return toplam
}
