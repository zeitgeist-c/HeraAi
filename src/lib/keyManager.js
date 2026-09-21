/**
 * HeraAi 1.10.0 — API anahtarı yöneticisi (Aşama 6).
 *
 * 1.9.4'te anahtarlar `chrome.storage.local` içinde açık metin duruyordu.
 * Artık tek kaynak şifreli kasadır (`keyVault`); bu modül yalnızca çağrıları
 * kasaya yönlendiren ince bir katmandır, böylece arayüz kodu değişmeden
 * güvenli depoya geçilmiştir.
 *
 * `getKeys` maskeli metadata döner; ham anahtar yalnızca istek anında
 * `resolveKeysForRequest` / `getRawKey` ile çözülür.
 */

import { getDefaultVault } from './keyVault'

export { PROVIDERS } from './keyVault'

export async function getKeys(provider) {
  return (await getDefaultVault()).listKeys(provider)
}

export async function getRawKey(provider, id) {
  return (await getDefaultVault()).getRawKey(provider, id)
}

export async function addKey(provider, rawKey, secenekler) {
  return (await getDefaultVault()).addKey(provider, rawKey, secenekler)
}

export async function removeKey(provider, id) {
  return (await getDefaultVault()).removeKey(provider, id)
}

export async function setPrimary(provider, id) {
  return (await getDefaultVault()).setPrimary(provider, id)
}

export async function updateKeyMetadata(provider, id, updates) {
  return (await getDefaultVault()).updateKeyMetadata(provider, id, updates)
}

export async function getAllKeysForRequest(provider) {
  return (await getDefaultVault()).getAllKeysForRequest(provider)
}

export async function resolveKeysForRequest(provider) {
  return (await getDefaultVault()).resolveKeysForRequest(provider)
}

export async function countKeys() {
  return (await getDefaultVault()).countKeys()
}
