import { afterEach, describe, expect, it } from 'vitest'

import {
  cleanupOrphanAttachments,
  getAttachment,
  listAttachmentIds,
  migrateLegacySessionAttachments,
  putAttachment,
} from './attachmentStore.js'

describe('attachment store', () => {
  afterEach(async () => {
    await cleanupOrphanAttachments([])
  })

  it('stores blobs separately and returns a metadata-only reference', async () => {
    const ref = await putAttachment({
      blob: new Blob(['hello'], { type: 'text/plain' }),
      modelText: 'hello',
      name: 'hello.txt',
      mimeType: 'text/plain',
      size: 5,
      kind: 'text',
    })
    expect(ref).toEqual(expect.objectContaining({ id: expect.any(String), availability: 'ready' }))
    expect(ref).not.toHaveProperty('blob')
    await expect(getAttachment(ref.id)).resolves.toMatchObject({ modelText: 'hello' })
  })

  it('migrates legacy base64 messages and removes orphaned records', async () => {
    const migration = await migrateLegacySessionAttachments([{
      id: 'session',
      messages: [{
        role: 'user',
        content: 'read',
        attachments: [{
          name: 'scan.png',
          mimeType: 'image/png',
          data: btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
        }],
      }],
    }])
    const ref = migration.sessions[0].messages[0].attachments[0]
    expect(migration.changed).toBe(true)
    expect(ref).toEqual(expect.objectContaining({ id: expect.any(String), availability: 'ready' }))
    expect(ref).not.toHaveProperty('data')
    await cleanupOrphanAttachments([])
    expect(await listAttachmentIds()).not.toContain(ref.id)
  })
})
