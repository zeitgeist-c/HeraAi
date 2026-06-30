# API Key Management Design — Remove .env, Add Settings-Based Key Management

**Date:** 2026-06-30
**Status:** Approved

## Overview

Remove `.env`-based API key loading from the backend (`server/`) and replace it with a full frontend Settings UI for managing Gemini and Tavily API keys. Keys are stored in `chrome.storage.local`, displayed masked, and sent to the backend per-request with ordered primary/fallback key pool logic.

---

## Architecture

```
Frontend (Chrome Extension)
  └── keyManager.js (storage + CRUD + cooldown state)
  └── SettingsPanel.jsx (UI for add/delete/test/set-primary)
  └── api.js (sends geminiKeys + tavilyKeys in request body)
        │
        │ POST /api/chat   { messages, geminiKeys }
        │ POST /api/vision { messages, image, geminiKeys }
        │ POST /api/research { question, geminiKeys, tavilyKeys }
        │ POST /api/test-key { provider, key }
        │
        ▼
  server/ (Express backend)
    ├── config.js (no .env key loading)
    ├── routes/chat.js → gemini.streamChat(req, res)
    ├── routes/vision.js → gemini.streamVision(req, res)
    ├── routes/research.js → tavily.searchWeb + gemini.streamChat
    ├── routes/testKey.js → tests a single key
    └── services/
        ├── keyPool.js — createPool() factory, ordered fallback
        ├── gemini.js — per-request pool from body
        └── tavily.js — per-request pool from body
```

---

## 1. Frontend Key Manager (`src/lib/keyManager.js`)

### Storage Structure (`chrome.storage.local`)

```js
geminiApiKeys: [
  {
    id: "uuid-1",
    key: "AIzaSy...",
    masked: "AIza...xYz9",
    isPrimary: true,
    createdAt: 1712345678000,
    lastUsedAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorType: null,
    cooldownUntil: null,
    failCount: 0,
  }
],
tavilyApiKeys: [ /* same structure */ ]
```

### Methods

- `getKeys(provider)` — returns metadata + masked (no raw key)
- `getRawKey(provider, id)` — returns raw key string (controlled, send-time only)
- `addKey(provider, rawKey)` — validate, check duplicate, mask, save, auto-primary
- `removeKey(provider, id)` — delete, auto-promote next if primary deleted
- `setPrimary(provider, id)` — set one, clear others
- `updateKeyMetadata(provider, id, updates)` — update runtime state
- `getAllKeysForRequest(provider)` — ordered: primary first, non-cooldown, cooldown last
- `maskKey(key)` — `"AIza...xYz9"` format

### Rules

- `provider` must be `"gemini"` or `"tavily"` only
- At most one primary per provider
- First added key is auto-primary
- Primary deletion promotes the first remaining key
- Duplicate raw keys rejected with user-friendly message
- Keys NEVER logged, never in error messages, never in network responses
- `chrome.storage.sync` is NEVER used

---

## 2. Backend Changes

### `server/src/config.js`
- Remove GEMINI_API_KEY, GEMINI_API_KEYS, TAVILY_API_KEY, TAVILY_API_KEYS loading
- Remove geminiKeys, tavilyKeys from export
- Keep PORT, ALLOWED_ORIGINS, NODE_ENV, cooldowns

### `server/src/services/keyPool.js`
- Remove round-robin cursor logic
- Remove `parseKeys()` global
- Add `createPool(provider, keysArray, cooldowns)` factory
- `getNextKey()` returns sequential keys (index 0, 1, 2...)
- Pool is throwaway per-request — no persistence

### `server/src/services/gemini.js`
- Remove `export const geminiPool` global
- `streamChat(req, res)` reads `req.body.geminiKeys`
- `streamVision(req, res)` reads `req.body.geminiKeys`
- `withGeminiFallback(fn, keyArray, res)` — creates per-request pool
- Same error classification (retryable vs non-retryable)
- Sends `key_status` event before each key attempt

### `server/src/services/tavily.js`
- Remove `export const tavilyPool` global
- `searchWeb(query, maxResults, tavilyKeysArray)` — creates per-request pool
- Same error classification + fallback

### Routes
- **chat.js, vision.js, research.js** — parse key arrays from body, pass to services
- **testKey.js (new)** — `POST /api/test-key`, short test call, no key in response/log
- **health.js** — simplified: `{ status: 'ok', timestamp }`

### Validation (middleware)
- `geminiKeys` must be non-empty array with `{ id, key, isPrimary }`
- `tavilyKeys` must be non-empty array for research
- Key never appears in validation error messages

---

## 3. SettingsPanel UI Changes

### Layout
- **Gemini / AI Studio API Key'leri** section
  - Password input + Ekle button
  - Tümünü Test Et button
  - Masked key list with: status badge | [Test] [Ana Yap] [Sil]
- **Tavily API Key'leri** section (same layout)
- Security notice
- Backend URL + Test Connection (unchanged)

### Behavior
- Input type="password" with optional show/hide during entry
- Saved keys NEVER shown unmasked
- "Ana Yap" only on non-primary keys
- Delete with brief confirm; auto-promote next key
- Sequential test-all with delay between requests

---

## 4. SSE Events

### `key_status`
```json
event: key_status
data: {"provider":"gemini","keyId":"uuid-1","status":"success"}
```
Status values: `success`, `rate_limited`, `quota_exceeded`, `timeout`, `provider_error`, `network_error`, `invalid_request`, `safety_blocked`

### Event Order
1. Failed key → `key_status` (error) before retry
2. Successful key → `key_status` (success) before first `chunk`
3. All failed → `key_status` events then final `error`
4. Mid-stream failure → `error` (no key switching mid-stream)

---

## 5. Frontend Integration (`App.jsx`)

- Load `geminiApiKeys` and `tavilyApiKeys` on mount
- Before `handleSend`:
  - Chat/vision: `getAllKeysForRequest('gemini')`
  - Research: both Gemini and Tavily keys
  - If empty → appropriate user-facing error
- Pass key arrays in API call body
- On `key_status` → `updateKeyMetadata()` to sync cooldown
- Existing UI preserved (scroll, quick actions, sources, vision)

---

## 6. Error Handling

| Scenario | Error Message |
|---|---|
| Gemini keys empty, chat | "Please add at least one Gemini API key in Settings" |
| Gemini keys empty, research | "Please add at least one Gemini API key in Settings" |
| Tavily keys empty, research | "Web Research requires a Tavily API key" |
| All Gemini keys exhausted | "Gemini service unavailable. Please try again later." |
| All Tavily keys exhausted | "Web search unavailable. Please try again later." |
| Backend unreachable | "Cannot connect to backend. Is the server running?" |
| Non-retryable Gemini error | "Request format error. Please try a different prompt." |

---

## 7. Files to Modify/Create

### Modified
- `server/src/config.js`
- `server/src/services/keyPool.js`
- `server/src/services/gemini.js`
- `server/src/services/tavily.js`
- `server/src/routes/chat.js`
- `server/src/routes/vision.js`
- `server/src/routes/research.js`
- `server/src/routes/health.js`
- `server/src/middleware/validate.js`
- `server/.env.example`
- `src/App.jsx`
- `src/components/SettingsPanel.jsx`
- `src/lib/api.js`
- `src/locales/en.json`
- `src/locales/tr.json`
- `README.md`

### Created
- `src/lib/keyManager.js`
- `server/src/routes/testKey.js`

---

## 8. Test Scenarios

1. Single Gemini key → normal chat works
2. Multiple Gemini keys → add, primary/backup correct
3. Primary key works → always primary (no round-robin)
4. Primary 429/timeout → backup tried
5. All keys fail → controlled error
6. Single Tavily key → Web Research works
7. Multiple Tavily keys → add, primary/backup correct
8. Primary Tavily fails → backup tried
9. Tavily missing → only research shows error
10. Gemini missing → chat/vision show "add key" error
11. Keys masked in UI, not logged, not in response
12. Old .env system completely removed
13. Round-robin removed
14. Existing UI behaviors preserved

---

## 9. Security Rules (Never)

- Hardcode keys in source code
- Log keys to console
- Show keys in error messages
- Use chrome.storage.sync
- Include keys in SSE events
- Return keys in API responses
- Round-robin (always cycling keys)
- Use Tavily outside Web Research
- Keep .env and Settings key systems coexisting
