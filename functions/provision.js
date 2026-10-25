// Run with Application Default Credentials against an explicitly named project.
/* global process */
// Owner address is read only from the process environment; never written to source.
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { byteSize } from './policy.js'
import { cliCredential, cliFirestore } from './cliCredential.js'

const projectId = process.env.GCLOUD_PROJECT
if (!projectId) throw new Error('Set GCLOUD_PROJECT explicitly')
initializeApp({ projectId, ...(process.env.HERAAI_USE_FIREBASE_CLI_AUTH === '1' ? { credential: cliCredential() } : {}) })
const db = process.env.HERAAI_USE_FIREBASE_CLI_AUTH === '1' ? cliFirestore(projectId) : getFirestore()
const mode = process.argv[2]
if (mode === 'owner') {
  const email = process.env.HERAAI_OWNER_EMAIL
  if (!email) throw new Error('Set HERAAI_OWNER_EMAIL')
  const user = await getAuth().getUserByEmail(email)
  if (!user.emailVerified || !user.providerData.some(provider => provider.providerId === 'google.com')) throw new Error('Verified Google account required')
  await db.doc(`cloudRoles/${user.uid}`).set({ role: 'owner' })
  console.log('Owner role assigned to verified Firebase UID:', user.uid)
} else if (mode === 'inventory') {
  // Run only after stopping all legacy writes; gateway-only rules must be active.
  const roots = await db.collection('users').listDocuments()
  for (const root of roots) {
    let storageBytes = 0, devices = 0
    async function visit(ref) {
      for (const collection of await ref.listCollections()) {
        let last = null
        for (;;) {
          let query = collection.orderBy('__name__').limit(100)
          if (last) query = query.startAfter(last)
          const page = await query.get()
          if (page.empty) break
          for (const doc of page.docs) {
            const value = doc.data()
            storageBytes += byteSize(value)
            if (collection.id === 'devices' && value.deviceMasterKeyEnvelope && !value.revokedAt && !value.disabledAt) devices += 1
            await visit(doc.ref)
          }
          last = page.docs.at(-1)
        }
      }
    }
    await visit(root)
    await db.doc(`cloudAccounts/${root.id}`).set({ storageBytes, devices, inventoried: true })
    console.log('Inventoried Firebase UID:', root.id)
  }
} else if (mode === 'enable-public' || mode === 'pause-public') {
  await db.doc('cloudConfig/public').set({ enabled: mode === 'enable-public' })
  console.log('Public cloud policy updated')
} else throw new Error('Expected owner, inventory, enable-public or pause-public')
