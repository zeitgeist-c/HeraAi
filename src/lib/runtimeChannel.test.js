import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SYNC_CHANNEL_LOST,
  describeRuntimeError,
  isChannelLossMessage,
  pollForResult,
  sendRuntimeMessage,
} from './runtimeChannel'

const originalChrome = globalThis.chrome

afterEach(() => {
  globalThis.chrome = originalChrome
})

describe('runtimeChannel hata indirgeme', () => {
  it('kanal kopması metinlerini sync_channel_lost koduna çevirir', () => {
    expect(describeRuntimeError(new Error('The message port closed before a response was received.')))
      .toBe(SYNC_CHANNEL_LOST)
    expect(describeRuntimeError(new Error('Could not establish connection. Receiving end does not exist.')))
      .toBe(SYNC_CHANNEL_LOST)
    expect(describeRuntimeError(new Error('Extension context invalidated.')))
      .toBe(SYNC_CHANNEL_LOST)
  })

  it('arayüzde metni olan kodu korur', () => {
    expect(describeRuntimeError(new Error('quota_exceeded'))).toBe('quota_exceeded')
    expect(describeRuntimeError(Object.assign(new Error('auth failed'), { code: 'auth_cancelled' })))
      .toBe('auth_cancelled')
  })

  it('tanınmayan ham metni sync_failed’a indirger', () => {
    expect(describeRuntimeError(new Error('Something internal went wrong'))).toBe('sync_failed')
    expect(describeRuntimeError(undefined)).toBe('sync_failed')
    expect(describeRuntimeError('')).toBe('sync_failed')
  })

  it('kanal kopması desenini yalnızca o metinlerde görür', () => {
    expect(isChannelLossMessage('The message port closed before a response was received.')).toBe(true)
    expect(isChannelLossMessage('quota_exceeded')).toBe(false)
    expect(isChannelLossMessage(undefined)).toBe(false)
  })
})

describe('sendRuntimeMessage', () => {
  it('yanıtı çözer', async () => {
    globalThis.chrome = {
      runtime: {
        lastError: null,
        sendMessage: (message, callback) => { callback({ ok: true, echo: message.type }) },
      },
    }

    await expect(sendRuntimeMessage({ type: 'SYNC_GET_STATUS' }))
      .resolves.toEqual({ ok: true, echo: 'SYNC_GET_STATUS' })
  })

  it('lastError doluysa reddeder', async () => {
    globalThis.chrome = {
      runtime: {
        lastError: { message: 'The message port closed before a response was received.' },
        sendMessage: (_message, callback) => { callback(undefined) },
      },
    }

    await expect(sendRuntimeMessage({ type: 'SYNC_GET_STATUS' }))
      .rejects.toThrow(/message port closed/i)
  })

  it('senkron fırlatmayı redde çevirir', async () => {
    globalThis.chrome = {
      runtime: {
        lastError: null,
        sendMessage: () => { throw new Error('Extension context invalidated.') },
      },
    }

    await expect(sendRuntimeMessage({ type: 'AUTH_GET_STATE' })).rejects.toThrow(/invalidated/i)
  })
})

describe('pollForResult', () => {
  it('sonucu bulunca döner ve fazladan beklemez', async () => {
    const check = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ user: { uid: 'uid-1' } })
    const waitFn = vi.fn().mockResolvedValue(undefined)

    const result = await pollForResult({ check, attempts: 4, delayMs: 1500, waitFn })

    expect(result).toEqual({ user: { uid: 'uid-1' } })
    expect(check).toHaveBeenCalledTimes(2)
    expect(waitFn).toHaveBeenCalledTimes(1)
    expect(waitFn).toHaveBeenCalledWith(1500)
  })

  it('sorgu hata verse de devam eder, sonuç yoksa null döner', async () => {
    const check = vi.fn().mockRejectedValue(new Error('The message port closed before a response was received.'))

    const result = await pollForResult({ check, attempts: 3, delayMs: 1, waitFn: async () => {} })

    expect(result).toBeNull()
    expect(check).toHaveBeenCalledTimes(3)
  })
})
