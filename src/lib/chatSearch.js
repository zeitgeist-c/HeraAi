import { getMessageDisplayContent } from './messageDisplay'

export function normalizeSearchText(value) {
  return String(value || '').trim().toLocaleLowerCase('tr')
}

export function findChatMatchIds(messages, query) {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return []
  const matches = []
  for (const message of messages || []) {
    if (!message || (message.role !== 'user' && message.role !== 'model')) continue
    if (!message.id) continue
    const text = normalizeSearchText(getMessageDisplayContent(message))
    if (text && text.includes(normalizedQuery)) matches.push(message.id)
  }
  return matches
}
