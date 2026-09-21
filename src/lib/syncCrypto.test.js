import { describe, expect, it } from 'vitest'

import { decryptBytes, decryptJson, encryptBytes, encryptJson } from './syncCrypto'

describe('sync encryption', () => {
  it('round-trips encrypted JSON without exposing plaintext', async () => {
    const source = { secret: 'AIza-private', sessions: [{ id: 'one' }] }
    const encrypted = await encryptJson(source, 'correct horse battery staple')

    expect(new TextDecoder().decode(encrypted)).not.toContain('AIza-private')
    await expect(decryptJson(encrypted, 'correct horse battery staple')).resolves.toEqual(source)
    await expect(decryptJson(encrypted, 'wrong password')).rejects.toThrow('sync_passphrase_invalid')
  })

  it('round-trips binary attachment data', async () => {
    const source = new Uint8Array([0, 1, 2, 127, 255])
    const encrypted = await encryptBytes(source, '12345678')
    await expect(decryptBytes(encrypted, '12345678')).resolves.toEqual(source)
  })
})
