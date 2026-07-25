import { beforeEach, describe, expect, it, vi } from 'vitest';

const createChromeMock = ({ withSidePanel }) => {
  const actionListener = vi.fn();
  const contextMenuListener = vi.fn();
  const setPanelBehavior = vi.fn().mockResolvedValue(undefined);
  const openPanel = vi.fn().mockResolvedValue(undefined);
  const createTab = vi.fn().mockResolvedValue(undefined);

  return {
    chrome: {
      action: {
        onClicked: { addListener: actionListener },
      },
      contextMenus: {
        create: vi.fn(),
        onClicked: { addListener: contextMenuListener },
      },
      runtime: {
        getURL: vi.fn(path => `chrome-extension://test/${path}`),
        onInstalled: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() },
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      storage: {
        local: {
          set: vi.fn((_value, callback) => callback()),
        },
      },
      tabs: {
        create: createTab,
      },
      ...(withSidePanel
        ? { sidePanel: { setPanelBehavior, open: openPanel } }
        : {}),
    },
    actionListener,
    contextMenuListener,
    createTab,
    openPanel,
    setPanelBehavior,
  };
};

describe('background service worker browser compatibility', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('uses the native side panel when the API is available', async () => {
    const mock = createChromeMock({ withSidePanel: true });
    global.chrome = mock.chrome;

    await import('./service_worker.js');

    expect(mock.setPanelBehavior).toHaveBeenCalledWith({
      openPanelOnActionClick: true,
    });
    expect(mock.actionListener).not.toHaveBeenCalled();
  });

  it('opens Hera in a tab when the side panel API is unavailable', async () => {
    const mock = createChromeMock({ withSidePanel: false });
    global.chrome = mock.chrome;

    await import('./service_worker.js');
    const actionHandler = mock.actionListener.mock.calls[0][0];
    await actionHandler();

    expect(mock.createTab).toHaveBeenCalledWith({
      url: 'chrome-extension://test/index.html',
    });
  });

  it('uses a tab for context-menu actions without side panel support', async () => {
    const mock = createChromeMock({ withSidePanel: false });
    global.chrome = mock.chrome;

    await import('./service_worker.js');
    const contextHandler = mock.contextMenuListener.mock.calls[0][0];
    contextHandler({ menuItemId: 'heraai-send', selectionText: 'hello' }, {});

    expect(mock.chrome.storage.local.set).toHaveBeenCalledWith(
      { selectedText: 'hello' },
      expect.any(Function),
    );
    expect(mock.createTab).toHaveBeenCalledWith({
      url: 'chrome-extension://test/index.html',
    });
  });
});
