import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import ChatMessage from './ChatMessage'

const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled', 'interrupted'])

function ComparisonResponse({
  messages,
  onSelect,
  ...chatMessageProps
}) {
  const { t } = useTranslation()
  const [activeSlot, setActiveSlot] = useState('a')
  const variants = ['a', 'b'].map(slot => (
    messages.find(message => (message.variantId || message.comparisonSlot) === slot)
  )).filter(Boolean)
  const terminal = variants.length === 2 && variants.every(message => TERMINAL_STATUSES.has(message.status))
  const selected = variants.find(message => message.comparisonSelected === true)

  return (
    <section className="rounded-2xl border border-border/70 bg-secondary/20 p-2" data-testid="comparison-response">
      <div className="mb-2 flex gap-1 md:hidden">
        {variants.map(message => {
          const slot = message.variantId || message.comparisonSlot
          return (
            <button
              key={slot}
              type="button"
              onClick={() => setActiveSlot(slot)}
              className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold ${activeSlot === slot ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}`}
            >
              {slot.toUpperCase()}
            </button>
          )
        })}
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {variants.map(message => {
          const slot = message.variantId || message.comparisonSlot
          const canSelect = terminal && message.status === 'done' && !selected
          return (
            <article
              key={message.id}
              className={`${activeSlot === slot ? 'block' : 'hidden'} min-w-0 rounded-xl border bg-background p-2 md:block ${message.comparisonSelected ? 'border-primary ring-1 ring-primary/30' : 'border-border/60'}`}
            >
              <div className="mb-1 text-[11px] font-bold text-muted-foreground">{slot.toUpperCase()}</div>
              <ChatMessage message={message} {...chatMessageProps} />
              {canSelect && (
                <button
                  type="button"
                  onClick={() => onSelect?.(message.comparisonId, slot)}
                  className="mt-2 w-full rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:brightness-105"
                >
                  {t('chat.comparison.continue_with_this')}
                </button>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}

export default ComparisonResponse
