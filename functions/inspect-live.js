/* global process */
import { initializeApp, deleteApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { cliCredential, cliFirestore } from './cliCredential.js'

const projectId = process.env.GCLOUD_PROJECT
const email = process.env.HERAAI_OWNER_EMAIL
if (!projectId || !email) throw new Error('Explicit project and owner email required')
const credential = cliCredential()
const app = initializeApp({ projectId, credential })
try {
  const user = await getAuth(app).getUserByEmail(email)
  console.log(JSON.stringify({ ownerUid: user.uid, emailVerified: user.emailVerified, googleAccount: user.providerData.some(provider => provider.providerId === 'google.com') }))
  const db = cliFirestore(projectId)
  try {
    const role = await db.doc(`cloudRoles/${user.uid}`).get()
    console.log(JSON.stringify({ ownerRoleAssigned: role.data()?.role === 'owner' }))
  } finally { await db.terminate() }
  const token = await credential.getAccessToken()
  const response = await fetch(`https://cloudbilling.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/billingInfo`, { headers: { Authorization: `Bearer ${token.access_token}` } })
  if (response.ok) {
    const body = await response.json()
    console.log(JSON.stringify({ billingEnabled: body.billingEnabled === true }))
  } else console.log(JSON.stringify({ billingStatusUnavailable: response.status }))
} finally { await deleteApp(app) }
