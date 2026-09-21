import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('firebaseClient', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_FIREBASE_API_KEY', '')
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', '')
    vi.stubEnv('VITE_FIREBASE_APP_ID', '')
    vi.stubEnv('VITE_GOOGLE_OAUTH_CLIENT_ID', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('konfigürasyon boşken yapılandırılmamış sayılır ve auth istemez', async () => {
    const { getFirebaseAuth, isFirebaseConfigured } = await import('./firebaseClient')

    expect(isFirebaseConfigured()).toBe(false)
    expect(() => getFirebaseAuth()).toThrow('firebase_not_configured')
  })

  it('zorunlu alanlardan biri eksikse yapılandırılmış sayılmaz', async () => {
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'test-api-key')
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', '')
    vi.stubEnv('VITE_FIREBASE_APP_ID', '1:2:web:3')

    const { isFirebaseConfigured } = await import('./firebaseClient')

    expect(isFirebaseConfigured()).toBe(false)
  })

  it('OAuth istemci kimliğini derleme ortamından okur', async () => {
    vi.stubEnv('VITE_GOOGLE_OAUTH_CLIENT_ID', 'client.apps.googleusercontent.com')

    const { getGoogleOAuthClientId } = await import('./firebaseClient')

    expect(getGoogleOAuthClientId()).toBe('client.apps.googleusercontent.com')
  })
})
