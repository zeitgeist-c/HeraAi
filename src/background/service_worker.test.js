import { beforeEach, describe, expect, it, vi } from 'vitest';

const keyManagerMocks = vi.hoisted(() => ({
  resolveKeysForRequest: vi.fn(),
  updateKeyMetadata: vi.fn(),
}));

vi.mock('../lib/keyManager.js', () => keyManagerMocks);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

const createChromeMock = ({
  withSidePanel = true,
  initialStorage = {},
  offscreenOpen = false,
  withGetContexts = true,
} = {}) => {
  const storage = clone(initialStorage);
  const events = [];
  let documentOpen = offscreenOpen;
  let activeOffscreenJobId = offscreenOpen
    ? (initialStorage.activeGeneration?.jobId || null)
    : null;
  let terminalForwardingJobId = null;

  const actionListener = vi.fn();
  const contextMenuListener = vi.fn();
  const runtimeMessageListener = vi.fn();
  const setPanelBehavior = vi.fn().mockResolvedValue(undefined);
  const openPanel = vi.fn().mockResolvedValue(undefined);
  const createTab = vi.fn().mockResolvedValue(undefined);

  const storageGet = vi.fn((keys, callback) => {
    const requestedKeys = Array.isArray(keys) ? keys : Object.keys(keys || {});
    const result = {};
    requestedKeys.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(storage, key)) {
        result[key] = clone(storage[key]);
      }
    });
    callback?.(result);
  });
  const storageSet = vi.fn((value, callback) => {
    const status = value.activeGeneration?.status || Object.keys(value).join(',');
    events.push(`storage:set:${status}`);
    Object.assign(storage, clone(value));
    callback?.();
  });
  const storageRemove = vi.fn((keys, callback) => {
    const requestedKeys = Array.isArray(keys) ? keys : [keys];
    events.push(`storage:remove:${requestedKeys.join(',')}`);
    requestedKeys.forEach(key => delete storage[key]);
    callback?.();
  });
  const setAccessLevel = vi.fn().mockResolvedValue(undefined);

  const runtimeSendMessage = vi.fn((message, callback) => {
    events.push(`runtime:${message.type}`);
    let response = { ok: true };
    if (message.type === 'OFFSCREEN_PROBE' && message.target === 'offscreen') {
      response = documentOpen
        ? {
            ok: true,
            ready: true,
            activeJobIds: activeOffscreenJobId ? [activeOffscreenJobId] : [],
            terminalForwardingJobIds: terminalForwardingJobId ? [terminalForwardingJobId] : [],
          }
        : undefined;
    } else if (message.type === 'HERA_GENERATION_START' && message.target === 'offscreen') {
      if (!documentOpen) {
        response = undefined;
      } else if (activeOffscreenJobId && activeOffscreenJobId !== message.jobId) {
        response = {
          ok: false,
          accepted: false,
          errorCode: 'already_running',
          activeJobId: activeOffscreenJobId,
        };
      } else {
        activeOffscreenJobId = message.jobId;
        response = { ok: true, accepted: true, jobId: message.jobId };
      }
    }
    callback?.(response);
    return Promise.resolve(response);
  });

  const getContexts = vi.fn((_query, callback) => {
    const contexts = documentOpen
      ? [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: 'chrome-extension://test/offscreen.html' }]
      : [];
    callback?.(contexts);
    return Promise.resolve(contexts);
  });
  const createDocument = vi.fn((options, callback) => {
    events.push('offscreen:create');
    documentOpen = true;
    callback?.();
    return Promise.resolve();
  });
  const closeDocument = vi.fn((callback) => {
    events.push('offscreen:close');
    documentOpen = false;
    activeOffscreenJobId = null;
    terminalForwardingJobId = null;
    callback?.();
    return Promise.resolve();
  });

  const runtime = {
    getURL: vi.fn(path => `chrome-extension://test/${path}`),
    onInstalled: { addListener: vi.fn() },
    onMessage: { addListener: runtimeMessageListener },
    sendMessage: runtimeSendMessage,
    lastError: null,
    ...(withGetContexts ? { getContexts } : {}),
  };

  const chromeMock = {
    action: {
      onClicked: { addListener: actionListener },
    },
    contextMenus: {
      create: vi.fn(),
      onClicked: { addListener: contextMenuListener },
    },
    runtime,
    storage: {
      local: {
        get: storageGet,
        set: storageSet,
        remove: storageRemove,
        setAccessLevel,
      },
    },
    tabs: {
      create: createTab,
    },
    offscreen: {
      createDocument,
      closeDocument,
      hasDocument: vi.fn(() => Promise.resolve(documentOpen)),
    },
    ...(withSidePanel
      ? { sidePanel: { setPanelBehavior, open: openPanel } }
      : {}),
  };

  return {
    chrome: chromeMock,
    storage,
    events,
    actionListener,
    contextMenuListener,
    runtimeMessageListener,
    createTab,
    openPanel,
    setPanelBehavior,
    getContexts,
    createDocument,
    closeDocument,
    storageGet,
    storageSet,
    storageRemove,
    setAccessLevel,
    runtimeSendMessage,
    isOffscreenOpen: () => documentOpen,
    setOffscreenJobs: ({ active = null, terminalForwarding = null } = {}) => {
      activeOffscreenJobId = active;
      terminalForwardingJobId = terminalForwarding;
    },
  };
};

async function loadWorker(mock) {
  global.chrome = mock.chrome;
  await import('./service_worker.js');
  return mock.runtimeMessageListener.mock.calls[0][0];
}

function dispatch(listener, message, sender = {}) {
  return new Promise((resolve) => {
    const keepChannelOpen = listener(message, sender, resolve);
    if (keepChannelOpen !== true) resolve(undefined);
  });
}

function queuedGeneration(overrides = {}) {
  return {
    jobId: 'job-1',
    requestId: 'request-1',
    sessionId: 'session-1',
    userMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
    startedAt: 100,
    mode: 'chat',
    model: 'gemini-3.6-flash',
    language: 'tr',
    status: 'queued',
    revision: 0,
    content: '',
    sources: [],
    errorCode: null,
    cancelReason: null,
    ...overrides,
  };
}

function startMessage(overrides = {}) {
  return {
    type: 'HERA_GENERATION_START',
    jobId: 'job-1',
    requestId: 'request-1',
    sessionId: 'session-1',
    userMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
    startedAt: 100,
    mode: 'chat',
    model: 'gemini-3.6-flash',
    language: 'tr',
    sessionTitle: 'Session from START',
    systemInstruction: 'Be concise',
    requestMessages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

function runtimeMessages(mock, type) {
  return mock.runtimeSendMessage.mock.calls
    .map(([message]) => message)
    .filter(message => !type || message.type === type);
}

describe('background service worker browser compatibility', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    keyManagerMocks.resolveKeysForRequest.mockResolvedValue({
      keys: [{ id: 'g1', key: 'gemini-secret', isPrimary: true }],
      allInCooldown: false,
      earliestCooldownEnd: null,
    });
    keyManagerMocks.updateKeyMetadata.mockResolvedValue(undefined);
    delete globalThis.clients;
  });

  it('uses the native side panel when the API is available', async () => {
    const mock = createChromeMock({ withSidePanel: true });
    await loadWorker(mock);

    expect(mock.setPanelBehavior).toHaveBeenCalledWith({
      openPanelOnActionClick: true,
    });
    expect(mock.actionListener).not.toHaveBeenCalled();
    expect(mock.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  it('opens Hera in a tab when the side panel API is unavailable', async () => {
    const mock = createChromeMock({ withSidePanel: false });
    await loadWorker(mock);
    const actionHandler = mock.actionListener.mock.calls[0][0];
    await actionHandler();

    expect(mock.createTab).toHaveBeenCalledWith({
      url: 'chrome-extension://test/index.html',
    });
  });

  it('uses a tab for context-menu actions without side panel support', async () => {
    const mock = createChromeMock({ withSidePanel: false });
    await loadWorker(mock);
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

  it('creates a page context-menu item on installation', async () => {
    const mock = createChromeMock({ withSidePanel: true });
    await loadWorker(mock);
    const installedHandler = mock.chrome.runtime.onInstalled.addListener.mock.calls[0][0];
    installedHandler();
    expect(mock.chrome.contextMenus.create).toHaveBeenCalledWith({
      id: 'heraai-page',
      title: "Sayfayı HeraAi'ye Gönder",
      contexts: ['page'],
    });
  });

  it('stores the page URL for page context-menu actions', async () => {
    const mock = createChromeMock({ withSidePanel: false });
    await loadWorker(mock);
    const contextHandler = mock.contextMenuListener.mock.calls[0][0];
    contextHandler({ menuItemId: 'heraai-page', pageUrl: 'https://example.com/yazi' }, {});
    expect(mock.chrome.storage.local.set).toHaveBeenCalledWith(
      { pendingPageUrl: 'https://example.com/yazi' },
      expect.any(Function),
    );
    expect(mock.createTab).toHaveBeenCalledWith({
      url: 'chrome-extension://test/index.html',
    });
  });

  it('continues forwarding crop completion and cancellation without holding the response channel open', async () => {
    const mock = createChromeMock();
    const listener = await loadWorker(mock);
    const sendResponse = vi.fn();

    expect(listener({ type: 'HERAAI_CROP_DONE', image: 'data:image/png' }, {}, sendResponse)).toBe(false);
    expect(listener({ type: 'HERAAI_CROP_CANCELLED', requestId: 'crop-1' }, {}, sendResponse)).toBe(false);
    expect(runtimeMessages(mock, 'HERAAI_CROP_DONE')).toEqual([
      { type: 'HERAAI_CROP_DONE', image: 'data:image/png' },
    ]);
    expect(runtimeMessages(mock, 'HERAAI_CROP_CANCELLED')).toEqual([
      { type: 'HERAAI_CROP_CANCELLED', requestId: 'crop-1' },
    ]);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});

describe('background generation coordinator', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    keyManagerMocks.resolveKeysForRequest.mockResolvedValue({
      keys: [{ id: 'g1', key: 'gemini-secret', isPrimary: true }],
      allInCooldown: false,
      earliestCooldownEnd: null,
    });
    keyManagerMocks.updateKeyMetadata.mockResolvedValue(undefined);
    delete globalThis.clients;
  });

  it('uses a callback response and returns true for asynchronous protocol messages', async () => {
    const mock = createChromeMock();
    const listener = await loadWorker(mock);
    const responsePromise = new Promise((resolve) => {
      expect(listener({ type: 'GET_STATE' }, {}, resolve)).toBe(true);
    });

    await expect(responsePromise).resolves.toEqual({
      type: 'STATE',
      ok: true,
      activeGeneration: null,
      keyStatuses: [],
    });
  });

  it('atomically persists the session, thinking placeholder and queued claim before starting', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeSessionId: 'older-session',
        sessions: [{
          id: 'older-session',
          title: 'Older session',
          updatedAt: 1,
          messages: [{ id: 'older-user', role: 'user', content: 'Older message' }],
        }],
      },
    });
    const listener = await loadWorker(mock);

    const response = await dispatch(listener, startMessage());

    expect(response.ok).toBe(true);
    const atomicWrite = mock.storageSet.mock.calls[0][0];
    expect(Object.keys(atomicWrite).sort()).toEqual([
      'activeGeneration',
      'activeSessionId',
      'sessions',
    ]);
    expect(atomicWrite.activeSessionId).toBe('session-1');
    expect(atomicWrite.activeGeneration).toMatchObject({
      jobId: 'job-1',
      status: 'queued',
      revision: 0,
    });
    expect(atomicWrite.sessions).toEqual([
      expect.objectContaining({ id: 'older-session', title: 'Older session' }),
      expect.objectContaining({
        id: 'session-1',
        title: 'Session from START',
        messages: [
          expect.objectContaining({ id: 'user-1', role: 'user', content: 'Hello' }),
          expect.objectContaining({
            id: 'assistant-1',
            role: 'model',
            content: '',
            status: 'thinking',
            model: 'gemini-3.6-flash',
          }),
        ],
      }),
    ]);
    expect(mock.storage.activeGeneration).toMatchObject({
      jobId: 'job-1',
      status: 'running',
      revision: 0,
      content: '',
      handoffCompletedAt: expect.any(Number),
    });
    expect(mock.storage.activeGeneration).not.toHaveProperty('geminiKeys');
    expect(mock.storage.activeGeneration).not.toHaveProperty('requestMessages');
    expect(mock.createDocument).toHaveBeenCalledWith({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Stream chat completions off the panel context for persistent generation.',
    });

    const forwardedStart = runtimeMessages(mock, 'HERA_GENERATION_START')[0];
    expect(forwardedStart).toMatchObject({
      target: 'offscreen',
      forwardedBy: 'service_worker',
      jobId: 'job-1',
      providerKeys: [{ id: 'g1', key: 'gemini-secret', isPrimary: true }],
      tavilyKeys: [],
      requestMessages: [{ role: 'user', content: 'Hello' }],
    });
    expect(mock.events.indexOf('storage:set:queued')).toBeLessThan(
      mock.events.indexOf('storage:set:running'),
    );
    expect(mock.events.indexOf('storage:set:running')).toBeLessThan(
      mock.events.indexOf('offscreen:create'),
    );
    expect(mock.events.indexOf('offscreen:create')).toBeLessThan(
      mock.events.indexOf('runtime:HERA_GENERATION_START'),
    );
  });

  it('keeps an internal vision prompt for the model without using it as the session title', async () => {
    const internalPrompt = 'Internal OCR instruction for the model only';
    const requestMessages = [{
      id: 'user-1',
      role: 'user',
      content: internalPrompt,
      displayContent: '',
      mode: 'vision',
      attachments: [{ name: 'scan.png', mimeType: 'image/png', data: 'image-data' }],
    }];
    const mock = createChromeMock({ initialStorage: { sessions: [] } });
    const listener = await loadWorker(mock);

    const response = await dispatch(listener, startMessage({
      mode: 'vision',
      sessionTitle: `${internalPrompt.slice(0, 30)}...`,
      requestMessages,
    }));

    expect(response.ok).toBe(true);
    expect(mock.storageSet.mock.calls[0][0].sessions[0]).toMatchObject({
      title: 'New Chat',
      messages: [
        expect.objectContaining({ content: internalPrompt, displayContent: '' }),
        expect.objectContaining({ role: 'model', status: 'thinking' }),
      ],
    });
    expect(runtimeMessages(mock, 'HERA_GENERATION_START')[0].requestMessages).toEqual(requestMessages);
  });

  it('preserves custom titles and starred metadata when START carries an automatic title', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeSessionId: 'session-1',
        sessions: [{
          id: 'session-1',
          title: 'My permanent title',
          isTitleCustom: true,
          isStarred: true,
          updatedAt: 1,
          messages: [{ id: 'older-user', role: 'user', content: 'Older message' }],
        }],
      },
    });
    const listener = await loadWorker(mock);

    const response = await dispatch(listener, startMessage({
      sessionTitle: 'Automatic title from START',
    }));

    expect(response.ok).toBe(true);
    const persistedSession = mock.storageSet.mock.calls[0][0].sessions
      .find(session => session.id === 'session-1');
    expect(persistedSession).toMatchObject({
      title: 'My permanent title',
      isTitleCustom: true,
      isStarred: true,
    });
  });

  it('resolves Tavily keys for web mode and reuses an existing offscreen document', async () => {
    keyManagerMocks.resolveKeysForRequest
      .mockResolvedValueOnce({
        keys: [{ id: 'g1', key: 'gemini-secret' }],
        allInCooldown: false,
      })
      .mockResolvedValueOnce({
        keys: [{ id: 't1', key: 'tavily-secret' }],
        allInCooldown: false,
      });
    const mock = createChromeMock({
      initialStorage: { sessions: [] },
      offscreenOpen: true,
    });
    const listener = await loadWorker(mock);

    const response = await dispatch(listener, startMessage({
      mode: 'web',
      attachmentIds: ['attachment-1'],
      activeAttachmentIds: ['attachment-1', 'attachment-2'],
      activeWebUrls: ['https://example.com/article', 'https://example.com/previous'],
      webContext: { kind: 'url', urls: ['https://example.com/article'] },
    }));

    expect(response.ok).toBe(true);
    expect(keyManagerMocks.resolveKeysForRequest.mock.calls).toEqual([
      ['gemini'],
      ['tavily'],
    ]);
    expect(mock.createDocument).not.toHaveBeenCalled();
    expect(runtimeMessages(mock, 'HERA_GENERATION_START')[0].tavilyKeys).toEqual([
      { id: 't1', key: 'tavily-secret' },
    ]);
    expect(runtimeMessages(mock, 'HERA_GENERATION_START')[0]).toMatchObject({
      attachmentIds: ['attachment-1'],
      webContext: { kind: 'url', urls: ['https://example.com/article'] },
    });
    expect(mock.storageSet.mock.calls[0][0].sessions[0]).toMatchObject({
      activeAttachmentIds: ['attachment-1', 'attachment-2'],
      activeWebUrls: ['https://example.com/article', 'https://example.com/previous'],
    });
  });

  it('forwards only the selected provider key pool and keeps secrets out of persisted state', async () => {
    keyManagerMocks.resolveKeysForRequest.mockResolvedValueOnce({
      keys: [{ id: 'or1', key: 'openrouter-secret', isPrimary: true }],
      allInCooldown: false,
    });
    keyManagerMocks.resolveKeysForRequest.mockResolvedValueOnce({
      keys: [{ id: 'g1', key: 'gemini-secret' }],
      allInCooldown: false,
    });
    const mock = createChromeMock({ initialStorage: { sessions: [] } });
    const listener = await loadWorker(mock);

    const response = await dispatch(listener, startMessage({
      provider: 'openrouter',
      model: 'openrouter/free',
    }));

    expect(response.ok).toBe(true);
    expect(keyManagerMocks.resolveKeysForRequest).toHaveBeenCalledTimes(2);
    expect(keyManagerMocks.resolveKeysForRequest).toHaveBeenNthCalledWith(1, 'openrouter');
    expect(keyManagerMocks.resolveKeysForRequest).toHaveBeenNthCalledWith(2, 'gemini');
    expect(runtimeMessages(mock, 'HERA_GENERATION_START')[0]).toMatchObject({
      provider: 'openrouter',
      providerKeys: [{ id: 'or1', key: 'openrouter-secret', isPrimary: true }],
      fallbackGeminiKeys: [{ id: 'g1', key: 'gemini-secret' }],
      tavilyKeys: [],
    });
    expect(JSON.stringify(mock.storage)).not.toContain('openrouter-secret');
    expect(mock.storage.activeGeneration).toMatchObject({
      provider: 'openrouter',
      model: 'openrouter/free',
    });

    await expect(dispatch(listener, {
      type: 'MODEL_RESOLVED',
      jobId: 'job-1',
      provider: 'openrouter',
      requestedModel: 'openrouter/free',
      resolvedModel: 'meta-llama/free',
    })).resolves.toMatchObject({ accepted: true, resolvedModel: 'meta-llama/free' });
    expect(mock.storage.activeGeneration.resolvedModel).toBe('meta-llama/free');
    expect(runtimeMessages(mock, 'MODEL_RESOLVED')).toContainEqual(expect.objectContaining({
      forwardedBy: 'service_worker',
      resolvedModel: 'meta-llama/free',
    }));
  });

  it('rejects a second job while a different generation is active', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({ status: 'running', jobId: 'existing-job' }),
      },
    });
    const listener = await loadWorker(mock);

    const response = await dispatch(listener, startMessage({ jobId: 'new-job' }));

    expect(response).toMatchObject({
      ok: false,
      errorCode: 'already_running',
      activeGeneration: {
        jobId: 'existing-job',
        status: 'running',
      },
    });
    expect(keyManagerMocks.resolveKeysForRequest).not.toHaveBeenCalled();
    expect(mock.createDocument).not.toHaveBeenCalled();
    expect(runtimeMessages(mock, 'START_REJECTED')[0]).toMatchObject({
      jobId: 'new-job',
      activeJobId: 'existing-job',
      errorCode: 'already_running',
    });
  });

  it('serializes simultaneous START messages so only the first can claim storage', async () => {
    let releaseKeyResolution;
    keyManagerMocks.resolveKeysForRequest.mockImplementationOnce(() => new Promise((resolve) => {
      releaseKeyResolution = () => resolve({
        keys: [{ id: 'g1', key: 'gemini-secret' }],
        allInCooldown: false,
      });
    }));
    const mock = createChromeMock({ initialStorage: { sessions: [] } });
    const listener = await loadWorker(mock);

    const firstStart = dispatch(listener, startMessage());
    await vi.waitFor(() => expect(releaseKeyResolution).toBeTypeOf('function'));
    const secondStart = dispatch(listener, startMessage({
      jobId: 'job-2',
      requestId: 'request-2',
      sessionId: 'session-2',
      userMessageId: 'user-2',
      assistantMessageId: 'assistant-2',
      sessionTitle: 'Second competing session',
      requestMessages: [{ id: 'user-2', role: 'user', content: 'Second request' }],
    }));
    releaseKeyResolution();

    const [firstResponse, secondResponse] = await Promise.all([firstStart, secondStart]);
    expect(firstResponse.ok).toBe(true);
    expect(secondResponse).toMatchObject({
      ok: false,
      errorCode: 'already_running',
      activeGeneration: {
        jobId: 'job-1',
        status: 'running',
      },
    });
    expect(mock.storage.activeGeneration).toMatchObject({
      jobId: 'job-1',
      status: 'running',
    });
    expect(mock.storage.sessions.some(session => session.id === 'session-2')).toBe(false);
    expect(runtimeMessages(mock, 'HERA_GENERATION_START')).toHaveLength(1);
    expect(runtimeMessages(mock, 'START_REJECTED')[0]).toMatchObject({
      jobId: 'job-2',
      activeJobId: 'job-1',
      errorCode: 'already_running',
    });
  });

  it('does not overwrite a different terminal job that is still awaiting DONE_ACK', async () => {
    const mock = createChromeMock({
      initialStorage: {
        sessions: [{
          id: 'terminal-session',
          title: 'Terminal session',
          messages: [{ id: 'terminal-answer', role: 'model', content: 'Must survive' }],
        }],
        activeGeneration: queuedGeneration({
          jobId: 'terminal-job',
          sessionId: 'terminal-session',
          status: 'completed',
          revision: 8,
          content: 'Must survive',
        }),
      },
    });
    const listener = await loadWorker(mock);

    const response = await dispatch(listener, startMessage({ jobId: 'new-job' }));

    expect(response).toMatchObject({
      ok: false,
      errorCode: 'already_running',
      activeGeneration: {
        jobId: 'terminal-job',
        status: 'completed',
        revision: 8,
        content: 'Must survive',
      },
    });
    expect(mock.storage.activeGeneration).toMatchObject({
      jobId: 'terminal-job',
      status: 'completed',
      revision: 8,
      content: 'Must survive',
    });
    expect(mock.storageSet).not.toHaveBeenCalled();
    expect(runtimeMessages(mock, 'START_REJECTED')[0]).toMatchObject({
      jobId: 'new-job',
      activeJobId: 'terminal-job',
      errorCode: 'already_running',
    });
  });

  it('treats a repeated START for the same running job as idempotent', async () => {
    const now = Date.now();
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({
          status: 'running',
          updatedAt: now,
          handoffCompletedAt: now,
        }),
      },
      offscreenOpen: true,
    });
    const listener = await loadWorker(mock);

    const response = await dispatch(listener, startMessage());

    expect(response).toMatchObject({ ok: true, alreadyStarted: true });
    expect(keyManagerMocks.resolveKeysForRequest).not.toHaveBeenCalled();
    expect(runtimeMessages(mock, 'HERA_GENERATION_START')).toHaveLength(0);
  });

  it('marks a repeated running START interrupted when its offscreen document is gone', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({
          status: 'running',
          updatedAt: Date.now(),
        }),
      },
      offscreenOpen: false,
    });
    const listener = await loadWorker(mock);

    const response = await dispatch(listener, startMessage());

    expect(response).toMatchObject({
      ok: true,
      interrupted: true,
      activeGeneration: {
        status: 'interrupted',
        interruptReason: 'offscreen_missing',
      },
    });
    expect(keyManagerMocks.resolveKeysForRequest).not.toHaveBeenCalled();
    expect(runtimeMessages(mock, 'HERA_GENERATION_START')).toHaveLength(0);
  });

  it('never restarts the same job after it has reached a terminal state', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({
          status: 'completed', revision: 3, content: 'persisted final answer',
        }),
      },
    });
    const listener = await loadWorker(mock);

    const response = await dispatch(listener, startMessage());

    expect(response).toMatchObject({
      ok: true,
      alreadyFinished: true,
      activeGeneration: { status: 'completed', content: 'persisted final answer' },
    });
    expect(keyManagerMocks.resolveKeysForRequest).not.toHaveBeenCalled();
    expect(mock.createDocument).not.toHaveBeenCalled();
    expect(runtimeMessages(mock, 'HERA_GENERATION_START')).toHaveLength(0);
  });

  it('persists a terminal cooldown error and retains it for DONE_ACK', async () => {
    keyManagerMocks.resolveKeysForRequest.mockResolvedValue({
      keys: [],
      allInCooldown: true,
      earliestCooldownEnd: 98765,
    });
    const mock = createChromeMock({
      initialStorage: { sessions: [] },
      offscreenOpen: true,
    });
    const listener = await loadWorker(mock);

    const response = await dispatch(listener, startMessage());

    expect(response).toMatchObject({ ok: false, errorCode: 'all_keys_cooldown' });
    expect(mock.storage.activeGeneration).toMatchObject({
      status: 'error',
      errorCode: 'all_keys_cooldown',
      earliestCooldownEnd: 98765,
    });
    expect(runtimeMessages(mock, 'DONE')[0]).toMatchObject({
      status: 'error',
      errorCode: 'all_keys_cooldown',
    });
    expect(mock.storageRemove).not.toHaveBeenCalled();
    expect(mock.closeDocument).toHaveBeenCalledTimes(1);
  });

  it('supports the Chrome 114 clients fallback when runtime.getContexts is unavailable', async () => {
    Object.defineProperty(globalThis, 'clients', {
      configurable: true,
      value: {
        matchAll: vi.fn().mockResolvedValue([
          { url: 'chrome-extension://test/offscreen.html' },
        ]),
      },
    });
    const mock = createChromeMock({
      initialStorage: { sessions: [] },
      withGetContexts: false,
      offscreenOpen: true,
    });
    const listener = await loadWorker(mock);

    const response = await dispatch(listener, startMessage());

    expect(response.ok).toBe(true);
    expect(globalThis.clients.matchAll).toHaveBeenCalledWith({
      includeUncontrolled: true,
      type: 'window',
    });
    expect(mock.createDocument).not.toHaveBeenCalled();
  });

  it('writes each newer snapshot before broadcasting and acknowledging it', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({
          status: 'running',
          revision: 2,
          content: 'old',
          presentedRevision: 2,
        }),
      },
      offscreenOpen: true,
    });
    const listener = await loadWorker(mock);

    const response = await dispatch(listener, {
      type: 'SNAPSHOT',
      jobId: 'job-1',
      revision: 3,
      content: 'new full snapshot',
      sources: [{ index: 1, url: 'https://example.com' }],
    });

    expect(response).toEqual({ ok: true, accepted: true, revision: 3 });
    expect(mock.storage.activeGeneration).toMatchObject({
      status: 'running',
      revision: 3,
      presentedRevision: 3,
      content: 'new full snapshot',
    });
    expect(runtimeMessages(mock).map(message => message.type)).toEqual([
      'ACTIVE_GEN_CHANGED',
      'PRESENTED',
    ]);
    expect(mock.events.indexOf('storage:set:running')).toBeLessThan(
      mock.events.indexOf('runtime:ACTIVE_GEN_CHANGED'),
    );
    expect(mock.events.indexOf('runtime:ACTIVE_GEN_CHANGED')).toBeLessThan(
      mock.events.indexOf('runtime:PRESENTED'),
    );
  });

  it('deduplicates repeated, stale, wrong-job and post-terminal snapshots', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({ status: 'running', revision: 5, content: 'latest' }),
      },
      offscreenOpen: true,
    });
    const listener = await loadWorker(mock);

    await expect(dispatch(listener, {
      type: 'SNAPSHOT', jobId: 'job-1', revision: 5, content: 'duplicate',
    })).resolves.toMatchObject({ accepted: false });
    await expect(dispatch(listener, {
      type: 'SNAPSHOT', jobId: 'job-1', revision: 4, content: 'stale',
    })).resolves.toMatchObject({ accepted: false });
    await expect(dispatch(listener, {
      type: 'SNAPSHOT', jobId: 'other-job', revision: 6, content: 'wrong',
    })).resolves.toMatchObject({ accepted: false, ignored: true });

    mock.storage.activeGeneration.status = 'completed';
    await expect(dispatch(listener, {
      type: 'SNAPSHOT', jobId: 'job-1', revision: 6, content: 'late',
    })).resolves.toMatchObject({ accepted: false, ignored: true });

    expect(mock.storageSet).not.toHaveBeenCalled();
    expect(mock.runtimeSendMessage).not.toHaveBeenCalled();
    expect(mock.storage.activeGeneration).toMatchObject({ revision: 5, content: 'latest' });
  });

  it('does not acknowledge a snapshot when its storage write fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({ status: 'running', revision: 1 }),
      },
      offscreenOpen: true,
    });
    mock.storageSet.mockImplementationOnce(() => Promise.reject(new Error('storage failed')));
    const listener = await loadWorker(mock);

    const response = await dispatch(listener, {
      type: 'SNAPSHOT', jobId: 'job-1', revision: 2, content: 'must not ack',
    });

    expect(response).toEqual({ ok: false, errorCode: 'generation_failed' });
    expect(runtimeMessages(mock, 'ACTIVE_GEN_CHANGED')).toHaveLength(0);
    expect(runtimeMessages(mock, 'PRESENTED')).toHaveLength(0);
    consoleError.mockRestore();
  });

  it('keeps persisted progress and accepts the next revision when a PRESENTED ack is lost', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({ status: 'running', revision: 1 }),
      },
      offscreenOpen: true,
    });
    mock.runtimeSendMessage
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('receiving end disappeared'));
    const listener = await loadWorker(mock);

    const first = await dispatch(listener, {
      type: 'SNAPSHOT', jobId: 'job-1', revision: 2, content: 'persisted second revision',
    });
    const second = await dispatch(listener, {
      type: 'SNAPSHOT', jobId: 'job-1', revision: 3, content: 'persisted third revision',
    });

    expect(first).toMatchObject({ ok: true, accepted: true, revision: 2 });
    expect(second).toMatchObject({ ok: true, accepted: true, revision: 3 });
    expect(mock.storage.activeGeneration).toMatchObject({
      revision: 3,
      presentedRevision: 3,
      content: 'persisted third revision',
    });
    expect(runtimeMessages(mock, 'ACTIVE_GEN_CHANGED')).toHaveLength(2);
    expect(runtimeMessages(mock, 'PRESENTED')).toHaveLength(2);
  });

  it('serializes concurrent snapshots so a delayed older write cannot win', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({ status: 'running', revision: 1 }),
      },
      offscreenOpen: true,
    });
    let releaseFirstWrite;
    mock.storageSet.mockImplementationOnce((value, callback) => new Promise((resolve) => {
      releaseFirstWrite = () => {
        Object.assign(mock.storage, clone(value));
        callback?.();
        resolve();
      };
    }));
    const listener = await loadWorker(mock);

    const first = dispatch(listener, {
      type: 'SNAPSHOT', jobId: 'job-1', revision: 2, content: 'revision two',
    });
    await vi.waitFor(() => expect(releaseFirstWrite).toBeTypeOf('function'));
    const second = dispatch(listener, {
      type: 'SNAPSHOT', jobId: 'job-1', revision: 3, content: 'revision three',
    });
    releaseFirstWrite();

    await Promise.all([first, second]);
    expect(mock.storage.activeGeneration).toMatchObject({
      revision: 3,
      content: 'revision three',
    });
  });

  it('updates heartbeat state only for the active job', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({ status: 'running' }),
      },
      offscreenOpen: true,
    });
    const listener = await loadWorker(mock);

    const accepted = await dispatch(listener, {
      type: 'HEARTBEAT', jobId: 'job-1', uptimeMs: 15000,
    });
    const storedHeartbeat = mock.storage.activeGeneration.lastHeartbeatAt;
    const ignored = await dispatch(listener, {
      type: 'HEARTBEAT', jobId: 'stale-job', uptimeMs: 30000,
    });

    expect(accepted).toMatchObject({ ok: true, accepted: true });
    expect(storedHeartbeat).toEqual(expect.any(Number));
    expect(mock.storage.activeGeneration.workerUptimeMs).toBe(15000);
    expect(ignored).toMatchObject({ ok: true, accepted: false, ignored: true });
    expect(mock.storageSet).toHaveBeenCalledTimes(1);
  });

  it('marks a queued or running stored job interrupted when no offscreen document survived', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({
          status: 'running',
          revision: 4,
          content: 'saved partial',
        }),
      },
      offscreenOpen: false,
    });
    const listener = await loadWorker(mock);

    const state = await dispatch(listener, { type: 'GET_STATE' });

    expect(state.activeGeneration).toMatchObject({
      status: 'interrupted',
      revision: 4,
      content: 'saved partial',
    });
    expect(mock.storage.activeGeneration.status).toBe('interrupted');
    expect(runtimeMessages(mock, 'HERA_GENERATION_START')).toHaveLength(0);
  });

  it('keeps a running job resumable when its offscreen document still exists', async () => {
    const now = Date.now();
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({
          status: 'running',
          content: 'partial',
          updatedAt: now,
          handoffCompletedAt: now,
        }),
      },
      offscreenOpen: true,
    });
    const listener = await loadWorker(mock);

    const state = await dispatch(listener, { type: 'GET_STATE' });

    expect(state.activeGeneration).toMatchObject({ status: 'running', content: 'partial' });
    expect(mock.storageSet).not.toHaveBeenCalled();
  });

  it('cancels a running retired MiniMax job and removes its provenance', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({
          status: 'running',
          model: 'minimax-m3',
          resolvedModel: 'minimax-m3:cloud',
          provider: 'ollama',
        }),
      },
      offscreenOpen: true,
    });
    const listener = await loadWorker(mock);

    const state = await dispatch(listener, { type: 'GET_STATE' });

    expect(state.activeGeneration).toMatchObject({
      status: 'cancelled',
      cancelReason: 'model_retired',
      provider: 'ollama',
    });
    expect(state.activeGeneration).not.toHaveProperty('model');
    expect(state.activeGeneration).not.toHaveProperty('resolvedModel');
    expect(mock.closeDocument).toHaveBeenCalledTimes(1);
  });

  it('interrupts and closes a running job whose heartbeat grace has expired', async () => {
    const staleTimestamp = Date.now() - 45_001;
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({
          status: 'running',
          content: 'safe partial',
          updatedAt: staleTimestamp,
          handoffCompletedAt: staleTimestamp,
          lastHeartbeatAt: staleTimestamp,
        }),
      },
      offscreenOpen: true,
    });
    const listener = await loadWorker(mock);

    const state = await dispatch(listener, { type: 'GET_STATE' });

    expect(state.activeGeneration).toMatchObject({
      status: 'interrupted',
      content: 'safe partial',
      interruptReason: 'heartbeat_stale',
    });
    expect(mock.closeDocument).toHaveBeenCalledTimes(1);
  });

  it('treats a leftover queued claim as interrupted even if an offscreen page exists', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({ updatedAt: Date.now() }),
      },
      offscreenOpen: true,
    });
    const listener = await loadWorker(mock);

    const state = await dispatch(listener, { type: 'GET_STATE' });

    expect(state.activeGeneration).toMatchObject({
      status: 'interrupted',
      interruptReason: 'queued_without_coordinator',
    });
    expect(mock.closeDocument).toHaveBeenCalledTimes(1);
  });

  it('updates key metadata, forwards KEY_STATUS and returns it from GET_STATE', async () => {
    const now = Date.now();
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({
          status: 'running',
          updatedAt: now,
          handoffCompletedAt: now,
        }),
      },
      offscreenOpen: true,
    });
    const listener = await loadWorker(mock);

    const result = await dispatch(listener, {
      type: 'KEY_STATUS',
      jobId: 'job-1',
      provider: 'gemini',
      keyId: 'g1',
      status: 'quota_exceeded',
    });
    const state = await dispatch(listener, { type: 'GET_STATE' });

    expect(result).toMatchObject({ ok: true, accepted: true });
    expect(keyManagerMocks.updateKeyMetadata).toHaveBeenCalledWith(
      'gemini',
      'g1',
      expect.objectContaining({
        lastErrorType: 'quota_exceeded',
        cooldownUntil: expect.any(Number),
      }),
    );
    expect(runtimeMessages(mock, 'KEY_STATUS')[0]).toMatchObject({
      forwardedBy: 'service_worker',
      provider: 'gemini',
      keyId: 'g1',
      status: 'quota_exceeded',
    });
    expect(state.keyStatuses).toEqual([
      expect.objectContaining({ provider: 'gemini', keyId: 'g1', status: 'quota_exceeded' }),
    ]);
  });

  it('persists completed output, closes offscreen, and waits for an exact DONE_ACK', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({ status: 'running', revision: 2, content: 'partial' }),
      },
      offscreenOpen: true,
    });
    const listener = await loadWorker(mock);

    const doneResponse = await dispatch(listener, {
      type: 'WORKER_DONE',
      jobId: 'job-1',
      finalRev: 3,
      content: 'complete answer',
      sources: [],
      cancelled: false,
    });

    expect(doneResponse).toMatchObject({ ok: true, accepted: true });
    expect(mock.storage.activeGeneration).toMatchObject({
      status: 'completed',
      revision: 3,
      content: 'complete answer',
    });
    expect(runtimeMessages(mock, 'DONE')[0]).toMatchObject({
      status: 'completed',
      finalRev: 3,
      content: 'complete answer',
    });
    expect(mock.storageRemove).not.toHaveBeenCalled();
    expect(mock.events.indexOf('storage:set:completed')).toBeLessThan(
      mock.events.indexOf('runtime:DONE'),
    );
    expect(mock.events.indexOf('runtime:DONE')).toBeLessThan(
      mock.events.indexOf('offscreen:close'),
    );

    const mismatchedAck = await dispatch(listener, {
      type: 'DONE_ACK', jobId: 'job-1', finalRevision: 2,
    });
    expect(mismatchedAck).toMatchObject({
      ok: false,
      removed: false,
      errorCode: 'revision_mismatch',
    });
    expect(mock.storage.activeGeneration).toBeTruthy();

    const ack = await dispatch(listener, {
      type: 'DONE_ACK', jobId: 'job-1', finalRevision: 3,
    });
    expect(ack).toEqual({ ok: true, removed: true });
    expect(mock.storage.activeGeneration).toBeUndefined();
  });

  it('does not let a stale WORKER_DONE revision replace a newer persisted snapshot', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({
          status: 'running', revision: 5, content: 'newer content', sources: [{ index: 5 }],
        }),
      },
      offscreenOpen: true,
    });
    const listener = await loadWorker(mock);

    await dispatch(listener, {
      type: 'WORKER_DONE',
      jobId: 'job-1',
      finalRev: 4,
      content: 'stale final content',
      sources: [{ index: 4 }],
      cancelled: false,
    });

    expect(mock.storage.activeGeneration).toMatchObject({
      status: 'completed',
      revision: 5,
      content: 'newer content',
      sources: [{ index: 5 }],
    });
  });

  it('ignores late worker completion or error events after cancellation won the race', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({
          status: 'cancelled', revision: 4, content: 'kept partial', cancelReason: 'stop',
        }),
      },
    });
    const listener = await loadWorker(mock);

    const done = await dispatch(listener, {
      type: 'WORKER_DONE', jobId: 'job-1', finalRev: 5, content: 'late full answer',
    });
    const error = await dispatch(listener, {
      type: 'WORKER_ERROR', jobId: 'job-1', finalRev: 5, code: 'timeout',
    });

    expect(done).toMatchObject({ accepted: false, ignored: true });
    expect(error).toMatchObject({ accepted: false, ignored: true });
    expect(mock.storage.activeGeneration).toMatchObject({
      status: 'cancelled', revision: 4, content: 'kept partial', cancelReason: 'stop',
    });
    expect(mock.storageSet).not.toHaveBeenCalled();
    expect(mock.runtimeSendMessage).not.toHaveBeenCalled();
  });

  it('persists worker errors and closes offscreen without deleting state', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({ status: 'running', revision: 2, content: 'partial' }),
      },
      offscreenOpen: true,
    });
    const listener = await loadWorker(mock);

    const response = await dispatch(listener, {
      type: 'WORKER_ERROR',
      jobId: 'job-1',
      code: 'timeout',
      finalRev: 3,
      content: 'safe partial',
      sources: [],
    });

    expect(response).toMatchObject({ ok: true, accepted: true });
    expect(mock.storage.activeGeneration).toMatchObject({
      status: 'error',
      revision: 3,
      content: 'safe partial',
      errorCode: 'timeout',
    });
    expect(runtimeMessages(mock, 'DONE')[0]).toMatchObject({
      status: 'error',
      errorCode: 'timeout',
    });
    expect(mock.closeDocument).toHaveBeenCalledTimes(1);
    expect(mock.storageRemove).not.toHaveBeenCalled();
  });

  it('preserves the latest persisted partial when a native worker error has no snapshot', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({
          status: 'running',
          revision: 6,
          content: 'latest safely persisted partial',
          sources: [{ index: 1, url: 'https://example.com' }],
        }),
      },
      offscreenOpen: true,
    });
    const listener = await loadWorker(mock);

    await dispatch(listener, {
      type: 'WORKER_ERROR',
      jobId: 'job-1',
      code: 'generation_failed',
      finalRev: 0,
      content: '',
      sources: [],
    });

    expect(mock.storage.activeGeneration).toMatchObject({
      status: 'error',
      revision: 6,
      content: 'latest safely persisted partial',
      sources: [{ index: 1, url: 'https://example.com' }],
    });
  });

  it('forwards cancellation before persisting and broadcasting the terminal state', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({
          status: 'running', revision: 4, content: 'visible partial',
        }),
      },
      offscreenOpen: true,
    });
    const listener = await loadWorker(mock);

    const response = await dispatch(listener, {
      type: 'CANCEL', jobId: 'job-1', reason: 'new_chat',
    });

    expect(response).toMatchObject({ ok: true, accepted: true });
    expect(mock.storage.activeGeneration).toMatchObject({
      status: 'cancelled',
      cancelReason: 'new_chat',
      revision: 4,
      content: 'visible partial',
    });
    expect(runtimeMessages(mock, 'CANCEL')[0]).toMatchObject({
      target: 'offscreen', jobId: 'job-1', reason: 'new_chat',
    });
    expect(runtimeMessages(mock, 'CANCEL_DONE')[0]).toMatchObject({
      status: 'cancelled', cancelReason: 'new_chat', content: 'visible partial',
    });
    expect(mock.events.indexOf('runtime:CANCEL')).toBeLessThan(
      mock.events.indexOf('storage:set:cancelled'),
    );
    expect(mock.events.indexOf('storage:set:cancelled')).toBeLessThan(
      mock.events.indexOf('runtime:CANCEL_DONE'),
    );
    expect(mock.events.indexOf('runtime:CANCEL_DONE')).toBeLessThan(
      mock.events.indexOf('offscreen:close'),
    );
    expect(mock.storageRemove).not.toHaveBeenCalled();

    await dispatch(listener, {
      type: 'CANCEL_DONE_ACK', jobId: 'job-1', finalRevision: 4,
    });
    expect(mock.storage.activeGeneration).toBeUndefined();
  });

  it('ignores acknowledgements for another job', async () => {
    const mock = createChromeMock({
      initialStorage: {
        activeGeneration: queuedGeneration({ status: 'completed', revision: 7 }),
      },
    });
    const listener = await loadWorker(mock);

    const response = await dispatch(listener, {
      type: 'DONE_ACK', jobId: 'other-job', finalRevision: 7,
    });

    expect(response).toMatchObject({ ok: true, removed: false, ignored: true });
    expect(mock.storage.activeGeneration).toBeTruthy();
    expect(mock.storageRemove).not.toHaveBeenCalled();
  });
});
