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
  'nvidia/nemotron-3-super-120b-a12b:free',
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
  'nvidia/nemotron-3-super-120b-a12b:free': 'Nemotron 3 Super',
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

    const copyButton = screen.getByRole('button', { name: /Copy|Kopyala/i })
    fireEvent.click(copyButton)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Copy this response'))
    expect(copyButton.querySelector('svg.lucide-check')).toBeInTheDocument()
    expect(copyButton.querySelector('svg.lucide-copy')).not.toBeInTheDocument()
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

  it('keeps an internal prompt hidden while preserving its attachment', () => {
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
    expect(screen.queryByRole('button', { name: /Regenerate response|Retry|Yeniden dene/i })).not.toBeInTheDocument()
    expect(onRetry).not.toHaveBeenCalled()
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

  it('shows no model retry on user questions', () => {
    const message = { id: 5, role: 'user', content: 'Compare this answer' }
    render(
      <ChatMessage
        message={message}
        onRetry={vi.fn()}
        retryModels={retryModels}
        modelLabels={modelLabels}
        currentModel="gemini-3.1-flash-lite"
      />
    )

    expect(screen.queryByRole('button', { name: /Try again with a model|Model ile yeniden dene/i }))
      .not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: /Try again with a model|Model ile yeniden dene/i }))
      .not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Copy|Kopyala/i })).toBeInTheDocument()
  })

  it('lists every retry model in the assistant retry menu', () => {
    const onRetry = vi.fn()
    const message = { id: 31, role: 'model', content: 'Compare this answer', status: 'done' }
    render(
      <ChatMessage
        message={message}
        onRetry={onRetry}
        retryModels={retryModels}
        modelLabels={modelLabels}
        currentModel="gemini-3.1-flash-lite"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Try again with a model|Model ile yeniden dene/i }))

    const retryDialog = screen.getByRole('dialog', { name: /Try again with a model|Model ile yeniden dene/i })
    expect(Array.from(retryDialog.querySelectorAll('[data-retry-model]')).map(button => button.dataset.retryModel)).toEqual(retryModels)

    fireEvent.click(screen.getByRole('button', { name: 'Gemini 3.5 Flash Lite' }))

    expect(onRetry).toHaveBeenCalledWith(message, 'gemini-3.5-flash-lite')
    expect(screen.queryByRole('dialog', { name: /Try again with a model|Model ile yeniden dene/i })).not.toBeInTheDocument()
  })

  it('shows the provider on every retry row', () => {
    render(
      <ChatMessage
        message={{ id: 7, role: 'model', content: 'An answer' }}
        onRetry={vi.fn()}
        retryModels={[
          { key: 'openrouter:nemotron', modelId: 'nvidia/nemotron-3-super-120b-a12b:free', provider: 'openrouter', label: 'Nemotron 3 Super' },
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
    expect(freeRow).toHaveTextContent('OpenRouter')
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
        message={{ id: 7, role: 'model', content: 'Wait for the active response', status: 'streaming' }}
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

  it('shows the automatic routing chain from router to resolved model', () => {
    render(<ChatMessage
      message={{
        id: 21,
        role: 'model',
        content: 'Auto answer',
        model: 'gemini-3.1-flash-lite',
        selectionMode: 'auto',
        routerModel: 'gemini-3.5-flash-lite',
        resolvedModel: 'gemini-3.5-flash-lite',
      }}
      modelLabels={modelLabels}
    />)

    expect(screen.getByTestId('auto-chain')).toHaveTextContent('Auto → Gemini 3.5 Flash Lite')
  })

  it('offers the winning answer control for selectable comparison variants', () => {
    const onSelectWinner = vi.fn()
    const message = {
      id: 22,
      role: 'model',
      content: 'Variant A',
      status: 'done',
      comparisonId: 'comparison-1',
      variantId: 'a',
      selectable: true,
      model: 'gemini-3.6-flash',
    }
    render(<ChatMessage message={message} modelLabels={modelLabels} onSelectWinner={onSelectWinner} />)

    fireEvent.click(screen.getByRole('button', { name: /Continue with this answer|Bu yanıtla devam et/i }))

    expect(onSelectWinner).toHaveBeenCalledWith(message)
  })

  it('dims context-excluded comparison losers', () => {
    render(<ChatMessage
      message={{
        id: 23,
        role: 'model',
        content: 'Loser answer',
        status: 'done',
        comparisonId: 'comparison-1',
        variantId: 'b',
        contextExcluded: true,
      }}
      modelLabels={modelLabels}
      onSelectWinner={vi.fn()}
    />)

    expect(screen.getByTestId('assistant-message')).toHaveAttribute('data-context-excluded', 'true')
  })

  it('renders response actions as icon-only buttons with intact accessible names', () => {
    const message = { id: 30, role: 'model', content: 'Compact actions', status: 'done' }
    render(
      <ChatMessage
        message={message}
        speechEnabled
        speechStatus="idle"
        onToggleSpeech={vi.fn()}
        onRetry={vi.fn()}
        retryModels={retryModels}
        modelLabels={modelLabels}
        currentModel="gemini-3.1-flash-lite"
      />,
    )

    const copyButton = screen.getByRole('button', { name: /Copy|Kopyala/i })
    const speechButton = screen.getByRole('button', { name: /Read aloud|Sesli oku/i })
    const retryButton = screen.getByRole('button', { name: /Try again with a model|Model ile yeniden dene/i })
    for (const button of [copyButton, speechButton, retryButton]) {
      expect(button.className).toMatch(/hera-icon-button/)
      expect(button.textContent).toBe('')
    }
    fireEvent.click(copyButton)
    fireEvent.click(speechButton)
    fireEvent.click(retryButton)
    expect(screen.getByRole('dialog', { name: /Try again with a model|Model ile yeniden dene/i })).toBeInTheDocument()
  })

  it('groups assistant actions and badges in a single pill bar', () => {
    const message = { id: 35, role: 'model', content: 'Pill actions', status: 'done', model: 'gemini-3.6-flash' }
    render(
      <ChatMessage
        message={message}
        speechEnabled
        speechStatus="idle"
        onToggleSpeech={vi.fn()}
        onRetry={vi.fn()}
        retryModels={retryModels}
        modelLabels={modelLabels}
        currentModel="gemini-3.1-flash-lite"
      />,
    )

    const pill = screen.getByTestId('response-action-pill')
    expect(pill.className).toMatch(/rounded-full/)
    const copyButton = screen.getByRole('button', { name: /Copy|Kopyala/i })
    const speechButton = screen.getByRole('button', { name: /Read aloud|Sesli oku/i })
    const retryButton = screen.getByRole('button', { name: /Try again with a model|Model ile yeniden dene/i })
    expect(pill.contains(copyButton)).toBe(true)
    expect(pill.contains(speechButton)).toBe(true)
    expect(pill.contains(retryButton)).toBe(true)
    expect(pill.contains(screen.getByTestId('message-model'))).toBe(true)
    expect(screen.queryByTestId('response-action-rail')).not.toBeInTheDocument()
  })

  it('shows a frozen duration badge for completed responses with timing data', () => {
    render(<ChatMessage
      message={{
        id: 31,
        role: 'model',
        content: 'Timed answer',
        status: 'done',
        model: 'gemini-3.6-flash',
        startedAt: 1000,
        completedAt: 6400,
      }}
      modelLabels={modelLabels}
    />)

    expect(screen.getByTestId('response-duration')).toHaveTextContent('5.4 s')
    const modelBadge = screen.getByTestId('message-model')
    expect(modelBadge.className).toMatch(/border-primary/)
    expect(modelBadge).toHaveTextContent('Gemini 3.6 Flash')
  })

  it('hides the duration badge for legacy and failed responses', () => {
    const { rerender } = render(<ChatMessage
      message={{ id: 32, role: 'model', content: 'Legacy answer', status: 'done', model: 'gemini-3.6-flash' }}
      modelLabels={modelLabels}
    />)
    expect(screen.queryByTestId('response-duration')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-model')).toBeInTheDocument()

    rerender(<ChatMessage
      message={{
        id: 33, role: 'model', content: 'Failed answer', status: 'error',
        startedAt: 1000, completedAt: 9000, errorCode: 'timeout',
      }}
      modelLabels={modelLabels}
    />)
    expect(screen.queryByTestId('response-duration')).not.toBeInTheDocument()
  })

  it('conceals only retry while keeping duration, model badge, copy and speech', () => {
    render(<ChatMessage
      message={{
        id: 36, role: 'model', content: 'Hidden meta', status: 'done',
        model: 'gemini-3.6-flash', startedAt: 1000, completedAt: 6400,
      }}
      modelLabels={modelLabels}
      speechEnabled
      speechStatus="idle"
      onToggleSpeech={vi.fn()}
      onRetry={vi.fn()}
      retryModels={retryModels}
      currentModel="gemini-3.1-flash-lite"
      concealMeta
    />)

    expect(screen.getByRole('button', { name: /Copy|Kopyala/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Read aloud|Sesli oku/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Try again with a model|Model ile yeniden dene/i })).not.toBeInTheDocument()
    expect(screen.getByTestId('response-duration')).toBeInTheDocument()
    expect(screen.getByTestId('message-model')).toBeInTheDocument()
  })

  it('shows a live duration badge while a response streams', () => {
    render(<ChatMessage
      message={{
        id: 34, role: 'model', content: 'Streaming answer', status: 'streaming',
        startedAt: Date.now() - 2500,
      }}
      modelLabels={modelLabels}
    />)

    expect(screen.getByTestId('response-duration')).toBeInTheDocument()
  })
})

describe('ChatMessage malformed content', () => {
  it('renders a message whose content is not a string without crashing the panel', () => {
    render(<ChatMessage message={{ id: 'malformed-1', role: 'model', content: { unexpected: true } }} />)

    expect(screen.getByTestId('assistant-content')).toBeInTheDocument()
    expect(screen.getByTestId('assistant-content').textContent).toBe('')
  })
})
