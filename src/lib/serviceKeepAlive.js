/**
 * Chrome closes the service worker after 30 seconds of inactivity. During long
 * interactive operations (Google sign-in window, cloud sync) a cheap extension API
 * call resets the timer; it is stopped when the operation ends. That way the panel's
 * message channel does not drop because the service closed mid-operation.
 */
export const KEEP_ALIVE_INTERVAL_MS = 20_000

export function pingExtensionRuntime() {
  try {
    const runtime = globalThis.chrome?.runtime
    if (typeof runtime?.getPlatformInfo !== 'function') return
    runtime.getPlatformInfo(() => { void runtime.lastError })
  } catch (_error) {
    // A ping error does not affect the actual operation.
  }
}

/** Durdurma fonksiyonu dondurur; islem bitince mutlaka cagrilmalidir. */
export function startServiceKeepAlive({
  intervalMs = KEEP_ALIVE_INTERVAL_MS,
  ping = pingExtensionRuntime,
  setIntervalFn = (handler, delayMs) => setInterval(handler, delayMs),
  clearIntervalFn = handle => clearInterval(handle),
} = {}) {
  const handle = setIntervalFn(() => {
    try {
      ping()
    } catch (_error) {
      // A ping error does not affect the actual operation.
    }
  }, intervalMs)
  return () => { clearIntervalFn(handle) }
}
