/**
 * HeraAi 1.10.0 — Anahtar sağlığı testleri (Aşama 10).
 *
 * Kapsam: hata sınıflandırması, artan bekleme merdiveni, `Retry-After`,
 * kullanılabilirlik, sayaç sıfırlama, duraklatma ve gizli parmak izi.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  COOLDOWN_LADDER_MS,
  KEY_HEALTH,
  PERMANENT_HEALTH,
  USABLE_HEALTH,
  applyKeyOutcome,
  classifyKeyError,
  cooldownForAttempt,
  describeKeyHealth,
  findDuplicateKey,
  isKeyUsable,
  keyFingerprint,
  parseRetryAfter,
  pauseKey,
  resumeKey,
  summarizePool,
} from './keyHealth'
import { deriveSubkeys, generateMasterSecretBytes, importMasterSecret } from './syncCrypto'

let fingerprintKey

beforeEach(async () => {
  const master = await importMasterSecret(generateMasterSecretBytes())
  const subkeys = await deriveSubkeys(master)
  fingerprintKey = subkeys.fingerprintKey
})

describe('sağlık durumları', () => {
  it('plan durumlarının tamamını tanımlar', () => {
    expect(Object.values(KEY_HEALTH).sort()).toEqual([
      'cooldown',
      'incompatible',
      'invalid',
      'paused',
      'ready',
      'transient_error',
      'untested',
    ])
  })

  it('kullanılabilir ve kalıcı dışlanan kümeleri ayırır', () => {
    expect(USABLE_HEALTH).toContain(KEY_HEALTH.READY)
    expect(USABLE_HEALTH).toContain(KEY_HEALTH.UNTESTED)
    expect(PERMANENT_HEALTH).toContain(KEY_HEALTH.INVALID)
    expect(PERMANENT_HEALTH).toContain(KEY_HEALTH.PAUSED)
    expect(USABLE_HEALTH).not.toContain(KEY_HEALTH.INVALID)
  })

  it('katalog plan değerlerini bildirir', () => {
    const katalog = describeKeyHealth()
    expect(katalog.cooldownLadderMs).toEqual([60000, 300000, 900000, 3600000])
    expect(katalog.fingerprint).toBe('hmac-sha-256')
  })
})

describe('bekleme merdiveni', () => {
  it('plan sırasını uygular', () => {
    expect(COOLDOWN_LADDER_MS).toEqual([60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000])
    expect(cooldownForAttempt(1)).toBe(60_000)
    expect(cooldownForAttempt(2)).toBe(300_000)
    expect(cooldownForAttempt(3)).toBe(900_000)
    expect(cooldownForAttempt(4)).toBe(3_600_000)
    expect(cooldownForAttempt(9)).toBe(3_600_000)
  })

  it('geçersiz sayaçta ilk basamağı kullanır', () => {
    expect(cooldownForAttempt(0)).toBe(60_000)
    expect(cooldownForAttempt(null)).toBe(60_000)
    expect(cooldownForAttempt('abc')).toBe(60_000)
  })
})

describe('Retry-After ayrıştırma', () => {
  it('saniye değerini milisaniyeye çevirir', () => {
    expect(parseRetryAfter('30')).toBe(30_000)
    expect(parseRetryAfter(120)).toBe(120_000)
    expect(parseRetryAfter('0')).toBe(0)
  })

  it('HTTP tarihini kalan süreye çevirir', () => {
    const now = Date.parse('2026-09-22T10:00:00Z')
    const kalan = parseRetryAfter('Tue, 22 Sep 2026 10:00:45 GMT', { now })
    expect(kalan).toBe(45_000)
  })

  it('geçmiş tarihte sıfır döner', () => {
    const now = Date.parse('2026-09-22T10:00:00Z')
    expect(parseRetryAfter('Tue, 22 Sep 2026 09:00:00 GMT', { now })).toBe(0)
  })

  it('boş ve geçersiz değeri yok sayar', () => {
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('')).toBeNull()
    expect(parseRetryAfter('yarın')).toBeNull()
  })
})

describe('hata sınıflandırması', () => {
  it('401 anahtarı kalıcı geçersiz yapar ve rotasyondan çıkarır', () => {
    const sonuc = classifyKeyError({ status: 401 })
    expect(sonuc.health).toBe(KEY_HEALTH.INVALID)
    expect(sonuc.cooldownMs).toBe(0)
    expect(sonuc.global).toBe(true)
  })

  it('429 bekleme kurar; Retry-After varsa onu kullanır', () => {
    const basliksiz = classifyKeyError({ status: 429, failCount: 0 })
    expect(basliksiz.health).toBe(KEY_HEALTH.COOLDOWN)
    expect(basliksiz.cooldownMs).toBe(60_000)

    const baslikli = classifyKeyError({ status: 429, retryAfter: '120', failCount: 0 })
    expect(baslikli.cooldownMs).toBe(120_000)
  })

  it('429 artan merdiveni izler', () => {
    expect(classifyKeyError({ status: 429, failCount: 1 }).cooldownMs).toBe(300_000)
    expect(classifyKeyError({ status: 429, failCount: 2 }).cooldownMs).toBe(900_000)
    expect(classifyKeyError({ status: 429, failCount: 5 }).cooldownMs).toBe(3_600_000)
  })

  it('kota hatasını hız sınırı sayar', () => {
    expect(classifyKeyError({ errorType: 'quota_exceeded' }).health).toBe(KEY_HEALTH.COOLDOWN)
  })

  it('403 model kapsamlıysa uyumsuz, değilse geçersiz sayar', () => {
    expect(classifyKeyError({ status: 403, modelScoped: true }).health).toBe(
      KEY_HEALTH.INCOMPATIBLE,
    )
    expect(classifyKeyError({ status: 403, message: 'Permission denied for model gemini' }).health).toBe(
      KEY_HEALTH.INCOMPATIBLE,
    )
    expect(classifyKeyError({ status: 403 }).health).toBe(KEY_HEALTH.INVALID)
  })

  it('5xx geçici hata sayar', () => {
    const sonuc = classifyKeyError({ status: 503 })
    expect(sonuc.health).toBe(KEY_HEALTH.TRANSIENT_ERROR)
    expect(sonuc.global).toBe(false)
  })

  it('400 istek hatası anahtarı bozmaz', () => {
    const sonuc = classifyKeyError({ status: 400 })
    expect(sonuc.health).toBe(KEY_HEALTH.READY)
    expect(sonuc.countsAsFailure).toBe(false)
  })

  it('ağ hatası küresel arıza sayılmaz', () => {
    const sonuc = classifyKeyError({ errorType: 'network_error' })
    expect(sonuc.health).toBe(KEY_HEALTH.TRANSIENT_ERROR)
    expect(sonuc.countsAsFailure).toBe(false)
    expect(sonuc.global).toBe(false)
    expect(sonuc.reason).toBe('network')

    expect(classifyKeyError({ message: 'Failed to fetch' }).reason).toBe('network')
    expect(classifyKeyError({ errorType: 'timeout' }).countsAsFailure).toBe(false)
  })

  it('bilinmeyen hatada temkinli davranır', () => {
    const sonuc = classifyKeyError({})
    expect(sonuc.health).toBe(KEY_HEALTH.TRANSIENT_ERROR)
    expect(sonuc.reason).toBe('unknown')
  })
})

describe('kullanılabilirlik', () => {
  it('hazır ve test edilmemiş anahtarlar kullanılabilir', () => {
    expect(isKeyUsable({ status: KEY_HEALTH.READY })).toBe(true)
    expect(isKeyUsable({ status: KEY_HEALTH.UNTESTED })).toBe(true)
    expect(isKeyUsable({})).toBe(true)
  })

  it('duraklatılmış ve geçersiz anahtarlar kullanılamaz', () => {
    expect(isKeyUsable({ status: KEY_HEALTH.PAUSED })).toBe(false)
    expect(isKeyUsable({ status: KEY_HEALTH.INVALID })).toBe(false)
  })

  it('bekleme süresi dolmamışsa kullanılamaz', () => {
    const now = 10_000
    expect(isKeyUsable({ status: KEY_HEALTH.COOLDOWN, cooldownUntil: 20_000 }, { now })).toBe(false)
    expect(isKeyUsable({ status: KEY_HEALTH.COOLDOWN, cooldownUntil: 5_000 }, { now })).toBe(true)
  })

  it('bekleme süresi yoksa cooldown yine denenebilir', () => {
    expect(isKeyUsable({ status: KEY_HEALTH.COOLDOWN, cooldownUntil: null })).toBe(true)
  })

  it('boş kaydı kullanılamaz sayar', () => {
    expect(isKeyUsable(null)).toBe(false)
    expect(isKeyUsable(undefined)).toBe(false)
  })
})

describe('sonuç uygulama', () => {
  it('başarı sayaç ve beklemeyi sıfırlar', () => {
    const eski = {
      status: KEY_HEALTH.COOLDOWN,
      failCount: 3,
      cooldownUntil: 999,
      lastErrorType: 'rate_limit',
    }
    const yeni = applyKeyOutcome(eski, { success: true, now: 1000 })
    expect(yeni.status).toBe(KEY_HEALTH.READY)
    expect(yeni.failCount).toBe(0)
    expect(yeni.cooldownUntil).toBeNull()
    expect(yeni.lastErrorType).toBeNull()
    expect(yeni.lastSuccessAt).toBe(1000)
    expect(yeni.lastUsedAt).toBe(1000)
  })

  it('429 hatasında sayaç artar ve bekleme yazılır', () => {
    const yeni = applyKeyOutcome({ failCount: 0 }, { success: false, status: 429, now: 1000 })
    expect(yeni.status).toBe(KEY_HEALTH.COOLDOWN)
    expect(yeni.failCount).toBe(1)
    expect(yeni.cooldownUntil).toBe(61_000)
    expect(yeni.lastErrorType).toBe('rate_limited')
  })

  it('ikinci 429 daha uzun beklemeye geçer', () => {
    const ilk = applyKeyOutcome({ failCount: 0 }, { success: false, status: 429, now: 1000 })
    const ikinci = applyKeyOutcome(ilk, { success: false, status: 429, now: 2000 })
    expect(ikinci.failCount).toBe(2)
    expect(ikinci.cooldownUntil).toBe(302_000)
  })

  it('401 kalıcı geçersiz yapar', () => {
    const yeni = applyKeyOutcome({ failCount: 0 }, { success: false, status: 401, now: 1000 })
    expect(yeni.status).toBe(KEY_HEALTH.INVALID)
    expect(yeni.cooldownUntil).toBeNull()
  })

  it('ağ hatası sayacı artırmaz ama yerel işaret koyar', () => {
    const yeni = applyKeyOutcome({ failCount: 0 }, { success: false, errorType: 'network_error', now: 1000 })
    expect(yeni.failCount).toBe(0)
    expect(yeni.status).toBe(KEY_HEALTH.TRANSIENT_ERROR)
    expect(yeni.lastErrorScope).toBe('local')
  })

  it('sağlayıcı hatası küresel işaret koymaz', () => {
    const yeni = applyKeyOutcome({ failCount: 0 }, { success: false, status: 401, now: 1000 })
    expect(yeni.lastErrorScope).toBeUndefined()
  })

  it('başarılı istek ağ hatası lekesini temizler', () => {
    const lekeli = applyKeyOutcome({ failCount: 0 }, { success: false, errorType: 'timeout', now: 1 })
    const temiz = applyKeyOutcome(lekeli, { success: true, now: 2 })
    expect(temiz.status).toBe(KEY_HEALTH.READY)
    expect(temiz.failCount).toBe(0)
  })
})

describe('duraklatma', () => {
  it('duraklatılan anahtar rotasyondan çıkar', () => {
    const yeni = pauseKey({ status: KEY_HEALTH.READY }, { now: 500 })
    expect(yeni.status).toBe(KEY_HEALTH.PAUSED)
    expect(yeni.pausedAt).toBe(500)
    expect(isKeyUsable(yeni)).toBe(false)
  })

  it('devam ettirilen anahtar test edilmemiş olur', () => {
    const yeni = resumeKey({ status: KEY_HEALTH.PAUSED, failCount: 4, cooldownUntil: 999 }, { now: 600 })
    expect(yeni.status).toBe(KEY_HEALTH.UNTESTED)
    expect(yeni.failCount).toBe(0)
    expect(yeni.cooldownUntil).toBeNull()
    expect(isKeyUsable(yeni)).toBe(true)
  })
})

describe('gizli parmak izi', () => {
  it('aynı ham anahtar için aynı parmak izini üretir', async () => {
    const a = await keyFingerprint(fingerprintKey, 'AIza-ayni-anahtar')
    const b = await keyFingerprint(fingerprintKey, 'AIza-ayni-anahtar')
    expect(a).toBe(b)
    expect(a).toHaveLength(64)
  })

  it('farklı ham anahtar için farklı parmak izi üretir', async () => {
    const a = await keyFingerprint(fingerprintKey, 'AIza-anahtar-1')
    const b = await keyFingerprint(fingerprintKey, 'AIza-anahtar-2')
    expect(a).not.toBe(b)
  })

  it('parmak izi ham anahtarı içermez', async () => {
    const ham = 'AIza-cok-gizli-deger'
    const iz = await keyFingerprint(fingerprintKey, ham)
    expect(iz).not.toContain(ham)
    expect(iz).not.toContain('gizli')
  })

  it('başka cihazın anahtarıyla aynı sonucu vermez', async () => {
    const digerMaster = await importMasterSecret(generateMasterSecretBytes())
    const digerSubkeys = await deriveSubkeys(digerMaster)
    const a = await keyFingerprint(fingerprintKey, 'AIza-anahtar')
    const b = await keyFingerprint(digerSubkeys.fingerprintKey, 'AIza-anahtar')
    expect(a).not.toBe(b)
  })

  it('eksik girdilerde açık hata verir', async () => {
    await expect(keyFingerprint(null, 'x')).rejects.toThrow('fingerprint_key_missing')
    await expect(keyFingerprint(fingerprintKey, '')).rejects.toThrow(
      'fingerprint_raw_key_missing',
    )
    await expect(keyFingerprint(fingerprintKey, '   ')).rejects.toThrow(
      'fingerprint_raw_key_missing',
    )
  })

  it('mükerrer kaydı bulur ve yenisini oluşturmaz', async () => {
    const iz = await keyFingerprint(fingerprintKey, 'AIza-anahtar')
    const mevcut = { id: 'k1', fingerprint: iz }
    const digeri = { id: 'k2', fingerprint: 'baska' }
    expect(findDuplicateKey(iz, [digeri, mevcut])).toBe(mevcut)
    expect(findDuplicateKey(iz, [digeri])).toBeNull()
    expect(findDuplicateKey(null, [mevcut])).toBeNull()
  })
})

describe('havuz özeti', () => {
  it('durumları sayar ve kullanılabilirleri toplar', () => {
    const now = 10_000
    const ozet = summarizePool(
      [
        { status: KEY_HEALTH.READY },
        { status: KEY_HEALTH.UNTESTED },
        { status: KEY_HEALTH.PAUSED },
        { status: KEY_HEALTH.INVALID },
        { status: KEY_HEALTH.COOLDOWN, cooldownUntil: 20_000 },
        { status: KEY_HEALTH.COOLDOWN, cooldownUntil: 5_000 },
        { status: KEY_HEALTH.INCOMPATIBLE },
        { status: KEY_HEALTH.TRANSIENT_ERROR, cooldownUntil: 5_000 },
      ],
      { now },
    )
    expect(ozet.total).toBe(8)
    expect(ozet.ready).toBe(1)
    expect(ozet.paused).toBe(1)
    expect(ozet.invalid).toBe(1)
    expect(ozet.cooldown).toBe(2)
    // ready + untested + süresi dolmuş cooldown + geçici hata + incompatible = 5
    // `incompatible` anahtar sağlamdır, yalnız ilgili model için geçersizdir;
    // başka model denenebildiği için kullanılabilir sayılır.
    expect(ozet.usable).toBe(5)
    expect(isKeyUsable({ status: KEY_HEALTH.INCOMPATIBLE })).toBe(true)
  })

  it('durumu olmayan kaydı test edilmemiş sayar', () => {
    const ozet = summarizePool([{}])
    expect(ozet.untested).toBe(1)
    expect(ozet.usable).toBe(1)
  })

  it('boş havuzda sıfır döner', () => {
    expect(summarizePool([]).total).toBe(0)
    expect(summarizePool().usable).toBe(0)
  })
})
