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
    expect(baseLanguage('de')).toBe('en')
    expect(baseLanguage('')).toBe('en')
    expect(baseLanguage(undefined)).toBe('en')
    expect(baseLanguage(null)).toBe('en')
  })

  it('i18next nesnesinden yuklenen dili okur', () => {
    expect(currentLanguage({ language: 'tr-TR', resolvedLanguage: 'tr' })).toBe('tr')
    expect(currentLanguage({ language: 'tr-TR' })).toBe('tr')
    expect(currentLanguage({ language: 'en-GB' })).toBe('en')
    expect(currentLanguage(undefined)).toBe('en')
  })
})
