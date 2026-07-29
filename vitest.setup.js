import '@testing-library/jest-dom'
import { vi } from 'vitest'

global.chrome = {
  storage: {
    local: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn()
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },
  runtime: {
    id: 'test-extension-id',
    getURL: vi.fn(path => `chrome-extension://test/${path}`),
    getContexts: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn((...args) => {
      const callback = args.findLast(arg => typeof arg === 'function')
      if (callback) callback(undefined)
      return Promise.resolve(undefined)
    }),
    lastError: undefined,
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },
  offscreen: {
    Reason: {
      WORKERS: 'WORKERS'
    },
    hasDocument: vi.fn().mockResolvedValue(false),
    createDocument: vi.fn().mockResolvedValue(undefined),
    closeDocument: vi.fn().mockResolvedValue(undefined)
  },
  tabs: {
    query: vi.fn(),
    captureVisibleTab: vi.fn()
  },
  windows: {
    getAll: vi.fn()
  },
  scripting: {
    executeScript: vi.fn()
  },
  contextMenus: {
    create: vi.fn(),
    onClicked: {
      addListener: vi.fn()
    }
  },
  sidePanel: {
    setPanelBehavior: vi.fn()
  }
}
