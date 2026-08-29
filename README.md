# HeraAi

AI-powered Chrome extension built with React 19, Vite 7, and Tailwind CSS.

HeraAi runs fully inside the Chrome extension. There is no Express backend and no `.env` file. Gemini, OpenRouter, Ollama Cloud, and Tavily API keys are added from the extension settings and stored locally in `chrome.storage.local`.

## Architecture

```
Chrome Extension
  ├─ React side panel UI
  ├─ chrome.storage.local API key storage
  ├─ Provider adapters for Gemini, OpenRouter Free, and Ollama Cloud
  └─ Direct Tavily API calls for web research
```

## Prerequisites

- Node.js 18+
- npm 9+
- Chrome browser
- An API key for at least one AI provider: Gemini, OpenRouter, or Ollama Cloud
- Tavily API key only if you want Web Research mode

## Setup

```bash
npm install
npm run dev
```

For a production extension build:

```bash
npm run build
```

Load the generated `dist/` folder as an unpacked Chrome extension.

To create a single distributable file for sharing:

```bash
npm run package
```

This creates `release/HeraAi-<version>.zip` using the version from `manifest.json`. Share that zip with the target machine, then unzip it and load the unpacked extension folder in Chrome.

## API Keys

1. Open the HeraAi side panel.
2. Click Settings.
3. Add at least one key for the provider you want to use.
4. Optional: add a Tavily API key for Web Research mode.
5. Save settings.

Keys are stored only in trusted extension contexts in `chrome.storage.local` on this device (`chrome.storage.sync` is never used). They are not encrypted, and real values are masked in the UI. Add as many keys as you want for each provider; the first key becomes primary and the rest are fallback keys.

Fallback behavior is primary-first, not round-robin. Before the first response token, HeraAi automatically tries the next key from the same provider after credential/permission, quota/rate-limit, timeout/network, or temporary service errors. It never switches provider or moves OpenRouter to a paid model automatically, and it never changes keys after a partial response begins.

The model selector contains four Gemini models, `OpenRouter Free` (`openrouter/free`), and `MiniMax M3 (Ollama Cloud)` (`minimax-m3`). OpenRouter reports the actual routed model on each answer. Ollama Cloud key testing sends a minimal generation request and consumes a small amount of quota. PDF attachments and voice features remain Gemini-only; images and extracted text documents work with all three AI providers.

If every key for a required provider is in cooldown at the same time, the request is blocked and HeraAi shows the earliest retry time instead of failing silently.

## Web Research Mode

Use the globe button in the chat input area.

- Off: the selected model answers from the chat context.
- On, with no URL: Tavily searches the web, then the selected model writes one final answer using the results and sources.
- On, with public URLs: Gemini models try Gemini URL Context first; OpenRouter and Ollama require Tavily Extract.

Tavily is only contacted when Web Research is on. Search queries are prepared locally without an extra model call. General search requires Tavily; exact public URL reading can work without Tavily only when a Gemini model successfully uses URL Context.

## Personal Use Notice

HeraAi is intended for personal or local use. API keys live in the browser on the machine where they are entered. Do not embed your own API key in a packaged distribution or share it with others; each user should add their own keys from Settings.

## Available Scripts

```bash
npm run dev       # Start Vite development server
npm run build     # Build the Chrome extension
npm run package   # Build and create a single zip package
npm run preview   # Preview production build
npm run lint      # Run ESLint
npm run test      # Run Vitest in watch mode
npm run test:run  # Run Vitest once
```

## Project Structure

```
src/
  App.jsx                  Main side panel application
  background/              Chrome extension service worker
  components/              React UI components
  lib/api.js               Provider coordination and Tavily research
  lib/providerApi.js       OpenRouter SSE and Ollama NDJSON adapters
  lib/models.js            Provider-aware model catalog
  lib/keyManager.js        Local API key storage helpers
  locales/                 i18n translations
manifest.json              Chrome extension manifest
vite.config.js             Vite + CRX config
```
