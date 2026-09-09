import { describe, expect, it } from 'vitest'

import { QUICK_PROMPTS, resolveQuickPrompt } from './quickPrompts.js'

describe('quick prompts', () => {
  it('exposes four prompts with label keys and bilingual text', () => {
    expect(QUICK_PROMPTS).toHaveLength(4)
    for (const prompt of QUICK_PROMPTS) {
      expect(prompt.id).toBeTruthy()
      expect(prompt.labelKey).toMatch(/^chat\.quick_prompts\./)
      expect(prompt.textTr).toBeTruthy()
      expect(prompt.textEn).toBeTruthy()
    }
  })

  it('resolves English text for English locales and Turkish otherwise', () => {
    const prompt = QUICK_PROMPTS[0]
    expect(resolveQuickPrompt(prompt, 'en')).toBe(prompt.textEn)
    expect(resolveQuickPrompt(prompt, 'en-US')).toBe(prompt.textEn)
    expect(resolveQuickPrompt(prompt, 'tr')).toBe(prompt.textTr)
    expect(resolveQuickPrompt(prompt, '')).toBe(prompt.textTr)
    expect(resolveQuickPrompt(prompt, null)).toBe(prompt.textTr)
  })
})
