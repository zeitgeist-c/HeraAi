import { describe, expect, it } from 'vitest'

import {
  extractPublicUrls,
  isUrlOnlyText,
  listPublicUrls,
  needsWebSearch,
  normalizePublicUrl,
  removePublicUrlFromText,
} from './urlContext.js'

describe('public URL parsing', () => {
  it('extracts Markdown and plain URLs, normalizes fragments and removes duplicates', () => {
    expect(extractPublicUrls('Read [one](https://example.com/a#part), then https://example.com/a.')).toEqual([
      'https://example.com/a',
    ])
  })

  it.each([
    'http://localhost/page',
    'http://127.0.0.1/page',
    'http://169.254.169.254/latest',
    'https://192.168.1.2/',
    'https://user:pass@example.com/',
    'http://localhost./page',
    'http://[::ffff:127.0.0.1]/page',
    'http://[::ffff:7f00:1]/page',
    'http://[::]/page',
    'http://100.64.0.5/page',
  ])('rejects private or credential-bearing URL %s', url => {
    expect(() => normalizePublicUrl(url)).toThrow(expect.objectContaining({ code: 'url_private' }))
  })

  it('treats a URL-only message as a URL regardless of letter case', () => {
    expect(isUrlOnlyText('HTTPS://Example.com/Article', ['https://example.com/Article'])).toBe(true)
    expect(isUrlOnlyText('bu sayfayi ozetle https://example.com/Article', ['https://example.com/Article'])).toBe(false)
  })

  it('accepts ten public URLs and rejects the eleventh', () => {
    const tenUrls = Array.from({ length: 10 }, (_, index) => `https://example.com/${index}`).join(' ')
    const elevenUrls = `${tenUrls} https://example.com/10`
    expect(extractPublicUrls(tenUrls)).toHaveLength(10)
    expect(() => extractPublicUrls(elevenUrls)).toThrow(expect.objectContaining({ code: 'url_limit_exceeded' }))
  })

  it('lists valid draft URLs without failing on incomplete or private candidates', () => {
    expect(listPublicUrls('https://example.com/a http://localhost/private https://')).toEqual([
      'https://example.com/a',
    ])
  })

  it('removes only the selected plain or Markdown URL token from draft text', () => {
    expect(removePublicUrlFromText(
      'Compare [first](https://example.com/a) with https://example.com/b and keep this text.',
      'https://example.com/a',
    )).toBe('Compare with https://example.com/b and keep this text.')
    expect(removePublicUrlFromText(
      'Compare https://example.com/a with https://example.com/b.',
      'https://example.com/b',
    )).toBe('Compare https://example.com/a with')
  })

  it('recognizes a URL-only request', () => {
    const urls = ['https://example.com/article']
    expect(isUrlOnlyText('https://example.com/article', urls)).toBe(true)
    expect(isUrlOnlyText('Summarize https://example.com/article', urls)).toBe(false)
  })
})

describe('needsWebSearch', () => {
  it.each([
    'Bugün dolar kuru ne kadar?',
    'Yarın hava durumu nasıl?',
    'Güncel altın fiyatı nedir?',
    'Son dakika haberleri neler?',
    'Maçı kim kazandı?',
    'Borsa bugün nasıl kapattı?',
    'Who won the match?',
    'Latest stock price?',
  ])('detects a time-sensitive question: %s', (text) => {
    expect(needsWebSearch(text)).toBe(true)
  })

  it.each([
    'Bana bir masal anlat',
    'Bu cümleyi İngilizceye çevir',
    'Fonksiyon nasıl yazılır?',
    '',
    '   ',
  ])('leaves ordinary chat alone: %s', (text) => {
    expect(needsWebSearch(text)).toBe(false)
  })

  it.each([
    'Bu konuyu internette araştır',
    '2026 hedefleri neler?',
    'Enflasyon ne durumda?',
    'Kripto piyasası nasıl?',
    'Dolar kuru kaç oldu?',
  ])('detects an explicit or current-data request: %s', (text) => {
    expect(needsWebSearch(text)).toBe(true)
  })

  it('leaves a code request alone even when it mentions a current topic', () => {
    expect(needsWebSearch('```js\n// borsa fiyatı hesaplama\nconsole.log(1)\n```')).toBe(false)
  })
})
