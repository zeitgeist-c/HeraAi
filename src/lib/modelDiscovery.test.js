import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverModels, mergeDiscoveryResults, normalizeDiscoveredModel } from './modelDiscovery'
import { configureModelCatalog, getModelDescriptor, getOpenRouterFallbackModel, modelAllowsKey, resolveModelSelection } from './models'

afterEach(() => configureModelCatalog(null))
const openModel = id => ({ id, name: id, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0.01', completion: '0.02' } })
describe('personal model catalog', () => {
  it('keeps key secrets out of URLs and cached metadata, follows Gemini pages', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ models: [{ name: 'models/future-chat', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'next' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [{ name: 'models/embed', supportedGenerationMethods: ['embedContent'] }] }) })
    const result = await discoverModels('gemini', 'secret-key', 'key-id', { fetcher })
    expect(result).toHaveLength(1)
    expect(result[0].capabilities.supportsImage).toBe(false)
    expect(JSON.stringify(result)).not.toContain('secret-key')
    expect(fetcher.mock.calls[0][0]).not.toContain('secret-key')
    expect(fetcher.mock.calls[1][0]).toContain('pageToken=next')
    expect(fetcher.mock.calls[0][1].headers['x-goog-api-key']).toBe('secret-key')
  })
  it('keeps provider identity and key provenance, enables only selected models', () => {
    const a = normalizeDiscoveredModel('openrouter', openModel('same/model'), 'a')
    const b = normalizeDiscoveredModel('openrouter', openModel('same/model'), 'b')
    const c = normalizeDiscoveredModel('ollama', { name: 'same/model' }, 'c')
    const models = mergeDiscoveryResults([[a], [b, c]])
    expect(models).toHaveLength(2)
    expect(models[0].sourceKeyIds).toEqual(['a', 'b'])
    configureModelCatalog({ models, enabledKeys: [a.key] })
    expect(getModelDescriptor('same/model', 'ollama')).toBeNull()
    expect(resolveModelSelection('openrouter', 'same/model').provider).toBe('openrouter')
    expect(modelAllowsKey('same/model', 'openrouter', 'c')).toBe(false)
    expect(getOpenRouterFallbackModel('same/model')).toBeNull()
  })
  it('does not accept unsafe IDs or non-chat outputs', () => {
    expect(normalizeDiscoveredModel('openrouter', openModel('openrouter/free'), 'a')).toBeNull()
    expect(normalizeDiscoveredModel('openrouter', openModel('../bad'), 'a')).toBeNull()
    expect(normalizeDiscoveredModel('openrouter', { ...openModel('image'), architecture: { output_modalities: ['image'] } }, 'a')).toBeNull()
  })
  it('fails a partial refresh instead of silently truncating the catalog', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 403 })
    await expect(discoverModels('openrouter', 'key', 'id', { fetcher })).rejects.toThrow('403')
  })
  it('never falls back to disabled defaults when a personal catalog exists', () => {
    const a = normalizeDiscoveredModel('openrouter', openModel('selected'), 'a')
    configureModelCatalog({ models: [a], enabledKeys: [a.key] })
    expect(resolveModelSelection('gemini', 'missing').key).toBe(a.key)
    expect(getModelDescriptor('gemini-3.1-flash-lite')).toBeNull()
  })
})
