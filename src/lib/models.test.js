import { describe, expect, it } from 'vitest'

import tr from '../locales/tr.json'
import en from '../locales/en.json'

import {
  AUTO_MODEL_KEY,
  DEFAULT_MODEL,
  MODEL_CATALOG,
  describeModelFallback,
  getAutoCandidateKeys,
  getProviderForModel,
  isAutoModelKey,
  resolveModelSelection,
} from './models.js'

describe('provider-aware model catalog', () => {
  it('contains five Gemini models, three OpenRouter models, and three Ollama Cloud models', () => {
    expect(MODEL_CATALOG).toHaveLength(11)
    expect(MODEL_CATALOG.map(model => [model.provider, model.modelId])).toEqual([
      ['gemini', 'gemini-3.1-flash-lite'],
      ['gemini', 'gemini-3.5-flash-lite'],
      ['gemini', 'gemini-3.6-flash'],
      ['gemini', 'gemini-3.7-flash'],
      ['gemini', 'gemini-3.8-flash'],
      ['openrouter', 'google/gemma-4-26b-a4b-it:free'],
      ['openrouter', 'qwen/qwen3.8-27b:free'],
      ['openrouter', 'nex-agi/nex-n2.5-pro:free'],
      ['ollama', 'gpt-oss:120b'],
      ['ollama', 'nemotron-3-super'],
      ['ollama', 'gemma4:31b'],
    ])
  })

  it('marks model speeds for the selector icons', () => {
    expect(Object.fromEntries(
      MODEL_CATALOG.map(model => [model.modelId, model.speed || null]),
    )).toEqual({
      'gemini-3.1-flash-lite': 'fast',
      'gemini-3.5-flash-lite': 'fast',
      'gemini-3.6-flash': 'medium',
      'gemini-3.7-flash': 'slow',
      'gemini-3.8-flash': 'slow',
      'nex-agi/nex-n2.5-pro:free': 'slow',
      'qwen/qwen3.8-27b:free': 'medium',
      'google/gemma-4-26b-a4b-it:free': 'fast',
      'gpt-oss:120b': 'fast',
      'nemotron-3-super': 'medium',
      'gemma4:31b': 'slow',
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

  it('gives every model a purpose label that exists in both locales', () => {
    expect(MODEL_CATALOG.every(model => typeof model.purposeKey === 'string' && model.purposeKey.length > 0)).toBe(true)
    const read = (source, path) => path.split('.').reduce((acc, part) => acc?.[part], source)
    MODEL_CATALOG.forEach(model => {
      expect(read(tr, model.purposeKey), `tr: ${model.purposeKey}`).toBeTruthy()
      expect(read(en, model.purposeKey), `en: ${model.purposeKey}`).toBeTruthy()
    })
  })

  it('declares PDF as Gemini-only and marks text-only models accurately', () => {
    expect(MODEL_CATALOG.filter(model => model.capabilities.supportsImage === false).map(model => model.modelId)).toEqual([
      'gpt-oss:120b',
      'nemotron-3-super',
    ])
    expect(MODEL_CATALOG.filter(model => model.capabilities.supportsPdf).every(model => model.provider === 'gemini')).toBe(true)
    expect(MODEL_CATALOG.filter(model => model.capabilities.supportsImage && model.provider === 'openrouter').map(model => model.modelId)).toEqual([
      'google/gemma-4-26b-a4b-it:free',
      'qwen/qwen3.8-27b:free',
      'nex-agi/nex-n2.5-pro:free',
    ])
    expect(getProviderForModel('nex-agi/nex-n2.5-pro:free')).toBe('openrouter')
    expect(getProviderForModel('qwen/qwen3.8-27b:free')).toBe('openrouter')
    expect(getProviderForModel('google/gemma-4-26b-a4b-it:free')).toBe('openrouter')
    expect(getProviderForModel('nemotron-3-super')).toBe('ollama')
    expect(getProviderForModel('gemma4:31b')).toBe('ollama')
    expect(getProviderForModel('gpt-oss:120b')).toBe('ollama')
  })

  it('migrates the retired MiniMax and Nemotron 3 Ultra selections to the Ollama default', () => {
    expect(resolveModelSelection('ollama', 'minimax-m3')).toMatchObject({
      provider: 'ollama',
      modelId: 'gemma4:31b',
    })
    expect(resolveModelSelection('ollama', 'nemotron-3-ultra')).toMatchObject({
      provider: 'ollama',
      modelId: 'gemma4:31b',
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
    expect(getAutoCandidateKeys({ mode: 'chat' })).toHaveLength(11)
    expect(getAutoCandidateKeys({ mimeTypes: ['application/pdf'] })).toEqual([
      'gemini:gemini-3.1-flash-lite',
      'gemini:gemini-3.5-flash-lite',
      'gemini:gemini-3.6-flash',
      'gemini:gemini-3.7-flash',
      'gemini:gemini-3.8-flash',
    ])
    expect(getAutoCandidateKeys({ mimeTypes: ['image/png'] })).toEqual([
      'gemini:gemini-3.1-flash-lite',
      'gemini:gemini-3.5-flash-lite',
      'gemini:gemini-3.6-flash',
      'gemini:gemini-3.7-flash',
      'gemini:gemini-3.8-flash',
      'openrouter:google/gemma-4-26b-a4b-it:free',
      'openrouter:qwen/qwen3.8-27b:free',
      'openrouter:nex-agi/nex-n2.5-pro:free',
      'ollama:gemma4:31b',
    ])
    expect(getAutoCandidateKeys({ mode: 'web' })).toEqual([
      'gemini:gemini-3.1-flash-lite',
      'gemini:gemini-3.5-flash-lite',
      'gemini:gemini-3.6-flash',
      'gemini:gemini-3.7-flash',
      'gemini:gemini-3.8-flash',
    ])
  })
})
