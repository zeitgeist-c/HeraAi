# HeraAi

AI-powered Chrome extension with Web Research support. Built with React 19, Vite 7, Tailwind CSS.

## Architecture

HeraAi uses a **backend-required architecture**:

```
Frontend (Chrome Extension)
  └── api.js ──HTTP / SSE──▶ server/ (Express backend)
                                  ├── Gemini AI (chat, vision)
                                  └── Tavily (web research)
```

- The frontend (Chrome extension) **never** holds API keys directly.
- All AI calls go through the backend (`server/`) via HTTP + Server-Sent Events (SSE).
- Without the backend, chat, web research, and vision features will not work.

## Prerequisites

- Node.js 18+
- npm 9+
- Chrome browser (for extension)

## Backend Setup

The backend is a separate Node.js + Express server in the `server/` directory.

```bash
cd server
npm install
```

### Environment Variables

Copy the example env file and fill in your API keys:

```bash
cp .env.example .env
```

Required variables in `.env`:

| Variable | Required | Purpose |
|---|---|---|---|
| `GEMINI_API_KEYS` | **Yes** | Gemini API key(s). Comma-separated for multiple keys (e.g., `key1,key2`). Backward compatible: `GEMINI_API_KEY` also works. Get one from [Google AI Studio](https://aistudio.google.com/apikey). |
| `TAVILY_API_KEYS` | No (see note) | Required only for Web Research mode. Comma-separated for multiple keys. Backward compatible: `TAVILY_API_KEY`. Get one from [Tavily](https://tavily.com). |
| `PORT` | No | Server port (default: 3001) |
| `ALLOWED_ORIGINS` | No | CORS origins, comma-separated (default: `http://localhost:5173,chrome-extension://*`) |
| `COOLDOWN_RATE_LIMIT` | No | Cooldown for 429 rate limits in ms (default: 60000) |
| `COOLDOWN_QUOTA` | No | Cooldown for quota exceeded in ms (default: 3600000) |
| `COOLDOWN_TIMEOUT` | No | Cooldown for timeouts in ms (default: 30000) |
| `COOLDOWN_SERVER_ERROR` | No | Cooldown for 5xx errors in ms (default: 60000) |

> **Note:** If no Tavily keys are configured, the server will still start, but the Web Research endpoint (`/api/research`) will return an error. Chat and Vision will work normally.

### Multi-Key Fallback

When multiple API keys are configured, HeraAi uses a **round-robin with cooldown** system:

1. **Round-robin selection**: Each request picks the next available key.
2. **Cooldown periods**: Failed keys enter a cooldown based on error type (429→60s, quota→1h, timeout→30s, 5xx→60s).
3. **Retryable errors only**: 429 rate limits, 5xx server errors, and timeouts trigger a retry with the next key. 400, 401, 403, and safety blocks are not retried.
4. **Stream safety**: Once an SSE stream starts, errors are sent as `error` events — no key switching mid-stream.
5. **Each key tried at most once** per request.

This enables basic redundancy and rate-limit mitigation without complex coordination.

### Start the Backend

```bash
# From the server/ directory
npm start
```

Expected output:
```
HeraAI Backend running on port 3001
```

## Frontend Setup

```bash
# From the project root
npm install
```

### Development

```bash
npm run dev
```

### Production Build

```bash
npm run build
```

Build output goes to `dist/`. Load this folder as an unpacked Chrome extension.

## Configure Backend URL in Frontend

1. Open the extension side panel.
2. Click the **Settings** (gear) icon.
3. Find the **Backend URL** field.
4. Enter `http://localhost:3001` (or your deployed backend URL).
5. Click **Test Connection** to verify the backend is reachable.
6. Click **Kaydet** to save.

## Web Research Mode

Toggle the **globe icon** button in the chat input area to enable Web Research mode.

- **Disabled (default):** Chat uses only Gemini AI to generate responses.
- **Enabled:** The backend searches the web via Tavily, then generates an answer using Gemini with sources cited below the response.

## CORS Configuration for Production

When deploying the backend to production:

1. Replace `chrome-extension://*` with your actual Chrome extension ID in `ALLOWED_ORIGINS`:
   ```
   ALLOWED_ORIGINS=https://yourdomain.com,chrome-extension://abcdefghijklmnopqrstuvwxyz123456
   ```
2. The wildcard (`*`) in `chrome-extension://*` is convenient for development but less secure. Pin the exact extension ID for production.
3. If deploying the backend publicly (e.g., Vercel, Railway), restrict origins to only the specific frontend URLs that need access.

## Project Structure

```
server/             Express backend
  src/
    index.js          App entry point
    config.js         Env config with validation
    routes/           API endpoints (health, chat, research, vision)
    services/
      gemini.js         Gemini AI with key pool fallback
      tavily.js         Tavily search with key pool fallback
      contextBuilder.js Build research context from search results
      keyPool.js        Round-robin key pool with cooldowns
    middleware/       Rate limiter, error handler, validation
    utils/            SSE helpers, timeout
  .env.example        Template for environment variables
src/                Frontend (React)
  App.jsx              Main app component
  lib/api.js           Backend API client (SSE streaming)
  components/          UI components
  locales/             i18n translations (tr, en)
eslint.config.js    ESLint flat config
vite.config.js      Vite config
```

## Available Scripts

```bash
npm run dev      # Start Vite dev server with HMR
npm run build    # Build for production
npm run preview  # Preview production build
npm run lint     # Run ESLint
npm run test     # Run Vitest tests (JSDOM + React Testing Library)
```
