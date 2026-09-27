import { beforeAll, describe, expect, it, vi } from 'vitest'

const user = { uid: 'user-1', email: 'user@example.com' }
const cloud = {
  account: null,
  devices: new Map(),
}

const transport = {
  getAccountRoot: vi.fn(async () => cloud.account),
  setAccountRoot: vi.fn(async (_uid, value) => {
    cloud.account = { ...(cloud.account || {}), ...value }
  }),
  getDevice: vi.fn(async (_uid, deviceId) => cloud.devices.get(deviceId) || null),
  setDevice: vi.fn(async (_uid, deviceId, value) => {
    cloud.devices.set(deviceId, { ...(cloud.devices.get(deviceId) || {}), ...value })
  }),
  listDevices: vi.fn(async () => [...cloud.devices.values()]),
  pushEntities: vi.fn(async () => undefined),
  pullEntities: vi.fn(async () => ({ documents: [] })),
}

vi.mock('./authService', () => ({
  getCurrentAuthUser: () => user,
  waitForCurrentAuthUser: async () => user,
}))

vi.mock('./firestoreTransport', () => ({
  createFirestoreTransport: () => transport,
}))

import {
  currentUsage,
  exportEncryptedBackup,
  getAutoSyncSettings,
  getCloudSyncStatus,
  initializeCloudSync,
  installCloudSyncListeners,
  cloudSyncWakeReason,
  linkCloudSyncDevice,
  listCloudSyncDevices,
  mapCloudSyncError,
  nextPacificQuotaReset,
  pacificDayKey,
  regenerateCloudRecoveryCode,
  renameCloudSyncDevice,
  runCloudSync,
  setAutoSyncInterval,
  setCloudSyncDeviceEnabled,
} from './cloudSyncCoordinator'
import {
  buildAad,
  deriveSubkeys,
  encryptJson,
  importMasterSecret,
  openMasterSecretFromRecovery,
} from './syncCrypto'
import { buildEntityDocument, createEntityVersion, deriveOpaqueId } from './syncModel'
import { createKeyVault, loadOrCreateDeviceKey, openVaultDatabase } from './keyVault'

const storage = {}

beforeAll(() => {
  chrome.storage.local.get.mockImplementation((keys, callback) => {
    const result = {}
    for (const key of keys || []) {
      if (Object.prototype.hasOwnProperty.call(storage, key)) result[key] = storage[key]
    }
    callback?.(result)
    return Promise.resolve(result)
  })
  chrome.storage.local.set.mockImplementation((value, callback) => {
    Object.assign(storage, value)
    callback?.()
    return Promise.resolve()
  })
  chrome.storage.local.remove.mockImplementation((keys, callback) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key]
    callback?.()
    return Promise.resolve()
  })
})

describe('cloud recovery code regeneration', () => {
  it('creates a new code on a linked device and invalidates the previous code', async () => {
    const initial = await initializeCloudSync()
    const previousEnvelope = cloud.account.recoveryEnvelope
    await expect(openMasterSecretFromRecovery(previousEnvelope, initial.recoveryCode)).resolves.toBeTruthy()

    const replacement = await regenerateCloudRecoveryCode()

    expect(replacement.recoveryCode).not.toBe(initial.recoveryCode)
    expect(cloud.account.keyRotationIndex).toBe(1)
    await expect(
      openMasterSecretFromRecovery(cloud.account.recoveryEnvelope, replacement.recoveryCode),
    ).resolves.toBeTruthy()
    await expect(
      openMasterSecretFromRecovery(cloud.account.recoveryEnvelope, initial.recoveryCode),
    ).rejects.toThrow('recovery_code_invalid')
  })
})

describe('cloud sync error policy', () => {
  it.each([
    ['resource-exhausted', 'quota_exceeded'],
    ['permission-denied', 'rules_denied'],
    ['failed-precondition', 'sync_precondition_failed'],
    ['sync_recovery_required', 'sync_recovery_required'],
    ['unauthenticated', 'sync_signed_out'],
    ['unavailable', 'offline'],
    ['sync_chunk_incomplete', 'sync_chunk_incomplete'],
    ['unknown', 'sync_failed'],
  ])('%s hatasini %s koduna cevirir', (code, expected) => {
    expect(mapCloudSyncError({ code })).toBe(expected)
  })

  it('kota engelini sonraki Pasifik gununun saat 01:00 anina kurar', () => {
    const now = Date.parse('2026-09-22T12:07:30Z')
    const reset = nextPacificQuotaReset(now)
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(reset)).map(part => [part.type, part.value]))
    expect(parts.hour).toBe('01')
    expect(parts.minute).toBe('00')
    expect(reset).toBeGreaterThan(now)
  })

  it('panel uyanmasinda kapali esitlemeyi atlar', () => {
    expect(cloudSyncWakeReason({ syncEnabled: false }, 1_000_000)).toBe('disabled')
  })

  it('panel uyanmasinda duraklatilmis esitlemeyi atlar', () => {
    expect(cloudSyncWakeReason({ syncEnabled: true, syncPaused: true }, 1_000_000)).toBe('paused')
  })

  it('panel uyanmasinda kota engelini atlar', () => {
    expect(cloudSyncWakeReason({ syncEnabled: true, syncBlockedUntil: 2_000_000 }, 1_000_000))
      .toBe('quota_blocked')
  })

  it('panel uyanmasinda 15 dakika dolmadan esitlemez', () => {
    expect(cloudSyncWakeReason({ syncEnabled: true, syncLastSuccessAt: 500_001 }, 1_000_000))
      .toBe('recently_synced')
    expect(cloudSyncWakeReason({ syncEnabled: true, syncLastSuccessAt: 100_000 }, 1_000_000))
      .toBeNull()
  })

  it('Firestore kotasi doluyken Google oturumunu basarili tutar ve yerel engel kaydeder', async () => {
    delete storage.syncBlockedUntil
    transport.getAccountRoot.mockRejectedValueOnce(
      Object.assign(new Error('Quota exceeded.'), { code: 'resource-exhausted' }),
    )

    const status = await getCloudSyncStatus()

    expect(status.signedIn).toBe(true)
    expect(status.user).toEqual(user)
    expect(status.cloudUnavailable).toBe(true)
    expect(status.lastErrorCode).toBe('quota_exceeded')
    expect(status.state).toBe('quota_exceeded')
    expect(status.blockedUntil).toBeGreaterThan(Date.now())
    expect(storage.syncBlockedUntil).toBe(status.blockedUntil)
  })

  it('cihaz baglantisi okunurken kota dolarsa kurtarma ekrani yerine kota durumunu gosterir', async () => {
    delete storage.syncBlockedUntil
    transport.getAccountRoot.mockResolvedValueOnce(cloud.account)
    transport.getDevice.mockRejectedValueOnce(
      Object.assign(new Error('Quota exceeded.'), { code: 'resource-exhausted' }),
    )

    const status = await getCloudSyncStatus()

    expect(status.signedIn).toBe(true)
    expect(status.cloudUnavailable).toBe(true)
    expect(status.lastErrorCode).toBe('quota_exceeded')
    expect(status.state).toBe('quota_exceeded')
  })
})

describe('cihaz kapatma ve ad verme', () => {
  let deviceId = null

  beforeAll(async () => {
    cloud.account = null
    cloud.devices.clear()
    delete storage.syncDeviceId
    delete storage.syncBlockedUntil
    delete storage.syncPaused
    await initializeCloudSync()
    // getRuntime() modül düzeyinde önbellekli; cihaz kimliği depodan değil kayıttan okunur.
    deviceId = [...cloud.devices.keys()][0]
    cloud.devices.set(deviceId, { ...cloud.devices.get(deviceId), disabledAt: 1_700_000 })
  })

  it('kapatilmis cihazda durum bagli kalir ve kurtarma ekranina dusmez', async () => {
    const status = await getCloudSyncStatus()

    expect(status.linked).toBe(true)
    expect(status.deviceDisabled).toBe(true)
    expect(status.state).toBe('device_disabled')
  })

  it('kapatilmis cihazda esitleme hic calismaz', async () => {
    await expect(runCloudSync()).resolves.toEqual({ skipped: 'device_disabled' })
  })

  it('kapatilmis cihaz buluta yazan islemleri reddeder', async () => {
    await expect(exportEncryptedBackup()).rejects.toThrow('sync_device_disabled')
    await expect(regenerateCloudRecoveryCode()).rejects.toThrow('sync_device_disabled')
  })

  it('cihaz kapatilir ve yeniden acilir', async () => {
    await setCloudSyncDeviceEnabled('dev-2', false)
    expect(cloud.devices.get('dev-2').disabledAt).toBeGreaterThan(0)

    await setCloudSyncDeviceEnabled('dev-2', true)
    expect(cloud.devices.get('dev-2').disabledAt).toBeNull()
  })

  it('cihaz adini kirparak kaydeder ve bos adi reddeder', async () => {
    await expect(renameCloudSyncDevice('dev-2', '  Masaüstü PC  '))
      .resolves.toEqual({ deviceId: 'dev-2', label: 'Masaüstü PC' })
    expect(cloud.devices.get('dev-2').label).toBe('Masaüstü PC')

    await expect(renameCloudSyncDevice('dev-2', '   ')).rejects.toThrow('device_label_empty')
  })

  it('yeniden acilan cihazda esitleme yeniden calisir', async () => {
    await setCloudSyncDeviceEnabled(deviceId, true)

    const result = await runCloudSync()

    expect(result?.skipped).toBeUndefined()
  })

  it('atlanan esitleme turunu basarili saymaz ve bekleyen anahtar isaretlerini korur', async () => {
    storage.syncLastSuccessAt = 111
    storage.syncKeyTombstones = { 'anahtar-1': 5000 }
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true })

    try {
      const result = await runCloudSync()

      expect(result?.skipped).toBe('offline')
      expect(storage.syncLastSuccessAt).toBe(111)
      expect(storage.syncKeyTombstones).toEqual({ 'anahtar-1': 5000 })
    } finally {
      Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true })
    }
  })

  it('yeniden baglanma verilen adi korur ve cihazi acar', async () => {
    const { recoveryCode } = await regenerateCloudRecoveryCode()
    cloud.devices.set(deviceId, { ...cloud.devices.get(deviceId), label: 'Özel Ad', revokedAt: 1 })

    await linkCloudSyncDevice(recoveryCode)

    const device = cloud.devices.get(deviceId)
    expect(device.label).toBe('Özel Ad')
    expect(device.revokedAt).toBeNull()
    expect(device.disabledAt).toBeNull()
  })

  it('erisimi kaldirilmis cihaz listede gorunmez', async () => {
    cloud.devices.set('dev-iptal', { label: 'İptal edilmiş cihaz', revokedAt: 1 })

    const devices = await listCloudSyncDevices()

    expect(devices.some(device => device.revokedAt)).toBe(false)
    expect(devices.map(device => device.label)).not.toContain('İptal edilmiş cihaz')
    expect(devices.length).toBeGreaterThan(0)
  })

  it('baglanmadan once var olan yerel sohbet hesaba gonderilir', async () => {
    const { recoveryCode } = await regenerateCloudRecoveryCode()
    storage.sessions = [{
      id: 'yerel-sohbet',
      title: 'Yerel sohbet',
      isStarred: true,
      syncPolicy: 'synced',
      updatedAt: 1,
      messages: [{ id: 'm1', role: 'user', content: 'Merhaba' }],
    }]
    transport.pushEntities.mockClear()

    await linkCloudSyncDevice(recoveryCode)

    const gonderilenler = transport.pushEntities.mock.calls
      .flatMap(([arg]) => arg.documents || [])
      .map(item => item.document)
    const gonderilenSohbetler = gonderilenler.filter(belge => belge.entityType === 'session')
    expect(gonderilenSohbetler).toHaveLength(1)
  })

  it('yalniz bu cihazda isaretlenen sohbetin bulut kopyasini siler', async () => {
    const { recoveryCode } = await regenerateCloudRecoveryCode()
    await linkCloudSyncDevice(recoveryCode)
    storage.sessions = [{
      id: 'gizli-sohbet',
      title: 'Gizli sohbet',
      syncPolicy: 'local_only',
      updatedAt: 2,
      messages: [{ id: 'm1', role: 'user', content: 'Merhaba' }],
    }]

    installCloudSyncListeners()
    const listener = chrome.storage.onChanged.addListener.mock.calls.at(-1)?.[0]
    expect(typeof listener).toBe('function')
    listener({
      sessions: {
        oldValue: [{ id: 'gizli-sohbet', syncPolicy: 'synced' }],
        newValue: storage.sessions,
      },
    }, 'local')
    // Dinleyici kuyruğa asenkron yazıyor.
    await new Promise(resolve => setTimeout(resolve, 0))

    transport.pushEntities.mockClear()
    await runCloudSync()

    const gonderilenler = transport.pushEntities.mock.calls
      .flatMap(([arg]) => arg.documents || [])
      .map(item => item.document)
    // Politikası değişen sohbet için buluta silme (tombstone) gönderilmeli.
    expect(gonderilenler.some(belge => belge.entityType === 'session' && belge.deleted === true)).toBe(true)
  })
})

describe('otomatik eşitleme ayarı ve kota sayacı', () => {
  it('varsayılan aralık bir saat; kaydedilen aralık okunur, geçersiz değer varsayılana döner', async () => {
    delete storage.syncAutoIntervalMinutes
    expect((await getAutoSyncSettings()).intervalMinutes).toBe(60)

    await setAutoSyncInterval(120)
    expect((await getAutoSyncSettings()).intervalMinutes).toBe(120)

    await setAutoSyncInterval(0)
    expect((await getAutoSyncSettings()).intervalMinutes).toBe(0)

    await setAutoSyncInterval(45)
    expect((await getAutoSyncSettings()).intervalMinutes).toBe(60)
  })

  it('başarılı koşudan sonra günlük sayaç artar ve panelde görünür', async () => {
    delete storage.syncUsage

    const result = await runCloudSync()

    expect(result?.skipped).toBeUndefined()
    const usage = storage.syncUsage
    expect(usage.dayKey).toBe(pacificDayKey())
    expect(usage.reads).toBeGreaterThanOrEqual(1)
    expect(usage.writes).toBeGreaterThanOrEqual(1)

    const ayarlar = await getAutoSyncSettings()
    expect(ayarlar.usage.reads).toBe(usage.reads)
    expect(ayarlar.slowMode).toBe(false)
  })

  it('dünkü sayaç bugüne taşınmaz', () => {
    const bugun = pacificDayKey()
    expect(currentUsage({ dayKey: bugun, reads: 10, writes: 5 }, Date.now()))
      .toEqual({ dayKey: bugun, reads: 10, writes: 5 })
    expect(currentUsage({ dayKey: '2000-01-01', reads: 999, writes: 999 }, Date.now()))
      .toEqual({ dayKey: bugun, reads: 0, writes: 0 })
    expect(currentUsage(undefined, Date.now())).toEqual({ dayKey: bugun, reads: 0, writes: 0 })
  })

  it('sayaç yarıyı geçince yavaş mod açılır', async () => {
    storage.syncUsage = {
      dayKey: pacificDayKey(),
      reads: 30_000,
      writes: 0,
    }

    const ayarlar = await getAutoSyncSettings()

    expect(ayarlar.slowMode).toBe(true)
    expect(ayarlar.ratio.reads).toBeCloseTo(0.6)
  })

  it('eşitleme sürerken ikinci çağrı aynı işlemin sonucunu bekler', async () => {
    let serbest
    transport.getDevice.mockImplementationOnce(async (_uid, id) => new Promise(resolve => {
      serbest = () => resolve(cloud.devices.get(id) || null)
    }))

    const birinci = runCloudSync()
    const ikinci = runCloudSync()
    expect(ikinci).toBe(birinci)

    // İlk koşu kilidi aldı ve cihaz durumunu okumakta bekliyor; bırakmadan önce
    // o noktaya ulaştığını doğrula.
    await vi.waitFor(() => expect(serbest).toBeTypeOf('function'))
    serbest()
    await expect(birinci).resolves.toBeDefined()
    await expect(ikinci).resolves.toEqual(await birinci)
    expect(storage.syncLease).toBe(0)
  })

  it('bayat kilit yeni koşuyu engellemez', async () => {
    storage.syncLease = Date.now() - 10 * 60 * 1000

    const result = await runCloudSync()

    expect(result?.skipped).toBeUndefined()
    expect(storage.syncLease).toBe(0)
  })

  it('başarısız koşudan sonra kilit temizlenir ve yeniden deneme çalışır', async () => {
    transport.getDevice.mockRejectedValueOnce(new Error('unavailable'))
    const first = runCloudSync()
    const joined = runCloudSync()
    expect(joined).toBe(first)
    await expect(first).rejects.toThrow('offline')
    expect(storage.syncLease).toBe(0)
    await expect(runCloudSync()).resolves.toEqual(expect.objectContaining({ rounds: expect.any(Number) }))
  })

  it('önceki worker taze bir depolama işareti bıraksa da yeni koşu çalışır', async () => {
    storage.syncLease = Date.now()

    const result = await runCloudSync()

    expect(result?.skipped).toBeUndefined()
    storage.syncLease = 0
  })

  it('devralınan depolama işareti işlem tamamlanınca temizlenir', async () => {
    const taze = Date.now()
    storage.syncLease = taze

    const result = await runCloudSync()

    expect(result?.skipped).toBeUndefined()
    expect(storage.syncLease).toBe(0)
    storage.syncLease = 0
  })
})

describe('eşitlemede aynı anahtarın iki cihazda ayrı kimliklerle eklenmesi', () => {
  it('çakışan bulut kaydını hata saymaz ve yerel kimliğe yakınsar', async () => {
    cloud.account = null
    cloud.devices.clear()
    storage.syncLease = 0
    delete storage.syncLastError
    delete storage.syncLastErrorDetail
    const { recoveryCode } = await initializeCloudSync()

    // Bu cihazda anahtar zaten var; başka bir cihaz aynı anahtarı ayrı bir
    // kimlikle eklediği için buluttan gelen kopya kasayla çakışacak.
    const ham = 'AIza-esitleme-cakismasi-12345'
    const db = await openVaultDatabase()
    const vault = createKeyVault({ db, deviceKey: await loadOrCreateDeviceKey(db) })
    const yerelId = await vault.addKey('gemini', ham)

    const masterBytes = await openMasterSecretFromRecovery(cloud.account.recoveryEnvelope, recoveryCode)
    const subkeys = await deriveSubkeys(await importMasterSecret(masterBytes))
    const uzakId = 'gemini:diger-cihaz'
    const opaqueEntityId = await deriveOpaqueId(subkeys.hmacIdKey, 'api_key', uzakId)
    const aad = buildAad({ ownerUid: user.uid, opaqueEntityId, entityType: 'api_key' })
    const zarf = await encryptJson(subkeys.dataEncryptionKey, {
      storageKey: 'geminiApiKeys',
      logicalId: uzakId,
      provider: 'gemini',
      metadata: { label: 'Diğer cihaz', isPrimary: false, createdAt: 1, fingerprint: null },
      key: ham,
    }, aad)
    const belge = buildEntityDocument({
      ownerUid: user.uid,
      entityType: 'api_key',
      entityVersion: createEntityVersion({ wallTimeMs: Date.now(), deviceId: 'dev-diger' }),
      sourceDeviceId: 'dev-diger',
      nonce: zarf.nonce,
      ciphertext: zarf.ciphertext,
      deleted: false,
    })
    transport.pullEntities.mockResolvedValueOnce({
      documents: [{ ...belge, opaqueEntityId, serverUpdatedAt: Date.now() }],
    })

    const sonuc = await runCloudSync()

    expect(sonuc?.skipped).toBeUndefined()
    expect(storage.syncLastError).toBeNull()
    expect(storage.syncLastErrorDetail).toBeNull()

    // Kasa tek kayda indi, anahtar korunuyor ve buluttaki kimlik yerelde oluşmadı.
    const liste = await vault.listKeys('gemini')
    expect(liste.some(kayit => kayit.id === yerelId)).toBe(true)
    expect(liste.some(kayit => kayit.id === uzakId)).toBe(false)
    expect(await vault.getRawKey('gemini', yerelId)).toBe(ham)

    // Yerel kimlik buluta yeniden yazıldı: tüm cihazlar tek kayda yakınsar.
    const gonderilenler = transport.pushEntities.mock.calls
      .flatMap(([arg]) => arg.documents || [])
      .map(item => item.document)
    expect(gonderilenler.some(item => item.entityType === 'api_key' && item.deleted !== true)).toBe(true)
  })
})
