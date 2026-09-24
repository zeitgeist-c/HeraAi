import { describe, expect, it } from 'vitest'

import {
  hasRetiredModelProvenance,
  sanitizeRetiredModelMessages,
  sanitizeRetiredModelSessions,
  stripRetiredModelProvenance,
} from './modelMigration.js'

describe('retired model migration', () => {
  it('removes MiniMax requested and resolved provenance without changing content', () => {
    const message = {
      role: 'model',
      content: 'Keep this answer',
      provider: 'ollama',
      model: 'minimax-m3',
      resolvedModel: 'minimax-m3:cloud',
    }

    expect(hasRetiredModelProvenance(message)).toBe(true)
    expect(stripRetiredModelProvenance(message)).toEqual({
      changed: true,
      value: {
        role: 'model',
        content: 'Keep this answer',
        provider: 'ollama',
      },
    })
  })

  it('sanitizes messages and sessions without rewriting other model provenance', () => {
    const sessions = [{
      id: 's1',
      messages: [
        { role: 'model', content: 'Old', model: 'minimax-m3' },
        { role: 'model', content: 'Current', model: 'nemotron-3-super', provider: 'ollama' },
      ],
    }]

    const result = sanitizeRetiredModelSessions(sessions)
    expect(result.changed).toBe(true)
    expect(result.sessions[0].messages).toEqual([
      { role: 'model', content: 'Old' },
      { role: 'model', content: 'Current', model: 'nemotron-3-super', provider: 'ollama' },
    ])
    expect(sanitizeRetiredModelMessages(result.sessions[0].messages).changed).toBe(false)
  })
})
