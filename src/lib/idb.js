/**
 * HeraAi 1.10.0 — IndexedDB altyapısı (Aşama 6).
 *
 * Yerel-öncelikli çalışmanın taşıyıcısı: şifreli API kasası, sohbet deposu,
 * ekler ve çevrimdışı eşitleme kuyruğu burada tutulur. Tüm işlemler Promise
 * tabanlıdır; hiçbir çağrı yarı yolda bırakılmaz.
 *
 * `chrome.storage.local` yalnızca hızlı bayraklar için kullanılır; asıl veri
 * burada yaşar, böylece tarayıcı kapanışında kayıp yaşanmaz.
 */

export const DB_NAMES = Object.freeze({
  vault: 'heraai-vault',
  chatStore: 'heraai-chat-store',
  attachments: 'heraai-attachments',
})

/** Kasa veritabanı sürümü — store eklendiğinde artırılır. */
export const VAULT_VERSION = 1

export const VAULT_STORES = Object.freeze({
  keys: 'keys',
  meta: 'meta',
  syncQueue: 'syncQueue',
})

/** Eşitleme kilidinin varsayılan ömrü: service worker çökerse kilit kendiliğinden açılır. */
export const LEASE_TTL_MS = 60000

export function idbAvailable() {
  return typeof globalThis.indexedDB !== 'undefined'
}

/** Veritabanını açar; eksik store'lar upgrade sırasında oluşturulur. */
export function openDatabase({ name, version = 1, stores = [] }) {
  return new Promise((resolve, reject) => {
    if (!idbAvailable()) {
      reject(new Error('idb_unavailable'))
      return
    }
    const request = globalThis.indexedDB.open(name, version)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const store of stores) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: 'id' })
        }
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('idb_open_failed'))
    request.onblocked = () => reject(new Error('idb_blocked'))
  })
}

function calistir(db, store, mode, is) {
  return new Promise((resolve, reject) => {
    let tx
    try {
      tx = db.transaction(store, mode)
    } catch (error) {
      reject(error)
      return
    }
    const hedef = tx.objectStore(store)
    let istek
    try {
      istek = is(hedef)
    } catch (error) {
      reject(error)
      return
    }
    tx.oncomplete = () => resolve(istek ? istek.result : undefined)
    tx.onerror = () => reject(tx.error || new Error('idb_tx_failed'))
    tx.onabort = () => reject(tx.error || new Error('idb_tx_aborted'))
  })
}

export function idbGet(db, store, key) {
  return calistir(db, store, 'readonly', hedef => hedef.get(key))
}

export function idbGetAll(db, store) {
  return calistir(db, store, 'readonly', hedef => hedef.getAll())
}

export function idbPut(db, store, value) {
  return calistir(db, store, 'readwrite', hedef => hedef.put(value))
}

/**
 * Tek işlemde "varsa oku, yoksa üret ve yaz". Okuma ile yazma aynı işlemde
 * olduğundan iki bağlam (panel + service worker) aynı anda çağırsa bile tek
 * kayıt oluşur; kaybeden taraf ürettiği adayı atar.
 */
export function idbGetOrPut(db, store, key, uret) {
  return new Promise((resolve, reject) => {
    let tx
    try {
      tx = db.transaction(store, 'readwrite')
    } catch (error) {
      reject(error)
      return
    }
    const hedef = tx.objectStore(store)
    let sonuc
    const istek = hedef.get(key)
    istek.onsuccess = () => {
      if (istek.result !== undefined) {
        sonuc = istek.result
        return
      }
      sonuc = uret()
      hedef.put(sonuc)
    }
    tx.oncomplete = () => resolve(sonuc)
    tx.onerror = () => reject(tx.error || new Error('idb_tx_failed'))
    tx.onabort = () => reject(tx.error || new Error('idb_tx_aborted'))
  })
}

export function idbDelete(db, store, key) {
  return calistir(db, store, 'readwrite', hedef => hedef.delete(key))
}

export function idbClear(db, store) {
  return calistir(db, store, 'readwrite', hedef => hedef.clear())
}

export function idbCount(db, store) {
  return calistir(db, store, 'readonly', hedef => hedef.count())
}

/** Çoklu yazımı tek işlemde uygular (kuyruk boşaltma gibi toplu işler için). */
export function idbPutMany(db, store, values) {
  return new Promise((resolve, reject) => {
    let tx
    try {
      tx = db.transaction(store, 'readwrite')
    } catch (error) {
      reject(error)
      return
    }
    const hedef = tx.objectStore(store)
    for (const value of values) hedef.put(value)
    tx.oncomplete = () => resolve(values.length)
    tx.onerror = () => reject(tx.error || new Error('idb_tx_failed'))
    tx.onabort = () => reject(tx.error || new Error('idb_tx_aborted'))
  })
}

export function idbDeleteMany(db, store, keys) {
  return new Promise((resolve, reject) => {
    let tx
    try {
      tx = db.transaction(store, 'readwrite')
    } catch (error) {
      reject(error)
      return
    }
    const hedef = tx.objectStore(store)
    for (const key of keys) hedef.delete(key)
    tx.oncomplete = () => resolve(keys.length)
    tx.onerror = () => reject(tx.error || new Error('idb_tx_failed'))
    tx.onabort = () => reject(tx.error || new Error('idb_tx_aborted'))
  })
}

/** Acknowledge only the snapshot sent; concurrent replacements must survive. */
export function idbDeleteMatching(db, store, records) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    const target = tx.objectStore(store)
    let deleted = 0
    for (const record of records) {
      const request = target.get(record.id)
      request.onsuccess = () => {
        if (JSON.stringify(request.result) === JSON.stringify(record)) {
          target.delete(record.id)
          deleted += 1
        }
      }
    }
    tx.oncomplete = () => resolve(deleted)
    tx.onerror = () => reject(tx.error || new Error('idb_tx_failed'))
    tx.onabort = () => reject(tx.error || new Error('idb_tx_aborted'))
  })
}

/**
 * Tarayıcıdan kalıcı depolama izni ister. Düşük disk durumunda IndexedDB'nin
 * sessizce silinmesini engeller; desteklenmiyorsa sessizce devam edilir.
 */
export async function requestPersistentStorage() {
  try {
    const storage = globalThis.navigator?.storage
    if (!storage?.persist) return { supported: false, persisted: false }
    const persisted = await storage.persist()
    return { supported: true, persisted: Boolean(persisted) }
  } catch {
    return { supported: false, persisted: false }
  }
}

export async function isStoragePersisted() {
  try {
    const storage = globalThis.navigator?.storage
    if (!storage?.persisted) return false
    return Boolean(await storage.persisted())
  } catch {
    return false
  }
}

/**
 * Süreli kiralama kilidi. Okuma ve yazma aynı işlem içinde yapıldığı için iki
 * sekme aynı anda kilidi alamaz. Service worker beklenmedik şekilde sonlanırsa
 * kilit TTL dolunca kendiliğinden serbest kalır.
 */
export function acquireLease(db, metaStore, name, { owner, now = Date.now(), ttlMs = LEASE_TTL_MS } = {}) {
  return new Promise((resolve, reject) => {
    let tx
    try {
      tx = db.transaction(metaStore, 'readwrite')
    } catch (error) {
      reject(error)
      return
    }
    const hedef = tx.objectStore(metaStore)
    const anahtar = `lease:${name}`
    let sonuc = { acquired: false, lease: null }

    const istek = hedef.get(anahtar)
    istek.onsuccess = () => {
      const mevcut = istek.result
      if (mevcut && mevcut.expiresAt > now && mevcut.owner !== owner) {
        sonuc = { acquired: false, lease: mevcut }
        return
      }
      const lease = { id: anahtar, owner, acquiredAt: now, expiresAt: now + ttlMs }
      hedef.put(lease)
      sonuc = { acquired: true, lease }
    }

    tx.oncomplete = () => resolve(sonuc)
    tx.onerror = () => reject(tx.error || new Error('idb_tx_failed'))
    tx.onabort = () => reject(tx.error || new Error('idb_tx_aborted'))
  })
}

/** Kilidi bırakır; sahibi farklıysa dokunmaz. */
export async function releaseLease(db, metaStore, name, owner) {
  const anahtar = `lease:${name}`
  const mevcut = await idbGet(db, metaStore, anahtar)
  if (!mevcut) return true
  if (owner && mevcut.owner !== owner) return false
  await idbDelete(db, metaStore, anahtar)
  return true
}

export async function readLease(db, metaStore, name, { now = Date.now() } = {}) {
  const lease = await idbGet(db, metaStore, `lease:${name}`)
  if (!lease) return null
  return { ...lease, active: lease.expiresAt > now }
}
