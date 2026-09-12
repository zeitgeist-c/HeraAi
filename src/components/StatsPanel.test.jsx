import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../i18n'
import { getStatsSnapshot } from '../lib/stats'
import StatsPanel from './StatsPanel'

vi.mock('../lib/stats', () => ({ getStatsSnapshot: vi.fn() }))

const fullSnapshot = (overrides = {}) => ({
  range: '7d',
  promptsTotal: 12,
  sessionCount: 4,
  avgSuccessDurationMs: 1500,
  successRate: 0.75,
  outcomes: { completed: 9, error: 2, interrupted: 1, cancelled: 0 },
  activity: [
    { key: '2026-09-06', label: 'Sep 6', count: 3 },
    { key: '2026-09-07', label: 'Sep 7', count: 9 },
  ],
  tools: { voice: 2, screenshot: 1, search: 3 },
  models: [
    {
      modelKey: 'gemini:gemini-3.5-flash',
      modelId: 'gemini-3.5-flash',
      provider: 'gemini',
      attempts: 10,
      successes: 8,
      avgSuccessDurationMs: 1200,
      successRate: 0.8,
    },
  ],
  lastActive: 1726051200000,
  hasAnyData: true,
  ...overrides,
})

beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage('en')
})

describe('StatsPanel', () => {
  it('renders summary cards, activity chart, and model table for full data', async () => {
    getStatsSnapshot.mockResolvedValue(fullSnapshot())
    render(<StatsPanel onClose={() => {}} />)

    expect(await screen.findByText('Prompts sent')).toBeInTheDocument()
    expect(getStatsSnapshot).toHaveBeenCalledWith({ range: '7d' })

    expect(screen.getByText('Sessions')).toBeInTheDocument()
    expect(screen.getByText('Avg. response time')).toBeInTheDocument()
    // Card label and model-table column header share this string.
    expect(screen.getAllByText('Success rate')).toHaveLength(2)

    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('1.5 s')).toBeInTheDocument()

    const chart = await screen.findByRole('img', { name: /Prompt activity chart/i })
    expect(chart).toHaveAttribute('aria-label', expect.stringContaining('Sep 6: 3'))
    expect(chart).toHaveAttribute('aria-label', expect.stringContaining('Sep 7: 9'))

    expect(screen.getByText('Peak: Sep 7 — 9')).toBeInTheDocument()

    expect(screen.getByText('Models')).toBeInTheDocument()
    expect(screen.getByText('gemini-3.5-flash')).toBeInTheDocument()
    expect(screen.getByText('Gemini')).toBeInTheDocument()
    expect(screen.getByText('80%')).toBeInTheDocument()

    expect(screen.getByText('Voice Inputs')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it("refetches the snapshot with range '30d' when the 30-day tab is clicked", async () => {
    getStatsSnapshot.mockResolvedValue(fullSnapshot())
    render(<StatsPanel onClose={() => {}} />)

    await screen.findByText('Prompts sent')
    expect(getStatsSnapshot).toHaveBeenCalledWith({ range: '7d' })

    const tab30d = screen.getByRole('button', { name: '30 Days' })
    expect(tab30d).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(tab30d)

    await waitFor(() => expect(getStatsSnapshot).toHaveBeenCalledWith({ range: '30d' }))
    expect(screen.getByRole('button', { name: '30 Days' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows the empty note when the snapshot has no data', async () => {
    getStatsSnapshot.mockResolvedValue(
      fullSnapshot({
        promptsTotal: 0,
        sessionCount: 0,
        avgSuccessDurationMs: null,
        successRate: null,
        activity: [],
        tools: { voice: 0, screenshot: 0, search: 0 },
        models: [],
        lastActive: null,
        hasAnyData: false,
      }),
    )
    render(<StatsPanel onClose={() => {}} />)

    expect(await screen.findByText('No stats yet. Send a prompt to see your usage here.')).toBeInTheDocument()
    expect(screen.queryByText('Models')).not.toBeInTheDocument()
  })

  it('shows the legacy note when only tool usage exists in the all-time range', async () => {
    const legacySnapshot = fullSnapshot({
      range: 'all',
      promptsTotal: 0,
      sessionCount: 0,
      avgSuccessDurationMs: null,
      successRate: null,
      activity: [],
      tools: { voice: 1, screenshot: 2, search: 0 },
      models: [],
      hasAnyData: true,
    })
    getStatsSnapshot.mockImplementation(({ range }) =>
      Promise.resolve(range === 'all' ? legacySnapshot : fullSnapshot()),
    )
    render(<StatsPanel onClose={() => {}} />)

    await screen.findByText('Prompts sent')
    fireEvent.click(screen.getByRole('button', { name: 'All Time' }))

    expect(
      await screen.findByText(
        'Detailed prompt stats were not recorded yet in this range, so only tool usage (voice, screenshots, searches) is shown.',
      ),
    ).toBeInTheDocument()
  })

  it('formats ISO bucket keys as compact locale labels', async () => {
    getStatsSnapshot.mockResolvedValue(
      fullSnapshot({
        activity: [
          { key: '2026-09-06', label: '2026-09-06', count: 3 },
          { key: '2026-09-07', label: '2026-09-07', count: 9 },
        ],
      }),
    )
    render(<StatsPanel onClose={() => {}} />)

    expect(await screen.findByText('Sep 6')).toBeInTheDocument()
    expect(screen.getByText('Sep 7')).toBeInTheDocument()
    expect(screen.queryByText('2026-09-06')).not.toBeInTheDocument()
    expect(screen.getByText('Peak: Sep 7 — 9')).toBeInTheDocument()
  })
})
