import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../i18n'
import AppHeader from './AppHeader'
import HistoryOverlay from './HistoryOverlay'

const headerProps = {
  onNewChat: vi.fn(),
  onHistory: vi.fn(),
  onClear: vi.fn(),
  onExport: vi.fn(),
  onImport: vi.fn(),
  onSettings: vi.fn(),
  onStats: vi.fn(),
  onShortcuts: vi.fn(),
}

const sessions = [
  { id: 'other-old', title: 'Other old', updatedAt: 100, isStarred: false },
  { id: 'star-old', title: 'Star old', updatedAt: 200, isStarred: true },
  { id: 'other-new', title: 'Other new', updatedAt: 400, isStarred: false },
  { id: 'star-new', title: 'Star new', updatedAt: 300, isStarred: true },
]

describe('session management UI', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await i18n.changeLanguage('en')
  })

  it('shows and renames the active session from the header', async () => {
    const onRenameSession = vi.fn()
    render(
      <AppHeader
        {...headerProps}
        activeSessionTitle="Current chat"
        onRenameSession={onRenameSession}
      />
    )

    expect(screen.getByText('Current chat')).toBeInTheDocument()
    expect(screen.getByText('HeraAi · AI assistant')).toBeInTheDocument()

    const renameButton = screen.getByRole('button', { name: 'Rename chat' })
    fireEvent.click(renameButton)
    const input = screen.getByRole('textbox', { name: 'Chat name' })
    fireEvent.change(input, { target: { value: '  Renamed chat  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRenameSession).toHaveBeenCalledWith('Renamed chat')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename chat' })).toHaveFocus())
  })

  it('rejects an empty header title and returns focus after cancelling with Escape', async () => {
    const onRenameSession = vi.fn()
    render(
      <AppHeader
        {...headerProps}
        activeSessionTitle="Current chat"
        onRenameSession={onRenameSession}
      />
    )

    const renameButton = screen.getByRole('button', { name: 'Rename chat' })
    fireEvent.click(renameButton)
    const input = screen.getByRole('textbox', { name: 'Chat name' })
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(onRenameSession).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Chat name' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename chat' })).toHaveFocus())
  })

  it('keeps focus on the next control when header renaming is saved by blur', async () => {
    const onRenameSession = vi.fn()
    render(
      <AppHeader
        {...headerProps}
        activeSessionTitle="Current chat"
        onRenameSession={onRenameSession}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Rename chat' }))
    const input = screen.getByRole('textbox', { name: 'Chat name' })
    const newChatButton = screen.getByRole('button', { name: 'Start New Chat' })
    fireEvent.change(input, { target: { value: 'Blurred header title' } })

    act(() => newChatButton.focus())

    expect(onRenameSession).toHaveBeenCalledWith('Blurred header title')
    await waitFor(() => expect(newChatButton).toHaveFocus())
    expect(screen.getByRole('button', { name: 'Rename chat' })).not.toHaveFocus()
  })

  it('shows Import Chat immediately above Export Chat in the header menu', () => {
    render(<AppHeader {...headerProps} activeSessionTitle="Current chat" />)

    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    const menuItems = screen.getAllByRole('menuitem').map(item => item.textContent)
    const importIndex = menuItems.indexOf('Import Chat')
    const exportIndex = menuItems.indexOf('Export Chat')

    expect(importIndex).toBeGreaterThanOrEqual(0)
    expect(exportIndex).toBe(importIndex + 1)
  })

  it('groups sessions, orders them by recency, and exposes sibling row actions', async () => {
    const onRename = vi.fn()
    const onToggleStar = vi.fn()
    const onDelete = vi.fn()
    const { container } = render(
      <HistoryOverlay
        sessions={sessions}
        activeSessionId="star-new"
        onSelect={vi.fn()}
        onDelete={onDelete}
        onRename={onRename}
        onToggleStar={onToggleStar}
        onRequestBulkDelete={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      'Starred',
      'Other chats',
    ])
    expect(screen.getByText('Star new').compareDocumentPosition(screen.getByText('Star old')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('Other new').compareDocumentPosition(screen.getByText('Other old')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelector('button button')).toBeNull()

    const renameButton = screen.getAllByRole('button', { name: 'Rename chat' })[0]
    fireEvent.click(renameButton)
    const input = screen.getByRole('textbox', { name: 'Chat name' })
    fireEvent.change(input, { target: { value: 'Renamed starred chat' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith('star-new', 'Renamed starred chat')
    await waitFor(() => expect(renameButton).toHaveFocus())

    fireEvent.click(renameButton)
    const reopenedInput = screen.getByRole('textbox', { name: 'Chat name' })
    fireEvent.keyDown(reopenedInput, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Chat name' })).not.toBeInTheDocument()
    await waitFor(() => expect(renameButton).toHaveFocus())

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove star' })[0])
    expect(onToggleStar).toHaveBeenCalledWith('star-new')
  })

  it('filters sessions by title through the history search box', () => {
    render(
      <HistoryOverlay
        sessions={sessions}
        activeSessionId="star-new"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        onToggleStar={vi.fn()}
        onRequestBulkDelete={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('Other old')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('history-search'), { target: { value: 'star' } })
    expect(screen.queryByText('Other old')).not.toBeInTheDocument()
    expect(screen.queryByText('Other new')).not.toBeInTheDocument()
    expect(screen.getByText('Star old')).toBeInTheDocument()
    expect(screen.getByText('Star new')).toBeInTheDocument()
  })

  it('finds sessions by message content as well as title', () => {
    const contentSessions = [
      { id: 's1', title: 'Tatil', updatedAt: 100, isStarred: false },
      {
        id: 's2',
        title: 'Alışveriş',
        updatedAt: 200,
        isStarred: false,
        messages: [{ id: 'm1', role: 'user', content: 'Ankara gezi planı yap' }],
      },
    ]
    render(
      <HistoryOverlay
        sessions={contentSessions}
        activeSessionId="s1"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        onToggleStar={vi.fn()}
        onRequestBulkDelete={vi.fn()}
        onClose={vi.fn()}
      />
    )

    fireEvent.change(screen.getByTestId('history-search'), { target: { value: 'ankara' } })
    expect(screen.queryByText('Tatil')).not.toBeInTheDocument()
    expect(screen.getByText('Alışveriş')).toBeInTheDocument()
  })

  it('keeps focus on the next row control when history renaming is saved by blur', async () => {
    const onRename = vi.fn()
    render(
      <HistoryOverlay
        sessions={sessions}
        activeSessionId="star-new"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onRename={onRename}
        onToggleStar={vi.fn()}
        onRequestBulkDelete={vi.fn()}
        onClose={vi.fn()}
      />
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Rename chat' })[0])
    const input = screen.getByRole('textbox', { name: 'Chat name' })
    const starButton = screen.getAllByRole('button', { name: 'Remove star' })[0]
    fireEvent.change(input, { target: { value: 'Blurred history title' } })

    act(() => starButton.focus())

    expect(onRename).toHaveBeenCalledWith('star-new', 'Blurred history title')
    await waitFor(() => expect(starButton).toHaveFocus())
    expect(screen.getAllByRole('button', { name: 'Rename chat' })[0]).not.toHaveFocus()
  })

  it('shows a controlled bulk-delete dialog, focuses cancel, and reports counts', async () => {
    const onCancelBulkDelete = vi.fn()
    const onConfirmBulkDelete = vi.fn()
    render(
      <HistoryOverlay
        sessions={sessions}
        activeSessionId="star-new"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        onToggleStar={vi.fn()}
        onRequestBulkDelete={vi.fn()}
        bulkDeleteOpen
        onCancelBulkDelete={onCancelBulkDelete}
        onConfirmBulkDelete={onConfirmBulkDelete}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByRole('dialog', { name: 'Delete unstarred chats?' })).toBeInTheDocument()
    expect(screen.getByText('Unstarred chats to be permanently deleted: 2.')).toBeInTheDocument()
    expect(screen.getByText('Starred chats that will be kept: 2.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'Delete 2' }))
    expect(onConfirmBulkDelete).toHaveBeenCalledOnce()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancelBulkDelete).toHaveBeenCalledOnce()
  })

  it('preserves dialog focus when the open bulk-delete overlay rerenders', async () => {
    const initialCancel = vi.fn()
    const commonProps = {
      sessions,
      activeSessionId: 'star-new',
      onSelect: vi.fn(),
      onDelete: vi.fn(),
      onRename: vi.fn(),
      onToggleStar: vi.fn(),
      onRequestBulkDelete: vi.fn(),
      bulkDeleteOpen: true,
      onConfirmBulkDelete: vi.fn(),
      onClose: vi.fn(),
    }
    const { rerender } = render(
      <HistoryOverlay
        {...commonProps}
        onCancelBulkDelete={initialCancel}
      />
    )

    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus())
    const confirmButton = screen.getByRole('button', { name: 'Delete 2' })
    act(() => confirmButton.focus())
    expect(confirmButton).toHaveFocus()

    rerender(
      <HistoryOverlay
        {...commonProps}
        sessions={[...sessions]}
        onCancelBulkDelete={vi.fn()}
      />
    )

    await waitFor(() => expect(confirmButton).toHaveFocus())
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toHaveFocus()
  })
})
