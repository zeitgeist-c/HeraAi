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
  getBlobManifest: vi.fn(async () => null),
  setBlobManifest: vi.fn(async () => undefined),
  setBlobChunk: vi.fn(async () => undefined),
  getBlobChunks: vi.fn(async () => []),
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
