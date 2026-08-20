import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SYSTEM_INSTRUCTION,
  SYSTEM_INSTRUCTION_DEFAULT_VERSION,
  resolveSystemInstructionConfig,
} from './systemInstruction'

describe('resolveSystemInstructionConfig', () => {
  it.each([
    ['missing', {}],
    ['legacy empty', { systemInstruction: '' }],
    ['legacy whitespace', { systemInstruction: '   ' }],
  ])('seeds the requested default for %s storage', (_label, storage) => {
    expect(resolveSystemInstructionConfig(storage)).toEqual({
      systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
      systemInstructionDefaultVersion: SYSTEM_INSTRUCTION_DEFAULT_VERSION,
      shouldPersist: true,
    })
  })

  it('preserves a legacy custom instruction while recording the migration', () => {
    expect(resolveSystemInstructionConfig({ systemInstruction: 'Özel komut' })).toEqual({
      systemInstruction: 'Özel komut',
      systemInstructionDefaultVersion: SYSTEM_INSTRUCTION_DEFAULT_VERSION,
      shouldPersist: true,
    })
  })

  it.each([
    ['custom', 'Değiştirilmiş komut'],
    ['explicitly empty', ''],
  ])('preserves a migrated %s instruction', (_label, systemInstruction) => {
    expect(resolveSystemInstructionConfig({
      systemInstruction,
      systemInstructionDefaultVersion: SYSTEM_INSTRUCTION_DEFAULT_VERSION,
    })).toEqual({
      systemInstruction,
      systemInstructionDefaultVersion: SYSTEM_INSTRUCTION_DEFAULT_VERSION,
      shouldPersist: false,
    })
  })
})
