import {
  Timestamp,
  collection,
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
} from 'firebase/firestore'

import { getFirebaseFirestore } from './firebaseClient'
import { cloudPaths } from './syncModel'

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

    async getBlobManifest(uid, opaqueAttachmentId) {
      const snapshot = await getDoc(doc(db, cloudPaths.blob(uid, opaqueAttachmentId)))
      return snapshot.exists() ? snapshot.data() : null
    },

    async setBlobManifest(uid, opaqueAttachmentId, value) {
      await setDoc(doc(db, cloudPaths.blob(uid, opaqueAttachmentId)), value, { merge: true })
    },

    async setBlobChunk(uid, opaqueAttachmentId, chunk) {
      await setDoc(
        doc(db, cloudPaths.blobChunk(uid, opaqueAttachmentId, chunk.index)),
        { ...chunk, chunkSize: Number(chunk.byteLength) || 0 },
      )
    },

    async getBlobChunks(uid, opaqueAttachmentId) {
      const snapshots = await getDocs(collection(db, `users/${uid}/blobs/${opaqueAttachmentId}/chunks`))
      return snapshots.docs
        .map(snapshot => snapshot.data())
        .sort((a, b) => Number(a.index) - Number(b.index))
    },

    async pushEntities({ uid, documents }) {
      for (const item of documents) {
        const entityRef = doc(db, cloudPaths.entity(uid, item.opaqueEntityId))
        await runTransaction(db, async (transaction) => {
          const previous = await transaction.get(entityRef)
          if (previous.exists()) {
            const previousData = previous.data()
            const version = previousData.entityVersion
            if (version) {
              const revisionId = `${version.wallTimeMs}-${version.logicalCounter}-${version.deviceId}`
              transaction.set(
                doc(db, cloudPaths.revision(uid, item.opaqueEntityId, revisionId)),
                { ...previousData, archivedAt: serverTimestamp() },
              )
            }
          }
          transaction.set(entityRef, {
            ...item.document,
            opaqueEntityId: item.opaqueEntityId,
            serverUpdatedAt: serverTimestamp(),
          })
        })
      }
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
  }
}
