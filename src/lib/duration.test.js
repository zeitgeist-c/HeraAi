import { describe, expect, it } from 'vitest'

import {
  formatDurationMs,
  getMessageDurationMs,
  isLiveDurationMessage,
} from './duration.js'

describe('response duration', () => {
  it('formats short durations with tenth-second precision', () => {
    expect(formatDurationMs(0)).toBe('0.0 s')
    expect(formatDurationMs(4300)).toBe('4.3 s')
    expect(formatDurationMs(59999)).toBe('60.0 s')
  })

  it('switches long durations to minute:second format', () => {
    expect(formatDurationMs(61_000)).toBe('1:01')
    expect(formatDurationMs(125_000)).toBe('2:05')
    expect(formatDurationMs(125_000, { live: true })).toBe('2:05.0')
    expect(formatDurationMs(-5)).toBe('')
    expect(formatDurationMs(Number.NaN)).toBe('')
  })

  it('freezes completed responses at their stored end time', () => {
    const message = { role: 'model', status: 'done', startedAt: 1000, completedAt: 6400 }
    expect(getMessageDurationMs(message)).toBe(5400)
    expect(isLiveDurationMessage(message)).toBe(false)
  })

  it('measures live responses against the current time', () => {
    const message = { role: 'model', status: 'streaming', startedAt: 1000 }
    expect(getMessageDurationMs(message, 2600)).toBe(1600)
    expect(isLiveDurationMessage(message)).toBe(true)
    expect(isLiveDurationMessage({ ...message, status: 'thinking' })).toBe(true)
  })

  it('hides misleading durations for errors and cancellations', () => {
    const base = { role: 'model', startedAt: 1000, completedAt: 9000 }
    for (const status of ['error', 'cancelled', 'cancelled_empty', 'interrupted']) {
      expect(getMessageDurationMs({ ...base, status })).toBeNull()
      expect(isLiveDurationMessage({ ...base, status })).toBe(false)
    }
  })

  it('never estimates durations for legacy messages without timing data', () => {
    expect(getMessageDurationMs({ role: 'model', status: 'done', content: 'Old' })).toBeNull()
    expect(getMessageDurationMs({ role: 'model', status: 'done', startedAt: 1000 })).toBeNull()
    expect(getMessageDurationMs({ role: 'model', status: 'streaming' })).toBeNull()
    expect(getMessageDurationMs({ role: 'user', status: 'done', startedAt: 1, completedAt: 2 })).toBeNull()
    expect(isLiveDurationMessage({ role: 'model', status: 'streaming' })).toBe(false)
  })
})
