import { describe, expect, it } from 'vitest'

import {
  requestsPreviousImage,
  requestsPreviousWebSource,
  selectRequestContext,
} from './contextSelection'

describe('context selection', () => {
  it.each(['önceki görseldeki yazı', 'eski fotoğrafa bak', 'use the previous image', 'İlk görseldeki tabloyu özetle'])('detects explicit previous image references: %s', text => {
    expect(requestsPreviousImage(text)).toBe(true)
  })

  it.each(['önceki linkteki bilgi', 'ilk URL hakkında', 'check the earlier page', 'İlk linki özetle'])('detects explicit previous web references: %s', text => {
    expect(requestsPreviousWebSource(text)).toBe(true)
  })

  it('does not treat an ambiguous current-image reference as a previous image request', () => {
    expect(requestsPreviousImage('bu görselde ne yazıyor?')).toBe(false)
  })

  it('uses only draft attachments and current URLs by default', () => {
    expect(selectRequestContext({
      text: 'new question',
      draftAttachments: [{ id: 'new-image' }],
      previousAttachments: [{ id: 'old-image' }],
      explicitUrls: ['https://new.example'],
      previousUrls: ['https://old.example'],
      includePreviousWeb: true,
    })).toEqual({
      attachments: [{ id: 'new-image' }],
      urls: ['https://new.example'],
    })
  })

  it('restores previous sources only for explicit references', () => {
    expect(selectRequestContext({
      text: 'önceki görsel ile önceki linki karşılaştır',
      draftAttachments: [{ id: 'new-image' }],
      previousAttachments: [{ id: 'old-image' }],
      explicitUrls: [],
      previousUrls: ['https://old.example'],
      includePreviousWeb: true,
    })).toEqual({
      attachments: [{ id: 'old-image' }, { id: 'new-image' }],
      urls: ['https://old.example'],
    })
  })
})
