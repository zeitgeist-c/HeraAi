import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import toast from 'react-hot-toast'

import '../i18n'
import ChatMessage from './ChatMessage'

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
