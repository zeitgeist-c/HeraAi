/**
 * HeraAi 1.10.0 — Yedek, geri yükleme ve dışa aktarma testleri (Aşama 12).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  BACKUP_EXTENSION,
  BACKUP_FORMAT_VERSION,
  RECOVERY_KIT_FILENAME,
  RESTORE_POINT_DAYS,
  backupFileName,
  buildBackupPayload,
  compressionAvailable,
  dateKeyFor,
  decryptBackup,
  describeBackupLayer,
  encryptBackup,
  planRestorePoints,
  pruneExpiredRevisions,
  recoveryKitDocument,
  restoreStateAt,
  summarizeBackup,
} from './backupRestore'
import { deriveSubkeys, generateMasterSecretBytes, importMasterSecret } from './syncCrypto'

const GUN = 24 * 60 * 60 * 1000

let backupKey

beforeEach(async () => {
  const master = await importMasterSecret(generateMasterSecretBytes())
  const subkeys = await deriveSubkeys(master)
  backupKey = subkeys.backupKey
})

describe('tarih anahtarı', () => {
  it('yerel gün anahtarı üretir', () => {
    expect(dateKeyFor(new Date(2026, 8, 22, 12, 0, 0))).toBe('2026-09-22')
    expect(dateKeyFor(new Date(2026, 0, 5, 23, 59, 0))).toBe('2026-01-05')
  })
})

describe('geri dönüş noktaları', () => {
  it('son yedi gün için günde bir nokta üretir', () => {
    const simdi = new Date(2026, 8, 22, 12, 0, 0).getTime()
    const noktalar = planRestorePoints({ now: simdi })
    expect(noktalar).toHaveLength(RESTORE_POINT_DAYS)
    expect(noktalar[0].dateKey).toBe('2026-09-22')
    expect(noktalar[0].dayOffset).toBe(0)
    expect(noktalar[6].dateKey).toBe('2026-09-16')
  })

  it('en yeni nokta ilk sırada', () => {
    const simdi = new Date(2026, 8, 22, 12, 0, 0).getTime()
    const anahtarlar = planRestorePoints({ now: simdi }).map(n => n.dateKey)
    const sirali = [...anahtarlar].sort().reverse()
    expect(anahtarlar).toEqual(sirali)
  })

  it('gün sayısı ayarlanabilir', () => {
    const simdi = new Date(2026, 8, 22, 12, 0, 0).getTime()
    expect(planRestorePoints({ now: simdi, days: 3 })).toHaveLength(3)
    expect(planRestorePoints({ now: simdi, days: 0 })).toHaveLength(1)
  })

  it('aynı gün için mükerrer nokta üretmez', () => {
    const simdi = new Date(2026, 8, 22, 12, 0, 0).getTime()
    const anahtarlar = planRestorePoints({ now: simdi, days: 7 }).map(n => n.dateKey)
    expect(new Set(anahtarlar).size).toBe(anahtarlar.length)
  })
})

describe('yedek paketi', () => {
  it('sayaçları ve veriyi taşır', () => {
    const paket = buildBackupPayload({
      sessions: [{ id: 's1' }, { id: 's2' }],
      apiKeys: { gemini: [], tavily: [] },
      settings: { theme: 'dark' },
      stats: { total: 5 },
      createdAt: 1000,
    })
    expect(paket.format).toBe('heraai-backup')
    expect(paket.formatVersion).toBe(BACKUP_FORMAT_VERSION)
    expect(paket.counts.sessions).toBe(2)
    expect(paket.counts.apiKeyPools).toBe(2)
    expect(paket.counts.settings).toBe(1)
    expect(paket.data.stats.total).toBe(5)
  })

  it('boş girdide sıfır sayaç üretir', () => {
    const paket = buildBackupPayload()
    expect(paket.counts.sessions).toBe(0)
    expect(paket.data.sessions).toEqual([])
  })
})

describe('şifreli yedek', () => {
  it('şifreleyip kayıpsız geri çözer', async () => {
    const paket = buildBackupPayload({
      sessions: [{ id: 's1', title: 'Gizli sohbet başlığı' }],
      settings: { theme: 'dark' },
      createdAt: 5000,
    })
    const zarf = await encryptBackup({ backupKey, payload: paket, compress: false })

    expect(zarf.format).toBe('heraai-backup')
    expect(zarf.nonce).toBeTruthy()
    expect(zarf.ciphertext).toBeTruthy()
    // Sohbet içeriği dosyada düz görünmez.
    expect(JSON.stringify(zarf)).not.toContain('Gizli sohbet')

    const cozulen = await decryptBackup({ backupKey, envelope: zarf })
    expect(cozulen.data.sessions[0].title).toBe('Gizli sohbet başlığı')
    expect(cozulen.data.settings.theme).toBe('dark')
    expect(cozulen.createdAt).toBe(5000)
  })

  it('başka anahtarla çözmeye çalışırsa reddeder', async () => {
    const paket = buildBackupPayload({ sessions: [] })
    const zarf = await encryptBackup({ backupKey, payload: paket, compress: false })

    const digerMaster = await importMasterSecret(generateMasterSecretBytes())
    const digerSubkeys = await deriveSubkeys(digerMaster)
    await expect(
      decryptBackup({ backupKey: digerSubkeys.backupKey, envelope: zarf }),
    ).rejects.toThrow('backup_decrypt_failed')
  })

  it('bozuk zarfı reddeder', async () => {
    await expect(decryptBackup({ backupKey, envelope: {} })).rejects.toThrow(
      'backup_envelope_invalid',
    )
    await expect(decryptBackup({ backupKey, envelope: null })).rejects.toThrow(
      'backup_envelope_invalid',
    )
  })

  it('anahtar yoksa açık hata verir', async () => {
    await expect(encryptBackup({ payload: {} })).rejects.toThrow('backup_key_missing')
    await expect(decryptBackup({ envelope: { nonce: 'a', ciphertext: 'b' } })).rejects.toThrow(
      'backup_key_missing',
    )
    await expect(encryptBackup({ backupKey })).rejects.toThrow('backup_payload_missing')
  })

  it('bilinmeyen biçimi reddeder', async () => {
    await expect(
      decryptBackup({ backupKey, envelope: { format: 'baska', nonce: 'a', ciphertext: 'b' } }),
    ).rejects.toThrow('backup_format_invalid')
  })

  it('desteklenmeyen sürümü reddeder', async () => {
    await expect(
      decryptBackup({
        backupKey,
        envelope: { format: 'heraai-backup', formatVersion: 99, nonce: 'a', ciphertext: 'b' },
      }),
    ).rejects.toThrow('backup_version_unsupported')
  })

  it('bozuk base64 içeriğini reddeder', async () => {
    const zarf = await encryptBackup({
      backupKey,
      payload: buildBackupPayload(),
      compress: false,
    })
    // Şifreli metni geçerli base64 ama JSON değil.
    const bozuk = { ...zarf, ciphertext: 'AAAA' }
    await expect(decryptBackup({ backupKey, envelope: bozuk })).rejects.toThrow(
      'backup_decrypt_failed',
    )
  })

  it('sıkıştırma destekleniyorsa gzip kullanır', async () => {
    const paket = buildBackupPayload({ sessions: [{ id: 's1' }] })
    const zarf = await encryptBackup({ backupKey, payload: paket })
    expect(zarf.compressed).toBe(compressionAvailable())
    const cozulen = await decryptBackup({ backupKey, envelope: zarf })
    expect(cozulen.data.sessions[0].id).toBe('s1')
  })
})

describe('geri yükleme hesabı', () => {
  const v = (wallTimeMs, deviceId = 'a') => ({ wallTimeMs, logicalCounter: 0, deviceId })

  it('hedef andan önceki en yeni sürümü seçer', () => {
    const secilenler = restoreStateAt({
      targetTimeMs: 5000,
      entities: [
        { opaqueEntityId: 'e1', entityType: 'session', entityVersion: v(9000), document: { id: 'e1', n: 'güncel' } },
      ],
      revisions: [
        { opaqueEntityId: 'e1', entityType: 'session', revisionId: 'r1', entityVersion: v(3000), document: { id: 'e1', n: 'eski' } },
        { opaqueEntityId: 'e1', entityType: 'session', revisionId: 'r2', entityVersion: v(4000), document: { id: 'e1', n: 'orta' } },
      ],
    })
    expect(secilenler).toHaveLength(1)
    expect(secilenler[0].document.n).toBe('orta')
    expect(secilenler[0].revisionId).toBe('r2')
    expect(secilenler[0].changed).toBe(true)
  })

  it('güncel sürüm hedeften eskiyse onu seçer ve değişiklik bildirmez', () => {
    const secilenler = restoreStateAt({
      targetTimeMs: 9000,
      entities: [
        { opaqueEntityId: 'e1', entityType: 'session', entityVersion: v(1000), document: { id: 'e1' } },
      ],
      revisions: [],
    })
    expect(secilenler[0].document.id).toBe('e1')
    expect(secilenler[0].changed).toBe(false)
  })

  it('hedef andan önce sürümü olmayan varlığı atlar', () => {
    const secilenler = restoreStateAt({
      targetTimeMs: 1000,
      entities: [
        { opaqueEntityId: 'e1', entityType: 'session', entityVersion: v(9000), document: { id: 'e1' } },
      ],
      revisions: [],
    })
    expect(secilenler).toHaveLength(0)
  })

  it('silmeleri tombstone olarak işaretler', () => {
    const secilenler = restoreStateAt({
      targetTimeMs: 9000,
      entities: [],
      revisions: [
        {
          opaqueEntityId: 'e1',
          entityType: 'tombstone',
          revisionId: 'r1',
          entityVersion: v(2000),
          document: { deleted: true },
        },
      ],
    })
    expect(secilenler[0].deleted).toBe(true)
  })

  it('aynı anda birden çok varlığı işler', () => {
    const secilenler = restoreStateAt({
      targetTimeMs: 9000,
      entities: [
        { opaqueEntityId: 'e2', entityType: 'session', entityVersion: v(1000), document: { id: 'e2' } },
        { opaqueEntityId: 'e1', entityType: 'setting', entityVersion: v(1000), document: { id: 'e1' } },
      ],
      revisions: [],
    })
    expect(secilenler.map(s => s.opaqueEntityId)).toEqual(['e1', 'e2'])
  })

  it('bozuk sürümü olan kaydı atlar', () => {
    const secilenler = restoreStateAt({
      targetTimeMs: 9000,
      entities: [{ opaqueEntityId: 'e1', entityVersion: null, document: {} }],
      revisions: [],
    })
    expect(secilenler).toHaveLength(0)
  })

  it('hedef an verilmezse hata verir', () => {
    expect(() => restoreStateAt({ entities: [], revisions: [] })).toThrow('restore_target_missing')
  })
})

describe('revizyon saklama', () => {
  it('yedi günden eski revizyonları atar', () => {
    const now = 10 * GUN
    const { kept, dropped } = pruneExpiredRevisions(
      [
        { entityVersion: { wallTimeMs: now - 1 * GUN, logicalCounter: 0, deviceId: 'a' } },
        { entityVersion: { wallTimeMs: now - 9 * GUN, logicalCounter: 0, deviceId: 'a' } },
      ],
      { now },
    )
    expect(kept).toHaveLength(1)
    expect(dropped).toHaveLength(1)
  })

  it('bozuk kaydı atar', () => {
    const { kept, dropped } = pruneExpiredRevisions([{ entityVersion: null }], { now: 1000 })
    expect(kept).toHaveLength(0)
    expect(dropped).toHaveLength(1)
  })

  it('boş girdide çökmez', () => {
    expect(pruneExpiredRevisions(null).kept).toEqual([])
    expect(pruneExpiredRevisions().dropped).toEqual([])
  })
})

describe('kurtarma kiti dosyası', () => {
  const kod = 'ABCDEFGH23456789ABCDEFGH23456789'

  it('kodu, maskeli hesabı ve anahtar sürümünü taşır', () => {
    const metin = recoveryKitDocument({
      code: kod,
      email: 'saatsami@gmail.com',
      createdAt: Date.UTC(2026, 8, 22),
    })
    expect(metin).toContain('HeraAi Hesap Kurtarma Kiti')
    expect(metin).toContain('ABCD-EFGH-2345-6789-ABCD-EFGH-2345-6789')
    expect(metin).toContain('saa***@gmail.com')
    expect(metin).toContain('Anahtar sürümü: v1 · Şema: v1')
    expect(metin).toContain('2026-09-22')
  })

  it('API anahtarı ve sohbet içermediğini açıkça yazar', () => {
    const metin = recoveryKitDocument({ code: kod, email: 'a@b.com' })
    expect(metin).toContain('API anahtarları yoktur')
    expect(metin).toContain('Sohbet içerikleri yoktur')
    expect(metin).not.toContain('AIza')
  })

  it('acil durum talimatlarını içerir', () => {
    const metin = recoveryKitDocument({ code: kod, email: 'a@b.com' })
    expect(metin).toContain('ACİL DURUM TALİMATLARI')
    expect(metin).toContain('kurtarılamaz')
  })

  it('İngilizce metin üretir', () => {
    const metin = recoveryKitDocument({ code: kod, email: 'a@b.com', locale: 'en' })
    expect(metin).toContain('HeraAi Account Recovery Kit')
    expect(metin).toContain('EMERGENCY INSTRUCTIONS')
  })

  it('kodu gruplu yazar', () => {
    const metin = recoveryKitDocument({ code: 'abcd efgh 2345 6789 abcd efgh 2345 6789', email: 'a@b.com' })
    expect(metin).toContain('ABCD-EFGH-2345-6789-ABCD-EFGH-2345-6789')
  })
})

describe('dosya adları ve özet', () => {
  it('yedek dosya adını üretir', () => {
    const ad = backupFileName({ now: new Date(2026, 8, 22, 12, 0, 0).getTime() })
    expect(ad).toBe(`heraai-yedek-2026-09-22${BACKUP_EXTENSION}`)
    expect(ad.endsWith('.heraai-backup')).toBe(true)
  })

  it('zarf özetini çıkarır', async () => {
    const zarf = await encryptBackup({
      backupKey,
      payload: buildBackupPayload({ sessions: [{ id: 's1' }], createdAt: 7000 }),
      compress: false,
    })
    const ozet = summarizeBackup(zarf)
    expect(ozet.createdAt).toBe(7000)
    expect(ozet.counts.sessions).toBe(1)
    expect(ozet.sizeBytes).toBeGreaterThan(0)
  })

  it('boş zarfta null döner', () => {
    expect(summarizeBackup(null)).toBeNull()
  })
})

describe('katman kataloğu', () => {
  it('plan değerlerini bildirir', () => {
    const katalog = describeBackupLayer()
    expect(katalog.extension).toBe('.heraai-backup')
    expect(katalog.recoveryKit).toBe(RECOVERY_KIT_FILENAME)
    expect(katalog.restorePointDays).toBe(7)
    expect(katalog.formatVersion).toBe(1)
  })
})
