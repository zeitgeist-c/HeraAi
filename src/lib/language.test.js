import { describe, expect, it } from 'vitest'

import { baseLanguage, currentLanguage } from './language'

describe('dil kodu normalizasyonu', () => {
  it('bolge ekini kirpar', () => {
    expect(baseLanguage('tr')).toBe('tr')
    expect(baseLanguage('tr-TR')).toBe('tr')
    expect(baseLanguage('TR-tr')).toBe('tr')
    expect(baseLanguage('tr_TR')).toBe('tr')
  })

  it('turkce olmayan ve bos degerleri ingilizceye dusurur', () => {
    expect(baseLanguage('en-US')).toBe('en')
    expect(baseLanguage('')).toBe('en')
    expect(baseLanguage(undefined)).toBe('en')
    expect(baseLanguage(null)).toBe('en')
    expect(baseLanguage('xx')).toBe('en')
  })

  it('13 dili kimligiyle korur', () => {
    for (const code of ['en', 'tr', 'de', 'es', 'fr', 'it', 'pt-BR', 'ru', 'pl', 'nl', 'zh-CN', 'ja', 'ko']) {
      expect(baseLanguage(code)).toBe(code)
    }
    expect(baseLanguage('de-DE')).toBe('de')
    expect(baseLanguage('pt_BR')).toBe('pt-BR')
    expect(baseLanguage('zh-CN')).toBe('zh-CN')
  })

  it('i18next nesnesinden yuklenen dili okur', () => {
    expect(currentLanguage({ language: 'tr-TR', resolvedLanguage: 'tr' })).toBe('tr')
    expect(currentLanguage({ language: 'tr-TR' })).toBe('tr')
    expect(currentLanguage({ language: 'en-GB' })).toBe('en')
    expect(currentLanguage(undefined)).toBe('en')
  })
})
