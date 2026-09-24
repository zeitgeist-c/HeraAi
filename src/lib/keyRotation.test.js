/**
 * HeraAi 1.10.0 — API anahtarı rotasyonu testleri (Aşama 9).
 *
 * Kapsam: iki modun sıralaması, deterministik eşitlik çözümü ve kullanım
 * metadata'sı.
 */

import { describe, expect, it } from 'vitest'

import {
  KEY_USAGE_MODE,
  createKeyLease,
  describeKeyRotation,
  isValidUsageMode,
  orderByPrimary,
  orderByRotation,
  orderKeysForRequest,
  selectCandidates,
  usageMetadata,
  usageModeLabel,
} from './keyRotation'

function anahtar(id, ek = {}) {
  return { id, key: `ham-${id}`, isPrimary: false, ...ek }
}

describe('sıralama: primary modu', () => {
  it('ana anahtarı öne alır', () => {
    const liste = [
      anahtar('a', { createdAt: 100 }),
      anahtar('b', { createdAt: 200, isPrimary: true }),
      anahtar('c', { createdAt: 300 }),
    ]
    expect(orderByPrimary(liste).map(k => k.id)).toEqual(['b', 'a', 'c'])
  })

  it('createdAt artan sıralar, eşitlikte id kullanır', () => {
    const liste = [
      anahtar('z', { createdAt: 500 }),
      anahtar('a', { createdAt: 500 }),
      anahtar('m', { createdAt: 100 }),
    ]
    expect(orderByPrimary(liste).map(k => k.id)).toEqual(['m', 'a', 'z'])
  })

  it('createdAt eksikse en eski sayar', () => {
    const liste = [anahtar('x', { createdAt: 100 }), anahtar('y', { createdAt: null })]
    expect(orderByPrimary(liste).map(k => k.id)).toEqual(['y', 'x'])
  })

  it('girdi listesini değiştirmez', () => {
    const liste = [anahtar('b', { createdAt: 2 }), anahtar('a', { createdAt: 1 })]
    const kopya = [...liste]
    orderByPrimary(liste)
    expect(liste).toEqual(kopya)
  })
})

describe('sıralama: rotasyon modu', () => {
  it('en uzun süredir kullanılmayan anahtarı öne alır', () => {
    const liste = [
      anahtar('yeni', { lastUsedAt: 9000 }),
      anahtar('orta', { lastUsedAt: 5000 }),
      anahtar('eski', { lastUsedAt: 1000 }),
    ]
    expect(orderByRotation(liste).map(k => k.id)).toEqual(['eski', 'orta', 'yeni'])
  })

  it('hiç kullanılmamış anahtar en öne geçer', () => {
    const liste = [anahtar('kullanilmis', { lastUsedAt: 1 }), anahtar('bakir', { lastUsedAt: null })]
    expect(orderByRotation(liste).map(k => k.id)).toEqual(['bakir', 'kullanilmis'])
  })

  it('eşit kullanımda id sırası belirleyicidir (tüm cihazlar aynı sonucu görür)', () => {
    const liste = [anahtar('c', { lastUsedAt: 100 }), anahtar('a', { lastUsedAt: 100 }), anahtar('b', { lastUsedAt: 100 })]
    expect(orderByRotation(liste).map(k => k.id)).toEqual(['a', 'b', 'c'])
  })

  it('ana anahtar ayrıcalığı rotasyonda geçerli değildir', () => {
    const liste = [
      anahtar('birincil', { isPrimary: true, lastUsedAt: 9000 }),
      anahtar('diger', { lastUsedAt: 100 }),
    ]
    expect(orderByRotation(liste).map(k => k.id)).toEqual(['diger', 'birincil'])
  })
})

describe('mod seçimi', () => {
  it('bilinmeyen mod primary sayılır', () => {
    const liste = [anahtar('a', { createdAt: 200 }), anahtar('b', { createdAt: 100, lastUsedAt: null })]
    // primary sırası: createdAt artan → b (100) önce.
    expect(orderKeysForRequest(liste, 'bilinmeyen').map(k => k.id)).toEqual(['b', 'a'])
    expect(orderKeysForRequest(liste, undefined).map(k => k.id)).toEqual(['b', 'a'])
  })

  it('rotasyon modu seçilirse kullanım sırasına geçer', () => {
    const liste = [anahtar('a', { createdAt: 100, lastUsedAt: 9000 }), anahtar('b', { createdAt: 200, lastUsedAt: 100 })]
    expect(orderKeysForRequest(liste, KEY_USAGE_MODE.BALANCED_ROTATION).map(k => k.id)).toEqual(['b', 'a'])
  })

  it('mod geçerliliğini denetler ve etiket verir', () => {
    expect(isValidUsageMode('primary')).toBe(true)
    expect(isValidUsageMode('balanced_rotation')).toBe(true)
    expect(isValidUsageMode('rastgele')).toBe(false)
    expect(usageModeLabel('balanced_rotation')).toBe('Anahtarları sırayla kullan')
    expect(usageModeLabel('primary')).toBe('Ana anahtarları kullan')
    expect(usageModeLabel('gecersiz')).toBe('Ana anahtarları kullan')
  })
})

describe('aday seçimi', () => {
  it('anahtarı olmayan kaydı listeye almaz', () => {
    const liste = [anahtar('a'), { id: 'bos', key: '' }, { id: 'yok' }]
    expect(selectCandidates({ keys: liste, mode: 'primary' }).map(k => k.id)).toEqual(['a'])
  })

  it('hariç tutulan kimlikleri çıkarır', () => {
    const liste = [anahtar('a', { createdAt: 1 }), anahtar('b', { createdAt: 2 }), anahtar('c', { createdAt: 3 })]
    const sonuc = selectCandidates({ keys: liste, mode: 'primary', excludeIds: ['a', 'c'] })
    expect(sonuc.map(k => k.id)).toEqual(['b'])
  })

  it('rezerve kimlikleri öne alır (akış sürekliliği)', () => {
    const liste = [anahtar('a', { createdAt: 1 }), anahtar('b', { createdAt: 2 }), anahtar('c', { createdAt: 3 })]
    const sonuc = selectCandidates({ keys: liste, mode: 'primary', reservedIds: ['c'] })
    expect(sonuc.map(k => k.id)).toEqual(['c', 'a', 'b'])
  })

  it('boş ve eksik listede çökmez', () => {
    expect(selectCandidates({})).toEqual([])
    expect(selectCandidates({ keys: [] })).toEqual([])
  })
})

describe('istek rezervasyonu', () => {
  it('akış boyunca aynı anahtarı döndürür', () => {
    const liste = [anahtar('a', { createdAt: 1 }), anahtar('b', { createdAt: 2 })]
    const kira = createKeyLease({ keys: liste, mode: 'primary' })
    expect(kira.exhausted).toBe(false)
    expect(kira.current().id).toBe('a')
    expect(kira.current().id).toBe('a')
    expect(kira.used()).toEqual(['a'])
  })

  it('advance yalnız yedek anahtara geçer', () => {
    const liste = [anahtar('a', { createdAt: 1 }), anahtar('b', { createdAt: 2 })]
    const kira = createKeyLease({ keys: liste, mode: 'primary', count: 2 })
    expect(kira.current().id).toBe('a')
    expect(kira.advance().id).toBe('b')
    expect(kira.advance()).toBeNull()
    expect(kira.current().id).toBe('b')
  })

  it('rezervasyon hariç tutulanları atlar', () => {
    const liste = [anahtar('a', { createdAt: 1 }), anahtar('b', { createdAt: 2 })]
    const kira = createKeyLease({ keys: liste, mode: 'primary', excludeIds: ['a'] })
    expect(kira.current().id).toBe('b')
  })

  it('anahtar yoksa tükenmiş bildirir', () => {
    const kira = createKeyLease({ keys: [], mode: 'primary' })
    expect(kira.exhausted).toBe(true)
    expect(kira.current()).toBeNull()
    expect(kira.used()).toEqual([])
  })

  it('rotasyon modunda en eski kullanılanı seçer', () => {
    const liste = [anahtar('a', { lastUsedAt: 9000 }), anahtar('b', { lastUsedAt: 100 })]
    const kira = createKeyLease({ keys: liste, mode: KEY_USAGE_MODE.BALANCED_ROTATION })
    expect(kira.current().id).toBe('b')
  })
})

describe('kullanım metadata sı', () => {
  it('başarılı kullanımda sayaçları sıfırlar', () => {
    const meta = usageMetadata({ now: 1000, success: true })
    expect(meta.lastUsedAt).toBe(1000)
    expect(meta.lastSuccessAt).toBe(1000)
    expect(meta.failCount).toBe(0)
    expect(meta.status).toBe('ready')
    expect(meta.cooldownUntil).toBeNull()
  })

  it('hatada bekleme süresi kurar', () => {
    const meta = usageMetadata({ now: 2000, success: false, errorType: 'quota_exceeded', cooldownMs: 60000 })
    expect(meta.lastUsedAt).toBe(2000)
    expect(meta.lastErrorType).toBe('quota_exceeded')
    expect(meta.cooldownUntil).toBe(62000)
    expect(meta.status).toBe('cooldown')
  })

  it('beklemesiz hatada durum error olur', () => {
    const meta = usageMetadata({ now: 3000, success: false, errorType: 'invalid_key' })
    expect(meta.cooldownUntil).toBeUndefined()
    expect(meta.status).toBe('error')
    expect(meta.lastErrorType).toBe('invalid_key')
  })

  it('hata türü verilmezse unknown yazar', () => {
    expect(usageMetadata({ success: false }).lastErrorType).toBe('unknown')
  })
})

describe('katman kataloğu', () => {
  it('plan değerlerini bildirir', () => {
    const katalog = describeKeyRotation()
    expect(katalog.modes).toEqual(['primary', 'balanced_rotation'])
    expect(katalog.strategy).toBe('least_recently_used')
    expect(katalog.tieBreak).toBe('id')
    expect(katalog.midStreamSwitch).toBe(false)
  })
})
