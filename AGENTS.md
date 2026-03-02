# AGENTS.md - Hera Project Guidelines

## Project Overview

Hera is a Chrome extension built with React 19, Vite 7, and Tailwind CSS. It provides AI-powered assistance using Google's Gemini API with support for multiple languages (i18next).

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
```

### Running a Single Test

This project currently has **no test framework configured**. There are no test scripts in package.json.

To add tests, consider installing:
- Vitest (matches Vite): `npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom`
- Jest: `npm install -D jest @testing-library/react`

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

```jsx
// Example import order
import { useState, useEffect } from 'react'
import { Settings, Key, Save } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { initGemini, streamChatResponse } from '../lib/gemini'
```

### React Patterns

- Use `memo()` for expensive components
- Use `useCallback` for event handlers passed to children
- Use `useState` with functional updates when applicable
- Destructure props with default values when appropriate
- Use early returns for conditional rendering

```jsx
// Good patterns
function SettingsPanel({ onSave, currentConfig }) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState('api')

  const handleAddKey = useCallback(() => {
    if (!newKey.trim()) return
    // ...
  }, [newKey])

  if (!currentConfig) return null

  return ( ... )
}
```

### Error Handling

- Use try/catch for async operations
- Log errors with `console.error`
- Provide user-friendly error messages via toast
- Handle errors at component level or with error boundaries

```jsx
try {
  const result = await apiCall()
  onSuccess(result)
} catch (error) {
  console.error("API Error:", error)
  onError(error.message || "An error occurred")
}
```

### TypeScript

This project uses **JavaScript only** (no TypeScript). However:
- Use JSDoc comments for complex functions if needed
- Keep props well-documented
- Consider migrating to TypeScript for new features

### CSS / Tailwind

- Use Tailwind utility classes exclusively
- Use semantic color tokens from tailwind.config.js:
  - `background`, `foreground`, `primary`, `secondary`
  - `muted`, `accent`, `destructive`
  - `border`, `input`, `ring`
- Use `hsl(var(--color))` pattern for theme colors

```jsx
// Good Tailwind usage
<div className="flex items-center gap-2 p-4 bg-primary/20 rounded-xl">
  <Settings className="w-8 h-8 text-primary" />
  <h1 className="text-2xl font-bold text-foreground">Title</h1>
</div>
```

### ESLint Rules

The project uses ESLint with these rules:
- Extends: `js/configs.recommended`, `reactHooks.configs.flat.recommended`, `reactRefresh.configs.vite`
- `no-unused-vars`: Error for unused vars (except those starting with `_` or uppercase)
- React Hooks: Enforced exhaustive deps and rules of hooks

Run `npm run lint` before committing.

### i18n (Internationalization)

- Use `react-i18next` for all user-facing strings
- Use the `t()` hook from `useTranslation()`
- Translation keys should be descriptive and hierarchical

```jsx
const { t } = useTranslation()
<p>{t('setup.api.saved_success')}</p>
```

### Chrome Extension Specifics

- Use `chrome.storage.local` for persistent storage
- Background scripts go in `src/background/service_worker.js`
- Manifest V3 format in `manifest.json`
- Use @crxjs/vite-plugin for CRX packaging

## Project Structure

```
Hera/
├── src/
│   ├── App.jsx              # Main application component
│   ├── main.jsx             # Entry point
│   ├── index.css            # Global styles (Tailwind)
│   ├── i18n.js              # i18next configuration
│   ├── background/
│   │   └── service_worker.js
│   ├── lib/
│   │   ├── gemini.js        # Gemini API integration
│   │   └── fileParsers.js  # File parsing utilities
│   ├── locales/
│   │   ├── en.json          # English translations
│   │   └── tr.json          # Turkish translations
│   └── assets/
├── public/                  # Static assets
├── dist/                    # Build output
├── manifest.json            # Chrome extension manifest
├── vite.config.js           # Vite configuration
├── eslint.config.js         # ESLint configuration
├── tailwind.config.js       # Tailwind configuration
└── package.json
```

## Common Tasks

### Adding a New Feature

1. Create component in appropriate directory
2. Add translations in `locales/en.json` and `locales/tr.json`
3. Run `npm run lint` to check code
4. Run `npm run build` to test production build

### Adding Dependencies

```bash
# Production dependency
npm install <package-name>

# Dev dependency
npm install -D <package-name>
```

### Debugging

- Use `console.log` for development debugging
- Use `toast.error()` to show user-facing errors
- Check Chrome DevTools console for extension errors
- Use `chrome://extensions` to reload extension
