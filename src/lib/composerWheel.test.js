import { describe, expect, it } from 'vitest'

import { WHEEL_TARGET_CHAT, WHEEL_TARGET_INNER, resolveWheelTarget } from './composerWheel'

const scroller = ({ scrollHeight = 400, clientHeight = 120, scrollTop = 0 } = {}) => ({
  scrollHeight,
  clientHeight,
  scrollTop,
})

describe('resolveWheelTarget', () => {
  it('sohbete gider: iç kaydırıcı yoksa', () => {
    expect(resolveWheelTarget(120, null)).toBe(WHEEL_TARGET_CHAT)
    expect(resolveWheelTarget(120, undefined)).toBe(WHEEL_TARGET_CHAT)
  })

  it('sohbete gider: iç kaydırıcı kayamıyorsa', () => {
    expect(resolveWheelTarget(120, scroller({ scrollHeight: 120, clientHeight: 120 }))).toBe(WHEEL_TARGET_CHAT)
  })

  it('yazı alanında kalır: ortada, aşağı doğru', () => {
    expect(resolveWheelTarget(120, scroller({ scrollTop: 100 }))).toBe(WHEEL_TARGET_INNER)
  })

  it('yazı alanında kalır: ortada, yukarı doğru', () => {
    expect(resolveWheelTarget(-120, scroller({ scrollTop: 100 }))).toBe(WHEEL_TARGET_INNER)
  })

  it('sohbete zincirlenir: en üstte yukarı doğru', () => {
    expect(resolveWheelTarget(-120, scroller({ scrollTop: 0 }))).toBe(WHEEL_TARGET_CHAT)
  })

  it('sohbete zincirlenir: en altta aşağı doğru', () => {
    expect(resolveWheelTarget(120, scroller({ scrollTop: 280 }))).toBe(WHEEL_TARGET_CHAT)
  })

  it('yazı alanında kalır: en üstte aşağı doğru', () => {
    expect(resolveWheelTarget(120, scroller({ scrollTop: 0 }))).toBe(WHEEL_TARGET_INNER)
  })

  it('yazı alanında kalır: en altta yukarı doğru', () => {
    expect(resolveWheelTarget(-120, scroller({ scrollTop: 280 }))).toBe(WHEEL_TARGET_INNER)
  })

  it('bozuk ölçülerde çökmez, sohbete düşer', () => {
    expect(resolveWheelTarget(120, { scrollHeight: undefined, clientHeight: null, scrollTop: 'x' })).toBe(WHEEL_TARGET_CHAT)
  })
})
