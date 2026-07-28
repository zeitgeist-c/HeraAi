import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import App from './App';
import * as api from './lib/api';
import i18n from './i18n';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

vi.mock('./lib/api', () => ({
  streamChat: vi.fn(),
  streamResearch: vi.fn(),
  streamVision: vi.fn(),
  testKey: vi.fn(),
  MODELS: [
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
  ],
  DEFAULT_MODEL: 'gemini-3.1-flash-lite',
}));

async function* mockStream(events) {
  for (const evt of events) {
    yield evt;
  }
}

async function* delayedMockStream(events) {
  for (const evt of events) {
    await new Promise(resolve => setTimeout(resolve, 0));
    yield evt;
  }
}

function createControlledStream() {
  const queue = [];
  const waiters = [];

  const push = (value) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    queue.push({ value, done: false });
  };

  const finish = () => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ done: true });
      return;
    }
    queue.push({ done: true });
  };

  async function* stream() {
    while (true) {
      const item = queue.length
        ? queue.shift()
        : await new Promise(resolve => waiters.push(resolve));

      if (item.done) return;
      yield item.value;
    }
  }

  return { stream: stream(), push, finish };
}

function getSendButton() {
  return Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-send') || btn.title?.match(/Send|Gönder/i));
}

function getStopButton() {
  return Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-square'));
}

function setScrollMetrics(element, { scrollHeight, clientHeight, scrollTop }) {
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    value: clientHeight,
  });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    writable: true,
    value: scrollTop,
  });
}

function openSettingsPanel() {
  const menuButton = document.querySelector('button[aria-haspopup="menu"]');
  fireEvent.click(menuButton);
  const settingsButton = Array.from(document.querySelectorAll('[role="menuitem"]'))
    .find(button => button.querySelector('svg.lucide-settings'));
  fireEvent.click(settingsButton);
}

describe('HeraAi App', () => {
  let currentStorage = {};
  let storageListeners = [];
  let runtimeListeners = [];
  let generationControllers = new Map();
  let documentVisibility = 'visible';

  const triggerStorageChange = (changes) => {
    act(() => {
      storageListeners.forEach(listener => listener(changes, 'local'));
    });
  };

  const emitRuntimeMessage = (message) => {
    act(() => {
      runtimeListeners.forEach(listener => listener(message, {}, vi.fn()));
    });
  };

  const readStorage = keys => new Promise(resolve => {
    global.chrome.storage.local.get(keys, result => resolve(result || {}));
  });

  const nextBridgeEvent = (iterator, signal) => new Promise((resolve, reject) => {
    const handleAbort = () => {
      signal.removeEventListener('abort', handleAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal.aborted) {
      handleAbort();
      return;
    }
    signal.addEventListener('abort', handleAbort, { once: true });
    Promise.resolve(iterator.next()).then(value => {
      signal.removeEventListener('abort', handleAbort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', handleAbort);
      reject(error);
    });
  });

  const runGenerationBridge = async (message) => {
    const controller = new AbortController();
    generationControllers.set(message.jobId, controller);
    const geminiResult = await readStorage(['geminiApiKeys']);
    const geminiKeys = geminiResult.geminiApiKeys || [];
    const tavilyResult = message.mode === 'web'
      ? await readStorage(['tavilyApiKeys'])
      : { tavilyApiKeys: [] };
    const tavilyKeys = tavilyResult.tavilyApiKeys || [];
    const options = {
      systemInstruction: message.systemInstruction || '',
      language: message.language || 'tr',
    };
    let content = '';
    let sources = [];
    let revision = 0;
    let errorCode = null;

    if (
      geminiKeys.length > 0
      && geminiKeys.every(key => Number(key?.cooldownUntil || 0) > Date.now())
    ) {
      const terminal = {
        ...currentStorage.activeGeneration,
        ...message,
        status: 'error',
        errorCode: 'all_keys_cooldown',
        revision,
        content,
        sources,
      };
      currentStorage.activeGeneration = terminal;
      emitRuntimeMessage({ type: 'DONE', activeGeneration: terminal });
      generationControllers.delete(message.jobId);
      return;
    }

    try {
      const events = message.mode === 'web'
        ? api.streamResearch(message.requestMessages, geminiKeys, tavilyKeys, controller.signal, message.model)
        : message.mode === 'vision'
          ? api.streamVision(message.requestMessages, null, options, geminiKeys, controller.signal, message.model)
          : api.streamChat(message.requestMessages, options, geminiKeys, controller.signal, message.model);
      const iterator = events[Symbol.asyncIterator]();
      while (true) {
        const next = await nextBridgeEvent(iterator, controller.signal);
        if (next.done) break;
        const event = next.value;
        if (event.event === 'chunk') content += event.data?.text || '';
        if (event.event === 'sources') sources = event.data?.sources || [];
        if (event.event === 'error') {
          errorCode = event.data?.code || 'generation_failed';
          break;
        }
        if (event.event !== 'chunk' && event.event !== 'sources') continue;
        revision += 1;
        const snapshot = {
          ...currentStorage.activeGeneration,
          ...message,
          status: 'running',
          revision,
          content,
          sources,
        };
        currentStorage.activeGeneration = snapshot;
        emitRuntimeMessage({ type: 'ACTIVE_GEN_CHANGED', snapshot });
      }
    } catch (error) {
      if (error?.name !== 'AbortError') errorCode = 'generation_failed';
    }

    if (controller.signal.aborted) return;
    const terminal = {
      ...currentStorage.activeGeneration,
      ...message,
      status: errorCode ? 'error' : 'completed',
      errorCode,
      revision,
      content,
      sources,
    };
    currentStorage.activeGeneration = terminal;
    emitRuntimeMessage({ type: 'DONE', activeGeneration: terminal });
    generationControllers.delete(message.jobId);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    storageListeners = [];
    runtimeListeners = [];
    generationControllers = new Map();
    documentVisibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => documentVisibility,
    });
    currentStorage = {
      theme: 'light',
    };

    global.chrome.storage.local.get.mockImplementation((keys, callback) => {
      if (typeof callback === 'function') callback(currentStorage);
      return Promise.resolve(currentStorage);
    });
    global.chrome.storage.local.set.mockImplementation((data, callback) => {
      Object.assign(currentStorage, data);
      if (typeof callback === 'function') callback();
      return Promise.resolve();
    });
    global.chrome.storage.local.remove.mockImplementation((keys, callback) => {
      const keysArray = Array.isArray(keys) ? keys : [keys];
      keysArray.forEach(k => delete currentStorage[k]);
      if (typeof callback === 'function') callback();
      return Promise.resolve();
    });
    global.chrome.storage.onChanged.addListener.mockImplementation((listener) => {
      storageListeners.push(listener);
    });
    global.chrome.storage.onChanged.removeListener.mockImplementation((listener) => {
      storageListeners = storageListeners.filter(item => item !== listener);
    });
    global.chrome.runtime.onMessage.addListener.mockImplementation((listener) => {
      runtimeListeners.push(listener);
    });
    global.chrome.runtime.onMessage.removeListener.mockImplementation((listener) => {
      runtimeListeners = runtimeListeners.filter(item => item !== listener);
    });
    global.chrome.runtime.sendMessage.mockImplementation(async (message) => {
      if (message?.type === 'GET_STATE') {
        return { ok: true, activeGeneration: currentStorage.activeGeneration || null };
      }
      if (message?.type === 'HERA_GENERATION_START') {
        const existingGeneration = currentStorage.activeGeneration;
        if (
          existingGeneration
          && ['queued', 'running'].includes(existingGeneration.status)
          && existingGeneration.jobId !== message.jobId
        ) {
          return { ok: false, errorCode: 'already_running', activeGeneration: existingGeneration };
        }

        const queued = {
          ...message,
          status: 'queued',
          revision: 0,
          content: '',
          sources: [],
          updatedAt: Date.now(),
        };
        const assistantMessage = {
          id: message.assistantMessageId,
          requestId: message.requestId,
          userMessageId: message.userMessageId,
          startedAt: message.startedAt,
          role: 'model',
          content: '',
          status: 'thinking',
          sources: [],
        };
        const nextSession = {
          id: message.sessionId,
          title: message.sessionTitle || message.requestMessages?.find(item => item.role === 'user')?.content || 'New Chat',
          updatedAt: Date.now(),
          messages: [...(message.requestMessages || []), assistantMessage],
        };
        const nextSessions = [
          ...(currentStorage.sessions || []).filter(session => session.id !== message.sessionId),
          nextSession,
        ];
        await global.chrome.storage.local.set({
          sessions: nextSessions,
          activeSessionId: message.sessionId,
          activeGeneration: queued,
        });

        const running = { ...queued, status: 'running', updatedAt: Date.now() };
        currentStorage.activeGeneration = running;
        void runGenerationBridge(message);
        return { ok: true, activeGeneration: running };
      }
      if (message?.type === 'CANCEL') {
        const controller = generationControllers.get(message.jobId);
        controller?.abort();
        const cancelled = {
          ...currentStorage.activeGeneration,
          status: 'cancelled',
          cancelReason: message.reason,
        };
        currentStorage.activeGeneration = cancelled;
        emitRuntimeMessage({ type: 'CANCEL_DONE', activeGeneration: cancelled });
        return { ok: true, activeGeneration: cancelled };
      }
      if (message?.type === 'DONE_ACK' || message?.type === 'CANCEL_DONE_ACK') {
        await global.chrome.storage.local.remove(['activeGeneration']);
        return { ok: true };
      }
      return { ok: true };
    });
    global.chrome.tabs.query.mockResolvedValue([{ id: 1, url: 'https://example.com/article' }]);
    global.chrome.tabs.captureVisibleTab.mockResolvedValue('data:image/png;base64,visible-tab');
    global.chrome.scripting.executeScript.mockResolvedValue([{
      result: {
        title: 'Example Article',
        url: 'https://example.com/article',
        selection: 'selected context',
        text: 'Readable page body',
      },
    }]);

    api.streamChat.mockImplementation(() => {
      return mockStream([{ event: 'chunk', data: { text: 'Hello from AI' } }]);
    });
  });

  afterEach(() => {
    generationControllers.forEach(controller => controller.abort());
    generationControllers.clear();
    runtimeListeners = [];
  });

  it('should send a message, display it, clear input and show AI response', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    const sendBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-send') || btn.title?.match(/Send/i));

    fireEvent.change(input, { target: { value: 'Hello Gemini, fun fact.' } });
    fireEvent.click(sendBtn);

    expect(await screen.findByText('Hello Gemini, fun fact.')).toBeInTheDocument();
    expect(input.value).toBe('');
    expect(await screen.findByText('Hello from AI')).toBeInTheDocument();
  });

  it('should send the textarea value when the send button click event fires', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    const sendBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-send') || btn.title?.match(/Send/i));

    fireEvent.change(input, { target: { value: 'Button click question' } });
    fireEvent.click(sendBtn);

    await waitFor(() => expect(api.streamChat).toHaveBeenCalled());
    expect(api.streamChat.mock.calls[0][0].at(-1).content).toBe('Button click question');
  });

  it('shows the user message and thinking state before API key resolution finishes', async () => {
    let releaseKeyLookup;
    global.chrome.storage.local.get.mockImplementation((keys, callback) => {
      if (Array.isArray(keys) && keys.length === 1 && keys[0] === 'geminiApiKeys') {
        releaseKeyLookup = () => callback({ geminiApiKeys: [] });
        return Promise.resolve();
      }
      if (typeof callback === 'function') callback(currentStorage);
      return Promise.resolve(currentStorage);
    });
    api.streamChat.mockImplementationOnce(() => mockStream([
      { event: 'chunk', data: { text: 'Resolved answer' } },
    ]));

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea');
    fireEvent.change(input, { target: { value: 'Show this immediately' } });
    fireEvent.click(getSendButton());

    expect(screen.getByText('Show this immediately')).toBeInTheDocument();
    expect(screen.getByText(/Thinking|Düşünüyor/i)).toBeInTheDocument();
    expect(api.streamChat).not.toHaveBeenCalled();

    await waitFor(() => expect(releaseKeyLookup).toBeTypeOf('function'));
    await act(async () => releaseKeyLookup());
    expect(await screen.findByText('Resolved answer')).toBeInTheDocument();
  });

  it('keeps the composer unavailable until background generation state is reconciled', async () => {
    const defaultRuntimeSend = global.chrome.runtime.sendMessage.getMockImplementation();
    let releaseState;
    global.chrome.runtime.sendMessage.mockImplementation(message => {
      if (message?.type === 'GET_STATE') {
        return new Promise(resolve => {
          releaseState = resolve;
        });
      }
      return defaultRuntimeSend(message);
    });

    render(<App />);
    await waitFor(() => expect(releaseState).toBeTypeOf('function'));
    expect(document.querySelector('textarea')).not.toBeInTheDocument();

    await act(async () => {
      releaseState({ ok: true, activeGeneration: null });
    });
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
  });

  it('applies the stored language once without restarting bootstrap', async () => {
    const previousLanguage = i18n.resolvedLanguage || i18n.language || 'tr';
    await i18n.changeLanguage('tr');
    currentStorage = {
      theme: 'light',
      language: 'en',
    };
    const changeLanguageSpy = vi.spyOn(i18n, 'changeLanguage');

    try {
      render(<App />);

      expect(await screen.findByText('Hello, how can I help?')).toBeInTheDocument();
      await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
      expect(changeLanguageSpy).toHaveBeenCalledTimes(1);
      expect(changeLanguageSpy).toHaveBeenCalledWith('en');
      expect(global.chrome.runtime.sendMessage.mock.calls.filter(([message]) => (
        message?.type === 'GET_STATE'
      ))).toHaveLength(1);
    } finally {
      changeLanguageSpy.mockRestore();
      await i18n.changeLanguage(previousLanguage);
    }
  });

  it('adopts an atomic session and generation change that lands during bootstrap', async () => {
    const initialStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'old-session',
      sessions: [{
        id: 'old-session',
        title: 'Old session',
        updatedAt: Date.now() - 10_000,
        messages: [{ id: 'old-user', role: 'user', content: 'Older question' }],
      }],
    };
    let releaseInitialStorageRead;
    global.chrome.storage.local.get.mockImplementation((keys, callback) => new Promise(resolve => {
      releaseInitialStorageRead = () => {
        if (typeof callback === 'function') callback(initialStorage);
        resolve(initialStorage);
      };
    }));

    render(<App />);
    await waitFor(() => expect(releaseInitialStorageRead).toBeTypeOf('function'));

    const runningGeneration = {
      jobId: 'bootstrap-race-job',
      requestId: 'bootstrap-race-job',
      sessionId: 'new-session',
      userMessageId: 'new-user',
      assistantMessageId: 'new-assistant',
      status: 'running',
      revision: 0,
      content: '',
      sources: [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    const newSessions = [
      ...initialStorage.sessions,
      {
        id: 'new-session',
        title: 'New atomic session',
        updatedAt: Date.now(),
        messages: [
          { id: 'new-user', role: 'user', content: 'Question claimed during bootstrap' },
          {
            id: 'new-assistant',
            role: 'model',
            content: '',
            status: 'thinking',
            sources: [],
          },
        ],
      },
    ];
    currentStorage = {
      ...initialStorage,
      sessions: newSessions,
      activeSessionId: 'new-session',
      activeGeneration: runningGeneration,
    };
    triggerStorageChange({
      sessions: { oldValue: initialStorage.sessions, newValue: newSessions },
      activeSessionId: { oldValue: 'old-session', newValue: 'new-session' },
      activeGeneration: { oldValue: undefined, newValue: runningGeneration },
    });

    await act(async () => {
      releaseInitialStorageRead();
      await Promise.resolve();
    });

    expect(await screen.findByText('Question claimed during bootstrap')).toBeInTheDocument();
    expect(screen.getByText(/Thinking|Düşünüyor/i)).toBeInTheDocument();
    expect(getStopButton()).toBeInTheDocument();

    const terminalGeneration = {
      ...runningGeneration,
      status: 'completed',
      revision: 1,
      content: 'Answer persisted into the atomic session.',
      completedAt: Date.now(),
      updatedAt: Date.now(),
    };
    currentStorage.activeGeneration = terminalGeneration;
    emitRuntimeMessage({ type: 'DONE', activeGeneration: terminalGeneration });

    expect(await screen.findByText(
      'Answer persisted into the atomic session.',
      {},
      { timeout: 3000 },
    )).toBeInTheDocument();
    await waitFor(() => {
      const persistedSession = currentStorage.sessions.find(session => session.id === 'new-session');
      expect(persistedSession?.messages).toContainEqual(expect.objectContaining({
        id: 'new-assistant',
        content: 'Answer persisted into the atomic session.',
        status: 'done',
      }));
    });
    expect(currentStorage.sessions.some(session => session.id === 'old-session')).toBe(true);
    expect(api.streamChat).not.toHaveBeenCalled();
  });

  it('merges a missing job session from an atomic storage change after bootstrap', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const runningGeneration = {
      jobId: 'post-bootstrap-job',
      requestId: 'post-bootstrap-job',
      sessionId: 'post-bootstrap-session',
      userMessageId: 'post-bootstrap-user',
      assistantMessageId: 'post-bootstrap-assistant',
      status: 'running',
      revision: 0,
      content: '',
      sources: [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    const externalSession = {
      id: 'post-bootstrap-session',
      title: 'Externally claimed session',
      updatedAt: Date.now(),
      messages: [
        { id: 'post-bootstrap-user', role: 'user', content: 'External panel question' },
        {
          id: 'post-bootstrap-assistant',
          role: 'model',
          content: '',
          status: 'thinking',
          sources: [],
        },
      ],
    };
    const previousSessions = currentStorage.sessions;
    const nextSessions = [...previousSessions, externalSession];
    const previousActiveSessionId = currentStorage.activeSessionId;
    currentStorage = {
      ...currentStorage,
      sessions: nextSessions,
      activeSessionId: externalSession.id,
      activeGeneration: runningGeneration,
    };

    triggerStorageChange({
      sessions: { oldValue: previousSessions, newValue: nextSessions },
      activeSessionId: { oldValue: previousActiveSessionId, newValue: externalSession.id },
      activeGeneration: { oldValue: undefined, newValue: runningGeneration },
    });

    expect(await screen.findByText('External panel question')).toBeInTheDocument();
    expect(getStopButton()).toBeInTheDocument();

    const terminalGeneration = {
      ...runningGeneration,
      status: 'completed',
      revision: 1,
      content: 'External answer was preserved.',
      completedAt: Date.now(),
      updatedAt: Date.now(),
    };
    currentStorage.activeGeneration = terminalGeneration;
    emitRuntimeMessage({ type: 'DONE', activeGeneration: terminalGeneration });

    expect(await screen.findByText(
      'External answer was preserved.',
      {},
      { timeout: 3000 },
    )).toBeInTheDocument();
    await waitFor(() => {
      const persistedSession = currentStorage.sessions.find(session => (
        session.id === externalSession.id
      ));
      expect(persistedSession?.messages).toContainEqual(expect.objectContaining({
        id: 'post-bootstrap-assistant',
        content: 'External answer was preserved.',
        status: 'done',
      }));
    });
    expect(api.streamChat).not.toHaveBeenCalled();
  });

  it('removes an orphaned thinking placeholder when GET_STATE clears a stale stored job', async () => {
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'stale-session',
      sessions: [{
        id: 'stale-session',
        title: 'Stale generation',
        updatedAt: Date.now(),
        messages: [
          { id: 'stale-user', role: 'user', content: 'Was this request still running?' },
          {
            id: 'stale-assistant',
            role: 'model',
            content: '',
            status: 'thinking',
            sources: [],
          },
        ],
      }],
      activeGeneration: {
        jobId: 'stale-job',
        requestId: 'stale-job',
        sessionId: 'stale-session',
        userMessageId: 'stale-user',
        assistantMessageId: 'stale-assistant',
        status: 'running',
        revision: 3,
        content: '',
        sources: [],
        startedAt: Date.now() - 10_000,
        updatedAt: Date.now() - 5_000,
      },
    };
    const defaultRuntimeSend = global.chrome.runtime.sendMessage.getMockImplementation();
    global.chrome.runtime.sendMessage.mockImplementation(message => (
      message?.type === 'GET_STATE'
        ? Promise.resolve({ ok: true, activeGeneration: null })
        : defaultRuntimeSend(message)
    ));

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    expect(screen.getByText('Was this request still running?')).toBeInTheDocument();
    expect(screen.queryByText(/Thinking|Düşünüyor|DÃ¼ÅŸÃ¼nÃ¼yor/i)).not.toBeInTheDocument();
    expect(getStopButton()).toBeUndefined();
    await waitFor(() => {
      const storedSession = currentStorage.sessions.find(session => session.id === 'stale-session');
      expect(storedSession.messages).toEqual([
        expect.objectContaining({ id: 'stale-user', role: 'user' }),
      ]);
    });
  });

  it('falls back to the stored generation snapshot when bootstrap GET_STATE never responds', async () => {
    vi.useFakeTimers();
    try {
      currentStorage = {
        theme: 'light',
        startupBehavior: 'resume',
        activeSessionId: 'timeout-session',
        sessions: [{
          id: 'timeout-session',
          title: 'Interrupted request',
          updatedAt: Date.now(),
          messages: [
            { id: 'timeout-user', role: 'user', content: 'Keep my stored state' },
            {
              id: 'timeout-assistant',
              role: 'model',
              content: 'Stored partial answer',
              status: 'interrupted',
              sources: [],
            },
          ],
        }],
        activeGeneration: {
          jobId: 'timeout-job',
          requestId: 'timeout-job',
          sessionId: 'timeout-session',
          userMessageId: 'timeout-user',
          assistantMessageId: 'timeout-assistant',
          status: 'interrupted',
          revision: 2,
          content: 'Stored partial answer',
          sources: [],
          errorCode: null,
          startedAt: Date.now() - 10_000,
          updatedAt: Date.now() - 5_000,
        },
      };
      const defaultRuntimeSend = global.chrome.runtime.sendMessage.getMockImplementation();
      global.chrome.runtime.sendMessage.mockImplementation(message => (
        message?.type === 'GET_STATE'
          ? new Promise(() => {})
          : defaultRuntimeSend(message)
      ));

      render(<App />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(document.querySelector('textarea')).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(document.querySelector('textarea')).toBeInTheDocument();
      expect(screen.getByText('Stored partial answer')).toBeInTheDocument();
      expect(screen.getByText(/browser closed|Tarayıcı/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('repairs an active stored placeholder when a bootstrap GET_STATE retry returns no job', async () => {
    vi.useFakeTimers();
    try {
      currentStorage = {
        theme: 'light',
        startupBehavior: 'resume',
        activeSessionId: 'retry-session',
        sessions: [{
          id: 'retry-session',
          title: 'Retry stale generation',
          updatedAt: Date.now(),
          messages: [
            { id: 'retry-user', role: 'user', content: 'Is this still running?' },
            {
              id: 'retry-assistant',
              role: 'model',
              content: '',
              status: 'thinking',
              sources: [],
            },
          ],
        }],
        activeGeneration: {
          jobId: 'retry-job',
          requestId: 'retry-job',
          sessionId: 'retry-session',
          userMessageId: 'retry-user',
          assistantMessageId: 'retry-assistant',
          status: 'running',
          revision: 4,
          content: '',
          sources: [],
          startedAt: Date.now() - 10_000,
          updatedAt: Date.now() - 5_000,
        },
      };
      const defaultRuntimeSend = global.chrome.runtime.sendMessage.getMockImplementation();
      let getStateAttempts = 0;
      global.chrome.runtime.sendMessage.mockImplementation(message => {
        if (message?.type !== 'GET_STATE') return defaultRuntimeSend(message);
        getStateAttempts += 1;
        if (getStateAttempts === 1) return new Promise(() => {});
        return Promise.resolve({ ok: true, activeGeneration: null });
      });

      render(<App />);
      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(document.querySelector('textarea')).toBeInTheDocument();
      expect(screen.getByText(/Thinking|Düşünüyor/i)).toBeInTheDocument();
      expect(getStopButton()).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
        await Promise.resolve();
      });

      expect(getStateAttempts).toBe(2);
      expect(screen.queryByText(/Thinking|Düşünüyor/i)).not.toBeInTheDocument();
      expect(getStopButton()).toBeUndefined();
      expect(currentStorage.sessions[0].messages).toEqual([
        expect.objectContaining({ id: 'retry-user', role: 'user' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('paints the user message and thinking state before an immediately available response starts', async () => {
    api.streamChat.mockImplementationOnce(() => mockStream([
      { event: 'chunk', data: { text: 'Immediate provider answer' } },
    ]));

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea');
    fireEvent.change(input, { target: { value: 'Paint me first' } });
    fireEvent.click(getSendButton());

    expect(screen.getByText('Paint me first')).toBeInTheDocument();
    expect(screen.getByText(/Thinking|Düşünüyor/i)).toBeInTheDocument();
    expect(api.streamChat).not.toHaveBeenCalled();

    expect(await screen.findByText('Immediate provider answer')).toBeInTheDocument();
  });

  it('keeps the thinking state visible before revealing a fast response progressively', async () => {
    const fastAnswer = 'Fast responses must still arrive progressively.';
    api.streamChat.mockImplementationOnce(() => mockStream([
      { event: 'chunk', data: { text: fastAnswer } },
    ]));

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea');
    fireEvent.change(input, { target: { value: 'Keep thinking visible' } });
    fireEvent.click(getSendButton());

    await waitFor(() => expect(api.streamChat).toHaveBeenCalled());
    expect(screen.getByText(/^(Thinking|Düşünüyor)/i)).toBeInTheDocument();
    expect(screen.queryByText(fastAnswer)).not.toBeInTheDocument();

    await new Promise(resolve => setTimeout(resolve, 120));
    expect(screen.getByText(/^(Thinking|Düşünüyor)/i)).toBeInTheDocument();
    expect(screen.queryByText(fastAnswer)).not.toBeInTheDocument();

    await waitFor(() => {
      const visibleText = screen.getByTestId('assistant-content').textContent;
      expect(visibleText.length).toBeGreaterThan(0);
      expect(visibleText.length).toBeLessThan(fastAnswer.length);
    });
    expect(await screen.findByText(fastAnswer)).toBeInTheDocument();
  });

  it('keeps new message ids distinct after reopening a persisted session', async () => {
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'persisted-session',
      sessions: [{
        id: 'persisted-session',
        title: 'Persisted chat',
        updatedAt: Date.now(),
        messages: [
          { id: 0, role: 'user', content: 'Persisted question' },
          { id: 1, role: 'model', content: 'Persisted answer', status: 'done', sources: [] },
        ],
      }],
    };
    const controlled = createControlledStream();
    api.streamChat.mockImplementationOnce(() => controlled.stream);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Persisted answer')).toBeInTheDocument());

    const input = document.querySelector('textarea');
    fireEvent.change(input, { target: { value: 'Question after reopening' } });
    fireEvent.click(getSendButton());

    expect(screen.getByText('Question after reopening')).toBeInTheDocument();
    expect(screen.getByText(/Thinking|Düşünüyor/i)).toBeInTheDocument();
    expect(screen.getByText('Persisted answer')).toBeInTheDocument();

    await waitFor(() => expect(api.streamChat).toHaveBeenCalled());
    await act(async () => {
      controlled.push({ event: 'chunk', data: { text: 'Fresh answer' } });
    });

    expect(await screen.findByText('Fresh answer')).toBeInTheDocument();
    expect(screen.getByText('Persisted answer')).toBeInTheDocument();

    await act(async () => {
      controlled.finish();
    });
  });

  it('repairs duplicate legacy message ids when reopening stored sessions', async () => {
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'legacy-session',
      sessions: [{
        id: 'legacy-session',
        title: 'Legacy chat',
        updatedAt: Date.now(),
        messages: [
          { id: 0, role: 'user', content: 'Legacy question one' },
          { id: 1, role: 'model', content: 'Legacy answer one' },
          { id: 0, role: 'user', content: 'Legacy question two' },
          { id: 1, role: 'model', content: 'Legacy answer two' },
        ],
      }],
    };

    render(<App />);

    expect(await screen.findByText('Legacy answer two')).toBeInTheDocument();
    await waitFor(() => {
      const ids = currentStorage.sessions[0].messages.map(message => String(message.id));
      expect(new Set(ids).size).toBe(ids.length);
    });
    expect(currentStorage.sessions[0].messages.map(message => message.content)).toEqual([
      'Legacy question one',
      'Legacy answer one',
      'Legacy question two',
      'Legacy answer two',
    ]);
  });

  it('keeps optimistic rendering after the panel is hidden, resumed, and switched to a new chat', async () => {
    api.streamChat.mockImplementationOnce(() => mockStream([
      { event: 'chunk', data: { text: 'Answer after panel resume' } },
    ]));

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    act(() => {
      documentVisibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('freeze'));
    });
    act(() => {
      documentVisibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('resume'));
      window.dispatchEvent(new Event('pageshow'));
      window.dispatchEvent(new Event('focus'));
    });

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    const input = document.querySelector('textarea');
    fireEvent.change(input, { target: { value: 'Question after panel resume' } });
    fireEvent.click(getSendButton());

    expect(screen.getByText('Question after panel resume')).toBeInTheDocument();
    expect(screen.getByText(/Thinking|Düşünüyor/i)).toBeInTheDocument();
    expect(api.streamChat).not.toHaveBeenCalled();

    await waitFor(() => expect(api.streamChat).toHaveBeenCalled());
    expect(screen.getByText(/^(Thinking|Düşünüyor)/i)).toBeInTheDocument();
    expect(screen.queryByText('Answer after panel resume')).not.toBeInTheDocument();

    expect(await screen.findByText('Answer after panel resume')).toBeInTheDocument();
  });

  it('pauses a received response while hidden and reveals it progressively after resume', async () => {
    const longAnswer = 'Hidden panel response must be revealed across visible animation frames instead of appearing in one batch. '.repeat(6).trim();
    const controlled = createControlledStream();
    api.streamChat.mockImplementationOnce(() => controlled.stream);

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea');
    fireEvent.change(input, { target: { value: 'Hide before response' } });
    fireEvent.click(getSendButton());
    await waitFor(() => expect(api.streamChat).toHaveBeenCalled());

    act(() => {
      documentVisibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('freeze'));
    });
    await act(async () => {
      controlled.push({ event: 'chunk', data: { text: longAnswer } });
      controlled.finish();
    });

    expect(screen.getByText(/Thinking|Düşünüyor/i)).toBeInTheDocument();
    expect(screen.queryByText(longAnswer)).not.toBeInTheDocument();

    act(() => {
      documentVisibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('resume'));
      window.dispatchEvent(new Event('pageshow'));
    });

    await waitFor(() => {
      const visibleText = screen.getByTestId('assistant-content').textContent;
      expect(visibleText.length).toBeGreaterThan(0);
      expect(visibleText.length).toBeLessThan(longAnswer.length);
    });
    expect(await screen.findByText(longAnswer, {}, { timeout: 7000 })).toBeInTheDocument();
  }, 10000);

  it('preserves the same optimistic sequence after a full unmount and storage-backed remount', async () => {
    api.streamChat
      .mockImplementationOnce(() => mockStream([
        { event: 'chunk', data: { text: 'Answer before restart' } },
      ]))
      .mockImplementationOnce(() => mockStream([
        { event: 'chunk', data: { text: 'Answer after restart' } },
      ]));

    const firstMount = render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    let input = document.querySelector('textarea');
    fireEvent.change(input, { target: { value: 'Question before restart' } });
    fireEvent.click(getSendButton());
    expect(await screen.findByText('Answer before restart')).toBeInTheDocument();
    await waitFor(() => {
      expect(currentStorage.sessions.some(session => (
        session.messages?.some(message => message.content === 'Answer before restart')
      ))).toBe(true);
    });

    firstMount.unmount();
    render(<App />);
    expect(await screen.findByText('Question before restart')).toBeInTheDocument();

    input = document.querySelector('textarea');
    fireEvent.change(input, { target: { value: 'Question after restart' } });
    fireEvent.click(getSendButton());

    expect(screen.getByText('Question after restart')).toBeInTheDocument();
    expect(screen.getByText(/Thinking|Düşünüyor/i)).toBeInTheDocument();
    expect(api.streamChat).toHaveBeenCalledTimes(1);

    expect(await screen.findByText('Answer after restart')).toBeInTheDocument();
    expect(api.streamChat).toHaveBeenCalledTimes(2);
  });

  it('keeps one background job alive across two panel close-and-reopen cycles', async () => {
    const controlled = createControlledStream();
    api.streamChat.mockImplementationOnce(() => controlled.stream);

    const firstMount = render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Survive panel restarts' } });
    fireEvent.click(getSendButton());
    await waitFor(() => expect(api.streamChat).toHaveBeenCalledTimes(1));

    await act(async () => {
      controlled.push({ event: 'chunk', data: { text: 'Persistent partial response' } });
    });
    await waitFor(() => expect(currentStorage.activeGeneration?.content).toBe('Persistent partial response'));
    firstMount.unmount();

    const secondMount = render(<App />);
    expect(await screen.findByText('Survive panel restarts')).toBeInTheDocument();
    expect(await screen.findByText('Persistent partial response', {}, { timeout: 3000 })).toBeInTheDocument();
    secondMount.unmount();

    await act(async () => {
      controlled.push({ event: 'chunk', data: { text: ' completed after the second close.' } });
      controlled.finish();
    });
    await waitFor(() => expect(currentStorage.activeGeneration?.status).toBe('completed'));

    render(<App />);
    expect(await screen.findByText(
      'Persistent partial response completed after the second close.',
      {},
      { timeout: 5000 },
    )).toBeInTheDocument();
    expect(api.streamChat).toHaveBeenCalledTimes(1);
    expect(global.chrome.runtime.sendMessage.mock.calls.some(([message]) => message?.type === 'CANCEL')).toBe(false);
    await waitFor(() => expect(currentStorage.activeGeneration).toBeUndefined());
  }, 10000);

  it('reveals a large provider chunk progressively instead of displaying it all at once', async () => {
    const streamedAnswer = 'Bu cevap sağlayıcıdan büyük bir parça olarak gelse bile kullanıcıya kademeli biçimde görünmelidir. '.repeat(4).trim();
    api.streamChat.mockImplementationOnce(() => mockStream([
      { event: 'chunk', data: { text: streamedAnswer } },
    ]));

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea');
    fireEvent.change(input, { target: { value: 'Progressive response test' } });
    fireEvent.click(getSendButton());

    await waitFor(() => {
      const visibleText = screen.getByTestId('assistant-content').textContent;
      expect(visibleText.length).toBeGreaterThan(0);
      expect(visibleText.length).toBeLessThan(streamedAnswer.length);
    });

    expect(await screen.findByText(streamedAnswer, {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it('should not allow empty message to be sent', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    const sendBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-send') || btn.title?.match(/Send/i));

    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.click(sendBtn);

    expect(api.streamChat).not.toHaveBeenCalled();
  });

  it('should pass an empty Gemini key list when no API key is configured', async () => {
    api.streamChat.mockImplementationOnce(() => {
      return mockStream([{ event: 'error', data: { message: 'Gemini API key required' } }]);
    });

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    const sendBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-send') || btn.title?.match(/Send/i));

    fireEvent.change(input, { target: { value: 'Hello without keys' } });
    fireEvent.click(sendBtn);

    await waitFor(() => {
      expect(api.streamChat).toHaveBeenCalled();
    });

    expect(api.streamChat.mock.calls[0][2]).toEqual([]);
  });

  it('should combine multiple chunks and persist the user turn before the completed response', async () => {
    api.streamChat.mockImplementationOnce(() => {
      return delayedMockStream([
        { event: 'chunk', data: { text: 'Hello' } },
        { event: 'chunk', data: { text: ' from' } },
        { event: 'chunk', data: { text: ' AI' } },
      ]);
    });

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    global.chrome.storage.local.set.mockClear();

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    const sendBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-send') || btn.title?.match(/Send/i));

    fireEvent.change(input, { target: { value: 'stream test' } });
    fireEvent.click(sendBtn);

    expect(await screen.findByText('Hello from AI')).toBeInTheDocument();
    expect(screen.getAllByText('Hello from AI')).toHaveLength(1);

    const sessionWrites = global.chrome.storage.local.set.mock.calls.filter(([data]) => data?.sessions);
    expect(sessionWrites.length).toBeGreaterThanOrEqual(2);
    expect(sessionWrites[0][0].sessions[0].messages.map(message => message.content)).toEqual([
      'stream test',
      '',
    ]);
    expect(sessionWrites[0][0].sessions[0].messages.at(-1).status).toBe('thinking');
    expect(sessionWrites.at(-1)[0].sessions[0].messages.map(message => message.content)).toEqual([
      'stream test',
      'Hello from AI',
    ]);
  });

  it('should keep a new assistant response separate from the welcome card', async () => {
    api.streamChat.mockImplementationOnce(() => {
      return mockStream([{ event: 'chunk', data: { text: 'Separate response' } }]);
    });

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    const sendBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-send') || btn.title?.match(/Send/i));

    fireEvent.change(input, { target: { value: 'new card test' } });
    fireEvent.click(sendBtn);

    expect(await screen.findByText('Separate response')).toBeInTheDocument();

    const messageCards = Array.from(document.querySelectorAll('article'));
    expect(messageCards.some(card => card.textContent.includes('Merhaba') && card.textContent.includes('Separate response'))).toBe(false);
    expect(messageCards.some(card => card.textContent.includes('Separate response'))).toBe(true);
  });

  it('should include previous user and assistant turns when sending a follow-up', async () => {
    api.streamChat
      .mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'First answer' } }]))
      .mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'Second answer' } }]));

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: 'First question' } });
    fireEvent.click(getSendButton());
    expect(await screen.findByText('First answer')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'What did I ask before?' } });
    fireEvent.click(getSendButton());
    expect(await screen.findByText('Second answer')).toBeInTheDocument();

    const secondCallMessages = api.streamChat.mock.calls[1][0];
    expect(secondCallMessages.map(message => message.content)).toEqual([
      'First question',
      'First answer',
      'What did I ask before?',
    ]);
    expect(secondCallMessages[0].role).toBe('user');
    expect(secondCallMessages[1].role).toBe('model');
  });

  it('should show an assistant error state when a stream returns no chunks', async () => {
    api.streamChat.mockImplementationOnce(() => {
      return mockStream([{ event: 'error', data: { message: 'Gemini API key required' } }]);
    });

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    const sendBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-send') || btn.title?.match(/Send/i));

    fireEvent.change(input, { target: { value: 'error test' } });
    fireEvent.click(sendBtn);

    await waitFor(() => {
      expect(api.streamChat).toHaveBeenCalled();
    });

    expect(await screen.findByText(/could not be generated|oluşturulamadı/i)).toBeInTheDocument();
    expect(screen.getByText('error test')).toBeInTheDocument();
  });

  it('should allow another question after an API error event', async () => {
    api.streamChat
      .mockImplementationOnce(() => mockStream([{ event: 'error', data: { message: 'Gemini API key required' } }]))
      .mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'Recovered answer' } }]));

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    const sendBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-send') || btn.title?.match(/Send/i));

    fireEvent.change(input, { target: { value: 'first fails' } });
    fireEvent.click(sendBtn);

    await waitFor(() => expect(api.streamChat).toHaveBeenCalledTimes(1));
    await screen.findByText(/could not be generated|oluşturulamadı/i);

    fireEvent.change(input, { target: { value: 'second works' } });
    fireEvent.click(sendBtn);

    expect(await screen.findByText('Recovered answer')).toBeInTheDocument();
    expect(api.streamChat).toHaveBeenCalledTimes(2);
  });

  it('should not carry empty or failed assistant placeholders into the next request', async () => {
    api.streamChat
      .mockImplementationOnce(() => mockStream([{ event: 'error', data: { message: 'Gemini API key required' } }]))
      .mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'Clean follow-up answer' } }]));

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: 'This fails' } });
    fireEvent.click(getSendButton());
    await waitFor(() => expect(api.streamChat).toHaveBeenCalledTimes(1));
    await screen.findByText(/could not be generated|oluşturulamadı/i);

    fireEvent.change(input, { target: { value: 'Follow-up after failure' } });
    fireEvent.click(getSendButton());
    expect(await screen.findByText('Clean follow-up answer')).toBeInTheDocument();

    const secondCallMessages = api.streamChat.mock.calls[1][0];
    expect(secondCallMessages.map(message => message.content)).toEqual([
      'This fails',
      'Follow-up after failure',
    ]);
    expect(secondCallMessages.some(message => message.role === 'model' && !message.content)).toBe(false);
  });

  it('should allow another question after the API throws', async () => {
    api.streamChat
      .mockImplementationOnce(() => {
        throw new Error('network down');
      })
      .mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'Answer after throw' } }]));

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    const sendBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-send') || btn.title?.match(/Send/i));

    fireEvent.change(input, { target: { value: 'throw once' } });
    fireEvent.click(sendBtn);

    await waitFor(() => expect(api.streamChat).toHaveBeenCalledTimes(1));
    await screen.findByText(/could not be generated|oluşturulamadı/i);

    fireEvent.change(input, { target: { value: 'try again' } });
    fireEvent.click(sendBtn);

    expect(await screen.findByText('Answer after throw')).toBeInTheDocument();
    expect(api.streamChat).toHaveBeenCalledTimes(2);
  });

  it('should keep the legacy selected text context menu flow', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Existing text' } });

    triggerStorageChange({
      selectedText: {
        newValue: 'Context menu text',
      },
    });

    await waitFor(() => expect(input.value).toBe('Existing text\nContext menu text'));
    expect(api.streamChat).not.toHaveBeenCalled();
  });

  it('should keep following new assistant content when the chat is already near the bottom', async () => {
    const controlled = createControlledStream();
    api.streamChat.mockImplementationOnce(() => controlled.stream);

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const scrollContainer = document.querySelector('main');
    setScrollMetrics(scrollContainer, { scrollHeight: 1000, clientHeight: 400, scrollTop: 560 });
    fireEvent.scroll(scrollContainer);

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'follow while near bottom' } });
    fireEvent.click(getSendButton());

    await waitFor(() => expect(api.streamChat).toHaveBeenCalled());

    await act(async () => {
      controlled.push({ event: 'chunk', data: { text: 'Near bottom answer' } });
    });

    expect(await screen.findByText('Near bottom answer')).toBeInTheDocument();
    expect(scrollContainer.scrollTop).toBe(scrollContainer.scrollHeight);

    await act(async () => {
      controlled.finish();
    });
  });

  it('should scroll the chat when the mouse wheel is used over the composer area', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const scrollContainer = document.querySelector('main');
    setScrollMetrics(scrollContainer, { scrollHeight: 1200, clientHeight: 400, scrollTop: 200 });

    const composer = document.querySelector('textarea').closest('.p-4.bg-background');
    fireEvent.wheel(composer, { deltaY: 160 });

    expect(scrollContainer.scrollTop).toBe(360);
  });

  it('should stop auto-following as soon as the wheel moves upward near the bottom', async () => {
    const controlled = createControlledStream();
    api.streamChat.mockImplementationOnce(() => controlled.stream);

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const scrollContainer = document.querySelector('main');
    setScrollMetrics(scrollContainer, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'pause near bottom' } });
    fireEvent.click(getSendButton());

    await waitFor(() => expect(api.streamChat).toHaveBeenCalled());

    fireEvent.wheel(scrollContainer, { deltaY: -32 });
    scrollContainer.scrollTop = 568;
    fireEvent.scroll(scrollContainer);

    await act(async () => {
      controlled.push({ event: 'chunk', data: { text: 'Do not pull me down' } });
    });

    expect(await screen.findByText('Do not pull me down')).toBeInTheDocument();
    expect(scrollContainer.scrollTop).toBe(568);
    expect(screen.getByText(/Yeni mesajlar|New messages/i)).toBeInTheDocument();

    await act(async () => {
      controlled.finish();
    });
  });

  it('should render the user message before the first assistant chunk arrives', async () => {
    const controlled = createControlledStream();
    api.streamChat.mockImplementationOnce(() => controlled.stream);

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'show me immediately' } });
    fireEvent.click(getSendButton());

    expect(await screen.findByText('show me immediately')).toBeInTheDocument();
    expect(screen.getByText(/Thinking|D/)).toBeInTheDocument();
    expect(screen.queryByText('Delayed answer')).not.toBeInTheDocument();

    await act(async () => {
      controlled.push({ event: 'chunk', data: { text: 'Delayed answer' } });
    });

    expect(await screen.findByText('Delayed answer')).toBeInTheDocument();

    await act(async () => {
      controlled.finish();
    });
  });

  it('preserves streamed line breaks while the response is still arriving', async () => {
    const controlled = createControlledStream();
    api.streamChat.mockImplementationOnce(() => controlled.stream);

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'line break test' } });
    fireEvent.click(getSendButton());
    await waitFor(() => expect(api.streamChat).toHaveBeenCalled());

    await act(async () => {
      controlled.push({ event: 'chunk', data: { text: 'First line\nSecond line' } });
    });

    const streamedContent = await screen.findByTestId('assistant-content');
    await waitFor(() => expect(streamedContent.textContent).toBe('First line\nSecond line'));
    expect(streamedContent.querySelector('p')).not.toBeInTheDocument();

    await act(async () => {
      controlled.finish();
    });

    await waitFor(() => {
      const completedContent = screen.getByTestId('assistant-content');
      expect(completedContent.querySelector('p')).toBeInTheDocument();
      expect(completedContent.textContent).toBe('First line\nSecond line');
    });
  });

  it('should preserve partial assistant text when the stream is stopped', async () => {
    api.streamChat.mockImplementationOnce((_messages, _options, _keys, signal) => {
      return (async function* partialStream() {
        yield { event: 'chunk', data: { text: 'Partial answer' } };
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new DOMException('Aborted', 'AbortError');
            reject(error);
          });
          setTimeout(resolve, 1000);
        });
      })();
    });

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'stop after partial' } });
    fireEvent.click(getSendButton());

    expect(await screen.findByText('Partial answer')).toBeInTheDocument();
    fireEvent.click(getStopButton());

    expect(await screen.findByText(/Cancelled|ptal/)).toBeInTheDocument();
    expect(screen.getByText('Partial answer')).toBeInTheDocument();
  });

  it('should discard queued but not yet displayed text when stopped', async () => {
    const longAnswer = 'Visible response content should continue for long enough to stop the display queue before every received character is shown. '.repeat(12).trim();
    api.streamChat.mockImplementationOnce(() => mockStream([
      { event: 'chunk', data: { text: longAnswer } },
    ]));

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea');
    fireEvent.change(input, { target: { value: 'Stop the queued response' } });
    fireEvent.click(getSendButton());

    await waitFor(() => {
      const visibleText = screen.getByTestId('assistant-content').textContent;
      expect(visibleText.length).toBeGreaterThan(0);
      expect(visibleText.length).toBeLessThan(longAnswer.length);
    });

    fireEvent.click(getStopButton());

    expect(await screen.findByText(/Cancelled|ptal/)).toBeInTheDocument();
    expect(screen.queryByText(longAnswer)).not.toBeInTheDocument();
  });

  it('should preserve the reader position when assistant content streams while the user is above the bottom', async () => {
    const controlled = createControlledStream();
    api.streamChat.mockImplementationOnce(() => controlled.stream);

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const scrollContainer = document.querySelector('main');
    setScrollMetrics(scrollContainer, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'read older messages' } });
    fireEvent.click(getSendButton());

    await waitFor(() => expect(api.streamChat).toHaveBeenCalled());
    await waitFor(() => expect(scrollContainer.scrollTop).toBe(scrollContainer.scrollHeight));

    scrollContainer.scrollTop = 120;
    fireEvent.scroll(scrollContainer);

    await waitFor(() => expect(screen.getByText(/Yeni mesajlar|New messages/i)).toBeInTheDocument());

    await act(async () => {
      controlled.push({ event: 'chunk', data: { text: 'Streaming while reading' } });
    });

    expect(await screen.findByText('Streaming while reading')).toBeInTheDocument();
    expect(scrollContainer.scrollTop).toBe(120);
    expect(screen.getByText(/Yeni mesajlar|New messages/i)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Yeni mesajlar|New messages/i));

    expect(scrollContainer.scrollTop).toBe(scrollContainer.scrollHeight);
    expect(screen.queryByText(/Yeni mesajlar|New messages/i)).not.toBeInTheDocument();

    await act(async () => {
      controlled.finish();
    });
  });

  it('renders only the model selector select and no active page context controls', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    expect(document.querySelectorAll('select')).toHaveLength(1);
    expect(document.querySelector('select[data-testid="model-selector"]')).toBeInTheDocument();
    expect(document.querySelector('svg.lucide-book-open')).not.toBeInTheDocument();
  });

  it('should render web research sources as clickable source cards', async () => {
    api.streamResearch.mockImplementationOnce(() => mockStream([
      { event: 'chunk', data: { text: 'Answer with sources' } },
      {
        event: 'sources',
        data: {
          sources: [
            { index: 1, title: 'Source One', url: 'https://example.com/source-one' },
          ],
        },
      },
    ]));

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const webButton = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-globe'));
    fireEvent.click(webButton);

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'research this' } });
    fireEvent.click(getSendButton());

    expect(await screen.findByText('Answer with sources')).toBeInTheDocument();
    const sourceLink = await screen.findByText('Source One');
    expect(sourceLink.closest('a')).toHaveAttribute('href', 'https://example.com/source-one');
  });

  it('should pass previous conversation context into web research requests', async () => {
    api.streamChat.mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'Earlier answer' } }]));
    api.streamResearch.mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'Research follow-up' } }]));

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: 'Earlier question' } });
    fireEvent.click(getSendButton());
    expect(await screen.findByText('Earlier answer')).toBeInTheDocument();

    const webButton = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-globe'));
    fireEvent.click(webButton);

    fireEvent.change(input, { target: { value: 'Research that same topic' } });
    fireEvent.click(getSendButton());
    expect(await screen.findByText('Research follow-up')).toBeInTheDocument();

    const researchMessages = api.streamResearch.mock.calls[0][0];
    expect(researchMessages.map(message => message.content)).toEqual([
      'Earlier question',
      'Earlier answer',
      'Research that same topic',
    ]);
  });

  it('should keep all image attachments when a quick translate action sends a vision request', async () => {
    api.streamVision.mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'Translated all crops' } }]));
    const originalCreateElement = document.createElement.bind(document);
    const OriginalImage = global.Image;
    let canvasIndex = 0;
    global.Image = class MockImage {
      naturalWidth = 10;
      naturalHeight = 10;
      onload = null;

      set src(_value) {
        setTimeout(() => this.onload?.(), 0);
      }
    };
    document.createElement = vi.fn((tagName, options) => {
      if (tagName === 'canvas') {
        canvasIndex += 1;
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: vi.fn() }),
          toDataURL: () => `data:image/png;base64,crop-${canvasIndex}`,
        };
      }
      return originalCreateElement(tagName, options);
    });

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    emitRuntimeMessage({
      type: 'HERAAI_CROP_DONE',
      coords: { x: 0, y: 0, width: 10, height: 10, pixelRatio: 1, viewportWidth: 10, viewportHeight: 10 },
    });
    await waitFor(() => expect(screen.getByText(/screenshot-/)).toBeInTheDocument());
    emitRuntimeMessage({
      type: 'HERAAI_CROP_DONE',
      coords: { x: 0, y: 0, width: 10, height: 10, pixelRatio: 1, viewportWidth: 10, viewportHeight: 10 },
    });
    await waitFor(() => expect(screen.getAllByText(/screenshot-/)).toHaveLength(2));

    const translateButton = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-languages'));
    fireEvent.click(translateButton);

    expect(await screen.findByText('Translated all crops', {}, { timeout: 3000 })).toBeInTheDocument();
    const requestMessages = api.streamVision.mock.calls[0][0];
    const userMessage = requestMessages.at(-1);
    expect(userMessage.attachments).toHaveLength(2);
    expect(userMessage.attachments.map(att => att.data)).toEqual(['crop-1', 'crop-2']);
    expect(api.streamVision.mock.calls[0][1]).toBeNull();
    document.createElement = originalCreateElement;
    global.Image = OriginalImage;
  });

  it('should add a Gemini API key from settings', async () => {
    api.testKey.mockResolvedValue({ success: true, provider: 'gemini' });
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBeGreaterThan(0);
    });

    const geminiInput = document.querySelectorAll('input[type="password"]')[0];
    fireEvent.change(geminiInput, { target: { value: 'AIza-test-key-123456' } });

    const addBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent?.match(/Add Key|Anahtar Ekle/i));
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(currentStorage.geminiApiKeys).toHaveLength(1);
    });

    const saveBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-save'));
    expect(saveBtn).toBeInTheDocument();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(document.querySelector('textarea')).toBeInTheDocument();
    });
  });
  it('keeps OCR disabled without images and renders quick actions in the required order', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const quickActionIcons = [
      'scissors',
      'globe',
      'scan-text',
      'languages',
      'file-text',
      'lightbulb',
    ];
    const buttons = quickActionIcons.map(icon => (
      Array.from(document.querySelectorAll('button'))
        .find(button => button.querySelector(`svg.lucide-${icon}`))
    ));
    const ocrButton = buttons[2];

    expect(ocrButton).toBeDisabled();
    expect(ocrButton).toHaveAttribute('title', expect.stringMatching(/Ekli görselden metin çıkar|Extract text from image/i));
    expect(ocrButton).toHaveAttribute('aria-label', ocrButton.title);
    expect(buttons.every(Boolean)).toBe(true);
    expect(buttons.map(button => Array.from(document.querySelectorAll('button')).indexOf(button)))
      .toEqual([...buttons].map(button => Array.from(document.querySelectorAll('button')).indexOf(button)).sort((a, b) => a - b));
  });

  it('keeps OCR disabled for a document and enables it for supported image types', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('input[type="file"][accept*="image"]')).toBeInTheDocument());

    const fileInput = document.querySelector('input[type="file"][accept*="image"]');
    const getOcrButton = () => Array.from(document.querySelectorAll('button'))
      .find(button => button.querySelector('svg.lucide-scan-text'));

    fireEvent.change(fileInput, { target: { files: [new File(['text'], 'notes.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());
    expect(getOcrButton()).toBeDisabled();

    for (const [name, type] of [['scan.png', 'image/png'], ['photo.jpg', 'image/jpeg'], ['page.webp', 'image/webp']]) {
      fireEvent.change(fileInput, { target: { files: [new File(['image'], name, { type })] } });
      await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument());
      expect(getOcrButton()).toBeEnabled();
    }
  });

  it('forces OCR through Vision with a pure prompt and preserves multiple image order', async () => {
    const controlled = createControlledStream();
    api.streamVision.mockImplementationOnce(() => controlled.stream);
    render(<App />);

    await waitFor(() => expect(document.querySelector('input[type="file"][accept*="image"]')).toBeInTheDocument());

    const fileInput = document.querySelector('input[type="file"][accept*="image"]');
    fireEvent.change(fileInput, {
      target: {
        files: [
          new File(['image-1'], 'first.png', { type: 'image/png' }),
          new File(['image-2'], 'second.webp', { type: 'image/webp' }),
        ],
      },
    });
    await waitFor(() => expect(screen.getByText('second.webp')).toBeInTheDocument());

    const input = document.querySelector('textarea');
    fireEvent.change(input, { target: { value: 'translate this extra instruction' } });
    const webButton = Array.from(document.querySelectorAll('button'))
      .find(button => button.querySelector('svg.lucide-globe'));
    fireEvent.click(webButton);

    const ocrButton = Array.from(document.querySelectorAll('button'))
      .find(button => button.querySelector('svg.lucide-scan-text'));
    fireEvent.click(ocrButton);

    await waitFor(() => expect(api.streamVision).toHaveBeenCalledTimes(1));
    expect(api.streamResearch).not.toHaveBeenCalled();
    expect(ocrButton).toHaveAttribute('aria-pressed', 'true');
    expect(ocrButton).toBeDisabled();

    const userMessage = api.streamVision.mock.calls[0][0].at(-1);
    expect(userMessage.mode).toBe('vision');
    expect(userMessage.content).toMatch(/yalnızca görünen metni|only the visible text/i);
    expect(userMessage.content).toMatch(/açıklama, özet, çeviri|explanations, summaries, translations/i);
    expect(userMessage.content).toMatch(/okuma düzenini|reading order/i);
    expect(userMessage.content).toMatch(/\[okunamadı\]|\[unreadable\]/i);
    expect(userMessage.content).toMatch(/Görsel 1|Image 1/i);
    expect(userMessage.content).not.toContain('translate this extra instruction');
    expect(userMessage.attachments.map(attachment => attachment.name)).toEqual(['first.png', 'second.webp']);

    await act(async () => {
      controlled.push({ event: 'chunk', data: { text: 'Extracted OCR text' } });
      controlled.finish();
    });
    expect(await screen.findByText('Extracted OCR text', {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('renders Gemini and Tavily key inputs as type=password', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(2);
    });

    expect(document.querySelectorAll('input[type="text"]').length).toBe(0);
  });

  it('toggles a Gemini password input to text and back via the eye button', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(2);
    });

    const geminiInput = document.querySelectorAll('input[type="password"]')[0];
    const eyeBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-eye'));
    fireEvent.click(eyeBtn);

    expect(geminiInput.type).toBe('text');

    fireEvent.click(eyeBtn);
    expect(geminiInput.type).toBe('password');
  });

  it('shows the security warning banner inside the API tab', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();

    expect(await screen.findByText(/API keys are stored in this browser|API anahtarları yalnızca bu cihazdaki/i)).toBeInTheDocument();
  });

  it('writes a quota_exceeded status marker when a Tavily key test reports quota exhausted', async () => {
    api.testKey.mockResolvedValueOnce({ success: false, provider: 'tavily', errorType: 'quota' });
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(2);
    });

    const tavilyInput = document.querySelectorAll('input[type="password"]')[1];
    fireEvent.change(tavilyInput, { target: { value: 'tvly-test-key-abcdefg1234' } });

    const addButtons = Array.from(document.querySelectorAll('button')).filter(btn => btn.textContent?.match(/Add Key|Anahtar Ekle/i));
    fireEvent.click(addButtons[1]);

    await waitFor(() => {
      expect(currentStorage.tavilyApiKeys).toHaveLength(1);
    });

    const testButtons = await waitFor(() => {
      const btns = Array.from(document.querySelectorAll('button')).filter(btn => {
        const txt = (btn.textContent || '').trim();
        return txt === 'Test' || txt === 'Test Et';
      });
      expect(btns.length).toBeGreaterThan(0);
      return btns;
    });
    fireEvent.click(testButtons[0]);

    await waitFor(() => {
      const entry = currentStorage.tavilyApiKeys[0];
      expect(entry.lastErrorType).toBe('quota_exceeded');
      expect(entry.lastErrorAt).toBeGreaterThan(0);
    });
  });

  it('keeps the optimistic user message visible while blocking a cooldown request', async () => {
    currentStorage.geminiApiKeys = [{
      id: 'k1',
      key: 'AIza-cooldown-aaaaaaaaaaaa',
      masked: 'AIza...aaaa',
      isPrimary: true,
      createdAt: Date.now(),
      lastUsedAt: null,
      lastSuccessAt: null,
      lastErrorAt: Date.now() - 10000,
      lastErrorType: 'rate_limited',
      cooldownUntil: Date.now() + 90000,
      failCount: 1,
    }];

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'please answer while all keys are rate-limited' } });
    fireEvent.click(getSendButton());

    expect(await screen.findByText('please answer while all keys are rate-limited')).toBeInTheDocument();
    expect(await screen.findByText(/temporarily rate limited|geçici olarak hız sınırında/i)).toBeInTheDocument();
    expect(api.streamChat).not.toHaveBeenCalled();
  });

  it('calls testKey once per saved Gemini key when clicking Test All', async () => {
    api.testKey.mockResolvedValue({ success: true, provider: 'gemini' });
    currentStorage.selectedModel = 'gemini-3.5-flash';

    currentStorage.geminiApiKeys = [
      { id: 'k1', key: 'AIza-aaaaaaaaaaaaa-key1', masked: 'AIza...key1', isPrimary: true, createdAt: 1000 },
      { id: 'k2', key: 'AIza-bbbbbbbbbbbbbb-key2', masked: 'AIza...key2', isPrimary: false, createdAt: 2000 },
    ];

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(2);
    });

    const testAllBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent?.match(/Test All|Tümünü Test Et/i));
    fireEvent.click(testAllBtn);

    await waitFor(() => {
      expect(api.testKey).toHaveBeenCalledTimes(2);
    });
    expect(api.testKey).toHaveBeenNthCalledWith(
      1,
      'gemini',
      'AIza-aaaaaaaaaaaaa-key1',
      'gemini-3.5-flash',
    );
    expect(api.testKey).toHaveBeenNthCalledWith(
      2,
      'gemini',
      'AIza-bbbbbbbbbbbbbb-key2',
      'gemini-3.5-flash',
    );
  });

  it('moves a chosen Gemini key above the previous primary when clicking Set as Primary', async () => {
    currentStorage.geminiApiKeys = [
      { id: 'k1', key: 'AIza-aaaaaaaaaaaaa-key1', masked: 'AIza...key1', isPrimary: true, createdAt: 1000 },
      { id: 'k2', key: 'AIza-bbbbbbbbbbbbbb-key2', masked: 'AIza...key2', isPrimary: false, createdAt: 2000 },
    ];

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(2);
    });

    const keyRows = () => Array.from(document.querySelectorAll('span.font-mono'));

    await waitFor(() => {
      expect(keyRows()).toHaveLength(2);
    });
    expect(keyRows().map(el => el.textContent)).toEqual(['AIza...key1', 'AIza...key2']);

    const setPrimaryButtons = Array.from(document.querySelectorAll('button')).filter(btn => btn.textContent?.match(/Set as Primary|Birincil Yap/i));
    expect(setPrimaryButtons).toHaveLength(1);
    fireEvent.click(setPrimaryButtons[0]);

    await waitFor(() => {
      expect(keyRows().map(el => el.textContent)).toEqual(['AIza...key2', 'AIza...key1']);
    });
  });

  it('shows the Pending status pill for a freshly added Gemini key', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(2);
    });

    const geminiInput = document.querySelectorAll('input[type="password"]')[0];
    fireEvent.change(geminiInput, { target: { value: 'AIza-freshly-added-key-AAAA' } });

    const addBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent?.match(/Add Key|Anahtar Ekle/i));
    fireEvent.click(addBtn);

    expect(await screen.findByText(/^Pending$|^Bekliyor$/)).toBeInTheDocument();
  });

  it('renders the model selector below the composer with the 4 supported model ids', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const modelSelect = document.querySelector('select[data-testid="model-selector"]');
    expect(modelSelect).toBeInTheDocument();
    expect(modelSelect.closest('[data-testid="composer-meta"]')).toBeInTheDocument();

    const optionValues = Array.from(modelSelect.options).map(opt => opt.value);
    expect(optionValues).toEqual([
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
    ]);
  });

  it('defaults the selected model to DEFAULT_MODEL when storage has none', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const modelSelect = document.querySelector('select[data-testid="model-selector"]');
    expect(modelSelect.value).toBe('gemini-3.1-flash-lite');
  });

  it('passes the chosen model into streamChat on the next send', async () => {
    api.streamChat.mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'ok' } }]));
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const modelSelect = document.querySelector('select[data-testid="model-selector"]');
    fireEvent.change(modelSelect, { target: { value: 'gemini-3.5-flash' } });

    expect(modelSelect.value).toBe('gemini-3.5-flash');

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'hello with custom model' } });
    fireEvent.click(getSendButton());

    await waitFor(() => expect(api.streamChat).toHaveBeenCalled());
    expect(api.streamChat.mock.calls[0][4]).toBe('gemini-3.5-flash');

    expect(currentStorage.selectedModel).toBe('gemini-3.5-flash');
  });

  it('starts generation through the background runtime after one atomic queued-state write', async () => {
    api.streamChat.mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'Background answer' } }]));
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Persistent question' } });
    fireEvent.click(getSendButton());

    expect(await screen.findByText('Persistent question')).toBeInTheDocument();
    expect(await screen.findByText('Background answer', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(api.streamChat).toHaveBeenCalledTimes(1);

    const initialWrite = global.chrome.storage.local.set.mock.calls.find(([value]) => (
      Array.isArray(value?.sessions)
      && value?.activeGeneration?.status === 'queued'
      && value.sessions.at(-1)?.messages.at(-1)?.status === 'thinking'
    ));
    expect(initialWrite).toBeTruthy();
    const persistedMessages = initialWrite[0].sessions.at(-1).messages;
    expect(persistedMessages.at(-2).content).toBe('Persistent question');
    expect(persistedMessages.at(-1).status).toBe('thinking');
    expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'HERA_GENERATION_START',
      jobId: initialWrite[0].activeGeneration.jobId,
      sessionId: initialWrite[0].activeGeneration.sessionId,
    }));
  });

  it('does not dispatch START when New Chat cancels a local job at the pre-START barrier', async () => {
    const defaultStorageSet = global.chrome.storage.local.set.getMockImplementation();
    let releaseInitialSessionWrite;
    let blockedInitialSessionWrite = false;
    global.chrome.storage.local.set.mockImplementation((data, callback) => {
      if (
        !blockedInitialSessionWrite
        && Array.isArray(data?.sessions)
        && !data?.activeGeneration
      ) {
        blockedInitialSessionWrite = true;
        return new Promise(resolve => {
          releaseInitialSessionWrite = async () => {
            await defaultStorageSet(data, callback);
            resolve();
          };
        });
      }
      return defaultStorageSet(data, callback);
    });

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    await waitFor(() => expect(releaseInitialSessionWrite).toBeTypeOf('function'));

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Cancel before START' } });
    fireEvent.click(getSendButton());
    expect(await screen.findByText('Cancel before START')).toBeInTheDocument();
    expect(getStopButton()).toBeInTheDocument();
    expect(global.chrome.runtime.sendMessage.mock.calls.some(([message]) => (
      message?.type === 'HERA_GENERATION_START'
    ))).toBe(false);

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    await waitFor(() => expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'CANCEL',
    })));

    await act(async () => {
      await releaseInitialSessionWrite();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(currentStorage.sessions?.length).toBeGreaterThan(1));
    expect(global.chrome.runtime.sendMessage.mock.calls.some(([message]) => (
      message?.type === 'HERA_GENERATION_START'
    ))).toBe(false);
    expect(api.streamChat).not.toHaveBeenCalled();
  });

  it('preserves a session added by another panel until the worker claims START atomically', async () => {
    const controlled = createControlledStream();
    api.streamChat.mockImplementationOnce(() => controlled.stream);

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    await waitFor(() => expect(currentStorage.sessions?.length).toBe(1));

    const otherPanelSession = {
      id: 'other-panel-session',
      title: 'Other panel',
      updatedAt: Date.now(),
      messages: [{ id: 'other-panel-user', role: 'user', content: 'Keep this session' }],
    };
    currentStorage.sessions = [...currentStorage.sessions, otherPanelSession];

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Claim without stale prewrite' } });
    fireEvent.click(getSendButton());

    await waitFor(() => expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'HERA_GENERATION_START',
    })));
    await waitFor(() => expect(currentStorage.activeGeneration?.status).toBe('running'));
    expect(currentStorage.sessions.some(session => session.id === otherPanelSession.id)).toBe(true);

    const atomicClaimWrite = global.chrome.storage.local.set.mock.calls.find(([value]) => (
      value?.activeGeneration?.status === 'queued'
    ));
    expect(atomicClaimWrite?.[0].sessions.some(session => session.id === otherPanelSession.id)).toBe(true);
  });

  it('does not overwrite a job claimed by another panel when START is rejected', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const otherPanelGeneration = {
      jobId: 'other-panel-job',
      requestId: 'other-panel-job',
      sessionId: 'other-panel-session',
      userMessageId: 'other-panel-user',
      assistantMessageId: 'other-panel-assistant',
      status: 'running',
      revision: 4,
      content: 'Still running elsewhere',
      sources: [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    currentStorage.activeGeneration = otherPanelGeneration;
    global.chrome.storage.local.set.mockClear();

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Competing request' } });
    fireEvent.click(getSendButton());

    await waitFor(() => expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'HERA_GENERATION_START',
    })));
    await waitFor(() => expect(currentStorage.activeGeneration).toEqual(otherPanelGeneration));
    expect(api.streamChat).not.toHaveBeenCalled();
    expect(global.chrome.storage.local.set.mock.calls.some(([value]) => (
      value?.activeGeneration?.jobId && value.activeGeneration.jobId !== 'other-panel-job'
    ))).toBe(false);
  });

  it('resumes a completed stored generation progressively and acknowledges it after presentation', async () => {
    const sessionId = 'persisted-session';
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: sessionId,
      sessions: [{
        id: sessionId,
        title: 'Persistent',
        updatedAt: Date.now(),
        messages: [
          { id: 'user-persisted', role: 'user', content: 'Question' },
          { id: 'assistant-persisted', role: 'model', content: '', status: 'thinking', sources: [] },
        ],
      }],
      activeGeneration: {
        jobId: 'job-persisted',
        sessionId,
        userMessageId: 'user-persisted',
        assistantMessageId: 'assistant-persisted',
        model: 'gemini-3.1-flash-lite',
        mode: 'chat',
        status: 'completed',
        revision: 7,
        content: 'A naturally revealed persisted response.',
        sources: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    };

    render(<App />);
    expect(await screen.findByText('Question')).toBeInTheDocument();
    expect(screen.getByText(/Thinking|Düşünüyor/i)).toBeInTheDocument();
    expect(screen.queryByText('A naturally revealed persisted response.')).not.toBeInTheDocument();

    expect(await screen.findByText('A naturally revealed persisted response.', {}, { timeout: 3000 })).toBeInTheDocument();
    await waitFor(() => expect(global.chrome.storage.local.remove).toHaveBeenCalledWith(['activeGeneration']));
    expect(api.streamChat).not.toHaveBeenCalled();
    expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'DONE_ACK',
      jobId: 'job-persisted',
      finalRevision: 7,
    });
  });

  it('reconciles a no-op DONE_ACK and adopts the worker replacement job', async () => {
    const oldSessionId = 'ack-old-session';
    const replacementSessionId = 'ack-replacement-session';
    const oldGeneration = {
      jobId: 'ack-old-job',
      requestId: 'ack-old-job',
      sessionId: oldSessionId,
      userMessageId: 'ack-old-user',
      assistantMessageId: 'ack-old-assistant',
      model: 'gemini-3.1-flash-lite',
      mode: 'chat',
      status: 'completed',
      revision: 7,
      content: 'Old completed answer',
      sources: [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    const replacementGeneration = {
      jobId: 'ack-replacement-job',
      requestId: 'ack-replacement-job',
      sessionId: replacementSessionId,
      userMessageId: 'ack-replacement-user',
      assistantMessageId: 'ack-replacement-assistant',
      model: 'gemini-3.1-flash-lite',
      mode: 'chat',
      status: 'running',
      revision: 3,
      content: 'Authoritative replacement partial',
      sources: [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: replacementSessionId,
      sessions: [
        {
          id: oldSessionId,
          title: 'Old generation',
          updatedAt: Date.now(),
          messages: [
            { id: 'ack-old-user', role: 'user', content: 'Old question' },
            { id: 'ack-old-assistant', role: 'model', content: 'Old completed answer', status: 'streaming', sources: [] },
          ],
        },
        {
          id: replacementSessionId,
          title: 'Replacement generation',
          updatedAt: Date.now(),
          messages: [
            { id: 'ack-replacement-user', role: 'user', content: 'Replacement question' },
            { id: 'ack-replacement-assistant', role: 'model', content: '', status: 'thinking', sources: [] },
          ],
        },
      ],
      activeGeneration: oldGeneration,
    };

    const defaultRuntimeSend = global.chrome.runtime.sendMessage.getMockImplementation();
    let oldAcknowledged = false;
    global.chrome.runtime.sendMessage.mockImplementation(async message => {
      if (message?.type === 'GET_STATE') {
        return {
          ok: true,
          activeGeneration: oldAcknowledged ? replacementGeneration : oldGeneration,
        };
      }
      if (message?.type === 'DONE_ACK' && message.jobId === oldGeneration.jobId) {
        oldAcknowledged = true;
        currentStorage.activeGeneration = replacementGeneration;
        return { ok: true, removed: false, ignored: true };
      }
      return defaultRuntimeSend(message);
    });

    render(<App />);
    await waitFor(() => expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'DONE_ACK',
      jobId: oldGeneration.jobId,
      finalRevision: oldGeneration.revision,
    }));
    await waitFor(() => expect(global.chrome.runtime.sendMessage.mock.calls.filter(([message]) => (
      message?.type === 'GET_STATE'
    ))).toHaveLength(2));
    expect(await screen.findByText('Authoritative replacement partial', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(getStopButton()).toBeInTheDocument();
    expect(api.streamChat).not.toHaveBeenCalled();

    fireEvent.click(getStopButton());
    await waitFor(() => expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'CANCEL',
      jobId: replacementGeneration.jobId,
    })));
  });

  it('ignores an equal-revision duplicate snapshot instead of rewinding visible content', async () => {
    const sessionId = 'revision-session';
    const baseGeneration = {
      jobId: 'revision-job',
      requestId: 'revision-job',
      sessionId,
      userMessageId: 'revision-user',
      assistantMessageId: 'revision-assistant',
      model: 'gemini-3.1-flash-lite',
      mode: 'chat',
      status: 'running',
      revision: 0,
      content: '',
      sources: [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: sessionId,
      sessions: [{
        id: sessionId,
        title: 'Revision guard',
        updatedAt: Date.now(),
        messages: [
          { id: 'revision-user', role: 'user', content: 'Keep the newest revision' },
          { id: 'revision-assistant', role: 'model', content: '', status: 'thinking', sources: [] },
        ],
      }],
      activeGeneration: baseGeneration,
    };

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    emitRuntimeMessage({
      type: 'ACTIVE_GEN_CHANGED',
      snapshot: { ...baseGeneration, revision: 1, content: 'Authoritative snapshot' },
    });
    emitRuntimeMessage({
      type: 'ACTIVE_GEN_CHANGED',
      snapshot: { ...baseGeneration, revision: 1, content: 'Stale replacement' },
    });

    expect(await screen.findByText('Authoritative snapshot', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText('Stale replacement')).not.toBeInTheDocument();

    emitRuntimeMessage({
      type: 'DONE',
      activeGeneration: {
        ...baseGeneration,
        status: 'completed',
        revision: 2,
        content: 'Authoritative snapshot',
      },
    });
    await waitFor(() => expect(currentStorage.activeGeneration).toBeUndefined());
  });
});
