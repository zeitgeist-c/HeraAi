import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../i18n'
import SyncPanel from './SyncPanel'
import { notifyError, notifySuccess } from '../lib/notify'

vi.mock('../lib/notify')

const baseStatus = {
  signedIn: true,
  accountExists: true,
  linked: true,
  paused: false,
  deviceDisabled: false,
  pending: 0,
  lastSyncAt: Date.parse('2026-09-22T11:26:16Z'),
  lastError: null,
  lastErrorCode: null,
  blockedUntil: null,
  user: { email: 'user@example.com' },
  deviceId: 'dev-1',
}

const baseDevices = [
  { id: 'dev-1', label: 'HeraAi - Windows', disabledAt: null, lastSyncedAt: 1 },
  { id: 'dev-2', label: 'Ofis dizüstü', disabledAt: 1_700_000, lastSyncedAt: 2 },
]

const baseAuto = {
  intervalMinutes: 60,
  usage: { dayKey: '2026-09-24', reads: 120, writes: 40 },
  ratio: { reads: 0.0024, writes: 0.002 },
  slowMode: false,
}

function mockChrome({ status = baseStatus, devices = baseDevices, auto = baseAuto } = {}) {
  chrome.runtime.sendMessage.mockImplementation((message, callback) => {
    const respond = response => callback?.(response)
    if (message.type === 'SYNC_GET_STATUS') respond({ ok: true, status })
    else if (message.type === 'SYNC_LIST_DEVICES') respond({ ok: true, devices })
    else if (message.type === 'SYNC_GET_AUTO_SETTINGS') respond({ ok: true, ...auto })
    else respond({ ok: true })
    return Promise.resolve()
  })
}

function sentMessages(type) {
  return chrome.runtime.sendMessage.mock.calls
    .map(([message]) => message)
    .filter(message => message.type === type)
}

// Cihaz listesi kapalı başlar (Varyant A): satırlara dokunan testler önce bölümü açar.
// Panel önce yükleme göstergesi çizer, bu yüzden başlık beklenir.
async function expandDevices() {
  const heading = await screen.findByRole('button', { name: 'Linked devices' })
  if (heading.getAttribute('aria-expanded') === 'false') fireEvent.click(heading)
}

beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage('en')
  mockChrome()
})

describe('SyncPanel cihaz listesi', () => {
  it('açık cihazda kapat, ad ver ve sil butonlarını gösterir', async () => {
    render(<SyncPanel />)
    await expandDevices()

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Turn off device' })).toHaveLength(1))
    expect(screen.getAllByRole('button', { name: 'Turn on device' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Rename device' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Revoke device access' })).toHaveLength(2)
    expect(screen.getByText('Off')).toBeInTheDocument()
    expect(screen.getByText('Ofis dizüstü')).toBeInTheDocument()
  })

  it('kapalı cihazı açar ve doğru mesajı gönderir', async () => {
    render(<SyncPanel />)
    await expandDevices()

    fireEvent.click(await screen.findByRole('button', { name: 'Turn on device' }))

    await waitFor(() => expect(sentMessages('SYNC_SET_DEVICE_ENABLED')).toHaveLength(1))
    expect(sentMessages('SYNC_SET_DEVICE_ENABLED')[0]).toEqual({
      type: 'SYNC_SET_DEVICE_ENABLED',
      deviceId: 'dev-2',
      enabled: true,
    })
  })

  it('ad verme satır içi input açar ve Enter ile kaydeder', async () => {
    render(<SyncPanel />)
    await expandDevices()
    const renameButtons = await screen.findAllByRole('button', { name: 'Rename device' })

    fireEvent.click(renameButtons[1])

    const input = screen.getByLabelText('Device name')
    expect(input.value).toBe('Ofis dizüstü')

    fireEvent.change(input, { target: { value: 'Salon PC' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(sentMessages('SYNC_RENAME_DEVICE')).toHaveLength(1))
    expect(sentMessages('SYNC_RENAME_DEVICE')[0]).toEqual({
      type: 'SYNC_RENAME_DEVICE',
      deviceId: 'dev-2',
      label: 'Salon PC',
    })
  })

  it('Escape ile ad değişikliğini iptal eder', async () => {
    render(<SyncPanel />)
    await expandDevices()
    const renameButtons = await screen.findAllByRole('button', { name: 'Rename device' })

    fireEvent.click(renameButtons[0])
    const input = screen.getByLabelText('Device name')
    fireEvent.change(input, { target: { value: 'Vazgeçilecek ad' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByLabelText('Device name')).not.toBeInTheDocument())
    expect(sentMessages('SYNC_RENAME_DEVICE')).toHaveLength(0)
    expect(screen.getByText('HeraAi - Windows')).toBeInTheDocument()
  })

  it('boş ad gönderilmez', async () => {
    render(<SyncPanel />)
    await expandDevices()
    const renameButtons = await screen.findAllByRole('button', { name: 'Rename device' })

    fireEvent.click(renameButtons[0])
    const input = screen.getByLabelText('Device name')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(screen.queryByLabelText('Device name')).not.toBeInTheDocument())
    expect(sentMessages('SYNC_RENAME_DEVICE')).toHaveLength(0)
  })
})

describe('SyncPanel kendi cihazı kapalıyken', () => {
  it('uyarı gösterir ve şimdi eşitle düğmesini kapatır', async () => {
    mockChrome({ status: { ...baseStatus, deviceDisabled: true } })
    render(<SyncPanel />)

    expect(await screen.findByText('This device is off')).toBeInTheDocument()
    expect(screen.getByText(/turned off from another device/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled()
  })
})

describe('SyncPanel erişimi kaldırılmış cihaz', () => {
  it('listede göstermez ve satırına buton koymaz', async () => {
    mockChrome({
      devices: [
        ...baseDevices,
        { id: 'dev-9', label: 'Eski cihaz', revokedAt: 123, lastSyncedAt: 3 },
      ],
    })
    render(<SyncPanel />)
    await expandDevices()

    await waitFor(() => expect(screen.getByText('Ofis dizüstü')).toBeInTheDocument())
    expect(screen.queryByText('Eski cihaz')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Revoke device access' })).toHaveLength(2)
  })
})

describe('SyncPanel cihaz akordeonu', () => {
  it('cihaz satırında son eşitleme zamanını gösterir; platform ve cihaz kimliği yok', async () => {
    mockChrome({
      devices: [
        {
          id: 'dev-1',
          label: 'Ai-Home',
          disabledAt: null,
          lastSyncedAt: Date.parse('2026-09-23T20:38:13Z'),
          platform: 'Windows',
        },
        { id: 'dev-2', label: 'Ofis dizüstü', disabledAt: null, lastSyncedAt: 1 },
      ],
    })
    render(<SyncPanel />)
    await expandDevices()

    const aiHome = await screen.findByText('Ai-Home')
    const row = aiHome.closest('section')
    expect(within(row).getByText(/Last sync/)).toBeInTheDocument()
    expect(within(row).getByText('This device')).toBeInTheDocument()

    // Akordeon ve ayrıntı satırları kaldırıldı: ok yok, panel yok, platform/kimlik yok.
    expect(screen.queryByRole('button', { name: /details/i })).toBeNull()
    expect(document.getElementById('device-panel-dev-1')).toBeNull()
    expect(screen.queryByText('Platform')).toBeNull()
    expect(screen.queryByText('Device ID')).toBeNull()

    const ofis = screen.getByText('Ofis dizüstü').closest('section')
    expect(within(ofis).getByText(/Last sync/)).toBeInTheDocument()
  })

  it('liste açıldığında hızlı işlem butonları satırda her zaman görünür', async () => {
    render(<SyncPanel />)
    await expandDevices()

    await waitFor(() => expect(screen.getByText('HeraAi - Windows')).toBeInTheDocument())
    expect(screen.getAllByRole('button', { name: 'Turn off device' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Turn on device' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Rename device' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Revoke device access' })).toHaveLength(2)
  })
})

describe('SyncPanel cihaz bölümü katlanır (Varyant A)', () => {
  it('varsayılan olarak kapalıdır ve cihaz satırlarını göstermez', async () => {
    render(<SyncPanel />)

    const heading = await screen.findByRole('button', { name: 'Linked devices' })
    expect(heading).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('HeraAi - Windows')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Turn off device' })).not.toBeInTheDocument()
    expect(document.getElementById('devices-panel')).toBeNull()
  })

  it('başlığa tıklayınca açar, tekrar tıklayınca kapatır', async () => {
    render(<SyncPanel />)

    const heading = await screen.findByRole('button', { name: 'Linked devices' })
    fireEvent.click(heading)

    expect(await screen.findByText('HeraAi - Windows')).toBeInTheDocument()
    expect(heading).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById('devices-panel')).not.toBeNull()

    fireEvent.click(heading)

    await waitFor(() => expect(screen.queryByText('HeraAi - Windows')).not.toBeInTheDocument())
    expect(heading).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById('devices-panel')).toBeNull()
  })

  it('kendi cihazını her zaman en üstte gösterir', async () => {
    mockChrome({
      devices: [
        { id: 'dev-2', label: 'Ofis dizüstü', disabledAt: null, lastSyncedAt: 2 },
        { id: 'dev-1', label: 'HeraAi - Windows', disabledAt: null, lastSyncedAt: 1 },
      ],
    })
    render(<SyncPanel />)
    await expandDevices()

    const rows = await screen.findAllByText(/HeraAi - Windows|Ofis dizüstü/)
    expect(rows[0].textContent).toBe('HeraAi - Windows')
  })

  it('kapalı cihaz sayısını başlıkta gösterir ama erişilebilir adı bozmaz', async () => {
    render(<SyncPanel />)

    const heading = await screen.findByRole('button', { name: 'Linked devices' })
    expect(within(heading).getByText('1 off')).toBeInTheDocument()
    expect(within(heading).getByText('2')).toBeInTheDocument()
  })

  it('başlıkta hesabın en son eşitlenme zamanını gösterir', async () => {
    const older = Date.parse('2026-09-23T18:41:08Z')
    const newest = Date.parse('2026-09-23T20:42:58Z')
    mockChrome({
      devices: [
        { id: 'dev-1', label: 'HeraAi - Windows', disabledAt: null, lastSyncedAt: older },
        { id: 'dev-2', label: 'Ofis dizüstü', disabledAt: null, lastSyncedAt: newest },
      ],
    })
    render(<SyncPanel />)

    // Ad tam olarak "Linked devices" kalmalı: başlıktaki özet metin aria-hidden.
    const heading = await screen.findByRole('button', { name: 'Linked devices' })
    const compact = value => `${new Date(value).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })} ${new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`

    expect(within(heading).getByText(/Last sync/)).toBeInTheDocument()
    expect(within(heading).getByText(compact(newest))).toBeInTheDocument()
    expect(within(heading).queryByText(compact(older))).toBeNull()
  })
})

describe('SyncPanel Google girişi dayanıklılığı', () => {
  const signedOutStatus = {
    signedIn: false,
    accountExists: null,
    linked: false,
    paused: false,
    deviceDisabled: false,
    pending: 0,
    lastSyncAt: null,
    lastError: null,
    lastErrorCode: null,
    blockedUntil: null,
    user: null,
    deviceId: 'dev-1',
  }

  // Chrome'un servis calisani kapandiginda urettigi ham metin.
  const channelLoss = 'The message port closed before a response was received.'

  function mockRuntime(handler, { signedOutFirst = false } = {}) {
    let statusReads = 0
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'SYNC_GET_STATUS') {
        statusReads += 1
        // Cikis ekrani gereken testlerde ilk okuma cikis, sonrasi bagli hesap.
        const status = signedOutFirst && statusReads === 1 ? signedOutStatus : baseStatus
        callback({ ok: true, status })
        return Promise.resolve()
      }
      if (handler) {
        const handled = handler(message, callback)
        if (handled) return Promise.resolve()
      }
      callback({ ok: true })
      return Promise.resolve()
    })
  }

  function failWithChannelLoss(callback) {
    chrome.runtime.lastError = { message: channelLoss }
    callback(undefined)
    chrome.runtime.lastError = null
  }

  it('giriş sürerken bekleme bilgisini gösterir', async () => {
    mockRuntime((message) => message.type === 'AUTH_SIGN_IN', { signedOutFirst: true })
    render(<SyncPanel />)

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }))

    expect(await screen.findByText('Signing in…')).toBeInTheDocument()
    expect(screen.getByText(/Complete the Google sign-in/)).toBeInTheDocument()
  })

  it('kanal koparsa oturumu doğrulayıp girişi başarılı sayar', async () => {
    mockRuntime((message, callback) => {
      if (message.type === 'AUTH_SIGN_IN') {
        failWithChannelLoss(callback)
        return true
      }
      if (message.type === 'AUTH_GET_STATE') {
        callback({ ok: true, user: { uid: 'uid-1', email: 'user@example.com' } })
        return true
      }
      return false
    }, { signedOutFirst: true })
    render(<SyncPanel />)

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }))

    expect(await screen.findByText('Sync active')).toBeInTheDocument()
    expect(notifySuccess).toHaveBeenCalledWith('Signed in to your Google account.')
    expect(notifyError).not.toHaveBeenCalled()
    expect(sentMessages('AUTH_GET_STATE').length).toBeGreaterThan(0)
  })

  it('giriş tamamlanmadıysa ham metin yerine açıklama gösterir', async () => {
    mockRuntime((message, callback) => {
      if (message.type === 'AUTH_SIGN_IN') {
        failWithChannelLoss(callback)
        return true
      }
      if (message.type === 'AUTH_GET_STATE') {
        callback({ ok: true, user: null })
        return true
      }
      return false
    }, { signedOutFirst: true })
    render(<SyncPanel />)

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }))

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Sign-in did not finish; the connection was lost. Try again.')
    }, { timeout: 10_000 })
    expect(notifyError).not.toHaveBeenCalledWith(channelLoss)
    expect(sentMessages('AUTH_GET_STATE').length).toBeGreaterThan(1)
  }, 20_000)

  it('eşitleme kanal kopmasına rağmen tamamlandıysa başarılı sayar', async () => {
    const previous = Date.parse('2026-09-22T11:26:16Z')
    let statusReads = 0
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'SYNC_GET_STATUS') {
        statusReads += 1
        // İlk okuma eski damga, sonrası ilerlemiş damga: eşitleme serviste bitmiş.
        callback({
          ok: true,
          status: { ...baseStatus, lastSyncAt: statusReads === 1 ? previous : previous + 60_000 },
        })
        return Promise.resolve()
      }
      if (message.type === 'SYNC_NOW') {
        failWithChannelLoss(callback)
        return true
      }
      callback({ ok: true })
      return Promise.resolve()
    })
    render(<SyncPanel />)

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }))

    await waitFor(() => expect(notifySuccess).toHaveBeenCalledWith('Sync completed.'))
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('eşitleme tamamlanmadıysa ham Chrome metnini göstermez', async () => {
    mockRuntime((message, callback) => {
      if (message.type === 'SYNC_NOW') {
        failWithChannelLoss(callback)
        return true
      }
      return false
    })
    render(<SyncPanel />)

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }))

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        'The browser background service was closed and the connection was lost. Try again.',
      )
    }, { timeout: 10_000 })
    expect(notifyError).not.toHaveBeenCalledWith(expect.stringContaining('message port closed'))
  }, 20_000)

  it('şifreli alan oluştuysa kurtarma kodunun gösterilemediğini söyler', async () => {
    let initializeCalls = 0
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'SYNC_GET_STATUS') {
        callback({
          ok: true,
          status: { ...baseStatus, accountExists: initializeCalls > 0, linked: false },
        })
        return Promise.resolve()
      }
      if (message.type === 'SYNC_INITIALIZE') {
        initializeCalls += 1
        failWithChannelLoss(callback)
        return true
      }
      callback({ ok: true })
      return Promise.resolve()
    })
    render(<SyncPanel />)

    fireEvent.click(await screen.findByRole('button', { name: 'Create encrypted space' }))

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringContaining('recovery code could not be shown'))
    })
    expect(notifySuccess).not.toHaveBeenCalled()
  })

  it('bozuk yedek dosyasında ayrıştırıcı metnini göstermez', async () => {
    const { container } = render(<SyncPanel />)
    await screen.findByRole('button', { name: 'Sync now' })

    const input = container.querySelector('input[type="file"]')
    const file = new File(['bu bir yedek degil'], 'bozuk.heraai-backup', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        'The backup file could not be read: it is corrupt or not a HeraAi encrypted backup.',
      )
    })
    expect(sentMessages('SYNC_IMPORT_BACKUP')).toHaveLength(0)
  })
})

describe('SyncPanel otomatik eşitleme', () => {
  it('aralık seçeneklerini gösterir ve seçili olanı işaretler', async () => {
    render(<SyncPanel />)

    const grup = await screen.findByRole('group', { name: 'Automatic sync' })
    expect(within(grup).getByRole('button', { name: '1 h' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(grup).getByRole('button', { name: 'Manual' })).toHaveAttribute('aria-pressed', 'false')
    expect(within(grup).getByRole('button', { name: '2 h' })).toHaveAttribute('aria-pressed', 'false')
    expect(within(grup).getByRole('button', { name: '6 h' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('seçim değişince aralığı kaydeder ve yeni seçimi işaretler', async () => {
    render(<SyncPanel />)
    const grup = await screen.findByRole('group', { name: 'Automatic sync' })

    mockChrome({ auto: { ...baseAuto, intervalMinutes: 360 } })
    fireEvent.click(within(grup).getByRole('button', { name: '6 h' }))

    await waitFor(() => {
      expect(sentMessages('SYNC_SET_AUTO_INTERVAL').some(message => message.minutes === 360)).toBe(true)
    })
    await waitFor(() => {
      expect(within(grup).getByRole('button', { name: '6 h' })).toHaveAttribute('aria-pressed', 'true')
    })
  })

  it('kapatıldığında kapanma notunu gösterir', async () => {
    mockChrome({ auto: { ...baseAuto, intervalMinutes: 0 } })
    render(<SyncPanel />)

    const grup = await screen.findByRole('group', { name: 'Automatic sync' })
    expect(within(grup).getByRole('button', { name: 'Manual' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/Automatic sync is off/)).toBeInTheDocument()
  })

  it('günlük kota kullanımını gösterir', async () => {
    mockChrome({
      auto: {
        intervalMinutes: 60,
        usage: { dayKey: '2026-09-24', reads: 120, writes: 40 },
        ratio: { reads: 0.24, writes: 0.05 },
        slowMode: false,
      },
    })
    render(<SyncPanel />)

    expect(await screen.findByText(/reads 24%/)).toBeInTheDocument()
    expect(screen.getByText(/writes 5%/)).toBeInTheDocument()
    expect(screen.queryByText('slow mode')).toBeNull()
  })

  it('yavaş modda rozeti ve uyarıyı gösterir', async () => {
    mockChrome({
      auto: {
        intervalMinutes: 60,
        usage: { dayKey: '2026-09-24', reads: 30_000, writes: 40 },
        ratio: { reads: 0.6, writes: 0.05 },
        slowMode: true,
      },
    })
    render(<SyncPanel />)

    expect(await screen.findByText('slow mode')).toBeInTheDocument()
    expect(screen.getByText(/passed 50%/)).toBeInTheDocument()
  })
})
