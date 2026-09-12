import { describe, expect, it } from 'vitest'

import { durationForMessage } from './notify.js'

describe('notification duration', () => {
  it('shows short messages briefly and long messages longer', () => {
    const short = durationForMessage('Kopyalandı!')
    const long = durationForMessage('Bu dosya türü desteklenmiyor. PNG, JPEG, WebP, PDF kullanın.')
    expect(short).toBeGreaterThanOrEqual(2500)
    expect(long).toBeGreaterThan(short)
  })

  it('caps the duration and handles empty input', () => {
    expect(durationForMessage('x'.repeat(10000))).toBe(9000)
    expect(durationForMessage('')).toBe(2500)
    expect(durationForMessage(null)).toBe(2500)
  })
})
