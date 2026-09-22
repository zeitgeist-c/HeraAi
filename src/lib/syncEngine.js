/**
 * HeraAi 1.10.0 — Eşitleme motoru ve çevrimdışı kuyruk (Aşama 7).
 *
 * Yerel değişiklikleri kaybetmeden gönderen, uzak değişiklikleri güvenle alan
 * merkezi motor. Service Worker yaşam döngüsüne uyumludur: kilit (lease)
 * IndexedDB'de tutulur, worker sonlanırsa TTL dolunca işlem kendiliğinden
 * devam eder.
 *
 * Motor veri modelinden bağımsızdır: yükü nereden okuyacağı (`readPayload`),
 * yerel sürümü nasıl bulacağı (`readLocalVersion`) ve uzak değişikliği nasıl
 * uygulayacağı (`applyRemote`) dışarıdan verilir. Böylece aynı motor hem
 * ayarlar hem kasa hem sohbetler için çalışır.
 *
 * Çevrim adımları (plan §11):
 *  1. İnternet ve oturum durumu denetlenir.
 *  2. Cihaz anahtarı ile ana sır çözülür, alt anahtarlar belleğe alınır.
 *  3. Kuyruk okunur, aynı varlığa ait ardışık işlemler birleştirilir.
 *  4. Değişiklikler şifrelenir ve 500'lük batch'ler halinde gönderilir.
 *  5. Gönderilen kayıtlar kuyruktan temizlenir.
 *  6. Sunucu imlecinden sonraki yeni değişiklikler çekilir.
 *  7. İndirilen kayıtlar AAD doğrulaması ile çözülür.
 *  8. Deterministik sürüm karşılaştırması yapılarak yerel depoya uygulanır.
 *  9. Yeni imleç kaydedilir ve arayüze `SYNC_IDLE` bildirilir.
 */

import {
  LEASE_TTL_MS,
  VAULT_STORES,
  acquireLease,
  idbDeleteMany,
  idbGet,
  idbGetAll,
  idbPut,
  releaseLease,
} from './idb'
import {
  buildEntityDocument,
  buildRevisionId,
  compareEntityVersions,
  deriveOpaqueId,
  entityTypeForStorageKey,
  isIncomingNewer,
  parseEntityVersion,
  shouldWriteRevision,
} from './syncModel'
import { buildAad, decryptJson, encryptJson } from './syncCrypto'

/** Kilit adı; tek eşitleme çevrimi aynı anda yalnız bir bağlamda çalışır. */
export const SYNC_LEASE_NAME = 'sync'

/** Firestore batch sınırı. */
export const SYNC_BATCH_SIZE = 500

/** Tek çekimde alınacak en fazla belge. */
export const SYNC_PULL_LIMIT = 200

/** Kuyruk kaydı türleri. */
export const QUEUE_OP = Object.freeze({ PUT: 'put', DELETE: 'delete' })

/** Arayüze bildirilen eşitleme durumları. */
export const SYNC_STATE = Object.freeze({
  IDLE: 'idle',
  SYNCING: 'syncing',
  SIGNED_OUT: 'signed_out',
  LOCKED: 'locked',
  OFFLINE: 'offline',
  ERROR: 'error',
})

/** Çevrim sonucu atlama nedenleri. */
export const SYNC_SKIP = Object.freeze({
  SIGNED_OUT: 'signed_out',
  LEASE_HELD: 'lease_held',
  IN_PROGRESS: 'in_progress',
  OFFLINE: 'offline',
})

/** Kuyruk kaydının deterministik kimliği: aynı varlık tek satırda birleşir. */
export function queueId(storageKey, logicalId) {
  return `${storageKey}::${logicalId}`
}

/**
 * Kuyruğu birleştirir: aynı varlık için yalnız en yeni işlem kalır.
 * Silme her zaman kazanır çünkü sürüm karşılaştırması silmeyi de kapsar;
 * eşit sürümde son yazılan kayıt geçerlidir.
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

/** İmleç: sunucudaki son görülen belgenin sıralama anahtarı. */
function normalizeCursor(raw) {
  if (!raw) return null
  const serverUpdatedAt = Number(raw.serverUpdatedAt)
  if (!Number.isFinite(serverUpdatedAt)) return null
  return {
    serverUpdatedAt,
    opaqueEntityId: typeof raw.opaqueEntityId === 'string' ? raw.opaqueEntityId : '',
  }
}

function cursorFromDocument(document) {
  if (!document) return null
  const serverUpdatedAt = Number(document.serverUpdatedAt)
  if (!Number.isFinite(serverUpdatedAt)) return null
  return {
    serverUpdatedAt,
    opaqueEntityId: typeof document.opaqueEntityId === 'string' ? document.opaqueEntityId : '',
  }
}

function ilerlemeVarMi(mevcut, yeni) {
  if (!yeni) return false
  if (!mevcut) return true
  if (yeni.serverUpdatedAt !== mevcut.serverUpdatedAt) {
    return yeni.serverUpdatedAt > mevcut.serverUpdatedAt
  }
  return yeni.opaqueEntityId > mevcut.opaqueEntityId
}

/**
 * Eşitleme motorunu kurar.
 *
 * @param {object} options
 * @param {IDBDatabase} options.db Kasa veritabanı.
 * @param {() => string|null} options.getUid Oturum sahibi; yoksa `null`.
 * @param {() => Promise<object>} options.getSubkeys Alt anahtarlar (dataEncryptionKey, hmacIdKey...).
 * @param {(storageKey: string, logicalId: string) => Promise<any>} options.readPayload Gönderilecek yük.
 * @param {(change: object) => Promise<boolean>} options.applyRemote Uzak değişikliği uygular.
 * @param {(entityType: string, opaqueEntityId: string) => Promise<object|null>} options.readLocalVersion Yerel sürüm.
 * @param {object} options.transport `pushEntities` ve `pullEntities`.
 * @param {() => boolean} [options.isOnline] Ağ durumu.
 * @param {(state: string, detail: object) => void} [options.onState] Durum bildirimi.
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
    } catch {
      // Durum dinleyicisi hata verirse eşitleme durmamalı.
    }
  }

  function getStatus() {
    return { state: durum, running: calisiyor, lastRun: sonCevrim }
  }

  /** Kuyruğa değişiklik ekler; aynı varlık için önceki kayıt güncellenir. */
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
    }
    await idbPut(db, queueStore, kayit)
    return kayit
  }

  /** Bekleyen kayıt sayısı (birleştirme sonrası). */
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

  /** Tek kuyruk kaydını şifreli bulut belgesine çevirir. */
  async function kaydiHazirla(uid, subkeys, kayit) {
    const opaqueEntityId = await deriveOpaqueId(subkeys.hmacIdKey, kayit.entityType, kayit.logicalId)
    const aad = buildAad({ ownerUid: uid, opaqueEntityId, entityType: kayit.entityType })
    const silme = kayit.op === QUEUE_OP.DELETE

    let yuk = null
    if (!silme) {
      yuk = await readPayload(kayit.storageKey, kayit.logicalId)
      // Kayıt artık yoksa (bu arada silinmişse) gönderim atlanır.
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
    const belge = buildEntityDocument({
      ...temel,
      entityType: kayit.entityType,
      deleted: silme,
    })

    // Mevcut bir varlığın güncellenmesinde önceki sürüm saklanır.
    const onceki = readLocalVersion
      ? await readLocalVersion(kayit.entityType, opaqueEntityId)
      : null
    const revizyon = shouldWriteRevision({ isInitialSync: !onceki })
      ? { id: buildRevisionId(kayit.entityVersion), document: belge }
      : null

    return { opaqueEntityId, document: belge, revision: revizyon }
  }

  /** Adım 3-5: kuyruğu boşaltır. */
  async function gonderBekleyenler(uid, subkeys) {
    const ham = await idbGetAll(db, queueStore)
    const kayitlar = coalesceQueue(ham)
    if (kayitlar.length === 0) return { pushed: 0, batches: 0 }

    let toplam = 0
    let parti = 0
    for (let i = 0; i < kayitlar.length; i += batchSize) {
      const dilim = kayitlar.slice(i, i + batchSize)
      const belgeler = []
      const revizyonlar = []
      const temizlenecek = []

      for (const kayit of dilim) {
        const hazir = await kaydiHazirla(uid, subkeys, kayit)
        temizlenecek.push(kayit.id)
        if (hazir?.skipped) continue
        belgeler.push({ opaqueEntityId: hazir.opaqueEntityId, document: hazir.document })
        if (hazir.revision) {
          revizyonlar.push({
            opaqueEntityId: hazir.opaqueEntityId,
            revisionId: hazir.revision.id,
            document: hazir.revision.document,
          })
        }
      }

      if (belgeler.length > 0) {
        await transport.pushEntities({ uid, documents: belgeler, revisions: revizyonlar })
        toplam += belgeler.length
        parti += 1
      }
      // Adım 5: gönderilen kayıtlar kuyruktan düşer.
      if (temizlenecek.length > 0) await idbDeleteMany(db, queueStore, temizlenecek)
    }
    return { pushed: toplam, batches: parti }
  }

  /** Adım 6-8: uzak değişiklikleri çeker ve uygular. */
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
        const sonuc = await uzakUygula(uid, subkeys, uzak)
        if (sonuc) uygulanan += 1
        const yeni = cursorFromDocument(uzak)
        if (ilerlemeVarMi(imlec, yeni)) imlec = yeni
      }

      if (belgeler.length < pullLimit) break
    }

    // Adım 9: imleç yalnızca ilerlediyse kaydedilir.
    if (ilerlemeVarMi(baslangic, imlec)) await writeCursor(imlec)
    return { pulled: cekilen, applied: uygulanan }
  }

  /** Adım 7-8: AAD doğrulaması, sürüm karşılaştırması, yerel uygulama. */
  async function uzakUygula(uid, subkeys, uzak) {
    if (!uzak?.opaqueEntityId || !uzak.ciphertext || !uzak.nonce) return false
    const entityType = uzak.entityType
    const aad = buildAad({ ownerUid: uid, opaqueEntityId: uzak.opaqueEntityId, entityType })
    let yuk
    try {
      yuk = await decryptJson(
        subkeys.dataEncryptionKey,
        { nonce: uzak.nonce, ciphertext: uzak.ciphertext },
        aad,
      )
    } catch {
      // AAD uyuşmazlığı veya bozuk kayıt: sessizce atlanır, imleç ilerler.
      return false
    }

    const uzakSurum = parseEntityVersion(uzak.entityVersion)
    if (!uzakSurum) return false

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

  /** Adım 1-9: tek eşitleme çevrimi. */
  async function runOnce() {
    if (calisiyor) return { skipped: SYNC_SKIP.IN_PROGRESS }
    calisiyor = true
    try {
      // Adım 1: oturum ve ağ denetimi.
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
        // Adım 2: alt anahtarlar.
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

  /** Kuyruk boşalana kadar çevrimi yineler. */
  async function drain({ maxRounds = 20 } = {}) {
    let toplam = { pushed: 0, applied: 0, rounds: 0 }
    for (let tur = 0; tur < maxRounds; tur += 1) {
      const sonuc = await runOnce()
      if (sonuc?.skipped) return { ...toplam, skipped: sonuc.skipped }
      toplam = {
        pushed: toplam.pushed + (sonuc.pushed || 0),
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

/** Eşitleme motorunun tanıtımı (test ve dokümantasyon). */
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
