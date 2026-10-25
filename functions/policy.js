export const USER_LIMITS = Object.freeze({
  syncs: 60, requests: 1000, reads: 5000, writes: 2000,
  bytes: 10 * 1024 * 1024, storageBytes: 10 * 1024 * 1024, devices: 3,
})
export const PUBLIC_LIMITS = Object.freeze({ reads: 35000, writes: 12000, bytes: 512 * 1024 * 1024 })
export class GatewayError extends Error {
  constructor(code) { super(code); this.code = code }
}
export const fail = code => { throw new GatewayError(code) }
export const byteSize = value => new TextEncoder().encode(JSON.stringify(value ?? null, (key, item) => key === 'serverUpdatedAt' ? undefined : item)).length
export function dayWindow(now) {
  const date = new Date(now)
  return { day: date.toISOString().slice(0, 10), resetsAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) }
}
export function incrementUsage(previous, cost, limits, exempt = false) {
  const next = { ...previous }
  for (const [key, value] of Object.entries(cost)) {
    if (!Number.isSafeInteger(value) || value < 0) fail('invalid_request')
    next[key] = (Number(previous?.[key]) || 0) + value
    if (!exempt && limits[key] !== undefined && next[key] > limits[key]) fail('daily_quota_exceeded')
  }
  return next
}
export function incrementPublicUsage(previous, cost) {
  try { return incrementUsage(previous, cost, PUBLIC_LIMITS) }
  catch (error) {
    if (error.code === 'daily_quota_exceeded') fail('public_quota_exceeded')
    throw error
  }
}
export function segment(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) fail('invalid_request')
  return value
}
export function compareVersions(a, b) {
  if (!a || !Number.isSafeInteger(a.wallTimeMs) || a.wallTimeMs < 0
    || !Number.isSafeInteger(a.logicalCounter) || a.logicalCounter < 0
    || typeof a.deviceId !== 'string') fail('invalid_request')
  if (!b) return 1
  return a.wallTimeMs - b.wallTimeMs || a.logicalCounter - b.logicalCounter || (a.deviceId === b.deviceId ? 0 : a.deviceId > b.deviceId ? 1 : -1)
}
