/**
 * HeraAi 1.10.0 - IndexedDB infrastructure (Stage 6).
 *
 * Carrier of local-first work: the encrypted API vault, chat store, attachments and
 * the offline sync queue live here. All operations are Promise based; no call is left
 * half done.
 *
 * `chrome.storage.local` is used only for quick flags; the real data lives here, so
 * nothing is lost when the browser closes.
 */

export const DB_NAMES = Object.freeze({
  vault: 'heraai-vault',
  chatStore: 'heraai-chat-store',
  attachments: 'heraai-attachments',
})

/** Vault database version - bumped when a store is added. */
export const VAULT_VERSION = 1

export const VAULT_STORES = Object.freeze({
  keys: 'keys',
  meta: 'meta',
  syncQueue: 'syncQueue',
})

/**
 * Default lifetime of the sync lock: if the service worker crashes the lock releases by itself.
 */
export const LEASE_TTL_MS = 60000

export function idbAvailable() {
  return typeof globalThis.indexedDB !== 'undefined'
}

/** Opens the database; missing stores are created during the upgrade. */
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
 * Read-if-present, otherwise create-and-write in a single transaction. Because the
 * read and the write are in the same transaction only one record is created even
 * when two contexts (panel + service worker) call at the same time; the losing side
 * discards the candidate it produced.
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
 * Asks the browser for persistent storage. Prevents IndexedDB from being evicted
 * silently on a low disk; when unsupported it silently continues.
 */
/**
 * Time-limited lease lock. Because the read and the write happen in the same
 * transaction two tabs cannot take the lock at the same time. If the service worker
 * terminates unexpectedly the lock frees itself when the TTL expires.
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

/** Releases the lock; does nothing if the owner is different. */
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
