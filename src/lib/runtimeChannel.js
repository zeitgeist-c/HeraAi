/**
 * Panel ile arka plan servisi arasindaki mesaj kanali.
 *
 * Chrome servis calisanini kapattiginda kanal duser ve lastError'a ham
 * Ingilizce metinler duser ("The message port closed before a response was
 * received.", "Could not establish connection. Receiving end does not
 * exist."). Bu metinler kullaniciya gosterilmez: hata, arayuzde karsiligi
 * olan sinirli bir kod kumesine indirgenir.
 */

/** Kanal koptugunda kullanilan kod (locale: setup.sync.errors.sync_channel_lost). */
export const SYNC_CHANNEL_LOST = 'sync_channel_lost'

/**
 * Arayuzde metni bulunan kodlar. Listede olmayan bir kod ham metin olarak
 * gosterilmez, sync_failed'a duser; yeni bir kod eklerken iki locale
 * dosyasina da karsiligini yazmak gerekir.
 */
export const KNOWN_SYNC_ERROR_CODES = new Set([
  // Servis/kanal
  SYNC_CHANNEL_LOST,
  'sync_failed',
  'sync_unknown_request',
  // Bulut/aktarim
  'quota_exceeded',
  'rules_denied',
  'offline',
  'sync_signed_out',
  'sync_version_unsupported',
  'sync_chunk_incomplete',
  'sync_payload_invalid',
  'sync_recovery_required',
  'sync_account_missing',
  'sync_account_exists',
  'sync_device_disabled',
  'sync_device_not_linked',
  'sync_not_enabled',
  'backup_invalid',
  // Google girisi
  'auth_failed',
  'auth_cancelled',
  'auth_flow_failed',
  'auth_state_mismatch',
  'auth_nonce_mismatch',
  'auth_token_missing',
  'auth_token_invalid',
  'identity_unavailable',
  'firebase_not_configured',
  'google_oauth_not_configured',
])

const CHANNEL_LOSS_PATTERN = /message port closed|receiving end does not exist|extension context invalidated/i

export function isChannelLossMessage(message) {
  return CHANNEL_LOSS_PATTERN.test(String(message || ''))
}

/**
 * Ham hata -> arayuzde metni olan kod. Kanal kopmasi kendi koduna iner,
 * taninmayan her sey sync_failed olur: ekrana ham Chrome metni cikmaz.
 */
export function describeRuntimeError(error) {
  const code = typeof error === 'string' ? error : String(error?.code || '')
  if (KNOWN_SYNC_ERROR_CODES.has(code)) return code
  const message = typeof error === 'string' ? error : String(error?.message || '')
  if (isChannelLossMessage(message)) return SYNC_CHANNEL_LOST
  if (KNOWN_SYNC_ERROR_CODES.has(message)) return message
  return 'sync_failed'
}

/**
 * chrome.runtime.sendMessage'i Promise'e cevirir. Kanal kopmasinda reddeder;
 * metni ham birakir, indirgeme describeRuntimeError'a aittir.
 */
export function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, response => {
        const lastError = chrome.runtime?.lastError
        if (lastError) reject(new Error(lastError.message || SYNC_CHANNEL_LOST))
        else resolve(response)
      })
    } catch (error) {
      reject(error)
    }
  })
}

const wait = delayMs => new Promise(resolve => setTimeout(resolve, delayMs))

/**
 * Kanal kopmasindan sonra isin gercekten tamamlanip tamamlanmadigini sorar:
 * her tur taze bir mesajla durum okur (servis uyanir, sonuc kalicidir).
 * Sorgu sirasinda kanal yine kopabilir; sonraki turda yeniden denenir.
 */
export async function pollForResult({ check, attempts = 4, delayMs = 800, waitFn = wait }) {
  const total = Math.max(1, Number(attempts) || 1)
  for (let attempt = 0; attempt < total; attempt += 1) {
    if (attempt > 0) await waitFn(delayMs)
    try {
      const result = await check()
      if (result) return result
    } catch (_error) {
      // Kanal yine kopmus olabilir; sonraki turda tekrar sorulur.
    }
  }
  return null
}
