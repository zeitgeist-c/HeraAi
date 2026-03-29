export const updateStats = async (type) => {
  if (!chrome?.storage?.local) return

  const today = new Date().toDateString()
  
  chrome.storage.local.get(['stats'], (result) => {
    const stats = result.stats || {
      totalMessages: 0,
      totalSessions: 0,
      messagesByDate: {},
      lastActive: null,
      voiceInputs: 0,
      screenshots: 0,
      searches: 0
    }

    stats.totalMessages += 1
    stats.lastActive = Date.now()

    if (!stats.messagesByDate[today]) {
      stats.messagesByDate[today] = 0
    }
    stats.messagesByDate[today] += 1

    if (type === 'voice') stats.voiceInputs = (stats.voiceInputs || 0) + 1
    if (type === 'screenshot') stats.screenshots = (stats.screenshots || 0) + 1
    if (type === 'search') stats.searches = (stats.searches || 0) + 1

    chrome.storage.local.set({ stats })
  })
}

export const getStats = () => {
  return new Promise((resolve) => {
    if (!chrome?.storage?.local) {
      resolve(null)
      return
    }
    
    chrome.storage.local.get(['stats'], (result) => {
      resolve(result.stats || null)
    })
  })
}
