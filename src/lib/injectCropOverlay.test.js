import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cancelCropOverlay, injectCropOverlay } from './injectCropOverlay.js'

describe('crop overlay lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.chrome.runtime.sendMessage.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cancelCropOverlay()
    vi.useRealTimers()
  })

  it('cancels the active overlay externally and removes all global listeners', () => {
    const removeListener = vi.spyOn(window, 'removeEventListener')

    expect(injectCropOverlay({ confirm: 'Confirm', cancel: 'Cancel' }, '#7c5cff', 'crop-1'))
      .toEqual({ active: true, existing: false, requestId: 'crop-1' })
    expect(document.querySelectorAll('#heraai-crop-overlay')).toHaveLength(1)

    expect(cancelCropOverlay('crop-1')).toEqual({
      active: false,
      cancelled: true,
      requestId: 'crop-1',
    })
    expect(document.getElementById('heraai-crop-overlay')).not.toBeInTheDocument()
    expect(removeListener).toHaveBeenCalledWith('mousemove', expect.any(Function))
    expect(removeListener).toHaveBeenCalledWith('mouseup', expect.any(Function))
    expect(removeListener).toHaveBeenCalledWith('keydown', expect.any(Function))
    expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'HERAAI_CROP_CANCELLED',
      requestId: 'crop-1',
    })

    removeListener.mockRestore()
  })

  it('safely replaces a stale overlay instead of stacking or adopting its request', () => {
    injectCropOverlay({}, '#7c5cff', 'crop-original')

    expect(injectCropOverlay({}, '#ff0000', 'crop-second')).toEqual({
      active: true,
      existing: false,
      requestId: 'crop-second',
    })
    expect(document.querySelectorAll('#heraai-crop-overlay')).toHaveLength(1)
    expect(document.getElementById('heraai-crop-overlay'))
      .toHaveAttribute('data-heraai-crop-request-id', 'crop-second')
    expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'HERAAI_CROP_CANCELLED',
      requestId: 'crop-original',
    })
  })

  it('completes a valid selection once without also reporting cancellation', () => {
    vi.useFakeTimers()
    injectCropOverlay({ confirm: 'Confirm', cancel: 'Cancel' }, '#7c5cff', 'crop-done')
    const overlay = document.getElementById('heraai-crop-overlay')

    overlay.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    }))
    window.dispatchEvent(new MouseEvent('mousemove', {
      clientX: 80,
      clientY: 70,
    }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    const confirmButton = Array.from(overlay.querySelectorAll('button'))
      .find(button => button.textContent === 'Confirm')
    confirmButton.click()
    confirmButton.click()
    vi.advanceTimersByTime(50)

    expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'HERAAI_CROP_DONE',
      requestId: 'crop-done',
      coords: expect.objectContaining({ x: 10, y: 10, width: 70, height: 60 }),
    }))
    expect(global.chrome.runtime.sendMessage.mock.calls
      .filter(([message]) => message.type === 'HERAAI_CROP_DONE')).toHaveLength(1)
    expect(global.chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'HERAAI_CROP_CANCELLED' }),
    )
    expect(document.getElementById('heraai-crop-overlay')).not.toBeInTheDocument()
  })

  it('supports Escape and prevents a pending confirm from completing after cancellation', () => {
    vi.useFakeTimers()
    injectCropOverlay({ confirm: 'Confirm', cancel: 'Cancel' }, '#7c5cff', 'crop-race')
    const overlay = document.getElementById('heraai-crop-overlay')

    overlay.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    }))
    window.dispatchEvent(new MouseEvent('mousemove', {
      clientX: 80,
      clientY: 70,
    }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    const confirmButton = Array.from(overlay.querySelectorAll('button'))
      .find(button => button.textContent === 'Confirm')
    confirmButton.click()
    confirmButton.click()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    vi.advanceTimersByTime(100)

    expect(document.getElementById('heraai-crop-overlay')).not.toBeInTheDocument()
    expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'HERAAI_CROP_CANCELLED',
      requestId: 'crop-race',
    })
    expect(global.chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'HERAAI_CROP_DONE' }),
    )
  })
})
