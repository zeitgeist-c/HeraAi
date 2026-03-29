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
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  },
  tabs: {
    query: vi.fn(),
    captureVisibleTab: vi.fn()
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
