import { beforeEach, describe, expect, it } from 'vitest'

import { DB_NAMES, VAULT_STORES, idbGetAll } from './idb'
import {
  addKey,
  getKeys,
  resolveKeysForRequest,
  setPrimary,
  updateKeyMetadata,
} from './keyManager'
import { openVaultDatabase, resetDefaultVault } from './keyVault'

async function veritabaniSil() {
  await new Promise((resolve) => {
    const istek = globalThis.indexedDB.deleteDatabase(DB_NAMES.vault)
    istek.onsuccess = () => resolve()
    istek.onerror = () => resolve()
    istek.onblocked = () => resolve()
  })
}

/** Aşama 6 sonrası tek kaynak şifreli kasadır; her test temiz kasayla başlar. */
beforeEach(async () => {
  resetDefaultVault()
  await veritabaniSil()
})

describe('keyManager (sifreli kasa uzerinden)', () => {
  describe('resolveKeysForRequest', () => {
    it('returns an empty pool with no cooldown when the vault has no keys', async () => {
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
      await addKey('gemini', 'AIza-aaaaaaaaaaaaaaaaaa-A', { createdAt: 1000 })
      await addKey('gemini', 'AIza-bbbbbbbbbbbbbbbbbb-B', { createdAt: 2000 })
      const entries = await getKeys('gemini')
      const keyBId = entries.find((e) => e.masked.endsWith('-B')).id
      await setPrimary('gemini', keyBId)

      const result = await resolveKeysForRequest('gemini')

      expect(result.keys.map((k) => k.key)).toEqual([
        'AIza-bbbbbbbbbbbbbbbbbb-B',
        'AIza-aaaaaaaaaaaaaaaaaa-A',
      ])
    })

    it('skips keys that are still in cooldown and keeps the rest available', async () => {
      await addKey('gemini', 'AIza-aaaaaaaaaaaaaaaaaa-A', { createdAt: 1000 })
      await addKey('gemini', 'AIza-bbbbbbbbbbbbbbbbbb-B', { createdAt: 2000 })
      const entries = await getKeys('gemini')
      const keyAId = entries.find((e) => e.masked.endsWith('-A')).id
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
      await addKey('gemini', 'AIza-aaaaaaaaaaaaaaaaaa-A', { createdAt: 1000 })
      await addKey('gemini', 'AIza-bbbbbbbbbbbbbbbbbb-B', { createdAt: 2000 })
      const entries = await getKeys('gemini')
      const keyAId = entries.find((e) => e.masked.endsWith('-A')).id
      const keyBId = entries.find((e) => e.masked.endsWith('-B')).id
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
      const [entry] = await getKeys('gemini')
      expect(entry.masked).toBe('AIza...xyz9')
    })

    it('masks tavily keys with the same first 4 / last 4 rule', async () => {
      await addKey('tavily', 'tvly-abcdefghij-AbC3')
      const [entry] = await getKeys('tavily')
      expect(entry.masked).toBe('tvly...AbC3')
    })

    it('keeps OpenRouter and Ollama keys in separate provider pools', async () => {
      await addKey('openrouter', '«redacted:sk-…»')
      await addKey('ollama', 'ollama-abcdefghijklm5678')

      expect(await getKeys('openrouter')).toHaveLength(1)
      expect(await getKeys('ollama')).toHaveLength(1)
      expect((await resolveKeysForRequest('openrouter')).keys[0].key).toBe('«redacted:sk-…»')
      expect((await resolveKeysForRequest('ollama')).keys[0].key).toBe('ollama-abcdefghijklm5678')
      expect(await getKeys('openrouter')).toEqual([
        expect.not.objectContaining({ key: expect.anything() }),
      ])
    })
  })

  describe('getKeys ordering', () => {
    it('returns metadata with primary first then createdAt ascending', async () => {
      await addKey('gemini', 'AIza-aaaaaaaaaaaaaaaaaa-A', { createdAt: 1000 })
      await addKey('gemini', 'AIza-bbbbbbbbbbbbbbbbbb-B', { createdAt: 2000 })
      await addKey('gemini', 'AIza-cccccccccccccccccc-C', { createdAt: 3000 })
      const entries = await getKeys('gemini')
      const keyAId = entries.find((e) => e.masked.endsWith('-A')).id
      const keyBId = entries.find((e) => e.masked.endsWith('-B')).id
      const keyCId = entries.find((e) => e.masked.endsWith('-C')).id
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

  describe('Asama 6 — acik metin kalmadi', () => {
    it('hicbir kayit diskte ham anahtar tasimaz', async () => {
      await addKey('gemini', 'AIzaSySECRET-do-not-leak-12345')
      await addKey('tavily', 'tvly-SECRET-tavily-1234567890')

      const db = await openVaultDatabase()
      const kayitlar = await idbGetAll(db, VAULT_STORES.keys)
      db.close()
      const disaVuran = JSON.stringify(kayitlar)

      expect(kayitlar).toHaveLength(2)
      expect(disaVuran).not.toContain('AIzaSySECRET')
      expect(disaVuran).not.toContain('tvly-SECRET')
      expect(kayitlar.every((k) => k.ciphertext?.ciphertext)).toBe(true)
    })
  })
})
