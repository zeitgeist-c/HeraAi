# AGENTS.md - Hera Project Guidelines

## Project Overview

Hera is a Chrome extension built with React 19, Vite 7, and Tailwind CSS. It provides AI-powered assistance using Google Gemini, OpenRouter Free, Ollama Cloud, and Tavily with support for multiple languages (i18next).

The extension runs in two primary contexts:
- **Side Panel (UI)**: The main React application (`src/App.jsx`).
- **Background Service Worker**: Handled by `src/background/service_worker.js` for intercepting extension events (like capturing screen tabs) and relaying them to the frontend.

## API Providers

Hera uses four provider APIs:
1. **Google Gemini (Direct)**: Streams chat and multimodal responses, accepts image/PDF inline data, and reads public URLs through URL Context.
2. **Tavily**: Provides general web search and exact-page extraction fallback when Gemini URL Context cannot retrieve a public URL.
3. **OpenRouter (Direct)**: Streams the catalogued OpenRouter models (Qwen3.8 27B, Nex-N2.5 Pro, Nemotron 3.5 Lightning) through SSE, falling back to the `openrouter/free` router when a model fails before producing content.
4. **Ollama Cloud (Direct)**: Streams `nemotron-3-ultra`, `nemotron-3-super`, and `gpt-oss:120b` text responses through NDJSON.

## Core Features & Data Flow

### 1. Storage (`chrome.storage.local`)
The application relies heavily on local Chrome storage for state persistence. Key variables include:
- `apiKeys` (Array): Saved API keys.
- `activeKeyIndex` (Int): Currently selected API key index.
- `sessions` (Array): Chat history structured locally.
- `theme` (String): UI theme (`light`, `dark`, or `system`).

### 2. Screen Capture (Cropping)
Hera allows users to crop sections of the active website.
1. User clicks the crop icon in React UI.
2. `chrome.tabs.captureVisibleTab` takes a screenshot of the active window.
3. The image is loaded into a `<canvas>` overlay where the user drags a selection box.
4. The cropped image is stored in the extension's `heraai-attachments` IndexedDB database and messages retain metadata-only attachment references.

**Limitation Warning:** Chrome security policies prevent screenshots on internal URLs like `chrome://`, `chrome-extension://`, and empty fallback pages.

## Build / Lint / Test Commands

```bash
# Install dependencies
npm install

# Start development server (with HMR)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Run ESLint
npm run lint

# Run the Vitest suite in watch mode (use `npm run test:run` for a single pass)
npm run test
```

### Testing Setup (Vitest + JSDOM)

This project uses **Vitest** for its test runner with `@testing-library/react` and `jsdom`. 

Test files map against **TestSprite UI Verification Plans** (found in `testsprite_tests/`). 
1. Since tests run in Node.js, **Browser Extension APIs** (`global.chrome`) restrict DOM rendering.
2. We mock `chrome.storage.local.get / set` natively inside `vitest.setup.js` ensuring component behaviors trigger without runtime crashes.

## Code Style Guidelines

### General Principles

- Use functional components with hooks (React 19)
- Prefer ES6+ features (const/let, arrow functions, destructuring, template literals)
- Keep components small and focused (single responsibility)
- Use meaningful, descriptive names

### Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Components | PascalCase | `SettingsPanel`, `ChatMessage` |
| Functions/variables | camelCase | `handleSave`, `activeIndex` |
| Constants | UPPER_SNAKE_CASE | `MAX_FILE_SIZE`, `API_BASE_URL` |
| Files (components) | PascalCase + .jsx | `SettingsPanel.jsx` |
| Files (utils/lib) | camelCase + .js | `gemini.js`, `fileParsers.js` |
| CSS classes | kebab-case (Tailwind) | `flex items-center gap-2` |

### Imports Organization

Order imports in the following groups (blank line between groups):

1. **React/Node built-ins**: `useState`, `useEffect`, `useRef`
2. **External libraries**: `lucide-react`, `react-markdown`, `toast`
3. **i18n**: `useTranslation` from `react-i18next`
4. **Internal components**: (if in same project)
5. **Internal lib/utils**: `../lib/gemini`, `./fileParsers`
6. **Styles/assets**: (rarely needed with Tailwind)

### React Patterns

- Use `memo()` for expensive components
- Use `useCallback` for event handlers passed to children
- Use `useState` with functional updates when applicable
- Destructure props with default values when appropriate
- Use early returns for conditional rendering

### Error Handling

- Use try/catch for async operations
- Log errors with `console.error`
- Provide user-friendly error messages via `react-hot-toast` (`toast.error()`)
- Handle errors at component level or with error boundaries

### TypeScript & JavaScript

This project uses **JavaScript only** (no TypeScript) combined with **JSDoc** definitions for complex module integrations (`gemini.js` & `fileParsers.js`).

### CSS / Tailwind

- Use Tailwind utility classes exclusively
- Use semantic color tokens from tailwind.config.js:
  - `background`, `foreground`, `primary`, `secondary`
  - `muted`, `accent`, `destructive`
  - `border`, `input`, `ring`
- Use `hsl(var(--color))` pattern for theme colors

### ESLint Rules

- Extends: `js/configs.recommended`, `reactHooks.configs.flat.recommended`, `reactRefresh.configs.vite`
- `no-unused-vars`: Error for unused vars (except those starting with `_` or uppercase)
- React Hooks: Enforced exhaustive deps and rules of hooks

Run `npm run lint` before committing.

### i18n (Internationalization)

- Use `react-i18next` for all user-facing strings
- Use the `t()` hook from `useTranslation()`
- Translation keys should be descriptive and hierarchical

## Common Tasks

### Adding a New Feature

1. Create component in appropriate directory
2. Add translations in `locales/en.json` and `locales/tr.json`
3. Run `npm run lint` to check code
4. Map feature to a new TC (Test Case) scenario inside `src/App.test.jsx`.
5. Run `npm run test` to guarantee Vitest checks clear before pushing.
6. Run `npm run build` to test production build.

### Debugging

- Use `console.log` for development debugging.
- Use `toast.error()` to show user-facing errors.
- Check Chrome DevTools console for extension errors (Right click -> Inspect on the Side Panel).
- Background worker errors must be viewed explicitly from `chrome://extensions` by clicking **Inspect views: service worker**.
- If UI is freezing or throwing `undefined` exceptions during tests, check `vitest.setup.js` to ensure the chrome property is successfully mocked.
