import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import toast from 'react-hot-toast'

import '../i18n'
import ChatMessage from './ChatMessage'

const retryModels = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
]

const modelLabels = {
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
  'gemini-3.6-flash': 'Gemini 3.6 Flash',
}

describe('ChatMessage copy actions', () => {
  const writeText = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  })

  it('copies an assistant response and shows a completed state', async () => {
    writeText.mockResolvedValue()
    render(<ChatMessage message={{ id: 1, role: 'model', content: 'Copy this response' }} />)

    fireEvent.click(screen.getByRole('button', { name: /Copy|Kopyala/i }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Copy this response'))
    expect(await screen.findByText(/Copied!|Kopyalandı!/i)).toBeInTheDocument()
  })

  it('copies a user question from its action row', async () => {
    writeText.mockResolvedValue()
    render(<ChatMessage message={{ id: 4, role: 'user', content: 'Copy this question' }} />)

    fireEvent.click(screen.getByRole('button', { name: /Copy|Kopyala/i }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Copy this question'))
  })

  it('keeps an internal prompt hidden while preserving its attachment and retry action', () => {
    const onEdit = vi.fn()
    const onRetry = vi.fn()
    const message = {
      id: 10,
      role: 'user',
      content: 'Internal OCR instruction that must not be displayed',
      displayContent: '',
      attachments: [{ name: 'scan.png', mimeType: 'image/png', data: 'image-data' }],
    }

    render(<ChatMessage message={message} onEdit={onEdit} onRetry={onRetry} />)

    expect(screen.queryByText(message.content)).not.toBeInTheDocument()
    expect(screen.getByText('scan.png')).toBeInTheDocument()
    expect(document.querySelector('svg.lucide-copy')).not.toBeInTheDocument()
    expect(document.querySelector('svg.lucide-pencil')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Regenerate response|Retry|Yeniden dene/i }))
    expect(onRetry).toHaveBeenCalledWith(message)
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('retries a user question with the model selected from the retry menu', () => {
    const onRetry = vi.fn()
    const message = { id: 5, role: 'user', content: 'Compare this answer' }
    render(
      <ChatMessage
        message={message}
        onRetry={onRetry}
        retryModels={retryModels}
        modelLabels={modelLabels}
        currentModel="gemini-3.1-flash-lite"
      />
    )

    const retryButton = screen.getByRole('button', { name: /Try again with a model|Model ile yeniden dene/i })
    fireEvent.click(retryButton)

    const retryDialog = screen.getByRole('dialog', { name: /Try again with a model|Model ile yeniden dene/i })
    expect(Array.from(retryDialog.querySelectorAll('[data-retry-model]')).map(button => button.dataset.retryModel)).toEqual(retryModels)

    fireEvent.click(screen.getByRole('button', { name: 'Gemini 3.5 Flash Lite' }))

    expect(onRetry).toHaveBeenCalledWith(message, 'gemini-3.5-flash-lite')
    expect(screen.queryByRole('dialog', { name: /Try again with a model|Model ile yeniden dene/i })).not.toBeInTheDocument()
  })

  it('closes the retry model menu with Escape and restores trigger focus', () => {
    render(
      <ChatMessage
        message={{ id: 6, role: 'model', content: 'An answer' }}
        retryModels={retryModels}
        modelLabels={modelLabels}
        currentModel="gemini-3.1-flash-lite"
      />
    )

    const retryButton = screen.getByRole('button', { name: /Try again with a model|Model ile yeniden dene/i })
    fireEvent.click(retryButton)
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: /Try again with a model|Model ile yeniden dene/i })).not.toBeInTheDocument()
    expect(retryButton).toHaveFocus()
  })

  it('closes the retry model menu when focus moves to another message action', () => {
    render(
      <ChatMessage
        message={{ id: 9, role: 'model', content: 'Another answer' }}
        retryModels={retryModels}
        modelLabels={modelLabels}
        currentModel="gemini-3.1-flash-lite"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Try again with a model|Model ile yeniden dene/i }))
    expect(screen.getByRole('dialog', { name: /Try again with a model|Model ile yeniden dene/i })).toBeInTheDocument()

    fireEvent.focus(screen.getByRole('button', { name: /Copy|Kopyala/i }))

    expect(screen.queryByRole('dialog', { name: /Try again with a model|Model ile yeniden dene/i })).not.toBeInTheDocument()
  })

  it('disables model retry while a response is being generated', () => {
    render(
      <ChatMessage
        message={{ id: 7, role: 'user', content: 'Wait for the active response' }}
        retryModels={retryModels}
        modelLabels={modelLabels}
        currentModel="gemini-3.1-flash-lite"
        retryDisabled
      />
    )

    const retryButton = screen.getByRole('button', { name: /Try again with a model|Model ile yeniden dene/i })
    expect(retryButton).toBeDisabled()
    fireEvent.click(retryButton)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows model retry for an attachment-only user question', () => {
    render(
      <ChatMessage
        message={{
          id: 8,
          role: 'user',
          content: '',
          attachments: [{ name: 'question.png', mimeType: 'image/png', data: 'image-data' }],
        }}
        retryModels={retryModels}
        modelLabels={modelLabels}
        currentModel="gemini-3.1-flash-lite"
      />
    )

    const retryButton = screen.getByRole('button', { name: /Try again with a model|Model ile yeniden dene/i })
    fireEvent.click(retryButton)
    expect(screen.getByRole('dialog', { name: /Try again with a model|Model ile yeniden dene/i })).toBeInTheDocument()
  })

  it('copies fenced code independently from the full message', async () => {
    writeText.mockResolvedValue()
    render(<ChatMessage message={{ id: 2, role: 'model', content: '```js\nconst answer = 42\n```' }} />)

    fireEvent.click(screen.getByRole('button', { name: /Copy code|Kodu kopyala/i }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const answer = 42'))
  })

  it('reports clipboard failures without showing a false success state', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const toastError = vi.spyOn(toast, 'error')
    writeText.mockRejectedValue(new Error('permission denied'))
    render(<ChatMessage message={{ id: 3, role: 'model', content: 'Cannot copy this' }} />)

    fireEvent.click(screen.getByRole('button', { name: /Copy|Kopyala/i }))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(screen.queryByText(/Copied!|Kopyalandı!/i)).not.toBeInTheDocument()
    consoleError.mockRestore()
  })
})
