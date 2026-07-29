export const exportSessions = (sessions) => {
  const exportData = {
    version: '1.1',
    exportedAt: new Date().toISOString(),
    sessions: sessions.map(s => ({
      id: s.id,
      title: s.title,
      isTitleCustom: s.isTitleCustom === true,
      isStarred: s.isStarred === true,
      updatedAt: s.updatedAt,
      messages: s.messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(typeof m.displayContent === 'string' ? { displayContent: m.displayContent } : {}),
        attachments: m.attachments ? m.attachments.map(a => ({
          name: a.name,
          mimeType: a.mimeType,
          data: a.data
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
          messages: s.messages || []
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
