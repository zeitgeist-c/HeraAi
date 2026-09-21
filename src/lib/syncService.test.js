/**
 * HeraAi 1.10.0 — Eşitleme servisi testleri (Aşama 13).
 *
 * Motor ve hesap bayrakları taklit edilir; servis sözleşmesi doğrulanır.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createSyncService, describeSyncService } from './syncService'
import { ACCOUNT_STATE, SYNC_BADGE } from './accountUiState'
import { SYNC_STATE } from './syncEngine'

let bayraklar
let engine
let yazilanlar
let cagrilar
let online
let servis

function kur(ek = {}) {
  return createSyncService({
    engine,
    readFlags: async () => bayraklar,
    writeFlags: async yama => {
      yazilanlar.push(yama)
      bayraklar = { ...bayraklar, ...yama }
    },
    isOnline: () => online,
    now: () => 5000,
    ...ek,
  })
}

beforeEach(() => {
  bayraklar = { signedIn: false, recoveryAcknowledged: false, paused: false, uid: null, email: null }
  yazilanlar = []
  cagrilar = []
  online = true
  engine = {
    runOnce: vi.fn(async () => ({ pushed: 1, pulled: 2, applied: 2, at: 4000 })),
    getStatus: vi.fn(() => ({ state: SYNC_STATE.IDLE, running: false, lastRun: { pushed: 1 } })),
  }
  servis = kur()
})

describe('servis sözleşmesi', () => {
  it('plandaki tüm metotları sunar', () => {
    const katalog = describeSyncService()
    for (const ad of katalog.methods) {
      expect(typeof servis[ad]).toBe('function')
    }
    expect(katalog.badges).toContain('syncing')
  })

  it('motorsuz kurulumu reddeder', () => {
    expect(() => createSyncService({})).toThrow('sync_service_engine_missing')
    expect(() => createSyncService({ engine: { runOnce: () => {} } })).toThrow(
      'sync_service_engine_missing',
    )
  })
})

describe('hesap kurulumu', () => {
  it('kurulum akışını çalıştırır ve bayrakları yazar', async () => {
    const s = kur({
      initializeAccount: async () => ({ uid: 'u1', email: 'a@b.com', code: 'KOD' }),
    })
    const sonuc = await s.initializeAccount()
    expect(sonuc.ok).toBe(true)
    expect(sonuc.code).toBe('KOD')
    expect(bayraklar.signedIn).toBe(true)
    expect(bayraklar.recoveryAcknowledged).toBe(false)
    expect(bayraklar.uid).toBe('u1')
  })

  it('zaten kuruluysa tekrar kurmaz', async () => {
    bayraklar = { signedIn: true, recoveryAcknowledged: true, uid: 'u1' }
    const s = kur({ initializeAccount: async () => ({ uid: 'u1' }) })
    const sonuc = await s.initializeAccount()
    expect(sonuc.ok).toBe(false)
    expect(sonuc.reason).toBe('already_initialized')
  })

  it('kurulum akışı yoksa açık hata verir', async () => {
    await expect(servis.initializeAccount()).rejects.toThrow('sync_initialize_unavailable')
  })

  it('kurtarma kodu onayını kaydeder', async () => {
    bayraklar = { signedIn: true, recoveryAcknowledged: false }
    await servis.acknowledgeRecovery()
    expect(bayraklar.recoveryAcknowledged).toBe(true)
    const durum = await servis.getStatus()
    expect(durum.accountState).toBe(ACCOUNT_STATE.CONNECTED)
  })
})

describe('cihaz bağlama', () => {
  it('kurtarma koduyla bağlar ve onaylı sayar', async () => {
    const s = kur({
      linkDevice: async kod => ({ uid: 'u2', email: 'b@c.com', code: kod }),
    })
    const sonuc = await s.linkDevice('ABCD-EFGH')
    expect(sonuc.ok).toBe(true)
    expect(bayraklar.signedIn).toBe(true)
    expect(bayraklar.recoveryAcknowledged).toBe(true)
    expect(bayraklar.uid).toBe('u2')
  })

  it('bağlama akışı yoksa açık hata verir', async () => {
    await expect(servis.linkDevice('KOD')).rejects.toThrow('sync_link_unavailable')
  })
})

describe('çevrim ve durum', () => {
  it('eşitlerken motoru çağırır', async () => {
    bayraklar.signedIn = true
    const sonuc = await servis.syncNow()
    expect(sonuc.pushed).toBe(1)
    expect(engine.runOnce).toHaveBeenCalledTimes(1)
  })

  it('duraklatılmışsa motoru hiç çağırmaz', async () => {
    bayraklar.paused = true
    const sonuc = await servis.syncNow()
    expect(sonuc.skipped).toBe('paused')
    expect(engine.runOnce).not.toHaveBeenCalled()
  })

  it('duraklat ve devam et bayrağı çevirir', async () => {
    await servis.pause()
    expect(bayraklar.paused).toBe(true)
    await servis.resume()
    expect(bayraklar.paused).toBe(false)
  })

  it('durum özeti hesap ve rozeti birleştirir', async () => {
    bayraklar = { signedIn: true, recoveryAcknowledged: true, uid: 'u1', email: 'a@b.com' }
    const durum = await servis.getStatus()
    expect(durum.accountState).toBe(ACCOUNT_STATE.CONNECTED)
    expect(durum.signedIn).toBe(true)
    expect(durum.email).toBe('a@b.com')
    expect(durum.badge).toBe(SYNC_BADGE.UP_TO_DATE)
    expect(durum.at).toBe(5000)
  })

  it('çevrimdışıyken rozet çevrimdışı olur', async () => {
    online = false
    bayraklar.signedIn = true
    const durum = await servis.getStatus()
    expect(durum.badge).toBe(SYNC_BADGE.OFFLINE)
    expect(durum.online).toBe(false)
  })

  it('duraklatılmış rozet her şeyden önce gelir', async () => {
    bayraklar = { signedIn: true, paused: true }
    engine.getStatus.mockReturnValue({ state: SYNC_STATE.SYNCING, running: true, lastRun: null })
    const durum = await servis.getStatus()
    expect(durum.badge).toBe(SYNC_BADGE.PAUSED)
  })

  it('motor hatasını rozete yansıtır', async () => {
    engine.getStatus.mockReturnValue({ state: SYNC_STATE.ERROR, running: false, lastRun: null })
    const durum = await servis.getStatus()
    expect(durum.badge).toBe(SYNC_BADGE.ERROR)
  })

  it('giriş yokken hesap durumu bağlı değil', async () => {
    const durum = await servis.getStatus()
    expect(durum.accountState).toBe(ACCOUNT_STATE.DISCONNECTED)
  })

  it('bayrak okuma hata verirse güvenli varsayılana düşer', async () => {
    const s = kur({
      readFlags: async () => {
        throw new Error('okuma_hatasi')
      },
    })
    const durum = await s.getStatus()
    expect(durum.signedIn).toBe(false)
    expect(durum.accountState).toBe(ACCOUNT_STATE.DISCONNECTED)
  })
})

describe('bağlantı kesme ve cihaz iptali', () => {
  it('bağlantıyı keser ve bayrakları temizler', async () => {
    bayraklar = { signedIn: true, recoveryAcknowledged: true, uid: 'u1', email: 'a@b.com' }
    const s = kur({ disconnectDevice: async () => cagrilar.push('disconnect') })
    const sonuc = await s.disconnect()
    expect(sonuc.ok).toBe(true)
    expect(cagrilar).toContain('disconnect')
    expect(bayraklar.signedIn).toBe(false)
    expect(bayraklar.uid).toBeNull()
    expect(bayraklar.email).toBeNull()
  })

  it('bağlantı kesme akışı olmasa da yerel bayrakları temizler', async () => {
    bayraklar = { signedIn: true, uid: 'u1' }
    const sonuc = await servis.disconnect()
    expect(sonuc.ok).toBe(true)
    expect(bayraklar.signedIn).toBe(false)
  })

  it('cihaz iptalini iletir', async () => {
    const s = kur({
      revokeDevice: async (deviceId, rotate) => {
        cagrilar.push([deviceId, rotate])
        return { revokedAt: 1 }
      },
    })
    const sonuc = await s.revoke('cihaz-b', true)
    expect(sonuc.ok).toBe(true)
    expect(sonuc.rotated).toBe(true)
    expect(cagrilar).toEqual([['cihaz-b', true]])
  })

  it('cihaz kimliği yoksa hata verir', async () => {
    await expect(servis.revoke()).rejects.toThrow('sync_device_id_missing')
  })

  it('iptal akışı yoksa açık hata verir', async () => {
    await expect(servis.revoke('cihaz-b')).rejects.toThrow('sync_revoke_unavailable')
  })
})

describe('geri yükleme', () => {
  it('geri yükleme akışını iletir', async () => {
    const s = kur({
      restorePoint: async ts => {
        cagrilar.push(ts)
        return { applied: 3 }
      },
    })
    const sonuc = await s.restore(1700000000000)
    expect(sonuc.ok).toBe(true)
    expect(sonuc.applied).toBe(3)
    expect(cagrilar).toEqual([1700000000000])
  })

  it('geçersiz zaman damgasını reddeder', async () => {
    await expect(servis.restore('abc')).rejects.toThrow('sync_restore_timestamp_invalid')
    await expect(servis.restore(null)).rejects.toThrow('sync_restore_timestamp_invalid')
  })

  it('geri yükleme akışı yoksa açık hata verir', async () => {
    await expect(servis.restore(1234)).rejects.toThrow('sync_restore_unavailable')
  })
})

describe('eşitleme anahtarı', () => {
  it('eşitlemeyi kapatıp açar', async () => {
    await servis.setSyncEnabled(false)
    expect(bayraklar.syncEnabled).toBe(false)
    await servis.setSyncEnabled(true)
    expect(bayraklar.syncEnabled).toBe(true)
  })
})
