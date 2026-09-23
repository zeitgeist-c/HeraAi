/**
 * HeraAi 1.10.0 — Hesap ve eşitleme arayüz durumu testleri (Aşama 11).
 */

import { describe, expect, it } from 'vitest'

import {
  ACCOUNT_STATE,
  DESTRUCTIVE_ACTIONS,
  SYNC_BADGE,
  confirmationFor,
  describeAccountUi,
  deviceRow,
  firstMergeSummary,
  formatRecoveryCode,
  isLocalOnlySession,
  maskAccount,
  recoveryCodeGroups,
  recoveryKitText,
  resolveAccountState,
  sessionPolicyLabel,
  sessionPolicyOptions,
  syncBadgeFor,
  syncBadgeLabel,
} from './accountUiState'
import { SYNC_STATE } from './syncEngine'

describe('hesap durumu', () => {
  it('giriş yoksa bağlı değil', () => {
    expect(resolveAccountState({ signedIn: false })).toBe(ACCOUNT_STATE.DISCONNECTED)
    expect(resolveAccountState({})).toBe(ACCOUNT_STATE.DISCONNECTED)
  })

  it('kurtarma kodu onaylanmadıysa ilk kurulum', () => {
    expect(resolveAccountState({ signedIn: true })).toBe(ACCOUNT_STATE.ONBOARDING)
    expect(resolveAccountState({ signedIn: true, recoveryAcknowledged: false })).toBe(
      ACCOUNT_STATE.ONBOARDING,
    )
  })

  it('onaylandıysa bağlı', () => {
    expect(resolveAccountState({ signedIn: true, recoveryAcknowledged: true })).toBe(
      ACCOUNT_STATE.CONNECTED,
    )
  })
})

describe('eşitleme rozeti', () => {
  it('duraklatma her şeyden önce gelir', () => {
    expect(syncBadgeFor({ syncState: SYNC_STATE.SYNCING, paused: true })).toBe(SYNC_BADGE.PAUSED)
    expect(syncBadgeFor({ syncState: SYNC_STATE.ERROR, paused: true })).toBe(SYNC_BADGE.PAUSED)
  })

  it('çevrimdışılık hata ve eşitleniyordan önce gelir', () => {
    expect(syncBadgeFor({ syncState: SYNC_STATE.ERROR, online: false })).toBe(SYNC_BADGE.OFFLINE)
    expect(syncBadgeFor({ syncState: SYNC_STATE.SYNCING, online: false })).toBe(SYNC_BADGE.OFFLINE)
  })

  it('durumları rozetlere çevirir', () => {
    expect(syncBadgeFor({ syncState: SYNC_STATE.SYNCING })).toBe(SYNC_BADGE.SYNCING)
    expect(syncBadgeFor({ syncState: SYNC_STATE.ERROR })).toBe(SYNC_BADGE.ERROR)
    expect(syncBadgeFor({ syncState: SYNC_STATE.IDLE })).toBe(SYNC_BADGE.UP_TO_DATE)
    expect(syncBadgeFor({ syncState: SYNC_STATE.SIGNED_OUT })).toBe(SYNC_BADGE.UP_TO_DATE)
    expect(syncBadgeFor({})).toBe(SYNC_BADGE.UP_TO_DATE)
  })

  it('rozet metinlerini verir', () => {
    expect(syncBadgeLabel(SYNC_BADGE.UP_TO_DATE)).toBe('Güncel')
    expect(syncBadgeLabel(SYNC_BADGE.SYNCING)).toBe('Eşitleniyor')
    expect(syncBadgeLabel(SYNC_BADGE.OFFLINE)).toBe('Çevrimdışı')
    expect(syncBadgeLabel(SYNC_BADGE.ERROR)).toBe('Hata')
    expect(syncBadgeLabel('bilinmeyen')).toBe('Güncel')
  })
})

describe('ilk birleştirme özeti', () => {
  it('sayıları toplar ve etiket üretir', () => {
    const ozet = firstMergeSummary({ sessions: 12, settings: 9, apiKeys: 4 })
    expect(ozet.total).toBe(25)
    expect(ozet.isEmpty).toBe(false)
    expect(ozet.label).toBe('12 sohbet · 9 ayar · 4 API anahtarı')
  })

  it('boş kurulumu bildirir', () => {
    const ozet = firstMergeSummary()
    expect(ozet.total).toBe(0)
    expect(ozet.isEmpty).toBe(true)
  })

  it('geçersiz değerleri sıfır sayar', () => {
    const ozet = firstMergeSummary({ sessions: 'abc', settings: -5, apiKeys: null })
    expect(ozet.total).toBe(0)
  })
})

describe('hesap maskeleme', () => {
  it('e-postayı maskeler', () => {
    expect(maskAccount('example@gmail.com')).toBe('mah***@gmail.com')
    expect(maskAccount('saatsami@gmail.com')).toBe('saa***@gmail.com')
  })

  it('kısa kullanıcı adını tamamen maskeler', () => {
    expect(maskAccount('ab@gmail.com')).toBe('***@gmail.com')
  })

  it('boş ve geçersiz girdide çökmez', () => {
    expect(maskAccount('')).toBe('')
    expect(maskAccount(null)).toBe('')
    expect(maskAccount('abc')).toBe('ab***')
  })
})

describe('kurtarma kodu biçimlendirme', () => {
  it('gruplu gösterim üretir', () => {
    expect(formatRecoveryCode('ABCDEFGH23456789')).toBe('ABCD-EFGH-2345-6789')
  })

  it('ayraçları ve küçük harfi normalize eder', () => {
    expect(formatRecoveryCode('abcd-efgh 2345_6789')).toBe('ABCD-EFGH-2345-6789')
  })

  it('tamamlanma durumunu bildirir', () => {
    // 160-bit kod = 8 grup x 4 karakter = 32 karakter.
    const kod = 'ABCDEFGH23456789ABCDEFGH23456789'
    expect(recoveryCodeGroups(kod).complete).toBe(true)
    expect(recoveryCodeGroups('ABCD').complete).toBe(false)
    expect(recoveryCodeGroups(kod).groups).toBe(8)
    expect(recoveryCodeGroups(kod).groupSize).toBe(4)
  })
})

describe('kurtarma kiti metni', () => {
  it('kodu, maskeli hesabı ve uyarıları taşır', () => {
    const metin = recoveryKitText({
      code: 'ABCDEFGH23456789ABCDEFGH23456789',
      email: 'saatsami@gmail.com',
      createdAt: Date.UTC(2026, 8, 22),
    })
    expect(metin).toContain('HeraAi Kurtarma Kiti')
    expect(metin).toContain('ABCD-EFGH-2345-6789-ABCD-EFGH-2345-6789')
    expect(metin).toContain('saa***@gmail.com')
    expect(metin).toContain('2026-09-22')
    expect(metin).toContain('kurtarılamaz')
    expect(metin).not.toContain('saatsami@gmail.com')
  })

  it('İngilizce metin üretir', () => {
    const metin = recoveryKitText({ code: 'ABCDEFGH23456789ABCDEFGH23456789', email: 'a@b.com', locale: 'en' })
    expect(metin).toContain('HeraAi Recovery Kit')
    expect(metin).toContain('Recovery code:')
  })

  it('tarih yoksa satırı atlar', () => {
    const metin = recoveryKitText({ code: 'ABCDEFGH23456789ABCDEFGH23456789', email: 'a@b.com' })
    expect(metin).not.toContain('Oluşturma:')
  })
})

describe('yerel sohbet politikası', () => {
  it('politika etiketlerini verir', () => {
    expect(sessionPolicyLabel('synced')).toBe('Bu sohbeti eşitle')
    expect(sessionPolicyLabel('local_only')).toBe('Yalnız bu cihazda tut')
    expect(sessionPolicyLabel('gecersiz')).toBe('Bu sohbeti eşitle')
  })

  it('yalnız cihazda kalma durumunu bildirir', () => {
    expect(isLocalOnlySession('local_only')).toBe(true)
    expect(isLocalOnlySession('synced')).toBe(false)
    expect(isLocalOnlySession(undefined)).toBe(false)
  })

  it('menü seçeneklerini üretir', () => {
    const secenekler = sessionPolicyOptions()
    expect(secenekler).toHaveLength(2)
    expect(secenekler[0].value).toBe('synced')
    expect(secenekler[1].value).toBe('local_only')
  })
})

describe('cihaz yönetimi', () => {
  it('kendi cihazımızı işaretler ve kaldırılamaz sayar', () => {
    const satir = deviceRow({
      device: { deviceId: 'a', name: 'Dizüstü' },
      currentDeviceId: 'a',
    })
    expect(satir.isCurrent).toBe(true)
    expect(satir.canRevoke).toBe(false)
    expect(satir.canForceRemove).toBe(false)
    expect(satir.label).toBe('Dizüstü')
  })

  it('diğer cihazları kaldırılabilir sayar', () => {
    const satir = deviceRow({ device: { deviceId: 'bbbbbbbbbb' }, currentDeviceId: 'a' })
    expect(satir.isCurrent).toBe(false)
    expect(satir.canRevoke).toBe(true)
    expect(satir.canForceRemove).toBe(true)
    expect(satir.label).toBe('bbbbbbbb')
  })

  it('iptal edilmiş cihazı tekrar iptal ettirmez', () => {
    const satir = deviceRow({
      device: { deviceId: 'b', revokedAt: 123 },
      currentDeviceId: 'a',
    })
    expect(satir.revoked).toBe(true)
    expect(satir.canRevoke).toBe(false)
  })

  it('kapatılmış cihazı durum bilgisiyle taşır', () => {
    const satir = deviceRow({
      device: { deviceId: 'b', disabledAt: 500 },
      currentDeviceId: 'a',
    })
    expect(satir.disabled).toBe(true)
    expect(satir.canToggle).toBe(true)
    expect(satir.canRename).toBe(true)
  })

  it('iptal edilmiş cihazda aç/kapat ve ad verme kapalıdır', () => {
    const satir = deviceRow({
      device: { deviceId: 'b', revokedAt: 123 },
      currentDeviceId: 'a',
    })
    expect(satir.disabled).toBe(false)
    expect(satir.canToggle).toBe(false)
    expect(satir.canRename).toBe(false)
  })

  it('geçersiz kayıtta null döner', () => {
    expect(deviceRow({})).toBeNull()
    expect(deviceRow()).toBeNull()
  })
})

describe('yıkıcı işlem onayları', () => {
  it('her işlem için onay metni vardır', () => {
    for (const islem of Object.values(DESTRUCTIVE_ACTIONS)) {
      const onay = confirmationFor(islem)
      expect(onay).toBeTruthy()
      expect(onay.title.length).toBeGreaterThan(0)
      expect(onay.confirmLabel.length).toBeGreaterThan(0)
    }
  })

  it('tüm veri silme onayı geri alınamazlığı bildirir', () => {
    const onay = confirmationFor(DESTRUCTIVE_ACTIONS.DELETE_ALL_CLOUD_DATA)
    expect(onay.body).toContain('geri alınamaz')
  })

  it('bilinmeyen işlem null döner', () => {
    expect(confirmationFor('bilinmeyen')).toBeNull()
  })
})

describe('katalog', () => {
  it('plan değerlerini bildirir', () => {
    const katalog = describeAccountUi()
    expect(katalog.states).toEqual(['disconnected', 'onboarding', 'connected'])
    expect(katalog.badges).toContain('syncing')
    expect(katalog.policies).toEqual(['synced', 'local_only'])
    expect(katalog.destructiveActions).toHaveLength(3)
  })
})
