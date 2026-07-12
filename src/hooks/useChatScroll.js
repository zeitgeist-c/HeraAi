import { useCallback, useLayoutEffect, useRef, useState } from 'react'

const BOTTOM_THRESHOLD_PX = 72

function isNearBottom(element) {
  if (!element) return true
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD_PX
}

export function useChatScroll(messages) {
  const scrollRef = useRef(null)
  const followOutputRef = useRef(true)
  const forceFollowRef = useRef(false)
  const [showScrollDown, setShowScrollDown] = useState(false)

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
    followOutputRef.current = true
    forceFollowRef.current = false
    setShowScrollDown(false)
  }, [])

  const followNextMessage = useCallback(() => {
    forceFollowRef.current = true
    followOutputRef.current = true
  }, [])

  const handleScroll = useCallback(event => {
    const nearBottom = isNearBottom(event.currentTarget)
    followOutputRef.current = nearBottom
    setShowScrollDown(!nearBottom)
  }, [])

  useLayoutEffect(() => {
    if (forceFollowRef.current || followOutputRef.current) {
      const element = scrollRef.current
      if (element) {
        element.scrollTop = element.scrollHeight
      }
      forceFollowRef.current = false
    }
  }, [messages])

  return {
    scrollRef,
    showScrollDown,
    scrollToBottom,
    followNextMessage,
    handleScroll,
  }
}
