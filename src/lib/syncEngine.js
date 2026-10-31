/**
 * HeraAi 1.10.0 - sync engine and offline queue (Stage 7).
 *
 * Central engine that sends local changes without losing them and receives remote
 * changes safely. It is compatible with the Service Worker lifecycle: the lease is
 * kept in IndexedDB, so if the worker terminates the operation continues by itself
 * when the TTL expires.
 *
 * The engine is independent of the data model: where to read the payload from
 * (`readPayload`), how to find the local version (`readLocalVersion`) and how to
 * apply the remote change (`applyRemote`) are supplied from outside. That way the
 * same engine serves settings, the vault and chats.
 *
 * Cycle steps (plan section 11):
 * 1. Network and session status are checked.
 * 2. The master secret is unwrapped with the device key, subkeys are loaded into memory.
 * 3. The queue is read, consecutive operations on the same entity are coalesced.
 * 4. Changes are encrypted and sent in batches of 500.
 * 5. Sent records are cleared from the queue.
 * 6. New changes after the server cursor are pulled.
 * 7. Downloaded records are decrypted with AAD verification.
 * 8. A deterministic version comparison is applied to the local store.
 * 9. The new cursor is saved and `SYNC_IDLE` is reported to the UI.
 */

import {
  LEASE_TTL_MS,
  VAULT_STORES,
  acquireLease,
  idbDeleteMatching,
  idbGet,
  idbGetAll,
  idbPut,
  releaseLease,
} from './idb'
import {
  buildEntityDocument,
  compareEntityVersions,
  deriveOpaqueId,
  entityTypeForStorageKey,
  isIncomingNewer,
  parseEntityVersion,
  CLOUD_SCHEMA_VERSION,
} from './syncModel'
import { buildAad, decryptBytes, decryptJson, encryptBytes, encryptJson } from './syncCrypto'

/** Lock name; a single sync cycle runs in only one context at a time. */
export const SYNC_LEASE_NAME = 'sync'

/** Firestore batch limit. */
export const SYNC_BATCH_SIZE = 500

/** Maximum number of documents taken in a single pull. */
export const SYNC_PULL_LIMIT = 200

export const SESSION_DOC_SAFE_BYTES = 700 * 1024
export const SESSION_CHUNK_BYTES = 480 * 1024

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function chunkAad(base, revision, index) {
  const suffix = encoder.encode(`|chunk:${revision}:${index}`)
  const result = new Uint8Array(base.length + suffix.length)
  result.set(base)
  result.set(suffix, base.length)
  return result
}

/** Queue record types. */
export const QUEUE_OP = Object.freeze({ PUT: 'put', DELETE: 'delete' })

/** Sync states reported to the UI. */
export const SYNC_STATE = Object.freeze({
  IDLE: 'idle',
  SYNCING: 'syncing',
  SIGNED_OUT: 'signed_out',
  LOCKED: 'locked',
  OFFLINE: 'offline',
  ERROR: 'error',
})

/** Reasons a cycle result was skipped. */
export const SYNC_SKIP = Object.freeze({
  SIGNED_OUT: 'signed_out',
  LEASE_HELD: 'lease_held',
  IN_PROGRESS: 'in_progress',
  OFFLINE: 'offline',
})

/** Deterministic id of a queue record: the same entity merges into a single row. */
export function queueId(storageKey, logicalId) {
  return `${storageKey}::${logicalId}`
}

/**
 * Coalesces the queue: only the newest operation per entity remains. A delete always
 * wins because the version comparison also covers deletion; on equal versions the
 * last written record applies.
 */
export function coalesceQueue(records) {
  const sonuc = new Map()
  for (const kayit of records || []) {
    if (!kayit?.id) continue
    const mevcut = sonuc.get(kayit.id)
    if (!mevcut) {
      sonuc.set(kayit.id, kayit)
      continue
    }
    const karsilastirma = compareEntityVersions(kayit.entityVersion, mevcut.entityVersion)
    if (karsilastirma > 0) {
      sonuc.set(kayit.id, kayit)
    } else if (karsilastirma === 0 && kayit.op === QUEUE_OP.DELETE && mevcut.op !== QUEUE_OP.DELETE) {
      sonuc.set(kayit.id, kayit)
    }
  }
  return [...sonuc.values()]
}

/** Cursor: the sort key of the last seen document on the server. */
function normalizeCursor(raw) {
  if (!raw) return null
  const serverUpdatedAt = Number(raw.serverUpdatedAt)
  if (!Number.isFinite(serverUpdatedAt)) return null
  return {
    serverUpdatedAt,
    opaqueEntityId: typeof raw.opaqueEntityId === 'string' ? raw.opaqueEntityId : '',
    ...(Number.isInteger(raw.serverTimestampSeconds) && Number.isInteger(raw.serverTimestampNanoseconds) ? {
      serverTimestampSeconds: raw.serverTimestampSeconds,
      serverTimestampNanoseconds: raw.serverTimestampNanoseconds,
    } : {}),
  }
}

function cursorFromDocument(document) {
  return normalizeCursor(document)
}

function ilerlemeVarMi(mevcut, yeni) {
  if (!yeni) return false
  if (!mevcut) return true
  if (Number.isInteger(mevcut.serverTimestampSeconds) && Number.isInteger(yeni.serverTimestampSeconds)) {
    if (yeni.serverTimestampSeconds !== mevcut.serverTimestampSeconds) return yeni.serverTimestampSeconds > mevcut.serverTimestampSeconds
    if (yeni.serverTimestampNanoseconds !== mevcut.serverTimestampNanoseconds) return yeni.serverTimestampNanoseconds > mevcut.serverTimestampNanoseconds
    return yeni.opaqueEntityId > mevcut.opaqueEntityId
  }
  if (yeni.serverUpdatedAt !== mevcut.serverUpdatedAt) {
    return yeni.serverUpdatedAt > mevcut.serverUpdatedAt
  }
  return yeni.opaqueEntityId > mevcut.opaqueEntityId
}

/**
 * Sets up the sync engine.
 *
 * @param {object} options
 * @param {IDBDatabase} options.db Vault database.
 * @param {() => string|null} options.getUid Session owner; `null` when absent.
 * @param {() => Promise<object>} options.getSubkeys Subkeys (dataEncryptionKey, hmacIdKey...).
 * @param {(storageKey: string, logicalId: string) => Promise<any>} options.readPayload Payload to
 * send.
 * @param {(change: object) => Promise<boolean>} options.applyRemote Applies the remote change.
 * @param {(entityType: string, opaqueEntityId: string) => Promise<object|null>}
 * options.readLocalVersion Local version.
 * @param {object} options.transport `pushEntities` and `pullEntities`.
 * @param {() => boolean} [options.isOnline] Network status.
 * @param {(state: string, detail: object) => void} [options.onState] State notification.
 */
export function createSyncEngine({
  db,
  metaStore = VAULT_STORES.meta,
  queueStore = VAULT_STORES.syncQueue,
  deviceId,
  getUid,
  getSubkeys,
  readPayload,
  applyRemote,
  readLocalVersion,
  transport,
  isOnline = () => true,
  now = () => Date.now(),
  leaseTtlMs = LEASE_TTL_MS,
  batchSize = SYNC_BATCH_SIZE,
  pullLimit = SYNC_PULL_LIMIT,
  onState = () => {},
} = {}) {
  if (!db) throw new Error('sync_db_missing')
  if (!deviceId) throw new Error('sync_device_missing')
  if (typeof getUid !== 'function') throw new Error('sync_uid_reader_missing')
  if (typeof getSubkeys !== 'function') throw new Error('sync_subkeys_reader_missing')
  if (typeof readPayload !== 'function') throw new Error('sync_payload_reader_missing')
  if (typeof applyRemote !== 'function') throw new Error('sync_apply_missing')
  if (!transport?.pushEntities || !transport?.pullEntities) {
    throw new Error('sync_transport_missing')
  }

  let durum = SYNC_STATE.IDLE
  let calisiyor = false
  let sonCevrim = null

  function bildir(yeni, detay = {}) {
    durum = yeni
    try {
      onState(yeni, detay)
    } catch (dinleyiciHatasi) {
      // If the state listener throws the sync must not stop; it is logged for
      // diagnostics.
      console.error('Sync state listener failed', dinleyiciHatasi)
    }
  }

  function getStatus() {
    return { state: durum, running: calisiyor, lastRun: sonCevrim }
  }

  /** Adds a change to the queue; the previous record for the same entity is updated. */
  async function enqueue({ storageKey, logicalId, op = QUEUE_OP.PUT, entityVersion, entityType }) {
    const tip = entityType || entityTypeForStorageKey(storageKey)
    if (!tip) throw new Error('sync_entity_type_unknown')
    if (!logicalId && logicalId !== 0) throw new Error('sync_logical_id_missing')
    if (!entityVersion) throw new Error('sync_version_missing')
    const kayit = {
      id: queueId(storageKey, logicalId),
      storageKey,
      logicalId: String(logicalId),
      entityType: tip,
      op: op === QUEUE_OP.DELETE ? QUEUE_OP.DELETE : QUEUE_OP.PUT,
      entityVersion: { ...entityVersion },
      queuedAt: now(),
      queueToken: globalThis.crypto.randomUUID(),
    }
    await idbPut(db, queueStore, kayit)
    return kayit
  }

  /** Number of pending records (after coalescing). */
  async function pendingCount() {
    const ham = await idbGetAll(db, queueStore)
    return coalesceQueue(ham).length
  }

  async function readCursor() {
    const kayit = await idbGet(db, metaStore, 'syncPullCursor')
    return normalizeCursor(kayit)
  }

  async function writeCursor(cursor) {
    if (!cursor) return
    await idbPut(db, metaStore, { id: 'syncPullCursor', ...cursor, savedAt: now() })
  }

  /** Turns a single queue record into an encrypted cloud document. */
  async function kaydiHazirla(uid, subkeys, kayit) {
    const opaqueEntityId = await deriveOpaqueId(subkeys.hmacIdKey, kayit.entityType, kayit.logicalId)
    const aad = buildAad({ ownerUid: uid, opaqueEntityId, entityType: kayit.entityType })
    const silme = kayit.op === QUEUE_OP.DELETE

    let yuk = null
    if (!silme) {
      yuk = await readPayload(kayit.storageKey, kayit.logicalId)
      // If the record no longer exists (deleted meanwhile) the send
      // is skipped.
      if (yuk === null || yuk === undefined) return { opaqueEntityId, skipped: true }
    }

    const zarf = await encryptJson(
      subkeys.dataEncryptionKey,
      silme ? { deleted: true, storageKey: kayit.storageKey, logicalId: kayit.logicalId } : yuk,
      aad,
    )
    const temel = {
      ownerUid: uid,
      entityVersion: kayit.entityVersion,
      sourceDeviceId: deviceId,
      nonce: zarf.nonce,
      ciphertext: zarf.ciphertext,
    }
    let belge = buildEntityDocument({
      ...temel,
      entityType: kayit.entityType,
      deleted: silme,
    })
    let chunks = null
    let chunkRevision = null
    if (!silme && kayit.entityType === 'session' && zarf.ciphertext.length > SESSION_DOC_SAFE_BYTES) {
      const bytes = encoder.encode(JSON.stringify(yuk))
      chunkRevision = `${kayit.entityVersion.wallTimeMs}-${kayit.entityVersion.logicalCounter}-${kayit.entityVersion.deviceId}`
      chunks = []
      for (let offset = 0, index = 0; offset < bytes.length; offset += SESSION_CHUNK_BYTES, index += 1) {
        const encrypted = await encryptBytes(
          subkeys.dataEncryptionKey,
          bytes.subarray(offset, Math.min(bytes.length, offset + SESSION_CHUNK_BYTES)),
          chunkAad(aad, chunkRevision, index),
        )
        chunks.push({ index, nonce: encrypted.nonce, ciphertext: encrypted.ciphertext })
      }
      belge = {
        ...buildEntityDocument({
          ...temel,
          nonce: null,
          ciphertext: null,
          entityType: kayit.entityType,
          deleted: false,
        }),
        chunkCount: chunks.length,
        chunkRevision,
        payloadBytes: bytes.length,
      }
    } else {
      belge = { ...belge, chunkCount: 0 }
    }

    return { opaqueEntityId, document: belge, chunks, chunkRevision }
  }

  /** Steps 3-5: drains the queue. */
  async function gonderBekleyenler(uid, subkeys) {
    const ham = await idbGetAll(db, queueStore)
    const kayitlar = coalesceQueue(ham)
    if (kayitlar.length === 0) return { pushed: 0, batches: 0 }

    let toplam = 0
    let parti = 0
    for (let i = 0; i < kayitlar.length; i += batchSize) {
      const dilim = kayitlar.slice(i, i + batchSize)
      const belgeler = []
      const chunkPlans = new Map()
      const temizlenecek = []

      for (const kayit of dilim) {
        const hazir = await kaydiHazirla(uid, subkeys, kayit)
        temizlenecek.push(kayit)
        if (hazir?.skipped) continue
        belgeler.push({ opaqueEntityId: hazir.opaqueEntityId, document: hazir.document })
        chunkPlans.set(hazir.opaqueEntityId, hazir)
      }

      if (belgeler.length > 0) {
        for (const plan of chunkPlans.values()) {
          if (plan.chunks?.length) {
            if (!transport.setEntityChunks) throw new Error('sync_chunk_transport_missing')
            await transport.setEntityChunks(uid, plan.opaqueEntityId, plan.chunkRevision, plan.chunks)
          }
        }
        const pushed = await transport.pushEntities({ uid, documents: belgeler })
        const appliedIds = pushed?.applied || belgeler.map(item => item.opaqueEntityId)
        const applied = new Set(appliedIds)
        for (const [opaqueEntityId, plan] of chunkPlans) {
          if (!applied.has(opaqueEntityId)) {
            if (plan.chunkRevision && transport.deleteEntityChunksRevision) {
              await transport.deleteEntityChunksRevision(uid, opaqueEntityId, plan.chunkRevision)
            }
            continue
          }
          if (transport.deleteStaleEntityChunks) {
            await transport.deleteStaleEntityChunks(uid, opaqueEntityId, plan?.chunkRevision || null)
          }
        }
        toplam += belgeler.length
        parti += 1
      }
      // Step 5: sent records drop out of the queue.
      if (temizlenecek.length > 0) await idbDeleteMatching(db, queueStore, temizlenecek)
    }
    return { pushed: toplam, batches: parti }
  }

  /** Steps 6-8: pulls remote changes and applies them. */
  async function cekUzakDegisiklikler(uid, subkeys) {
    const baslangic = await readCursor()
    let imlec = baslangic
    let uygulanan = 0
    let cekilen = 0

    for (let tur = 0; tur < 50; tur += 1) {
      const yanit = await transport.pullEntities({ uid, cursor: imlec, limit: pullLimit })
      const belgeler = Array.isArray(yanit?.documents) ? yanit.documents : []
      if (belgeler.length === 0) break
      cekilen += belgeler.length

      for (const uzak of belgeler) {
        // An unreadable document is not skipped silently; the cursor is kept so
        // it can be retried.
        const sonuc = await uzakUygula(uid, subkeys, uzak)
        if (sonuc) uygulanan += 1
        const yeni = cursorFromDocument(uzak)
        if (ilerlemeVarMi(imlec, yeni)) imlec = yeni
      }

      if (belgeler.length < (yanit.pageSize || pullLimit)) break
    }

    // Step 9: the cursor is saved only if it moved forward.
    if (ilerlemeVarMi(baslangic, imlec)) await writeCursor(imlec)
    return { pulled: cekilen, applied: uygulanan, quarantined: 0 }
  }

  /** Steps 7-8: AAD verification, version comparison, local application. */
  async function uzakUygula(uid, subkeys, uzak) {
    if (!uzak?.opaqueEntityId) return false
    if (Number(uzak.schemaVersion) !== CLOUD_SCHEMA_VERSION) {
      throw new Error('sync_version_unsupported')
    }
    const entityType = uzak.entityType
    const aad = buildAad({ ownerUid: uid, opaqueEntityId: uzak.opaqueEntityId, entityType })
    let yuk
    try {
      if (Number(uzak.chunkCount) > 0) {
        if (!uzak.chunkRevision || !transport.getEntityChunks) throw new Error('sync_chunk_incomplete')
        const chunks = await transport.getEntityChunks(uid, uzak.opaqueEntityId, uzak.chunkRevision)
        if (chunks.length !== Number(uzak.chunkCount)) throw new Error('sync_chunk_incomplete')
        const parts = []
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index]
          if (Number(chunk.index) !== index) throw new Error('sync_chunk_incomplete')
          parts.push(await decryptBytes(
            subkeys.dataEncryptionKey,
            { nonce: chunk.nonce, ciphertext: chunk.ciphertext },
            chunkAad(aad, uzak.chunkRevision, index),
          ))
        }
        const total = parts.reduce((sum, part) => sum + part.length, 0)
        const bytes = new Uint8Array(total)
        let offset = 0
        for (const part of parts) {
          bytes.set(part, offset)
          offset += part.length
        }
        yuk = JSON.parse(decoder.decode(bytes))
      } else {
        if (!uzak.ciphertext || !uzak.nonce) throw new Error('sync_payload_invalid')
        yuk = await decryptJson(
          subkeys.dataEncryptionKey,
          { nonce: uzak.nonce, ciphertext: uzak.ciphertext },
          aad,
        )
      }
    } catch (error) {
      if (error?.message === 'sync_chunk_incomplete') throw error
      throw new Error('sync_payload_invalid', { cause: error })
    }

    const uzakSurum = parseEntityVersion(uzak.entityVersion)
    if (!uzakSurum) throw new Error('sync_payload_invalid')

    const yerelSurum = readLocalVersion
      ? await readLocalVersion(entityType, uzak.opaqueEntityId)
      : null
    if (!isIncomingNewer(uzakSurum, yerelSurum)) return false

    const silindi = uzak.deleted === true || entityType === 'tombstone'
    const uygulandi = await applyRemote({
      entityType,
      opaqueEntityId: uzak.opaqueEntityId,
      entityVersion: uzakSurum,
      deleted: silindi,
      payload: yuk,
      sourceDeviceId: uzak.sourceDeviceId || null,
      serverUpdatedAt: Number(uzak.serverUpdatedAt) || null,
    })
    return uygulandi !== false
  }

  /** Steps 1-9: a single sync cycle. */
  async function runOnce() {
    if (calisiyor) return { skipped: SYNC_SKIP.IN_PROGRESS }
    calisiyor = true
    try {
      // Step 1: session and network check.
      const uid = getUid()
      if (!uid) {
        bildir(SYNC_STATE.SIGNED_OUT)
        return { skipped: SYNC_SKIP.SIGNED_OUT }
      }
      if (!isOnline()) {
        bildir(SYNC_STATE.OFFLINE)
        return { skipped: SYNC_SKIP.OFFLINE }
      }

      const kilit = acquireLease(db, metaStore, SYNC_LEASE_NAME, {
        owner: deviceId,
        now: now(),
        ttlMs: leaseTtlMs,
      })
      const kilitSonuc = await kilit
      if (!kilitSonuc.acquired) {
        bildir(SYNC_STATE.LOCKED)
        return { skipped: SYNC_SKIP.LEASE_HELD }
      }

      bildir(SYNC_STATE.SYNCING)
      try {
        // Step 2: subkeys.
        const subkeys = await getSubkeys()
        if (!subkeys?.dataEncryptionKey || !subkeys?.hmacIdKey) {
          throw new Error('sync_subkeys_invalid')
        }

        const gonderim = await gonderBekleyenler(uid, subkeys)
        const cekim = await cekUzakDegisiklikler(uid, subkeys)
        const ozet = {
          pushed: gonderim.pushed,
          batches: gonderim.batches,
          pulled: cekim.pulled,
          applied: cekim.applied,
          quarantined: cekim.quarantined,
          at: now(),
        }
        sonCevrim = ozet
        bildir(SYNC_STATE.IDLE, ozet)
        return ozet
      } catch (error) {
        bildir(SYNC_STATE.ERROR, { message: error?.message || 'sync_failed' })
        throw error
      } finally {
        await releaseLease(db, metaStore, SYNC_LEASE_NAME, deviceId)
      }
    } finally {
      calisiyor = false
    }
  }

  /** Repeats the cycle until the queue is empty. */
  async function drain({ maxRounds = 20 } = {}) {
    let toplam = { pushed: 0, pulled: 0, applied: 0, rounds: 0 }
    for (let tur = 0; tur < maxRounds; tur += 1) {
      const sonuc = await runOnce()
      if (sonuc?.skipped) return { ...toplam, skipped: sonuc.skipped }
      toplam = {
        pushed: toplam.pushed + (sonuc.pushed || 0),
        pulled: toplam.pulled + (sonuc.pulled || 0),
        applied: toplam.applied + (sonuc.applied || 0),
        rounds: toplam.rounds + 1,
      }
      const bekleyen = await pendingCount()
      if (bekleyen === 0) break
    }
    return toplam
  }

  return {
    enqueue,
    runOnce,
    drain,
    pendingCount,
    getStatus,
    readCursor,
    writeCursor,
  }
}

/** Introduction of the sync engine (tests and documentation). */
export function describeSyncEngine() {
  return {
    leaseName: SYNC_LEASE_NAME,
    leaseTtlMs: LEASE_TTL_MS,
    batchSize: SYNC_BATCH_SIZE,
    pullLimit: SYNC_PULL_LIMIT,
    states: Object.values(SYNC_STATE),
    steps: 9,
  }
}
