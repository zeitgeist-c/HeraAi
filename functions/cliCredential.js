// Local operator tooling only. Never imported by the deployed gateway.
import { getAccessToken, getGlobalDefaultAccount } from 'firebase-tools/lib/auth.js'
import { clientId, clientSecret } from 'firebase-tools/lib/api.js'
import { Firestore } from 'firebase-admin/firestore'

export function cliFirestore(projectId) {
  const account = getGlobalDefaultAccount()
  if (!account?.tokens?.refresh_token) throw new Error('Firebase CLI login required')
  // In-memory authorized-user credentials; no service-account key or ADC file.
  return new Firestore({ projectId, credentials: {
    type: 'authorized_user', client_id: clientId(), client_secret: clientSecret(), refresh_token: account.tokens.refresh_token,
  } })
}

export function cliCredential() {
  const account = getGlobalDefaultAccount()
  if (!account?.tokens?.refresh_token) throw new Error('Firebase CLI login required')
  return { getAccessToken: async () => {
    const token = await getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform'])
    return { access_token: token.access_token, expires_in: Math.max(1, Math.floor((token.expires_at - Date.now()) / 1000)) }
  } }
}
