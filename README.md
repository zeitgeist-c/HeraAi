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

This creates `release/HeraAi-extension.zip`. Share that zip with the target machine, then unzip it and load the unpacked `dist/` folder in Chrome.

## API Keys

1. Open the HeraAi side panel.
2. Click Settings.
3. Add at least one Gemini API key.
4. Optional: add a Tavily API key for Web Research mode.
5. Save settings.

Multiple keys are supported. HeraAi tries the primary key first and can fall back to other saved keys when a provider rate limit or temporary error is detected.

## Web Research Mode

Use the globe button in the chat input area.

- Off: Gemini answers from the chat context.
- On: Tavily searches the web, then Gemini writes an answer using the search results and sources.

If Tavily is not configured, normal chat still works.

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
