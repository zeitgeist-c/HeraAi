import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { initializeApp, deleteApp } from 'firebase-admin/app'
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore'
import { createCloudGateway } from '../gateway.js'
import { dayWindow } from '../policy.js'

/* global process, Buffer */
const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST)
const projectId = 'demo-heraai'
let db, app, call, clock
before(async () => {
  if (!enabled) return
  app = initializeApp({ projectId }, 'gateway-emulator')
  db = getFirestore(app)
  clock = Date.UTC(2026, 9, 25, 12)
  const handle = createCloudGateway({ db, Timestamp, serverTimestamp: () => FieldValue.serverTimestamp(), now: () => clock })
  call = (uid, action, args = {}) => handle({ auth: { uid, token: { email_verified: true, firebase: { sign_in_provider: 'google.com' } } }, data: { action, args } })
  await db.doc('cloudConfig/public').set({ enabled: true })
})
after(async () => { if (app) await deleteApp(app) })
const run = (name, callback) => test(name, { skip: !enabled }, callback)

run('real Firestore transactions enforce a shared daily limit under concurrent calls', async () => {
  const uid = 'race-user'
  const ref = db.doc(`cloudDaily/${uid}_${dayWindow(clock).day}`)
  await ref.set({ syncs: 59 })
  const results = await Promise.allSettled([call(uid, 'beginSync'), call(uid, 'beginSync'), call(uid, 'beginSync')])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal((await ref.get()).data().syncs, 60)
})
run('real SDK stores setup, device envelope, versioned entity and server timestamp cursor', async () => {
  const uid = 'sync-user'
  await call(uid, 'setAccountRoot', { value: { schemaVersion: 1, cryptoVersion: 1, recoveryEnvelope: { nonce: 'n', ciphertext: 'cipher' }, createdAt: clock, keyRotationIndex: 0, lastCleanupAt: null } })
  await call(uid, 'setDevice', { deviceId: 'device1', value: { deviceId: 'device1', label: 'Test', deviceMasterKeyEnvelope: { nonce: 'n', ciphertext: 'cipher' } } })
  assert.equal((await call(uid, 'listDevices')).result.length, 1)
  const document = { ownerUid: uid, entityType: 'session', schemaVersion: 1, cryptoVersion: 1, entityVersion: { wallTimeMs: clock, logicalCounter: 0, deviceId: 'device1' }, nonce: 'n', ciphertext: 'cipher', ciphertextSize: 6, chunkCount: 0 }
  await call(uid, 'pushEntities', { documents: [{ opaqueEntityId: 'session1', document }] })
  const first = (await call(uid, 'pullEntities')).result
  assert.equal(first.documents.length, 1)
  assert.equal(first.pageSize, 1)
  assert.ok(Number.isInteger(first.documents[0].serverTimestampNanoseconds))
  const cursor = first.documents[0]
  assert.equal((await call(uid, 'pullEntities', { cursor })).result.documents.length, 0)
  assert.deepEqual((await call(uid, 'pushEntities', { documents: [{ opaqueEntityId: 'session1', document }] })).result.applied, [])
})
run('real SDK handles encrypted chunk paging and refuses to delete the live revision', async () => {
  const uid = 'chunk-user'
  for (let index = 0; index < 2; index += 1) await call(uid, 'setEntityChunks', { opaqueEntityId: 'session', revision: 'revision1', chunks: [{ index, nonce: 'n', ciphertext: 'cipher' }] })
  const first = (await call(uid, 'getEntityChunks', { opaqueEntityId: 'session', revision: 'revision1' })).result
  assert.equal(first.chunks.length, 1)
  const second = (await call(uid, 'getEntityChunks', { opaqueEntityId: 'session', revision: 'revision1', afterId: first.afterId })).result
  assert.equal(second.chunks[0].index, 1)
  await call(uid, 'pushEntities', { documents: [{ opaqueEntityId: 'session', document: { ownerUid: uid, entityType: 'session', schemaVersion: 1, entityVersion: { wallTimeMs: clock, logicalCounter: 0, deviceId: 'device1' }, chunkRevision: 'revision1', chunkCount: 2, payloadBytes: 100 } }] })
  assert.equal((await call(uid, 'deleteEntityChunksRevision', { opaqueEntityId: 'session', revision: 'revision1' })).result.deleted, 0)
})
run('gateway-only rules deny direct REST access to data and role documents', async () => {
  const base = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${projectId}/databases/(default)/documents`
  // The emulator accepts unsigned JWTs for rules evaluation; no production secrets.
  const token = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'owner', user_id: 'owner', aud: projectId, iss: `https://securetoken.google.com/${projectId}`, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, firebase: { sign_in_provider: 'google.com' } })).toString('base64url')}.`
  await db.doc('cloudRoles/owner').set({ role: 'owner' })
  for (const path of ['users/owner/account/root', 'cloudRoles/owner', 'cloudDaily/owner_test']) {
    const response = await fetch(`${base}/${path}`, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(response.status, 403)
  }
  const response = await fetch(`${base}/cloudRoles/attacker`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ fields: { role: { stringValue: 'owner' } } }) })
  assert.equal(response.status, 403)
})
run('owner bypass works in the SDK with exhausted public quota and paused public service', async () => {
  await db.doc('cloudConfig/public').set({ enabled: false })
  await db.doc('cloudRoles/test-owner').set({ role: 'owner' })
  assert.equal((await call('test-owner', 'beginSync')).quota.exempt, true)
  await assert.rejects(call('normal-user', 'beginSync'), /public_cloud_paused/)
  await db.doc('cloudConfig/public').set({ enabled: true })
})
