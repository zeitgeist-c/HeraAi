import { describe, expect, it } from 'vitest'

import { findChatMatchIds } from './chatSearch.js'

describe('in-chat search', () => {
  const messages = [
    { id: 'u1', role: 'user', content: 'Ankara gezi planı yap' },
    { id: 'm1', role: 'model', content: 'Ankara için üç günlük plan hazır.' },
    { id: 'u2', role: 'user', content: 'İzmir nasıl?', displayContent: 'İzmir hakkında bilgi ver' },
    { id: 'm2', role: 'model', content: '', status: 'thinking' },
  ]

  it('returns matching message ids in order', () => {
    expect(findChatMatchIds(messages, 'ankara')).toEqual(['u1', 'm1'])
  })

  it('prefers display content and ignores empty queries', () => {
    expect(findChatMatchIds(messages, 'hakkında')).toEqual(['u2'])
    expect(findChatMatchIds(messages, '   ')).toEqual([])
    expect(findChatMatchIds(messages, '')).toEqual([])
  })

  it('skips non-conversation roles and messages without ids', () => {
    const mixed = [
      ...messages,
      { role: 'system', content: 'ankara' },
      { role: 'user', content: 'ankara' },
    ]
    expect(findChatMatchIds(mixed, 'ankara')).toEqual(['u1', 'm1'])
  })
})
