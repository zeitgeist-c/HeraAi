/**
 * HeraAi 1.10.0 — Ek dosyaları eşitleme testleri (Aşama 8).
 *
 * Gerçek Web Crypto kullanılır. Kapsam: boyut sınırları, parçalama ve
 * birleştirme, şifreleme/çözme, parça karıştırma koruması, dosya adı
 * şifreleme, manifest, tembel indirme ve mükerrer ek tespiti.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  ATTACHMENT_AVAILABILITY,
  ATTACHMENT_LIMITS,
  ATTACHMENT_MANIFEST_STATUS,
  ATTACHMENT_SYNC_MODE,
  attachmentAad,
  attachmentAvailabilityFor,
  attachmentPaths,
  buildBlobManifest,
  chunkCount,
  computeSha256,
  decryptAttachmentChunks,
  decryptAttachmentName,
  describeAttachmentSync,
  encryptAttachmentChunks,
  encryptAttachmentName,
  findDuplicateAttachment,
  isManifestReady,
  mergeChunks,
  planAttachmentSync,
  shouldFetchAttachment,
  splitIntoChunks,
} from './attachmentSync'
import { deriveSubkeys, generateMasterSecretBytes, importMasterSecret } from './syncCrypto'
import { deriveOpaqueAttachmentId } from './syncModel'
import { ATTACHMENT_SYNC_POLICY } from './syncContract'

const UID = 'kullanici-1'
const MIB = 1024 * 1024

let blobKey
let hmacKey

/** Deterministik sahte içerik üretir. */
function icerik(boyut) {
  const bayt = new Uint8Array(boyut)
  for (let i = 0; i < boyut; i += 1) bayt[i] = (i * 31 + 7) % 256
  return bayt
}

beforeEach(async () => {
  const master = await importMasterSecret(generateMasterSecretBytes())
  const subkeys = await deriveSubkeys(master)
  blobKey = subkeys.blobEncryptionKey
  hmacKey = subkeys.hmacIdKey
})

describe('boyut sınırları ve kota koruması', () => {
  it('3 MiB altındaki eki parçalı eşitlemeye alır', () => {
    const plan = planAttachmentSync({ size: 1 * MIB })
    expect(plan.mode).toBe(ATTACHMENT_SYNC_MODE.CHUNKED)
    expect(plan.syncBinary).toBe(true)
    expect(plan.availability).toBe(ATTACHMENT_AVAILABILITY.SYNCED)
    expect(plan.chunkCount).toBe(2)
  })

  it('tam 3 MiB sınırında eşitler (sınır dahil)', () => {
    const plan = planAttachmentSync({ size: 3 * MIB })
    expect(plan.mode).toBe(ATTACHMENT_SYNC_MODE.CHUNKED)
    expect(plan.syncBinary).toBe(true)
  })

  it('3 MiB üzerindeki eki yalnız metaveriyle eşitler', () => {
    const plan = planAttachmentSync({ size: 3 * MIB + 1 })
    expect(plan.mode).toBe(ATTACHMENT_SYNC_MODE.METADATA_ONLY)
    expect(plan.reason).toBe('over_cloud_limit')
    expect(plan.availability).toBe(ATTACHMENT_AVAILABILITY.LOCAL_ONLY)
    expect(plan.syncBinary).toBe(false)
    expect(plan.chunkCount).toBe(0)
  })

  it('20 MiB üzerindeki eki yerelde tutar', () => {
    const plan = planAttachmentSync({ size: 25 * MIB })
    expect(plan.mode).toBe(ATTACHMENT_SYNC_MODE.METADATA_ONLY)
    expect(plan.reason).toBe('over_local_limit')
    expect(plan.availability).toBe(ATTACHMENT_AVAILABILITY.LOCAL_ONLY)
  })

  it('sözleşmedeki 3 MiB sınırıyla uyuşur', () => {
    expect(ATTACHMENT_LIMITS.cloudMaxBytes).toBe(ATTACHMENT_SYNC_POLICY.maxSyncBytes)
    expect(ATTACHMENT_LIMITS.cloudMaxBytes).toBe(3 * MIB)
    expect(ATTACHMENT_LIMITS.localMaxBytes).toBe(20 * MIB)
    expect(ATTACHMENT_LIMITS.chunkBytes).toBe(700 * 1024)
  })

  it('bozuk boyut girdisini sıfır sayar', () => {
    expect(planAttachmentSync({ size: 'abc' }).mode).toBe(ATTACHMENT_SYNC_MODE.CHUNKED)
    expect(planAttachmentSync({}).chunkCount).toBe(1)
    expect(attachmentAvailabilityFor({ size: null })).toBe(ATTACHMENT_AVAILABILITY.SYNCED)
  })

  it('katalog bilgisi plan değerleriyle uyuşur', () => {
    const katalog = describeAttachmentSync()
    expect(katalog.store).toBe('heraai-attachments')
    expect(katalog.chunkBytes).toBe(700 * 1024)
    expect(katalog.availability).toContain(ATTACHMENT_AVAILABILITY.LOCAL_ONLY)
  })
})

describe('parçalama', () => {
  it('parça sayısını doğru hesaplar', () => {
    expect(chunkCount(0)).toBe(1)
    expect(chunkCount(1)).toBe(1)
    expect(chunkCount(700 * 1024)).toBe(1)
    expect(chunkCount(700 * 1024 + 1)).toBe(2)
    expect(chunkCount(3 * MIB)).toBe(5)
  })

  it('baytları 700 KiB parçalara böler', () => {
    const veri = icerik(700 * 1024 + 100)
    const parcalar = splitIntoChunks(veri)
    expect(parcalar).toHaveLength(2)
    expect(parcalar[0].length).toBe(700 * 1024)
    expect(parcalar[1].length).toBe(100)
  })

  it('boş içerik için tek boş parça üretir', () => {
    const parcalar = splitIntoChunks(new Uint8Array(0))
    expect(parcalar).toHaveLength(1)
    expect(parcalar[0].length).toBe(0)
  })

  it('parçaları kayıpsız birleştirir', () => {
    const veri = icerik(1500)
    const birlesik = mergeChunks(splitIntoChunks(veri, 400))
    expect(birlesik.length).toBe(veri.length)
    expect([...birlesik]).toEqual([...veri])
  })
})

describe('içerik parmak izi', () => {
  it('aynı içerik için aynı SHA-256 üretir', async () => {
    const a = await computeSha256(icerik(1000))
    const b = await computeSha256(icerik(1000))
    expect(a).toBe(b)
    expect(a).toHaveLength(64)
  })

  it('farklı içerik için farklı özet üretir', async () => {
    const a = await computeSha256(icerik(1000))
    const b = await computeSha256(icerik(1001))
    expect(a).not.toBe(b)
  })
})

describe('şifreleme ve çözme', () => {
  it('parçaları şifreleyip kayıpsız geri çözer', async () => {
    const veri = icerik(700 * 1024 + 555)
    const opaque = await deriveOpaqueAttachmentId(hmacKey, 'ek-1')

    const sifreli = await encryptAttachmentChunks({
      blobKey,
      bytes: veri,
      ownerUid: UID,
      opaqueAttachmentId: opaque,
    })
    expect(sifreli).toHaveLength(2)
    expect(sifreli[0].index).toBe(0)
    expect(sifreli[0].byteLength).toBe(700 * 1024)
    expect(sifreli[1].byteLength).toBe(555)
    // Ham içerik şifreli metinde görünmez.
    expect(sifreli[0].ciphertext.length).toBeGreaterThan(0)

    const cozulen = await decryptAttachmentChunks({
      blobKey,
      chunks: sifreli,
      ownerUid: UID,
      opaqueAttachmentId: opaque,
    })
    expect(cozulen.length).toBe(veri.length)
    expect([...cozulen]).toEqual([...veri])
  })

  it('her parça için benzersiz nonce üretir', async () => {
    const opaque = await deriveOpaqueAttachmentId(hmacKey, 'ek-2')
    const sifreli = await encryptAttachmentChunks({
      blobKey,
      bytes: icerik(100),
      ownerUid: UID,
      opaqueAttachmentId: opaque,
      chunkBytes: 30,
    })
    const noncelar = sifreli.map(parca => parca.nonce)
    expect(new Set(noncelar).size).toBe(noncelar.length)
  })

  it('parça sırası karıştırılırsa geri çözüm yine doğru olur (indeks sıralı)', async () => {
    const veri = icerik(300)
    const opaque = await deriveOpaqueAttachmentId(hmacKey, 'ek-3')
    const sifreli = await encryptAttachmentChunks({
      blobKey,
      bytes: veri,
      ownerUid: UID,
      opaqueAttachmentId: opaque,
      chunkBytes: 100,
    })

    const tersSirali = [...sifreli].reverse()
    const cozulen = await decryptAttachmentChunks({
      blobKey,
      chunks: tersSirali,
      ownerUid: UID,
      opaqueAttachmentId: opaque,
    })
    expect([...cozulen]).toEqual([...veri])
  })

  it('başka bir ekin parçası yerine konursa reddeder', async () => {
    const opaqueA = await deriveOpaqueAttachmentId(hmacKey, 'ek-a')
    const opaqueB = await deriveOpaqueAttachmentId(hmacKey, 'ek-b')
    const a = await encryptAttachmentChunks({
      blobKey,
      bytes: icerik(200),
      ownerUid: UID,
      opaqueAttachmentId: opaqueA,
      chunkBytes: 100,
    })
    const b = await encryptAttachmentChunks({
      blobKey,
      bytes: icerik(200),
      ownerUid: UID,
      opaqueAttachmentId: opaqueB,
      chunkBytes: 100,
    })

    // B'nin ilk parçası A'ya karıştırıldı.
    const karisik = [b[0], a[1]]
    await expect(
      decryptAttachmentChunks({
        blobKey,
        chunks: karisik,
        ownerUid: UID,
        opaqueAttachmentId: opaqueA,
      }),
    ).rejects.toThrow('attachment_chunk_failed')
  })

  it('parça indeksi değiştirilirse reddeder', async () => {
    const opaque = await deriveOpaqueAttachmentId(hmacKey, 'ek-4')
    const sifreli = await encryptAttachmentChunks({
      blobKey,
      bytes: icerik(200),
      ownerUid: UID,
      opaqueAttachmentId: opaque,
      chunkBytes: 100,
    })
    const bozuk = [{ ...sifreli[0], index: 1 }, sifreli[1]]
    await expect(
      decryptAttachmentChunks({
        blobKey,
        chunks: bozuk,
        ownerUid: UID,
        opaqueAttachmentId: opaque,
      }),
    ).rejects.toThrow('attachment_chunk_failed')
  })

  it('anahtar ve kimlik eksikse açık hata verir', async () => {
    await expect(encryptAttachmentChunks({ bytes: icerik(10) })).rejects.toThrow(
      'attachment_blob_key_missing',
    )
    await expect(
      encryptAttachmentChunks({ blobKey, bytes: icerik(10), opaqueAttachmentId: 'x' }),
    ).rejects.toThrow('attachment_owner_missing')
    await expect(
      encryptAttachmentChunks({ blobKey, bytes: icerik(10), ownerUid: UID }),
    ).rejects.toThrow('attachment_id_missing')
  })

  it('AAD parça indeksini bağlar', async () => {
    const opaque = await deriveOpaqueAttachmentId(hmacKey, 'ek-5')
    const sifir = attachmentAad({ ownerUid: UID, opaqueAttachmentId: opaque, chunkIndex: 0 })
    const bir = attachmentAad({ ownerUid: UID, opaqueAttachmentId: opaque, chunkIndex: 1 })
    const temel = attachmentAad({ ownerUid: UID, opaqueAttachmentId: opaque })
    expect([...sifir]).not.toEqual([...bir])
    expect([...temel]).not.toEqual([...sifir])
  })
})

describe('dosya adı şifreleme', () => {
  it('adı şifreleyip geri çözer', async () => {
    const opaque = await deriveOpaqueAttachmentId(hmacKey, 'ek-6')
    const zarf = await encryptAttachmentName({
      blobKey,
      name: 'gizli-rapor.pdf',
      ownerUid: UID,
      opaqueAttachmentId: opaque,
    })
    expect(zarf.ciphertext).not.toContain('gizli')
    const ad = await decryptAttachmentName({
      blobKey,
      envelope: zarf,
      ownerUid: UID,
      opaqueAttachmentId: opaque,
    })
    expect(ad).toBe('gizli-rapor.pdf')
  })

  it('başka ek kimliğiyle çözmeye çalışırsa reddeder', async () => {
    const opaque = await deriveOpaqueAttachmentId(hmacKey, 'ek-7')
    const digeri = await deriveOpaqueAttachmentId(hmacKey, 'ek-8')
    const zarf = await encryptAttachmentName({
      blobKey,
      name: 'rapor.pdf',
      ownerUid: UID,
      opaqueAttachmentId: opaque,
    })
    await expect(
      decryptAttachmentName({
        blobKey,
        envelope: zarf,
        ownerUid: UID,
        opaqueAttachmentId: digeri,
      }),
    ).rejects.toThrow('attachment_name_failed')
  })

  it('boş zarf için boş ad döner', async () => {
    const ad = await decryptAttachmentName({
      blobKey,
      envelope: null,
      ownerUid: UID,
      opaqueAttachmentId: 'x',
    })
    expect(ad).toBe('')
  })
})

describe('manifest', () => {
  it('parça sayısı ve boyutu planla uyuşur', async () => {
    const opaque = await deriveOpaqueAttachmentId(hmacKey, 'ek-9')
    const veri = icerik(700 * 1024 + 10)
    const ozet = await computeSha256(veri)
    const manifest = buildBlobManifest({
      ownerUid: UID,
      opaqueAttachmentId: opaque,
      totalBytes: veri.length,
      sha256: ozet,
      mimeType: 'application/pdf',
      kind: 'pdf',
    })

    expect(manifest.chunkCount).toBe(2)
    expect(manifest.totalBytes).toBe(veri.length)
    expect(manifest.chunkBytes).toBe(700 * 1024)
    expect(manifest.sha256).toBe(ozet)
    expect(manifest.status).toBe(ATTACHMENT_MANIFEST_STATUS.UPLOADING)
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.cryptoVersion).toBe(1)
  })

  it('parçalar yüklendikten sonra ready durumuna alınır', async () => {
    const opaque = await deriveOpaqueAttachmentId(hmacKey, 'ek-10')
    const manifest = buildBlobManifest({
      ownerUid: UID,
      opaqueAttachmentId: opaque,
      totalBytes: 100,
      sha256: await computeSha256(icerik(100)),
      status: ATTACHMENT_MANIFEST_STATUS.READY,
    })
    expect(isManifestReady(manifest)).toBe(true)
  })

  it('yerel ekin manifesti ready sayılmaz', async () => {
    const opaque = await deriveOpaqueAttachmentId(hmacKey, 'ek-11')
    const manifest = buildBlobManifest({
      ownerUid: UID,
      opaqueAttachmentId: opaque,
      totalBytes: 4 * MIB,
      sha256: await computeSha256(icerik(10)),
      availability: ATTACHMENT_AVAILABILITY.LOCAL_ONLY,
      status: ATTACHMENT_MANIFEST_STATUS.READY,
    })
    expect(isManifestReady(manifest)).toBe(false)
  })

  it('zorunlu alanlar eksikse hata verir', () => {
    expect(() => buildBlobManifest({ opaqueAttachmentId: 'x', sha256: 'h' })).toThrow(
      'attachment_owner_missing',
    )
    expect(() => buildBlobManifest({ ownerUid: UID, sha256: 'h' })).toThrow('attachment_id_missing')
    expect(() => buildBlobManifest({ ownerUid: UID, opaqueAttachmentId: 'x' })).toThrow(
      'attachment_hash_missing',
    )
  })
})

describe('tembel indirme', () => {
  it('istenmedikçe gövde indirilmez', async () => {
    const opaque = await deriveOpaqueAttachmentId(hmacKey, 'ek-12')
    const manifest = buildBlobManifest({
      ownerUid: UID,
      opaqueAttachmentId: opaque,
      totalBytes: 100,
      sha256: await computeSha256(icerik(100)),
      status: ATTACHMENT_MANIFEST_STATUS.READY,
    })
    expect(shouldFetchAttachment({ manifest, hasLocalBody: false, requested: false })).toBe(false)
    expect(shouldFetchAttachment({ manifest, hasLocalBody: false, requested: true })).toBe(true)
  })

  it('yerelde gövde varsa indirmez', async () => {
    const opaque = await deriveOpaqueAttachmentId(hmacKey, 'ek-13')
    const manifest = buildBlobManifest({
      ownerUid: UID,
      opaqueAttachmentId: opaque,
      totalBytes: 100,
      sha256: await computeSha256(icerik(100)),
      status: ATTACHMENT_MANIFEST_STATUS.READY,
    })
    expect(shouldFetchAttachment({ manifest, hasLocalBody: true, requested: true })).toBe(false)
  })

  it('hazır olmayan manifesti indirmez', async () => {
    const opaque = await deriveOpaqueAttachmentId(hmacKey, 'ek-14')
    const manifest = buildBlobManifest({
      ownerUid: UID,
      opaqueAttachmentId: opaque,
      totalBytes: 100,
      sha256: await computeSha256(icerik(100)),
    })
    expect(shouldFetchAttachment({ manifest, hasLocalBody: false, requested: true })).toBe(false)
  })
})

describe('mükerrer ek tespiti', () => {
  it('aynı içerikli hazır blobu bulur', async () => {
    const ozet = await computeSha256(icerik(500))
    const yeni = { opaqueAttachmentId: 'yeni', sha256: ozet }
    const mevcut = {
      opaqueAttachmentId: 'mevcut',
      sha256: ozet,
      status: ATTACHMENT_MANIFEST_STATUS.READY,
      availability: ATTACHMENT_AVAILABILITY.SYNCED,
      chunkCount: 1,
    }
    expect(findDuplicateAttachment(yeni, [mevcut])).toBe(mevcut)
  })

  it('hazır olmayan veya farklı içerikli kaydı eşleştirmez', async () => {
    const ozet = await computeSha256(icerik(500))
    const yeni = { opaqueAttachmentId: 'yeni', sha256: ozet }
    expect(
      findDuplicateAttachment(yeni, [
        {
          opaqueAttachmentId: 'yarim',
          sha256: ozet,
          status: ATTACHMENT_MANIFEST_STATUS.UPLOADING,
          availability: ATTACHMENT_AVAILABILITY.SYNCED,
          chunkCount: 1,
        },
      ]),
    ).toBeNull()
    expect(
      findDuplicateAttachment(yeni, [
        {
          opaqueAttachmentId: 'baska',
          sha256: 'farkli',
          status: ATTACHMENT_MANIFEST_STATUS.READY,
          availability: ATTACHMENT_AVAILABILITY.SYNCED,
          chunkCount: 1,
        },
      ]),
    ).toBeNull()
  })

  it('kendisini mükerrer saymaz ve özet yoksa eşleştirmez', async () => {
    const ozet = await computeSha256(icerik(500))
    const kendisi = {
      opaqueAttachmentId: 'kendi',
      sha256: ozet,
      status: ATTACHMENT_MANIFEST_STATUS.READY,
      availability: ATTACHMENT_AVAILABILITY.SYNCED,
      chunkCount: 1,
    }
    expect(findDuplicateAttachment(kendisi, [kendisi])).toBeNull()
    expect(findDuplicateAttachment({ opaqueAttachmentId: 'x' }, [kendisi])).toBeNull()
  })
})

describe('bulut yolları', () => {
  it('manifest ve parça yollarını üretir', () => {
    expect(attachmentPaths(UID, 'abc')).toBe(`users/${UID}/blobs/abc`)
    expect(attachmentPaths(UID, 'abc', 2)).toBe(`users/${UID}/blobs/abc/chunks/2`)
  })
})
