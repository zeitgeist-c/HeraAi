/**
 * Chrome servis calisani 30 saniye hareketsizlikte kendini kapatir. Uzun suren
 * etkilesimli islemler (Google giris penceresi, bulut esitleme) boyunca ucuz bir
 * extension API cagrisi zamanlayiciyi sifirlar; islem bitince durdurulur.
 * Boylece panelin mesaj kanali, islem surerken servis kapanmasi yuzunden kopmaz.
 */
export const KEEP_ALIVE_INTERVAL_MS = 20_000

export function pingExtensionRuntime() {
  try {
    const runtime = globalThis.chrome?.runtime
    if (typeof runtime?.getPlatformInfo !== 'function') return
    runtime.getPlatformInfo(() => { void runtime.lastError })
  } catch (_error) {
    // Ping hatasi asil islemi etkilemez.
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
      // Ping hatasi asil islemi etkilemez.
    }
  }, intervalMs)
  return () => { clearIntervalFn(handle) }
}
