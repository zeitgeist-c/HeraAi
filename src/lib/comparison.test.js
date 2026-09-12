import { describe, expect, it } from 'vitest'

import {
  COMPARISON_SLOTS,
  allVariantsTerminal,
  applyWinnerSelection,
  createComparisonJob,
  getSelectableWinners,
  isComparisonJob,
} from './comparison.js'

describe('comparison job model', () => {
  it('exposes exactly the a/b slots', () => {
    expect(COMPARISON_SLOTS).toEqual(['a', 'b'])
  })

  it('creates a parent job with two queued variants', () => {
    const parent = createComparisonJob({
      jobId: 'cmp-1',
      sessionId: 'session-1',
      variants: [
        { variantId: 'a', model: 'gemini-3.6-flash', provider: 'gemini' },
        { variantId: 'b', model: 'openrouter/free', provider: 'openrouter' },
      ],
    })

    expect(parent).toMatchObject({
      kind: 'comparison',
      jobId: 'cmp-1',
      comparisonId: 'cmp-1',
      sessionId: 'session-1',
    })
    expect(parent.variants.a).toMatchObject({
      variantId: 'a',
      status: 'queued',
      content: '',
      sources: [],
      resolvedModel: null,
      revision: 0,
      errorCode: null,
      model: 'gemini-3.6-flash',
      provider: 'gemini',
    })
    expect(parent.variants.b).toMatchObject({
      variantId: 'b',
      status: 'queued',
      model: 'openrouter/free',
      provider: 'openrouter',
    })
    expect(parent.selection).toMatchObject({ winnerSlot: null })
  })

  it('accepts an object-shaped variant map and defaults missing slots', () => {
    const parent = createComparisonJob({
      jobId: 'cmp-2',
      variants: { b: { model: 'gpt-oss:120b', provider: 'ollama' } },
    })

    expect(parent.variants.a).toMatchObject({ variantId: 'a', status: 'queued' })
    expect(parent.variants.b).toMatchObject({
      variantId: 'b',
      status: 'queued',
      model: 'gpt-oss:120b',
      provider: 'ollama',
    })
  })

  it('detects comparison jobs', () => {
    expect(isComparisonJob(createComparisonJob({ jobId: 'cmp-1' }))).toBe(true)
    expect(isComparisonJob({ kind: 'comparison', variants: { a: {} } })).toBe(false)
    expect(isComparisonJob({ kind: 'single', jobId: 'job-1' })).toBe(false)
    expect(isComparisonJob(null)).toBe(false)
  })

  it('reports terminal state only when both variants are terminal', () => {
    const parent = createComparisonJob({ jobId: 'cmp-1' })
    expect(allVariantsTerminal(parent)).toBe(false)

    parent.variants.a.status = 'completed'
    expect(allVariantsTerminal(parent)).toBe(false)

    parent.variants.b.status = 'error'
    expect(allVariantsTerminal(parent)).toBe(true)

    parent.variants.b.status = 'cancelled'
    expect(allVariantsTerminal(parent)).toBe(true)

    expect(allVariantsTerminal({ kind: 'single' })).toBe(false)
  })

  it('lists only completed variants as selectable winners', () => {
    const parent = createComparisonJob({ jobId: 'cmp-1' })
    expect(getSelectableWinners(parent)).toEqual([])

    parent.variants.a.status = 'completed'
    expect(getSelectableWinners(parent)).toEqual(['a'])

    parent.variants.b.status = 'error'
    expect(getSelectableWinners(parent)).toEqual(['a'])

    parent.variants.b.status = 'completed'
    expect(getSelectableWinners(parent)).toEqual(['a', 'b'])

    expect(getSelectableWinners(null)).toEqual([])
  })

  it('marks the winner selected and excludes the loser from context', () => {
    const messages = [
      { id: 'user-1', role: 'user', content: 'Which is better?' },
      { id: 'assistant-1:a', comparisonId: 'cmp-1', variantId: 'a', role: 'model', content: 'A' },
      { id: 'assistant-1:b', comparisonId: 'cmp-1', variantId: 'b', role: 'model', content: 'B' },
    ]

    const next = applyWinnerSelection(messages, 'cmp-1', 'b')

    expect(next[0]).toBe(messages[0])
    expect(next[1]).toMatchObject({
      id: 'assistant-1:a',
      comparisonSelected: false,
      contextExcluded: true,
    })
    expect(next[2]).toMatchObject({
      id: 'assistant-1:b',
      comparisonSelected: true,
      contextExcluded: false,
    })
    // Original messages stay untouched.
    expect(messages[1]).not.toHaveProperty('comparisonSelected')
    expect(messages[2]).not.toHaveProperty('contextExcluded')
  })

  it('leaves other comparisons and unknown slots untouched', () => {
    const messages = [
      { id: 'assistant-9:a', comparisonId: 'cmp-9', variantId: 'a', role: 'model', content: 'X' },
      { id: 'assistant-1:c', comparisonId: 'cmp-1', variantId: 'c', role: 'model', content: 'Y' },
    ]

    const next = applyWinnerSelection(messages, 'cmp-1', 'a')
    expect(next[0]).toBe(messages[0])
    expect(next[1]).toBe(messages[1])
  })

  it('returns messages unchanged for an invalid winner slot', () => {
    const messages = [
      { id: 'assistant-1:a', comparisonId: 'cmp-1', variantId: 'a', role: 'model', content: 'A' },
    ]
    expect(applyWinnerSelection(messages, 'cmp-1', 'c')).toBe(messages)
  })
})
