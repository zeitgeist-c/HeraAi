import { describe, expect, it, vi } from 'vitest'

import {
  normalizeSessionAttachmentMetadata,
  normalizeSessionsAttachmentMetadata,
} from './attachmentSyncPolicy'

const attachment = (extra = {}) => ({
  id: 'a-1',
  name: 'scan.png',
  mimeType: 'image/png',
  size: 42,
  kind: 'image',
  availability: 'ready',
  data: 'BASE64',
  modelText: 'secret text',
  remoteBlobId: 'legacy-blob',
  ...extra,
})

const session = (attachments = [attachment()]) => ({
  id: 's-1',
  title: 'Session',
  messages: [{ id: 'm-1', role: 'user', content: 'Read', attachments }],
})

describe('attachment sync metadata policy', () => {
  it('oturum kimligini korur', async () => {
    expect((await normalizeSessionAttachmentMetadata(session())).id).toBe('s-1')
  })

  it('oturum basligini korur', async () => {
    expect((await normalizeSessionAttachmentMetadata(session())).title).toBe('Session')
  })

  it('mesaj alanlarini korur', async () => {
    const result = await normalizeSessionAttachmentMetadata(session())
    expect(result.messages[0]).toMatchObject({ id: 'm-1', role: 'user', content: 'Read' })
  })

  it('ek kimligini korur', async () => {
    const result = await normalizeSessionAttachmentMetadata(session())
    expect(result.messages[0].attachments[0].id).toBe('a-1')
  })

  it('ek adini korur', async () => {
    const result = await normalizeSessionAttachmentMetadata(session())
    expect(result.messages[0].attachments[0].name).toBe('scan.png')
  })

  it('MIME turunu korur', async () => {
    const result = await normalizeSessionAttachmentMetadata(session())
    expect(result.messages[0].attachments[0].mimeType).toBe('image/png')
  })

  it('boyutu korur', async () => {
    const result = await normalizeSessionAttachmentMetadata(session())
    expect(result.messages[0].attachments[0].size).toBe(42)
  })

  it('ek turunu korur', async () => {
    const result = await normalizeSessionAttachmentMetadata(session())
    expect(result.messages[0].attachments[0].kind).toBe('image')
  })

  it('yerel kaydi bulunan eki local_only yapar', async () => {
    const result = await normalizeSessionAttachmentMetadata(session(), async () => true)
    expect(result.messages[0].attachments[0].availability).toBe('local_only')
  })

  it('yerel kaydi bulunmayan eki missing yapar', async () => {
    const result = await normalizeSessionAttachmentMetadata(session(), async () => false)
    expect(result.messages[0].attachments[0].availability).toBe('missing')
  })

  it('eski synced durumunu yerel duruma donusturur', async () => {
    const result = await normalizeSessionAttachmentMetadata(
      session([attachment({ availability: 'synced' })]),
      async () => true,
    )
    expect(result.messages[0].attachments[0].availability).toBe('local_only')
  })

  it('eski remote_only durumunu missing yapar', async () => {
    const result = await normalizeSessionAttachmentMetadata(
      session([attachment({ availability: 'remote_only' })]),
      async () => false,
    )
    expect(result.messages[0].attachments[0].availability).toBe('missing')
  })

  it('base64 verisini atar', async () => {
    const result = await normalizeSessionAttachmentMetadata(session())
    expect(result.messages[0].attachments[0]).not.toHaveProperty('data')
  })

  it('model metnini atar', async () => {
    const result = await normalizeSessionAttachmentMetadata(session())
    expect(result.messages[0].attachments[0]).not.toHaveProperty('modelText')
  })

  it('eski uzak blob kimligini atar', async () => {
    const result = await normalizeSessionAttachmentMetadata(session())
    expect(result.messages[0].attachments[0]).not.toHaveProperty('remoteBlobId')
  })

  it('yalniz izin verilen alti metadata alanini birakir', async () => {
    const result = await normalizeSessionAttachmentMetadata(session())
    expect(Object.keys(result.messages[0].attachments[0]).sort()).toEqual(
      ['availability', 'id', 'kind', 'mimeType', 'name', 'size'],
    )
  })

  it('ayni ek kimligini yalniz bir kez sorgular', async () => {
    const lookup = vi.fn(async () => true)
    const value = session([attachment(), attachment()])
    await normalizeSessionAttachmentMetadata(value, lookup)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('kimliksiz ek icin yerel depo sorgusu yapmaz', async () => {
    const lookup = vi.fn(async () => true)
    await normalizeSessionAttachmentMetadata(session([attachment({ id: undefined })]), lookup)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('kimliksiz eki missing olarak isaretler', async () => {
    const result = await normalizeSessionAttachmentMetadata(session([attachment({ id: undefined })]))
    expect(result.messages[0].attachments[0].availability).toBe('missing')
  })

  it('bos mesaj listesini destekler', async () => {
    await expect(normalizeSessionAttachmentMetadata({ id: 'empty', messages: [] }))
      .resolves.toMatchObject({ id: 'empty', messages: [] })
  })

  it('messages alani olmayan eski oturumu destekler', async () => {
    await expect(normalizeSessionAttachmentMetadata({ id: 'legacy' }))
      .resolves.toMatchObject({ id: 'legacy', messages: [] })
  })

  it('attachments alani olmayan mesaji destekler', async () => {
    const result = await normalizeSessionAttachmentMetadata({ id: 's', messages: [{ id: 'm' }] })
    expect(result.messages[0].attachments).toEqual([])
  })

  it('kaynak oturumu degistirmez', async () => {
    const source = session()
    await normalizeSessionAttachmentMetadata(source, async () => true)
    expect(source.messages[0].attachments[0].data).toBe('BASE64')
    expect(source.messages[0].attachments[0].availability).toBe('ready')
  })

  it('birden cok oturumu ayni politikayla donusturur', async () => {
    const result = await normalizeSessionsAttachmentMetadata(
      [session(), { ...session(), id: 's-2' }],
      async () => true,
    )
    expect(result).toHaveLength(2)
    expect(result.every(item => item.messages[0].attachments[0].availability === 'local_only')).toBe(true)
  })

  it('bos oturum dizisini destekler', async () => {
    await expect(normalizeSessionsAttachmentMetadata()).resolves.toEqual([])
  })

  it('yerel depo hatasini sessizce yutmaz', async () => {
    await expect(normalizeSessionAttachmentMetadata(session(), async () => {
      throw new Error('attachment_store_failed')
    })).rejects.toThrow('attachment_store_failed')
  })
})
