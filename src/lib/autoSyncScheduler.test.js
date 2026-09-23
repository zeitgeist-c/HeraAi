import { describe, expect, it, vi } from 'vitest'

import {
  AUTO_SYNC_IDLE_MS,
  AUTO_SYNC_JITTER_MS,
  AUTO_SYNC_SLOW_FACTOR,
  DEFAULT_AUTO_SYNC_MINUTES,
  FREE_TIER_READS_PER_DAY,
  FREE_TIER_WRITES_PER_DAY,
  LOCAL_CHANGE_SYNC_DELAY_MS,
  autoSyncDelayMs,
  autoSyncSkipReason,
  createAutoSyncScheduler,
  isSlowMode,
  normalizeAutoSyncMinutes,
  quotaUsageRatio,
  touchesSyncedKeys,
} from './autoSyncScheduler'

const MINUTE = 60 * 1000

/** Elle sürülen zamanlayıcı: gecikmeler birebir doğrulanabilir. */
function createManualTimers() {
  let nextId = 1
  const pending = new Map()
  return {
    schedule(fn, ms) {
      const id = nextId
      nextId += 1
      pending.set(id, { fn, ms })
      return id
    },
    cancel(id) {
      pending.delete(id)
    },
    pendingCount() {
      return pending.size
    },
    delays() {
      return [...pending.values()].map(entry => entry.ms)
    },
    async runNext() {
      const sirali = [...pending.entries()].sort((a, b) => a[1].ms - b[1].ms)
      if (!sirali.length) return null
      const [id, entry] = sirali[0]
      pending.delete(id)
      await entry.fn()
      return entry.ms
    },
  }
}

function createHarness(overrides = {}) {
  const timers = createManualTimers()
  const requestSync = vi.fn(async () => undefined)
  const requestSyncAfterChange = vi.fn(async () => undefined)
  const state = {
    hidden: false,
    lastActivityAt: 1_000,
    now: 1_000,
    usage: null,
    intervalMinutes: DEFAULT_AUTO_SYNC_MINUTES,
    ...overrides,
  }
  const scheduler = createAutoSyncScheduler({
    requestSync,
    requestSyncAfterChange,
    isHidden: () => state.hidden,
    getLastActivityAt: () => state.lastActivityAt,
    getUsage: () => state.usage,
    getIntervalMinutes: () => state.intervalMinutes,
    random: () => 0,
    now: () => state.now,
    schedule: timers.schedule,
    cancel: timers.cancel,
  })
  return { scheduler, timers, requestSync, requestSyncAfterChange, state }
}

describe('otomatik eşitleme aralığı', () => {
  it('yalnız bilinen aralıkları kabul eder, bilinmeyende varsayılana düşer', () => {
    expect(normalizeAutoSyncMinutes(0)).toBe(0)
    expect(normalizeAutoSyncMinutes(60)).toBe(60)
    expect(normalizeAutoSyncMinutes(120)).toBe(120)
    expect(normalizeAutoSyncMinutes(360)).toBe(360)
    expect(normalizeAutoSyncMinutes(45)).toBe(DEFAULT_AUTO_SYNC_MINUTES)
    expect(normalizeAutoSyncMinutes('abc')).toBe(DEFAULT_AUTO_SYNC_MINUTES)
    expect(normalizeAutoSyncMinutes(undefined)).toBe(DEFAULT_AUTO_SYNC_MINUTES)
  })

  it('yalnız eşitlenen anahtarlara dokunan yazımlar eşitlemeyi tetikler', () => {
    expect(touchesSyncedKeys({ sessions: [] })).toBe(true)
    expect(touchesSyncedKeys({ theme: 'dark', language: 'tr' })).toBe(true)
    expect(touchesSyncedKeys({ stats: {} })).toBe(true)
    // Cihaza özel anahtarlar boşuna koşu başlatmamalı.
    expect(touchesSyncedKeys({ activeSessionId: 'abc' })).toBe(false)
    expect(touchesSyncedKeys({ activeGeneration: null })).toBe(false)
    expect(touchesSyncedKeys({})).toBe(false)
    expect(touchesSyncedKeys(null)).toBe(false)
    expect(touchesSyncedKeys('sessions')).toBe(false)
  })

  it('kapalı aralıkta gecikme üretmez, açıkta kayma ekler', () => {
    expect(autoSyncDelayMs(0, () => 0)).toBe(0)
    expect(autoSyncDelayMs(60, () => 0)).toBe(60 * MINUTE)
    expect(autoSyncDelayMs(60, () => 0.5)).toBe(60 * MINUTE + AUTO_SYNC_JITTER_MS / 2)
    const ust = autoSyncDelayMs(60, () => 1)
    expect(ust).toBeGreaterThanOrEqual(60 * MINUTE)
    expect(ust).toBeLessThan(60 * MINUTE + AUTO_SYNC_JITTER_MS)
    // Yavaş modda aralık katlanır; bu ara değer doğrulanıp 60'a düşmemeli.
    expect(autoSyncDelayMs(60 * AUTO_SYNC_SLOW_FACTOR, () => 0)).toBe(240 * MINUTE)
  })
})

describe('kota koruması eşikleri', () => {
  it('günlük sınıra göre oran hesaplar', () => {
    const ratio = quotaUsageRatio({ reads: FREE_TIER_READS_PER_DAY / 2, writes: FREE_TIER_WRITES_PER_DAY / 4 })
    expect(ratio.reads).toBeCloseTo(0.5)
    expect(ratio.writes).toBeCloseTo(0.25)
    expect(ratio.worst).toBeCloseTo(0.5)
  })

  it('bozuk sayaç değerlerinde güvenli tarafa düşer', () => {
    expect(quotaUsageRatio(null).worst).toBe(0)
    expect(quotaUsageRatio({ reads: -5, writes: 'x' }).worst).toBe(0)
  })

  it('yarıdan sonra yavaş mod açılır', () => {
    expect(isSlowMode({ reads: FREE_TIER_READS_PER_DAY * 0.49, writes: 0 })).toBe(false)
    expect(isSlowMode({ reads: FREE_TIER_READS_PER_DAY * 0.5, writes: 0 })).toBe(true)
    expect(isSlowMode({ reads: 0, writes: FREE_TIER_WRITES_PER_DAY * 0.6 })).toBe(true)
    expect(isSlowMode(null)).toBe(false)
  })
})

describe('boşta atlama kararı', () => {
  it('panel gizliyse ve kullanıcı uzaktaysa koşuyu atlar', () => {
    expect(autoSyncSkipReason({ hidden: true, lastActivityAt: 1_000, now: 2_000 })).toBe('hidden')
    expect(autoSyncSkipReason({
      hidden: false,
      lastActivityAt: 1_000,
      now: 1_000 + AUTO_SYNC_IDLE_MS,
    })).toBe('idle')
    expect(autoSyncSkipReason({ hidden: false, lastActivityAt: 1_000, now: 1_500 })).toBeNull()
  })
})

describe('otomatik eşitleme zamanlayıcısı', () => {
  it('başlangıçta aralık + kayma kadar sonra tek koşu planlar', async () => {
    const { scheduler, timers, requestSync } = createHarness()
    scheduler.start()

    expect(timers.pendingCount()).toBe(1)
    expect(timers.delays()[0]).toBe(60 * MINUTE)

    await timers.runNext()
    expect(requestSync).toHaveBeenCalledTimes(1)
    expect(timers.pendingCount()).toBe(1)
    scheduler.stop()
  })

  it('panel gizliyken koşmaz ama sonraki turu planlar', async () => {
    const { scheduler, timers, requestSync, state } = createHarness()
    state.hidden = true
    scheduler.start()

    await timers.runNext()
    expect(requestSync).not.toHaveBeenCalled()
    expect(timers.pendingCount()).toBe(1)

    state.hidden = false
    state.now = state.lastActivityAt + 1_000
    await timers.runNext()
    expect(requestSync).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it('kullanıcı uzaktayken koşmaz', async () => {
    const { scheduler, timers, requestSync, state } = createHarness()
    state.now = state.lastActivityAt + AUTO_SYNC_IDLE_MS + 1
    scheduler.start()

    await timers.runNext()
    expect(requestSync).not.toHaveBeenCalled()
    scheduler.stop()
  })

  it('kapalı aralıkta hiç plan yapmaz', async () => {
    const { scheduler, timers, requestSync } = createHarness({ intervalMinutes: 0 })
    scheduler.start()

    expect(timers.pendingCount()).toBe(0)
    await timers.runNext()
    expect(requestSync).not.toHaveBeenCalled()
    scheduler.stop()
  })

  it('yavaş modda aralığı katlar', () => {
    const { scheduler, timers } = createHarness({
      usage: { reads: FREE_TIER_READS_PER_DAY * 0.8, writes: 0 },
    })
    scheduler.start()

    expect(timers.delays()[0]).toBe(60 * MINUTE * AUTO_SYNC_SLOW_FACTOR)
    scheduler.stop()
  })

  it('yerel değişiklikten sonra tek koşu yapar, üst üste değişiklik birleşir', async () => {
    const { scheduler, timers, requestSync, requestSyncAfterChange, state } = createHarness()
    state.now = state.lastActivityAt
    scheduler.start()

    scheduler.noteLocalChange()
    scheduler.noteLocalChange()
    const degisiklikGecikmeleri = timers.delays().filter(ms => ms === LOCAL_CHANGE_SYNC_DELAY_MS)
    expect(degisiklikGecikmeleri).toHaveLength(1)

    await timers.runNext()
    expect(requestSyncAfterChange).toHaveBeenCalledTimes(1)
    expect(requestSync).not.toHaveBeenCalled()
    scheduler.stop()
  })

  it('gizliyken yerel değişiklik de koşmaz', async () => {
    const { scheduler, timers, requestSyncAfterChange, state } = createHarness()
    state.hidden = true
    scheduler.start()
    scheduler.noteLocalChange()

    await timers.runNext()
    expect(requestSyncAfterChange).not.toHaveBeenCalled()
    scheduler.stop()
  })

  it('durdurulunca bekleyen koşular temizlenir', async () => {
    const { scheduler, timers, requestSync } = createHarness()
    scheduler.start()
    scheduler.noteLocalChange()

    scheduler.stop()
    expect(timers.pendingCount()).toBe(0)
    await timers.runNext()
    expect(requestSync).not.toHaveBeenCalled()
  })
})
