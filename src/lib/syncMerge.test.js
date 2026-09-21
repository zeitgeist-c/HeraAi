import { describe, expect, it } from 'vitest'

import { aggregateDeviceStats, mergeSyncSnapshots } from './syncMerge'

function stats(prompts, completed, day = '2026-09-21') {
  return {
    schemaVersion: 2,
    lastActive: prompts,
    lifetime: {
      prompts,
      byOutcome: { completed, error: 0, interrupted: 0, cancelled: 0 },
      successDurationMs: completed * 100,
      tools: { voice: 0, screenshot: prompts, search: 0 },
      models: {},
    },
    days: {
      [day]: {
        prompts,
        byOutcome: { completed, error: 0, interrupted: 0, cancelled: 0 },
        successDurationMs: completed * 100,
        tools: { voice: 0, screenshot: prompts, search: 0 },
        models: {},
      },
    },
    legacyTools: { voice: 0, screenshot: 0, search: 0 },
    recentFinalizedIds: [`id-${prompts}`],
  }
}

describe('sync merge', () => {
  it('keeps the newest version of each chat and honors newer tombstones', () => {
    const merged = mergeSyncSnapshots(
      {
        sessions: [
          { id: 'shared', updatedAt: 30, title: 'local' },
          { id: 'deleted', updatedAt: 10 },
        ],
        sessionTombstones: { 'remote-deleted': 50 },
        settings: { theme: 'dark' },
        settingsUpdatedAt: 40,
      },
      {
        sessions: [
          { id: 'shared', updatedAt: 20, title: 'remote' },
          { id: 'remote-deleted', updatedAt: 30 },
        ],
        sessionTombstones: { deleted: 20 },
        settings: { theme: 'light' },
        settingsUpdatedAt: 10,
      },
    )

    expect(merged.sessions).toEqual([{ id: 'shared', updatedAt: 30, title: 'local' }])
    expect(merged.settings.theme).toBe('dark')
    expect(merged.sessionTombstones).toEqual({ deleted: 20, 'remote-deleted': 50 })
  })

  it('adds independent device statistics without double counting device records', () => {
    const merged = mergeSyncSnapshots(
      { statsByDevice: { laptop: { updatedAt: 20, stats: stats(2, 1) } } },
      {
        statsByDevice: {
          laptop: { updatedAt: 10, stats: stats(1, 1) },
          desktop: { updatedAt: 30, stats: stats(3, 2) },
        },
      },
    )
    const aggregate = aggregateDeviceStats(merged.statsByDevice)

    expect(aggregate.lifetime.prompts).toBe(5)
    expect(aggregate.lifetime.byOutcome.completed).toBe(3)
    expect(aggregate.days['2026-09-21'].tools.screenshot).toBe(5)
  })

  it('merges API keys by id and keeps deleted keys deleted', () => {
    const merged = mergeSyncSnapshots(
      {
        vault: {
          geminiApiKeys: [
            { id: 'shared', key: 'new-value', updatedAt: 30 },
            { id: 'local-only', key: 'local', updatedAt: 20 },
          ],
        },
        vaultTombstones: { 'geminiApiKeys:deleted': 50 },
      },
      {
        vault: {
          geminiApiKeys: [
            { id: 'shared', key: 'old-value', updatedAt: 10 },
            { id: 'remote-only', key: 'remote', updatedAt: 20 },
            { id: 'deleted', key: 'gone', updatedAt: 40 },
          ],
        },
      },
    )

    expect(merged.vault.geminiApiKeys.map(entry => entry.id).sort()).toEqual([
      'local-only',
      'remote-only',
      'shared',
    ])
    expect(merged.vault.geminiApiKeys.find(entry => entry.id === 'shared').key).toBe('new-value')
  })
})
