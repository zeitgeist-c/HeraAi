export const COMPARISON_SLOTS = ['a', 'b']

const COMPARISON_TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'error'])

function findVariantDef(defs, slot) {
  return defs.find(def => (
    def
    && (def.variantId === slot || def.slot === slot || def.id === slot)
  )) || {}
}

function normalizeVariantDefs(variants) {
  if (Array.isArray(variants)) return variants
  if (variants && typeof variants === 'object') {
    return Object.entries(variants).map(([slot, def]) => ({
      variantId: slot,
      ...((def && typeof def === 'object') ? def : {}),
    }))
  }
  return []
}

function buildVariantState(slot, def = {}) {
  const variant = {
    variantId: slot,
    status: 'queued',
    content: '',
    sources: [],
    resolvedModel: null,
    revision: 0,
    errorCode: null,
  }
  if (def.model != null) variant.model = def.model
  if (def.provider != null) variant.provider = def.provider
  return variant
}

export function createComparisonJob({ jobId = null, comparisonId = null, variants = [], selection = null, ...rest } = {}) {
  const id = comparisonId ?? jobId
  const defs = normalizeVariantDefs(variants)
  return {
    kind: 'comparison',
    status: 'queued',
    jobId,
    comparisonId: id,
    variants: {
      a: buildVariantState('a', findVariantDef(defs, 'a')),
      b: buildVariantState('b', findVariantDef(defs, 'b')),
    },
    selection: selection ?? { winnerSlot: null, decidedAt: null },
    ...rest,
  }
}

export function isComparisonJob(job) {
  return (
    job?.kind === 'comparison'
    && job?.variants?.a != null
    && job?.variants?.b != null
  )
}

export function allVariantsTerminal(job) {
  if (!isComparisonJob(job)) return false
  return COMPARISON_SLOTS.every(slot => (
    COMPARISON_TERMINAL_STATUSES.has(job.variants[slot]?.status)
  ))
}

export function getSelectableWinners(job) {
  if (!isComparisonJob(job)) return []
  return COMPARISON_SLOTS.filter(slot => job.variants[slot]?.status === 'completed')
}

function slotOfMessage(message) {
  return message?.variantId ?? message?.slot ?? message?.comparisonSlot ?? null
}

export function applyWinnerSelection(messages, comparisonId, winnerSlot) {
  if (!Array.isArray(messages) || !COMPARISON_SLOTS.includes(winnerSlot)) return messages
  const loserSlot = COMPARISON_SLOTS.find(slot => slot !== winnerSlot)
  return messages.map(message => {
    if (message?.comparisonId !== comparisonId) return message
    const slot = slotOfMessage(message)
    if (slot === winnerSlot) {
      return { ...message, comparisonSelected: true, contextExcluded: false }
    }
    if (slot === loserSlot) {
      return { ...message, comparisonSelected: false, contextExcluded: true }
    }
    return message
  })
}
