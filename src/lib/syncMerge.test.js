/**
 * HeraAi 1.10.0 — Çakışma birleştirme testleri (Aşama 14).
 *
 * Kapsam: son yazan kazanır, kayıt birleşimi, tombstone üstünlüğü,
 * istatistik toplama ve anahtar bazlı yönlendirme.
 */

import { describe, expect, it } from 'vitest'

import {
  describeSyncMerge,
  mergeEntities,
  mergeSetting,
  mergeStats,
  mergeStorageKey,
  mergeStorageSnapshot,
} from './syncMerge'
import { MERGE_STRATEGY } from './syncContract'

function kayit(id, ek = {}) {
  return { id, title: `kayit-${id}`, ...ek }
}

function surum(wallTimeMs, deviceId = 'a', logicalCounter = 0) {
  return { wallTimeMs, logicalCounter, deviceId }
}

describe('son yazan kazanır', () => {
  it('daha yeni uzak değeri alır', () => {
    const sonuc = mergeSetting({
      local: { value: 'light', updatedAt: 100 },
      remote: { value: 'dark', updatedAt: 200 },
    })
    expect(sonuc.value.value).toBe('dark')
    expect(sonuc.changed).toBe(true)
    expect(sonuc.source).toBe('remote')
  })

  it('daha eski uzak değeri yok sayar', () => {
    const sonuc = mergeSetting({
      local: { value: 'light', updatedAt: 300 },
      remote: { value: 'dark', updatedAt: 200 },
    })
    expect(sonuc.value.value).toBe('light')
    expect(sonuc.changed).toBe(false)
  })

  it('eşitlikte yeri korur (gereksiz yazma yok)', () => {
    const sonuc = mergeSetting({
      local: { value: 'light', updatedAt: 100 },
      remote: { value: 'dark', updatedAt: 100 },
    })
    expect(sonuc.value.value).toBe('light')
    expect(sonuc.changed).toBe(false)
  })

  it('yerelde yoksa uzak değeri alır', () => {
    const sonuc = mergeSetting({ remote: { value: 'dark', updatedAt: 10 } })
    expect(sonuc.value.value).toBe('dark')
    expect(sonuc.changed).toBe(true)
  })

  it('uzakta yoksa yeri korur', () => {
    const sonuc = mergeSetting({ local: { value: 'light', updatedAt: 10 } })
    expect(sonuc.value.value).toBe('light')
    expect(sonuc.changed).toBe(false)
  })

  it('zaman bilgisi olmayan düz değerlerde yeri korur', () => {
    const sonuc = mergeSetting({ local: 'light', remote: 'dark' })
    expect(sonuc.value).toBe('light')
    expect(sonuc.changed).toBe(false)
  })

  it('createdAt yedeğini kullanır', () => {
    const sonuc = mergeSetting({
      local: { value: 'a', createdAt: 100 },
      remote: { value: 'b', createdAt: 300 },
    })
    expect(sonuc.value.value).toBe('b')
    expect(sonuc.changed).toBe(true)
  })
})

describe('kayıt birleşimi', () => {
  it('yeni kaydı ekler', () => {
    const sonuc = mergeEntities({
      local: [kayit('a')],
      remote: [kayit('b', { entityVersion: surum(100) })],
    })
    expect(sonuc.records.map(k => k.id)).toEqual(['a', 'b'])
    expect(sonuc.added).toEqual(['b'])
  })

  it('daha yeni sürümü günceller', () => {
    const sonuc = mergeEntities({
      local: [kayit('a', { title: 'eski', entityVersion: surum(100) })],
      remote: [kayit('a', { title: 'yeni', entityVersion: surum(200) })],
    })
    expect(sonuc.records[0].title).toBe('yeni')
    expect(sonuc.updated).toEqual(['a'])
  })

  it('daha eski sürümü yok sayar', () => {
    const sonuc = mergeEntities({
      local: [kayit('a', { title: 'yeni', entityVersion: surum(300) })],
      remote: [kayit('a', { title: 'eski', entityVersion: surum(100) })],
    })
    expect(sonuc.records[0].title).toBe('yeni')
    expect(sonuc.updated).toEqual([])
  })

  it('eşit sürümde yeri korur', () => {
    const sonuc = mergeEntities({
      local: [kayit('a', { title: 'yerel', entityVersion: surum(100) })],
      remote: [kayit('a', { title: 'uzak', entityVersion: surum(100) })],
    })
    expect(sonuc.records[0].title).toBe('yerel')
  })

  it('mantıksal sayaçla ayırır', () => {
    const sonuc = mergeEntities({
      local: [kayit('a', { title: 'yerel', entityVersion: surum(100, 'a', 0) })],
      remote: [kayit('a', { title: 'uzak', entityVersion: surum(100, 'a', 1) })],
    })
    expect(sonuc.records[0].title).toBe('uzak')
  })

  it('girdi listesini değiştirmez', () => {
    const yerel = [kayit('a', { entityVersion: surum(100) })]
    const kopya = JSON.parse(JSON.stringify(yerel))
    mergeEntities({ local: yerel, remote: [kayit('a', { title: 'x', entityVersion: surum(200) })] })
    expect(yerel).toEqual(kopya)
  })

  it('kimliksiz kayıtları atlar', () => {
    const sonuc = mergeEntities({ local: [], remote: [{ title: 'kimliksiz' }] })
    expect(sonuc.records).toHaveLength(0)
  })

  it('boş girdide çökmez', () => {
    expect(mergeEntities({}).records).toEqual([])
    expect(mergeEntities().added).toEqual([])
  })
})

describe('tombstone üstünlüğü', () => {
  it('silme kaydı yerel kaydı ezer', () => {
    const sonuc = mergeEntities({
      local: [kayit('a', { entityVersion: surum(100) })],
      remote: [{ id: 'a', deleted: true, entityVersion: surum(200) }],
    })
    expect(sonuc.records[0].deleted).toBe(true)
    expect(sonuc.deleted).toEqual(['a'])
  })

  it('uzun süre kapalı kalan cihaz silinmiş veriyi diriltemez', () => {
    // Cihaz 5 gün önce kaydı güncelledi; başka cihaz dün sildi.
    const sonuc = mergeEntities({
      local: [kayit('a', { title: 'diriltme denemesi', entityVersion: surum(100) })],
      remote: [{ id: 'a', deleted: true, entityVersion: surum(900) }],
    })
    expect(sonuc.records[0].deleted).toBe(true)
  })

  it('silme yerel sürümden eskiyse yok sayılır (geri getirilmiş kayıt)', () => {
    const sonuc = mergeEntities({
      local: [kayit('a', { title: 'geri getirildi', entityVersion: surum(900) })],
      remote: [{ id: 'a', deleted: true, entityVersion: surum(100) }],
    })
    expect(sonuc.records[0].title).toBe('geri getirildi')
    expect(sonuc.deleted).toEqual([])
  })

  it('yerelde olmayan silme kaydı yeni kayıt oluşturmaz', () => {
    const sonuc = mergeEntities({
      local: [],
      remote: [{ id: 'a', deleted: true, entityVersion: surum(100) }],
    })
    expect(sonuc.records).toHaveLength(0)
    expect(sonuc.deleted).toEqual(['a'])
  })

  it('iki tarafta da silinmişse kayıt tekrar yazılmaz', () => {
    const sonuc = mergeEntities({
      local: [{ id: 'a', deleted: true, entityVersion: surum(100) }],
      remote: [{ id: 'a', deleted: true, entityVersion: surum(200) }],
    })
    expect(sonuc.deleted).toEqual(['a'])
    expect(sonuc.updated).toEqual([])
  })

  it('tombstone kapalıysa silme uygulanmaz', () => {
    const sonuc = mergeEntities({
      local: [kayit('a', { title: 'yerel', entityVersion: surum(100) })],
      remote: [{ id: 'a', deleted: true, entityVersion: surum(200) }],
      withTombstone: false,
    })
    expect(sonuc.records[0].title).toBe('yerel')
    expect(sonuc.deleted).toEqual([])
  })
})

describe('istatistik birleşimi', () => {
  it('günlük sayaçları toplar', () => {
    const sonuc = mergeStats({
      local: { dailyCounts: { '2026-09-20': 3 }, totalGenerations: 3 },
      remote: { dailyCounts: { '2026-09-20': 2, '2026-09-21': 5 }, totalGenerations: 7 },
    })
    expect(sonuc.value.dailyCounts['2026-09-20']).toBe(5)
    expect(sonuc.value.dailyCounts['2026-09-21']).toBe(5)
    expect(sonuc.value.totalGenerations).toBe(10)
    expect(sonuc.changed).toBe(true)
  })

  it('kimlik listelerini birleştirir ve tekilleştirir', () => {
    const sonuc = mergeStats({
      local: { recentFinalizedIds: ['a', 'b'] },
      remote: { recentFinalizedIds: ['b', 'c'] },
    })
    expect(sonuc.value.recentFinalizedIds.sort()).toEqual(['a', 'b', 'c'])
  })

  it('lastActive için en büyüğü alır', () => {
    const sonuc = mergeStats({ local: { lastActive: 100 }, remote: { lastActive: 900 } })
    expect(sonuc.value.lastActive).toBe(900)
    const ters = mergeStats({ local: { lastActive: 900 }, remote: { lastActive: 100 } })
    expect(ters.value.lastActive).toBe(900)
  })

  it('yerelde yoksa uzak istatistiği alır', () => {
    const sonuc = mergeStats({ remote: { dailyCounts: { x: 1 } } })
    expect(sonuc.value.dailyCounts.x).toBe(1)
    expect(sonuc.changed).toBe(true)
  })

  it('uzakta yoksa yeri korur', () => {
    const sonuc = mergeStats({ local: { dailyCounts: { x: 1 } } })
    expect(sonuc.value.dailyCounts.x).toBe(1)
    expect(sonuc.changed).toBe(false)
  })

  it('bozuk sayaçları sıfır sayar', () => {
    const sonuc = mergeStats({
      local: { dailyCounts: { x: 'abc' } },
      remote: { dailyCounts: { x: 4 } },
    })
    expect(sonuc.value.dailyCounts.x).toBe(4)
  })
})

describe('anahtar bazlı yönlendirme', () => {
  it('ayarlar için son yazan kazanır', () => {
    const sonuc = mergeStorageKey({
      storageKey: 'theme',
      local: { value: 'light', updatedAt: 100 },
      remote: { value: 'dark', updatedAt: 200 },
    })
    expect(sonuc.strategy).toBe(MERGE_STRATEGY.LAST_WRITE_WINS)
    expect(sonuc.value.value).toBe('dark')
  })

  it('sohbetler için kayıt birleşimi', () => {
    const sonuc = mergeStorageKey({
      storageKey: 'sessions',
      local: [kayit('a', { entityVersion: surum(100) })],
      remote: [kayit('b', { entityVersion: surum(200) })],
    })
    expect(sonuc.strategy).toBe(MERGE_STRATEGY.ENTITY_UNION)
    expect(sonuc.records).toHaveLength(2)
  })

  it('API anahtarı havuzları için tombstone uygulanır', () => {
    const sonuc = mergeStorageKey({
      storageKey: 'geminiApiKeys',
      local: [kayit('k1', { entityVersion: surum(100) })],
      remote: [{ id: 'k1', deleted: true, entityVersion: surum(200) }],
    })
    expect(sonuc.strategy).toBe(MERGE_STRATEGY.ENTITY_UNION)
    expect(sonuc.deleted).toEqual(['k1'])
  })

  it('istatistikler için toplama', () => {
    const sonuc = mergeStorageKey({
      storageKey: 'stats',
      local: { dailyCounts: { x: 1 } },
      remote: { dailyCounts: { x: 2 } },
    })
    expect(sonuc.strategy).toBe(MERGE_STRATEGY.STATS_SUM)
    expect(sonuc.value.dailyCounts.x).toBe(3)
  })

  it('eşitlenmeyen anahtarı birleştirmez', () => {
    const sonuc = mergeStorageKey({ storageKey: 'bilinmeyenAlan', local: 1, remote: 2 })
    expect(sonuc.strategy).toBe(MERGE_STRATEGY.NONE)
    expect(sonuc.value).toBe(1)
    expect(sonuc.changed).toBe(false)
  })

  it('yalnız cihazda kalan anahtarı birleştirmez', () => {
    const sonuc = mergeStorageKey({ storageKey: 'activeSessionId', local: 'x', remote: 'y' })
    expect(sonuc.strategy).toBe(MERGE_STRATEGY.NONE)
  })
})

describe('anlık görüntü birleşimi', () => {
  it('yalnız değişen anahtarları döndürür', () => {
    const sonuc = mergeStorageSnapshot({
      local: { theme: { value: 'light', updatedAt: 300 } },
      remote: {
        theme: { value: 'dark', updatedAt: 100 },
        sessions: [kayit('a', { entityVersion: surum(100) })],
      },
    })
    expect(sonuc.changedKeys).toEqual(['sessions'])
    expect(sonuc.changes.sessions).toHaveLength(1)
  })

  it('eşitlenmeyen anahtarları atlar', () => {
    const sonuc = mergeStorageSnapshot({
      local: {},
      remote: { activeSessionId: 'x', syncQueue: [] },
    })
    expect(sonuc.changedKeys).toEqual([])
    expect(sonuc.skipped).toContain('activeSessionId')
  })

  it('boş anlık görüntüde çökmez', () => {
    expect(mergeStorageSnapshot({}).changedKeys).toEqual([])
    expect(mergeStorageSnapshot().skipped).toEqual([])
  })
})

describe('katalog', () => {
  it('plan değerlerini bildirir', () => {
    const katalog = describeSyncMerge()
    expect(katalog.strategies).toContain('entity_union')
    expect(katalog.tombstoneWins).toBe(true)
    expect(katalog.deterministicTieBreak).toBe(true)
  })
})
