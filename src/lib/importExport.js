import { getProviderForModel } from './models'

export const exportSessions = (sessions) => {
  const exportData = {
    version: '2.2',
    exportedAt: new Date().toISOString(),
    sessions: sessions.map(s => ({
      id: s.id,
      title: s.title,
      isTitleCustom: s.isTitleCustom === true,
      isStarred: s.isStarred === true,
      updatedAt: s.updatedAt,
      activeAttachmentIds: s.activeAttachmentIds || [],
      activeWebUrls: s.activeWebUrls || [],
      messages: s.messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(typeof m.displayContent === 'string' ? { displayContent: m.displayContent } : {}),
        ...(typeof m.model === 'string' && m.model ? { model: m.model } : {}),
        ...(typeof m.provider === 'string' && m.provider ? { provider: m.provider } : {}),
        ...(typeof m.resolvedModel === 'string' && m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
        ...(typeof m.mode === 'string' ? { mode: m.mode } : {}),
        ...(Array.isArray(m.webUrls) ? { webUrls: m.webUrls } : {}),
        ...(Array.isArray(m.displayWebUrls) ? { displayWebUrls: m.displayWebUrls } : {}),
        ...(Array.isArray(m.displayAttachmentIds) ? { displayAttachmentIds: m.displayAttachmentIds } : {}),
        attachments: m.attachments ? m.attachments.map(a => ({
          id: a.id,
          name: a.name,
          mimeType: a.mimeType,
          size: a.size || 0,
          kind: a.kind,
          availability: 'omitted'
        })) : []
      }))
    }))
  }

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `heraai-export-${new Date().toISOString().split('T')[0]}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export const importSessions = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result)
        
        if (!data.sessions || !Array.isArray(data.sessions)) {
          reject(new Error('Invalid file format'))
          return
        }

        const sessions = data.sessions.map(s => ({
          id: s.id || Date.now().toString() + Math.random().toString(36).substr(2, 9),
          title: s.title || 'Imported Chat',
          isTitleCustom: s.isTitleCustom === true,
          isStarred: s.isStarred === true,
          updatedAt: s.updatedAt || Date.now(),
          activeAttachmentIds: Array.isArray(s.activeAttachmentIds) ? s.activeAttachmentIds : [],
          activeWebUrls: Array.isArray(s.activeWebUrls) ? s.activeWebUrls : [],
          messages: (s.messages || []).map(message => ({
            ...message,
            ...(message.model && !message.provider
              ? { provider: getProviderForModel(message.model) }
              : {}),
            attachments: (message.attachments || []).map(attachment => (
              attachment?.data
                ? attachment
                : { ...attachment, availability: attachment.availability || 'missing' }
            )),
          })),
        }))

        resolve(sessions)
      } catch (_err) {
        reject(new Error('Failed to parse file'))
      }
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file)
  })
}
