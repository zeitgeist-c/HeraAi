import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Timestamp } from 'firebase-admin/firestore'
import { createCloudGateway } from '../gateway.js'
import { USER_LIMITS, PUBLIC_LIMITS, dayWindow, incrementUsage } from '../policy.js'

// Serializable fake transaction tests policy behavior; emulator tests separately
// exercise the actual Firestore SDK and concurrent transaction retries.
function setup() {
  const data = new Map([['cloudConfig/public', { enabled: true }]])
  const doc = path => ({ path, id: path.split('/').at(-1) })
  const snapshot = ref => ({ ref, id: ref.id, exists: data.has(ref.path), data: () => data.get(ref.path) })
  let chain = Promise.resolve()
  const db = { doc, runTransaction: fn => {
    const task = chain.then(async () => {
      const writes = []
      const tx = {
        get: async ref => snapshot(ref), getAll: async (...refs) => refs.map(snapshot),
        set: (ref, value) => writes.push(() => data.set(ref.path, value)),
        delete: ref => writes.push(() => data.delete(ref.path)),
      }
      const result = await fn(tx)
      writes.forEach(write => write())
      return result
    })
    chain = task.catch(() => {})
    return task
  } }
  const now = Date.UTC(2026, 9, 25, 12)
  const handle = createCloudGateway({ db, Timestamp, now: () => now })
  const call = (uid, action, args = {}, token = {}) => handle({ auth: { uid, token: { email_verified: true, firebase: { sign_in_provider: 'google.com' }, ...token } }, data: { action, args } })
  return { data, call, handle, now }
}
test('all devices share daily user quota; concurrent requests cannot overshoot', async () => {
  const { call, data, now } = setup()
  const key = `cloudDaily/user_${dayWindow(now).day}`
  data.set(key, { syncs: 59 })
  const results = await Promise.allSettled([call('user', 'beginSync'), call('user', 'beginSync')])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(data.get(key).syncs, 60)
})
test('only server-side owner role bypasses user quotas and public pool exhaustion', async () => {
  const { call, data, now } = setup()
  data.set(`cloudPublicDaily/${dayWindow(now).day}`, { reads: PUBLIC_LIMITS.reads })
  await assert.rejects(call('user', 'beginSync', { role: 'owner' }), /quota/)
  data.set('cloudRoles/owner', { role: 'owner' })
  data.set(`cloudDaily/owner_${dayWindow(now).day}`, { syncs: USER_LIMITS.syncs + 50 })
  const result = await call('owner', 'beginSync')
  assert.equal(result.quota.exempt, true)
  assert.equal(data.get(`cloudPublicDaily/${dayWindow(now).day}`).reads, PUBLIC_LIMITS.reads)
})
test('owner continues when public stop switch is off', async () => {
  const { call, data } = setup()
  data.set('cloudConfig/public', { enabled: false })
  data.set('cloudRoles/owner', { role: 'owner' })
  await assert.rejects(call('user', 'status'), /public_cloud_paused/)
  assert.equal((await call('owner', 'status')).quota.exempt, true)
})
test('refuses forged resource paths and cross-account writes', async () => {
  const { call } = setup()
  await assert.rejects(call('user', 'getDevice', { deviceId: '../owner' }), /invalid_request/)
  await assert.rejects(call('user', 'pushEntities', { documents: [{ opaqueEntityId: 'id', document: { ownerUid: 'victim', entityType: 'session', schemaVersion: 1 } }] }), /invalid_request/)
})
test('requires verified Google authentication', async () => {
  const { call, handle } = setup()
  await assert.rejects(handle({ data: { action: 'status' } }), /unauthenticated/)
  await assert.rejects(call('user', 'status', {}, { email_verified: false }), /unauthenticated/)
})
test('resets daily windows using server UTC, not client date', () => {
  assert.equal(dayWindow(Date.UTC(2026, 9, 25, 23, 59)).resetsAt, Date.UTC(2026, 9, 26))
  assert.equal(dayWindow(Date.UTC(2026, 9, 26)).day, '2026-10-26')
  assert.equal(incrementUsage({}, { syncs: 1 }, USER_LIMITS).syncs, 1)
})
test('capacity rejection rolls back data and quota counters', async () => {
  const { call, data } = setup()
  data.set('cloudAccounts/user', { storageBytes: USER_LIMITS.storageBytes, devices: 3 })
  await assert.rejects(call('user', 'setDevice', { deviceId: 'fourth', value: { deviceId: 'fourth', deviceMasterKeyEnvelope: { nonce: 'n', ciphertext: 'c' } } }), /account_capacity_exceeded/)
  assert.equal(data.has('users/user/devices/fourth'), false)
})
test('idempotent entity retry does not overwrite a newer remote version', async () => {
  const { call, data } = setup()
  const document = { ownerUid: 'user', entityType: 'session', schemaVersion: 1, entityVersion: { wallTimeMs: 2, logicalCounter: 0, deviceId: 'device' }, ciphertext: 'encrypted', nonce: 'nonce' }
  const args = { documents: [{ opaqueEntityId: 'entity', document }] }
  assert.deepEqual((await call('user', 'pushEntities', args)).result.applied, ['entity'])
  assert.deepEqual((await call('user', 'pushEntities', args)).result.applied, [])
  assert.equal(data.get('users/user/entities/entity').ciphertext, 'encrypted')
})
