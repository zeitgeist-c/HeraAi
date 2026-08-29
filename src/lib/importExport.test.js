import { afterEach, describe, expect, it, vi } from 'vitest'

import { exportSessions, importSessions } from './importExport.js'

const readBlob = blob => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = event => resolve(event.target.result)
  reader.onerror = () => reject(reader.error)
  reader.readAsText(blob)
})

describe('session import and export', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exports version 2.2 metadata and provider provenance without attachment payloads', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:hera-export')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    exportSessions([{
      id: 'session-1',
      title: 'Saved title',
      isTitleCustom: true,
      isStarred: true,
      updatedAt: 100,
      activeAttachmentIds: ['file-1'],
      activeWebUrls: ['https://example.com/'],
      messages: [
        {
          role: 'user',
          content: 'Internal prompt',
          displayContent: '',
          attachments: [{ id: 'file-1', name: 'notes.txt', mimeType: 'text/plain', data: 'secret' }],
        },
        {
          role: 'model',
          content: 'Saved answer',
          model: 'openrouter/free',
          provider: 'openrouter',
          resolvedModel: 'meta-llama/llama-4-scout:free',
        },
        {
          role: 'model',
          content: 'Retired answer',
          model: 'minimax-m3',
          provider: 'ollama',
          resolvedModel: 'minimax-m3:cloud',
        },
      ],
    }])

    const blob = createObjectURL.mock.calls[0][0]
    const exported = JSON.parse(await readBlob(blob))
    expect(exported).toMatchObject({
      version: '2.2',
      sessions: [{
        id: 'session-1',
        title: 'Saved title',
        isTitleCustom: true,
        isStarred: true,
        activeAttachmentIds: ['file-1'],
        activeWebUrls: ['https://example.com/'],
        messages: [
          {
            role: 'user',
            content: 'Internal prompt',
            displayContent: '',
            attachments: [{
              id: 'file-1',
              name: 'notes.txt',
              mimeType: 'text/plain',
              availability: 'omitted',
            }],
          },
          {
            role: 'model',
            content: 'Saved answer',
            model: 'openrouter/free',
            provider: 'openrouter',
            resolvedModel: 'meta-llama/llama-4-scout:free',
            attachments: [],
          },
          {
            role: 'model',
            content: 'Retired answer',
            provider: 'ollama',
            attachments: [],
          },
        ],
      }],
    })
  })

  it('defaults metadata from version 1.0 exports to false', async () => {
    const file = new File([JSON.stringify({
      version: '1.0',
      sessions: [{
        id: 'legacy-session',
        title: 'Legacy title',
        updatedAt: 100,
        messages: [],
      }],
    })], 'legacy.json', { type: 'application/json' })

    await expect(importSessions(file)).resolves.toMatchObject([{
      id: 'legacy-session',
      title: 'Legacy title',
      isTitleCustom: false,
      isStarred: false,
      updatedAt: 100,
      messages: [],
    }])
  })

  it('preserves model provenance when importing version 2.1 messages', async () => {
    const file = new File([JSON.stringify({
      version: '2.1',
      sessions: [{
        id: 'model-session',
        title: 'Model session',
        messages: [{
          role: 'model',
          content: 'Imported answer',
          model: 'gemini-3.6-flash',
        }],
      }],
    })], 'model-session.json', { type: 'application/json' })

    await expect(importSessions(file)).resolves.toMatchObject([{
      id: 'model-session',
      messages: [{
        role: 'model',
        content: 'Imported answer',
        model: 'gemini-3.6-flash',
      }],
    }])
  })

  it('removes retired MiniMax provenance from imported messages without deleting content', async () => {
    const file = new File([JSON.stringify({
      version: '2.2',
      sessions: [{
        id: 'retired-model-session',
        messages: [{
          role: 'model',
          content: 'Preserved answer',
          provider: 'ollama',
          model: 'minimax-m3',
          resolvedModel: 'minimax-m3:cloud',
        }],
      }],
    })], 'retired-model.json', { type: 'application/json' })

    const imported = await importSessions(file)
    expect(imported[0].messages[0]).toEqual(expect.objectContaining({
      role: 'model',
      content: 'Preserved answer',
      provider: 'ollama',
    }))
    expect(imported[0].messages[0]).not.toHaveProperty('model')
    expect(imported[0].messages[0]).not.toHaveProperty('resolvedModel')
  })

  it('restores version 1.1 metadata using strict boolean values', async () => {
    const file = new File([JSON.stringify({
      version: '1.1',
      sessions: [{
        id: 'starred-session',
        title: 'Pinned title',
        isTitleCustom: true,
        isStarred: true,
        updatedAt: 200,
        messages: [{ role: 'user', content: 'Internal prompt', displayContent: '' }],
      }],
    })], 'current.json', { type: 'application/json' })

    await expect(importSessions(file)).resolves.toMatchObject([{
      id: 'starred-session',
      title: 'Pinned title',
      isTitleCustom: true,
      isStarred: true,
      updatedAt: 200,
      messages: [{ role: 'user', content: 'Internal prompt', displayContent: '' }],
    }])
  })
})
