/**
 * Updates usage stats atomically for one or more event types.
 * @param {string|string[]} types - One or more of: 'message', 'voice', 'screenshot', 'search'
 */
export const updateStats = async (types) => {
  if (!chrome?.storage?.local) return

  const typeList = Array.isArray(types) ? types : [types]
  const today = new Date().toDateString()

  return new Promise((resolve) => {
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

      stats.lastActive = Date.now()

      if (typeList.includes('message')) {
        stats.totalMessages += 1
        if (!stats.messagesByDate[today]) {
          stats.messagesByDate[today] = 0
        }
        stats.messagesByDate[today] += 1
      }

      if (typeList.includes('voice')) stats.voiceInputs = (stats.voiceInputs || 0) + 1
      if (typeList.includes('screenshot')) stats.screenshots = (stats.screenshots || 0) + 1
      if (typeList.includes('search')) stats.searches = (stats.searches || 0) + 1

      chrome.storage.local.set({ stats }, resolve)
    })
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
