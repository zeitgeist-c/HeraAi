import { getApps, initializeApp } from 'firebase/app'
import { getAuth, indexedDBLocalPersistence, initializeAuth } from 'firebase/auth/web-extension'
// There is no XMLHttpRequest in the MV3 service worker environment. Firestore
// Lite uses REST/fetch and is therefore compatible with the background service
// worker.
import { getFirestore } from 'firebase/firestore/lite'

/**
 * The Firebase web configuration is embedded at build time (via .env.local). The Firebase web
 * config is designed to be public in the client; it is not a secret key.
 */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || '',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '',
}

const googleOAuthClientId = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID || ''

export function isFirebaseConfigured() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId)
}

export function getGoogleOAuthClientId() {
  return googleOAuthClientId
}

let cachedAuth = null
let cachedFirestore = null

export function getFirebaseApp() {
  if (!isFirebaseConfigured()) throw new Error('firebase_not_configured')
  return getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig)
}

/**
 * Returns the Firebase Auth instance for the service worker and extension pages. The only local
 * persistence supported in the service worker environment is indexedDBLocalPersistence; no
 * popup/redirect resolver is defined.
 */
export function getFirebaseAuth() {
  if (!isFirebaseConfigured()) throw new Error('firebase_not_configured')
  if (cachedAuth) return cachedAuth
  const app = getFirebaseApp()
  try {
    cachedAuth = initializeAuth(app, { persistence: indexedDBLocalPersistence })
  } catch {
    // If Auth was already set up on the same app instance the existing
    // instance is returned.
    cachedAuth = getAuth(app)
  }
  return cachedAuth
}

export function getFirebaseFirestore() {
  if (cachedFirestore) return cachedFirestore
  cachedFirestore = getFirestore(getFirebaseApp())
  return cachedFirestore
}
