import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from './App';
import * as api from './lib/api';

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

// Mock api module
vi.mock('./lib/api', () => ({
  streamChat: vi.fn(),
  streamResearch: vi.fn(),
  streamVision: vi.fn(),
  checkHealth: vi.fn(),
}));

async function* mockStream(events) {
  for (const evt of events) {
    yield evt;
  }
}

describe('HeraAi App (TestSprite Target Tests)', () => {
  let currentStorage = {};

  beforeEach(() => {
    vi.clearAllMocks();
    currentStorage = {
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
    
    // Setup generic stream response
    api.streamChat.mockImplementation(() => {
      return mockStream([{ event: 'chunk', data: { text: 'Hello from AI' } }, { event: 'done', data: {} }]);
    });
  });

  // TC001: Send a chat message and receive a streamed AI response (and TC005 clear input)
  it('should send a message, display it, clear input and show AI response', async () => {
    render(<App />);
    
    // Wait for load
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
    render(<App />);
    
    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());
    
    const input = document.querySelector('textarea') || screen.getByRole('textbox');
    const sendBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-send') || btn.title?.match(/Send/i));
    
    // No text typed, just click send
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.click(sendBtn);
    
    // Verify no stream was called
    expect(api.streamChat).not.toHaveBeenCalled();
  });

  // TC008: Save backend URL from Settings
  it('should be able to save backend URL from settings', async () => {
    render(<App />);

    await waitFor(() => expect(document.querySelector('textarea')).toBeInTheDocument());

    // Open settings via gear button
    const settingsBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.title?.match(/Settings/i));
    fireEvent.click(settingsBtn);

    // Wait for settings to appear
    await waitFor(() => {
      expect(screen.getByText(/Backend URL/i)).toBeInTheDocument();
    });

    // Find the backend URL input
    const urlInput = document.querySelector('input[type="text"]');
    expect(urlInput).toBeInTheDocument();
    
    // Change URL
    fireEvent.change(urlInput, { target: { value: 'http://localhost:4000' } });
    
    // Click save button
    const saveBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('svg.lucide-save'));
    expect(saveBtn).toBeInTheDocument();
    fireEvent.click(saveBtn);
    
    // Should close settings
    await waitFor(() => {
      expect(screen.queryByText(/Backend URL/i)).not.toBeInTheDocument();
    });
  });
});
