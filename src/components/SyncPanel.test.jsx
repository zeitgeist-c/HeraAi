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

beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage('en')
  mockChrome()
})

describe('SyncPanel cihaz listesi', () => {
  it('açık cihazda kapat, ad ver ve sil butonlarını gösterir', async () => {
    render(<SyncPanel />)

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Turn off device' })).toHaveLength(1))
    expect(screen.getAllByRole('button', { name: 'Turn on device' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Rename device' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Revoke device access' })).toHaveLength(2)
    expect(screen.getByText('Off')).toBeInTheDocument()
    expect(screen.getByText('Ofis dizüstü')).toBeInTheDocument()
  })

  it('kapalı cihazı açar ve doğru mesajı gönderir', async () => {
    render(<SyncPanel />)

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

    await waitFor(() => expect(screen.getByText('Ofis dizüstü')).toBeInTheDocument())
    expect(screen.queryByText('Eski cihaz')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Revoke device access' })).toHaveLength(2)
  })
})

describe('SyncPanel cihaz akordeonu', () => {
  it('cihazlar kapalı gelir, tıklayınca ayrıntılar açılır', async () => {
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

    const aiHome = await screen.findByRole('button', { name: /^Ai-Home/ })
    const aiHomeDetails = document.getElementById('device-panel-dev-1')
    expect(aiHome).toHaveAttribute('aria-expanded', 'false')
    expect(aiHomeDetails).toHaveAttribute('hidden')
    expect(screen.getAllByRole('button', { name: 'Show details' })).toHaveLength(2)

    fireEvent.click(aiHome)

    expect(aiHome).toHaveAttribute('aria-expanded', 'true')
    expect(aiHomeDetails).not.toHaveAttribute('hidden')
    expect(within(aiHomeDetails).getByText('Last sync')).toBeVisible()
    expect(within(aiHomeDetails).getByText('Platform')).toBeVisible()
    expect(within(aiHomeDetails).getByText('Windows')).toBeVisible()
    expect(within(aiHomeDetails).getByText('Device ID')).toBeVisible()
    expect(within(aiHomeDetails).getByText('dev-1…')).toBeVisible()
    expect(screen.getAllByRole('button', { name: 'Hide details' })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))

    expect(aiHome).toHaveAttribute('aria-expanded', 'false')
    expect(aiHomeDetails).toHaveAttribute('hidden')
  })

  it('hızlı işlem butonları kapalıyken de görünür', async () => {
    render(<SyncPanel />)

    await waitFor(() => expect(screen.getByText('HeraAi - Windows')).toBeInTheDocument())
    expect(screen.getAllByRole('button', { name: 'Turn off device' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Turn on device' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Rename device' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Revoke device access' })).toHaveLength(2)
  })
})
