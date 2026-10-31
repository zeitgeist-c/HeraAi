import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signOut,
} from 'firebase/auth/web-extension'

import { getFirebaseAuth, getGoogleOAuthClientId, isFirebaseConfigured } from './firebaseClient'

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const AUTH_SCOPE = 'openid email profile'

/** Limited set of error codes the UI may show to the user. */
export const AUTH_ERROR_CODES = new Set([
  'firebase_not_configured',
  'google_oauth_not_configured',
  'identity_unavailable',
  'auth_cancelled',
  'auth_flow_failed',
  'auth_state_mismatch',
  'auth_nonce_mismatch',
  'auth_token_missing',
  'auth_token_invalid',
])

function authError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function randomToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function buildAuthUrl({ clientId, redirectUri, state, nonce }) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'id_token',
    redirect_uri: redirectUri,
    scope: AUTH_SCOPE,
    state,
    nonce,
    prompt: 'select_account',
  })
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`
}

export function parseAuthResponseParams(responseUrl) {
  const url = new URL(responseUrl)
  const source = url.hash && url.hash.length > 1 ? url.hash.slice(1) : url.search
  return new URLSearchParams(source)
}

export function decodeIdTokenPayload(idToken) {
  const segments = String(idToken || '').split('.')
  if (segments.length !== 3) throw authError('auth_token_invalid')
  const base64 = segments[1].replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  try {
    return JSON.parse(atob(padded))
  } catch {
    throw authError('auth_token_invalid')
  }
}

function launchAuthFlow(url) {
  return new Promise((resolve, reject) => {
    try {
      globalThis.chrome.identity.launchWebAuthFlow({ url, interactive: true }, (responseUrl) => {
        const lastError = globalThis.chrome.runtime?.lastError
        if (lastError) {
          const message = String(lastError.message || '')
          reject(authError(/did not approve|cancel/i.test(message) ? 'auth_cancelled' : 'auth_flow_failed'))
          return
        }
        resolve(responseUrl || null)
      })
    } catch (_error) {
      reject(authError('auth_flow_failed'))
    }
  })
}

function toAuthUser(user) {
  if (!user?.uid) return null
  return { uid: user.uid, email: user.email || null }
}

export function isGoogleSignInConfigured() {
  return isFirebaseConfigured() && Boolean(getGoogleOAuthClientId())
}

/**
 * Google OAuth identity flow: launchWebAuthFlow obtains the id_token, state and nonce are
 * verified and the Firebase session is opened with signInWithCredential. The password is never
 * held on the HeraAi side at any stage.
 */
export async function signInWithGoogle() {
  if (!isFirebaseConfigured()) throw authError('firebase_not_configured')
  const clientId = getGoogleOAuthClientId()
  if (!clientId) throw authError('google_oauth_not_configured')
  if (!globalThis.chrome?.identity?.launchWebAuthFlow) throw authError('identity_unavailable')

  const redirectUri = globalThis.chrome.identity.getRedirectURL()
  const state = randomToken()
  const nonce = randomToken()

  const responseUrl = await launchAuthFlow(buildAuthUrl({ clientId, redirectUri, state, nonce }))
  if (!responseUrl) throw authError('auth_cancelled')

  const params = parseAuthResponseParams(responseUrl)
  if (params.get('state') !== state) throw authError('auth_state_mismatch')
  if (params.get('error')) throw authError('auth_cancelled')

  const idToken = params.get('id_token')
  if (!idToken) throw authError('auth_token_missing')

  const payload = decodeIdTokenPayload(idToken)
  if (payload.nonce !== nonce) throw authError('auth_nonce_mismatch')

  const credential = GoogleAuthProvider.credential(idToken)
  const result = await signInWithCredential(getFirebaseAuth(), credential)
  return toAuthUser(result?.user)
}

export async function signOutFromGoogle() {
  if (!isFirebaseConfigured()) return
  await signOut(getFirebaseAuth())
}

export function getCurrentAuthUser() {
  if (!isFirebaseConfigured()) return null
  return toAuthUser(getFirebaseAuth().currentUser)
}

export async function waitForCurrentAuthUser() {
  if (!isFirebaseConfigured()) return null
  const auth = getFirebaseAuth()
  if (typeof auth.authStateReady === 'function') await auth.authStateReady()
  return toAuthUser(auth.currentUser)
}

export function subscribeToAuthChanges(handler) {
  if (!isFirebaseConfigured()) return () => {}
  return onAuthStateChanged(getFirebaseAuth(), user => handler(toAuthUser(user)))
}
