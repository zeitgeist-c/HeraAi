import { initializeApp } from 'firebase-admin/app'
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { createCloudGateway } from './gateway.js'
import { GatewayError, dayWindow } from './policy.js'

initializeApp()
const handle = createCloudGateway({ db: getFirestore(), Timestamp, serverTimestamp: () => FieldValue.serverTimestamp() })
export const cloudGateway = onCall({
  region: 'europe-west1', maxInstances: 3, minInstances: 0,
  concurrency: 20, timeoutSeconds: 30, memory: '256MiB',
  // Extension App Check attestation requires a separately validated provider.
  // Auth, server quotas and the public-cloud stop switch remain mandatory.
  enforceAppCheck: false,
}, async request => {
  try { return await handle(request) }
  catch (error) {
    if (error instanceof GatewayError) {
      throw new HttpsError(error.code === 'unauthenticated' ? 'unauthenticated' : 'failed-precondition', error.code, { resetsAt: dayWindow(Date.now()).resetsAt })
    }
    // Never return SDK messages, encrypted payloads, tokens or stack traces.
    throw new HttpsError('internal', 'cloud_gateway_failed')
  }
})
