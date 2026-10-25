import { getFirebaseAuth } from './firebaseClient'

export const CLOUD_GATEWAY_URL = import.meta.env.VITE_CLOUD_GATEWAY_URL || ''
const ERROR_CODES = new Set(['unauthenticated', 'daily_quota_exceeded', 'public_quota_exceeded', 'public_cloud_paused', 'cloud_migration_required', 'account_capacity_exceeded', 'legacy_cleanup_admin_required', 'request_too_large', 'invalid_request'])

export function createCloudGatewayTransport({ endpoint = CLOUD_GATEWAY_URL, auth = getFirebaseAuth(), fetcher = fetch } = {}) {
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('cloud_gateway_invalid')
  async function call(action, args = {}) {
    const user = auth.currentUser
    if (!user) throw new Error('sync_signed_out')
    const token = await user.getIdToken()
    const response = await fetcher(url.href, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ data: { action, args } }), credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(35_000),
    })
    const body = await response.json()
    if (!response.ok || body.error) {
      const code = ERROR_CODES.has(body.error?.message) ? body.error.message : 'cloud_gateway_failed'
      const error = new Error(code)
      error.code = code
      error.resetsAt = Number(body.error?.details?.resetsAt) || null
      throw error
    }
    const envelope = body.result
    if (!envelope || !Object.hasOwn(envelope, 'result') || !envelope.quota) throw new Error('cloud_gateway_invalid_response')
    await chrome.storage.local.set({ cloudQuota: { ...envelope.quota, uid: user.uid } })
    return envelope.result
  }
  async function pagedDelete(action, args) {
    let afterId = null, total = 0
    for (let page = 0; page < 1000; page += 1) {
      const response = await call(action, { ...args, afterId })
      total += response.deleted
      if (!response.afterId) return total
      afterId = response.afterId
    }
    throw new Error('cloud_gateway_page_limit')
  }
  return {
    beginSync: () => call('beginSync'),
    getQuota: () => call('status'),
    getAccountRoot: _uid => call('getAccountRoot'),
    setAccountRoot: (_uid, value) => call('setAccountRoot', { value }),
    getDevice: (_uid, deviceId) => call('getDevice', { deviceId }),
    setDevice: (_uid, deviceId, value) => call('setDevice', { deviceId, value }),
    listDevices: _uid => call('listDevices'),
    async pushEntities({ documents }) {
      const applied = []
      // Small calls bound both HTTP payloads and transaction work.
      for (const document of documents) {
        const result = await call('pushEntities', { documents: [document] })
        applied.push(...result.applied)
      }
      return { applied }
    },
    pullEntities: ({ cursor }) => call('pullEntities', { cursor }),
    async setEntityChunks(_uid, opaqueEntityId, revision, chunks) {
      for (const chunk of chunks) await call('setEntityChunks', { opaqueEntityId, revision, chunks: [chunk] })
    },
    async getEntityChunks(_uid, opaqueEntityId, revision) {
      let afterId = null
      const chunks = []
      for (let page = 0; page < 10001; page += 1) {
        const result = await call('getEntityChunks', { opaqueEntityId, revision, afterId })
        chunks.push(...result.chunks)
        if (!result.afterId) return chunks.sort((a, b) => a.index - b.index)
        afterId = result.afterId
      }
      throw new Error('cloud_gateway_page_limit')
    },
    deleteStaleEntityChunks: (_uid, opaqueEntityId, keepRevision) => pagedDelete('deleteStaleEntityChunks', { opaqueEntityId, keepRevision }),
    deleteEntityChunksRevision: (_uid, opaqueEntityId, revision) => pagedDelete('deleteEntityChunksRevision', { opaqueEntityId, revision }),
    cleanLegacyCloudData: _uid => call('cleanLegacyCloudData'),
  }
}
