/**
 * In-panel automatic sync scheduler.
 *
 * Why inside the panel: `chrome.alarms` needs a new permission and Chrome disables an
 * extension that adds one and asks the user to approve (manual approval 20 times on
 * 20 devices). The panel's own timer runs without a permission and already gives the
 * right behaviour: it never runs while the panel is closed, so no quota is wasted.
 *
 * Cost note: even an empty pull query counts as at least one read. The device check,
 * the last-seen write and the new gateway counters produce operations as well. The
 * local counter is an estimate; it is not the server's account quota or the Firebase bill.
 */
import { isSyncedKey } from './syncContract'

/** Storage key of the panel setting (device specific, not synced). */
export const AUTO_SYNC_INTERVAL_KEY = 'syncAutoIntervalMinutes'
/** Daily quota usage counter (device specific, not synced). */
export const AUTO_SYNC_USAGE_KEY = 'syncUsage'

/** Selectable intervals (minutes); 0 = off. */
export const AUTO_SYNC_OPTIONS_MINUTES = Object.freeze([0, 60, 120, 360])
export const DEFAULT_AUTO_SYNC_MINUTES = 60
/** Random jitter added to every run so 20 devices do not load at the same second. */
export const AUTO_SYNC_JITTER_MS = 3 * 60 * 1000
/** Send delay after a local change (back-to-back changes coalesce). */
export const LOCAL_CHANGE_SYNC_DELAY_MS = 60 * 1000
/** If the user is not active during this period the periodic run is skipped. */
export const AUTO_SYNC_IDLE_MS = 10 * 60 * 1000
/** When half the quota is used the interval is stretched by this factor (slow mode). */
export const AUTO_SYNC_SLOW_FACTOR = 4
export const AUTO_SYNC_SLOW_THRESHOLD = 0.5
/** Firestore Spark free quota (daily). */
export const FREE_TIER_READS_PER_DAY = 50_000
export const FREE_TIER_WRITES_PER_DAY = 20_000

/** Validates a writable interval; an unknown value falls back to the default. */
export function normalizeAutoSyncMinutes(value) {
  const minutes = Number(value)
  return AUTO_SYNC_OPTIONS_MINUTES.includes(minutes) ? minutes : DEFAULT_AUTO_SYNC_MINUTES
}

/**
 * Does the storage patch being written touch a synced key?
 * Only synced keys trigger automatic sync; device specific keys such as
 * `activeSessionId` must not start a run for nothing.
 */
export function touchesSyncedKeys(values) {
  if (!values || typeof values !== 'object') return false
  return Object.keys(values).some(isSyncedKey)
}

/** Daily quota usage ratios (a value above 1 means overflow). */
export function quotaUsageRatio(usage) {
  const reads = Math.max(0, Number(usage?.reads) || 0)
  const writes = Math.max(0, Number(usage?.writes) || 0)
  const readRatio = reads / FREE_TIER_READS_PER_DAY
  const writeRatio = writes / FREE_TIER_WRITES_PER_DAY
  return { reads: readRatio, writes: writeRatio, worst: Math.max(readRatio, writeRatio) }
}

/** Is half the quota used? If so the interval is stretched and the panel warns. */
export function isSlowMode(usage) {
  return quotaUsageRatio(usage).worst >= AUTO_SYNC_SLOW_THRESHOLD
}

/**
 * Interval + random jitter (0 when off).
 * Note: the value is not validated here - intermediate values multiplied by the slow
 * mode factor (for example 240 minutes) must pass too; validation of the selectable
 * values is done by `normalizeAutoSyncMinutes`.
 */
export function autoSyncDelayMs(minutes, random = Math.random, jitterMs = AUTO_SYNC_JITTER_MS) {
  const base = Math.max(0, Number(minutes) || 0) * 60_000
  if (base === 0) return 0
  const kayma = Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * jitterMs)
  return base + kayma
}

/** Should the periodic run be skipped? ('hidden' | 'idle' | null) */
export function autoSyncSkipReason({ hidden, lastActivityAt, now, idleMs = AUTO_SYNC_IDLE_MS }) {
  if (hidden) return 'hidden'
  if (Number.isFinite(lastActivityAt) && Number.isFinite(now) && now - lastActivityAt >= idleMs) {
    return 'idle'
  }
  return null
}

/**
 * Sets up the scheduler. All side effects are injected, so a unit test can verify it
 * exactly with a fake timer and a fake store.
 *
 * @param {object} deps
 * @param {() => Promise<unknown>} deps.requestSync  triggers the sync
 * @param {() => Promise<unknown>} [deps.requestSyncAfterChange]  trigger after a local
 * change (default: `requestSync`); the caller may send it on the path that is not
 * subject to the interval threshold.
 * @param {() => boolean} deps.isHidden              is the panel hidden
 * @param {() => number} deps.getLastActivityAt      last user activity (ms)
 * @param {() => object|null} deps.getUsage          daily quota counter
 * @param {() => number} deps.getIntervalMinutes     selected interval (minutes)
 */
export function createAutoSyncScheduler({
  requestSync,
  requestSyncAfterChange = null,
  isHidden = () => false,
  getLastActivityAt = () => Date.now(),
  getUsage = () => null,
  getIntervalMinutes = () => DEFAULT_AUTO_SYNC_MINUTES,
  random = Math.random,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = id => clearTimeout(id),
} = {}) {
  let periodicTimer = null
  let changeTimer = null
  let stopped = true

  function clearPeriodic() {
    if (periodicTimer != null) {
      cancel(periodicTimer)
      periodicTimer = null
    }
  }

  function clearChange() {
    if (changeTimer != null) {
      cancel(changeTimer)
      changeTimer = null
    }
  }

  function skipReason() {
    return autoSyncSkipReason({ hidden: isHidden(), lastActivityAt: getLastActivityAt(), now: now() })
  }

  async function fire(trigger = requestSync) {
    try {
      await trigger()
    } catch {
      // Silent: it is retried on the next round; quota/session errors are
      // already handled
      // in the coordinator and shown in the panel.
    }
  }

  /** Schedules the next periodic run (does not schedule when off). */
  function planNext() {
    clearPeriodic()
    if (stopped) return
    const minutes = normalizeAutoSyncMinutes(getIntervalMinutes())
    if (minutes === 0) return
    const factor = isSlowMode(getUsage()) ? AUTO_SYNC_SLOW_FACTOR : 1
    periodicTimer = schedule(() => {
      periodicTimer = null
      void tick()
    }, autoSyncDelayMs(minutes * factor, random))
  }

  /** Periodic round: skips when hidden/idle, then schedules the next one. */
  async function tick() {
    if (stopped) return
    if (!skipReason()) await fire()
    planNext()
  }

  /** Single run after a local change; back-to-back changes merge into one run. */
  function noteLocalChange() {
    if (stopped || changeTimer != null) return
    changeTimer = schedule(() => {
      changeTimer = null
      if (stopped || skipReason()) return
      void fire(requestSyncAfterChange || requestSync)
    }, LOCAL_CHANGE_SYNC_DELAY_MS)
  }

  function start() {
    if (!stopped) return
    stopped = false
    planNext()
  }

  function stop() {
    stopped = true
    clearPeriodic()
    clearChange()
  }

  return { start, stop, noteLocalChange, tick, planNext }
}
