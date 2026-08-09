# HeraAi

AI-powered Chrome extension built with React 19, Vite 7, and Tailwind CSS.

HeraAi runs fully inside the Chrome extension. There is no Express backend and no `.env` file. Gemini and Tavily API keys are added from the extension settings and stored locally in `chrome.storage.local`.

## Architecture

```
Chrome Extension
  ├─ React side panel UI
  ├─ chrome.storage.local API key storage
  ├─ Direct Gemini API calls for chat and vision
  └─ Direct Tavily API calls for web research
```

## Prerequisites

- Node.js 18+
- npm 9+
- Chrome browser
- Gemini API key from Google AI Studio
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
3. Add at least one Gemini API key.
4. Optional: add a Tavily API key for Web Research mode.
5. Save settings.

Keys are stored only in `chrome.storage.local` on this device (`chrome.storage.sync` is never used). Real key values are masked in the UI as `AIza...xYz9`. Add as many keys as you want for each provider; the first key you add becomes the primary, and the rest are fallback keys.

Fallback behavior is primary-first, not round-robin: the primary key is used on every request. If the primary returns a rate limit (429), quota exhaustion, timeout, or other transient provider error, HeraAi tries the next available fallback key for that request, then resumes the primary once its cooldown clears. Invalid keys, policy/safety refusals, and bad request errors do not trigger fallback.

If every key for a required provider is in cooldown at the same time, the request is blocked and HeraAi shows the earliest retry time instead of failing silently.

## Web Research Mode

Use the globe button in the chat input area.

- Off: Gemini answers from the chat context.
- On: Tavily searches the web, then Gemini writes an answer using the search results and sources.

Tavily is only contacted when Web Research is on. Translate, Summarize, Explain, Vision and OCR all use Gemini only. If no Tavily key is configured, normal chat still works; only Web Research is unavailable.

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
  lib/api.js               Direct Gemini and Tavily API client
  lib/keyManager.js        Local API key storage helpers
  locales/                 i18n translations
manifest.json              Chrome extension manifest
vite.config.js             Vite + CRX config
```
