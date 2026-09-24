import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit as limitQuery,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  startAfter,
  writeBatch,
} from 'firebase/firestore/lite'

import { getFirebaseFirestore } from './firebaseClient'
import { cloudPaths, compareEntityVersions } from './syncModel'

function timestampMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis()
  if (Number.isFinite(Number(value))) return Number(value)
  return 0
}

function normalizeSnapshot(snapshot) {
  const value = snapshot.data()
  return {
    ...value,
    opaqueEntityId: snapshot.id,
    serverUpdatedAt: timestampMillis(value.serverUpdatedAt),
  }
}

export function createFirestoreTransport({ db = getFirebaseFirestore() } = {}) {
  async function deleteRefs(refs) {
    for (let offset = 0; offset < refs.length; offset += 400) {
      const batch = writeBatch(db)
      for (const ref of refs.slice(offset, offset + 400)) batch.delete(ref)
      await batch.commit()
    }
  }

  async function readPage(path, afterId = null, pageSize = 100) {
    const constraints = [orderBy(documentId())]
    if (afterId) constraints.push(startAfter(afterId))
    constraints.push(limitQuery(pageSize))
    return getDocs(query(collection(db, path), ...constraints))
  }

  async function deleteCollection(path) {
    let deleted = 0
    for (;;) {
      const snapshots = await readPage(path)
      if (snapshots.empty) return deleted
      await deleteRefs(snapshots.docs.map(snapshot => snapshot.ref))
      deleted += snapshots.size
    }
  }

  return {
    async getAccountRoot(uid) {
      const snapshot = await getDoc(doc(db, cloudPaths.accountRoot(uid)))
      return snapshot.exists() ? snapshot.data() : null
    },

    async setAccountRoot(uid, value) {
      await setDoc(doc(db, cloudPaths.accountRoot(uid)), value, { merge: true })
    },

    async getDevice(uid, deviceId) {
      const snapshot = await getDoc(doc(db, cloudPaths.device(uid, deviceId)))
      return snapshot.exists() ? snapshot.data() : null
    },

    async setDevice(uid, deviceId, value) {
      await setDoc(doc(db, cloudPaths.device(uid, deviceId)), value, { merge: true })
    },

    async listDevices(uid) {
      const snapshots = await getDocs(collection(db, `users/${uid}/devices`))
      return snapshots.docs.map(snapshot => ({ id: snapshot.id, ...snapshot.data() }))
    },

    async setEntityChunks(uid, opaqueEntityId, revision, chunks) {
      for (let offset = 0; offset < chunks.length; offset += 400) {
        const batch = writeBatch(db)
        for (const chunk of chunks.slice(offset, offset + 400)) {
          const chunkId = `${revision}-${String(chunk.index).padStart(6, '0')}`
          batch.set(doc(db, cloudPaths.entityChunk(uid, opaqueEntityId, chunkId)), {
            ...chunk,
            ownerUid: uid,
            schemaVersion: 1,
            entityType: 'session_chunk',
            revision,
            chunkSize: String(chunk.ciphertext || '').length,
          })
        }
        await batch.commit()
      }
    },

    async getEntityChunks(uid, opaqueEntityId, revision) {
      const snapshots = await getDocs(collection(db, `users/${uid}/entities/${opaqueEntityId}/chunks`))
      return snapshots.docs
        .map(snapshot => snapshot.data())
        .filter(chunk => chunk.revision === revision)
        .sort((a, b) => Number(a.index) - Number(b.index))
    },

    async deleteStaleEntityChunks(uid, opaqueEntityId, keepRevision = null) {
      let revision = keepRevision
      if (!revision) {
        // Revizyon verilmediyse belgenin guncel revizyonunu koru: araya giren
        // baska bir cihazin parcali surumunu silmek belgeyi bozar.
        const snapshot = await getDoc(doc(db, cloudPaths.entity(uid, opaqueEntityId)))
        revision = snapshot.exists() ? snapshot.data()?.chunkRevision || null : null
      }
      const snapshots = await getDocs(collection(db, `users/${uid}/entities/${opaqueEntityId}/chunks`))
      const stale = snapshots.docs
        .filter(snapshot => !revision || snapshot.data()?.revision !== revision)
        .map(snapshot => snapshot.ref)
      await deleteRefs(stale)
      return stale.length
    },

    async deleteEntityChunksRevision(uid, opaqueEntityId, revision) {
      const snapshots = await getDocs(collection(db, `users/${uid}/entities/${opaqueEntityId}/chunks`))
      const matching = snapshots.docs
        .filter(snapshot => snapshot.data()?.revision === revision)
        .map(snapshot => snapshot.ref)
      await deleteRefs(matching)
      return matching.length
    },

    async pushEntities({ uid, documents }) {
      const applied = []
      for (const item of documents) {
        const entityRef = doc(db, cloudPaths.entity(uid, item.opaqueEntityId))
        const written = await runTransaction(db, async (transaction) => {
          const previous = await transaction.get(entityRef)
          if (previous.exists()) {
            const previousData = previous.data()
            if (compareEntityVersions(item.document.entityVersion, previousData.entityVersion) <= 0) return false
          }
          transaction.set(entityRef, {
            ...item.document,
            opaqueEntityId: item.opaqueEntityId,
            serverUpdatedAt: serverTimestamp(),
          })
          return true
        })
        if (written) applied.push(item.opaqueEntityId)
      }
      return { applied }
    },

    async pullEntities({ uid, cursor, limit = 100 }) {
      const constraints = [orderBy('serverUpdatedAt'), orderBy(documentId())]
      if (cursor?.serverUpdatedAt && cursor?.opaqueEntityId) {
        constraints.push(
          startAfter(Timestamp.fromMillis(cursor.serverUpdatedAt), cursor.opaqueEntityId),
        )
      }
      constraints.push(limitQuery(limit))
      const snapshots = await getDocs(query(
        collection(db, `users/${uid}/entities`),
        ...constraints,
      ))
      return { documents: snapshots.docs.map(normalizeSnapshot) }
    },

    async cleanLegacyCloudData(uid) {
      const counts = { blobs: 0, chunks: 0, revisions: 0, backups: 0 }
      for (;;) {
        const blobSnapshots = await readPage(`users/${uid}/blobs`)
        if (blobSnapshots.empty) break
        for (const blobSnapshot of blobSnapshots.docs) {
          counts.chunks += await deleteCollection(`users/${uid}/blobs/${blobSnapshot.id}/chunks`)
          await deleteDoc(blobSnapshot.ref)
          counts.blobs += 1
        }
      }
      let entityCursor = null
      for (;;) {
        const entitySnapshots = await readPage(`users/${uid}/entities`, entityCursor)
        if (entitySnapshots.empty) break
        for (const entitySnapshot of entitySnapshots.docs) {
          counts.revisions += await deleteCollection(
            `users/${uid}/entities/${entitySnapshot.id}/revisions`,
          )
        }
        entityCursor = entitySnapshots.docs.at(-1).id
      }
      counts.backups = await deleteCollection(`users/${uid}/backups`)
      return counts
    },
  }
}
