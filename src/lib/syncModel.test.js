import { describe, expect, it } from 'vitest'

import {
  CLOUD_SCHEMA_VERSION,
  CRYPTO_VERSION,
  ENTITY_TYPES,
  REVISION_RETENTION_DAYS,
  backupDateKey,
  buildAccountRootDocument,
  buildDeviceDocument,
  buildEntityDocument,
  buildRevisionId,
  buildTombstoneDocument,
  cloudPaths,
  compareEntityVersions,
  createEntityVersion,
  deriveOpaqueId,
  describeCloudModel,
  entityTypeForStorageKey,
  isIncomingNewer,
  isRevisionExpired,
  opaqueNamespace,
  parseEntityVersion,
  serializeEntityVersion,
  shouldWriteRevision,
} from './syncModel'

const UID = 'uid_abc123'
const DEVICE_A = 'device-aaa'
const DEVICE_B = 'device-bbb'

async function makeHmacKey(material = 'test-hmac-material') {
  const bytes = new TextEncoder().encode(material)
  return globalThis.crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

describe('syncModel belge yollari', () => {
  it('koleksiyon yollari plan ile aynidir', () => {
    expect(cloudPaths.accountRoot(UID)).toBe(`users/${UID}/account/root`)
    expect(cloudPaths.device(UID, 'dev1')).toBe(`users/${UID}/devices/dev1`)
    expect(cloudPaths.entity(UID, 'op1')).toBe(`users/${UID}/entities/op1`)
    expect(cloudPaths.revision(UID, 'op1', 'rev1')).toBe(`users/${UID}/entities/op1/revisions/rev1`)
    expect(cloudPaths.blob(UID, 'bl1')).toBe(`users/${UID}/blobs/bl1`)
    expect(cloudPaths.blobChunk(UID, 'bl1', 3)).toBe(`users/${UID}/blobs/bl1/chunks/3`)
    expect(cloudPaths.backup(UID, '2026-09-21')).toBe(`users/${UID}/backups/2026-09-21`)
  })

  it('sozlesmedeki anahtarlar bulut varlik turune eslenir', () => {
    expect(entityTypeForStorageKey('theme')).toBe('setting')
    expect(entityTypeForStorageKey('comparisonModelKeys')).toBe('setting')
    expect(entityTypeForStorageKey('sessions')).toBe('session')
    expect(entityTypeForStorageKey('geminiApiKeys')).toBe('api_key')
    expect(entityTypeForStorageKey('ollamaApiKeys')).toBe('api_key')
    expect(entityTypeForStorageKey('stats')).toBe('stats_day')
  })

  it('esitlenmeyen anahtarlar buluta eslenmez', () => {
    expect(entityTypeForStorageKey('activeSessionId')).toBeNull()
    expect(entityTypeForStorageKey('activeGeneration')).toBeNull()
    expect(entityTypeForStorageKey('chatHistory')).toBeNull()
    expect(entityTypeForStorageKey('bilinmeyenAnahtar')).toBeNull()
  })

  it('varlik turleri plan listesiyle aynidir', () => {
    expect([...ENTITY_TYPES]).toEqual([
      'setting', 'session', 'message_batch', 'message', 'api_key', 'stats_day', 'tombstone',
    ])
  })
})

describe('syncModel opak kimlik', () => {
  it('ayni girdi icin deterministiktir', async () => {
    const key = await makeHmacKey()
    const first = await deriveOpaqueId(key, 'session', 'session_123')
    const second = await deriveOpaqueId(key, 'session', 'session_123')
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  it('farkli mantiksal kimlikler farkli opak kimlik uretir', async () => {
    const key = await makeHmacKey()
    const a = await deriveOpaqueId(key, 'session', 'session_123')
    const b = await deriveOpaqueId(key, 'session', 'session_124')
    const c = await deriveOpaqueId(key, 'api_key', 'session_123')
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })

  it('farkli anahtarlar ayni kimlik icin farkli opak kimlik uretir', async () => {
    const keyA = await makeHmacKey('material-a')
    const keyB = await makeHmacKey('material-b')
    const a = await deriveOpaqueId(keyA, 'session', 'session_123')
    const b = await deriveOpaqueId(keyB, 'session', 'session_123')
    expect(a).not.toBe(b)
  })

  it('opak kimlik mantiksal kimligi sizdirmaz', async () => {
    const key = await makeHmacKey()
    const opak = await deriveOpaqueId(key, 'session', 'gizli-sohbet-adi')
    expect(opak).not.toContain('gizli')
    expect(opak).not.toContain('session')
  })

  it('eski ek yolu yalniz temizlik uyumlulugu icin tanimlidir', () => {
    expect(cloudPaths.blob('u1', 'legacy-1')).toBe('users/u1/blobs/legacy-1')
    expect(cloudPaths.blobChunk('u1', 'legacy-1', 2)).toBe('users/u1/blobs/legacy-1/chunks/2')
  })

  it('eksik anahtar veya kimlikte hata verir', async () => {
    const key = await makeHmacKey()
    await expect(deriveOpaqueId(null, 'session', 'x')).rejects.toThrow('opaque_id_key_missing')
    await expect(deriveOpaqueId(key, 'bilinmeyen', 'x')).rejects.toThrow('opaque_id_type_invalid')
    await expect(deriveOpaqueId(key, 'session', '')).rejects.toThrow('opaque_id_logical_missing')
    expect(cloudPaths.blob('u1', 'legacy')).toContain('/blobs/')
  })

  it('ad alani bicimi tur:kimlik seklindedir', () => {
    expect(opaqueNamespace('session', 'abc')).toBe('session:abc')
  })
})

describe('syncModel surum damgasi', () => {
  it('sirali karsilastirma: duvar saati, sayac, cihaz kimligi', () => {
    const base = createEntityVersion({ wallTimeMs: 1000, logicalCounter: 0, deviceId: DEVICE_A })
    const newerTime = createEntityVersion({ wallTimeMs: 1001, logicalCounter: 0, deviceId: DEVICE_A })
    const newerCounter = createEntityVersion({ wallTimeMs: 1000, logicalCounter: 1, deviceId: DEVICE_A })
    const newerDevice = createEntityVersion({ wallTimeMs: 1000, logicalCounter: 0, deviceId: DEVICE_B })

    expect(compareEntityVersions(newerTime, base)).toBe(1)
    expect(compareEntityVersions(base, newerTime)).toBe(-1)
    expect(compareEntityVersions(newerCounter, base)).toBe(1)
    expect(compareEntityVersions(newerDevice, base)).toBe(1)
    expect(compareEntityVersions(base, base)).toBe(0)
    expect(compareEntityVersions(base, createEntityVersion({ wallTimeMs: 900, logicalCounter: 99, deviceId: DEVICE_B }))).toBe(1)
  })

  it('geri giden saatte bile deterministiktir', () => {
    const ileri = createEntityVersion({ wallTimeMs: 5000, logicalCounter: 0, deviceId: DEVICE_A })
    const geri = createEntityVersion({ wallTimeMs: 4000, logicalCounter: 0, deviceId: DEVICE_B })
    expect(compareEntityVersions(ileri, geri)).toBe(1)
    expect(compareEntityVersions(geri, ileri)).toBe(-1)
  })

  it('eksik ve bozuk girdileri reddeder', () => {
    expect(() => createEntityVersion({ wallTimeMs: NaN, deviceId: DEVICE_A })).toThrow('entity_version_time_invalid')
    expect(() => createEntityVersion({ wallTimeMs: 1 })).toThrow('entity_version_device_missing')
    expect(createEntityVersion({ wallTimeMs: 1, logicalCounter: -5, deviceId: DEVICE_A }).logicalCounter).toBe(0)
    expect(createEntityVersion({ wallTimeMs: 1, logicalCounter: 'yok', deviceId: DEVICE_A }).logicalCounter).toBe(0)
  })

  it('serilestirme ve ayristirma turu kaybetmez', () => {
    const version = createEntityVersion({ wallTimeMs: 1234, logicalCounter: 7, deviceId: DEVICE_A })
    const parsed = parseEntityVersion(serializeEntityVersion(version))
    expect(parsed).toEqual(version)
    expect(compareEntityVersions(parsed, version)).toBe(0)
  })

  it('bozuk ayristirma null doner', () => {
    expect(parseEntityVersion(null)).toBeNull()
    expect(parseEntityVersion({})).toBeNull()
    expect(parseEntityVersion({ wallTimeMs: 'x', deviceId: DEVICE_A })).toBeNull()
    expect(parseEntityVersion({ wallTimeMs: 5 })).toBeNull()
  })

  it('gelen surum yerelden yeni mi', () => {
    const local = createEntityVersion({ wallTimeMs: 1000, logicalCounter: 0, deviceId: DEVICE_A })
    const incoming = createEntityVersion({ wallTimeMs: 1001, logicalCounter: 0, deviceId: DEVICE_B })
    expect(isIncomingNewer(incoming, local)).toBe(true)
    expect(isIncomingNewer(local, incoming)).toBe(false)
    expect(isIncomingNewer(local, local)).toBe(false)
    expect(isIncomingNewer(local, null)).toBe(true)
  })
})

describe('syncModel belgeleri', () => {
  it('account/root yalniz teknik alanlar tasir', () => {
    const doc = buildAccountRootDocument({ createdAt: 111, recoveryEnvelope: { v: 1 }, keyRotationIndex: 2 })
    expect(Object.keys(doc).sort()).toEqual([
      'createdAt', 'cryptoVersion', 'keyRotationIndex', 'lastCleanupAt', 'recoveryEnvelope', 'schemaVersion',
    ])
    expect(doc.schemaVersion).toBe(CLOUD_SCHEMA_VERSION)
    expect(doc.cryptoVersion).toBe(CRYPTO_VERSION)
    expect(doc.keyRotationIndex).toBe(2)
  })

  it('devices belgesi cihaz zarfini ve iptal durumunu tasir', () => {
    const doc = buildDeviceDocument({
      deviceId: DEVICE_A,
      label: 'Brave - Windows',
      browser: 'Brave 153',
      platform: 'Windows 11',
      createdAt: 100,
      deviceMasterKeyEnvelope: { wrapped: 'x' },
    })
    expect(doc.deviceId).toBe(DEVICE_A)
    expect(doc.label).toBe('Brave - Windows')
    expect(doc.deviceMasterKeyEnvelope).toEqual({ wrapped: 'x' })
    expect(doc.revokedAt).toBeNull()
    expect(() => buildDeviceDocument({})).toThrow('device_id_missing')
  })

  it('entities belgesi sifreli zarfi ve acik teknik alanlari ayirir', () => {
    const version = createEntityVersion({ wallTimeMs: 2000, logicalCounter: 1, deviceId: DEVICE_A })
    const doc = buildEntityDocument({
      ownerUid: UID,
      entityType: 'session',
      entityVersion: version,
      sourceDeviceId: DEVICE_A,
      nonce: 'nonce123',
      ciphertext: 'abcdef',
    })
    expect(doc.ownerUid).toBe(UID)
    expect(doc.entityType).toBe('session')
    expect(doc.entityVersion).toEqual(serializeEntityVersion(version))
    expect(doc.nonce).toBe('nonce123')
    expect(doc.ciphertext).toBe('abcdef')
    expect(doc.ciphertextSize).toBe(6)
    expect(doc.deleted).toBe(false)
  })

  it('zorunlu alanlar olmadan belge uretmez', () => {
    const version = createEntityVersion({ wallTimeMs: 1, deviceId: DEVICE_A })
    expect(() => buildEntityDocument({ entityType: 'session', entityVersion: version })).toThrow('entity_owner_missing')
    expect(() => buildEntityDocument({ ownerUid: UID, entityVersion: version })).toThrow('entity_type_invalid')
    expect(() => buildEntityDocument({ ownerUid: UID, entityType: 'session' })).toThrow('entity_version_missing')
  })

  it('tombstone silinmis varlik olarak isaretlenir', () => {
    const version = createEntityVersion({ wallTimeMs: 3000, deviceId: DEVICE_A })
    const doc = buildTombstoneDocument({
      ownerUid: UID,
      entityVersion: version,
      sourceDeviceId: DEVICE_A,
      nonce: 'n',
      ciphertext: 'c',
    })
    expect(doc.entityType).toBe('tombstone')
    expect(doc.deleted).toBe(true)
  })

  it('belgelerde sohbet metni veya anahtar alani bulunmaz', () => {
    const version = createEntityVersion({ wallTimeMs: 4000, deviceId: DEVICE_A })
    const belgeler = [
      buildAccountRootDocument({ createdAt: 1 }),
      buildDeviceDocument({ deviceId: DEVICE_A, label: 'x', createdAt: 1 }),
      buildEntityDocument({
        ownerUid: UID, entityType: 'setting', entityVersion: version,
        sourceDeviceId: DEVICE_A, nonce: 'n', ciphertext: 'c',
      }),
    ]
    const yasakli = [
      'title', 'content', 'displayContent', 'messages', 'apiKey', 'key',
      'masked', 'email', 'systemInstruction', 'recoveryPhrase',
    ]
    for (const doc of belgeler) {
      for (const alan of yasakli) {
        expect(Object.keys(doc)).not.toContain(alan)
      }
    }
  })
})

describe('syncModel revizyon politikasi', () => {
  it('ilk aktarimda revizyon yazilmaz', () => {
    expect(shouldWriteRevision({ isInitialSync: true })).toBe(false)
    expect(shouldWriteRevision({ isInitialSync: false })).toBe(true)
    expect(shouldWriteRevision({})).toBe(true)
  })

  it('revizyon kimligi surumden deterministik uretilir', () => {
    const version = createEntityVersion({ wallTimeMs: 5000, logicalCounter: 2, deviceId: DEVICE_A })
    expect(buildRevisionId(version)).toBe(`5000-2-${DEVICE_A}`)
    expect(buildRevisionId(version)).toBe(buildRevisionId(version))
  })

  it('son yedi gun korunur, eskisi temizlenir', () => {
    const now = 1_000_000_000_000
    const gun = 24 * 60 * 60 * 1000
    expect(isRevisionExpired(now - 6 * gun, now)).toBe(false)
    expect(isRevisionExpired(now - 8 * gun, now)).toBe(true)
    expect(isRevisionExpired(now - 7 * gun - 1, now)).toBe(true)
    expect(isRevisionExpired('bozuk', now)).toBe(true)
    expect(REVISION_RETENTION_DAYS).toBe(7)
  })

  it('yedek tarih anahtari yerel gundur', () => {
    expect(backupDateKey(new Date(2026, 8, 21))).toBe('2026-09-21')
    expect(backupDateKey(new Date(2026, 0, 5))).toBe('2026-01-05')
  })

  it('model ozeti koleksiyonlari raporlar', () => {
    const ozet = describeCloudModel()
    expect(ozet.schemaVersion).toBe(CLOUD_SCHEMA_VERSION)
    expect(ozet.cryptoVersion).toBe(CRYPTO_VERSION)
    expect(ozet.entityTypes).toContain('tombstone')
    expect(ozet.collections).toContain('entities')
  })
})
