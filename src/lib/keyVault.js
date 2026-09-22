/**
 * HeraAi 1.10.0 — şifreli API anahtarı kasası (Aşama 6).
 *
 * Anahtarlar artık `chrome.storage.local` içinde açık metin durmaz: her kayıt
 * cihaz yerel anahtarıyla (AES-256-GCM) şifrelenip IndexedDB'ye yazılır.
 * Cihaz anahtarı dışa aktarılamaz (`extractable: false`), bu yüzden kasa
 * dosyaları kopyalansa bile başka bir cihazda açılamaz.
 *
 * Sağlayıcı havuzları kesin olarak ayrıdır: her sorgu `provider` ile
 * filtrelenir, bir sağlayıcının anahtarı diğerine asla sızmaz.
 */

import {
  DB_NAMES,
  VAULT_STORES,
  VAULT_VERSION,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  openDatabase,
} from './idb'
import { decryptJson, encryptJson, generateDeviceKey } from './syncCrypto'
import { isKeyUsable } from './keyHealth'
import { KEY_USAGE_MODE, orderKeysForRequest } from './keyRotation'

export const PROVIDERS = Object.freeze(['gemini', 'tavily', 'openrouter', 'ollama'])

/** Cihaz anahtarının meta store içindeki kimliği. */
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
 * Metadata sıralaması: ana anahtar önce, kalanı createdAt artan. createdAt
 * eşitse id ile kararlı sıralanır; aksi halde IndexedDB'nin anahtar sırası
 * sonucu değiştirebilirdi.
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

/** Kayıttan şifreli yükü çıkarır; dışarıya yalnızca açık metadata verilir. */
function metadataOf(kayit) {
  const { ciphertext: _ciphertext, ...acik } = kayit
  return acik
}

/**
 * Kasa örneği üretir. `db` açık bir IndexedDB, `deviceKey` ise AES-GCM
 * anahtarıdır; ikisi de enjekte edilebilir olduğu için testler gerçek
 * IndexedDB ve gerçek Web Crypto ile çalışır.
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

  return {
    /** Maskeli metadata; ham anahtar asla dönmez. */
    async listKeys(provider) {
      saglayiciDogrula(provider)
      const kayitlar = await kayitlariGetir(provider)
      return sortKeyMetadata(kayitlar.map(metadataOf))
    },

    /** Tek anahtarın ham değeri (istek anında çağrılır). */
    async getRawKey(provider, id) {
      saglayiciDogrula(provider)
      const kayit = (await kayitlariGetir(provider)).find(k => k.id === id)
      return kayit ? coz(kayit) : null
    },

    /**
     * Yeni anahtar ekler. Mükerrer anahtar reddedilir: parmak izi verilmişse
     * onunla, verilmemişse çözülerek karşılaştırılır.
     *
     * `isPrimary` ve `createdAt` yalnızca göç sırasında verilir; böylece
     * 1.9.4'teki ana anahtar seçimi ve sıralama aynen korunur.
     */
    async addKey(provider, rawKey, { label = null, fingerprint = null, model = null, isPrimary = null, createdAt = null, id = null } = {}) {
      saglayiciDogrula(provider)
      const trimmed = String(rawKey ?? '').trim()
      if (!trimmed) throw new Error('key_empty_error')

      const mevcut = await kayitlariGetir(provider)
      for (const kayit of mevcut) {
        if (fingerprint && kayit.fingerprint) {
          if (kayit.fingerprint === fingerprint) throw new Error('key_duplicate_error')
          continue
        }
        if ((await coz(kayit)) === trimmed) throw new Error('key_duplicate_error')
      }

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

    /** Sıralı ham anahtar listesi; ana anahtar önce, sonra createdAt artan. */
    async getAllKeysForRequest(provider) {
      saglayiciDogrula(provider)
      const kayitlar = sortKeyMetadata(await kayitlariGetir(provider))
      const keys = []
      for (const kayit of kayitlar) {
        keys.push({ id: kayit.id, key: await coz(kayit), isPrimary: Boolean(kayit.isPrimary) })
      }
      return keys
    },

    /** Beklemede olmayan anahtarlar; hepsi beklemedeyse erken bitiş zamanı bildirilir. */
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
          allInCooldown: kayitlar.length > 0,
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

    /** Kasadaki toplam kayıt sayısı (sağlayıcı bazında). */
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

/** Cihaz anahtarını meta store'dan okur; yoksa üretip saklar. */
export async function loadOrCreateDeviceKey(db, metaStore = VAULT_STORES.meta) {
  const mevcut = await idbGet(db, metaStore, DEVICE_KEY_ID)
  if (mevcut?.key) return mevcut.key

  const deviceKey = await generateDeviceKey()
  await idbPut(db, metaStore, { id: DEVICE_KEY_ID, key: deviceKey, createdAt: Date.now() })
  return deviceKey
}

export async function hasDeviceKey(db, metaStore = VAULT_STORES.meta) {
  const mevcut = await idbGet(db, metaStore, DEVICE_KEY_ID)
  return Boolean(mevcut?.key)
}

/** Kasa veritabanını açar (eksik store'lar upgrade'de oluşturulur). */
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
 * Uygulama genelinde paylaşılan kasa (üretim yolu). Açılış tek bir söz
 * üzerinden yürür: eşzamanlı çağrılar aynı bağlantıyı ve aynı cihaz anahtarını
 * paylaşır, aksi halde iki farklı anahtar üretilip kayıtlar birbirini açamazdı.
 */
export async function getDefaultVault() {
  if (varsayilanKasa) return varsayilanKasa
  if (!kasaSozu) {
    kasaSozu = (async () => {
      // Yerel değişken şart: sıfırlama bu await'ler sırasında çalışırsa
      // `varsayilanDb` null'a çekilir ve kasa null bağlantıyla kurulurdu.
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
 * Önbelleği bırakır ve veritabanı bağlantısını kapatır. Bağlantı açık kalsa
 * `deleteDatabase` bloklanır; testler ve hesap sıfırlama bu yolu kullanır.
 */
export function resetDefaultVault() {
  try {
    varsayilanDb?.close()
  } catch {
    // Bağlantı zaten kapalıysa yoksayılır.
  }
  varsayilanDb = null
  varsayilanKasa = null
  kasaSozu = null
}
