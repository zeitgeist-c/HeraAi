import { useEffect, useState } from 'react'
import { Timer } from 'lucide-react'

import { formatDurationMs, getMessageDurationMs, isLiveDurationMessage } from '../lib/duration'

function ResponseDuration({ message }) {
  const [now, setNow] = useState(() => Date.now())
  const live = isLiveDurationMessage(message)

  useEffect(() => {
    if (!live) return undefined
    const timerId = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timerId)
  }, [live, message?.id, message?.startedAt, message?.status])

  const durationMs = getMessageDurationMs(message, now)
  if (durationMs == null) return null
  const text = formatDurationMs(durationMs, { live })
  if (!text) return null

  return (
    <span
      data-testid="response-duration"
      title={text}
      className="inline-flex min-h-6 items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground"
    >
      <Timer className="h-3 w-3 shrink-0" />
      <span>{text}</span>
    </span>
  )
}

export default ResponseDuration
