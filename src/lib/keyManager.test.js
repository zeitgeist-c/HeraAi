import { describe, it, expect, beforeEach } from 'vitest'

import {
  resolveKeysForRequest,
  getKeys,
  addKey,
  setPrimary,
  updateKeyMetadata,
} from './keyManager'

describe('keyManager', () => {
  let currentStorage = {}

  beforeEach(() => {
    currentStorage = {}

    global.chrome.storage.local.get.mockImplementation((keys, callback) => {
      const result = {}
      for (const key of keys) {
        if (currentStorage[key] !== undefined) result[key] = currentStorage[key]
      }
      if (typeof callback === 'function') callback(result)
      return Promise.resolve(result)
    })

    global.chrome.storage.local.set.mockImplementation((data, callback) => {
      Object.assign(currentStorage, data)
      if (typeof callback === 'function') callback()
      return Promise.resolve(data)
    })
  })

  describe('resolveKeysForRequest', () => {
    it('returns an empty pool with no cooldown when the store has no keys', async () => {
      const result = await resolveKeysForRequest('gemini')

      expect(result).toEqual({
        keys: [],
        allInCooldown: false,
        earliestCooldownEnd: null,
      })
    })

    it('returns the single key ordered first with primary flag preserved', async () => {
      await addKey('gemini', 'AIzaSyABCDEF1234567890xyz9')

      const result = await resolveKeysForRequest('gemini')

      expect(result.allInCooldown).toBe(false)
      expect(result.earliestCooldownEnd).toBeNull()
      expect(result.keys).toHaveLength(1)
      expect(result.keys[0].isPrimary).toBe(true)
      expect(result.keys[0].key).toBe('AIzaSyABCDEF1234567890xyz9')
    })

    it('orders the primary key first then the other keys by createdAt', async () => {
      await addKey('gemini', 'AIza-aaaaaaaaaaaaaaaaaa-A')
      await addKey('gemini', 'AIza-bbbbbbbbbbbbbbbbbb-B')
      const entries = currentStorage.geminiApiKeys
      const keyBId = entries.find((e) => e.key.endsWith('-B')).id
      await setPrimary('gemini', keyBId)

      const result = await resolveKeysForRequest('gemini')

      expect(result.keys.map((k) => k.key)).toEqual([
        'AIza-bbbbbbbbbbbbbbbbbb-B',
        'AIza-aaaaaaaaaaaaaaaaaa-A',
      ])
    })

    it('skips keys that are still in cooldown and keeps the rest available', async () => {
      await addKey('gemini', 'AIza-aaaaaaaaaaaaaaaaaa-A')
      await addKey('gemini', 'AIza-bbbbbbbbbbbbbbbbbb-B')
      const entries = currentStorage.geminiApiKeys
      const keyAId = entries.find((e) => e.key.endsWith('-A')).id
      await updateKeyMetadata('gemini', keyAId, {
        cooldownUntil: Date.now() + 60000,
        lastErrorAt: Date.now(),
        lastErrorType: 'rate_limited',
      })

      const result = await resolveKeysForRequest('gemini')

      expect(result.allInCooldown).toBe(false)
      expect(result.keys.map((k) => k.key)).toEqual(['AIza-bbbbbbbbbbbbbbbbbb-B'])
    })

    it('returns allInCooldown=true with the earliest cooldown end when every key is in cooldown', async () => {
      await addKey('gemini', 'AIza-aaaaaaaaaaaaaaaaaa-A')
      await addKey('gemini', 'AIza-bbbbbbbbbbbbbbbbbb-B')
      const entries = currentStorage.geminiApiKeys
      const keyAId = entries.find((e) => e.key.endsWith('-A')).id
      const keyBId = entries.find((e) => e.key.endsWith('-B')).id
      const earliest = Date.now() + 30000
      const later = Date.now() + 120000
      await updateKeyMetadata('gemini', keyAId, { cooldownUntil: later })
      await updateKeyMetadata('gemini', keyBId, { cooldownUntil: earliest })

      const result = await resolveKeysForRequest('gemini')

      expect(result.keys).toEqual([])
      expect(result.allInCooldown).toBe(true)
      expect(result.earliestCooldownEnd).toBe(earliest)
    })
  })

  describe('maskKey via addKey', () => {
    it('masks the key with the first 4 and last 4 characters only', async () => {
      await addKey('gemini', 'AIzaSyABCDEF1234567890xyz9')
      const [entry] = currentStorage.geminiApiKeys
      expect(entry.masked).toBe('AIza...xyz9')
    })

    it('masks tavily keys with the same first 4 / last 4 rule', async () => {
      await addKey('tavily', 'tvly-abcdefghij-AbC3')
      const [entry] = currentStorage.tavilyApiKeys
      expect(entry.masked).toBe('tvly...AbC3')
    })
  })

  describe('getKeys ordering', () => {
    it('returns metadata with primary first then createdAt ascending', async () => {
      await addKey('gemini', 'AIza-aaaaaaaaaaaaaaaaaa-A')
      await addKey('gemini', 'AIza-bbbbbbbbbbbbbbbbbb-B')
      await addKey('gemini', 'AIza-cccccccccccccccccc-C')
      const entries = currentStorage.geminiApiKeys
      const keyAId = entries.find((e) => e.key.endsWith('-A')).id
      const keyBId = entries.find((e) => e.key.endsWith('-B')).id
      const keyCId = entries.find((e) => e.key.endsWith('-C')).id
      await setPrimary('gemini', keyCId)

      const keys = await getKeys('gemini')

      expect(keys.map((k) => k.id)).toEqual([keyCId, keyAId, keyBId])
      expect(keys[0].isPrimary).toBe(true)
    })

    it('never exposes the raw key value in the returned metadata', async () => {
      await addKey('gemini', 'AIzaSySECRET-do-not-leak-12345')
      const keys = await getKeys('gemini')

      expect(keys[0]).not.toHaveProperty('key')
    })
  })
})
