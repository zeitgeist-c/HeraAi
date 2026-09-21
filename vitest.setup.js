import 'fake-indexeddb/auto'
import '@testing-library/jest-dom'
import { vi } from 'vitest'
import { configure } from '@testing-library/react'

// Yüklü/soğuk koşularda 1 sn'lik varsayılan bekleme flaky kırılma üretiyordu (Bulgu #5).
configure({ asyncUtilTimeout: 5000 })

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
    getAll: vi.fn(),
    getCurrent: vi.fn(),
    create: vi.fn(),
    onRemoved: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
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
