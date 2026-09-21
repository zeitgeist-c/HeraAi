export const SYNC_SCHEMA_VERSION = 1

const numericTime = value => Number.isFinite(Number(value)) ? Number(value) : 0

function mapSessions(sessions) {
  return new Map((Array.isArray(sessions) ? sessions : [])
    .filter(session => session?.id)
    .map(session => [String(session.id), session]))
}

function mergeTimedMap(left, right) {
  const result = { ...(left || {}) }
  for (const [key, value] of Object.entries(right || {})) {
    const current = result[key]
    if (!current || numericTime(value?.updatedAt) >= numericTime(current?.updatedAt)) result[key] = value
  }
  return result
}

function entryTime(entry) {
  return Math.max(
    numericTime(entry?.updatedAt),
    numericTime(entry?.lastUsedAt),
    numericTime(entry?.lastSuccessAt),
    numericTime(entry?.lastErrorAt),
    numericTime(entry?.createdAt),
  )
}

function mergeVault(localVault, remoteVault, tombstones) {
  const result = {}
  const providers = new Set([...Object.keys(localVault || {}), ...Object.keys(remoteVault || {})])
  for (const provider of providers) {
    const entries = new Map()
    for (const entry of remoteVault?.[provider] || []) if (entry?.id) entries.set(String(entry.id), entry)
    for (const entry of localVault?.[provider] || []) {
      if (!entry?.id) continue
      const current = entries.get(String(entry.id))
      if (!current || entryTime(entry) >= entryTime(current)) entries.set(String(entry.id), entry)
    }
    for (const [id, entry] of entries) {
      const deletedAt = numericTime(tombstones?.[`${provider}:${id}`])
      if (deletedAt >= entryTime(entry)) entries.delete(id)
    }
    result[provider] = Array.from(entries.values())
  }
  return result
}

export function mergeSyncSnapshots(localSnapshot, remoteSnapshot) {
  const local = localSnapshot || {}
  const remote = remoteSnapshot || {}
  const sessions = mapSessions(remote.sessions)
  for (const [id, session] of mapSessions(local.sessions)) {
    const existing = sessions.get(id)
    if (!existing || numericTime(session.updatedAt) >= numericTime(existing.updatedAt)) sessions.set(id, session)
  }

  const tombstones = { ...(remote.sessionTombstones || {}) }
  for (const [id, deletedAt] of Object.entries(local.sessionTombstones || {})) {
    tombstones[id] = Math.max(numericTime(tombstones[id]), numericTime(deletedAt))
  }
  for (const [id, deletedAt] of Object.entries(tombstones)) {
    const session = sessions.get(id)
    if (session && numericTime(deletedAt) >= numericTime(session.updatedAt)) sessions.delete(id)
    else if (session) delete tombstones[id]
  }

  const localSettingsAt = numericTime(local.settingsUpdatedAt)
  const remoteSettingsAt = numericTime(remote.settingsUpdatedAt)
  const vaultTombstones = { ...(remote.vaultTombstones || {}) }
  for (const [key, deletedAt] of Object.entries(local.vaultTombstones || {})) {
    vaultTombstones[key] = Math.max(numericTime(vaultTombstones[key]), numericTime(deletedAt))
  }

  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    updatedAt: Math.max(Date.now(), numericTime(local.updatedAt), numericTime(remote.updatedAt)),
    settings: localSettingsAt >= remoteSettingsAt ? (local.settings || {}) : (remote.settings || {}),
    settingsUpdatedAt: Math.max(localSettingsAt, remoteSettingsAt),
    sessions: Array.from(sessions.values()).sort((a, b) => numericTime(b.updatedAt) - numericTime(a.updatedAt)),
    sessionTombstones: tombstones,
    statsByDevice: mergeTimedMap(remote.statsByDevice, local.statsByDevice),
    vault: mergeVault(local.vault, remote.vault, vaultTombstones),
    vaultTombstones,
    vaultUpdatedAt: Math.max(numericTime(local.vaultUpdatedAt), numericTime(remote.vaultUpdatedAt)),
    attachments: mergeTimedMap(remote.attachments, local.attachments),
  }
}

function addNumber(target, source, key) {
  target[key] = (Number(target[key]) || 0) + (Number(source?.[key]) || 0)
}

function addModels(target, source) {
  for (const [key, row] of Object.entries(source || {})) {
    if (!target[key]) {
      target[key] = { modelId: row.modelId, provider: row.provider, attempts: 0, successes: 0, successDurationMs: 0 }
    }
    addNumber(target[key], row, 'attempts')
    addNumber(target[key], row, 'successes')
    addNumber(target[key], row, 'successDurationMs')
  }
}

export function aggregateDeviceStats(statsByDevice) {
  const result = {
    schemaVersion: 2,
    lastActive: null,
    lifetime: {
      prompts: 0,
      byOutcome: { completed: 0, error: 0, interrupted: 0, cancelled: 0 },
      successDurationMs: 0,
      tools: { voice: 0, screenshot: 0, search: 0 },
      models: {},
    },
    days: {},
    legacyTools: { voice: 0, screenshot: 0, search: 0 },
    recentFinalizedIds: [],
  }
  const recentIds = new Set()
  for (const entry of Object.values(statsByDevice || {})) {
    const stats = entry?.stats
    if (!stats || typeof stats !== 'object') continue
    result.lastActive = Math.max(numericTime(result.lastActive), numericTime(stats.lastActive)) || null
    addNumber(result.lifetime, stats.lifetime, 'prompts')
    addNumber(result.lifetime, stats.lifetime, 'successDurationMs')
    for (const key of Object.keys(result.lifetime.byOutcome)) addNumber(result.lifetime.byOutcome, stats.lifetime?.byOutcome, key)
    for (const key of Object.keys(result.lifetime.tools)) addNumber(result.lifetime.tools, stats.lifetime?.tools, key)
    addModels(result.lifetime.models, stats.lifetime?.models)
    for (const [dayKey, day] of Object.entries(stats.days || {})) {
      if (!result.days[dayKey]) {
        result.days[dayKey] = {
          prompts: 0,
          byOutcome: { completed: 0, error: 0, interrupted: 0, cancelled: 0 },
          successDurationMs: 0,
          tools: { voice: 0, screenshot: 0, search: 0 },
          models: {},
        }
      }
      const target = result.days[dayKey]
      addNumber(target, day, 'prompts')
      addNumber(target, day, 'successDurationMs')
      for (const key of Object.keys(target.byOutcome)) addNumber(target.byOutcome, day.byOutcome, key)
      for (const key of Object.keys(target.tools)) addNumber(target.tools, day.tools, key)
      addModels(target.models, day.models)
    }
    for (const id of stats.recentFinalizedIds || []) recentIds.add(id)
  }
  result.recentFinalizedIds = Array.from(recentIds).slice(-100)
  return result
}
