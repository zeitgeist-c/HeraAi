import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MicPermissionPage } from './micPermission'

describe('microphone permission page', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/mic-permission.html?requestId=request-1')
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    })
  })

  it('requests permission only after the user clicks and reports the matching request id', async () => {
    const stop = vi.fn()
    navigator.mediaDevices.getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] })
    render(<MicPermissionPage />)
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Allow microphone|Mikrofona izin ver/i }))
    await waitFor(() => expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'HERAAI_MIC_PERMISSION_RESULT',
      requestId: 'request-1',
      granted: true,
    }))
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('reports permission denial without closing the explanation page', async () => {
    navigator.mediaDevices.getUserMedia.mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
    render(<MicPermissionPage />)
    fireEvent.click(screen.getByRole('button', { name: /Allow microphone|Mikrofona izin ver/i }))

    await waitFor(() => expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'HERAAI_MIC_PERMISSION_RESULT',
      requestId: 'request-1',
      granted: false,
      errorCode: 'permission_denied',
    }))
    expect(screen.getByText(/denied|reddedildi/i)).toBeInTheDocument()
  })
})
