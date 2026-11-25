import { describe, expect, it } from 'vitest'

import {
  AUTO_MODEL_KEY,
  DEFAULT_MODEL,
  MODEL_CATALOG,
  OPENROUTER_MODEL_IDS,
  describeModelFallback,
  getAutoCandidateKeys,
  getOpenRouterFallbackModel,
  getProviderForModel,
  isAutoModelKey,
  resolveModelSelection,
} from './models.js'

describe('provider-aware model catalog', () => {
  it('contains three Gemini models and three OpenRouter models', () => {
    expect(MODEL_CATALOG).toHaveLength(6)
    expect(MODEL_CATALOG.map(model => [model.provider, model.modelId])).toEqual([
      ['gemini', 'gemini-3.5-flash-lite'],
      ['gemini', 'gemini-3.6-flash'],
      ['gemini', 'gemini-4-hydrogen'],
      ['openrouter', 'nvidia/nemotron-3.5-lightning:free'],
      ['openrouter', 'nvidia/nemotron-3.5-super-vl:free'],
      ['openrouter', 'inclusionai/ling-3.2-flash:free'],
    ])
  })

  it('marks model speeds for the selector icons', () => {
    expect(Object.fromEntries(
      MODEL_CATALOG.map(model => [model.modelId, model.speed || null]),
    )).toEqual({
      'gemini-3.5-flash-lite': 'fast',
      'gemini-3.6-flash': 'medium',
      'gemini-4-hydrogen': 'slow',
      'nvidia/nemotron-3.5-lightning:free': 'fast',
      'nvidia/nemotron-3.5-super-vl:free': 'medium',
      'inclusionai/ling-3.2-flash:free': 'fast',
    })
  })

  it('migrates provider-less legacy selections to Gemini', () => {
    expect(resolveModelSelection(undefined, 'gemini-3.6-flash')).toMatchObject({
      provider: 'gemini',
      modelId: 'gemini-3.6-flash',
    })
    expect(resolveModelSelection(undefined, 'unknown')).toMatchObject({
      provider: 'gemini',
      modelId: DEFAULT_MODEL,
    })
  })

  it('has no localized model labels indirection anymore', () => {
    expect(MODEL_CATALOG.filter(model => model.labelKey)).toEqual([])
  })

  it('declares PDF as Gemini-only and marks text-only models accurately', () => {
    expect(MODEL_CATALOG.filter(model => model.capabilities.supportsImage === false).map(model => model.modelId)).toEqual([
      'nvidia/nemotron-3.5-lightning:free',
    ])
    expect(MODEL_CATALOG.filter(model => model.capabilities.supportsPdf).every(model => model.provider === 'gemini')).toBe(true)
    expect(MODEL_CATALOG.filter(model => model.capabilities.supportsImage && model.provider === 'openrouter').map(model => model.modelId)).toEqual([
      'nvidia/nemotron-3.5-super-vl:free',
      'inclusionai/ling-3.2-flash:free',
    ])
    expect(getProviderForModel('nvidia/nemotron-3.5-lightning:free')).toBe('openrouter')
    expect(getProviderForModel('nvidia/nemotron-3.5-super-vl:free')).toBe('openrouter')
    expect(getProviderForModel('inclusionai/ling-3.2-flash:free')).toBe('openrouter')
  })

  it('keeps the OpenRouter fallback inside the catalog', () => {
    expect(OPENROUTER_MODEL_IDS).toEqual([
      'nvidia/nemotron-3.5-lightning:free',
      'nvidia/nemotron-3.5-super-vl:free',
      'inclusionai/ling-3.2-flash:free',
    ])
    expect(getOpenRouterFallbackModel('nvidia/nemotron-3.5-lightning:free')).toBe('nvidia/nemotron-3.5-super-vl:free')
    expect(getOpenRouterFallbackModel('nvidia/nemotron-3.5-super-vl:free')).toBe('inclusionai/ling-3.2-flash:free')
    expect(getOpenRouterFallbackModel('inclusionai/ling-3.2-flash:free')).toBe('nvidia/nemotron-3.5-lightning:free')
    expect(getOpenRouterFallbackModel('nvidia/nemotron-3.5-super-vl:free', { hasImage: true })).toBe('inclusionai/ling-3.2-flash:free')
    // An id this system does not know (an old session, a hand-edited export)
    // lands on the first catalog model instead of the provider's own router.
    expect(getOpenRouterFallbackModel('meta-llama/legacy-model:free')).toBe('nvidia/nemotron-3.5-lightning:free')
    expect(getOpenRouterFallbackModel('gemini-3.6-flash')).toBe('nvidia/nemotron-3.5-lightning:free')
    expect(MODEL_CATALOG.map(model => model.modelId)).toContain(getOpenRouterFallbackModel('nvidia/nemotron-3.5-super-vl:free'))
  })

  it('migrates retired selections to the Gemini default', () => {
    expect(resolveModelSelection('openrouter', 'google/gemma-4-26b-a4b-it:free')).toMatchObject({
      provider: 'gemini',
      modelId: 'gemini-3.5-flash-lite',
    })
    expect(resolveModelSelection('ollama', 'nemotron-3-super')).toMatchObject({
      provider: 'gemini',
      modelId: 'gemini-3.5-flash-lite',
    })
  })

  it('describes a model fallback with display labels', () => {
    expect(describeModelFallback('gemini-3.8-flash', 'gemini-3.5-flash-lite', {
      'gemini-3.8-flash': 'Gemini 3.8 Flash',
      'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
    })).toEqual({ from: 'Gemini 3.8 Flash', to: 'Gemini 3.5 Flash Lite' })
  })

  it('returns null when no fallback happened', () => {
    expect(describeModelFallback('gemini-3.8-flash', 'gemini-3.8-flash', {})).toBeNull()
    expect(describeModelFallback('gemini-3.8-flash', null, {})).toBeNull()
    expect(describeModelFallback('gemini-3.8-flash', '', {})).toBeNull()
  })

  it('keeps the automatic selector out of the concrete catalog', () => {
    expect(AUTO_MODEL_KEY).toBe('auto')
    expect(MODEL_CATALOG.some(model => model.key === AUTO_MODEL_KEY || model.modelId === AUTO_MODEL_KEY)).toBe(false)
    expect(isAutoModelKey('auto')).toBe(true)
    expect(isAutoModelKey('gemini-3.1-flash-lite')).toBe(false)
    expect(isAutoModelKey(null)).toBe(false)
    expect(isAutoModelKey(undefined)).toBe(false)
  })

  it('lists eligible automatic candidates as catalog keys filtered by capability', () => {
    expect(getAutoCandidateKeys()).toEqual(MODEL_CATALOG.map(model => model.key))
    expect(getAutoCandidateKeys({ mode: 'chat' })).toHaveLength(6)
    expect(getAutoCandidateKeys({ mimeTypes: ['application/pdf'] })).toEqual([
      'gemini:gemini-3.5-flash-lite',
      'gemini:gemini-3.6-flash',
      'gemini:gemini-4-hydrogen',
    ])
    expect(getAutoCandidateKeys({ mimeTypes: ['image/png'] })).toEqual([
      'gemini:gemini-3.5-flash-lite',
      'gemini:gemini-3.6-flash',
      'gemini:gemini-4-hydrogen',
      'openrouter:nvidia/nemotron-3.5-super-vl:free',
      'openrouter:inclusionai/ling-3.2-flash:free',
    ])
    expect(getAutoCandidateKeys({ mode: 'web' })).toEqual([
      'gemini:gemini-3.5-flash-lite',
      'gemini:gemini-3.6-flash',
      'gemini:gemini-4-hydrogen',
    ])
  })
})
