import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MODEL,
  MODEL_CATALOG,
  getProviderForModel,
  resolveModelSelection,
} from './models.js'

describe('provider-aware model catalog', () => {
  it('contains five Gemini models, OpenRouter Free, and two Ollama Cloud models', () => {
    expect(MODEL_CATALOG).toHaveLength(8)
    expect(MODEL_CATALOG.map(model => [model.provider, model.modelId])).toEqual([
      ['gemini', 'gemini-3.1-flash-lite'],
      ['gemini', 'gemini-3.5-flash-lite'],
      ['gemini', 'gemini-3.6-flash'],
      ['gemini', 'gemini-3.7-flash'],
      ['gemini', 'gemini-3.8-flash'],
      ['openrouter', 'openrouter/free'],
      ['ollama', 'gpt-oss:120b'],
      ['ollama', 'nemotron-3-ultra'],
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
      'gpt-oss:120b',
      'nemotron-3-ultra',
    ])
    expect(MODEL_CATALOG.filter(model => model.capabilities.supportsPdf).every(model => model.provider === 'gemini')).toBe(true)
    expect(getProviderForModel('openrouter/free')).toBe('openrouter')
    expect(getProviderForModel('nemotron-3-ultra')).toBe('ollama')
    expect(getProviderForModel('gpt-oss:120b')).toBe('ollama')
  })

  it('migrates the retired MiniMax selection to Nemotron', () => {
    expect(resolveModelSelection('ollama', 'minimax-m3')).toMatchObject({
      provider: 'ollama',
      modelId: 'nemotron-3-ultra',
    })
  })
})
