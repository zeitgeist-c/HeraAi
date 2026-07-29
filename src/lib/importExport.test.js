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

  it('exports version 1.1 with custom-title and starred metadata', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:hera-export')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    exportSessions([{
      id: 'session-1',
      title: 'Saved title',
      isTitleCustom: true,
      isStarred: true,
      updatedAt: 100,
      messages: [{ role: 'user', content: 'Internal prompt', displayContent: '' }],
    }])

    const blob = createObjectURL.mock.calls[0][0]
    const exported = JSON.parse(await readBlob(blob))
    expect(exported).toMatchObject({
      version: '1.1',
      sessions: [{
        id: 'session-1',
        title: 'Saved title',
        isTitleCustom: true,
        isStarred: true,
        messages: [{
          role: 'user',
          content: 'Internal prompt',
          displayContent: '',
        }],
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

    await expect(importSessions(file)).resolves.toEqual([{
      id: 'legacy-session',
      title: 'Legacy title',
      isTitleCustom: false,
      isStarred: false,
      updatedAt: 100,
      messages: [],
    }])
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

    await expect(importSessions(file)).resolves.toEqual([{
      id: 'starred-session',
      title: 'Pinned title',
      isTitleCustom: true,
      isStarred: true,
      updatedAt: 200,
      messages: [{ role: 'user', content: 'Internal prompt', displayContent: '' }],
    }])
  })
})
