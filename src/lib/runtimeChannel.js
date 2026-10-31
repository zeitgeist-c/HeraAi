/**
 * Message channel between the panel and the background service.
 *
 * When Chrome shuts the service worker down the channel drops and raw English
 * texts land in lastError ("The message port closed before a response was
 * received.", "Could not establish connection. Receiving end does not
 * exist."). Those texts are not shown to the user: the error is reduced to a
 * limited set of codes that have a UI translation.
 */

/** Kanal koptugunda kullanilan kod (locale: setup.sync.errors.sync_channel_lost). */
export const SYNC_CHANNEL_LOST = 'sync_channel_lost'

/**
 * Codes that have UI text. A code not on the list is not shown as raw text, it falls
 * back to sync_failed; when adding a code its translation must be written into both
 * locale files.
 */
export const KNOWN_SYNC_ERROR_CODES = new Set([
  // Servis/kanal
  SYNC_CHANNEL_LOST,
  'sync_failed',
  'sync_busy',
  'sync_paused',
  'sync_index_required',
  'sync_precondition_failed',
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
 * Raw error -> a code that has UI text. A channel drop maps to its own code, anything
 * unrecognized becomes sync_failed: no raw Chrome text reaches the screen.
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
 * Asks whether the work really completed after a channel drop: each round reads the
 * status with a fresh message (the service wakes up, the result is durable). The
 * channel may drop again during the query; it is retried on the next round.
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
