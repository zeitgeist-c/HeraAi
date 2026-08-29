import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MODEL,
  MODEL_CATALOG,
  getProviderForModel,
  resolveModelSelection,
} from './models.js'

describe('provider-aware model catalog', () => {
  it('contains four Gemini models plus OpenRouter Free and Ollama MiniMax M3', () => {
    expect(MODEL_CATALOG).toHaveLength(6)
    expect(MODEL_CATALOG.map(model => [model.provider, model.modelId])).toEqual([
      ['gemini', 'gemini-3.1-flash-lite'],
      ['gemini', 'gemini-3.5-flash-lite'],
      ['gemini', 'gemini-3.6-flash'],
      ['gemini', 'gemini-3.7-flash'],
      ['openrouter', 'openrouter/free'],
      ['ollama', 'minimax-m3'],
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

  it('declares PDF as Gemini-only while all catalog entries accept images', () => {
    expect(MODEL_CATALOG.every(model => model.capabilities.supportsImage)).toBe(true)
    expect(MODEL_CATALOG.filter(model => model.capabilities.supportsPdf).every(model => model.provider === 'gemini')).toBe(true)
    expect(getProviderForModel('openrouter/free')).toBe('openrouter')
    expect(getProviderForModel('minimax-m3')).toBe('ollama')
  })
})
