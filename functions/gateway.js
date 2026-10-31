import { USER_LIMITS, fail, byteSize, dayWindow, incrementUsage, incrementPublicUsage, segment, compareVersions } from './policy.js'

const TYPES = ['setting', 'session', 'message', 'message_batch', 'api_key', 'stats_day', 'tombstone']
const MAX_REQUEST_BYTES = 1_500_000
function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_request')
  return value
}
function fields(value, allowed) {
  plain(value)
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('invalid_request')
}

// All data paths are constructed from verified auth.uid. No client path/UID/role is accepted.
export function createCloudGateway({ db, Timestamp, serverTimestamp = () => Timestamp.now(), now = Date.now }) {
  return async ({ auth, data }) => {
    if (!auth?.uid || auth.token?.firebase?.sign_in_provider !== 'google.com' || auth.token?.email_verified !== true) fail('unauthenticated')
    const uid = segment(auth.uid)
    fields(data, ['action', 'args'])
    const { action, args = {} } = data
    plain(args)
    if (byteSize(data) > MAX_REQUEST_BYTES) fail('request_too_large')
    const { day, resetsAt } = dayWindow(now())
    return db.runTransaction(async tx => {
      const roleRef = db.doc(`cloudRoles/${uid}`)
      const accountRef = db.doc(`cloudAccounts/${uid}`)
      const dailyRef = db.doc(`cloudDaily/${uid}_${day}`)
      const poolRef = db.doc(`cloudPublicDaily/${day}`)
      const controlRef = db.doc('cloudConfig/public')
      const role = await tx.get(roleRef)
      const owner = role.data()?.role === 'owner'
      // Owner transactions never read/write the shared public counter, so
      // public-pool contention does not force their transactions to retry.
      const [inventory, daily, pool, control] = await tx.getAll(accountRef, dailyRef, ...(owner ? [] : [poolRef, controlRef]))
      if (!owner && control.data()?.enabled !== true) fail('public_cloud_paused')
      // Refuse exhausted accounts before any user-data query. Rejected HTTP
      // traffic and these control reads still have infrastructure costs.
      incrementUsage(daily.data() || {}, { requests: 1, reads: 6 }, USER_LIMITS, owner)
      if (!owner) incrementPublicUsage(pool.data() || {}, { reads: 6, writes: 3 })
      const root = `users/${uid}`
      let storageBytes = inventory.data()?.storageBytes || 0
      let devices = inventory.data()?.devices || 0
      // Old data must be inventoried using the Admin migration before admission.
      if (!inventory.exists && (await tx.get(db.doc(`${root}/account/root`))).exists && !owner) fail('cloud_migration_required')
      let reads = 6, writes = 0
      const mutations = []
      const read = async ref => { reads += 1; return tx.get(ref) }
      const readQuery = async query => {
        const snapshot = await tx.get(query)
        reads += Math.max(1, snapshot.size)
        return snapshot.docs
      }
      const stage = (ref, previous, next) => {
        if (next && byteSize(next) > 850000) fail('request_too_large')
        const before = previous?.exists ? previous.data() : null
        storageBytes += (next ? byteSize(next) : 0) - (before ? byteSize(before) : 0)
        writes += 1
        mutations.push({ ref, next })
      }
      const snapshotData = snapshot => snapshot.exists ? snapshot.data() : null
      const normalize = snapshot => {
        const value = snapshot.data()
        const timestamp = value.serverUpdatedAt
        return { ...value, opaqueEntityId: snapshot.id,
          ...(timestamp?.toMillis ? { serverUpdatedAt: timestamp.toMillis(), serverTimestampSeconds: timestamp.seconds, serverTimestampNanoseconds: timestamp.nanoseconds } : {}),
        }
      }
      let result
      switch (action) {
        case 'status':
        case 'beginSync': result = {}; break
        case 'getAccountRoot': result = snapshotData(await read(db.doc(`${root}/account/root`))); break
        case 'setAccountRoot': {
          const value = args.value
          fields(value, ['schemaVersion', 'cryptoVersion', 'recoveryEnvelope', 'createdAt', 'keyRotationIndex', 'lastCleanupAt'])
          if (byteSize(value) > 16000) fail('request_too_large')
          if (!Number.isInteger(value.schemaVersion) || !value.recoveryEnvelope) fail('invalid_request')
          const ref = db.doc(`${root}/account/root`)
          const previous = await read(ref)
          stage(ref, previous, { ...(previous.data() || {}), ...value })
          result = null; break
        }
        case 'getDevice': result = snapshotData(await read(db.doc(`${root}/devices/${segment(args.deviceId)}`))); break
        case 'listDevices': result = (await readQuery(db.collection(`${root}/devices`).limit(101))).map(snapshot => ({ id: snapshot.id, ...snapshot.data() })); break
        case 'setDevice': {
          const ref = db.doc(`${root}/devices/${segment(args.deviceId)}`)
          const value = args.value
          fields(value, ['deviceId', 'label', 'platform', 'browser', 'createdAt', 'lastSeenAt', 'lastSyncedAt', 'deviceMasterKeyEnvelope', 'revokedAt', 'disabledAt', 'schemaVersion'])
          if (byteSize(value) > 16000) fail('request_too_large')
          if (value.deviceId && value.deviceId !== args.deviceId) fail('invalid_request')
          const previous = await read(ref)
          const next = { ...(previous.data() || {}), ...value }
          const active = item => Boolean(item?.deviceMasterKeyEnvelope && !item.revokedAt && !item.disabledAt)
          devices += Number(active(next)) - Number(active(previous.data()))
          stage(ref, previous, next)
          result = null; break
        }
        case 'pushEntities': {
          if (!Array.isArray(args.documents) || args.documents.length !== 1) fail('invalid_request')
          const applied = []
          for (const item of args.documents) {
            const id = segment(item.opaqueEntityId)
            const value = item.document
            fields(value, ['ownerUid', 'entityType', 'schemaVersion', 'cryptoVersion', 'entityVersion', 'sourceDeviceId', 'deleted', 'ciphertextSize', 'nonce', 'ciphertext', 'chunkRevision', 'chunkCount', 'payloadBytes'])
            if (value.ownerUid !== uid || value.schemaVersion !== 1 || !TYPES.includes(value.entityType)
              || byteSize(value) > 850000 || (value.ciphertext?.length || 0) > 800000) fail('invalid_request')
            compareVersions(value.entityVersion, null)
            const ref = db.doc(`${root}/entities/${id}`)
            const previous = await read(ref)
            if (previous.exists && compareVersions(value.entityVersion, previous.data().entityVersion) <= 0) continue
            stage(ref, previous, { ...value, opaqueEntityId: id, serverUpdatedAt: serverTimestamp() })
            applied.push(id)
          }
          result = { applied }; break
        }
        case 'pullEntities': {
          const limit = 1 // Bound response bytes even for maximum-sized sessions.
          let query = db.collection(`${root}/entities`).orderBy('serverUpdatedAt').orderBy('__name__').limit(limit)
          if (args.cursor) {
            const cursor = args.cursor
            const timestamp = Number.isInteger(cursor.serverTimestampSeconds)
              ? new Timestamp(cursor.serverTimestampSeconds, cursor.serverTimestampNanoseconds)
              : Timestamp.fromMillis(Number(cursor.serverUpdatedAt))
            query = query.startAfter(timestamp, segment(cursor.opaqueEntityId))
          }
          result = { documents: (await readQuery(query)).map(normalize), pageSize: limit }; break
        }
        case 'setEntityChunks': {
          if (!Array.isArray(args.chunks) || args.chunks.length !== 1) fail('invalid_request')
          const revision = segment(args.revision)
          const chunk = args.chunks[0]
          fields(chunk, ['index', 'nonce', 'ciphertext'])
          if (!Number.isInteger(chunk.index) || chunk.index < 0 || chunk.index > 10000
            || typeof chunk.ciphertext !== 'string' || chunk.ciphertext.length > 720000) fail('invalid_request')
          const ref = db.doc(`${root}/entities/${segment(args.opaqueEntityId)}/chunks/${revision}-${String(chunk.index).padStart(6, '0')}`)
          const previous = await read(ref)
          stage(ref, previous, { ...chunk, ownerUid: uid, schemaVersion: 1, entityType: 'session_chunk', revision, chunkSize: chunk.ciphertext.length })
          result = null; break
        }
        case 'getEntityChunks': {
          let query = db.collection(`${root}/entities/${segment(args.opaqueEntityId)}/chunks`).where('revision', '==', segment(args.revision)).orderBy('__name__').limit(1)
          if (args.afterId) query = query.startAfter(segment(args.afterId))
          const snapshots = await readQuery(query)
          result = { chunks: snapshots.map(snapshot => snapshot.data()), afterId: snapshots.at(-1)?.id || null }; break
        }
        case 'deleteStaleEntityChunks':
        case 'deleteEntityChunksRevision': {
          const id = segment(args.opaqueEntityId)
          const parent = await read(db.doc(`${root}/entities/${id}`))
          const protectedRevision = parent.data()?.chunkRevision
          const revision = args.revision || args.keepRevision || protectedRevision
          if (revision) segment(revision)
          // Never delete a revision still referenced by the live entity.
          if (action === 'deleteEntityChunksRevision' && protectedRevision === revision) { result = { deleted: 0, afterId: null }; break }
          let query = db.collection(`${root}/entities/${id}/chunks`).orderBy('__name__').limit(10)
          if (args.afterId) query = query.startAfter(segment(args.afterId))
          const snapshots = await readQuery(query)
          let deleted = 0
          for (const snapshot of snapshots) {
            const chunkRevision = snapshot.data().revision
            const remove = action === 'deleteStaleEntityChunks'
              ? chunkRevision !== protectedRevision && chunkRevision !== revision : chunkRevision === revision
            if (remove) { stage(snapshot.ref, snapshot, null); deleted += 1 }
          }
          result = { deleted, afterId: snapshots.length === 10 ? snapshots.at(-1).id : null }; break
        }
        case 'cleanLegacyCloudData':
          // Legacy blobs/backups need the bounded Admin migration; public clients
          // cannot run unbounded scans over old data as a quota bypass.
          fail('legacy_cleanup_admin_required'); break
        default: fail('invalid_request')
      }
      if (!owner && (storageBytes > USER_LIMITS.storageBytes || devices > USER_LIMITS.devices)) fail('account_capacity_exceeded')
      const cost = { requests: 1, reads, writes: writes + (owner ? 2 : 3), bytes: byteSize(data) + byteSize(result), syncs: action === 'beginSync' ? 1 : 0 }
      const usage = incrementUsage(daily.data() || {}, cost, USER_LIMITS, owner)
      let publicUsage
      if (!owner) publicUsage = incrementPublicUsage(pool.data() || {}, cost)
      for (const mutation of mutations) {
        if (mutation.next) tx.set(mutation.ref, mutation.next)
        else tx.delete(mutation.ref)
      }
      tx.set(accountRef, { storageBytes: Math.max(0, storageBytes), devices: Math.max(0, devices), inventoried: true })
      tx.set(dailyRef, usage)
      if (!owner) tx.set(poolRef, publicUsage)
      return { result, quota: { exempt: owner, usage, limits: owner ? null : USER_LIMITS, resetsAt, storageBytes, devices } }
    })
  }
}
