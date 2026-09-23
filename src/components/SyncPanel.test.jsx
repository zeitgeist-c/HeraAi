import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../i18n'
import SyncPanel from './SyncPanel'

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

function mockChrome({ status = baseStatus, devices = baseDevices } = {}) {
  chrome.runtime.sendMessage.mockImplementation((message, callback) => {
    const respond = response => callback?.(response)
    if (message.type === 'SYNC_GET_STATUS') respond({ ok: true, status })
    else if (message.type === 'SYNC_LIST_DEVICES') respond({ ok: true, devices })
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
