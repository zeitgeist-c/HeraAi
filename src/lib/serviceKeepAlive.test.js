import { afterEach, describe, expect, it, vi } from 'vitest'

import { KEEP_ALIVE_INTERVAL_MS, pingExtensionRuntime, startServiceKeepAlive } from './serviceKeepAlive'

const originalChrome = globalThis.chrome

afterEach(() => {
  globalThis.chrome = originalChrome
  vi.useRealTimers()
})

describe('startServiceKeepAlive', () => {
  it('aralık boyunca ping atar, durdurunca keser', () => {
    vi.useFakeTimers()
    const ping = vi.fn()

    const stop = startServiceKeepAlive({ ping })
    expect(ping).not.toHaveBeenCalled()

    vi.advanceTimersByTime(KEEP_ALIVE_INTERVAL_MS * 2)
    expect(ping).toHaveBeenCalledTimes(2)

    stop()
    vi.advanceTimersByTime(KEEP_ALIVE_INTERVAL_MS * 3)
    expect(ping).toHaveBeenCalledTimes(2)
  })

  it('ping sırasında oluşan hatayı işleme yaymaz', () => {
    vi.useFakeTimers()
    const stop = startServiceKeepAlive({ ping: () => { throw new Error('boom') } })

    expect(() => vi.advanceTimersByTime(KEEP_ALIVE_INTERVAL_MS)).not.toThrow()
    stop()
  })
})

describe('pingExtensionRuntime', () => {
  it('platform bilgisi çağrısıyla zamanlayıcıyı sıfırlar ve lastError’ı tüketir', () => {
    const getPlatformInfo = vi.fn(callback => callback({ os: 'win' }))
    globalThis.chrome = { runtime: { getPlatformInfo, lastError: { message: 'ignored' } } }

    pingExtensionRuntime()

    expect(getPlatformInfo).toHaveBeenCalledTimes(1)
  })

  it('platform bilgisi yoksa sessizce çıkar', () => {
    globalThis.chrome = { runtime: {} }

    expect(() => pingExtensionRuntime()).not.toThrow()
  })
})
