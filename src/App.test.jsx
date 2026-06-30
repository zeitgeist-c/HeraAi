import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from './App';
import * as geminiApi from './lib/gemini';

// Mock matchMedia
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

// Mock gemini api
vi.mock('./lib/gemini', () => ({
  initGemini: vi.fn(),
  streamChatResponse: vi.fn(),
}));

describe('HeraAi App (TestSprite Target Tests)', () => {
  let currentStorage = {};

  beforeEach(() => {
    vi.clearAllMocks();
    currentStorage = {
      geminiApiKey: 'test-api-key',
      apiKeys: ['test-api-key'],
      activeKeyIndex: 0,
      theme: 'light',
    };
    
    // Default Chrome mock behavior for this suite
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
    
    // Setup generic user stream response
    geminiApi.streamChatResponse.mockImplementation((history, message, attachments, options, onChunk) => {
      return new Promise((resolve) => {
        setTimeout(() => {
          if(onChunk) onChunk('Hello from AI');
          resolve();
        }, 10);
      });
    });
  });

  // TC001: Send a chat message and receive a streamed AI response (and TC005 clear input)
  it('should send a message, display it, clear input and show AI response', async () => {
    currentStorage = { geminiApiKey: 'valid-key', apiKeys: ['valid-key'], activeKeyIndex: 0 };
    render(<App />);
    
    // Wait for load
    await waitFor(() => expect(screen.queryByText(/HeraAi Setup/i)).not.toBeInTheDocument());
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    expect(input).toBeInTheDocument();

    const sendBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-send') || btn.title?.match(/Send/i));
    
    // Type and send
    fireEvent.change(input, { target: { value: 'Hello Gemini, fun fact.' } });
    fireEvent.click(sendBtn);

    // Assert user message is visible
    expect(await screen.findByText('Hello Gemini, fun fact.')).toBeInTheDocument();
    
    // Assert input is cleared (TC005)
    expect(input.value).toBe('');
    
    // Assert AI response appears
    expect(await screen.findByText('Hello from AI')).toBeInTheDocument();
  });

  // TC003: Empty message validation prevents sending
  it('should not allow empty message to be sent', async () => {
    currentStorage = { geminiApiKey: 'valid-key', apiKeys: ['valid-key'], activeKeyIndex: 0 };
    render(<App />);
    
    await waitFor(() => expect(screen.queryByText(/HeraAi Setup/i)).not.toBeInTheDocument());
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    
    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    const sendBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-send') || btn.title?.match(/Send/i));
    
    // No text typed, just click send
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.click(sendBtn);
    
    // Verify no tool call was made to gemini
    expect(geminiApi.streamChatResponse).not.toHaveBeenCalled();
  });

  // TC008: Save a new valid API key from Settings (API tab)
  it('should be able to save a valid API key from settings', async () => {
    // Start with no key to trigger settings
    currentStorage = { apiKeys: [] };
    render(<App />);

    // Wait until settings panel or add key button is rendered
    await waitFor(() => {
        expect(screen.getByText(/HeraAi Setup/i)).toBeInTheDocument();
    });

    const inputE = document.querySelector('input[type="password"]');
    expect(inputE).toBeInTheDocument();
    
    // Type valid key
    fireEvent.change(inputE, { target: { value: 'NEW-VALID-KEY' } });
    
    // Click Ekle (Add) button
    const addBtn = screen.getByText(/Ekle/i);
    fireEvent.click(addBtn);
    
    // Click Kaydet (Save)
    const saveBtn = screen.getByText(/Kaydet/i);
    fireEvent.click(saveBtn);
    
    // Should call initGemini
    await waitFor(() => {
      expect(geminiApi.initGemini).toHaveBeenCalledWith('NEW-VALID-KEY');
    });
  });

});
