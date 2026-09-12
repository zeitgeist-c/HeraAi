import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../i18n'
import { CHANGELOG } from '../data/changelog'
import ChangelogPanel from './ChangelogPanel'

beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage('en')
})

describe('ChangelogPanel', () => {
  it('keeps Turkish and English notes in sync for every version', () => {
    for (const entry of CHANGELOG) {
      expect(Array.isArray(entry.changes.tr)).toBe(true)
      expect(Array.isArray(entry.changes.en)).toBe(true)
      expect(entry.changes.tr.length).toBeGreaterThan(0)
      expect(entry.changes.tr.length).toBe(entry.changes.en.length)
      for (const change of [...entry.changes.tr, ...entry.changes.en]) {
        expect(change.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('shows the latest version as a highlighted current card', () => {
    render(<ChangelogPanel onClose={() => {}} />)

    expect(screen.getByText('Changelog')).toBeInTheDocument()
    expect(screen.getByText(`Version ${CHANGELOG[0].version} · current`)).toBeInTheDocument()
    for (const change of CHANGELOG[0].changes.en) {
      expect(screen.getByText(change)).toBeInTheDocument()
    }
  })

  it('expands an older collapsed version on click', () => {
    render(<ChangelogPanel onClose={() => {}} />)

    const older = CHANGELOG[1]
    expect(screen.queryByText(older.changes.en[0])).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`v?${older.version}`) }))
    expect(screen.getByText(older.changes.en[0])).toBeInTheDocument()
  })

  it('closes through the close button', () => {
    const onClose = vi.fn()
    render(<ChangelogPanel onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
