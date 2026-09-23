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
  exportEncryptedBackup,
  getCloudSyncStatus,
  initializeCloudSync,
  cloudSyncWakeReason,
  linkCloudSyncDevice,
  listCloudSyncDevices,
  mapCloudSyncError,
  nextPacificQuotaReset,
  regenerateCloudRecoveryCode,
  renameCloudSyncDevice,
  runCloudSync,
  setCloudSyncDeviceEnabled,
} from './cloudSyncCoordinator'
import { openMasterSecretFromRecovery } from './syncCrypto'

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
})
