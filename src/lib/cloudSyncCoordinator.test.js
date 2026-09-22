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
  initializeCloudSync,
  cloudSyncWakeReason,
  mapCloudSyncError,
  nextPacificQuotaReset,
  regenerateCloudRecoveryCode,
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
})
