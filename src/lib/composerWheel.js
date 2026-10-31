/**
 * Decides which scroller the wheel event in the composer goes to.
 *
 * Why a separate module: it cannot be verified through `defaultPrevented` - React binds the
 * wheel listener passively, so `preventDefault()` leaves no observable trace. Once the decision
 * is extracted into a pure function, both the production path and the tests use the same logic.
 *
 * Rule: if the inner scroller (the composer field) can scroll on its own it consumes the wheel;
 * when it reaches its top or end the rest goes on to the chat (chaining).
 */

export const WHEEL_TARGET_CHAT = 'chat'
export const WHEEL_TARGET_INNER = 'inner'

export function resolveWheelTarget(deltaY, innerScroller) {
  if (!innerScroller || !deltaY) return WHEEL_TARGET_CHAT

  const scrollHeight = Number(innerScroller.scrollHeight) || 0
  const clientHeight = Number(innerScroller.clientHeight) || 0
  const scrollTop = Number(innerScroller.scrollTop) || 0

  // Can the inner scroller really scroll? If it cannot, the wheel goes to the
  // chat.
  if (scrollHeight <= clientHeight + 1) return WHEEL_TARGET_CHAT

  const atTop = scrollTop <= 0
  const atBottom = scrollTop + clientHeight >= scrollHeight - 1

  if (deltaY < 0 && atTop) return WHEEL_TARGET_CHAT
  if (deltaY > 0 && atBottom) return WHEEL_TARGET_CHAT
  return WHEEL_TARGET_INNER
}
