import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MODEL,
  MODEL_CATALOG,
  getProviderForModel,
  resolveModelSelection,
} from './models.js'

describe('provider-aware model catalog', () => {
  it('contains four Gemini models, OpenRouter Free, and three Ollama Cloud models', () => {
    expect(MODEL_CATALOG).toHaveLength(8)
    expect(MODEL_CATALOG.map(model => [model.provider, model.modelId])).toEqual([
      ['gemini', 'gemini-3.1-flash-lite'],
      ['gemini', 'gemini-3.5-flash-lite'],
      ['gemini', 'gemini-3.6-flash'],
      ['gemini', 'gemini-3.7-flash'],
      ['openrouter', 'openrouter/free'],
      ['ollama', 'minimax-m3'],
      ['ollama', 'nemotron-3-ultra'],
      ['ollama', 'gpt-oss:120b'],
    ])
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

  it('declares PDF as Gemini-only and marks the text-only Ollama models accurately', () => {
    expect(MODEL_CATALOG.filter(model => model.capabilities.supportsImage === false).map(model => model.modelId)).toEqual([
      'nemotron-3-ultra',
      'gpt-oss:120b',
    ])
    expect(MODEL_CATALOG.filter(model => model.capabilities.supportsPdf).every(model => model.provider === 'gemini')).toBe(true)
    expect(getProviderForModel('openrouter/free')).toBe('openrouter')
    expect(getProviderForModel('minimax-m3')).toBe('ollama')
    expect(getProviderForModel('nemotron-3-ultra')).toBe('ollama')
    expect(getProviderForModel('gpt-oss:120b')).toBe('ollama')
  })
})
