import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { ENTITY_TYPES } from './syncModel'

const KOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const kurallar = readFileSync(path.join(KOK, 'firestore.rules'), 'utf8')

function satirlar(kaynak) {
  return kaynak
    .split('\n')
    .map(satir => satir.trim())
    .filter(satir => satir && !satir.startsWith('//'))
}

describe('firestore.rules guvenlik sozlesmesi', () => {
  it('varsayilan tum yollar kapalidir', () => {
    const govde = satirlar(kurallar)
    expect(govde).toContain("match /{document=**} {")
    expect(kurallar).toContain('allow read, write: if false;')
    // Varsayilan kapanis kullanici dalindan once gelmelidir.
    expect(kurallar.indexOf('match /{document=**}'))
      .toBeLessThan(kurallar.indexOf('match /users/{userId}'))
  })

  it('yalnizca kendi dizinine erisim verir', () => {
    expect(kurallar).toContain('function isOwner()')
    expect(kurallar).toContain('request.auth != null && request.auth.uid == userId')
    const izinSayisi = (kurallar.match(/if isOwner\(\)/g) || []).length
    expect(izinSayisi).toBeGreaterThanOrEqual(10)
  })

  it('plan koleksiyonlarinin tamami tanimlidir', () => {
    for (const yol of [
      'match /account/root',
      'match /devices/{deviceId}',
      'match /entities/{entityId}',
      'match /revisions/{revisionId}',
      'match /blobs/{blobId}',
      'match /chunks/{chunkIndex}',
      'match /backups/{backupId}',
    ]) {
      expect(kurallar).toContain(yol)
    }
  })

  it('entity turleri bulut modeliyle birebir aynidir', () => {
    const eslesme = kurallar.match(/entityType in \[([^\]]+)\]/)
    expect(eslesme).toBeTruthy()
    const kuralTurleri = eslesme[1]
      .split(',')
      .map(parca => parca.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
    expect(kuralTurleri.sort()).toEqual([...ENTITY_TYPES].sort())
  })

  it('belge boyut sinirlari 1 MiB limitinin altindadir', () => {
    expect(kurallar).toContain('ciphertextSize <= 800000')
    expect(kurallar).toContain('chunkSize <= 750000')
  })

  it('varlik sahipligi ve sema alanlari dogrulanir', () => {
    expect(kurallar).toContain('request.resource.data.ownerUid == userId')
    expect(kurallar).toContain('request.resource.data.schemaVersion is int')
    expect(kurallar).toContain('request.resource.data.recoveryEnvelope is map')
    expect(kurallar).toContain('request.resource.data.deviceId == deviceId')
  })

  it('account/root silinemez ve rules_version 2 kullanilir', () => {
    expect(kurallar).toContain("rules_version = '2';")
    const hesapBlogu = kurallar.slice(
      kurallar.indexOf('match /account/root'),
      kurallar.indexOf('match /devices/{deviceId}'),
    )
    expect(hesapBlogu).toContain('allow delete: if false;')
  })
})
