# API Key Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `.env`-based API key loading from server, add frontend Settings-based key management with ordered primary/fallback via per-request KeyPool.

**Architecture:** Server no longer loads keys from `.env` or holds global pools. Each request includes `geminiKeys` and `tavilyKeys` arrays from frontend. Server creates per-request KeyPool with ordered fallback (primary first, no round-robin). Frontend keyManager stores keys in `chrome.storage.local`, displays masked, sends to backend on each request.

**Tech Stack:** Express (backend), React 19 (frontend), chrome.storage.local, SSE

---

## File Structure

### New Files
- `src/lib/keyManager.js` — key storage, CRUD, masking, getAllKeysForRequest
- `server/src/routes/testKey.js` — `POST /api/test-key` endpoint

### Modified Files
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
- `src/lib/api.js`
- `src/components/SettingsPanel.jsx`
- `src/App.jsx`
- `src/locales/en.json`
- `src/locales/tr.json`
- `README.md`

---

## Phase 1: Backend — Remove .env Keys, Add Per-Request KeyPool

### Task 1: `server/src/config.js` — Remove .env Key Loading

- [ ] Remove `GEMINI_API_KEY`, `GEMINI_API_KEYS`, `TAVILY_API_KEY`, `TAVILY_API_KEYS` imports and parsing
- [ ] Remove `geminiKeys`, `tavilyKeys` from export
- [ ] Keep `PORT`, `ALLOWED_ORIGINS`, `NODE_ENV`, `cooldowns`
- [ ] Server no longer requires any API key to start

```js
import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  allowedOrigins: process.env.ALLOWED_ORIGINS || 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV || 'development',
  cooldowns: {
    rateLimit: parseInt(process.env.COOLDOWN_RATE_LIMIT || '60000', 10),
    quotaExceeded: parseInt(process.env.COOLDOWN_QUOTA || '3600000', 10),
    timeout: parseInt(process.env.COOLDOWN_TIMEOUT || '30000', 10),
    serverError: parseInt(process.env.COOLDOWN_SERVER_ERROR || '60000', 10),
  },
};
```

### Task 2: `server/src/services/keyPool.js` — Add createPool(), Remove Round-Robin

- [ ] Remove `parseKeys()` function
- [ ] Keep `maskKey()`, `ERROR_RETRYABLE`, `ERROR_NON_RETRYABLE`
- [ ] `KeyPool` constructor: take `keys` array directly (already `[{ id, key, isPrimary }]`)
- [ ] `getNextKey()`: sequential index walk (no round-robin), start at index 0 each time
- [ ] `isAvailable()`: same cooldown check
- [ ] Add `createPool(provider, keysArray, cooldowns)` factory function

```js
function createPool(provider, keysArray, cooldowns) {
  if (!keysArray || !Array.isArray(keysArray)) {
    return new KeyPool(provider, [], cooldowns);
  }
  const keyValues = keysArray.map(k => ({ id: k.id, key: k.key, isPrimary: k.isPrimary }));
  return new KeyPool(provider, keyValues, cooldowns);
}
```

- [ ] `KeyPool.getNextKey()`: iterate `this.keys` sequentially from index 0, skip cooldown keys, return first available. Do NOT advance a cursor.

```js
getNextKey() {
  for (const entry of this.keys) {
    if (this.isAvailable(entry)) return entry;
  }
  return null;
}
```

- [ ] Export `createPool` alongside existing exports

### Task 3: `server/src/services/gemini.js` — Per-Request Pool + key_status Events

- [ ] Remove `export const geminiPool` global
- [ ] `streamChat(req, res)`: read `req.body.geminiKeys`, create per-request pool via `createPool('gemini', geminiKeys, config.cooldowns)`
- [ ] `streamVision(req, res)`: same pattern
- [ ] `withGeminiFallback(fn, pool, res)`: takes pool as param instead of using global
- [ ] On key fail: `writeEvent(res, 'key_status', { provider: 'gemini', keyId: entry.id, status: errorType })` before retry
- [ ] On key success: `writeEvent(res, 'key_status', { provider: 'gemini', keyId: entry.id, status: 'success' })` before first chunk
- [ ] If all keys exhausted: `writeEvent(res, 'error', ...)` after all key_status events
- [ ] Raw key NEVER logged — only `entry.id` or `entry.masked` in debug logs

```js
export async function streamChat(req, res) {
  const { messages, systemInstruction, geminiKeys } = req.body;
  const pool = createPool('gemini', geminiKeys, config.cooldowns);

  await withGeminiFallback(async (genAI, entry) => {
    writeEvent(res, 'key_status', { provider: 'gemini', keyId: entry.id, status: 'success' });
    const model = genAI.getGenerativeModel({ model: MODEL, ... });
    const history = messages.slice(0, -1).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const lastMsg = messages[messages.length - 1];
    const chat = model.startChat({ history });
    const result = await chat.sendMessageStream(lastMsg.content);
    for await (const chunk of result.stream) {
      writeEvent(res, 'chunk', { text: chunk.text() });
    }
    endStream(res);
  }, pool, res);
}
```

### Task 4: `server/src/services/tavily.js` — Per-Request Pool

- [ ] Remove `export const tavilyPool` global
- [ ] `searchWeb(query, maxResults, tavilyKeysArray, res)` — takes key array + optional res for key_status events
- [ ] Create per-request pool via `createPool('tavily', tavilyKeys, config.cooldowns)`
- [ ] Send `key_status` events same pattern as gemini
- [ ] Never log raw keys

```js
export async function searchWeb(query, maxResults = 10, tavilyKeysArray = [], res = null) {
  const pool = createPool('tavily', tavilyKeysArray, config.cooldowns);
  if (pool.keys.length === 0) throw new Error('No Tavily keys available');
  // ... existing fetch logic using pool.getNextKey(), pool.markFailed(), etc.
  // On success: send key_status if res provided
  // On retryable fail: send key_status error event
}
```

### Task 5: `server/src/middleware/validate.js` — Add Key Validation

- [ ] `validateChat`: check `geminiKeys` is non-empty array with `{ id, key, isPrimary }`
- [ ] `validateVision`: same
- [ ] `validateResearch`: check both `geminiKeys` and `tavilyKeys`
- [ ] Validation error messages do NOT include raw keys

```js
function validateKeyArray(keys, provider) {
  if (!keys || !Array.isArray(keys) || keys.length === 0) {
    return `${provider} API key listesi gerekli`;
  }
  for (const k of keys) {
    if (!k.id || !k.key || typeof k.key !== 'string' || k.key.trim() === '') {
      return `${provider} API key bilgisi geçersiz`;
    }
  }
  return null;
}
```

### Task 6: `server/src/routes/chat.js` — Pass geminiKeys

- [ ] Remove `tavilyPool.keys.length` check (no longer needed — keys come from body)
- [ ] Pass `req.body.geminiKeys` into `streamChat`
- [ ] All other SSE/streaming logic unchanged

### Task 7: `server/src/routes/vision.js` — Pass geminiKeys

- [ ] Pass `req.body.geminiKeys` into `streamVision`

### Task 8: `server/src/routes/research.js` — Pass Both Key Arrays

- [ ] Extract `geminiKeys` and `tavilyKeys` from body
- [ ] Pass `tavilyKeys` to `searchWeb()` call
- [ ] Pass `geminiKeys` to per-request Gemini pool
- [ ] Check if tavilyKeys is empty: return 400 with "Web Research için Tavily API key gerekli"
- [ ] Check if geminiKeys is empty: return 400 with "Gemini API key gerekli"
- [ ] Remove global `geminiPool` and `tavilyPool` references

### Task 9: Create `server/src/routes/testKey.js` — Key Testing Endpoint

- [ ] `POST /api/test-key` with body `{ provider, key }`
- [ ] `provider` must be `"gemini"` or `"tavily"`
- [ ] For Gemini: short `generateContent` call with `"test"` prompt
- [ ] For Tavily: short `search` call with `"test"` query
- [ ] Return `{ success: true, provider }` or `{ success: false, provider, errorType, message }`
- [ ] NEVER log the key. NEVER return the key in response.
- [ ] Error types: `rate_limited`, `quota_exceeded`, `timeout`, `invalid_key`, `network_error`

```js
router.post('/test-key', async (req, res) => {
  const { provider, key } = req.body;
  if (!provider || !['gemini', 'tavily'].includes(provider)) {
    return res.status(400).json({ success: false, errorType: 'invalid_request', message: 'Geçersiz provider' });
  }
  if (!key || typeof key !== 'string' || key.trim() === '') {
    return res.status(400).json({ success: false, errorType: 'invalid_request', message: 'Key gerekli' });
  }
  try {
    if (provider === 'gemini') {
      const genAI = new GoogleGenerativeAI(key.trim());
      const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
      await model.generateContent('test');
    } else {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key.trim(), query: 'test', max_results: 1 }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) { /* classify error */ }
    }
    res.json({ success: true, provider });
  } catch (err) { /* classify and return controlled error */ }
});
```

### Task 10: `server/src/routes/health.js` — Simplify

- [ ] Remove `geminiPool` and `tavilyPool` imports
- [ ] Return `{ status: 'ok', timestamp: Date.now() }`

### Task 11: `server/.env.example` — Remove API Key Vars

- [ ] Remove `GEMINI_API_KEYS`, `GEMINI_API_KEY`, `TAVILY_API_KEYS`, `TAVILY_API_KEY`
- [ ] Keep `PORT`, `ALLOWED_ORIGINS`, `NODE_ENV`, cooldown vars

---

## Phase 2: Frontend — Key Manager + Settings UI

### Task 12: Create `src/lib/keyManager.js`

- [ ] `maskKey(key)`: return `key.slice(0, 4) + '...' + key.slice(-3)` (min length 8, else `'***'`)
- [ ] `generateId()`: use `crypto.randomUUID()` or `Date.now() + Math.random()`
- [ ] `getKeys(provider)`: read from `chrome.storage.local['geminiApiKeys'|'tavilyApiKeys']`, return array without raw `key` field
- [ ] `getRawKey(provider, id)`: read storage, find by id, return raw key or null (only for API calls)
- [ ] `addKey(provider, rawKey)`: validate provider, check duplicate (compare raw keys), mask, create entry, set primary if first key, save to storage
- [ ] `removeKey(provider, id)`: delete entry, auto-promote first remaining as primary if deleted was primary, save
- [ ] `setPrimary(provider, id)`: set `isPrimary: true` on target, `false` on all others, save
- [ ] `updateKeyMetadata(provider, id, updates)`: merge `{ lastSuccessAt, lastErrorAt, lastErrorType, cooldownUntil, failCount }` onto existing entry, save
- [ ] `getAllKeysForRequest(provider)`: get all keys, sort primary first then non-cooldown then cooldown, return `[{ id, key, isPrimary }]` (includes raw key — ONLY for request body)
- [ ] Wrap all chrome.storage operations in Promise
- [ ] Export all functions

```js
const PROVIDERS = ['gemini', 'tavily'];
const STORAGE_KEYS = { gemini: 'geminiApiKeys', tavily: 'tavilyApiKeys' };

function getStorageKey(provider) {
  if (!PROVIDERS.includes(provider)) throw new Error(`Invalid provider: ${provider}`);
  return STORAGE_KEYS[provider];
}

function maskKey(key) {
  if (!key || key.length <= 8) return '***';
  return key.slice(0, 4) + '...' + key.slice(-3);
}

async function getAllKeysForRequest(provider) {
  const entries = await readKeys(provider);
  const now = Date.now();
  const sorted = [...entries].sort((a, b) => {
    if (a.isPrimary) return -1;
    if (b.isPrimary) return 1;
    const aCooldown = a.cooldownUntil && a.cooldownUntil > now ? 1 : 0;
    const bCooldown = b.cooldownUntil && b.cooldownUntil > now ? 1 : 0;
    return aCooldown - bCooldown;
  });
  return sorted.map(e => ({ id: e.id, key: e.key, isPrimary: e.isPrimary }));
}
```

### Task 13: Update `src/lib/api.js` — Send Keys in Request Body

- [ ] `streamChat()`: add `geminiKeys` param, include in body
- [ ] `streamVision()`: add `geminiKeys` param, include in body
- [ ] `streamResearch()`: add `geminiKeys` + `tavilyKeys` params, include in body
- [ ] `testKey(provider, key)`: new function, POSTs to `/api/test-key`
- [ ] `checkHealth()`: unchanged

```js
export async function* streamChat(messages, options = {}, geminiKeys = [], signal) {
  const gen = streamFromEndpoint('/api/chat', {
    messages,
    systemInstruction: options.systemInstruction || '',
    geminiKeys,
  }, signal);
  for await (const evt of gen) yield evt;
}

export async function* streamResearch(question, geminiKeys = [], tavilyKeys = [], signal) {
  const gen = streamFromEndpoint('/api/research', { question, geminiKeys, tavilyKeys }, signal);
  for await (const evt of gen) yield evt;
}

export async function* streamVision(messages, image, options = {}, geminiKeys = [], signal) {
  const gen = streamFromEndpoint('/api/vision', {
    messages, image: image || undefined,
    systemInstruction: options.systemInstruction || '',
    geminiKeys,
  }, signal);
  for await (const evt of gen) yield evt;
}

export async function testKey(provider, key) {
  const baseUrl = await getBaseUrl();
  const res = await fetch(`${baseUrl}/api/test-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, key }),
  });
  return res.json();
}
```

### Task 14: Update `src/components/SettingsPanel.jsx` — Key Management UI

- [ ] Import `keyManager` functions
- [ ] Add state: `geminiKeysMeta`, `tavilyKeysMeta`, `geminiInput`, `tavilyInput`, `testingKeys`
- [ ] On mount, load both key lists via `getKeys()`
- [ ] Add Gemini section:
  - Password input (`geminiInput`) with show/hide toggle
  - "Ekle" button → `addKey('gemini', value)` → refresh list
  - "Tümünü Test Et" button → iterate keys, call `testKey()`, update metadata, refresh
  - Key list: each row shows masked key, Ana/Yedek badge, status icon, [Test] [Ana Yap] [Sil]
- [ ] Add Tavily section (identical structure)
- [ ] Security notice at bottom
- [ ] Keep existing Backend URL and Test Connection unchanged
- [ ] Show toast for success/error on add, delete, test
- [ ] Confirm dialog before delete
- [ ] Layout: compact, scrollable within panel, no overflow on narrow screens

```jsx
// Gemini section structure (simplified)
<div className="flex flex-col gap-3">
  <h2 className="text-sm font-semibold">{t('setup.api.gemini_section')}</h2>
  <div className="flex gap-2">
    <input type={showGeminiInput ? 'text' : 'password'} value={geminiInput}
      onChange={e => setGeminiInput(e.target.value)}
      placeholder={t('setup.api.add_placeholder')} className="flex-1 h-9 ..." />
    <button onClick={toggleShowGemini} className="...">
      {showGeminiInput ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
    </button>
    <button onClick={handleAddGeminiKey} disabled={!geminiInput.trim()}
      className="h-9 px-3 bg-primary text-primary-foreground rounded-lg ...">
      {t('setup.api.add_btn')}
    </button>
  </div>
  <button onClick={handleTestAllGemini} disabled={testingKeys}
    className="...">
    {t('setup.api.test_all')}
  </button>
  <div className="flex flex-col gap-1 max-h-[200px] overflow-y-auto">
    {geminiKeysMeta.map(key => (
      <div key={key.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-secondary/30 text-xs">
        <span className="font-mono text-muted-foreground">{key.masked}</span>
        <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${key.isPrimary ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground'}`}>
          {key.isPrimary ? t('setup.api.primary') : t('setup.api.backup')}
        </span>
        <span className="text-muted-foreground">{getStatusLabel(key)}</span>
        <div className="ml-auto flex gap-1">
          <button onClick={() => handleTestKey('gemini', key)} title={t('setup.api.test')} className="p-1 ..."><Play className="w-3 h-3" /></button>
          {!key.isPrimary && <button onClick={() => handleSetPrimary('gemini', key.id)} title={t('setup.api.make_primary')} className="p-1 ..."><Star className="w-3 h-3" /></button>}
          <button onClick={() => handleDeleteKey('gemini', key.id)} title={t('setup.api.delete')} className="p-1 text-destructive ..."><Trash2 className="w-3 h-3" /></button>
        </div>
      </div>
    ))}
  </div>
</div>
```

**New locale keys to add:**

en.json additions in `setup.api`:
```json
"gemini_section": "Gemini / AI Studio API Keys",
"tavily_section": "Tavily API Keys",
"primary": "Primary",
"backup": "Backup",
"test": "Test",
"test_all": "Test All",
"delete": "Delete",
"make_primary": "Make Primary",
"status_success": "Successful",
"status_waiting": "Waiting",
"status_rate_limit": "Rate Limit",
"status_quota": "Quota Exceeded",
"status_timeout": "Timeout",
"status_invalid": "Invalid Key",
"status_error": "Error",
"key_empty_error": "Please enter an API key",
"key_duplicate_error": "This key is already added",
"gemini_keys_missing": "Please add at least one Gemini API key in Settings",
"tavily_keys_missing": "Web Research requires a Tavily API key",
"security_warning": "API keys are stored in your browser's extension storage. Suitable for personal use. Do not share your keys."
```

tr.json additions:
```json
"gemini_section": "Gemini / AI Studio API Anahtarları",
"tavily_section": "Tavily API Anahtarları",
"primary": "Ana",
"backup": "Yedek",
"test": "Test Et",
"test_all": "Tümünü Test Et",
"delete": "Sil",
"make_primary": "Ana Yap",
"status_success": "Başarılı",
"status_waiting": "Bekliyor",
"status_rate_limit": "Rate Limit",
"status_quota": "Kota Doldu",
"status_timeout": "Zaman Aşımı",
"status_invalid": "Geçersiz Anahtar",
"status_error": "Hata",
"key_empty_error": "Lütfen bir API anahtarı girin",
"key_duplicate_error": "Bu anahtar zaten eklenmiş",
"gemini_keys_missing": "Lütfen Ayarlar'dan en az bir Gemini API anahtarı ekleyin",
"tavily_keys_missing": "Web Araştırması için Tavily API anahtarı gerekli",
"security_warning": "API anahtarları tarayıcı eklenti depolamasında saklanır. Kişisel kullanım için uygundur. Anahtarlarınızı paylaşmayın."
```

### Task 15: Update `src/App.jsx` — Load Keys, Pass to API Calls

- [ ] Import `keyManager` functions and updated `api.js` functions
- [ ] On mount (in existing `useEffect`), also load `geminiApiKeys` and `tavilyApiKeys` from storage via `getKeys()`
- [ ] Store key metadata arrays in state: `geminiKeyMeta`, `tavilyKeyMeta`
- [ ] Before `handleSend`:
  - Call `getAllKeysForRequest('gemini')` → `geminiKeysForRequest`
  - If research: `getAllKeysForRequest('tavily')` → `tavilyKeysForRequest`
  - If `geminiKeysForRequest.length === 0`: show toast "Lütfen Ayarlar'dan en az bir Gemini API anahtarı ekleyin", return
  - If research and `tavilyKeysForRequest.length === 0`: show toast "Web Araştırması için Tavily API anahtarı gerekli", return
- [ ] Pass key arrays to stream functions:
  - `streamChat(messages, options, geminiKeysForRequest, signal)`
  - `streamResearch(question, geminiKeysForRequest, tavilyKeysForRequest, signal)`
  - `streamVision(messages, image, options, geminiKeysForRequest, signal)`
- [ ] On `key_status` SSE event: call `updateKeyMetadata(provider, keyId, updates)` to sync cooldown
- [ ] Pass `geminiKeysMeta`/`tavilyKeysMeta` to `SettingsPanel` so it can show saved keys without re-reading storage

### Task 16: Update `README.md`

- [ ] Remove .env API key setup section
- [ ] Add new setup flow:
  - Backend no longer needs API keys in .env
  - Open extension Settings
  - Add Gemini/Tavily API keys via UI
  - First key = primary, others = backup
  - Keys stored in browser extension storage, masked in UI
- [ ] Update security notes

---

## Task Dependencies & Order

```
Phase 1 (Backend):
  Task 1 (config.js) → prerequisite for all backend
  Task 2 (keyPool.js) → prerequisite for Task 3, 4
  Task 3 (gemini.js) + Task 4 (tavily.js) → prerequisite for routes
  Task 5 (validate.js) → prerequisite for routes
  Task 6 (chat.js) + Task 7 (vision.js) + Task 8 (research.js) → can be parallel
  Task 9 (testKey.js) → independent
  Task 10 (health.js) → independent
  Task 11 (.env.example) → independent

Phase 2 (Frontend):
  Task 12 (keyManager.js) → prerequisite for all frontend
  Task 13 (api.js) → prerequisite for App.jsx
  Task 14 (SettingsPanel.jsx) → parallel with Task 15
  Task 15 (App.jsx) → parallel with Task 14
  Locales + README → independent
```
