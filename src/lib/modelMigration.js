import { isRetiredModelId } from './models.js'

export function hasRetiredModelProvenance(value) {
  return Boolean(value) && (
    isRetiredModelId(value.model)
    || isRetiredModelId(value.resolvedModel)
  )
}

export function stripRetiredModelProvenance(value) {
  if (!value || !hasRetiredModelProvenance(value)) return { value, changed: false }

  const sanitized = { ...value }
  if (isRetiredModelId(sanitized.model)) delete sanitized.model
  if (isRetiredModelId(sanitized.resolvedModel)) delete sanitized.resolvedModel
  return { value: sanitized, changed: true }
}

export function sanitizeRetiredModelMessages(messages) {
  let changed = false
  const sanitized = (messages || []).map(message => {
    const result = stripRetiredModelProvenance(message)
    changed = changed || result.changed
    return result.value
  })
  return { messages: sanitized, changed }
}

export function sanitizeRetiredModelSessions(sessions) {
  let changed = false
  const sanitized = (sessions || []).map(session => {
    if (!session) return session
    const result = sanitizeRetiredModelMessages(session.messages)
    if (!result.changed) return session
    changed = true
    return { ...session, messages: result.messages }
  })
  return { sessions: sanitized, changed }
}
