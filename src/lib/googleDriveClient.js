const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'

function manifestHasOAuthClient() {
  const clientId = globalThis.chrome?.runtime?.getManifest?.()?.oauth2?.client_id
  return typeof clientId === 'string' && clientId.endsWith('.apps.googleusercontent.com')
}

export function isGoogleDriveSyncConfigured() {
  return Boolean(globalThis.chrome?.identity?.getAuthToken && manifestHasOAuthClient())
}

export async function getGoogleAccessToken(interactive = false) {
  if (!isGoogleDriveSyncConfigured()) throw new Error('sync_not_configured')
  const result = await globalThis.chrome.identity.getAuthToken({ interactive })
  const token = typeof result === 'string' ? result : result?.token
  if (!token) throw new Error('sync_sign_in_failed')
  return token
}

async function driveFetch(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  })
  if (!response.ok) {
    const error = new Error(`drive_request_failed:${response.status}`)
    error.status = response.status
    throw error
  }
  return response
}

export async function findAppDataFile(token, name) {
  const query = encodeURIComponent(`name = '${String(name).replaceAll("'", "\\'")}' and trashed = false`)
  const response = await driveFetch(
    token,
    `${DRIVE_API}/files?spaces=appDataFolder&q=${query}&fields=files(id,name,modifiedTime,appProperties)&pageSize=10`,
  )
  const data = await response.json()
  return data.files?.[0] || null
}

export async function downloadAppDataFile(token, fileId) {
  const response = await driveFetch(token, `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`)
  return new Uint8Array(await response.arrayBuffer())
}

export async function createAppDataFile(token, name, bytes, appProperties = {}) {
  const metadataResponse = await driveFetch(token, `${DRIVE_API}/files?fields=id,name,modifiedTime,appProperties`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: ['appDataFolder'], appProperties }),
  })
  const metadata = await metadataResponse.json()
  await updateAppDataFile(token, metadata.id, bytes)
  return metadata
}

export async function updateAppDataFile(token, fileId, bytes) {
  await driveFetch(token, `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  })
}

export async function deleteAppDataFile(token, fileId) {
  await driveFetch(token, `${DRIVE_API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' })
}

export async function upsertAppDataFile(token, name, bytes, appProperties = {}) {
  const existing = await findAppDataFile(token, name)
  if (existing) {
    await updateAppDataFile(token, existing.id, bytes)
    return existing
  }
  return createAppDataFile(token, name, bytes, appProperties)
}
