import { beforeEach, describe, expect, it, vi } from 'vitest'

const authMocks = vi.hoisted(() => ({
  credential: vi.fn(token => ({ idToken: token })),
  onAuthStateChanged: vi.fn(),
  signInWithCredential: vi.fn(),
  signOut: vi.fn(),
}))

vi.mock('firebase/auth/web-extension', () => ({
  GoogleAuthProvider: { credential: authMocks.credential },
  onAuthStateChanged: authMocks.onAuthStateChanged,
  signInWithCredential: authMocks.signInWithCredential,
  signOut: authMocks.signOut,
}))

const authInstance = { currentUser: null }

const clientMocks = vi.hoisted(() => ({
  isFirebaseConfigured: vi.fn(),
  getGoogleOAuthClientId: vi.fn(),
  getFirebaseAuth: vi.fn(),
}))

vi.mock('./firebaseClient', () => ({
  isFirebaseConfigured: clientMocks.isFirebaseConfigured,
  getGoogleOAuthClientId: clientMocks.getGoogleOAuthClientId,
  getFirebaseAuth: clientMocks.getFirebaseAuth,
}))

import {
  decodeIdTokenPayload,
  getCurrentAuthUser,
  isGoogleSignInConfigured,
  signInWithGoogle,
  signOutFromGoogle,
  subscribeToAuthChanges,
} from './authService'

const REDIRECT_URL = 'https://pldmkijahkhpacdjflkkgipnkcgehfoj.chromiumapp.org/'
const CLIENT_ID = 'heraai-client.apps.googleusercontent.com'

function makeIdToken(payload) {
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = btoa(JSON.stringify(payload))
  return `${header}.${body}.test-signature`
}

function installChromeIdentity(handler) {
  const launchWebAuthFlow = vi.fn((options, callback) => {
    const result = handler(options)
    if (result?.lastError) {
      globalThis.chrome.runtime.lastError = { message: result.lastError }
    }
    callback(result?.responseUrl ?? undefined)
    globalThis.chrome.runtime.lastError = null
  })
  globalThis.chrome = {
    ...globalThis.chrome,
    runtime: { ...(globalThis.chrome?.runtime || {}), lastError: null },
    identity: {
      launchWebAuthFlow,
      getRedirectURL: vi.fn(() => REDIRECT_URL),
    },
  }
  return launchWebAuthFlow
}

function echoIdentity({ nonceOverride, stateOverride, errorCode } = {}) {
  return installChromeIdentity((options) => {
    const url = new URL(options.url)
    const state = stateOverride ?? url.searchParams.get('state')
    const nonce = nonceOverride ?? url.searchParams.get('nonce')
    if (errorCode) {
      return { responseUrl: `${REDIRECT_URL}#error=${errorCode}&state=${state}` }
    }
    const idToken = makeIdToken({ sub: 'uid-1', email: 'user@example.com', nonce })
    return { responseUrl: `${REDIRECT_URL}#id_token=${idToken}&state=${state}` }
  })
}

describe('authService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clientMocks.isFirebaseConfigured.mockReturnValue(true)
    clientMocks.getGoogleOAuthClientId.mockReturnValue(CLIENT_ID)
    clientMocks.getFirebaseAuth.mockReturnValue(authInstance)
    authMocks.signInWithCredential.mockResolvedValue({
      user: { uid: 'uid-1', email: 'user@example.com' },
    })
    authMocks.signOut.mockResolvedValue(undefined)
  })

  it('id_token ile Firebase oturumunu açar ve kullanıcı bilgisini döner', async () => {
    const launch = echoIdentity()
    const user = await signInWithGoogle()

    expect(user).toEqual({ uid: 'uid-1', email: 'user@example.com' })
    const options = launch.mock.calls[0][0]
    const url = new URL(options.url)
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('id_token')
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URL)
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    expect(options.interactive).toBe(true)
    expect(authMocks.credential).toHaveBeenCalledWith(expect.any(String))
    expect(authMocks.signInWithCredential).toHaveBeenCalledWith(
      authInstance,
      expect.objectContaining({ idToken: expect.any(String) }),
    )
  })

  it('state uyuşmazlığında akışı reddeder', async () => {
    echoIdentity({ stateOverride: 'saldirgan-state' })
    await expect(signInWithGoogle()).rejects.toThrow('auth_state_mismatch')
    expect(authMocks.signInWithCredential).not.toHaveBeenCalled()
  })

  it('nonce uyuşmazlığında akışı reddeder', async () => {
    echoIdentity({ nonceOverride: 'yanlis-nonce' })
    await expect(signInWithGoogle()).rejects.toThrow('auth_nonce_mismatch')
    expect(authMocks.signInWithCredential).not.toHaveBeenCalled()
  })

  it('kullanıcı pencereyi kapatırsa iptal hatası döner', async () => {
    installChromeIdentity(() => ({ lastError: 'The user did not approve access.' }))
    await expect(signInWithGoogle()).rejects.toThrow('auth_cancelled')
  })

  it('sağlayıcı error parametresi döndürürse iptal olarak işler', async () => {
    echoIdentity({ errorCode: 'access_denied' })
    await expect(signInWithGoogle()).rejects.toThrow('auth_cancelled')
  })

  it('Firebase yapılandırılmamışsa açık hata fırlatır', async () => {
    clientMocks.isFirebaseConfigured.mockReturnValue(false)
    await expect(signInWithGoogle()).rejects.toThrow('firebase_not_configured')
  })

  it('OAuth istemci kimliği yoksa açık hata fırlatır', async () => {
    clientMocks.getGoogleOAuthClientId.mockReturnValue('')
    await expect(signInWithGoogle()).rejects.toThrow('google_oauth_not_configured')
  })

  it('id_token gövdesi çözülemezse açık hata fırlatır', () => {
    expect(() => decodeIdTokenPayload('bozuk-token')).toThrow('auth_token_invalid')
  })

  it('mevcut kullanıcıyı ve yapılandırma durumunu bildirir', () => {
    expect(getCurrentAuthUser()).toBeNull()
    clientMocks.getFirebaseAuth.mockReturnValue({
      currentUser: { uid: 'uid-9', email: 'x@y.com' },
    })
    expect(getCurrentAuthUser()).toEqual({ uid: 'uid-9', email: 'x@y.com' })
    expect(isGoogleSignInConfigured()).toBe(true)
  })

  it('çıkışta Firebase signOut çağrılır', async () => {
    await signOutFromGoogle()
    expect(authMocks.signOut).toHaveBeenCalledWith(authInstance)
  })

  it('kimlik değişikliklerini sade kullanıcı nesnesiyle iletir', () => {
    const unsubscribe = vi.fn()
    let captured
    authMocks.onAuthStateChanged.mockImplementation((_auth, handler) => {
      captured = handler
      return unsubscribe
    })

    const handler = vi.fn()
    const result = subscribeToAuthChanges(handler)
    captured({ uid: 'uid-2', email: 'z@w.com' })

    expect(handler).toHaveBeenCalledWith({ uid: 'uid-2', email: 'z@w.com' })
    expect(result).toBe(unsubscribe)
  })
})
