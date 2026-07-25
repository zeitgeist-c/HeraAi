import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import App from './App';
import * as api from './lib/api';

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

describe('HeraAi App', () => {
  let currentStorage = {};
  let storageListeners = [];

  const triggerStorageChange = (changes) => {
    act(() => {
      storageListeners.forEach(listener => listener(changes, 'local'));
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    storageListeners = [];
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

  it('should combine multiple chunks into one assistant message and save the session once after streaming', async () => {
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
    expect(sessionWrites).toHaveLength(1);
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

    const messageCards = Array.from(document.querySelectorAll('.group.flex'));
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

    expect(await screen.findByText(/Response failed|Yan/)).toBeInTheDocument();
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
    expect(scrollContainer.scrollTop).toBe(scrollContainer.scrollHeight);

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
    const runtimeListeners = [];
    const originalCreateElement = document.createElement.bind(document);
    const OriginalImage = global.Image;
    let canvasIndex = 0;
    global.chrome.runtime.onMessage.addListener.mockImplementation((listener) => {
      runtimeListeners.push(listener);
    });
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

    await act(async () => {
      runtimeListeners[0]({
        type: 'HERAAI_CROP_DONE',
        coords: { x: 0, y: 0, width: 10, height: 10, pixelRatio: 1, viewportWidth: 10, viewportHeight: 10 },
      });
    });
    await waitFor(() => expect(screen.getByText(/screenshot-/)).toBeInTheDocument());
    await act(async () => {
      runtimeListeners[0]({
        type: 'HERAAI_CROP_DONE',
        coords: { x: 0, y: 0, width: 10, height: 10, pixelRatio: 1, viewportWidth: 10, viewportHeight: 10 },
      });
    });
    await waitFor(() => expect(screen.getAllByText(/screenshot-/)).toHaveLength(2));

    const translateButton = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-languages'));
    fireEvent.click(translateButton);

    expect(await screen.findByText('Translated all crops')).toBeInTheDocument();
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

    const settingsBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-settings'));
    fireEvent.click(settingsBtn);

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
    expect(await screen.findByText('Extracted OCR text')).toBeInTheDocument();
  });

  it('renders Gemini and Tavily key inputs as type=password', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const settingsBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-settings'));
    fireEvent.click(settingsBtn);

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(2);
    });

    expect(document.querySelectorAll('input[type="text"]').length).toBe(0);
  });

  it('toggles a Gemini password input to text and back via the eye button', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const settingsBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-settings'));
    fireEvent.click(settingsBtn);

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

    const settingsBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-settings'));
    fireEvent.click(settingsBtn);

    expect(await screen.findByText(/API keys are stored in this browser|API anahtarları yalnızca bu cihazdaki/i)).toBeInTheDocument();
  });

  it('writes a quota_exceeded status marker when a Tavily key test reports quota exhausted', async () => {
    api.testKey.mockResolvedValueOnce({ success: false, provider: 'tavily', errorType: 'quota' });
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const settingsBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-settings'));
    fireEvent.click(settingsBtn);

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

  it('blocks the request with a cooldown signal when every Gemini key is in cooldown', async () => {
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

    await waitFor(() => {
      expect(api.streamChat).not.toHaveBeenCalled();
    });

    const main = document.querySelector('main');
    expect(main?.textContent || '').not.toContain('please answer while all keys are rate-limited');
  });

  it('calls testKey once per saved Gemini key when clicking Test All', async () => {
    api.testKey.mockResolvedValue({ success: true, provider: 'gemini' });

    currentStorage.geminiApiKeys = [
      { id: 'k1', key: 'AIza-aaaaaaaaaaaaa-key1', masked: 'AIza...key1', isPrimary: true, createdAt: 1000 },
      { id: 'k2', key: 'AIza-bbbbbbbbbbbbbb-key2', masked: 'AIza...key2', isPrimary: false, createdAt: 2000 },
    ];

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const settingsBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-settings'));
    fireEvent.click(settingsBtn);

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(2);
    });

    const testAllBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent?.match(/Test All|Tümünü Test Et/i));
    fireEvent.click(testAllBtn);

    await waitFor(() => {
      expect(api.testKey).toHaveBeenCalledTimes(2);
    });
  });

  it('moves a chosen Gemini key above the previous primary when clicking Set as Primary', async () => {
    currentStorage.geminiApiKeys = [
      { id: 'k1', key: 'AIza-aaaaaaaaaaaaa-key1', masked: 'AIza...key1', isPrimary: true, createdAt: 1000 },
      { id: 'k2', key: 'AIza-bbbbbbbbbbbbbb-key2', masked: 'AIza...key2', isPrimary: false, createdAt: 2000 },
    ];

    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const settingsBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-settings'));
    fireEvent.click(settingsBtn);

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(2);
    });

    const keyRows = () => Array.from(document.querySelectorAll('span.text-sm.font-mono'));

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

    const settingsBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-settings'));
    fireEvent.click(settingsBtn);

    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]').length).toBe(2);
    });

    const geminiInput = document.querySelectorAll('input[type="password"]')[0];
    fireEvent.change(geminiInput, { target: { value: 'AIza-freshly-added-key-AAAA' } });

    const addBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent?.match(/Add Key|Anahtar Ekle/i));
    fireEvent.click(addBtn);

    expect(await screen.findByText(/^Pending$|^Bekliyor$/)).toBeInTheDocument();
  });

  it('renders a model selector in the header with the 4 supported model ids', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const modelSelect = document.querySelector('select[data-testid="model-selector"]');
    expect(modelSelect).toBeInTheDocument();

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
});
