/**
 * HeraAi 1.10.0 - API key manager (Stage 6).
 *
 * In 1.9.4 keys sat in plain text inside `chrome.storage.local`. The encrypted vault
 * (`keyVault`) is the single source now; this module is only a thin layer that
 * forwards the calls to the vault, so the UI code moved to secure storage unchanged.
 *
 * `getKeys` returns masked metadata; the raw key is resolved only at request time
 * with `resolveKeysForRequest` / `getRawKey`.
 */

import { getDefaultVault } from './keyVault'
import { createStorageAdapter, migrateLegacyKeys } from './v194Migration'

export { PROVIDERS } from './keyVault'

async function getReadyVault() {
  const vault = await getDefaultVault()
  const storage = createStorageAdapter()
  if (storage.available) await migrateLegacyKeys({ storage, vault })
  return vault
}

async function markVaultChanged(extra = {}) {
  if (!globalThis.chrome?.storage?.local) return
  await globalThis.chrome.storage.local.set({
    syncVaultUpdatedAt: Date.now(),
    ...extra,
  })
}

export async function getKeys(provider) {
  return (await getReadyVault()).listKeys(provider)
}

export async function getRawKey(provider, id) {
  return (await getReadyVault()).getRawKey(provider, id)
}

export async function addKey(provider, rawKey, secenekler) {
  const result = await (await getReadyVault()).addKey(provider, rawKey, secenekler)
  await markVaultChanged()
  return result
}

export async function removeKey(provider, id) {
  const removed = await (await getReadyVault()).removeKey(provider, id)
  if (removed) {
    const existing = await globalThis.chrome?.storage?.local?.get?.(['syncKeyTombstones'])
    await markVaultChanged({
      syncKeyTombstones: {
        ...(existing?.syncKeyTombstones || {}),
        [`${provider}:${id}`]: Date.now(),
      },
    })
  }
  return removed
}

export async function setPrimary(provider, id) {
  const result = await (await getReadyVault()).setPrimary(provider, id)
  if (result) await markVaultChanged()
  return result
}

export async function updateKeyMetadata(provider, id, updates) {
  const result = await (await getReadyVault()).updateKeyMetadata(provider, id, updates)
  if (result) await markVaultChanged()
  return result
}

export async function getAllKeysForRequest(provider) {
  return (await getReadyVault()).getAllKeysForRequest(provider)
}

export async function resolveKeysForRequest(provider) {
  return (await getReadyVault()).resolveKeysForRequest(provider)
}

export async function countKeys() {
  return (await getReadyVault()).countKeys()
}
