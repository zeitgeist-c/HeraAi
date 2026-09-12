import toast from 'react-hot-toast'

export const NOTIFY_BASE_DURATION_MS = 2500
export const NOTIFY_PER_CHAR_DURATION_MS = 35
export const NOTIFY_MAX_DURATION_MS = 9000

export function durationForMessage(message) {
  const length = String(message ?? '').length
  return Math.min(
    NOTIFY_MAX_DURATION_MS,
    NOTIFY_BASE_DURATION_MS + length * NOTIFY_PER_CHAR_DURATION_MS,
  )
}

export function notifySuccess(message) {
  return toast.success(message, { duration: durationForMessage(message) })
}

export function notifyError(message) {
  return toast.error(message, { duration: durationForMessage(message) })
}
