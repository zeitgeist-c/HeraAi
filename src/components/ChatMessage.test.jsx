import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import toast from 'react-hot-toast'

import '../i18n'
import ChatMessage from './ChatMessage'

const retryModels = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'openrouter/free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'gpt-oss:120b',
  'nemotron-3-ultra',
]

const modelLabels = {
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
  'gemini-3.6-flash': 'Gemini 3.6 Flash',
  'gemini-3.7-flash': 'Gemini 3.7 Flash',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'openrouter/free': 'Free',
  'nvidia/nemotron-3-ultra-550b-a55b:free': 'Nemotron 3 Ultra',
  'gpt-oss:120b': 'GPT-OSS 120B',
  'nemotron-3-ultra': 'Nemotron 3 Ultra',
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

  it('shows the persisted response model and rerenders when only the model changes', () => {
    const { rerender } = render(
      <ChatMessage
        message={{ id: 15, role: 'model', content: 'Model answer', model: 'gemini-3.7-flash' }}
        modelLabels={modelLabels}
      />
    )

    expect(screen.getByTestId('message-model')).toHaveTextContent('Gemini 3.7 Flash')

    rerender(
      <ChatMessage
        message={{ id: 15, role: 'model', content: 'Model answer', model: 'future-model-id' }}
        modelLabels={modelLabels}
      />
    )
    expect(screen.getByTestId('message-model')).toHaveTextContent('future-model-id')
  })

  it('keeps legacy assistant messages without model provenance unlabeled', () => {
    render(<ChatMessage message={{ id: 16, role: 'model', content: 'Legacy answer' }} modelLabels={modelLabels} />)

    expect(screen.queryByTestId('message-model')).not.toBeInTheDocument()
  })

  it('shows the actual routed model for OpenRouter answers', () => {
    render(<ChatMessage
      message={{
        id: 17,
        role: 'model',
        content: 'Routed answer',
        model: 'openrouter/free',
        provider: 'openrouter',
        resolvedModel: 'meta-llama/llama-4-scout:free',
      }}
      modelLabels={{ ...modelLabels, 'openrouter/free': 'Free' }}
    />)

    expect(screen.getByTestId('message-model')).toHaveTextContent(
      'Free → meta-llama/llama-4-scout:free',
    )
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

  it('shows only newly introduced context chips without draft removal buttons', () => {
    render(<ChatMessage message={{
      id: 11,
      role: 'user',
      content: 'Follow up with one new source',
      attachments: [
        { id: 'old-file', name: 'old.pdf', mimeType: 'application/pdf' },
        { id: 'new-file', name: 'new.pdf', mimeType: 'application/pdf' },
      ],
      displayAttachmentIds: ['new-file'],
      webUrls: ['https://example.com/old', 'https://example.com/new'],
      displayWebUrls: ['https://example.com/new'],
    }} />)

    expect(screen.queryByText('old.pdf')).not.toBeInTheDocument()
    expect(screen.getByText('new.pdf')).toBeInTheDocument()
    expect(screen.queryByText('https://example.com/old')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://example.com/new' })).toHaveAttribute(
      'href',
      'https://example.com/new',
    )
    expect(screen.queryByRole('button', { name: /Remove link|Bağlantıyı kaldır/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remove attachment|Eki kaldır/i })).not.toBeInTheDocument()
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

  it('marks duplicate retry labels with their provider', () => {
    render(
      <ChatMessage
        message={{ id: 7, role: 'model', content: 'An answer' }}
        onRetry={vi.fn()}
        retryModels={[
          { key: 'openrouter:nemotron', modelId: 'nvidia/nemotron-3-ultra-550b-a55b:free', provider: 'openrouter', label: 'Nemotron 3 Ultra' },
          { key: 'ollama:nemotron', modelId: 'nemotron-3-ultra', provider: 'ollama', label: 'Nemotron 3 Ultra' },
          { key: 'openrouter:free', modelId: 'openrouter/free', provider: 'openrouter', label: 'Free' },
        ]}
        modelLabels={modelLabels}
        currentModel="gemini-3.1-flash-lite"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Try again with a model|Model ile yeniden dene/i }))
    const retryDialog = screen.getByRole('dialog', { name: /Try again with a model|Model ile yeniden dene/i })
    const nemotronRows = Array.from(retryDialog.querySelectorAll('[data-retry-model]'))
      .filter(button => button.dataset.retryModel.includes('nemotron'))
    expect(nemotronRows).toHaveLength(2)
    expect(nemotronRows[0]).toHaveTextContent('OpenRouter')
    expect(nemotronRows[1]).toHaveTextContent(/Ollama/)
    const freeRow = retryDialog.querySelector('[data-retry-model="openrouter/free"]')
    expect(freeRow).not.toHaveTextContent('OpenRouter')
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

  it('shows read aloud only for eligible assistant messages and forwards the message', () => {
    const message = { id: 12, role: 'model', content: 'Read this answer', status: 'done' }
    const onToggleSpeech = vi.fn()
    const { rerender } = render(
      <ChatMessage
        message={message}
        speechEnabled
        speechStatus="idle"
        onToggleSpeech={onToggleSpeech}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Read aloud|Sesli oku/i }))
    expect(onToggleSpeech).toHaveBeenCalledWith(message)

    rerender(
      <ChatMessage
        message={{ id: 13, role: 'user', content: 'User text' }}
        speechEnabled
        onToggleSpeech={onToggleSpeech}
      />
    )
    expect(screen.queryByRole('button', { name: /Read aloud|Sesli oku/i })).not.toBeInTheDocument()
  })

  it('updates the memoized speech action to loading and playing states', () => {
    const message = { id: 14, role: 'model', content: 'Audio state', status: 'done' }
    const { rerender } = render(
      <ChatMessage message={message} speechEnabled speechStatus="loading" />
    )
    expect(screen.getByRole('button', { name: /Preparing audio|Ses hazırlanıyor/i })).toHaveAttribute('aria-pressed', 'true')

    rerender(<ChatMessage message={message} speechEnabled speechStatus="playing" />)
    expect(screen.getByRole('button', { name: /Stop reading|Okumayı durdur/i })).toHaveAttribute('aria-pressed', 'true')
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
