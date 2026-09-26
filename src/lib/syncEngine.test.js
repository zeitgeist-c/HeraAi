/**
 * HeraAi 1.10.0 — Eşitleme motoru testleri (Aşama 7).
 *
 * Gerçek Web Crypto ve `fake-indexeddb` kullanılır; ağ katmanı taklit edilir.
 * Kapsam: kuyruk birleştirme, kilit davranışı, gönderim/çekim çevrimi,
 * tombstone, AAD doğrulaması, sürüm karşılaştırması, imleç ilerlemesi.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DB_NAMES,
  LEASE_TTL_MS,
  VAULT_STORES,
  VAULT_VERSION,
  acquireLease,
  idbClear,
  idbGetAll,
  idbPut,
  openDatabase,
  readLease,
} from './idb'
import {
  QUEUE_OP,
  SYNC_BATCH_SIZE,
  SYNC_LEASE_NAME,
  SYNC_SKIP,
  SYNC_STATE,
  coalesceQueue,
  createSyncEngine,
  describeSyncEngine,
  queueId,
} from './syncEngine'
import {
  buildAad,
  deriveSubkeys,
  encryptJson,
  generateMasterSecretBytes,
  importMasterSecret,
} from './syncCrypto'
import { deriveOpaqueId } from './syncModel'

const CIHAZ = 'cihaz-a'
const UID = 'kullanici-1'

let db
let subkeys
let uid
let online
let transport
let payloads
let uygulananlar

/** Test kuyruğuna yazılan yükleri tutan basit depo. */
function yukKoy(storageKey, logicalId, deger) {
  payloads.set(`${storageKey}::${logicalId}`, deger)
}

function motorKur(ek = {}) {
  return createSyncEngine({
    db,
    deviceId: CIHAZ,
    getUid: () => uid,
    getSubkeys: async () => subkeys,
    readPayload: async (storageKey, logicalId) => payloads.get(`${storageKey}::${logicalId}`) ?? null,
    applyRemote: async change => {
      uygulananlar.push(change)
      return true
    },
    readLocalVersion: async () => null,
    transport,
    isOnline: () => online,
    ...ek,
  })
}

async function surum(wallTimeMs, logicalCounter = 0) {
  return { wallTimeMs, logicalCounter, deviceId: CIHAZ }
}

beforeEach(async () => {
  db = await openDatabase({
    name: DB_NAMES.vault,
    version: VAULT_VERSION,
    stores: Object.values(VAULT_STORES),
  })
  await idbClear(db, VAULT_STORES.syncQueue)
  await idbClear(db, VAULT_STORES.meta)
  await idbClear(db, VAULT_STORES.keys)

  const master = await importMasterSecret(generateMasterSecretBytes())
  subkeys = await deriveSubkeys(master)

  uid = UID
  online = true
  payloads = new Map()
  uygulananlar = []
  transport = {
    pushEntities: vi.fn(async () => ({ ok: true })),
    pullEntities: vi.fn(async () => ({ documents: [], cursor: null })),
  }
})

describe('kuyruk birleştirme', () => {
  it('çekme imlecinin nanosaniye hassasiyetini korur', async () => {
    const engine = motorKur()
    const cursor = { serverUpdatedAt: 5000.123456, opaqueEntityId: 'a', serverTimestampSeconds: 5, serverTimestampNanoseconds: 123456 }
    await engine.writeCursor(cursor)
    expect(await engine.readCursor()).toEqual(cursor)
    await engine.runOnce()
    expect(transport.pullEntities).toHaveBeenCalledWith(expect.objectContaining({ cursor }))
  })

  it('gönderim sırasında eklenen yeni değişikliği kuyruktan silmez', async () => {
    const engine = motorKur()
    yukKoy('sessions', 'race', { id: 'race', title: 'first' })
    await engine.enqueue({ storageKey: 'sessions', logicalId: 'race', entityVersion: await surum(100) })
    transport.pushEntities.mockImplementationOnce(async () => {
      yukKoy('sessions', 'race', { id: 'race', title: 'second' })
      await engine.enqueue({ storageKey: 'sessions', logicalId: 'race', entityVersion: await surum(200) })
      return { ok: true }
    })
    await engine.runOnce()
    expect(await engine.pendingCount()).toBe(1)
    await engine.runOnce()
    expect(await engine.pendingCount()).toBe(0)
    expect(transport.pushEntities).toHaveBeenCalledTimes(2)
  })

  it('kuyruk kimliği depolama anahtarı ve mantıksal kimlikten türetilir', () => {
    expect(queueId('sessions', 'abc')).toBe('sessions::abc')
    expect(queueId('geminiApiKeys', 'k1')).toBe('geminiApiKeys::k1')
  })

  it('aynı varlık için yalnız en yeni sürümü bırakır', () => {
    const kayitlar = [
      { id: 'sessions::a', entityVersion: { wallTimeMs: 100, logicalCounter: 0, deviceId: 'x' } },
      { id: 'sessions::a', entityVersion: { wallTimeMs: 200, logicalCounter: 0, deviceId: 'x' } },
      { id: 'sessions::a', entityVersion: { wallTimeMs: 150, logicalCounter: 0, deviceId: 'x' } },
    ]
    const sonuc = coalesceQueue(kayitlar)
    expect(sonuc).toHaveLength(1)
    expect(sonuc[0].entityVersion.wallTimeMs).toBe(200)
  })

  it('eşit sürümde silme kaydı kazanır', () => {
    const surum = { wallTimeMs: 500, logicalCounter: 0, deviceId: 'x' }
    const sonuc = coalesceQueue([
      { id: 'geminiApiKeys::k1', op: QUEUE_OP.PUT, entityVersion: surum },
      { id: 'geminiApiKeys::k1', op: QUEUE_OP.DELETE, entityVersion: surum },
    ])
    expect(sonuc).toHaveLength(1)
    expect(sonuc[0].op).toBe(QUEUE_OP.DELETE)
  })

  it('farklı varlıkları ayrı tutar ve bozuk kaydı atlar', () => {
    const sonuc = coalesceQueue([
      { id: 'sessions::a', entityVersion: { wallTimeMs: 1, logicalCounter: 0, deviceId: 'x' } },
      { id: 'sessions::b', entityVersion: { wallTimeMs: 1, logicalCounter: 0, deviceId: 'x' } },
      { entityVersion: { wallTimeMs: 1, logicalCounter: 0, deviceId: 'x' } },
    ])
    expect(sonuc).toHaveLength(2)
  })
})

describe('motor kurulumu', () => {
  it('zorunlu bağımlılıklar eksikse açık hata verir', () => {
    expect(() => createSyncEngine({})).toThrow('sync_db_missing')
    expect(() => createSyncEngine({ db })).toThrow('sync_device_missing')
    expect(() =>
      createSyncEngine({ db, deviceId: CIHAZ, getSubkeys: async () => subkeys }),
    ).toThrow('sync_uid_reader_missing')
    expect(() =>
      createSyncEngine({
        db,
        deviceId: CIHAZ,
        getUid: () => UID,
        getSubkeys: async () => subkeys,
        readPayload: async () => null,
        applyRemote: async () => true,
      }),
    ).toThrow('sync_transport_missing')
  })

  it('katalog bilgisi plan değerleriyle uyuşur', () => {
    const katalog = describeSyncEngine()
    expect(katalog.leaseTtlMs).toBe(60000)
    expect(katalog.batchSize).toBe(SYNC_BATCH_SIZE)
    expect(katalog.states).toContain(SYNC_STATE.SYNCING)
    expect(katalog.steps).toBe(9)
  })
})

describe('kuyruğa ekleme', () => {
  it('kaydı yazar ve bekleyen sayısını bildirir', async () => {
    const motor = motorKur()
    await motor.enqueue({
      storageKey: 'sessions',
      logicalId: 'sohbet-1',
      entityVersion: await surum(1000),
    })
    await motor.enqueue({
      storageKey: 'sessions',
      logicalId: 'sohbet-1',
      entityVersion: await surum(2000),
    })

    const ham = await idbGetAll(db, VAULT_STORES.syncQueue)
    // Aynı varlık tek satırda tutulur: ikinci kayıt birincinin üzerine yazar.
    expect(ham).toHaveLength(1)
    expect(ham[0].entityVersion.wallTimeMs).toBe(2000)
    expect(await motor.pendingCount()).toBe(1)
  })

  it('bilinmeyen depolama anahtarını reddeder', async () => {
    const motor = motorKur()
    await expect(
      motor.enqueue({ storageKey: 'bilinmeyenAlan', logicalId: 'x', entityVersion: await surum(1) }),
    ).rejects.toThrow('sync_entity_type_unknown')
  })

  it('sürüm olmadan kaydı reddeder', async () => {
    const motor = motorKur()
    await expect(motor.enqueue({ storageKey: 'sessions', logicalId: 'x' })).rejects.toThrow(
      'sync_version_missing',
    )
  })
})

describe('çevrim öncesi denetimler', () => {
  it('oturum yoksa signed_out döner ve kilit almaz', async () => {
    uid = null
    const motor = motorKur()
    const sonuc = await motor.runOnce()
    expect(sonuc.skipped).toBe(SYNC_SKIP.SIGNED_OUT)
    expect(motor.getStatus().state).toBe(SYNC_STATE.SIGNED_OUT)
    expect(transport.pushEntities).not.toHaveBeenCalled()
  })

  it('çevrimdışıysa offline döner', async () => {
    online = false
    const motor = motorKur()
    const sonuc = await motor.runOnce()
    expect(sonuc.skipped).toBe(SYNC_SKIP.OFFLINE)
    expect(motor.getStatus().state).toBe(SYNC_STATE.OFFLINE)
  })

  it('kilit başka sahipteyse lease_held döner', async () => {
    await acquireLease(db, VAULT_STORES.meta, SYNC_LEASE_NAME, { owner: 'cihaz-b' })
    const motor = motorKur()
    const sonuc = await motor.runOnce()
    expect(sonuc.skipped).toBe(SYNC_SKIP.LEASE_HELD)
    expect(motor.getStatus().state).toBe(SYNC_STATE.LOCKED)
  })

  it('kilit TTL dolduysa devralır', async () => {
    await acquireLease(db, VAULT_STORES.meta, SYNC_LEASE_NAME, {
      owner: 'cihaz-b',
      now: Date.now() - LEASE_TTL_MS - 1000,
      ttlMs: LEASE_TTL_MS,
    })
    const motor = motorKur()
    const sonuc = await motor.runOnce()
    expect(sonuc.skipped).toBeUndefined()
    expect(sonuc.pushed).toBe(0)
  })

  it('aynı anda ikinci çevrimi başlatmaz', async () => {
    let cozumle
    transport.pullEntities.mockImplementation(
      () =>
        new Promise(resolve => {
          cozumle = () => resolve({ documents: [], cursor: null })
        }),
    )
    const motor = motorKur()
    const ilk = motor.runOnce()
    // İlk çevrim çekim adımına ulaşana kadar bekle.
    await vi.waitFor(() => expect(cozumle).toBeTypeOf('function'))
    const ikinci = await motor.runOnce()
    expect(ikinci.skipped).toBe(SYNC_SKIP.IN_PROGRESS)
    cozumle()
    await ilk
  })

  it('çevrim sonunda kilidi bırakır', async () => {
    const motor = motorKur()
    await motor.runOnce()
    const kilit = await readLease(db, VAULT_STORES.meta, SYNC_LEASE_NAME)
    expect(kilit).toBeNull()
  })
})

describe('gönderim', () => {
  it('bekleyen kaydı şifreleyip gönderir ve kuyruktan siler', async () => {
    const motor = motorKur()
    yukKoy('sessions', 'sohbet-1', { id: 'sohbet-1', title: 'Gizli başlık' })
    await motor.enqueue({
      storageKey: 'sessions',
      logicalId: 'sohbet-1',
      entityVersion: await surum(1000),
    })

    const sonuc = await motor.runOnce()
    expect(sonuc.pushed).toBe(1)
    expect(transport.pushEntities).toHaveBeenCalledTimes(1)

    const cagri = transport.pushEntities.mock.calls[0][0]
    expect(cagri.uid).toBe(UID)
    expect(cagri.documents).toHaveLength(1)

    const belge = cagri.documents[0]
    expect(belge.document.entityType).toBe('session')
    expect(belge.document.deleted).toBe(false)
    expect(belge.document.ownerUid).toBe(UID)
    expect(belge.document.ciphertext).toBeTruthy()
    // Ham başlık buluta düz gitmez.
    expect(JSON.stringify(belge.document)).not.toContain('Gizli başlık')

    expect(await motor.pendingCount()).toBe(0)
  })

  it('opak kimlik deterministiktir', async () => {
    const motor = motorKur()
    yukKoy('sessions', 'sohbet-1', { id: 'sohbet-1' })
    await motor.enqueue({
      storageKey: 'sessions',
      logicalId: 'sohbet-1',
      entityVersion: await surum(1000),
    })
    await motor.runOnce()

    const beklenen = await deriveOpaqueId(subkeys.hmacIdKey, 'session', 'sohbet-1')
    expect(transport.pushEntities.mock.calls[0][0].documents[0].opaqueEntityId).toBe(beklenen)
  })

  it('silme kaydını ayni varlik turunde tombstone bayragiyla gönderir', async () => {
    const motor = motorKur()
    await motor.enqueue({
      storageKey: 'sessions',
      logicalId: 'sohbet-2',
      op: QUEUE_OP.DELETE,
      entityVersion: await surum(2000),
    })

    const sonuc = await motor.runOnce()
    expect(sonuc.pushed).toBe(1)
    const belge = transport.pushEntities.mock.calls[0][0].documents[0]
    expect(belge.document.entityType).toBe('session')
    expect(belge.document.deleted).toBe(true)
  })

  it('yerel kaydı bu arada silinmişse gönderimi atlar ama kuyruğu temizler', async () => {
    const motor = motorKur()
    await motor.enqueue({
      storageKey: 'sessions',
      logicalId: 'yok-olan',
      entityVersion: await surum(1000),
    })
    const sonuc = await motor.runOnce()
    expect(sonuc.pushed).toBe(0)
    expect(transport.pushEntities).not.toHaveBeenCalled()
    expect(await motor.pendingCount()).toBe(0)
  })

  it('batch sınırını aşan kuyruğu böler', async () => {
    const motor = motorKur({ batchSize: 2 })
    for (let i = 0; i < 5; i += 1) {
      yukKoy('sessions', `s${i}`, { id: `s${i}` })
      await motor.enqueue({
        storageKey: 'sessions',
        logicalId: `s${i}`,
        entityVersion: await surum(1000 + i),
      })
    }
    const sonuc = await motor.runOnce()
    expect(sonuc.pushed).toBe(5)
    expect(sonuc.batches).toBe(3)
    expect(transport.pushEntities).toHaveBeenCalledTimes(3)
  })

  it('700 KiB sinirini asan sohbeti ayri sifreli parcalara boler', async () => {
    transport.setEntityChunks = vi.fn(async () => undefined)
    transport.deleteStaleEntityChunks = vi.fn(async () => 0)
    transport.pushEntities.mockImplementation(async ({ documents }) => ({
      applied: documents.map(item => item.opaqueEntityId),
    }))
    const motor = motorKur()
    yukKoy('sessions', 'buyuk-sohbet', { id: 'buyuk-sohbet', content: 'x'.repeat(800000) })
    await motor.enqueue({
      storageKey: 'sessions',
      logicalId: 'buyuk-sohbet',
      entityVersion: await surum(1000),
    })

    const sonuc = await motor.runOnce()
    const chunkCall = transport.setEntityChunks.mock.calls[0]
    const manifest = transport.pushEntities.mock.calls[0][0].documents[0].document
    expect(sonuc.pushed).toBe(1)
    expect(chunkCall[3].length).toBeGreaterThan(1)
    expect(manifest.chunkCount).toBe(chunkCall[3].length)
    expect(manifest.chunkRevision).toBe(chunkCall[2])
    expect(manifest).not.toHaveProperty('ciphertext')
    expect(manifest).not.toHaveProperty('nonce')
  })

  it('parcali sohbeti eksiksiz yeniden birlestirip uygular', async () => {
    let manifest
    let chunks
    transport.setEntityChunks = vi.fn(async (_uid, _opaque, _revision, value) => { chunks = value })
    transport.deleteStaleEntityChunks = vi.fn(async () => 0)
    transport.pushEntities.mockImplementation(async ({ documents }) => {
      manifest = { ...documents[0].document, opaqueEntityId: documents[0].opaqueEntityId }
      return { applied: [documents[0].opaqueEntityId] }
    })
    const sender = motorKur()
    yukKoy('sessions', 'buyuk-tur', { id: 'buyuk-tur', content: 'ö'.repeat(500000) })
    await sender.enqueue({
      storageKey: 'sessions',
      logicalId: 'buyuk-tur',
      entityVersion: await surum(2000),
    })
    await sender.runOnce()

    uygulananlar = []
    transport.getEntityChunks = vi.fn(async () => chunks)
    transport.pullEntities.mockResolvedValueOnce({
      documents: [{ ...manifest, serverUpdatedAt: 3000 }],
      cursor: null,
    })
    const receiver = motorKur()
    const sonuc = await receiver.runOnce()
    expect(sonuc.applied).toBe(1)
    expect(uygulananlar[0].payload.content).toHaveLength(500000)
  })

  it('daha yeni uzak surum kazandiginda yuklenen gecici parcalari temizler', async () => {
    transport.setEntityChunks = vi.fn(async () => undefined)
    transport.deleteEntityChunksRevision = vi.fn(async () => 2)
    transport.deleteStaleEntityChunks = vi.fn(async () => 0)
    transport.pushEntities.mockResolvedValueOnce({ applied: [] })
    const motor = motorKur()
    yukKoy('sessions', 'conflict', { id: 'conflict', content: 'x'.repeat(800000) })
    await motor.enqueue({
      storageKey: 'sessions',
      logicalId: 'conflict',
      entityVersion: await surum(1000),
    })

    await motor.runOnce()
    expect(transport.deleteEntityChunksRevision).toHaveBeenCalledTimes(1)
    expect(transport.deleteStaleEntityChunks).not.toHaveBeenCalled()
  })
})

describe('çekim ve uygulama', () => {
  it('uzak kaydı çözüp uygular ve imleci ilerletir', async () => {
    const motor = motorKur()
    const opaque = await deriveOpaqueId(subkeys.hmacIdKey, 'session', 'uzak-1')
    const aad = buildAad({ ownerUid: UID, opaqueEntityId: opaque, entityType: 'session' })
    const zarf = await encryptJson(subkeys.dataEncryptionKey, { id: 'uzak-1', title: 'Uzak' }, aad)

    transport.pullEntities.mockResolvedValueOnce({
      documents: [
        {
          schemaVersion: 1,
          opaqueEntityId: opaque,
          entityType: 'session',
          entityVersion: { wallTimeMs: 3000, logicalCounter: 0, deviceId: 'cihaz-b' },
          nonce: zarf.nonce,
          ciphertext: zarf.ciphertext,
          deleted: false,
          serverUpdatedAt: 5000,
        },
      ],
      cursor: null,
    })

    const sonuc = await motor.runOnce()
    expect(sonuc.pulled).toBe(1)
    expect(sonuc.applied).toBe(1)
    expect(uygulananlar).toHaveLength(1)
    expect(uygulananlar[0].payload.title).toBe('Uzak')
    expect(uygulananlar[0].deleted).toBe(false)

    const imlec = await motor.readCursor()
    expect(imlec.serverUpdatedAt).toBe(5000)
  })

  it('AAD uyuşmayan kaydı uygulamaz', async () => {
    const motor = motorKur()
    const opaque = await deriveOpaqueId(subkeys.hmacIdKey, 'session', 'uzak-2')
    // AAD başka bir kimlikle üretildi: çözme başarısız olmalı.
    const yanlisAad = buildAad({
      ownerUid: UID,
      opaqueEntityId: 'baska-kimlik',
      entityType: 'session',
    })
    const zarf = await encryptJson(subkeys.dataEncryptionKey, { id: 'uzak-2' }, yanlisAad)

    transport.pullEntities.mockResolvedValueOnce({
      documents: [
        {
          schemaVersion: 1,
          opaqueEntityId: opaque,
          entityType: 'session',
          entityVersion: { wallTimeMs: 3000, logicalCounter: 0, deviceId: 'cihaz-b' },
          nonce: zarf.nonce,
          ciphertext: zarf.ciphertext,
          deleted: false,
          serverUpdatedAt: 6000,
        },
      ],
      cursor: null,
    })

    await expect(motor.runOnce()).rejects.toThrow('sync_payload_invalid')
    expect(uygulananlar).toHaveLength(0)
    // Bozuk kayıt açık hata verir ve çekim imlecini ilerletmez.
    const imlec = await motor.readCursor()
    expect(imlec).toBeNull()
  })

  it('üst üste başarısız olan belgeyi sessizce atlamaz', async () => {
    const motor = motorKur()
    const opaque = await deriveOpaqueId(subkeys.hmacIdKey, 'session', 'bozuk-karantina')
    const yanlisAad = buildAad({
      ownerUid: UID,
      opaqueEntityId: 'baska-kimlik',
      entityType: 'session',
    })
    const zarf = await encryptJson(subkeys.dataEncryptionKey, { id: 'bozuk-karantina' }, yanlisAad)
    transport.pullEntities.mockResolvedValue({
      documents: [
        {
          schemaVersion: 1,
          opaqueEntityId: opaque,
          entityType: 'session',
          entityVersion: { wallTimeMs: 3000, logicalCounter: 0, deviceId: 'cihaz-b' },
          nonce: zarf.nonce,
          ciphertext: zarf.ciphertext,
          deleted: false,
          serverUpdatedAt: 7000,
        },
      ],
      cursor: null,
    })

    await expect(motor.runOnce()).rejects.toThrow('sync_payload_invalid')
    await expect(motor.runOnce()).rejects.toThrow('sync_payload_invalid')
    await expect(motor.runOnce()).rejects.toThrow('sync_payload_invalid')
    const imlec = await motor.readCursor()
    expect(imlec).toBeNull()
    expect(uygulananlar).toHaveLength(0)
  })

  it('yerelde daha yeni sürüm varsa uzak kaydı uygulamaz', async () => {
    const motor = motorKur({
      readLocalVersion: async () => ({ wallTimeMs: 9000, logicalCounter: 0, deviceId: CIHAZ }),
    })
    const opaque = await deriveOpaqueId(subkeys.hmacIdKey, 'session', 'uzak-3')
    const aad = buildAad({ ownerUid: UID, opaqueEntityId: opaque, entityType: 'session' })
    const zarf = await encryptJson(subkeys.dataEncryptionKey, { id: 'uzak-3' }, aad)

    transport.pullEntities.mockResolvedValueOnce({
      documents: [
        {
          schemaVersion: 1,
          opaqueEntityId: opaque,
          entityType: 'session',
          entityVersion: { wallTimeMs: 1000, logicalCounter: 0, deviceId: 'cihaz-b' },
          nonce: zarf.nonce,
          ciphertext: zarf.ciphertext,
          deleted: false,
          serverUpdatedAt: 7000,
        },
      ],
      cursor: null,
    })

    const sonuc = await motor.runOnce()
    expect(sonuc.applied).toBe(0)
    expect(uygulananlar).toHaveLength(0)
  })

  it('tombstone kaydını silme olarak iletir', async () => {
    const motor = motorKur()
    const opaque = await deriveOpaqueId(subkeys.hmacIdKey, 'session', 'uzak-4')
    const aad = buildAad({ ownerUid: UID, opaqueEntityId: opaque, entityType: 'tombstone' })
    const zarf = await encryptJson(subkeys.dataEncryptionKey, { deleted: true }, aad)

    transport.pullEntities.mockResolvedValueOnce({
      documents: [
        {
          schemaVersion: 1,
          opaqueEntityId: opaque,
          entityType: 'tombstone',
          entityVersion: { wallTimeMs: 8000, logicalCounter: 0, deviceId: 'cihaz-b' },
          nonce: zarf.nonce,
          ciphertext: zarf.ciphertext,
          deleted: true,
          serverUpdatedAt: 9000,
        },
      ],
      cursor: null,
    })

    const sonuc = await motor.runOnce()
    expect(sonuc.applied).toBe(1)
    expect(uygulananlar[0].deleted).toBe(true)
  })

  it('birden çok sayfayı imleçle takip eder', async () => {
    const motor = motorKur({ pullLimit: 1 })
    const sayfa = async (sira, serverUpdatedAt) => {
      const opaque = await deriveOpaqueId(subkeys.hmacIdKey, 'session', `sayfa-${sira}`)
      const aad = buildAad({ ownerUid: UID, opaqueEntityId: opaque, entityType: 'session' })
      const zarf = await encryptJson(subkeys.dataEncryptionKey, { id: `sayfa-${sira}` }, aad)
      return {
        schemaVersion: 1,
        opaqueEntityId: opaque,
        entityType: 'session',
        entityVersion: { wallTimeMs: 1000 + sira, logicalCounter: 0, deviceId: 'cihaz-b' },
        nonce: zarf.nonce,
        ciphertext: zarf.ciphertext,
        deleted: false,
        serverUpdatedAt,
      }
    }
    transport.pullEntities
      .mockResolvedValueOnce({ documents: [await sayfa(1, 100)], cursor: null })
      .mockResolvedValueOnce({ documents: [await sayfa(2, 200)], cursor: null })
      .mockResolvedValueOnce({ documents: [], cursor: null })

    const sonuc = await motor.runOnce()
    expect(sonuc.pulled).toBe(2)
    expect(sonuc.applied).toBe(2)
    expect(transport.pullEntities).toHaveBeenCalledTimes(3)
    expect((await motor.readCursor()).serverUpdatedAt).toBe(200)
  })

  it('eksik parcada yerel veriyi ve imleci degistirmez', async () => {
    const motor = motorKur()
    transport.getEntityChunks = vi.fn(async () => [{ index: 0, nonce: 'x', ciphertext: 'y' }])
    transport.pullEntities.mockResolvedValueOnce({
      documents: [{
        schemaVersion: 1,
        opaqueEntityId: 'chunked',
        entityType: 'session',
        entityVersion: { wallTimeMs: 1, logicalCounter: 0, deviceId: 'b' },
        chunkCount: 2,
        chunkRevision: 'rev-1',
        serverUpdatedAt: 6000,
      }],
      cursor: null,
    })
    await expect(motor.runOnce()).rejects.toThrow('sync_chunk_incomplete')
    expect(uygulananlar).toHaveLength(0)
    expect(await motor.readCursor()).toBeNull()
  })

  it('bilinmeyen sema surumunde yazma ve imlec ilerlemesi yapmaz', async () => {
    const motor = motorKur()
    transport.pullEntities.mockResolvedValueOnce({
      documents: [{
        schemaVersion: 99,
        opaqueEntityId: 'future',
        entityType: 'session',
        entityVersion: { wallTimeMs: 1, logicalCounter: 0, deviceId: 'b' },
        nonce: 'x',
        ciphertext: 'y',
        serverUpdatedAt: 7000,
      }],
      cursor: null,
    })
    await expect(motor.runOnce()).rejects.toThrow('sync_version_unsupported')
    expect(uygulananlar).toHaveLength(0)
    expect(await motor.readCursor()).toBeNull()
  })
})

describe('drain', () => {
  it('kuyruk boşalana kadar çevrimi yineler', async () => {
    const motor = motorKur()
    yukKoy('sessions', 'd1', { id: 'd1' })
    await motor.enqueue({
      storageKey: 'sessions',
      logicalId: 'd1',
      entityVersion: await surum(1000),
    })

    const sonuc = await motor.drain()
    expect(sonuc.pushed).toBe(1)
    expect(await motor.pendingCount()).toBe(0)
  })

  it('oturum yoksa turu bırakır', async () => {
    uid = null
    const motor = motorKur()
    const sonuc = await motor.drain()
    expect(sonuc.skipped).toBe(SYNC_SKIP.SIGNED_OUT)
  })
})

describe('imleç', () => {
  it('geçersiz imleci yok sayar', async () => {
    await idbPut(db, VAULT_STORES.meta, { id: 'syncPullCursor', serverUpdatedAt: 'abc' })
    const motor = motorKur()
    expect(await motor.readCursor()).toBeNull()
  })

  it('ileri gitmeyen imleci kaydetmez', async () => {
    const motor = motorKur()
    await motor.writeCursor({ serverUpdatedAt: 5000, opaqueEntityId: 'x' })
    const aad = buildAad({ ownerUid: UID, opaqueEntityId: 'y', entityType: 'session' })
    const zarf = await encryptJson(subkeys.dataEncryptionKey, { id: 'y' }, aad)
    transport.pullEntities.mockResolvedValueOnce({
      documents: [
        {
          schemaVersion: 1,
          opaqueEntityId: 'y',
          entityType: 'session',
          entityVersion: { wallTimeMs: 1, logicalCounter: 0, deviceId: 'b' },
          nonce: zarf.nonce,
          ciphertext: zarf.ciphertext,
          serverUpdatedAt: 4000,
        },
      ],
      cursor: null,
    })
    await motor.runOnce()
    const imlec = await motor.readCursor()
    expect(imlec.serverUpdatedAt).toBe(5000)
  })
})

describe('durum bildirimleri', () => {
  it('çevrim boyunca syncing ve idle bildirir', async () => {
    const durumlar = []
    const motor = motorKur({ onState: state => durumlar.push(state) })
    await motor.runOnce()
    expect(durumlar).toEqual([SYNC_STATE.SYNCING, SYNC_STATE.IDLE])
  })

  it('gönderim hatasında error bildirir ve kilidi bırakır', async () => {
    transport.pushEntities.mockRejectedValueOnce(new Error('ag_hatasi'))
    const durumlar = []
    const motor = motorKur({ onState: state => durumlar.push(state) })
    yukKoy('sessions', 'h1', { id: 'h1' })
    await motor.enqueue({
      storageKey: 'sessions',
      logicalId: 'h1',
      entityVersion: await surum(1000),
    })

    await expect(motor.runOnce()).rejects.toThrow('ag_hatasi')
    expect(durumlar).toContain(SYNC_STATE.ERROR)
    expect(await readLease(db, VAULT_STORES.meta, SYNC_LEASE_NAME)).toBeNull()
    // Gönderilemeyen kayıt kuyrukta kalır: veri kaybı yok.
    expect(await motor.pendingCount()).toBe(1)
  })
})
