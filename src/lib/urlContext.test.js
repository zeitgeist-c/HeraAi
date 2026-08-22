import { describe, expect, it } from 'vitest'

import {
  extractPublicUrls,
  isUrlOnlyText,
  listPublicUrls,
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
  ])('rejects private or credential-bearing URL %s', url => {
    expect(() => normalizePublicUrl(url)).toThrow(expect.objectContaining({ code: 'url_private' }))
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
