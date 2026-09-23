import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import toast from 'react-hot-toast';

import App from './App';
import * as api from './lib/api';
import {
  addKey as vaultAddKey,
  getKeys as vaultGetKeys,
  getRawKey as vaultGetRawKey,
  updateKeyMetadata as vaultUpdateKeyMetadata,
} from './lib/keyManager';
import { openVaultDatabase, resetDefaultVault } from './lib/keyVault';
import { VAULT_STORES, idbClear } from './lib/idb';
import * as audioUtils from './lib/audioUtils';
import * as voiceApi from './lib/voiceApi';
import i18n from './i18n';
import {
  DEFAULT_SYSTEM_INSTRUCTION,
  SYSTEM_INSTRUCTION_DEFAULT_VERSION,
} from './lib/systemInstruction';

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
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
  ],
  DEFAULT_MODEL: 'gemini-3.1-flash-lite',
}));

vi.mock('./lib/audioUtils', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    recordedBlobToWav: vi.fn().mockResolvedValue(new Uint8Array([82, 73, 70, 70])),
  };
});

vi.mock('./lib/voiceApi', () => ({
  generateSpeech: vi.fn(),
  transcribeAudio: vi.fn(),
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

function validImageBytes(type, label = '') {
  const suffix = Array.from(new TextEncoder().encode(label));
  if (type === 'image/jpeg') return new Uint8Array([0xff, 0xd8, 0xff, ...suffix]);
  if (type === 'image/webp') {
    return new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...suffix]);
  }
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...suffix]);
}

function getChatSurface() {
  const main = document.querySelector('main');
  if (!main) throw new Error('Chat surface is not rendered');
  return within(main);
}

async function findChatText(text, queryOptions, waitOptions) {
  const main = await waitFor(() => {
    const chatSurface = document.querySelector('main');
    if (!chatSurface) throw new Error('Chat surface is not rendered');
    return chatSurface;
  });
  return within(main).findByText(text, queryOptions, waitOptions);
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

const PROVIDER_TITLE_PATTERNS = [
  /Gemini API (Keys|Anahtarları)/i,
  /OpenRouter API (Keys|Anahtarları)/i,
  /Ollama \((No Image Support|Görsel Desteklemez)\) API (Keys|Anahtarları)/i,
  /Tavily (Search API Keys|Arama API Anahtarları)/i,
];

// Sağlayıcı kartları kapalı gelir ve içerikleri yalnız açıkken DOM'da olur;
// kart içeriğine dokunan testler önce kartı açmalı.
function expandProviderCards(patterns = PROVIDER_TITLE_PATTERNS) {
  patterns.forEach(pattern => {
    const heading = screen.getByText(pattern).closest('button');
    if (heading.getAttribute('aria-expanded') === 'false') {
      fireEvent.click(heading);
    }
  });
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

  // Aşama 6 köprüsü — üretimde anahtarlar şifreli kasada (IndexedDB) tutulur.
  // Testler `chrome.storage.local` arayüzünü kullandığı için iki yön kurulur:
  // tohumlanan anahtarlar kasaya yazılır, okumalar kasadan yapılır.
  const API_KEY_FIELDS = {
    geminiApiKeys: 'gemini',
    tavilyApiKeys: 'tavily',
    openRouterApiKeys: 'openrouter',
    ollamaApiKeys: 'ollama',
  };

  const KEY_METADATA_FIELDS = [
    'lastUsedAt', 'lastSuccessAt', 'lastErrorAt', 'lastErrorType', 'cooldownUntil', 'failCount',
  ];

  const tohumlananlar = new Set();

  const KASA_PROVIDERS = Object.values(API_KEY_FIELDS);

  /** Kasadaki kayıtlar: maskeli metadata + çözülmüş ham anahtar. */
  const readVaultKeys = async (provider) => {
    const metadata = await vaultGetKeys(provider);
    const ham = [];
    for (const kayit of metadata) {
      ham.push({ ...kayit, key: await vaultGetRawKey(provider, kayit.id) });
    }
    return ham;
  };

  const kasaOnbellek = new Map();
  let aynalamaSozu = null;

  /**
   * Kasayı arka planda aynalar. `waitFor` senkron okuduğu için `kasaOku`
   * önbellekten döner; tazeleme bir sonraki denemede görünür olur.
   */
  const kasaAynala = () => {
    if (aynalamaSozu) return aynalamaSozu;
    aynalamaSozu = (async () => {
      for (const provider of KASA_PROVIDERS) {
        kasaOnbellek.set(provider, await readVaultKeys(provider));
      }
    })().finally(() => {
      aynalamaSozu = null;
    });
    return aynalamaSozu;
  };

  const kasaOku = (provider) => {
    void kasaAynala();
    return kasaOnbellek.get(provider) || [];
  };

  const seedVaultKeys = async (provider, kayitlar) => {
    for (const kayit of kayitlar) {
      if (!kayit || typeof kayit.key !== 'string' || !kayit.key.trim()) continue;
      const imza = `${provider}:${kayit.id}`;
      if (tohumlananlar.has(imza)) continue;
      tohumlananlar.add(imza);
      try {
        await vaultAddKey(provider, kayit.key, {
          id: kayit.id,
          isPrimary: kayit.isPrimary,
          createdAt: kayit.createdAt ?? null,
        });
      } catch (error) {
        if (error?.message !== 'key_duplicate_error') throw error;
        continue;
      }
      const meta = {};
      for (const alan of KEY_METADATA_FIELDS) {
        if (kayit[alan] !== undefined) meta[alan] = kayit[alan];
      }
      if (Object.keys(meta).length > 0) await vaultUpdateKeyMetadata(provider, kayit.id, meta);
    }
  };

  /**
   * Kasa kayıtlarını temizler ama cihaz anahtarını korur: anahtar da silinirse
   * uçuştaki işlemlerle yarışıp çözülemeyen kayıtlar bırakırdı.
   */
  const kasaTemizle = async () => {
    try {
      const db = await openVaultDatabase();
      await idbClear(db, VAULT_STORES.keys);
      await idbClear(db, VAULT_STORES.syncQueue);
      db.close();
    } catch {
      // Kasa henüz oluşmamışsa yoksayılır.
    }
  };

  const readStorage = async keys => {
    const alanlar = Array.isArray(keys) ? keys : [keys];
    const sonuc = await new Promise(resolve => {
      global.chrome.storage.local.get(alanlar, result => resolve(result || {}));
    });
    for (const alan of alanlar) {
      if (API_KEY_FIELDS[alan]) sonuc[alan] = await readVaultKeys(API_KEY_FIELDS[alan]);
    }
    return sonuc;
  };

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
      ...(message.webContext ? { webContext: message.webContext } : {}),
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
        ? api.streamResearch(message.requestMessages, geminiKeys, tavilyKeys, controller.signal, message.model, options)
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

  afterEach(() => {
    resetDefaultVault();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDefaultVault();
    await kasaTemizle();
    tohumlananlar.clear();
    kasaOnbellek.clear();
    storageListeners = [];
    runtimeListeners = [];
    generationControllers = new Map();
    documentVisibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => documentVisibility,
    });
    currentStorage = { theme: 'light' };

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
          model: message.model,
        };
        const existingSession = (currentStorage.sessions || [])
          .find(session => session.id === message.sessionId);
        const nextSession = {
          ...(existingSession || {}),
          id: message.sessionId,
          title: existingSession?.isTitleCustom === true
            ? existingSession.title
            : message.sessionTitle || message.requestMessages?.find(item => item.role === 'user')?.content || 'New Chat',
          isTitleCustom: existingSession?.isTitleCustom === true,
          isStarred: existingSession?.isStarred === true,
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
    global.chrome.windows.getAll.mockResolvedValue([{ id: 1, type: 'normal' }]);
    global.chrome.windows.getCurrent.mockResolvedValue({ id: 1, type: 'normal' });
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
    audioUtils.recordedBlobToWav.mockResolvedValue(new Uint8Array([82, 73, 70, 70]));
    voiceApi.transcribeAudio.mockResolvedValue('Voice transcript');
    voiceApi.generateSpeech.mockResolvedValue({ pcm: new Uint8Array([0, 0]), sampleRate: 24000 });
  });

  afterEach(() => {
    generationControllers.forEach(controller => controller.abort());
    generationControllers.clear();
    runtimeListeners = [];
  });

  it('seeds and displays the requested default system instruction on an unmigrated install', async () => {
    render(<App />);

    await waitFor(() => {
      expect(currentStorage.systemInstruction).toBe(DEFAULT_SYSTEM_INSTRUCTION);
      expect(currentStorage.systemInstructionDefaultVersion).toBe(SYSTEM_INSTRUCTION_DEFAULT_VERSION);
    });

    await waitFor(() => {
      expect(document.querySelector('button[aria-haspopup="menu"]')).toBeInTheDocument();
    });

    openSettingsPanel();
    fireEvent.click(screen.getByRole('button', { name: /General Settings|Genel Ayarlar/i }));
    expect(screen.getByTestId('system-instruction-input')).toHaveValue(DEFAULT_SYSTEM_INSTRUCTION);
  });

  it('preserves a legacy custom system instruction while marking the migration complete', async () => {
    currentStorage = {
      theme: 'light',
      systemInstruction: 'Mevcut özel komut',
    };

    render(<App />);

    await waitFor(() => {
      expect(currentStorage.systemInstruction).toBe('Mevcut özel komut');
      expect(currentStorage.systemInstructionDefaultVersion).toBe(SYSTEM_INSTRUCTION_DEFAULT_VERSION);
    });
  });

  it('preserves an intentionally empty system instruction after migration', async () => {
    currentStorage = {
      theme: 'light',
      systemInstruction: '',
      systemInstructionDefaultVersion: SYSTEM_INSTRUCTION_DEFAULT_VERSION,
    };

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();
    fireEvent.click(screen.getByRole('button', { name: /General Settings|Genel Ayarlar/i }));
    expect(screen.getByTestId('system-instruction-input')).toHaveValue('');
    expect(currentStorage.systemInstruction).toBe('');
  });

  it('saves an edited system instruction and forwards it with the next generation', async () => {
    currentStorage = {
      theme: 'light',
      systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
      systemInstructionDefaultVersion: SYSTEM_INSTRUCTION_DEFAULT_VERSION,
    };

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();
    fireEvent.click(screen.getByRole('button', { name: /General Settings|Genel Ayarlar/i }));
    fireEvent.change(screen.getByTestId('system-instruction-input'), {
      target: { value: 'Düzenlenmiş sistem komutu' },
    });
    fireEvent.click(Array.from(document.querySelectorAll('button')).find(button => (
      button.querySelector('svg.lucide-save')
    )));

    await waitFor(() => expect(currentStorage.systemInstruction).toBe('Düzenlenmiş sistem komutu'));
    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Yeni soru' } });
    fireEvent.click(getSendButton());

    await waitFor(() => expect(api.streamChat).toHaveBeenCalled());
    expect(api.streamChat.mock.calls[0][1]).toEqual(expect.objectContaining({
      systemInstruction: 'Düzenlenmiş sistem komutu',
    }));
    const startMessage = global.chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .find(message => message?.type === 'HERA_GENERATION_START');
    expect(startMessage.systemInstruction).toBe('Düzenlenmiş sistem komutu');
  });

  it('should send a message, display it, clear input and show AI response', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    const sendBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-send') || btn.title?.match(/Send/i));

    fireEvent.change(input, { target: { value: 'Hello Gemini, fun fact.' } });
    fireEvent.click(sendBtn);

    expect(await findChatText('Hello Gemini, fun fact.')).toBeInTheDocument();
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

  it('focuses the chat textarea from composer padding without stealing interactive control focus', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea');
    const composer = input.closest('.hera-surface');
    const modelSelect = document.querySelector('button[data-testid="model-selector"]');
    modelSelect.focus();

    fireEvent.pointerDown(composer, { button: 0 });
    expect(input).toHaveFocus();

    modelSelect.focus();
    fireEvent.pointerDown(modelSelect, { button: 0 });
    expect(modelSelect).toHaveFocus();
  });

  it('leaves a plain URL paste to the textarea native insertion path', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea');
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        items: [{ type: 'text/plain', getAsFile: () => null }],
        getData: () => 'https://example.com/article',
      },
    });

    fireEvent(input, pasteEvent);
    expect(pasteEvent.defaultPrevented).toBe(false);
  });

  it('inserts mixed clipboard text at the caret and appends its supported image once', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea');
    fireEvent.change(input, { target: { value: 'before after' } });
    input.setSelectionRange(7, 12);
    const pastedImage = new File(
      [validImageBytes('image/png', 'clipboard')],
      'clipboard.png',
      { type: 'image/png' },
    );
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        items: [
          { type: 'text/plain', getAsFile: () => null },
          { type: 'image/png', getAsFile: () => pastedImage },
        ],
        getData: type => type === 'text/plain' ? 'https://example.com' : '',
      },
    });

    fireEvent(input, pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(input).toHaveValue('before https://example.com'));
    await waitFor(() => expect(screen.getAllByText(/pasted-image-/)).toHaveLength(1));
    expect(input.selectionStart).toBe('before https://example.com'.length);
    expect(input.selectionEnd).toBe('before https://example.com'.length);
  });

  it('does not let an unsupported clipboard image suppress accompanying text', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea');
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        items: [
          { type: 'text/plain', getAsFile: () => null },
          { type: 'image/gif', getAsFile: () => new File(['gif'], 'clip.gif', { type: 'image/gif' }) },
        ],
        getData: () => 'https://example.com/from-gif',
      },
    });

    fireEvent(input, pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(screen.queryByText(/pasted-image-/)).not.toBeInTheDocument();
  });

  it('adds the current page URL to the composer via the page button', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const pageButton = document.querySelector('svg.lucide-link-2')?.closest('button');
    expect(pageButton).toBeInTheDocument();
    fireEvent.click(pageButton);

    await waitFor(() => expect(document.querySelector('textarea')).toHaveValue('https://example.com/article'));
    expect(global.chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  });

  it('leaves the composer empty when the current page URL cannot be read', async () => {
    global.chrome.tabs.query.mockResolvedValueOnce([{ id: 2 }]);
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const pageButton = document.querySelector('svg.lucide-link-2')?.closest('button');
    fireEvent.click(pageButton);

    await waitFor(() => expect(global.chrome.tabs.query).toHaveBeenCalled());
    expect(document.querySelector('textarea')).toHaveValue('');
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

    expect(getChatSurface().getByText('Show this immediately')).toBeInTheDocument();
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

  it('renders the language choice as a segmented control and applies it', async () => {
    const previousLanguage = i18n.resolvedLanguage || i18n.language || 'tr';
    await i18n.changeLanguage('tr');
    currentStorage = {
      theme: 'light',
      language: 'tr',
    };

    try {
      render(<App />);
      await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

      openSettingsPanel();
      fireEvent.click(screen.getByRole('button', { name: /General Settings|Genel Ayarlar/i }));

      const group = screen.getByRole('radiogroup', { name: /Dil|Language/i });
      const options = within(group).getAllByRole('radio');
      expect(options).toHaveLength(2);
      expect(options[0]).toHaveAttribute('aria-checked', 'true');
      expect(options[1]).toHaveAttribute('aria-checked', 'false');
      expect(within(group).getByRole('radio', { name: /TR/ })).toHaveTextContent('Türkçe');
      expect(within(group).getByRole('radio', { name: /EN/ })).toHaveTextContent('English');

      fireEvent.click(options[1]);

      await waitFor(() => expect(i18n.resolvedLanguage).toBe('en'));
      expect(options[1]).toHaveAttribute('aria-checked', 'true');
      expect(options[0]).toHaveAttribute('aria-checked', 'false');
      // Seçim anında arayüz metni de değişmeli
      expect(await screen.findByRole('button', { name: /General Settings/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Genel Ayarlar/ })).toBeNull();
      // Kaydet'e basmadan kalıcı olmalı
      await waitFor(() => expect(currentStorage.language).toBe('en'));

      // Seçim bir sonraki tikte geri alınmamalı: bootstrap efektinin yeniden
      // koşması depodaki eski dili geri yazıp seçimi siliyordu.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
      expect(i18n.resolvedLanguage).toBe('en');
      expect(screen.getByRole('button', { name: /General Settings/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Genel Ayarlar/ })).toBeNull();
      // Dil değişimi bootstrap'ı yeniden koşturmamalı (eskiden koşuyordu ve
      // depodaki eski dili geri yazıyordu): GET_STATE hâlâ tek kez çağrılmış olmalı.
      expect(global.chrome.runtime.sendMessage.mock.calls.filter(([message]) => (
        message?.type === 'GET_STATE'
      ))).toHaveLength(1);
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });

  it('saves the API key usage mode picked in General Settings', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();
    fireEvent.click(screen.getByRole('button', { name: /General Settings|Genel Ayarlar/i }));

    const primary = screen.getByRole('button', { name: /Use primary keys|Ana anahtarları kullan/ });
    const rotation = screen.getByRole('button', { name: /Rotate healthy keys|Anahtarları sırayla kullan/ });
    expect(primary).toHaveAttribute('aria-pressed', 'true');
    expect(rotation).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(rotation);
    expect(rotation).toHaveAttribute('aria-pressed', 'true');
    expect(primary).toHaveAttribute('aria-pressed', 'false');

    // Seçim Kaydet'e basmadan kalıcı olmamalı; basınca depoya yazılmalı.
    expect(currentStorage.apiKeyUsageMode).not.toBe('balanced_rotation');
    fireEvent.click(screen.getByRole('button', { name: /Save and Continue|Kaydet ve Devam Et/ }));

    await waitFor(() => expect(currentStorage.apiKeyUsageMode).toBe('balanced_rotation'));
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
    let initialStorageReadStarted = false;
    global.chrome.storage.local.get.mockImplementation((keys, callback) => {
      if (!initialStorageReadStarted) {
        initialStorageReadStarted = true;
        return new Promise(resolve => {
          releaseInitialStorageRead = () => {
            if (typeof callback === 'function') callback(initialStorage);
            resolve(initialStorage);
          };
        });
      }

      if (typeof callback === 'function') callback(currentStorage);
      return Promise.resolve(currentStorage);
    });

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
      model: 'gemini-3.6-flash',
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

    expect(await findChatText('Question claimed during bootstrap')).toBeInTheDocument();
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

    const recoveredAnswer = await screen.findByText(
      'Answer persisted into the atomic session.',
      {},
      { timeout: 3000 },
    );
    expect(recoveredAnswer).toBeInTheDocument();
    expect(within(recoveredAnswer.closest('[data-testid="assistant-message"]')).getByTestId('message-model')).toHaveTextContent('Gemini 3.6 Flash');
    await waitFor(() => {
      const persistedSession = currentStorage.sessions.find(session => session.id === 'new-session');
      expect(persistedSession?.messages).toContainEqual(expect.objectContaining({
        id: 'new-assistant',
        content: 'Answer persisted into the atomic session.',
        status: 'done',
        model: 'gemini-3.6-flash',
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

    expect(await findChatText('External panel question')).toBeInTheDocument();
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

    expect(getChatSurface().getByText('Paint me first')).toBeInTheDocument();
    expect(screen.getByText(/Thinking|Düşünüyor/i)).toBeInTheDocument();
    expect(api.streamChat).not.toHaveBeenCalled();

    expect(await screen.findByText('Immediate provider answer')).toBeInTheDocument();
  });

  it('keeps the thinking state visible before revealing a fast response progressively', async () => {
    currentStorage.modelSelectionMode = 'manual';
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

    expect(getChatSurface().getByText('Question after reopening')).toBeInTheDocument();
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
    currentStorage.modelSelectionMode = 'manual';
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

    expect(getChatSurface().getByText('Question after panel resume')).toBeInTheDocument();
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
    expect(await findChatText('Question before restart')).toBeInTheDocument();

    input = document.querySelector('textarea');
    fireEvent.change(input, { target: { value: 'Question after restart' } });
    fireEvent.click(getSendButton());

    expect(getChatSurface().getByText('Question after restart')).toBeInTheDocument();
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
    expect(await findChatText('Survive panel restarts')).toBeInTheDocument();
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
  }, 10000);

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
    expect(getChatSurface().getByText('error test')).toBeInTheDocument();
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

  it('appends the page URL sent from the page context menu', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');

    triggerStorageChange({
      pendingPageUrl: {
        newValue: 'https://example.com/yazi',
      },
    });

    await waitFor(() => expect(input.value).toBe('https://example.com/yazi'));
    expect(api.streamChat).not.toHaveBeenCalled();
  });

  it('searches within the active chat from the header', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea');
    fireEvent.change(input, { target: { value: 'merhaba' } });
    fireEvent.click(getSendButton());
    await waitFor(() => expect(api.streamChat).toHaveBeenCalled());
    await screen.findByText('Hello from AI');

    fireEvent.click(screen.getByTestId('chat-search-toggle'));
    fireEvent.change(screen.getByTestId('chat-search-input'), { target: { value: 'hello' } });

    await waitFor(() => expect(screen.getByTestId('chat-search-count')).toHaveTextContent('1/1'));
    expect(screen.getByTestId('assistant-message')).toHaveAttribute('data-search-current', 'true');
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

  it('shows start and end controls only when the scroll geometry needs them', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const scrollContainer = document.querySelector('main');
    const startName = /Sohbetin başına git|Go to the start of the chat/i;
    const endName = /Sohbetin sonuna git|Go to the end of the chat/i;

    setScrollMetrics(scrollContainer, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    fireEvent.scroll(scrollContainer);
    expect(screen.queryByRole('button', { name: startName })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: endName })).toBeInTheDocument();

    scrollContainer.scrollTop = 300;
    fireEvent.scroll(scrollContainer);
    expect(screen.getByRole('button', { name: startName })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: endName })).toBeInTheDocument();

    scrollContainer.scrollTop = 600;
    fireEvent.scroll(scrollContainer);
    expect(screen.getByRole('button', { name: startName })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: endName })).not.toBeInTheDocument();

    setScrollMetrics(scrollContainer, { scrollHeight: 400, clientHeight: 400, scrollTop: 0 });
    fireEvent.scroll(scrollContainer);
    expect(screen.queryByRole('button', { name: startName })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: endName })).not.toBeInTheDocument();
  });

  it('pauses streaming auto-follow at the start and resumes it from the end control', async () => {
    const controlled = createControlledStream();
    api.streamChat.mockImplementationOnce(() => controlled.stream);
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const scrollContainer = document.querySelector('main');
    setScrollMetrics(scrollContainer, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Navigate while streaming' } });
    fireEvent.click(getSendButton());
    await waitFor(() => expect(api.streamChat).toHaveBeenCalled());

    scrollContainer.scrollTop = 300;
    fireEvent.scroll(scrollContainer);
    fireEvent.click(screen.getByRole('button', { name: /Sohbetin başına git|Go to the start of the chat/i }));
    expect(scrollContainer.scrollTop).toBe(0);

    await act(async () => {
      controlled.push({ event: 'chunk', data: { text: 'First streamed part' } });
    });
    expect(await screen.findByText('First streamed part')).toBeInTheDocument();
    expect(scrollContainer.scrollTop).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: /Sohbetin sonuna git|Go to the end of the chat/i }));
    expect(scrollContainer.scrollTop).toBe(scrollContainer.scrollHeight);

    await act(async () => {
      controlled.push({ event: 'chunk', data: { text: ' and second part' } });
    });
    await waitFor(() => expect(scrollContainer.scrollTop).toBe(scrollContainer.scrollHeight));
    await act(async () => controlled.finish());
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
    expect(screen.getByRole('button', { name: /Sohbetin sonuna git|Go to the end of the chat/i })).toBeInTheDocument();

    await act(async () => {
      controlled.finish();
    });
  });

  it('should render the user message before the first assistant chunk arrives', async () => {
    currentStorage.modelSelectionMode = 'manual';
    const controlled = createControlledStream();
    api.streamChat.mockImplementationOnce(() => controlled.stream);

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'show me immediately' } });
    fireEvent.click(getSendButton());

    expect(await findChatText('show me immediately')).toBeInTheDocument();
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

    await waitFor(() => expect(screen.getByRole('button', { name: /Sohbetin sonuna git|Go to the end of the chat/i })).toBeInTheDocument());

    await act(async () => {
      controlled.push({ event: 'chunk', data: { text: 'Streaming while reading' } });
    });

    expect(await screen.findByText('Streaming while reading')).toBeInTheDocument();
    expect(scrollContainer.scrollTop).toBe(120);
    expect(screen.getByRole('button', { name: /Sohbetin sonuna git|Go to the end of the chat/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Sohbetin sonuna git|Go to the end of the chat/i }));

    expect(scrollContainer.scrollTop).toBe(scrollContainer.scrollHeight);
    expect(screen.queryByRole('button', { name: /Sohbetin sonuna git|Go to the end of the chat/i })).not.toBeInTheDocument();

    await act(async () => {
      controlled.finish();
    });
  });

  it('renders only the model selector button and no active page context controls', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    expect(document.querySelectorAll('select')).toHaveLength(0);
    expect(document.querySelector('button[data-testid="model-selector"]')).toBeInTheDocument();
    expect(document.querySelector('svg.lucide-book-open')).not.toBeInTheDocument();
  });

  it('should render web research sources as clickable source cards', async () => {
    currentStorage.showSources = true;
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

  it('keeps source data hidden by default and shows existing source cards after saving the setting', async () => {
    api.streamResearch.mockImplementationOnce(() => mockStream([
      { event: 'chunk', data: { text: 'Answer with citation [1]' } },
      {
        event: 'sources',
        data: {
          sources: [
            { index: 1, title: 'Hidden Source', url: 'https://example.com/hidden-source' },
          ],
        },
      },
    ]));

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const webButton = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-globe'));
    fireEvent.click(webButton);
    fireEvent.change(document.querySelector('textarea'), { target: { value: 'research privately' } });
    fireEvent.click(getSendButton());

    expect(await screen.findByText('Answer with citation [1]')).toBeInTheDocument();
    expect(screen.queryByText('Hidden Source')).not.toBeInTheDocument();

    openSettingsPanel();
    fireEvent.click(screen.getByRole('button', { name: /General Settings|Genel Ayarlar/i }));
    fireEvent.click(screen.getByRole('switch', { name: /Show Sources|Kaynakları Göster/i }));
    fireEvent.click(Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-save')));

    const sourceLink = await screen.findByText('Hidden Source');
    expect(sourceLink.closest('a')).toHaveAttribute('href', 'https://example.com/hidden-source');
    expect(currentStorage.showSources).toBe(true);
    expect(screen.getByText('Answer with citation [1]')).toBeInTheDocument();
    expect(api.streamResearch).toHaveBeenCalledTimes(1);
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

  it('routes public URLs per request and reuses them only when explicitly requested', async () => {
    api.streamResearch
      .mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'Page summary' } }]))
      .mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'Independent follow-up' } }]))
      .mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'Previous page follow-up' } }]));

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    const input = document.querySelector('textarea');
    const webButton = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-globe'));
    fireEvent.click(webButton);
    fireEvent.change(input, { target: { value: 'https://example.com/article' } });
    fireEvent.click(getSendButton());
    expect(await screen.findByText('Page summary')).toBeInTheDocument();

    expect(api.streamResearch.mock.calls[0][5].webContext).toEqual({
      kind: 'url',
      urls: ['https://example.com/article'],
    });
    expect(screen.getAllByText('https://example.com/article').length).toBeGreaterThanOrEqual(2);

    fireEvent.change(input, { target: { value: 'What is the main conclusion?' } });
    fireEvent.click(getSendButton());
    expect(await screen.findByText('Independent follow-up')).toBeInTheDocument();
    expect(api.streamResearch.mock.calls[1][5].webContext.urls).toEqual([]);

    fireEvent.change(input, { target: { value: 'Önceki linkteki ana sonucu kontrol et' } });
    fireEvent.click(getSendButton());
    expect(await screen.findByText('Previous page follow-up')).toBeInTheDocument();
    expect(api.streamResearch.mock.calls[2][5].webContext.urls).toEqual(['https://example.com/article']);
  });

  it('shows individual draft URL removal controls and preserves the remaining prompt', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    const input = document.querySelector('textarea');
    const webButton = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-globe'));
    fireEvent.click(webButton);
    fireEvent.change(input, {
      target: {
        value: 'Compare [first](https://example.com/a) with https://example.com/b and keep this text.',
      },
    });

    const removeButtons = screen.getAllByRole('button', { name: /Remove link|Bağlantıyı kaldır/i });
    expect(removeButtons).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Clear pages|Sayfaları temizle/i })).not.toBeInTheDocument();

    fireEvent.click(removeButtons[0]);
    expect(input).toHaveValue('Compare with https://example.com/b and keep this text.');
    expect(screen.getAllByRole('button', { name: /Remove link|Bağlantıyı kaldır/i })).toHaveLength(1);
  });

  it('automatically reads a pasted page URL without the research toggle', async () => {
    api.streamResearch.mockImplementationOnce(() => mockStream([
      { event: 'chunk', data: { text: 'Auto page summary' } },
    ]));

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    const input = document.querySelector('textarea');
    fireEvent.change(input, { target: { value: 'https://example.com/article özetle' } });
    fireEvent.click(getSendButton());

    expect(await screen.findByText('Auto page summary')).toBeInTheDocument();
    expect(api.streamResearch).toHaveBeenCalledTimes(1);
    expect(api.streamResearch.mock.calls[0][5].webContext).toEqual({
      kind: 'url',
      urls: ['https://example.com/article'],
    });
  });

  it('routes time-sensitive questions to automatic search without the research toggle', async () => {
    api.streamResearch.mockImplementationOnce(() => mockStream([
      { event: 'chunk', data: { text: 'Auto search answer' } },
    ]));

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    const input = document.querySelector('textarea');
    fireEvent.change(input, { target: { value: 'Bugün dolar kuru ne kadar?' } });
    fireEvent.click(getSendButton());

    expect(await screen.findByText('Auto search answer')).toBeInTheDocument();
    expect(api.streamResearch).toHaveBeenCalledTimes(1);
    expect(api.streamResearch.mock.calls[0][5].webContext).toEqual({
      kind: 'search',
      urls: [],
      searchMode: 'auto',
    });
    expect(api.streamChat).not.toHaveBeenCalled();
  });

  it('marks toggle-driven search as explicit so it keeps using Tavily', async () => {
    api.streamResearch.mockImplementationOnce(() => mockStream([
      { event: 'chunk', data: { text: 'Explicit search answer' } },
    ]));

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    const input = document.querySelector('textarea');
    const webButton = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-globe'));
    fireEvent.click(webButton);
    fireEvent.change(input, { target: { value: 'Bana bir masal anlat' } });
    fireEvent.click(getSendButton());

    expect(await screen.findByText('Explicit search answer')).toBeInTheDocument();
    expect(api.streamResearch.mock.calls[0][5].webContext).toEqual({
      kind: 'search',
      urls: [],
      searchMode: 'explicit',
    });
  });

  it('does not retain a previous image for an independent vision follow-up', async () => {
    api.streamVision
      .mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'First file answer' } }]))
      .mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'File follow-up answer' } }]))
      .mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'Previous image answer' } }]));
    render(<App />);
    await waitFor(() => expect(document.querySelector('input[type="file"][accept*="image"]')).toBeInTheDocument());

    const input = document.querySelector('textarea');
    const composer = input.closest('.hera-surface');
    const fileInput = document.querySelector('input[type="file"][accept*="image"]');
    fireEvent.change(fileInput, {
      target: {
        files: [new File([validImageBytes('image/png', 'context')], 'context.png', { type: 'image/png' })],
      },
    });
    await waitFor(() => expect(within(composer).getByText('context.png')).toBeInTheDocument());
    fireEvent.change(input, { target: { value: 'Inspect this file' } });
    fireEvent.click(getSendButton());
    expect(await screen.findByText('First file answer')).toBeInTheDocument();

    expect(within(composer).queryByText('context.png')).not.toBeInTheDocument();
    expect(screen.getAllByText('context.png')).toHaveLength(1);

    fireEvent.change(fileInput, {
      target: {
        files: [new File([validImageBytes('image/png', 'second-context')], 'second-context.png', { type: 'image/png' })],
      },
    });
    await waitFor(() => expect(within(composer).getByText('second-context.png')).toBeInTheDocument());
    fireEvent.change(input, { target: { value: 'Inspect this second file' } });
    fireEvent.click(getSendButton());
    expect(await screen.findByText('File follow-up answer')).toBeInTheDocument();
    expect(api.streamVision).toHaveBeenCalledTimes(2);
    const followUpMessage = api.streamVision.mock.calls[1][0].at(-1);
    expect(followUpMessage.attachments).toEqual([
      expect.objectContaining({ name: 'second-context.png', mimeType: 'image/png' }),
    ]);
    expect(followUpMessage.attachments).not.toEqual([
      expect.objectContaining({ name: 'context.png', mimeType: 'image/png' }),
    ]);
    expect(screen.getAllByText('context.png')).toHaveLength(1);

    fireEvent.change(input, { target: { value: 'Önceki görseldeki ayrıntıyı açıkla' } });
    fireEvent.click(getSendButton());
    expect(await screen.findByText('Previous image answer')).toBeInTheDocument();
    expect(api.streamVision).toHaveBeenCalledTimes(3);
    expect(api.streamVision.mock.calls[2][0].at(-1).attachments).toEqual([
      expect.objectContaining({ name: 'second-context.png', mimeType: 'image/png' }),
    ]);
  });

  it('accepts dropped files across the chat panel and appends them to the draft', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('input[type="file"][accept*="image"]')).toBeInTheDocument());
    const fileInput = document.querySelector('input[type="file"][accept*="image"]');
    const panel = document.querySelector('.hera-panel');
    const firstFile = new File([validImageBytes('image/png', 'first')], 'first.png', { type: 'image/png' });
    const secondFile = new File([validImageBytes('image/webp', 'second')], 'second.webp', { type: 'image/webp' });

    fireEvent.change(fileInput, { target: { files: [firstFile] } });
    await waitFor(() => expect(screen.getByText('first.png')).toBeInTheDocument());

    const dataTransfer = { types: ['Files'], files: [secondFile], dropEffect: 'none' };
    fireEvent.dragEnter(panel, { dataTransfer });
    expect(screen.getByTestId('file-drop-overlay')).toBeInTheDocument();
    fireEvent.drop(panel, { dataTransfer });

    await waitFor(() => expect(screen.getByText('second.webp')).toBeInTheDocument());
    expect(screen.getByText('first.png')).toBeInTheDocument();
    expect(screen.queryByTestId('file-drop-overlay')).not.toBeInTheDocument();

    fireEvent.dragEnter(panel, { dataTransfer: { types: ['text/plain'], files: [] } });
    expect(screen.queryByTestId('file-drop-overlay')).not.toBeInTheDocument();
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
    expect(userMessage.attachments.map(att => att.id)).toEqual([
      expect.any(String),
      expect.any(String),
    ]);
    expect(userMessage.attachments.every(att => att.data == null)).toBe(true);
    expect(api.streamVision.mock.calls[0][1]).toBeNull();
    document.createElement = originalCreateElement;
    global.Image = OriginalImage;
  });

  it('should add a Gemini API key from settings', async () => {
    api.testKey.mockResolvedValue({ success: true, provider: 'gemini' });
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();
    expandProviderCards([PROVIDER_TITLE_PATTERNS[0]]);

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBeGreaterThan(0);
    });

    const geminiInput = document.querySelectorAll('input[type="password"]')[0];
    fireEvent.change(geminiInput, { target: { value: 'AIza-test-key-123456' } });

    const addBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent?.match(/Add Key|Anahtar Ekle/i));
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(kasaOku('gemini')).toHaveLength(1);
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
      'text-align-start',
      'lightbulb',
    ];
    const composer = document.querySelector('textarea').closest('.hera-surface');
    const buttons = quickActionIcons.map(icon => (
      Array.from(composer.querySelectorAll('button'))
        .find(button => button.querySelector(`svg.lucide-${icon}`))
    ));
    const ocrButton = buttons[2];

    expect(ocrButton).toBeDisabled();
    expect(ocrButton).toHaveAttribute('title', expect.stringMatching(/Ekli görselden metin çıkar|Extract text from image/i));
    expect(ocrButton).toHaveAttribute('aria-label', ocrButton.title);
    expect(buttons.every(Boolean)).toBe(true);
    expect(buttons.map(button => Array.from(composer.querySelectorAll('button')).indexOf(button)))
      .toEqual([...buttons].map(button => Array.from(composer.querySelectorAll('button')).indexOf(button)).sort((a, b) => a - b));
  });

  it('renders voice input before the comparison button', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const composer = document.querySelector('textarea').closest('.hera-surface');
    const buttons = Array.from(composer.querySelectorAll('button'));
    const micIndex = buttons.findIndex(button => button.querySelector('svg.lucide-mic'));
    const compareIndex = buttons.findIndex(button => button.querySelector('svg.lucide-columns-2'));
    expect(micIndex).toBeGreaterThanOrEqual(0);
    expect(compareIndex).toBeGreaterThanOrEqual(0);
    expect(micIndex).toBeLessThan(compareIndex);
  });

  it('toggles an active screen selection off with the same crop button', async () => {
    await i18n.changeLanguage('en');
    global.chrome.scripting.executeScript
      .mockResolvedValueOnce([{ result: { active: true, existing: false, requestId: 'crop-request-1' } }])
      .mockResolvedValueOnce([{ result: { active: false, cancelled: true, requestId: 'crop-request-1' } }]);

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const cropButton = screen.getByRole('button', { name: 'Select an area on screen' });
    expect(cropButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(cropButton);

    await waitFor(() => expect(cropButton).toHaveAttribute('aria-pressed', 'true'));
    expect(cropButton).toHaveAccessibleName('Cancel area selection');
    expect(screen.getByRole('button', { name: /Cancel selection/i })).toHaveAttribute('aria-pressed', 'true');
    expect(global.chrome.scripting.executeScript.mock.calls[0][0].func.name).toBe('injectCropOverlay');
    expect(global.chrome.scripting.executeScript.mock.calls[0][0].target).toEqual({ tabId: 1 });
    await waitFor(() => expect(currentStorage.stats?.lifetime?.tools?.screenshot).toBe(1));

    global.chrome.tabs.query.mockResolvedValue([{ id: 99, url: 'https://example.com/another-tab' }]);
    fireEvent.click(cropButton);

    await waitFor(() => expect(cropButton).toHaveAttribute('aria-pressed', 'false'));
    expect(cropButton).toHaveAccessibleName('Select an area on screen');
    expect(global.chrome.scripting.executeScript).toHaveBeenCalledTimes(2);
    expect(global.chrome.scripting.executeScript.mock.calls[1][0]).toMatchObject({
      target: { tabId: 1 },
      args: ['crop-request-1'],
    });
    expect(global.chrome.scripting.executeScript.mock.calls[1][0].func.name).toBe('cancelCropOverlay');
    expect(currentStorage.stats.lifetime.tools.screenshot).toBe(1);
  });

  it('honors the second crop-button click while overlay injection is still pending', async () => {
    await i18n.changeLanguage('en');
    let resolveInjection;
    const pendingInjection = new Promise(resolve => {
      resolveInjection = resolve;
    });
    global.chrome.scripting.executeScript
      .mockImplementationOnce(() => pendingInjection)
      .mockResolvedValueOnce([{ result: { active: false, cancelled: true } }]);

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const cropButton = screen.getByRole('button', { name: 'Select an area on screen' });
    fireEvent.click(cropButton);

    await waitFor(() => expect(global.chrome.scripting.executeScript).toHaveBeenCalledTimes(1));
    expect(cropButton).toHaveAttribute('aria-pressed', 'true');
    const requestId = global.chrome.scripting.executeScript.mock.calls[0][0].args[2];

    fireEvent.click(cropButton);

    expect(cropButton).toHaveAttribute('aria-pressed', 'false');
    expect(global.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInjection([{
        result: { active: true, existing: false, requestId },
      }]);
      await pendingInjection;
    });

    await waitFor(() => expect(global.chrome.scripting.executeScript).toHaveBeenCalledTimes(2));
    expect(global.chrome.scripting.executeScript.mock.calls[1][0]).toMatchObject({
      target: { tabId: 1 },
      args: [requestId],
    });
    expect(global.chrome.scripting.executeScript.mock.calls[1][0].func.name).toBe('cancelCropOverlay');
    expect(cropButton).toHaveAccessibleName('Select an area on screen');
    expect(cropButton).toHaveAttribute('aria-pressed', 'false');
  });

  it('clears the crop button when the page cancels the active selection', async () => {
    await i18n.changeLanguage('en');
    global.chrome.scripting.executeScript.mockResolvedValueOnce([{
      result: { active: true, existing: false, requestId: 'crop-page-cancel' },
    }]);

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const cropButton = screen.getByRole('button', { name: 'Select an area on screen' });
    fireEvent.click(cropButton);
    await waitFor(() => expect(cropButton).toHaveAttribute('aria-pressed', 'true'));

    emitRuntimeMessage({ type: 'HERAAI_CROP_CANCELLED', requestId: 'another-panel-crop' });
    expect(cropButton).toHaveAttribute('aria-pressed', 'true');

    emitRuntimeMessage({ type: 'HERAAI_CROP_CANCELLED', requestId: 'crop-page-cancel' });

    await waitFor(() => expect(cropButton).toHaveAttribute('aria-pressed', 'false'));
    expect(cropButton).toHaveAccessibleName('Select an area on screen');
    expect(global.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
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
      fireEvent.change(fileInput, { target: { files: [new File([validImageBytes(type)], name, { type })] } });
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
          new File([validImageBytes('image/png', 'image-1')], 'first.png', { type: 'image/png' }),
          new File([validImageBytes('image/webp', 'image-2')], 'second.webp', { type: 'image/webp' }),
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
    expect(userMessage.displayContent).toBe('');
    expect(userMessage.content).toMatch(/yalnızca görünen metni|only the visible text/i);
    expect(userMessage.content).toMatch(/açıklama, özet, çeviri|explanations, summaries, translations/i);
    expect(userMessage.content).toMatch(/okuma düzenini|reading order/i);
    expect(userMessage.content).toMatch(/\[okunamadı\]|\[unreadable\]/i);
    expect(userMessage.content).toMatch(/Görsel 1|Image 1/i);
    expect(userMessage.content).not.toContain('translate this extra instruction');
    expect(userMessage.attachments.map(attachment => attachment.name)).toEqual(['first.png', 'second.webp']);
    expect(screen.queryByText(userMessage.content)).not.toBeInTheDocument();
    await waitFor(() => expect(currentStorage.sessions.some(session => (
      session.messages?.some(message => (
        message.id === userMessage.id
        && message.content === userMessage.content
        && message.displayContent === ''
      ))
    ))).toBe(true));

    await act(async () => {
      controlled.push({ event: 'chunk', data: { text: 'Extracted OCR text' } });
      controlled.finish();
    });
    expect(await screen.findByText('Extracted OCR text', {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('migrates a previously stored OCR prompt without exposing its message or automatic title', async () => {
    await i18n.changeLanguage('en');
    const legacyPrompt = 'Extract only the visible text from the attached image or images. Do not add explanations, summaries, translations, interpretations, or any text that is not visible. Preserve headings, paragraphs, lists, line order, and reading order as closely as possible. Mark every unreadable section as [unreadable]. If there is more than one image, process them in attachment order and separate the results with the headings Image 1, Image 2, and so on.';
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'legacy-ocr-session',
      sessions: [{
        id: 'legacy-ocr-session',
        title: `${legacyPrompt.slice(0, 30)}...`,
        isTitleCustom: false,
        updatedAt: 100,
        messages: [
          {
            id: 'legacy-ocr-user',
            role: 'user',
            content: legacyPrompt,
            attachments: [{ name: 'legacy-scan.png', mimeType: 'image/png', data: 'legacy-image' }],
          },
          { id: 'legacy-ocr-answer', role: 'model', content: 'Stored extracted text' },
        ],
      }],
    };

    render(<App />);

    expect(await screen.findByText('Stored extracted text')).toBeInTheDocument();
    expect(screen.queryByText(legacyPrompt)).not.toBeInTheDocument();
    expect(screen.getByTitle('New Chat')).toBeInTheDocument();
    await waitFor(() => expect(currentStorage.sessions[0]).toMatchObject({
      title: 'New Chat',
      messages: [
        expect.objectContaining({ id: 'legacy-ocr-user', displayContent: '' }),
        expect.objectContaining({ id: 'legacy-ocr-answer' }),
      ],
    }));
  });

  it('renders provider API keys as passwords and names as text inputs', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();
    expandProviderCards();

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(4);
    });

    const nameInputs = Array.from(document.querySelectorAll('input[maxlength="60"]'));
    expect(nameInputs).toHaveLength(4);
    expect(nameInputs.every(input => input.type === 'text')).toBe(true);
  });

  it('toggles a Gemini password input to text and back via the eye button', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();
    expandProviderCards();

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(4);
    });

    const geminiInput = document.querySelectorAll('input[type="password"]')[0];
    const eyeBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-eye'));
    fireEvent.click(eyeBtn);

    expect(geminiInput.type).toBe('text');

    fireEvent.click(eyeBtn);
    expect(geminiInput.type).toBe('password');
  });

  it('does not show the removed API and voice information texts', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();

    expect(screen.queryByText(/API keys are stored in this browser|API anahtarları yalnızca bu cihazdaki/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Key tests send a small real request|Anahtar testleri küçük bir gerçek istek/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/This applies to every provider|Bu seçim bütün sağlayıcılara/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/API key usage mode|API anahtarı kullanım biçimi/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/General Settings|Genel Ayarlar/i));
    expect(screen.queryByText(/Voice features use your Gemini API key|Ses özellikleri Gemini API/i)).not.toBeInTheDocument();
    expect(screen.getByText(/API key usage mode|API anahtarı kullanım biçimi/i)).toBeInTheDocument();
  });

  it('separates API providers into collapsible cards and links to every key portal', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    openSettingsPanel();

    const providerHeadings = PROVIDER_TITLE_PATTERNS.map(pattern => screen.getByText(pattern).closest('button'));

    expect(providerHeadings.map(button => button.getAttribute('aria-expanded'))).toEqual([
      'false',
      'false',
      'false',
      'false',
    ]);
    // Kapalı kartın içeriği DOM'da hiç bulunmaz; `hidden` özniteliği tek başına
    // yetmiyordu (display sınıfı onu ezip paneli açık bırakıyordu).
    expect(document.querySelector('a[href="https://aistudio.google.com/api-keys"]')).toBeNull();

    fireEvent.click(providerHeadings[1]);
    expect(providerHeadings[0]).toHaveAttribute('aria-expanded', 'false');
    expect(providerHeadings[1]).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(providerHeadings[0]);
    expect(providerHeadings[0]).toHaveAttribute('aria-expanded', 'true');
    expect(providerHeadings[1]).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(providerHeadings[0]);
    expect(providerHeadings[0]).toHaveAttribute('aria-expanded', 'false');
    expect(providerHeadings[1]).toHaveAttribute('aria-expanded', 'true');
    expect(document.querySelector('a[href="https://aistudio.google.com/api-keys"]')).toBeNull();

    expandProviderCards();

    const expectedLinks = [
      ['https://aistudio.google.com/api-keys', /Gemini/i],
      ['https://openrouter.ai/settings/keys', /OpenRouter/i],
      ['https://ollama.com/settings/keys', /Ollama/i],
      ['https://app.tavily.com/home', /Tavily/i],
    ];
    for (const [href, label] of expectedLinks) {
      const link = document.querySelector(`a[href="${href}"]`);
      expect(link).toBeInTheDocument();
      expect(link).toHaveTextContent(label);
      expect(link).toHaveAttribute('target', '_blank');
    }

    expect(screen.queryByText(/free-model router|ücretsiz model yönlendiricisini/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/high-usage model|yüksek kullanım sınıfındaki model/i)).not.toBeInTheDocument();
  });

  it('writes a quota_exceeded status marker when a Tavily key test reports quota exhausted', async () => {
    api.testKey.mockResolvedValueOnce({ success: false, provider: 'tavily', errorType: 'quota' });
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();
    expandProviderCards();

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(4);
    });

    const tavilyInput = document.querySelectorAll('input[type="password"]')[3];
    fireEvent.change(tavilyInput, { target: { value: 'tvly-test-key-abcdefg1234' } });

    const addButtons = Array.from(document.querySelectorAll('button')).filter(btn => btn.textContent?.match(/Add Key|Anahtar Ekle/i));
    fireEvent.click(addButtons[3]);

    await waitFor(() => {
      expect(kasaOku('tavily')).toHaveLength(1);
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
      const entry = kasaOku('tavily')[0];
      expect(entry.lastErrorType).toBe('quota_exceeded');
      expect(entry.lastErrorAt).toBeGreaterThan(0);
    });
  });

  it('keeps the optimistic user message visible while blocking a cooldown request', async () => {
    await seedVaultKeys('gemini', [{
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
    }]);

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'please answer while all keys are rate-limited' } });
    fireEvent.click(getSendButton());

    expect(await findChatText('please answer while all keys are rate-limited')).toBeInTheDocument();
    expect(await screen.findByText(/temporarily rate limited|geçici olarak hız sınırında/i)).toBeInTheDocument();
    expect(api.streamChat).not.toHaveBeenCalled();
  });

  it('calls testKey once per saved Gemini key when clicking Test All', async () => {
    api.testKey.mockResolvedValue({ success: true, provider: 'gemini' });
    currentStorage.selectedModel = 'gemini-3.6-flash';

    await seedVaultKeys('gemini', [
      { id: 'k1', key: 'AIza-aaaaaaaaaaaaa-key1', masked: 'AIza...key1', isPrimary: true, createdAt: 1000 },
      { id: 'k2', key: 'AIza-bbbbbbbbbbbbbb-key2', masked: 'AIza...key2', isPrimary: false, createdAt: 2000 },
    ]);

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();
    expandProviderCards();

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(4);
    });

    const testAllBtn = await waitFor(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.match(/Test All|Tümünü Test Et/i));
      expect(btn).toBeTruthy();
      return btn;
    });
    fireEvent.click(testAllBtn);

    await waitFor(() => {
      expect(api.testKey).toHaveBeenCalledTimes(2);
    });
    expect(api.testKey).toHaveBeenNthCalledWith(
      1,
      'gemini',
      'AIza-aaaaaaaaaaaaa-key1',
      'gemini-3.6-flash',
    );
    expect(api.testKey).toHaveBeenNthCalledWith(
      2,
      'gemini',
      'AIza-bbbbbbbbbbbbbb-key2',
      'gemini-3.6-flash',
    );
  });

  it('moves a chosen Gemini key above the previous primary when clicking Set as Primary', async () => {
    await seedVaultKeys('gemini', [
      { id: 'k1', key: 'AIza-aaaaaaaaaaaaa-key1', masked: 'AIza...key1', isPrimary: true, createdAt: 1000 },
      { id: 'k2', key: 'AIza-bbbbbbbbbbbbbb-key2', masked: 'AIza...key2', isPrimary: false, createdAt: 2000 },
    ]);

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();
    expandProviderCards();

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(4);
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

  it('keeps large API key pools inside a compact scrollable list', async () => {
    await seedVaultKeys('gemini', Array.from({ length: 12 }, (_, index) => ({
      id: `key-${index + 1}`,
      key: `AIza-${String(index + 1).padStart(2, '0')}-aaaaaaaaaaaa`,
      masked: `AIza...${String(index + 1).padStart(2, '0')}`,
      isPrimary: index === 0,
      createdAt: 1000 + index,
    })));

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    openSettingsPanel();
    fireEvent.click(screen.getByText(/Gemini API (Keys|Anahtarları)/i).closest('button'));

    const keyList = await screen.findByTestId('gemini-key-list');
    expect(keyList).toHaveClass('max-h-64', 'overflow-y-auto');
    expect(within(keyList).getAllByTestId('api-key-row')).toHaveLength(12);
    expect(within(keyList).getAllByRole('button', { name: /Test|Test Et/i })).toHaveLength(12);
    expect(within(keyList).getAllByRole('button', { name: /Delete|Sil/i })).toHaveLength(12);
  });

  it('shows the Pending status pill for a freshly added Gemini key', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    openSettingsPanel();
    expandProviderCards();

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(4);
    });

    const geminiInput = document.querySelectorAll('input[type="password"]')[0];
    fireEvent.change(geminiInput, { target: { value: 'AIza-freshly-added-key-AAAA' } });

    const addBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent?.match(/Add Key|Anahtar Ekle/i));
    fireEvent.click(addBtn);

    expect(await screen.findByText(/^Pending$|^Bekliyor$/)).toBeInTheDocument();
  });

  it('saves and displays an optional name while adding an API key', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    openSettingsPanel();
    fireEvent.click(screen.getByText(/Gemini API (Keys|Anahtarları)/i).closest('button'));

    const nameInputs = screen.getAllByRole('textbox', { name: /Key name|Anahtar adı/i });
    const geminiInput = document.querySelectorAll('input[type="password"]')[0];
    fireEvent.change(nameInputs[0], { target: { value: 'Kişisel Gemini' } });
    fireEvent.change(geminiInput, { target: { value: 'AIza-named-key-1234567890' } });
    fireEvent.click(Array.from(document.querySelectorAll('button')).find(button => (
      button.textContent?.match(/Add Key|Anahtar Ekle/i)
    )));

    expect(await screen.findByText('Kişisel Gemini')).toBeInTheDocument();
    expect(screen.getByText('AIza...7890')).toBeInTheDocument();
    await waitFor(() => expect(kasaOku('gemini')[0]?.label).toBe('Kişisel Gemini'));
    expect(nameInputs[0]).toHaveValue('');
  });

  it('renders the provider-grouped model selector with the 9 supported model ids', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const modelSelect = document.querySelector('button[data-testid="model-selector"]');
    expect(modelSelect).toBeInTheDocument();
    expect(modelSelect.closest('[data-testid="composer-meta"]')).toBeInTheDocument();

    fireEvent.click(modelSelect);
    const listbox = screen.getByRole('listbox');
    fireEvent.click(screen.getByText('OpenRouter'));
    fireEvent.click(screen.getByText(/Ollama/));
    const optionValues = Array.from(listbox.querySelectorAll('[data-model-id]')).map(opt => opt.dataset.modelId);
    expect(optionValues).toEqual([
      'auto',
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash-lite',
      'gemini-3.6-flash',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'openrouter/free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'gpt-oss:120b',
      'nemotron-3-ultra',
    ]);
    const autoOption = listbox.querySelector('[data-model-id="auto"]');
    expect(autoOption).toHaveTextContent('Auto');
    expect(autoOption.querySelector('svg.lucide-sparkles')).toBeInTheDocument();
    expect(screen.getByText('Gemini')).toBeInTheDocument();
    expect(screen.getByText('OpenRouter')).toBeInTheDocument();
    expect(Array.from(listbox.querySelectorAll('[data-model-id]'))
      .filter(option => option.dataset.modelId === 'openrouter/free')
      .map(option => option.textContent)).toEqual(['FreeMediumQ2']);
    expect(Array.from(listbox.querySelectorAll('[data-model-id]')).slice(-2).map(option => option.textContent)).toEqual([
      'GPT-OSS 120BFastQ3',
      'Nemotron 3 UltraSlowQ5',
    ]);
    const speedBadge = (id) => listbox.querySelector(`[data-model-id="${id}"]`).textContent;
    expect(speedBadge('gpt-oss:120b')).toContain('Fast');
    expect(speedBadge('nemotron-3-ultra')).toContain('Slow');
    expect(speedBadge('nvidia/nemotron-3-super-120b-a12b:free')).toContain('Medium');
    expect(speedBadge('openrouter/free')).toContain('Medium');
    expect(speedBadge('gemini-3.1-flash-lite')).toContain('Fast');
    expect(speedBadge('gemini-3.5-flash-lite')).toContain('Fast');
    expect(speedBadge('gemini-3.6-flash')).toContain('Medium');
    expect(speedBadge('gemini-3.7-flash')).toContain('Slow');
    expect(speedBadge('gemini-3.8-flash')).toContain('Slow');
  });

  it('collapses provider groups in the model selector independently', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    fireEvent.click(document.querySelector('button[data-testid="model-selector"]'));
    const listbox = screen.getByRole('listbox');
    expect(listbox.querySelector('[data-model-id="gemini-3.8-flash"]')).toBeInTheDocument();
    expect(listbox.querySelector('[data-model-id="openrouter/free"]')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('OpenRouter'));
    expect(listbox.querySelector('[data-model-id="openrouter/free"]')).toBeInTheDocument();
    expect(listbox.querySelector('[data-model-id="gemini-3.8-flash"]')).toBeInTheDocument();

    fireEvent.click(screen.getByText('OpenRouter'));
    expect(listbox.querySelector('[data-model-id="openrouter/free"]')).not.toBeInTheDocument();
  });

  it('collapses the selected model group too', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    fireEvent.click(document.querySelector('button[data-testid="model-selector"]'));
    const listbox = screen.getByRole('listbox');
    expect(listbox.querySelector('[data-model-id="gemini-3.8-flash"]')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Gemini'));
    expect(listbox.querySelector('[data-model-id="gemini-3.8-flash"]')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Gemini'));
    expect(listbox.querySelector('[data-model-id="gemini-3.8-flash"]')).toBeInTheDocument();
  });

  it('closes the model selector with a second toggle click', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const modelSelect = document.querySelector('button[data-testid="model-selector"]');
    fireEvent.click(modelSelect);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.click(modelSelect);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('defaults the model selection mode to automatic when storage has none', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const modelSelect = document.querySelector('button[data-testid="model-selector"]');
    expect(modelSelect.textContent).toBe('Auto');
    await waitFor(() => expect(currentStorage.modelSelectionMode).toBe('auto'));
  });

  it('restores a persisted manual model selection', async () => {
    currentStorage.selectedModel = 'gemini-3.7-flash';
    currentStorage.selectedProvider = 'gemini';
    currentStorage.modelSelectionMode = 'manual';
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    expect(document.querySelector('button[data-testid="model-selector"]')).toHaveTextContent('Gemini 3.7 Flash');
  });

  it('switches back to automatic mode from the selector', async () => {
    currentStorage.selectedModel = 'gemini-3.7-flash';
    currentStorage.selectedProvider = 'gemini';
    currentStorage.modelSelectionMode = 'manual';
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    fireEvent.click(document.querySelector('button[data-testid="model-selector"]'));
    fireEvent.click(document.querySelector('[data-model-id="auto"]'));

    await waitFor(() => expect(currentStorage.modelSelectionMode).toBe('auto'));
    expect(document.querySelector('button[data-testid="model-selector"]')).toHaveTextContent('Auto');
  });

  it('migrates a provider-less legacy Gemini selection once', async () => {
    currentStorage.selectedModel = 'gemini-3.6-flash';
    currentStorage.modelSelectionMode = 'manual';
    render(<App />);

    await waitFor(() => {
      expect(currentStorage.selectedProvider).toBe('gemini');
      expect(document.querySelector('button[data-testid="model-selector"]')).toHaveTextContent('Gemini 3.6 Flash');
    });
  });

  it('migrates a retired MiniMax selection to Nemotron', async () => {
    currentStorage.selectedProvider = 'ollama';
    currentStorage.selectedModel = 'minimax-m3';
    currentStorage.modelSelectionMode = 'manual';
    render(<App />);

    await waitFor(() => expect(currentStorage).toMatchObject({
      selectedProvider: 'ollama',
      selectedModel: 'nemotron-3-ultra',
    }));
    expect(document.querySelector('button[data-testid="model-selector"]')).toHaveTextContent('Nemotron 3 Ultra');
  });

  it('removes retired MiniMax provenance from stored sessions without deleting answers', async () => {
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'retired-session',
      sessions: [{
        id: 'retired-session',
        title: 'Retired model',
        updatedAt: 100,
        messages: [
          { id: 'u1', role: 'user', content: 'Question' },
          {
            id: 'a1',
            role: 'model',
            content: 'Preserved MiniMax answer',
            provider: 'ollama',
            model: 'minimax-m3',
            resolvedModel: 'minimax-m3:cloud',
          },
        ],
      }],
    };

    render(<App />);

    expect(await screen.findByText('Preserved MiniMax answer')).toBeInTheDocument();
    await waitFor(() => {
      const storedAnswer = currentStorage.sessions[0].messages[1];
      expect(storedAnswer).not.toHaveProperty('model');
      expect(storedAnswer).not.toHaveProperty('resolvedModel');
      expect(storedAnswer.content).toBe('Preserved MiniMax answer');
    });
  });

  it.each([
    ['openrouter/free', 'openrouter'],
    ['nemotron-3-ultra', 'ollama'],
    ['gpt-oss:120b', 'ollama'],
  ])('persists provider and model together when selecting %s', async (modelId, providerId) => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    fireEvent.click(document.querySelector('button[data-testid="model-selector"]'));
    fireEvent.click(screen.getByText(providerId === 'openrouter' ? 'OpenRouter' : /Ollama/));
    fireEvent.click(document.querySelector(`[data-model-id="${modelId}"]`));

    await waitFor(() => expect(currentStorage).toMatchObject({
      selectedProvider: providerId,
      selectedModel: modelId,
    }));
  });

  it('passes the chosen model into streamChat on the next send', async () => {
    api.streamChat.mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'ok' } }]));
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const modelSelect = document.querySelector('button[data-testid="model-selector"]');
    fireEvent.click(modelSelect);
    fireEvent.click(document.querySelector('[data-model-id="gemini-3.7-flash"]'));

    expect(modelSelect.textContent).toBe('Gemini 3.7 Flash');

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'hello with custom model' } });
    fireEvent.click(getSendButton());

    await waitFor(() => expect(api.streamChat).toHaveBeenCalled());
    expect(api.streamChat.mock.calls[0][4]).toBe('gemini-3.7-flash');
    const answer = await screen.findByText('ok');
    expect(within(answer.closest('[data-testid="assistant-message"]')).getByTestId('message-model')).toHaveTextContent('Gemini 3.7 Flash');
    await waitFor(() => expect(currentStorage.sessions.some(session => (
      session.messages?.some(message => message.role === 'model' && message.model === 'gemini-3.7-flash')
    ))).toBe(true));

    expect(currentStorage.selectedModel).toBe('gemini-3.7-flash');
  });

  it('retries the same question with a one-off model without changing the composer model', async () => {
    currentStorage = {
      theme: 'light',
      selectedModel: 'gemini-3.1-flash-lite',
      modelSelectionMode: 'manual',
    };
    api.streamChat
      .mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'Answer from 3.1' } }]))
      .mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'Answer from 3.5 Lite' } }]));

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Compare this question' } });
    fireEvent.click(getSendButton());

    const firstAnswer = await screen.findByText('Answer from 3.1');
    const assistantMessage = firstAnswer.closest('[data-testid="assistant-message"]');
    const retryButton = assistantMessage.querySelector('button[aria-haspopup="dialog"]');
    fireEvent.click(retryButton);

    const retryDialog = screen.getByRole('dialog', { name: /Try again with a model|Model ile yeniden dene/i });
    expect(Array.from(retryDialog.querySelectorAll('[data-retry-model]')).map(button => button.dataset.retryModel)).toEqual([
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash-lite',
      'gemini-3.6-flash',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'openrouter/free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'gpt-oss:120b',
      'nemotron-3-ultra',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Gemini 3.5 Flash Lite' }));

    expect(await screen.findByText('Answer from 3.5 Lite')).toBeInTheDocument();
    expect(api.streamChat).toHaveBeenCalledTimes(2);
    expect(api.streamChat.mock.calls[1][0].map(message => message.content)).toEqual(['Compare this question']);
    expect(api.streamChat.mock.calls[1][4]).toBe('gemini-3.5-flash-lite');

    const startMessages = global.chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message?.type === 'HERA_GENERATION_START');
    expect(startMessages.at(-1).model).toBe('gemini-3.5-flash-lite');
    expect(document.querySelector('button[data-testid="model-selector"]').textContent).toBe('Gemini 3.1 Flash Lite');
    expect(currentStorage.selectedModel).toBe('gemini-3.1-flash-lite');
    expect(screen.getByText('Answer from 3.1')).toBeInTheDocument();
    expect(within(screen.getByText('Answer from 3.1').closest('[data-testid="assistant-message"]')).getByTestId('message-model')).toHaveTextContent('Gemini 3.1 Flash Lite');
    expect(within(screen.getByText('Answer from 3.5 Lite').closest('[data-testid="assistant-message"]')).getByTestId('message-model')).toHaveTextContent('Gemini 3.5 Flash Lite');
    expect(screen.getAllByTestId('user-message').filter(element => (
      element.textContent.includes('Compare this question')
    ))).toHaveLength(2);
  });

  it('routes an automatic send through local selection and labels the answer', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'hello auto world' } });
    fireEvent.click(getSendButton());

    let startMessage;
    await waitFor(() => {
      startMessage = global.chrome.runtime.sendMessage.mock.calls
        .map(([message]) => message)
        .find(message => message?.type === 'HERA_GENERATION_START' && !message?.kind);
      expect(startMessage).toBeDefined();
    });
    expect(startMessage.selectionMode).toBe('auto');
    expect(startMessage.model).toBe('gemini-3.1-flash-lite');
    expect(startMessage.selectionReasonCode).toBe('fast');

    const answer = await screen.findByText('Hello from AI');
    expect(within(answer.closest('[data-testid="assistant-message"]')).getByTestId('message-model'))
      .toHaveTextContent('Auto → Gemini 3.1 Flash Lite');
  });

  it('sends a follow-up without a winner and keeps both answers in context', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Compare models|Modelleri karşılaştır/i }));
    const dialog = await screen.findByRole('dialog', { name: /Compare two models|İki modeli karşılaştır/i });
    expect(within(dialog).getByText(/two requests|iki istek/i)).toBeInTheDocument();
    const selects = within(dialog).getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'gemini:gemini-3.6-flash' } });
    fireEvent.change(selects[1], { target: { value: 'gemini:gemini-3.7-flash' } });

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Which model writes better?' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Start comparison|Karşılaştırmayı başlat/i }));

    let startMessage;
    await waitFor(() => {
      startMessage = global.chrome.runtime.sendMessage.mock.calls
        .map(([message]) => message)
        .find(message => message?.type === 'HERA_GENERATION_START' && message?.kind === 'comparison');
      expect(startMessage).toBeDefined();
    });
    expect(startMessage.variants.map(variant => variant.model)).toEqual([
      'gemini-3.6-flash',
      'gemini-3.7-flash',
    ]);
    const { jobId, sessionId, userMessageId, assistantMessageId } = startMessage;
    const snapshotFor = (status, revision, firstContent, secondContent) => ({
      jobId,
      kind: 'comparison',
      comparisonId: jobId,
      sessionId,
      userMessageId,
      assistantMessageId,
      mode: 'chat',
      status,
      revision,
      content: '',
      sources: [],
      variants: {
        a: {
          variantId: 'a', status, content: firstContent, sources: [], resolvedModel: null,
          revision, errorCode: null, model: 'gemini-3.6-flash', provider: 'gemini',
        },
        b: {
          variantId: 'b', status, content: secondContent, sources: [], resolvedModel: null,
          revision, errorCode: null, model: 'gemini-3.7-flash', provider: 'gemini',
        },
      },
    });

    emitRuntimeMessage({ type: 'ACTIVE_GEN_CHANGED', snapshot: snapshotFor('running', 1, 'Answer A', 'Answer B') });
    expect(await screen.findByText('Answer A')).toBeInTheDocument();
    expect(await screen.findByText('Answer B')).toBeInTheDocument();

    emitRuntimeMessage({ type: 'DONE', activeGeneration: snapshotFor('completed', 2, 'Answer A', 'Answer B') });
    // The composer stays usable without picking a winner.
    await waitFor(() => expect(document.querySelector('textarea')).not.toBeDisabled());

    const winners = await screen.findAllByRole('button', { name: /Continue with this answer|Bu yanıtla devam et/i });
    expect(winners).toHaveLength(2);

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Follow up' } });
    fireEvent.click(getSendButton());

    await waitFor(() => expect(global.chrome.runtime.sendMessage.mock.calls.some(([message]) => (
      message?.type === 'RESOLVE_COMPARISON_BOTH' && message?.comparisonId === jobId
    ))).toBe(true));

    let followUpStart;
    await waitFor(() => {
      followUpStart = global.chrome.runtime.sendMessage.mock.calls
        .map(([message]) => message)
        .find(message => message?.type === 'HERA_GENERATION_START'
          && message?.requestMessages?.some(item => item.content === 'Follow up'));
      expect(followUpStart).toBeDefined();
    });
    const followUpContents = followUpStart.requestMessages.map(item => item.content);
    expect(followUpContents).toContain('Answer A');
    expect(followUpContents).toContain('Answer B');

    // Both answers stay on screen with a both-resolution note and no winner buttons.
    expect(await screen.findByTestId('comparison-both-note')).toHaveTextContent(
      /Continued with both answers|İki yanıtla devam edildi/i,
    );
    expect(screen.getByText('Answer A')).toBeInTheDocument();
    expect(screen.getByText('Answer B')).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /Continue with this answer|Bu yanıtla devam et/i }))
      .toHaveLength(0);
  });

  it('keeps a single-winner follow-up limited to the winning answer', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Compare models|Modelleri karşılaştır/i }));
    const dialog = await screen.findByRole('dialog', { name: /Compare two models|İki modeli karşılaştır/i });
    const selects = within(dialog).getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'gemini:gemini-3.6-flash' } });
    fireEvent.change(selects[1], { target: { value: 'gemini:gemini-3.7-flash' } });

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Which model writes better?' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Start comparison|Karşılaştırmayı başlat/i }));

    let startMessage;
    await waitFor(() => {
      startMessage = global.chrome.runtime.sendMessage.mock.calls
        .map(([message]) => message)
        .find(message => message?.type === 'HERA_GENERATION_START' && message?.kind === 'comparison');
      expect(startMessage).toBeDefined();
    });
    const { jobId, sessionId, userMessageId, assistantMessageId } = startMessage;
    const snapshotFor = (status, revision, firstContent, secondContent) => ({
      jobId,
      kind: 'comparison',
      comparisonId: jobId,
      sessionId,
      userMessageId,
      assistantMessageId,
      mode: 'chat',
      status,
      revision,
      content: '',
      sources: [],
      variants: {
        a: {
          variantId: 'a', status, content: firstContent, sources: [], resolvedModel: null,
          revision, errorCode: null, model: 'gemini-3.6-flash', provider: 'gemini',
        },
        b: {
          variantId: 'b', status, content: secondContent, sources: [], resolvedModel: null,
          revision, errorCode: null, model: 'gemini-3.7-flash', provider: 'gemini',
        },
      },
    });

    emitRuntimeMessage({ type: 'ACTIVE_GEN_CHANGED', snapshot: snapshotFor('running', 1, 'Answer A', 'Answer B') });
    expect(await screen.findByText('Answer A')).toBeInTheDocument();

    emitRuntimeMessage({ type: 'DONE', activeGeneration: snapshotFor('completed', 2, 'Answer A', 'Answer B') });

    const winners = await screen.findAllByRole('button', { name: /Continue with this answer|Bu yanıtla devam et/i });
    expect(winners).toHaveLength(2);
    fireEvent.click(winners[0]);

    await waitFor(() => expect(global.chrome.runtime.sendMessage.mock.calls.some(([message]) => (
      message?.type === 'SELECT_COMPARISON_WINNER' && message?.winnerSlot === 'a'
    ))).toBe(true));
    await waitFor(() => expect(document.querySelector('textarea')).not.toBeDisabled());

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Follow up' } });
    fireEvent.click(getSendButton());

    let followUpStart;
    await waitFor(() => {
      followUpStart = global.chrome.runtime.sendMessage.mock.calls
        .map(([message]) => message)
        .find(message => message?.type === 'HERA_GENERATION_START'
          && message?.requestMessages?.some(item => item.content === 'Follow up'));
      expect(followUpStart).toBeDefined();
    });
    const followUpContents = followUpStart.requestMessages.map(item => item.content);
    expect(followUpContents).toContain('Answer A');
    expect(followUpContents).not.toContain('Answer B');
  });

  it('keeps the comparison launcher disabled while a comparison is unresolved', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Compare models|Modelleri karşılaştır/i }));
    const dialog = await screen.findByRole('dialog', { name: /Compare two models|İki modeli karşılaştır/i });
    const selects = within(dialog).getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'gemini:gemini-3.6-flash' } });
    fireEvent.change(selects[1], { target: { value: 'gemini:gemini-3.7-flash' } });

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Which model writes better?' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Start comparison|Karşılaştırmayı başlat/i }));

    let startMessage;
    await waitFor(() => {
      startMessage = global.chrome.runtime.sendMessage.mock.calls
        .map(([message]) => message)
        .find(message => message?.type === 'HERA_GENERATION_START' && message?.kind === 'comparison');
      expect(startMessage).toBeDefined();
    });
    const { jobId, sessionId, userMessageId, assistantMessageId } = startMessage;
    emitRuntimeMessage({
      type: 'DONE',
      activeGeneration: {
        jobId,
        kind: 'comparison',
        comparisonId: jobId,
        sessionId,
        userMessageId,
        assistantMessageId,
        mode: 'chat',
        status: 'completed',
        revision: 2,
        content: '',
        sources: [],
        variants: {
          a: {
            variantId: 'a', status: 'completed', content: 'Answer A', sources: [],
            resolvedModel: null, revision: 2, errorCode: null,
            model: 'gemini-3.6-flash', provider: 'gemini',
          },
          b: {
            variantId: 'b', status: 'completed', content: 'Answer B', sources: [],
            resolvedModel: null, revision: 2, errorCode: null,
            model: 'gemini-3.7-flash', provider: 'gemini',
          },
        },
      },
    });

    await screen.findByText('Answer A');
    // Normal composer input stays enabled, but the comparison launcher is locked.
    await waitFor(() => expect(document.querySelector('textarea')).not.toBeDisabled());
    await waitFor(() => expect(
      screen.getByRole('button', { name: /Compare models|Modelleri karşılaştır/i }),
    ).toBeDisabled());
  });

  it('blocks a PDF retry before starting OpenRouter generation', async () => {
    const toastError = vi.spyOn(toast, 'error');
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'pdf-retry-session',
      sessions: [{
        id: 'pdf-retry-session',
        title: 'PDF retry',
        updatedAt: Date.now(),
        messages: [
          {
            id: 'pdf-user',
            role: 'user',
            content: 'Read this PDF',
            mode: 'vision',
            attachments: [{ id: 'pdf-1', name: 'paper.pdf', mimeType: 'application/pdf', data: 'PDF' }],
          },
          { id: 'pdf-answer', userMessageId: 'pdf-user', role: 'model', content: 'Old PDF answer', status: 'done' },
        ],
      }],
    };

    render(<App />);
    const oldAnswer = await screen.findByText('Old PDF answer');
    fireEvent.click(oldAnswer.closest('[data-testid="assistant-message"]').querySelector('button[aria-haspopup="dialog"]'));
    fireEvent.click(screen.getByRole('button', { name: 'Free' }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(
      /PDF attachments are supported only|PDF ekleri yalnızca/i,
    ), expect.any(Object)));
    expect(api.streamChat).not.toHaveBeenCalled();
    expect(api.streamVision).not.toHaveBeenCalled();
    expect(global.chrome.runtime.sendMessage.mock.calls.some(([message]) => (
      message?.type === 'HERA_GENERATION_START'
    ))).toBe(false);
  });

  it('blocks an image retry before starting a text-only Ollama model', async () => {
    const toastError = vi.spyOn(toast, 'error');
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'text-only-image-retry-session',
      sessions: [{
        id: 'text-only-image-retry-session',
        title: 'Text-only image retry',
        updatedAt: Date.now(),
        messages: [
          {
            id: 'image-user',
            role: 'user',
            content: 'Describe this image',
            mode: 'vision',
            attachments: [{ id: 'image-1', name: 'diagram.png', mimeType: 'image/png', data: 'BASE64' }],
          },
          { id: 'image-answer', userMessageId: 'image-user', role: 'model', content: 'Old image answer', status: 'done' },
        ],
      }],
    };

    render(<App />);
    const oldAnswer = await screen.findByText('Old image answer');
    fireEvent.click(oldAnswer.closest('[data-testid="assistant-message"]').querySelector('button[aria-haspopup="dialog"]'));
    fireEvent.click(screen.getByRole('button', { name: 'Nemotron 3 Ultra' }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(
      /selected model accepts text only|Seçili model yalnızca metin/i,
    ), expect.any(Object)));
    expect(api.streamChat).not.toHaveBeenCalled();
    expect(api.streamVision).not.toHaveBeenCalled();
    expect(global.chrome.runtime.sendMessage.mock.calls.some(([message]) => (
      message?.type === 'HERA_GENERATION_START'
    ))).toBe(false);
  });

  it('keeps the full visible conversation when retrying an older answer', async () => {
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'preserved-retry-session',
      sessions: [{
        id: 'preserved-retry-session',
        title: 'Preserved retry',
        updatedAt: Date.now(),
        messages: [
          { id: 'first-user', role: 'user', content: 'First question', mode: 'chat' },
          { id: 'first-answer', userMessageId: 'first-user', role: 'model', content: 'First old answer', status: 'done', sources: [] },
          { id: 'later-user', role: 'user', content: 'Later question', mode: 'chat' },
          { id: 'later-answer', userMessageId: 'later-user', role: 'model', content: 'Later answer', status: 'done', sources: [] },
        ],
      }],
    };
    api.streamChat.mockImplementationOnce(() => mockStream([
      { event: 'chunk', data: { text: 'First retried answer' } },
    ]));

    render(<App />);
    const oldAnswer = await screen.findByText('First old answer');
    const assistantMessage = oldAnswer.closest('[data-testid="assistant-message"]');
    fireEvent.click(assistantMessage.querySelector('button[aria-haspopup="dialog"]'));
    fireEvent.click(screen.getByRole('button', { name: 'Gemini 3.5 Flash Lite' }));

    expect(await screen.findByText('First retried answer')).toBeInTheDocument();
    expect(screen.getByText('First old answer')).toBeInTheDocument();
    expect(screen.getByText('Later question')).toBeInTheDocument();
    expect(screen.getByText('Later answer')).toBeInTheDocument();
    expect(screen.getAllByTestId('user-message').filter(element => (
      element.textContent.includes('First question')
    ))).toHaveLength(2);
    expect(api.streamChat.mock.calls[0][0].map(message => message.content)).toEqual(['First question']);
    expect(currentStorage.sessions[0].messages.map(message => message.content)).toEqual([
      'First question',
      'First old answer',
      'Later question',
      'Later answer',
      'First question',
      'First retried answer',
    ]);
  });

  it('preserves the original web mode when retrying an older research answer', async () => {
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'research-retry-session',
      sessions: [{
        id: 'research-retry-session',
        title: 'Research retry',
        updatedAt: Date.now(),
        messages: [
          { id: 'research-user', role: 'user', content: 'Research this topic', mode: 'web' },
          {
            id: 'research-answer',
            userMessageId: 'research-user',
            role: 'model',
            content: 'Older research answer',
            status: 'done',
            sources: [],
          },
        ],
      }],
    };
    api.streamResearch.mockImplementationOnce(() => mockStream([
      { event: 'chunk', data: { text: 'Fresh research answer' } },
    ]));

    render(<App />);
    const oldAnswer = await screen.findByText('Older research answer');
    const assistantMessage = oldAnswer.closest('[data-testid="assistant-message"]');
    fireEvent.click(assistantMessage.querySelector('button[aria-haspopup="dialog"]'));
    fireEvent.click(screen.getByRole('button', { name: 'Gemini 3.5 Flash Lite' }));

    expect(await screen.findByText('Fresh research answer')).toBeInTheDocument();
    expect(api.streamResearch).toHaveBeenCalledTimes(1);
    expect(api.streamChat).not.toHaveBeenCalled();
    expect(api.streamResearch.mock.calls[0][0].map(message => message.content)).toEqual(['Research this topic']);
    expect(api.streamResearch.mock.calls[0][4]).toBe('gemini-3.5-flash-lite');
  });

  it('preserves image attachments when retrying an attachment-only vision question', async () => {
    const attachment = {
      name: 'diagram.png',
      mimeType: 'image/png',
      data: btoa(String.fromCharCode(...validImageBytes('image/png', 'image-data'))),
    };
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'vision-retry-session',
      sessions: [{
        id: 'vision-retry-session',
        title: 'Vision retry',
        updatedAt: Date.now(),
        messages: [
          {
            id: 'vision-user',
            role: 'user',
            content: 'Hidden OCR retry instruction',
            displayContent: '',
            mode: 'vision',
            attachments: [attachment],
          },
          {
            id: 'vision-answer',
            userMessageId: 'vision-user',
            role: 'model',
            content: 'Older vision answer',
            status: 'done',
            sources: [],
          },
        ],
      }],
    };
    api.streamVision.mockImplementationOnce(() => mockStream([
      { event: 'chunk', data: { text: 'Fresh vision answer' } },
    ]));

    render(<App />);
    const oldAnswer = await screen.findByText('Older vision answer');
    const assistantMessage = oldAnswer.closest('[data-testid="assistant-message"]');
    fireEvent.click(assistantMessage.querySelector('button[aria-haspopup="dialog"]'));
    fireEvent.click(screen.getByRole('button', { name: 'Gemini 3.5 Flash Lite' }));

    expect(await screen.findByText('Fresh vision answer')).toBeInTheDocument();
    expect(api.streamVision).toHaveBeenCalledTimes(1);
    expect(api.streamChat).not.toHaveBeenCalled();
    expect(api.streamVision.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        role: 'user',
        content: 'Hidden OCR retry instruction',
        displayContent: '',
        mode: 'vision',
        attachments: [expect.objectContaining({
          id: expect.any(String),
          name: 'diagram.png',
          mimeType: 'image/png',
          availability: 'ready',
        })],
        retryOfMessageId: 'vision-user',
      }),
    ]);
    expect(screen.queryByText('Hidden OCR retry instruction')).not.toBeInTheDocument();
    expect(api.streamVision.mock.calls[0][5]).toBe('gemini-3.5-flash-lite');
  });

  it('does not send or clear an unrelated composer draft when retrying an older text answer', async () => {
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'draft-safe-retry-session',
      sessions: [{
        id: 'draft-safe-retry-session',
        title: 'Draft-safe retry',
        updatedAt: Date.now(),
        messages: [
          { id: 'legacy-user', role: 'user', content: 'Older text question', mode: 'chat' },
          {
            id: 'legacy-answer',
            userMessageId: 'legacy-user',
            role: 'model',
            content: 'Older text answer',
            status: 'done',
            sources: [],
          },
        ],
      }],
    };
    api.streamChat.mockImplementationOnce(() => mockStream([
      { event: 'chunk', data: { text: 'Retried text answer' } },
    ]));

    render(<App />);
    const oldAnswer = await screen.findByText('Older text answer');
    const composer = document.querySelector('textarea');
    fireEvent.change(composer, { target: { value: 'Unsent draft' } });
    const fileInput = document.querySelector('input[type="file"][accept*="image"]');
    fireEvent.change(fileInput, {
      target: { files: [new File([validImageBytes('image/png', 'draft-image')], 'draft.png', { type: 'image/png' })] },
    });
    await waitFor(() => expect(screen.getByText('draft.png')).toBeInTheDocument());

    const assistantMessage = oldAnswer.closest('[data-testid="assistant-message"]');
    fireEvent.click(assistantMessage.querySelector('button[aria-haspopup="dialog"]'));
    fireEvent.click(screen.getByRole('button', { name: 'Gemini 3.5 Flash Lite' }));

    expect(await screen.findByText('Retried text answer')).toBeInTheDocument();
    expect(api.streamChat).toHaveBeenCalledTimes(1);
    expect(api.streamVision).not.toHaveBeenCalled();
    expect(api.streamChat.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        content: 'Older text question',
        attachments: [],
        mode: 'chat',
        retryOfMessageId: 'legacy-user',
      }),
    ]);
    expect(composer).toHaveValue('Unsent draft');
    expect(screen.getByText('draft.png')).toBeInTheDocument();
  });

  it('starts generation through the background runtime after one atomic queued-state write', async () => {
    api.streamChat.mockImplementationOnce(() => mockStream([{ event: 'chunk', data: { text: 'Background answer' } }]));
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Persistent question' } });
    fireEvent.click(getSendButton());

    expect(await findChatText('Persistent question')).toBeInTheDocument();
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
    expect(await findChatText('Cancel before START')).toBeInTheDocument();
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
    expect(await findChatText('Question')).toBeInTheDocument();
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

  it('keeps a header rename permanent across a new streamed response', async () => {
    await i18n.changeLanguage('en');
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'rename-session',
      sessions: [{
        id: 'rename-session',
        title: 'Automatic title',
        updatedAt: 100,
        messages: [{ id: 'rename-welcome', role: 'model', content: 'Welcome' }],
      }],
    };

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Rename chat' }));
    const titleInput = screen.getByRole('textbox', { name: 'Chat name' });
    fireEvent.change(titleInput, { target: { value: '  Permanent project name  ' } });
    fireEvent.keyDown(titleInput, { key: 'Enter' });

    await waitFor(() => expect(currentStorage.sessions.find(session => (
      session.id === 'rename-session'
    ))).toMatchObject({
      title: 'Permanent project name',
      isTitleCustom: true,
      isStarred: false,
      updatedAt: 100,
    }));

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'A new question' } });
    fireEvent.click(getSendButton());
    expect(await screen.findByText('Hello from AI')).toBeInTheDocument();

    await waitFor(() => expect(currentStorage.sessions.find(session => (
      session.id === 'rename-session'
    ))).toMatchObject({
      title: 'Permanent project name',
      isTitleCustom: true,
      isStarred: false,
    }));
    expect(screen.getByTitle('Permanent project name')).toBeInTheDocument();
  });

  it('persists stars, groups them first, and bulk-deletes only unstarred chats', async () => {
    await i18n.changeLanguage('en');
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'drop-active',
      sessions: [
        {
          id: 'keep-starred',
          title: 'Already starred',
          isTitleCustom: true,
          isStarred: true,
          updatedAt: 200,
          messages: [{ id: 'starred-user', role: 'user', content: 'Starred question' }],
        },
        {
          id: 'pin-this',
          title: 'Pin this chat',
          isTitleCustom: false,
          isStarred: false,
          updatedAt: 300,
          messages: [{ id: 'pin-user', role: 'user', content: 'Pin question' }],
        },
        {
          id: 'drop-active',
          title: 'Delete this chat',
          isTitleCustom: false,
          isStarred: false,
          updatedAt: 400,
          messages: [{ id: 'drop-user', role: 'user', content: 'Delete question' }],
        },
      ],
    };

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));

    const pinRow = screen.getByText('Pin this chat').closest('.group');
    fireEvent.click(within(pinRow).getByRole('button', { name: 'Star chat' }));
    await waitFor(() => expect(currentStorage.sessions.find(session => (
      session.id === 'pin-this'
    ))).toMatchObject({ isStarred: true, updatedAt: 300 }));

    const starredHeading = screen.getByRole('heading', { name: 'Starred' });
    const otherHeading = screen.getByRole('heading', { name: 'Other chats' });
    expect(starredHeading.compareDocumentPosition(otherHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Bulk delete' }));
    expect(screen.getByRole('dialog', { name: 'Delete unstarred chats?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1' }));

    await waitFor(() => expect(currentStorage.sessions.map(session => session.id).sort()).toEqual([
      'keep-starred',
      'pin-this',
    ]));
    expect(currentStorage.activeSessionId).toBe('pin-this');
    expect(screen.getByRole('heading', { name: 'Chat History' })).toBeInTheDocument();
    expect(screen.queryByText('Delete this chat')).not.toBeInTheDocument();
    expect(screen.getByText('Pin this chat')).toBeInTheDocument();
    expect(screen.getByText('Already starred')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus());
  });

  it('başka cihazdan eşitlenen yeni sohbeti geçmiş listesinde gösterir', async () => {
    await i18n.changeLanguage('en');
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'yerel-1',
      sessions: [
        {
          id: 'yerel-1',
          title: 'Local chat',
          isTitleCustom: false,
          isStarred: false,
          updatedAt: 100,
          messages: [{ id: 'yerel-m1', role: 'user', content: 'Local question' }],
        },
      ],
    };

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));
    expect(screen.getByText('Local chat')).toBeInTheDocument();

    const pulledSession = {
      id: 'uzak-1',
      title: 'Synced starred chat',
      isTitleCustom: false,
      isStarred: true,
      updatedAt: 200,
      messages: [{ id: 'uzak-m1', role: 'user', content: 'Remote question' }],
    };
    const previousSessions = currentStorage.sessions;
    currentStorage.sessions = [...previousSessions, pulledSession];
    triggerStorageChange({
      sessions: { oldValue: previousSessions, newValue: currentStorage.sessions },
    });

    expect(await screen.findByText('Synced starred chat')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Starred' })).toBeInTheDocument();
    expect(screen.getByText('Local chat')).toBeInTheDocument();
  });

  it('uses the protected menu action and cancels a deleted active generation', async () => {
    await i18n.changeLanguage('en');
    const controlled = createControlledStream();
    api.streamChat.mockImplementationOnce(() => controlled.stream);
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'running-unstarred',
      sessions: [
        {
          id: 'protected-starred',
          title: 'Protected starred chat',
          isTitleCustom: true,
          isStarred: true,
          updatedAt: 200,
          messages: [{ id: 'protected-user', role: 'user', content: 'Keep me' }],
        },
        {
          id: 'running-unstarred',
          title: 'Running unstarred chat',
          isTitleCustom: true,
          isStarred: false,
          updatedAt: 300,
          messages: [{ id: 'running-user-old', role: 'user', content: 'Earlier question' }],
        },
      ],
    };

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Keep running until delete' } });
    fireEvent.click(getSendButton());
    await waitFor(() => expect(currentStorage.activeGeneration?.status).toBe('running'));

    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear' }));
    expect(screen.getByRole('dialog', { name: 'Delete unstarred chats?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1' }));

    await waitFor(() => expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'CANCEL',
      reason: 'clear_history',
    })));
    await waitFor(() => expect(currentStorage.sessions).toEqual([
      expect.objectContaining({
        id: 'protected-starred',
        isStarred: true,
      }),
    ]));
    expect(currentStorage.activeSessionId).toBe('protected-starred');
    expect(screen.getByRole('heading', { name: 'Chat History' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Delete unstarred chats?' })).not.toBeInTheDocument();
    expect(screen.queryByText('Running unstarred chat')).not.toBeInTheDocument();
    expect(screen.getByText('Protected starred chat')).toBeInTheDocument();
  });

  it('creates one fresh unstarred chat and keeps history open when bulk deletion has no survivor', async () => {
    await i18n.changeLanguage('en');
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'only-chat',
      sessions: [{
        id: 'only-chat',
        title: 'Only unstarred chat',
        isTitleCustom: true,
        isStarred: false,
        updatedAt: 100,
        messages: [{ id: 'only-user', role: 'user', content: 'Delete me' }],
      }],
    };

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1' }));

    await waitFor(() => expect(currentStorage.sessions[0]?.id).not.toBe('only-chat'));
    expect(currentStorage.sessions).toHaveLength(1);
    expect(currentStorage.sessions[0]).toMatchObject({
      title: 'New Chat',
      isTitleCustom: false,
      isStarred: false,
    });
    expect(currentStorage.sessions[0].id).not.toBe('only-chat');
    expect(currentStorage.activeSessionId).toBe(currentStorage.sessions[0].id);
    expect(screen.getByRole('heading', { name: 'Chat History' })).toBeInTheDocument();
    expect(screen.getByText('New Chat')).toBeInTheDocument();
    expect(screen.queryByText('Only unstarred chat')).not.toBeInTheDocument();
  });

  it('preserves newer stored metadata and unrelated session order when a streamed message write is queued', async () => {
    await i18n.changeLanguage('en');
    const controlled = createControlledStream();
    api.streamChat.mockImplementationOnce(() => controlled.stream);
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'race-active',
      sessions: [
        {
          id: 'race-active',
          title: 'Automatic race title',
          isTitleCustom: false,
          isStarred: false,
          updatedAt: 300,
          messages: [{ id: 'race-old-user', role: 'user', content: 'Earlier question' }],
        },
        {
          id: 'race-existing',
          title: 'Existing unrelated chat',
          isTitleCustom: true,
          isStarred: false,
          updatedAt: 100,
          messages: [{ id: 'race-existing-user', role: 'user', content: 'Keep existing' }],
        },
      ],
    };

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Queue this response' } });
    fireEvent.click(getSendButton());
    await waitFor(() => expect(currentStorage.activeGeneration?.status).toBe('running'));

    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));

    const defaultStorageGet = global.chrome.storage.local.get.getMockImplementation();
    let releaseMetadataRead;
    let shouldBlockNextSessionsRead = true;
    global.chrome.storage.local.get.mockImplementation((keys, callback) => {
      if (
        shouldBlockNextSessionsRead
        && Array.isArray(keys)
        && keys.length === 1
        && keys[0] === 'sessions'
      ) {
        shouldBlockNextSessionsRead = false;
        return new Promise(resolve => {
          releaseMetadataRead = (result) => {
            if (typeof callback === 'function') callback(result);
            resolve(result);
          };
        });
      }
      return defaultStorageGet(keys, callback);
    });

    const activeRow = document.querySelector('button[aria-current="true"]').closest('.group');
    fireEvent.click(within(activeRow).getByRole('button', { name: 'Star chat' }));
    await waitFor(() => expect(releaseMetadataRead).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    const workerSession = currentStorage.sessions.find(session => session.id === 'race-active');
    const existingSession = currentStorage.sessions.find(session => session.id === 'race-existing');
    currentStorage.sessions = [
      {
        id: 'race-new-external',
        title: 'New external chat',
        isTitleCustom: true,
        isStarred: false,
        updatedAt: 500,
        messages: [{ id: 'race-external-user', role: 'user', content: 'Keep new external' }],
      },
      {
        ...workerSession,
        title: 'Newest manual title',
        isTitleCustom: true,
        isStarred: true,
        updatedAt: 400,
      },
      existingSession,
    ];

    await act(async () => {
      controlled.push({ event: 'chunk', data: { text: 'Queued persistence answer' } });
      controlled.finish();
    });
    expect(await screen.findByText('Queued persistence answer', {}, { timeout: 3000 })).toBeInTheDocument();

    await act(async () => {
      releaseMetadataRead({ sessions: currentStorage.sessions });
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(currentStorage.activeGeneration).toBeUndefined());
    expect(currentStorage.sessions.map(session => session.id)).toEqual([
      'race-new-external',
      'race-active',
      'race-existing',
    ]);
    expect(currentStorage.sessions.find(session => session.id === 'race-active')).toMatchObject({
      title: 'Newest manual title',
      isTitleCustom: true,
      isStarred: true,
    });
    expect(currentStorage.sessions.find(session => session.id === 'race-active').messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'Queue this response' }),
        expect.objectContaining({ role: 'model', content: 'Queued persistence answer' }),
      ]),
    );
  });

  it('aborts bulk deletion when the worker still reports the active generation', async () => {
    await i18n.changeLanguage('en');
    const controlled = createControlledStream();
    api.streamChat.mockImplementationOnce(() => controlled.stream);
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'bulk-running',
      sessions: [
        {
          id: 'bulk-starred',
          title: 'Bulk protected chat',
          isTitleCustom: true,
          isStarred: true,
          updatedAt: 100,
          messages: [{ id: 'bulk-starred-user', role: 'user', content: 'Keep protected' }],
        },
        {
          id: 'bulk-running',
          title: 'Bulk running chat',
          isTitleCustom: true,
          isStarred: false,
          updatedAt: 200,
          messages: [{ id: 'bulk-running-user', role: 'user', content: 'Earlier running question' }],
        },
      ],
    };

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Do not delete this running chat' } });
    fireEvent.click(getSendButton());
    await waitFor(() => expect(currentStorage.activeGeneration?.status).toBe('running'));

    const defaultRuntimeSend = global.chrome.runtime.sendMessage.getMockImplementation();
    global.chrome.runtime.sendMessage.mockImplementation(async message => {
      if (message?.type === 'CANCEL') return { ok: false, errorCode: 'cancel_not_confirmed' };
      if (message?.type === 'GET_STATE') {
        return { ok: true, activeGeneration: currentStorage.activeGeneration };
      }
      return defaultRuntimeSend(message);
    });

    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1' }));

    await waitFor(() => expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'CANCEL',
      jobId: currentStorage.activeGeneration.jobId,
      reason: 'clear_history',
    })));
    await waitFor(() => expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'GET_STATE' }));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(currentStorage.sessions.map(session => session.id).sort()).toEqual([
      'bulk-running',
      'bulk-starred',
    ]);
    expect(currentStorage.activeSessionId).toBe('bulk-running');
    expect(currentStorage.activeGeneration?.status).toBe('running');
    expect(screen.getByRole('heading', { name: 'Chat History' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Delete unstarred chats?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete 1' })).toBeEnabled();
    expect(screen.getByText('Bulk protected chat')).toBeInTheDocument();
    expect(screen.getByText('Bulk running chat')).toBeInTheDocument();
  });

  it('aborts single-chat deletion when the worker still reports the active generation', async () => {
    await i18n.changeLanguage('en');
    const controlled = createControlledStream();
    api.streamChat.mockImplementationOnce(() => controlled.stream);
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'single-running',
      sessions: [
        {
          id: 'single-backup',
          title: 'Single backup chat',
          isTitleCustom: true,
          isStarred: true,
          updatedAt: 100,
          messages: [{ id: 'single-backup-user', role: 'user', content: 'Keep backup' }],
        },
        {
          id: 'single-running',
          title: 'Single running chat',
          isTitleCustom: true,
          isStarred: false,
          updatedAt: 200,
          messages: [{ id: 'single-running-user', role: 'user', content: 'Earlier running question' }],
        },
      ],
    };

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Keep this single chat alive' } });
    fireEvent.click(getSendButton());
    await waitFor(() => expect(currentStorage.activeGeneration?.status).toBe('running'));

    const defaultRuntimeSend = global.chrome.runtime.sendMessage.getMockImplementation();
    global.chrome.runtime.sendMessage.mockImplementation(async message => {
      if (message?.type === 'CANCEL') return { ok: false, errorCode: 'cancel_not_confirmed' };
      if (message?.type === 'GET_STATE') {
        return { ok: true, activeGeneration: currentStorage.activeGeneration };
      }
      return defaultRuntimeSend(message);
    });

    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));
    const runningRow = screen.getByText('Single running chat').closest('.group');
    fireEvent.click(within(runningRow).getByRole('button', { name: 'Delete chat' }));

    await waitFor(() => expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'CANCEL',
      jobId: currentStorage.activeGeneration.jobId,
      reason: 'session_deleted',
    })));
    await waitFor(() => expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'GET_STATE' }));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(currentStorage.sessions.map(session => session.id).sort()).toEqual([
      'single-backup',
      'single-running',
    ]);
    expect(currentStorage.activeSessionId).toBe('single-running');
    expect(currentStorage.activeGeneration?.status).toBe('running');
  });

  it('keeps pending rename and star metadata across pagehide, unmount, and remount', async () => {
    await i18n.changeLanguage('en');
    const originalSession = {
      id: 'pagehide-metadata',
      title: 'Original pagehide title',
      isTitleCustom: true,
      isStarred: false,
      updatedAt: 100,
      messages: [{ id: 'pagehide-user', role: 'user', content: 'Persist this conversation' }],
    };
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: originalSession.id,
      sessions: [originalSession],
    };

    const view = render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const defaultStorageGet = global.chrome.storage.local.get.getMockImplementation();
    let releasePendingMetadataRead;
    let blockNextSessionsRead = true;
    global.chrome.storage.local.get.mockImplementation((keys, callback) => {
      if (
        blockNextSessionsRead
        && Array.isArray(keys)
        && keys.length === 1
        && keys[0] === 'sessions'
      ) {
        blockNextSessionsRead = false;
        return new Promise(resolve => {
          releasePendingMetadataRead = (result) => {
            if (typeof callback === 'function') callback(result);
            resolve(result);
          };
        });
      }
      return defaultStorageGet(keys, callback);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Rename chat' }));
    const titleInput = screen.getByRole('textbox', { name: 'Chat name' });
    fireEvent.change(titleInput, { target: { value: 'Pagehide-safe title' } });
    fireEvent.keyDown(titleInput, { key: 'Enter' });
    await waitFor(() => expect(releasePendingMetadataRead).toBeTypeOf('function'));

    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));
    const renamedRow = screen.getByText('Pagehide-safe title').closest('.group');
    fireEvent.click(within(renamedRow).getByRole('button', { name: 'Star chat' }));
    await waitFor(() => {
      const starredRow = screen.getByText('Pagehide-safe title').closest('.group');
      expect(within(starredRow).getByRole('button', { name: 'Remove star' })).toBeInTheDocument();
    });

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(currentStorage.sessions[0]).toMatchObject({
      id: originalSession.id,
      title: 'Pagehide-safe title',
      isTitleCustom: true,
      isStarred: true,
    }));

    view.unmount();
    await act(async () => {
      await Promise.resolve();
      releasePendingMetadataRead({ sessions: [originalSession] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(currentStorage.sessions[0]).toMatchObject({
      id: originalSession.id,
      title: 'Pagehide-safe title',
      isTitleCustom: true,
      isStarred: true,
    });

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    expect(screen.getByTitle('Pagehide-safe title')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));
    const restoredRow = screen.getByText('Pagehide-safe title').closest('.group');
    expect(within(restoredRow).getByRole('button', { name: 'Remove star' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not resurrect a deleted row when its star action was queued behind deletion', async () => {
    await i18n.changeLanguage('en');
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'queue-survivor',
      sessions: [
        {
          id: 'queue-target',
          title: 'Queued deletion target',
          isTitleCustom: true,
          isStarred: false,
          updatedAt: 200,
          messages: [{ id: 'queue-target-user', role: 'user', content: 'Delete this row' }],
        },
        {
          id: 'queue-survivor',
          title: 'Queued deletion survivor',
          isTitleCustom: true,
          isStarred: true,
          updatedAt: 100,
          messages: [{ id: 'queue-survivor-user', role: 'user', content: 'Keep this row' }],
        },
      ],
    };

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));

    const defaultStorageGet = global.chrome.storage.local.get.getMockImplementation();
    let releaseDeletionRead;
    let blockNextSessionsRead = true;
    global.chrome.storage.local.get.mockImplementation((keys, callback) => {
      if (
        blockNextSessionsRead
        && Array.isArray(keys)
        && keys.length === 1
        && keys[0] === 'sessions'
      ) {
        blockNextSessionsRead = false;
        return new Promise(resolve => {
          releaseDeletionRead = (result) => {
            if (typeof callback === 'function') callback(result);
            resolve(result);
          };
        });
      }
      return defaultStorageGet(keys, callback);
    });

    const targetRow = screen.getByText('Queued deletion target').closest('.group');
    fireEvent.click(within(targetRow).getByRole('button', { name: 'Delete chat' }));
    await waitFor(() => expect(releaseDeletionRead).toBeTypeOf('function'));
    fireEvent.click(within(targetRow).getByRole('button', { name: 'Star chat' }));

    const sessionsReadCountBeforeRelease = global.chrome.storage.local.get.mock.calls.filter(([keys]) => (
      Array.isArray(keys) && keys.length === 1 && keys[0] === 'sessions'
    )).length;
    await act(async () => {
      releaseDeletionRead({ sessions: currentStorage.sessions });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(global.chrome.storage.local.get.mock.calls.filter(([keys]) => (
      Array.isArray(keys) && keys.length === 1 && keys[0] === 'sessions'
    )).length).toBeGreaterThan(sessionsReadCountBeforeRelease));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(currentStorage.sessions.map(session => session.id)).toEqual(['queue-survivor']);
    expect(screen.queryByText('Queued deletion target')).not.toBeInTheDocument();
    expect(screen.getByText('Queued deletion survivor')).toBeInTheDocument();
  });

  it('does not resurrect an authoritatively removed session from a delayed message write', async () => {
    await i18n.changeLanguage('en');
    const controlled = createControlledStream();
    api.streamChat.mockImplementationOnce(() => controlled.stream);
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'removed-message-session',
      sessions: [
        {
          id: 'removed-message-session',
          title: 'Removed message session',
          isTitleCustom: true,
          isStarred: false,
          updatedAt: 200,
          messages: [{ id: 'removed-old-user', role: 'user', content: 'Earlier message' }],
        },
        {
          id: 'message-survivor',
          title: 'Message survivor',
          isTitleCustom: true,
          isStarred: true,
          updatedAt: 100,
          messages: [{ id: 'message-survivor-user', role: 'user', content: 'Keep survivor' }],
        },
      ],
    };

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    fireEvent.change(document.querySelector('textarea'), { target: { value: 'This write must not resurrect me' } });
    fireEvent.click(getSendButton());
    await waitFor(() => expect(currentStorage.activeGeneration?.status).toBe('running'));

    const defaultStorageGet = global.chrome.storage.local.get.getMockImplementation();
    let releaseMessageRead;
    let blockNextSessionsRead = true;
    global.chrome.storage.local.get.mockImplementation((keys, callback) => {
      if (
        blockNextSessionsRead
        && Array.isArray(keys)
        && keys.length === 1
        && keys[0] === 'sessions'
      ) {
        blockNextSessionsRead = false;
        return new Promise(resolve => {
          releaseMessageRead = (result) => {
            if (typeof callback === 'function') callback(result);
            resolve(result);
          };
        });
      }
      return defaultStorageGet(keys, callback);
    });

    await act(async () => {
      controlled.push({ event: 'chunk', data: { text: 'Delayed final answer' } });
      controlled.finish();
    });
    await waitFor(() => expect(releaseMessageRead).toBeTypeOf('function'), { timeout: 3000 });

    const survivor = currentStorage.sessions.find(session => session.id === 'message-survivor');
    currentStorage.sessions = [survivor];
    const storageSetCountAtRemoval = global.chrome.storage.local.set.mock.calls.length;
    await act(async () => {
      releaseMessageRead({ sessions: [survivor] });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(currentStorage.activeGeneration).toBeUndefined());
    expect(currentStorage.sessions.map(session => session.id)).toEqual(['message-survivor']);
    const writesAfterRemoval = global.chrome.storage.local.set.mock.calls
      .slice(storageSetCountAtRemoval)
      .filter(([data]) => Array.isArray(data?.sessions));
    expect(writesAfterRemoval.every(([data]) => (
      data.sessions.every(session => session.id !== 'removed-message-session')
    ))).toBe(true);
  });

  it('keeps bulk-delete UI and storage unchanged after a failed write and allows retry', async () => {
    await i18n.changeLanguage('en');
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'retry-starred',
      sessions: [
        {
          id: 'retry-starred',
          title: 'Retry protected chat',
          isTitleCustom: true,
          isStarred: true,
          updatedAt: 200,
          messages: [{ id: 'retry-starred-user', role: 'user', content: 'Keep protected' }],
        },
        {
          id: 'retry-unstarred',
          title: 'Retry deletable chat',
          isTitleCustom: true,
          isStarred: false,
          updatedAt: 100,
          messages: [{ id: 'retry-unstarred-user', role: 'user', content: 'Delete on retry' }],
        },
      ],
    };
    const defaultStorageSet = global.chrome.storage.local.set.getMockImplementation();
    let rejectNextBulkWrite = true;
    global.chrome.storage.local.set.mockImplementation((data, callback) => {
      if (
        rejectNextBulkWrite
        && Array.isArray(data?.sessions)
        && data.sessions.length === 1
        && data.sessions[0]?.id === 'retry-starred'
      ) {
        rejectNextBulkWrite = false;
        return Promise.reject(new Error('simulated bulk storage failure'));
      }
      return defaultStorageSet(data, callback);
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      render(<App />);
      await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'More options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));
      fireEvent.click(screen.getByRole('button', { name: 'Bulk delete' }));
      fireEvent.click(screen.getByRole('button', { name: 'Delete 1' }));

      await waitFor(() => expect(rejectNextBulkWrite).toBe(false));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Delete 1' })).toBeEnabled());
      expect(currentStorage.sessions.map(session => session.id).sort()).toEqual([
        'retry-starred',
        'retry-unstarred',
      ]);
      expect(screen.getByText('Retry protected chat')).toBeInTheDocument();
      expect(screen.getByText('Retry deletable chat')).toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'Delete unstarred chats?' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Delete 1' }));
      await waitFor(() => expect(currentStorage.sessions.map(session => session.id)).toEqual([
        'retry-starred',
      ]));
      expect(screen.queryByRole('dialog', { name: 'Delete unstarred chats?' })).not.toBeInTheDocument();
      expect(screen.queryByText('Retry deletable chat')).not.toBeInTheDocument();
      expect(screen.getByText('Retry protected chat')).toBeInTheDocument();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('keeps an active starred generation alive when bulk deletion precedes partial persistence', async () => {
    await i18n.changeLanguage('en');
    const controlled = createControlledStream();
    api.streamChat.mockImplementationOnce(() => controlled.stream);
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'streaming-starred',
      sessions: [
        {
          id: 'streaming-starred',
          title: 'Streaming protected chat',
          isTitleCustom: true,
          isStarred: true,
          updatedAt: 200,
          messages: [{ id: 'streaming-old-user', role: 'user', content: 'Earlier protected question' }],
        },
        {
          id: 'streaming-unstarred',
          title: 'Streaming deletable chat',
          isTitleCustom: true,
          isStarred: false,
          updatedAt: 100,
          messages: [{ id: 'streaming-delete-user', role: 'user', content: 'Delete this chat' }],
        },
      ],
    };

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Keep my live chunk' } });
    fireEvent.click(getSendButton());
    await waitFor(() => expect(currentStorage.activeGeneration?.status).toBe('running'));
    // Kasa (IndexedDB) okuması bitmeden sahte zamanlayıcı açılırsa istek akışı
    // hiç başlamaz; bu yüzden çağrı doğrulanır.
    await waitFor(() => expect(api.streamChat).toHaveBeenCalled());
    global.chrome.storage.local.set.mockClear();

    vi.useFakeTimers();
    try {
      await act(async () => {
        controlled.push({ event: 'chunk', data: { text: 'Protected live chunk' } });
        await Promise.resolve();
        // Kasa (IndexedDB) okuması setImmediate kullanır; sahte zamanlayıcı
        // sıfır süreyle ilerletilir, debounce süresi dolmaz.
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(currentStorage.activeGeneration?.content).toBe('Protected live chunk');
      expect(global.chrome.storage.local.set.mock.calls.some(([data]) => Array.isArray(data?.sessions))).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'More options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Clear' }));
      fireEvent.click(screen.getByRole('button', { name: 'Delete 1' }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(currentStorage.sessions.map(session => session.id)).toEqual(['streaming-starred']);
      expect(currentStorage.activeGeneration?.status).toBe('running');
      expect(global.chrome.runtime.sendMessage.mock.calls.some(([message]) => message?.type === 'CANCEL')).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(screen.getByText('Protected live chunk')).toBeInTheDocument();
      expect(getStopButton()).toBeInTheDocument();
      expect(currentStorage.activeGeneration?.status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a non-active row rename and star across delayed metadata, pagehide, and remount', async () => {
    await i18n.changeLanguage('en');
    const originalSessions = [
      {
        id: 'nonactive-current',
        title: 'Current chat',
        isTitleCustom: true,
        isStarred: false,
        updatedAt: 200,
        messages: [{ id: 'nonactive-current-user', role: 'user', content: 'Current conversation' }],
      },
      {
        id: 'nonactive-target',
        title: 'Background chat',
        isTitleCustom: true,
        isStarred: false,
        updatedAt: 100,
        messages: [{ id: 'nonactive-target-user', role: 'user', content: 'Background conversation' }],
      },
    ];
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'nonactive-current',
      sessions: originalSessions,
    };

    const view = render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));

    const defaultStorageGet = global.chrome.storage.local.get.getMockImplementation();
    let releaseMetadataRead;
    let blockNextSessionsRead = true;
    global.chrome.storage.local.get.mockImplementation((keys, callback) => {
      if (
        blockNextSessionsRead
        && Array.isArray(keys)
        && keys.length === 1
        && keys[0] === 'sessions'
      ) {
        blockNextSessionsRead = false;
        return new Promise(resolve => {
          releaseMetadataRead = (result) => {
            if (typeof callback === 'function') callback(result);
            resolve(result);
          };
        });
      }
      return defaultStorageGet(keys, callback);
    });

    const targetRow = screen.getByText('Background chat').closest('.group');
    fireEvent.click(within(targetRow).getByRole('button', { name: 'Rename chat' }));
    const titleInput = screen.getByRole('textbox', { name: 'Chat name' });
    fireEvent.change(titleInput, { target: { value: 'Background chat renamed' } });
    fireEvent.keyDown(titleInput, { key: 'Enter' });
    await waitFor(() => expect(releaseMetadataRead).toBeTypeOf('function'));

    const renamedRow = screen.getByText('Background chat renamed').closest('.group');
    fireEvent.click(within(renamedRow).getByRole('button', { name: 'Star chat' }));
    await waitFor(() => {
      const starredRow = screen.getByText('Background chat renamed').closest('.group');
      expect(within(starredRow).getByRole('button', { name: 'Remove star' })).toHaveAttribute('aria-pressed', 'true');
    });

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(currentStorage.sessions.find(session => (
      session.id === 'nonactive-target'
    ))).toMatchObject({
      title: 'Background chat renamed',
      isTitleCustom: true,
      isStarred: true,
    }));

    view.unmount();
    await act(async () => {
      releaseMetadataRead({ sessions: originalSessions });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(currentStorage.sessions.find(session => session.id === 'nonactive-target')).toMatchObject({
      title: 'Background chat renamed',
      isTitleCustom: true,
      isStarred: true,
    });

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    expect(screen.getByTitle('Current chat')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));
    const restoredTargetRow = screen.getByText('Background chat renamed').closest('.group');
    expect(within(restoredTargetRow).getByRole('button', { name: 'Remove star' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not let pagehide immediate flush resurrect a session behind delayed structural deletion', async () => {
    await i18n.changeLanguage('en');
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'structural-survivor',
      sessions: [
        {
          id: 'structural-survivor',
          title: 'Structural survivor',
          isTitleCustom: true,
          isStarred: true,
          updatedAt: 200,
          messages: [{ id: 'structural-survivor-user', role: 'user', content: 'Keep active session' }],
        },
        {
          id: 'structural-delete',
          title: 'Structural delete target',
          isTitleCustom: true,
          isStarred: false,
          updatedAt: 100,
          messages: [{ id: 'structural-delete-user', role: 'user', content: 'Remove this session' }],
        },
      ],
    };

    const defaultStorageSet = global.chrome.storage.local.set.getMockImplementation();
    let releaseDeletionWrite;
    let delayDeletionWrite = true;
    global.chrome.storage.local.set.mockImplementation((data, callback) => {
      if (
        delayDeletionWrite
        && Array.isArray(data?.sessions)
        && data.sessions.length === 1
        && data.sessions[0]?.id === 'structural-survivor'
      ) {
        delayDeletionWrite = false;
        return new Promise(resolve => {
          releaseDeletionWrite = async () => {
            await defaultStorageSet(data, callback);
            resolve();
          };
        });
      }
      return defaultStorageSet(data, callback);
    });

    const view = render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));
    const targetRow = screen.getByText('Structural delete target').closest('.group');
    fireEvent.click(within(targetRow).getByRole('button', { name: 'Delete chat' }));
    await waitFor(() => expect(releaseDeletionWrite).toBeTypeOf('function'));

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
    });
    view.unmount();
    await act(async () => {
      await releaseDeletionWrite();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(currentStorage.sessions.map(session => session.id)).toEqual([
      'structural-survivor',
    ]));
    const structuralWrites = global.chrome.storage.local.set.mock.calls.filter(([data]) => (
      Array.isArray(data?.sessions)
    ));
    expect(structuralWrites.every(([data]) => (
      data.sessions.every(session => session.id !== 'structural-delete')
    ))).toBe(true);

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));
    expect(screen.getByText('Structural survivor')).toBeInTheDocument();
    expect(screen.queryByText('Structural delete target')).not.toBeInTheDocument();
  });

  it('keeps a delayed two-session import authoritative across pagehide and remount', async () => {
    await i18n.changeLanguage('en');
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'import-alpha',
      sessions: [
        {
          id: 'import-alpha',
          title: 'Old active chat',
          isTitleCustom: true,
          isStarred: false,
          updatedAt: 200,
          messages: [{ id: 'old-import-alpha-user', role: 'user', content: 'Old active content' }],
        },
        {
          id: 'old-import-other',
          title: 'Old other chat',
          isTitleCustom: true,
          isStarred: true,
          updatedAt: 100,
          messages: [{ id: 'old-import-other-user', role: 'user', content: 'Old other content' }],
        },
      ],
    };
    const importedSessions = [
      {
        id: 'import-alpha',
        title: 'Imported Alpha',
        isTitleCustom: true,
        isStarred: true,
        updatedAt: 400,
        messages: [{ id: 'import-alpha-user', role: 'user', content: 'Alpha imported content' }],
      },
      {
        id: 'import-beta',
        title: 'Imported Beta',
        isTitleCustom: true,
        isStarred: false,
        updatedAt: 300,
        messages: [{ id: 'import-beta-user', role: 'user', content: 'Beta imported content' }],
      },
    ];

    const defaultStorageSet = global.chrome.storage.local.set.getMockImplementation();
    let releaseImportWrite;
    let delayImportWrite = true;
    global.chrome.storage.local.set.mockImplementation((data, callback) => {
      if (
        delayImportWrite
        && Array.isArray(data?.sessions)
        && data.sessions.map(session => session.id).join(',') === 'import-alpha,import-beta'
      ) {
        delayImportWrite = false;
        return new Promise(resolve => {
          releaseImportWrite = async () => {
            await defaultStorageSet(data, callback);
            resolve();
          };
        });
      }
      return defaultStorageSet(data, callback);
    });

    const view = render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const importInput = document.querySelector('input[type="file"][accept=".json"]');
    const importFile = new File([JSON.stringify({
      version: '1.1',
      sessions: importedSessions,
    })], 'two-sessions.json', { type: 'application/json' });
    fireEvent.change(importInput, { target: { files: [importFile] } });
    await waitFor(() => expect(releaseImportWrite).toBeTypeOf('function'));

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
    });
    view.unmount();
    await act(async () => {
      await releaseImportWrite();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(currentStorage.sessions.map(session => session.id)).toEqual([
      'import-alpha',
      'import-beta',
    ]));
    expect(currentStorage.sessions.some(session => session.id === 'old-import-other')).toBe(false);
    expect(currentStorage.activeSessionId).toBe('import-alpha');
    expect(currentStorage.sessions[0].messages).toEqual([
      expect.objectContaining({ id: 'import-alpha-user', content: 'Alpha imported content' }),
    ]);
    expect(currentStorage.sessions[0].messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'Old active content' }),
    ]));

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    expect(screen.getByTitle('Imported Alpha')).toBeInTheDocument();
    expect(await findChatText('Alpha imported content')).toBeInTheDocument();
    expect(screen.queryByText('Old active content')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));
    expect(screen.getByText('Imported Alpha')).toBeInTheDocument();
    expect(screen.getByText('Imported Beta')).toBeInTheDocument();
    expect(screen.queryByText('Old active chat')).not.toBeInTheDocument();
    expect(screen.queryByText('Old other chat')).not.toBeInTheDocument();
  });

  it('replaces old chats with one persisted default session after a valid empty import', async () => {
    await i18n.changeLanguage('en');
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'empty-import-old',
      sessions: [{
        id: 'empty-import-old',
        title: 'Old chat before empty import',
        isTitleCustom: true,
        isStarred: true,
        updatedAt: 100,
        messages: [{ id: 'empty-import-old-user', role: 'user', content: 'Replace old chat' }],
      }],
    };

    const view = render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const importInput = document.querySelector('input[type="file"][accept=".json"]');
    const emptyImportFile = new File([JSON.stringify({
      version: '1.1',
      sessions: [],
    })], 'empty-sessions.json', { type: 'application/json' });
    fireEvent.change(importInput, { target: { files: [emptyImportFile] } });

    await waitFor(() => {
      expect(currentStorage.sessions).toHaveLength(1);
      expect(currentStorage.sessions[0]).toMatchObject({
        title: 'New Chat',
        isTitleCustom: false,
        isStarred: false,
      });
      expect(currentStorage.sessions[0].id).not.toBe('empty-import-old');
      expect(currentStorage.activeSessionId).toBe(currentStorage.sessions[0].id);
    });
    expect(currentStorage.sessions[0].messages).toEqual([
      expect.objectContaining({ role: 'model', content: expect.any(String) }),
    ]);

    view.unmount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    expect(screen.getByTitle('New Chat')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));
    expect(screen.getByText('New Chat')).toBeInTheDocument();
    expect(screen.queryByText('Old chat before empty import')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bulk delete' })).toBeEnabled();
  });

  it('records dictation, appends the transcript, and never sends it automatically', async () => {
    await seedVaultKeys('gemini', [{ id: 'g1', key: 'secret', isPrimary: true }]);
    const tracks = [{ stop: vi.fn() }];
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn().mockResolvedValue({ state: 'granted' }) },
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => tracks }) },
    });
    class FakeMediaRecorder {
      static isTypeSupported = vi.fn().mockReturnValue(true);
      constructor() {
        this.state = 'inactive';
        this.mimeType = 'audio/webm;codecs=opus';
      }
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) });
        this.onstop?.();
      }
    }
    global.MediaRecorder = FakeMediaRecorder;

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    const textarea = document.querySelector('textarea');
    fireEvent.change(textarea, { target: { value: 'Existing draft' } });
    fireEvent.click(screen.getByRole('button', { name: /Voice Input|Sesli Giriş/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Stop Recording|Kaydı Durdur/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Stop Recording|Kaydı Durdur/i }));

    await waitFor(() => expect(textarea).toHaveValue('Existing draft\nVoice transcript'));
    expect(voiceApi.transcribeAudio).toHaveBeenCalledTimes(1);
    expect(global.chrome.runtime.sendMessage.mock.calls.some(([message]) => message?.type === 'HERA_GENERATION_START')).toBe(false);
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('cancels a pending microphone request when the permission window closes', async () => {
    await seedVaultKeys('gemini', [{ id: 'g1', key: 'secret', isPrimary: true }]);
    let removedListener;
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn().mockResolvedValue({ state: 'prompt' }) },
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });
    global.MediaRecorder = class PendingMediaRecorder {};
    global.chrome.windows.create.mockResolvedValue({ id: 77 });
    global.chrome.windows.onRemoved.addListener.mockImplementation(listener => { removedListener = listener; });

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Voice Input|Sesli Giriş/i }));
    await waitFor(() => expect(global.chrome.windows.create).toHaveBeenCalledTimes(1));
    expect(global.chrome.windows.create.mock.calls[0][0].url).toMatch(/mic-permission\.html\?requestId=/);
    act(() => removedListener(77));

    await waitFor(() => expect(screen.getByRole('button', { name: /Voice Input|Sesli Giriş/i })).toBeInTheDocument());
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(global.chrome.runtime.onMessage.removeListener).toHaveBeenCalled();
  });

  it('reads a completed assistant message with one Web Audio source', async () => {
    await seedVaultKeys('gemini', [{ id: 'g1', key: 'secret', isPrimary: true }]);
    currentStorage.sessions = [{
      id: 'speech-session',
      title: 'Speech',
      messages: [{ id: 'speech-message', role: 'model', content: 'Read this answer', status: 'done' }],
    }];
    currentStorage.activeSessionId = 'speech-session';
    const source = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(function start() { queueMicrotask(() => this.onended?.()); }),
      stop: vi.fn(),
      onended: null,
    };
    global.AudioContext = class FakeAudioContext {
      constructor() { this.state = 'running'; this.destination = {}; }
      resume = vi.fn().mockResolvedValue(undefined);
      close = vi.fn().mockResolvedValue(undefined);
      createBuffer = (_channels, length, sampleRate) => ({
        sampleRate,
        getChannelData: () => new Float32Array(length),
      });
      createBufferSource = () => source;
    };

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Read aloud|Sesli oku/i }));
    await waitFor(() => expect(voiceApi.generateSpeech).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(source.start).toHaveBeenCalledTimes(1));
    expect(voiceApi.generateSpeech.mock.calls[0][0].text).toBe('Read this answer');
  });

  it('keeps voice tools available without settings switches', async () => {
    await i18n.changeLanguage('en');
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Voice Input' })).toBeInTheDocument();
    openSettingsPanel();
    fireEvent.click(screen.getByRole('button', { name: /General Settings/i }));
    expect(screen.queryByRole('switch', { name: 'Gemini Dictation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Gemini Read Aloud (Preview)' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Voice features use your Gemini API key/i)).not.toBeInTheDocument();
  });

  it('reloads a both-resolved comparison without locking the composer', async () => {
    currentStorage = {
      theme: 'light',
      startupBehavior: 'resume',
      activeSessionId: 'both-session',
      sessions: [{
        id: 'both-session',
        title: 'Both resolved',
        updatedAt: Date.now(),
        messages: [
          { id: 'both-user', role: 'user', content: 'Which model writes better?', mode: 'chat' },
          {
            id: 'both-assistant:a', role: 'model', content: 'Answer A', status: 'done',
            comparisonId: 'cmp-both', variantId: 'a', comparisonSlot: 'a',
            comparisonSelected: true, selectable: false, contextExcluded: false,
            model: 'gemini-3.6-flash', provider: 'gemini', startedAt: Date.now() - 8000, completedAt: Date.now() - 3000,
          },
          {
            id: 'both-assistant:b', role: 'model', content: 'Answer B', status: 'done',
            comparisonId: 'cmp-both', variantId: 'b', comparisonSlot: 'b',
            comparisonSelected: true, selectable: false, contextExcluded: false,
            model: 'gemini-3.7-flash', provider: 'gemini', startedAt: Date.now() - 8000, completedAt: Date.now() - 1000,
          },
        ],
      }],
    };

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    expect(await screen.findByText('Answer A')).toBeInTheDocument();
    expect(screen.getByText('Answer B')).toBeInTheDocument();
    expect(screen.getByTestId('comparison-both-note')).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /Continue with this answer|Bu yanıtla devam et/i }))
      .toHaveLength(0);
    expect(document.querySelector('textarea')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Compare models|Modelleri karşılaştır/i })).not.toBeDisabled();

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Follow up after reload' } });
    fireEvent.click(getSendButton());

    let followUpStart;
    await waitFor(() => {
      followUpStart = global.chrome.runtime.sendMessage.mock.calls
        .map(([message]) => message)
        .find(message => message?.type === 'HERA_GENERATION_START'
          && message?.requestMessages?.some(item => item.content === 'Follow up after reload'));
      expect(followUpStart).toBeDefined();
    });
    const followUpContents = followUpStart.requestMessages.map(item => item.content);
    expect(followUpContents).toContain('Answer A');
    expect(followUpContents).toContain('Answer B');
    expect(global.chrome.runtime.sendMessage.mock.calls.some(([message]) => (
      message?.type === 'RESOLVE_COMPARISON_BOTH'
    ))).toBe(false);
  });

  it('pins the remaining read-aloud chunks to the fallback TTS model', async () => {
    await seedVaultKeys('gemini', [{ id: 'g1', key: 'secret', isPrimary: true }]);
    const longAnswer = `${'A clear spoken sentence. '.repeat(120)}`;
    currentStorage.sessions = [{
      id: 'speech-pin-session',
      title: 'Speech pin',
      messages: [{ id: 'speech-pin-message', role: 'model', content: longAnswer, status: 'done' }],
    }];
    currentStorage.activeSessionId = 'speech-pin-session';
    const source = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(function start() { queueMicrotask(() => this.onended?.()); }),
      stop: vi.fn(),
      onended: null,
    };
    global.AudioContext = class FakeAudioContext {
      constructor() { this.state = 'running'; this.destination = {}; }
      resume = vi.fn().mockResolvedValue(undefined);
      close = vi.fn().mockResolvedValue(undefined);
      createBuffer = (_channels, length, sampleRate) => ({
        sampleRate,
        getChannelData: () => new Float32Array(length),
      });
      createBufferSource = () => source;
    };
    voiceApi.generateSpeech
      .mockResolvedValueOnce({ pcm: new Uint8Array([0, 0]), sampleRate: 24000, model: 'gemini-2.5-flash-preview-tts' })
      .mockResolvedValue({ pcm: new Uint8Array([0, 0]), sampleRate: 24000, model: 'gemini-2.5-flash-preview-tts' });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Read aloud|Sesli oku/i }));

    await waitFor(() => expect(voiceApi.generateSpeech).toHaveBeenCalledTimes(2));
    expect(voiceApi.generateSpeech.mock.calls[0][0]).not.toHaveProperty('model');
    expect(voiceApi.generateSpeech.mock.calls[1][0].model).toBe('gemini-2.5-flash-preview-tts');
  });

  it('sends a model-override retry as manual so auto routing does not override it', async () => {
    currentStorage = {
      theme: 'light',
      modelSelectionMode: 'auto',
      activeSessionId: 'retry-override-session',
      sessions: [{
        id: 'retry-override-session',
        title: 'Retry override',
        updatedAt: Date.now(),
        messages: [
          { id: 'retry-user', role: 'user', content: 'Original question', mode: 'chat' },
          {
            id: 'retry-answer', userMessageId: 'retry-user', role: 'model',
            content: 'Old answer', status: 'done', sources: [],
          },
        ],
      }],
    };

    render(<App />);
    const oldAnswer = await screen.findByText('Old answer');
    const assistantMessage = oldAnswer.closest('[data-testid="assistant-message"]');
    fireEvent.click(assistantMessage.querySelector('button[aria-haspopup="dialog"]'));
    fireEvent.click(screen.getByRole('button', { name: 'Gemini 3.7 Flash' }));

    let retryStart;
    await waitFor(() => {
      retryStart = global.chrome.runtime.sendMessage.mock.calls
        .map(([message]) => message)
        .find(message => message?.type === 'HERA_GENERATION_START'
          && message?.requestMessages?.some(item => item.content === 'Original question'));
      expect(retryStart).toBeDefined();
    });
    expect(retryStart.model).toBe('gemini-3.7-flash');
    expect(retryStart.selectionMode).toBe('manual');
  });

  it('records one prompt and one search tool usage for a web send', async () => {
    api.streamResearch.mockImplementationOnce(() => mockStream([
      { event: 'chunk', data: { text: 'Research answer' } },
    ]));
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const webButton = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-globe'));
    fireEvent.click(webButton);
    fireEvent.change(document.querySelector('textarea'), { target: { value: 'hello research' } });
    fireEvent.click(getSendButton());

    await waitFor(() => expect(currentStorage.stats?.lifetime?.prompts).toBe(1));
    expect(currentStorage.stats.lifetime.tools.search).toBe(1);
    expect(currentStorage.stats.lifetime.tools.voice).toBe(0);
  });

  it('records a completed single generation with model outcome and duration', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    fireEvent.change(document.querySelector('textarea'), { target: { value: 'hello stats' } });
    fireEvent.click(getSendButton());

    expect(await screen.findByText('Hello from AI')).toBeInTheDocument();
    await waitFor(() => expect(currentStorage.stats?.lifetime?.byOutcome?.completed).toBe(1));
    expect(currentStorage.stats.lifetime.prompts).toBe(1);
    const rows = Object.values(currentStorage.stats.lifetime.models);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ modelId: 'gemini-3.1-flash-lite', attempts: 1, successes: 1 });
    expect(rows[0].successDurationMs).toBeGreaterThanOrEqual(0);
    expect(currentStorage.stats.lifetime.successDurationMs).toBe(rows[0].successDurationMs);
  });

  it('freezes the displayed duration at presentation end while stats use stream end', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const startedAt = Date.now() - 8000;
    const streamEndedAt = startedAt + 5000;
    const runningGeneration = {
      jobId: 'duration-job',
      requestId: 'duration-job',
      sessionId: 'duration-session',
      userMessageId: 'duration-user',
      assistantMessageId: 'duration-assistant',
      status: 'running',
      revision: 1,
      content: '',
      sources: [],
      model: 'gemini-3.1-flash-lite',
      provider: 'gemini',
      startedAt,
      updatedAt: Date.now(),
    };
    const externalSession = {
      id: 'duration-session',
      title: 'Duration session',
      updatedAt: Date.now(),
      messages: [
        { id: 'duration-user', role: 'user', content: 'How long did this take?' },
        {
          id: 'duration-assistant',
          role: 'model',
          content: '',
          status: 'streaming',
          sources: [],
          startedAt,
          completedAt: null,
        },
      ],
    };
    const previousSessions = currentStorage.sessions;
    const previousActiveSessionId = currentStorage.activeSessionId;
    currentStorage = {
      ...currentStorage,
      sessions: [...previousSessions, externalSession],
      activeSessionId: externalSession.id,
      activeGeneration: runningGeneration,
    };
    triggerStorageChange({
      sessions: { oldValue: previousSessions, newValue: currentStorage.sessions },
      activeSessionId: { oldValue: previousActiveSessionId, newValue: externalSession.id },
      activeGeneration: { oldValue: undefined, newValue: runningGeneration },
    });

    expect(await screen.findByText('How long did this take?')).toBeInTheDocument();

    const terminalGeneration = {
      ...runningGeneration,
      status: 'completed',
      revision: 2,
      content: 'Eight seconds of work.',
      completedAt: streamEndedAt,
      updatedAt: streamEndedAt,
    };
    const emitTime = Date.now();
    currentStorage.activeGeneration = terminalGeneration;
    emitRuntimeMessage({ type: 'DONE', activeGeneration: terminalGeneration });

    expect(await screen.findByText('Eight seconds of work.', {}, { timeout: 5000 })).toBeInTheDocument();
    await waitFor(() => {
      const persistedSession = currentStorage.sessions.find(session => session.id === externalSession.id);
      const assistant = persistedSession?.messages?.find(message => message.id === 'duration-assistant');
      expect(assistant?.status).toBe('done');
      expect(assistant?.completedAt).toBeGreaterThanOrEqual(emitTime);
    });
    await waitFor(() => expect(currentStorage.stats?.lifetime?.byOutcome?.completed).toBe(1));
    expect(currentStorage.stats.lifetime.successDurationMs).toBe(5000);
  });

  it('records each comparison variant separately with a single prompt', async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Compare models|Modelleri karşılaştır/i }));
    const dialog = await screen.findByRole('dialog', { name: /Compare two models|İki modeli karşılaştır/i });
    const selects = within(dialog).getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'gemini:gemini-3.6-flash' } });
    fireEvent.change(selects[1], { target: { value: 'gemini:gemini-3.7-flash' } });
    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Which model writes better?' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Start comparison|Karşılaştırmayı başlat/i }));

    let startMessage;
    await waitFor(() => {
      startMessage = global.chrome.runtime.sendMessage.mock.calls
        .map(([message]) => message)
        .find(message => message?.type === 'HERA_GENERATION_START' && message?.kind === 'comparison');
      expect(startMessage).toBeDefined();
    });
    const { jobId, sessionId, userMessageId, assistantMessageId } = startMessage;
    const doneAt = Date.now();
    emitRuntimeMessage({
      type: 'DONE',
      activeGeneration: {
        jobId,
        kind: 'comparison',
        comparisonId: jobId,
        sessionId,
        userMessageId,
        assistantMessageId,
        mode: 'chat',
        status: 'completed',
        revision: 2,
        content: '',
        sources: [],
        completedAt: doneAt,
        variants: {
          a: {
            variantId: 'a', status: 'completed', content: 'Answer A', sources: [],
            resolvedModel: null, revision: 2, errorCode: null, completedAt: doneAt,
            model: 'gemini-3.6-flash', provider: 'gemini',
          },
          b: {
            variantId: 'b', status: 'completed', content: 'Answer B', sources: [],
            resolvedModel: null, revision: 2, errorCode: null, completedAt: doneAt,
            model: 'gemini-3.7-flash', provider: 'gemini',
          },
        },
      },
    });

    expect(await screen.findByText('Answer A')).toBeInTheDocument();
    await waitFor(() => expect(currentStorage.stats?.lifetime?.byOutcome?.completed).toBe(2));
    expect(currentStorage.stats.lifetime.prompts).toBe(1);
    const rows = Object.values(currentStorage.stats.lifetime.models);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual(expect.objectContaining({ modelId: 'gemini-3.6-flash', attempts: 1, successes: 1 }));
    expect(rows).toContainEqual(expect.objectContaining({ modelId: 'gemini-3.7-flash', attempts: 1, successes: 1 }));
  });

  it('surfaces a failed storage write instead of losing the chat silently', async () => {
    const toastError = vi.spyOn(toast, 'error');
    currentStorage = { theme: 'light', sessions: [], activeSessionId: null };

    render(<App />);
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const originalSet = global.chrome.storage.local.set;
    global.chrome.storage.local.set = vi.fn(() => Promise.reject(new Error('QUOTA_BYTES quota exceeded')));
    try {
      fireEvent.click(screen.getByRole('button', { name: /Start New Chat|Yeni Sohbet Başlat/i }));

      await waitFor(() => expect(toastError).toHaveBeenCalledWith(
        expect.stringMatching(/could not be saved|kaydedilemedi/i),
        expect.any(Object),
      ));
    } finally {
      global.chrome.storage.local.set = originalSet;
    }
  });
});
