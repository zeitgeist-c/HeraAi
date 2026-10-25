import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ModelManagement from './ModelManagement'
import { discoverModels } from '../lib/modelDiscovery'
import { getKeys, getRawKey } from '../lib/keyManager'
import '../i18n'

vi.mock('../lib/keyManager', () => ({ getKeys: vi.fn(), getRawKey: vi.fn() }))
vi.mock('../lib/modelDiscovery', async original => ({ ...(await original()), discoverModels: vi.fn() }))
const model = { key: 'openrouter:test/model', provider: 'openrouter', modelId: 'test/model', label: 'Test model', sourceKeyIds: ['key1'], capabilities: {} }
describe('model management user flow', () => {
  let storage
  beforeEach(() => {
    vi.clearAllMocks()
    storage = { modelPreferences: { models: [model], enabledKeys: ['gemini:gemini-3.1-flash-lite'] } }
    chrome.storage.local.get.mockImplementation(async () => storage)
    chrome.storage.local.set.mockImplementation(async patch => { storage = { ...storage, ...patch } })
    getKeys.mockImplementation(async provider => provider === 'openrouter' ? [{ id: 'key1' }] : [])
    getRawKey.mockResolvedValue('secret')
    discoverModels.mockResolvedValue([model])
  })
  it('selects a discovered model and saves only metadata, not secrets', async () => {
    render(<ModelManagement />)
    const input = await screen.findByRole('checkbox', { name: /Test model/ })
    await waitFor(() => expect(input).toBeEnabled())
    fireEvent.click(input)
    await waitFor(() => expect(storage.modelPreferences.enabledKeys).toContain(model.key))
    expect(JSON.stringify(storage)).not.toContain('secret')
  })
  it('preserves the last catalog on refresh failure', async () => {
    discoverModels.mockRejectedValue(new Error('403'))
    render(<ModelManagement />)
    const button = screen.getByRole('button', { name: /getir|refresh/i })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    await screen.findByRole('alert')
    expect(storage.modelPreferences.models).toEqual([model])
    expect(screen.getByRole('checkbox', { name: /Test model/ })).toBeInTheDocument()
  })
  it('does not enable newly discovered models automatically', async () => {
    render(<ModelManagement />)
    const button = screen.getByRole('button', { name: /getir|refresh/i })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    await waitFor(() => expect(storage.modelPreferences.refreshedAt).toBeTruthy())
    expect(storage.modelPreferences.enabledKeys).not.toContain(model.key)
  })
})
