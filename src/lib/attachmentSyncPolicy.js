/**
 * Bulut eşitlemesinde eklerin yalnızca güvenli metadatasını bırakır.
 * İkili içerik her zaman yerel IndexedDB'de kalır.
 */
export async function normalizeSessionAttachmentMetadata(session, hasLocalAttachment) {
  const lookup = typeof hasLocalAttachment === 'function'
    ? hasLocalAttachment
    : async () => false
  const availability = new Map()

  for (const message of session?.messages || []) {
    for (const attachment of message?.attachments || []) {
      if (!attachment?.id || availability.has(attachment.id)) continue
      availability.set(attachment.id, await lookup(attachment.id) ? 'local_only' : 'missing')
    }
  }

  return {
    ...session,
    messages: (session?.messages || []).map(message => ({
      ...message,
      attachments: (message?.attachments || []).map(attachment => ({
        id: attachment?.id,
        name: attachment?.name,
        mimeType: attachment?.mimeType,
        size: attachment?.size,
        kind: attachment?.kind,
        availability: availability.get(attachment?.id) || 'missing',
      })),
    })),
  }
}

export async function normalizeSessionsAttachmentMetadata(sessions, hasLocalAttachment) {
  return Promise.all((sessions || []).map(session => (
    normalizeSessionAttachmentMetadata(session, hasLocalAttachment)
  )))
}
