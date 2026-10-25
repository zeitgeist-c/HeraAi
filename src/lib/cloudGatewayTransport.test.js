import { describe, expect, it, vi } from 'vitest'
import { createCloudGatewayTransport } from './cloudGatewayTransport'

describe('authenticated cloud transport', () => {
  const auth = { currentUser: { uid: 'user1', getIdToken: async () => 'test-token' } }
  it('sends only an operation, never a client UID or role', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: { result: null, quota: { exempt: false } } }) })
    const transport = createCloudGatewayTransport({ endpoint: 'https://example.test/cloud', auth, fetcher })
    await transport.getAccountRoot('forged-uid')
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ data: { action: 'getAccountRoot', args: {} } })
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token')
  })
  it('propagates the server reset time and never falls back to direct Firestore', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: { message: 'daily_quota_exceeded', details: { resetsAt: 123 } } }) })
    const transport = createCloudGatewayTransport({ endpoint: 'https://example.test/cloud', auth, fetcher })
    await expect(transport.beginSync()).rejects.toMatchObject({ code: 'daily_quota_exceeded', resetsAt: 123 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('rejects cleartext remote endpoints', () => {
    expect(() => createCloudGatewayTransport({ endpoint: 'http://example.test', auth })).toThrow('invalid')
  })
})
