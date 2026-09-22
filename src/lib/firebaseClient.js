import { getApps, initializeApp } from 'firebase/app'
import { getAuth, indexedDBLocalPersistence, initializeAuth } from 'firebase/auth/web-extension'
import { getFirestore } from 'firebase/firestore'

/**
 * Firebase web konfigurasyonu derleme sirasinda (.env.local uzerinden) gomulur.
 * Firebase web config'i istemciye acik olmak uzere tasarlanmistir; gizli anahtar degildir.
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

export function getFirebaseWebConfig() {
  return { ...firebaseConfig }
}

let cachedAuth = null
let cachedFirestore = null

export function getFirebaseApp() {
  if (!isFirebaseConfigured()) throw new Error('firebase_not_configured')
  return getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig)
}

/**
 * Service worker ve uzanti sayfalari icin Firebase Auth ornegi dondurur.
 * Service worker ortaminda desteklenen tek yerel kalicilik
 * indexedDBLocalPersistence'tir; popup/redirect cozucu tanimlanmaz.
 */
export function getFirebaseAuth() {
  if (!isFirebaseConfigured()) throw new Error('firebase_not_configured')
  if (cachedAuth) return cachedAuth
  const app = getFirebaseApp()
  try {
    cachedAuth = initializeAuth(app, { persistence: indexedDBLocalPersistence })
  } catch {
    // Auth ayni uygulama orneginde daha once kurulmussa mevcut ornege donulur.
    cachedAuth = getAuth(app)
  }
  return cachedAuth
}

export function getFirebaseFirestore() {
  if (cachedFirestore) return cachedFirestore
  cachedFirestore = getFirestore(getFirebaseApp())
  return cachedFirestore
}
