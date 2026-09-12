const MINUTE_MS = 60_000

function toFiniteNumber(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

export function formatDurationMs(durationMs, { live = false } = {}) {
  const ms = toFiniteNumber(durationMs)
  if (ms == null || ms < 0) return ''
  if (ms < MINUTE_MS) {
    return `${(ms / 1000).toFixed(1)} s`
  }
  const totalSeconds = ms / 1000
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds - minutes * 60
  if (live) {
    return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`
  }
  return `${minutes}:${String(Math.floor(seconds)).padStart(2, '0')}`
}

const HIDDEN_TIMER_STATUSES = new Set(['error', 'cancelled', 'cancelled_empty', 'interrupted'])

export function getMessageDurationMs(message, now = Date.now()) {
  if (!message || message.role === 'user') return null
  if (HIDDEN_TIMER_STATUSES.has(message.status)) return null
  const startedAt = toFiniteNumber(message.startedAt)
  if (startedAt == null) return null
  if (message.status === 'done') {
    const completedAt = toFiniteNumber(message.completedAt)
    if (completedAt == null || completedAt < startedAt) return null
    return completedAt - startedAt
  }
  const current = toFiniteNumber(now)
  if (current == null || current < startedAt) return null
  return current - startedAt
}

export function isLiveDurationMessage(message) {
  if (!message || message.role === 'user') return false
  if (HIDDEN_TIMER_STATUSES.has(message.status)) return false
  if (message.status !== 'thinking' && message.status !== 'streaming') return false
  return toFiniteNumber(message.startedAt) != null
}
