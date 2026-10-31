/**
 * HeraAi 1.10.0 - encrypted API key vault (Stage 6).
 *
 * Keys no longer sit in plain text inside `chrome.storage.local`: every record is
 * encrypted with the device's local key (AES-256-GCM) and written to IndexedDB. The
 * device key cannot be exported (`extractable: false`), so even if the vault files
 * are copied they cannot be opened on another device.
 *
 * Provider pools are strictly separate: every query is filtered by `provider`, a
 * key from one provider never leaks into another.
 */

import {
  DB_NAMES,
  VAULT_STORES,
  VAULT_VERSION,
  idbDelete,
  idbGet,
  idbGetAll,
  idbGetOrPut,
  idbPut,
  openDatabase,
} from './idb'
import { decryptJson, encryptJson, generateDeviceKey } from './syncCrypto'
import { isKeyUsable } from './keyHealth'
import { KEY_USAGE_MODE, orderKeysForRequest } from './keyRotation'

export const PROVIDERS = Object.freeze(['gemini', 'tavily', 'openrouter', 'ollama'])

/** Id of the device key inside the meta store. */
export const DEVICE_KEY_ID = 'deviceCryptoKey'

export function maskKey(key) {
  if (!key || key.length <= 8) return '***'
  return key.slice(0, 4) + '...' + key.slice(-4)
}

function yeniId(provider) {
  return `${provider}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function saglayiciDogrula(provider) {
  if (!PROVIDERS.includes(provider)) throw new Error(`Invalid provider: ${provider}`)
}

async function readUsageMode() {
  try {
    const stored = await globalThis.chrome?.storage?.local?.get?.(['apiKeyUsageMode'])
    return stored?.apiKeyUsageMode === KEY_USAGE_MODE.BALANCED_ROTATION
      ? KEY_USAGE_MODE.BALANCED_ROTATION
      : KEY_USAGE_MODE.PRIMARY
  } catch {
    return KEY_USAGE_MODE.PRIMARY
  }
}

/**
 * Metadata ordering: main key first, the rest by `createdAt` ascending. On equal
 * `createdAt` it sorts stably by id; otherwise IndexedDB's key order could change
 * the result.
 */
export function sortKeyMetadata(entries) {
  return [...entries].sort((a, b) => {
    if (a.isPrimary && !b.isPrimary) return -1
    if (!a.isPrimary && b.isPrimary) return 1
    const fark = (a.createdAt || 0) - (b.createdAt || 0)
    if (fark !== 0) return fark
    return String(a.id).localeCompare(String(b.id))
  })
}

export const KEY_METADATA_FIELDS = Object.freeze([
  'label',
  'lastUsedAt',
  'lastSuccessAt',
  'lastErrorAt',
  'lastErrorType',
  'cooldownUntil',
  'failCount',
  'status',
  'fingerprint',
  'model',
])

/** Extracts the encrypted payload from a record; only plain metadata is exposed. */
function metadataOf(kayit) {
  const { ciphertext: _ciphertext, ...acik } = kayit
  return acik
}

/**
 * Creates a vault instance. `db` is an open IndexedDB and `deviceKey` is the
 * AES-GCM key; both are injectable, so the tests run against a real IndexedDB and
 * real Web Crypto.
 */
export function createKeyVault({ db, deviceKey, store = VAULT_STORES.keys }) {
  async function kayitlariGetir(provider) {
    const hepsi = await idbGetAll(db, store)
    return hepsi.filter(kayit => kayit.provider === provider)
  }

  async function coz(kayit) {
    const yuk = await decryptJson(deviceKey, kayit.ciphertext)
    return yuk.key
  }

  /**
   * Finds the id of a duplicate record; the same comparison rule as `addKey`:
   * by fingerprint when given, otherwise by decrypting and comparing.
   */
  async function mukerrerId(mevcut, { trimmed = '', fingerprint = null } = {}) {
    for (const kayit of mevcut) {
      if (fingerprint && kayit.fingerprint) {
        if (kayit.fingerprint === fingerprint) return kayit.id
        continue
      }
      if (trimmed && (await coz(kayit)) === trimmed) return kayit.id
    }
    return null
  }

  /**
   * Adds a new key. A duplicate key is rejected: compared by fingerprint when given,
   * otherwise by decrypting.
   *
   * `isPrimary` and `createdAt` are supplied only during migration, so the 1.9.4 main
   * key selection and ordering are preserved as they were.
   */
  async function anahtarEkle(provider, rawKey, { label = null, fingerprint = null, model = null, isPrimary = null, createdAt = null, id = null } = {}) {
    saglayiciDogrula(provider)
    const trimmed = String(rawKey ?? '').trim()
    if (!trimmed) throw new Error('key_empty_error')

    const mevcut = await kayitlariGetir(provider)
    if (await mukerrerId(mevcut, { trimmed, fingerprint })) throw new Error('key_duplicate_error')

    const kayit = {
      id: id ?? yeniId(provider),
      provider,
      label: String(label ?? '').trim().slice(0, 60) || null,
      masked: maskKey(trimmed),
      fingerprint,
      model,
      ciphertext: await encryptJson(deviceKey, { key: trimmed }),
      isPrimary: isPrimary === null ? mevcut.length === 0 : Boolean(isPrimary),
      createdAt: createdAt ?? Date.now(),
      lastUsedAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorType: null,
      cooldownUntil: null,
      failCount: 0,
      status: 'ready',
    }

    await idbPut(db, store, kayit)
    return kayit.id
  }

  return {
    /** Masked metadata; the raw key is never returned. */
    async listKeys(provider) {
      saglayiciDogrula(provider)
      const kayitlar = await kayitlariGetir(provider)
      return sortKeyMetadata(kayitlar.map(metadataOf))
    },

    /** Raw value of a single key (called at request time). */
    async getRawKey(provider, id) {
      saglayiciDogrula(provider)
      const kayit = (await kayitlariGetir(provider)).find(k => k.id === id)
      return kayit ? coz(kayit) : null
    },

    /** Adds a new key; the duplicate check and the record shape live in `anahtarEkle`. */
    async addKey(provider, rawKey, secenekler = {}) {
      return anahtarEkle(provider, rawKey, secenekler)
    },

    /**
     * Adds the key; if the same key is already registered under a different id it
     * returns the existing record's id instead of an error (`created: false`). That is
     * why sync does not conflict: the same key added under separate ids on two devices
     * converges on a single record. If no record exists the original error passes through.
     */
    async ensureKey(provider, rawKey, secenekler = {}) {
      try {
        const id = await anahtarEkle(provider, rawKey, secenekler)
        return { id, created: true }
      } catch (error) {
        if (error?.message !== 'key_duplicate_error') throw error
        const id = await mukerrerId(await kayitlariGetir(provider), {
          trimmed: String(rawKey ?? '').trim(),
          fingerprint: secenekler.fingerprint ?? null,
        })
        if (!id) throw error
        return { id, created: false }
      }
    },

    async removeKey(provider, id) {
      saglayiciDogrula(provider)
      const kayitlar = await kayitlariGetir(provider)
      const silinecek = kayitlar.find(k => k.id === id)
      if (!silinecek) return false

      await idbDelete(db, store, id)

      if (silinecek.isPrimary) {
        const kalan = sortKeyMetadata(kayitlar.filter(k => k.id !== id))
        if (kalan.length > 0) {
          kalan[0].isPrimary = true
          await idbPut(db, store, kalan[0])
        }
      }
      return true
    },

    async setPrimary(provider, id) {
      saglayiciDogrula(provider)
      const kayitlar = await kayitlariGetir(provider)
      let bulundu = false
      for (const kayit of kayitlar) {
        const olmali = kayit.id === id
        if (olmali) bulundu = true
        if (Boolean(kayit.isPrimary) !== olmali) {
          kayit.isPrimary = olmali
          await idbPut(db, store, kayit)
        }
      }
      return bulundu
    },

    async updateKeyMetadata(provider, id, updates) {
      saglayiciDogrula(provider)
      const kayit = (await kayitlariGetir(provider)).find(k => k.id === id)
      if (!kayit) return false

      let degisti = false
      for (const alan of KEY_METADATA_FIELDS) {
        if (updates?.[alan] !== undefined && kayit[alan] !== updates[alan]) {
          kayit[alan] = updates[alan]
          degisti = true
        }
      }
      if (degisti) await idbPut(db, store, kayit)
      return degisti
    },

    /** Ordered raw key list; main key first, then `createdAt` ascending. */
    async getAllKeysForRequest(provider) {
      saglayiciDogrula(provider)
      const kayitlar = sortKeyMetadata(await kayitlariGetir(provider))
      const keys = []
      for (const kayit of kayitlar) {
        keys.push({ id: kayit.id, key: await coz(kayit), isPrimary: Boolean(kayit.isPrimary) })
      }
      return keys
    },

    /** Keys that are not waiting; if all are waiting the early finish time is reported. */
    async resolveKeysForRequest(provider) {
      saglayiciDogrula(provider)
      const kayitlar = await kayitlariGetir(provider)
      const now = Date.now()

      const hazir = []
      const beklemede = []
      for (const kayit of kayitlar) {
        if (kayit.cooldownUntil && kayit.cooldownUntil > now) beklemede.push(kayit)
        else if (isKeyUsable(kayit, { now })) hazir.push(kayit)
      }

      if (hazir.length === 0) {
        return {
          keys: [],
          // Only when truly all of them are waiting is it called a "rate limit";
          // it does not
          // send the user into a needless wait while keys are paused/invalid.
          allInCooldown: kayitlar.length > 0 && beklemede.length === kayitlar.length,
          earliestCooldownEnd: beklemede.length > 0
            ? Math.min(...beklemede.map(k => k.cooldownUntil))
            : null,
        }
      }

      const mode = await readUsageMode()
      const sirali = orderKeysForRequest(hazir, mode)
      if (sirali[0]) {
        sirali[0].lastUsedAt = now
        await idbPut(db, store, sirali[0])
      }
      const keys = []
      for (const kayit of sirali) {
        keys.push({ id: kayit.id, key: await coz(kayit), isPrimary: Boolean(kayit.isPrimary) })
      }
      return { keys, mode, allInCooldown: false, earliestCooldownEnd: null }
    },

    /** Total record count in the vault (per provider). */
    async countKeys() {
      const hepsi = await idbGetAll(db, store)
      const sayim = {}
      for (const kayit of hepsi) {
        sayim[kayit.provider] = (sayim[kayit.provider] || 0) + 1
      }
      return sayim
    },
  }
}

/** Reads the device key from the meta store; creates and stores one when absent. */
export async function loadOrCreateDeviceKey(db, metaStore = VAULT_STORES.meta) {
  const mevcut = await idbGet(db, metaStore, DEVICE_KEY_ID)
  if (mevcut?.key) return mevcut.key

  // The candidate key is generated before the transaction; because
  // read-or-write runs
  // in a single transaction, if two contexts (panel + service worker) race
  // only one
  // writes and both use the same key - otherwise the records could not
  // decrypt each other.
  const aday = await generateDeviceKey()
  const kayit = await idbGetOrPut(db, metaStore, DEVICE_KEY_ID, () => ({
    id: DEVICE_KEY_ID,
    key: aday,
    createdAt: Date.now(),
  }))
  return kayit?.key || aday
}

/** Opens the vault database (missing stores are created during the upgrade). */
export function openVaultDatabase() {
  return openDatabase({
    name: DB_NAMES.vault,
    version: VAULT_VERSION,
    stores: Object.values(VAULT_STORES),
  })
}

let varsayilanKasa = null
let varsayilanDb = null
let kasaSozu = null

/**
 * The vault shared across the app (production path). Opening runs through a single
 * promise: concurrent calls share the same connection and the same device key,
 * otherwise two different keys would be generated and the records could not decrypt each other.
 */
export async function getDefaultVault() {
  if (varsayilanKasa) return varsayilanKasa
  if (!kasaSozu) {
    kasaSozu = (async () => {
      // The local variable is essential: if a reset runs during these
      // awaits
      // `varsayilanDb` would be set to null and the vault would be built
      // on a null connection.
      const db = await openVaultDatabase()
      const deviceKey = await loadOrCreateDeviceKey(db)
      varsayilanDb = db
      return createKeyVault({ db, deviceKey })
    })()
  }
  try {
    varsayilanKasa = await kasaSozu
  } catch (error) {
    kasaSozu = null
    throw error
  }
  return varsayilanKasa
}

/**
 * Drops the cache and closes the database connection. If the connection stayed open
 * `deleteDatabase` would be blocked; tests and account reset use this path.
 */
export function resetDefaultVault() {
  try {
    varsayilanDb?.close()
  } catch {
    // Ignored when the connection is already closed.
  }
  varsayilanDb = null
  varsayilanKasa = null
  kasaSozu = null
}
