# Settings Tabanlı Çoklu API Key Yönetimi — Design Spec

**Date:** 2026-07-25
**Status:** Approved (pending implementation)
**Supersedes:** 2026-06-30-api-key-management-design.md (already implemented and shipped)

## Background

HeraAi previously ran an Express backend that loaded Gemini/Tavily keys from `server/.env`. That system was fully removed in commit `6ef0d38` (2026-07-13): the `server/` directory is gone, no `process.env` / `GEMINI_API_KEY` / `TAVILY_API_KEY` / `APP_ACCESS_TOKEN` references exist anywhere in the codebase, and the README already states "no Express backend and no `.env` file".

A Settings-based key management layer already exists (`src/lib/keyManager.js`, key management UI in `src/components/SettingsPanel.jsx`, fallback in `src/lib/api.js`). This spec covers the remaining gaps between the current implementation and the user's 2026-07-25 requirements, plus a fallback hardening and a stale-state bug fix.

## Goal

Close all outstanding gaps so the Settings-based key system fully satisfies the requirements: password-type inputs, friendly test results, status indicators, security warnings, full cooldown blocking, and a fresh-per-request key resolution that fixes a latent stale-cooldown bug. No backend, no `.env`, no changes to existing features (quick actions, scroll, vision, manga, stats, popup).

## Non-Goals

- Reintroducing a backend (`server/` stays deleted).
- A "show full key" affordance for saved keys (explicitly dispreferred).
- Drag-and-drop key reordering (explicitly deferred).
- Round-robin key rotation (explicitly forbidden — primary-first, sequential fallback only).

## Approved Decisions

1. **Cooldown strategy:** Cooldown keys are fully skipped. If ALL keys are in cooldown, the request is blocked *before* the user/assistant message is created; the user is shown the earliest cooldown end time. Manual retry required.
2. **Primary-first:** Primary is always attempted first on each new request. If primary is in cooldown, the first available fallback is used. Primary resumes automatically once its cooldown expires. Successful fallback keys do NOT become temporary primary; only Settings "Set as Primary" changes the primary.
3. **Status indicator:** 5 states — Success (green), Pending (gray), Rate Limited (amber), Quota Exhausted (red), Invalid/Error (red) — with a "Last error: X min ago" subline when applicable.
4. **Input:** `type="password"` with a per-input eye toggle. Saved keys are NEVER displayed in plain text.
5. **Security warning:** Both in SettingsPanel (banner in the API tab) and README.
6. **Test coverage:** Both `App.test.jsx` (UI) and `api.test.js` (fallback/classification).
7. **Masking:** Last 4 chars shown (e.g. `AIza...xYz9`, `tvly...AbC3`).

## Architecture

No new modules. Existing modules are refined:

```
keyManager.js   ─ resolveKeysForRequest(provider) → { keys, allInCooldown, earliestCooldownEnd }
                 ─ storage CRUD, masking, primary ordering
api.js          ─ streamChat / streamVision / streamResearch (unchanged signatures)
                 ─ testKey returns friendly errorType + message key
                 ─ console.error calls sanitized (no raw error objects)
App.jsx         ─ resolve keys fresh per request BEFORE building messages
                 ─ block + toast on allInCooldown
                 ─ key_status handler preserves cooldown + adds failCount
SettingsPanel   ─ password inputs, "Test All", 5-state status, security banner
```

## Detailed Design

### A. `src/lib/keyManager.js`

- `maskKey`: `slice(-3)` → `slice(-4)`. Keep first 4 unchanged.
- **New** `resolveKeysForRequest(provider)`:
  - Reads entries from `chrome.storage.local`.
  - Filters out keys with `cooldownUntil > now` (true skip, not just re-sorted).
  - Sorts remaining: primary first, then `createdAt` ascending.
  - Returns `{ keys: [{id, key, isPrimary}], allInCooldown: boolean, earliestCooldownEnd: number|null }`.
  - Empty store → `{ keys: [], allInCooldown: false, earliestCooldownEnd: null }`.
  - All keys in cooldown → `{ keys: [], allInCooldown: true, earliestCooldownEnd: <min cooldownUntil> }`.
- `getKeys(provider)`: sort returned metadata by primary-first then `createdAt`, so the UI renders primary at the top.
- `getAllKeysForRequest` is preserved for backward compat but App.jsx switches to `resolveKeysForRequest`.

### B. `src/lib/api.js`

- `console.error` at lines ~160 (Gemini exhausted), ~396 (Tavily failed), ~451 (test failed) replaced with messages that do not embed the raw error object. Keys are never in these messages (Gemini uses the SDK header path; Tavily uses the request body), so this is defense-in-depth.
- `testKey(provider, key)` returns `{ success, provider, errorType, message }`:
  - Gemini: `400/401/403` → `invalid`; `429` or `RATE_LIMIT` → `rate_limit`; `RESOURCE_EXHAUSTED` / `quota` → `quota`; AbortError/timeout → `timeout`; otherwise → `network`.
  - Tavily: `401/403` → `invalid`; `429` → `rate_limit`; `5xx` → `network`; AbortError → `timeout`; otherwise → `network`.
  - `message` is a short English fallback string used only as a sanity default; the UI maps `errorType` to i18n.
- `classifyGeminiError` / `classifyTavilyStatus` preserved (already correct per spec §6). Covered by new unit tests.
- No signature changes to `streamChat` / `streamVision` / `streamResearch`. Fallback loop stays sequential, primary-first (because `resolveKeysForRequest` already ordered the input). Stream-mid errors remain terminal (spec §20).

### C. `src/components/SettingsPanel.jsx`

- Both Gemini and Tavily key inputs: `type="password"` + a `Show/Hide` eye toggle button bound to local state `showGeminiInput` / `showTavilyInput`.
- Under each section header: a **"Test All"** button that iterates over the section's keys, calls `testKey` for each (await, sequential, not parallel — avoids concurrent key_status races), and reloads keys via `getKeys` after each test so the status pill updates live.
- Each key row gains a **status pill** (top-right area) computed with this precedence (most recent wins):
  1. Active cooldown with `lastErrorType === 'rate_limited'` (`cooldownUntil > now`) → **rate_limited** (amber).
  2. `lastErrorType === 'quota_exceeded'` → **quota_exceeded** (red), even outside cooldown (quota is sticky until a successful retry clears it).
  3. `lastErrorType === 'invalid'` (covers 400/401/403/SAFETY; the api classifier collapses these to `'error'` and App.jsx maps to `'invalid'`) → **invalid** (red).
  4. `lastErrorAt` more recent than `lastSuccessAt` → fallback to **invalid** (red).
  5. `lastSuccessAt` set and newer than `lastErrorAt` (or `lastErrorAt` null) → **success** (green).
  6. Neither `lastSuccessAt` nor `lastErrorAt` → **pending** (gray).
- Below the pill: a "Last error: X min ago" line shown only when `lastErrorAt` is set.
- "Set as Primary" handler calls `setPrimary` then re-runs `getKeys(provider)` so the list re-renders with primary at the top.
- Test handlers (single + Test All) re-run `getKeys(provider)` after each test so status reflects the result.
- A **security warning banner** rendered at the top of the API tab using `t('setup.keys.security_warning')`.

### D. `src/App.jsx`

- In `handleSend`, before creating the user message: `await resolveKeysForRequest('gemini')`. If `mode === 'web'`, also `await resolveKeysForRequest('tavily')`.
  - If `allInCooldown` for the required provider → `toast.error(t('chat.all_keys_cooldown', { time: formattedEarliest }))` and **return early** (no messages appended, no stream started). The chat history stays unmodified.
  - Pass `geminiResolved.keys` / `tavilyResolved.keys` to the api generators.
- This fresh per-request resolve replaces the stale `geminiKeys`/`tavilyKeys` state members; those state vars remain only for the count check (e.g. disabling send when empty — currently not enforced, left as-is).
- `key_status` handler: existing branches for `'cooldown'`, `'quota_exceeded'`, and `'success'` are kept unchanged. The current `'error'` branch (which only emits a noisy `${providerName} key ${keyId} failed` toast) is replaced with `updateKeyMetadata(provider, keyId, { lastErrorAt: Date.now(), lastErrorType: 'invalid', failCount: <prev+1> })` and the toast is dropped.
- Settings onSave callback does `resolveKeysForRequest('gemini').then(r => setGeminiKeys(r.keys))` (same for tavily), so cooldowns are reflected on close.

### E. Locales (`src/locales/en.json`, `tr.json`)

New keys under `setup.keys`:
- `security_warning`
- `test_all_btn`, `show_key`, `hide_key`
- `status_success`, `status_pending`, `status_rate_limited`, `status_quota_exceeded`, `status_invalid`
- `last_error` (with `{minutes}` interpolation)
- `test_invalid`, `test_quota`, `test_rate_limit`, `test_network`, `test_timeout`, `test_unknown`

New key under `chat`:
- `all_keys_cooldown` (with `{time}` interpolation)

### F. `README.md`

In the "API Keys" section:
- Note that keys are stored in `chrome.storage.local` (not `sync`).
- Describe primary/fallback + cooldown behavior in one sentence.
- Add: "HeraAi is intended for personal/local use. Do not embed your API key in a distribution; each user adds their own keys from Settings."

### G. `src/App.test.jsx`

- Fix the existing `input[type="text"]` assertion (line ~699) to `input[type="password"]`; account for two password inputs (Gemini + Tavily) by index.
- New tests:
  1. Gemini and Tavily inputs render as `type="password"`.
  2. Eye toggle flips a section input to `type="text"` and back.
  3. Security warning text appears in the API tab.
  4. "Set as Primary" moves the chosen row above the previous primary.
  5. "Test All" calls `testKey` once per saved key for that provider.
  6. A freshly added key shows the "Pending" status pill.
  7. When all stored Gemini keys have `cooldownUntil > now`, `handleSend` blocks: no user message rendered, `streamChat` not called, a toast with the cooldown time appears. Seed cooldowns via the `chrome.storage.local` mock (no direct mock of `resolveKeysForRequest`).
  8. `testKey` returning `{ errorType: 'quota' }` surfaces the friendly "Kota dolu olabilir" message (assert on the translation key or its Turkish/English text).
- Mock `resolveKeysForRequest` indirectly by seeding `chrome.storage.local` with cooldown entries in `beforeEach` (the storage mock already returns the seeded object).

### H. `src/lib/api.test.js`

- Parametric table tests for `classifyGeminiError`: each of `{429, RESOURCE_EXHAUSTED, quota, 400/401/403, SAFETY, generic}` → expected bucket.
- Same for `classifyTavilyStatus`: `{429, 401, 403, 500, 200, 400}`.
- `testKey` for Gemini: mock `generateContent` to throw with each status → expect matching `errorType`.
- `testKey` for Tavily: mock `fetch` to resolve `{ ok: false, status: X }` for X ∈ {401, 429, 500} → expect matching `errorType`.
- `streamChat` with two keys, first throws a 429-shaped error, second streams a chunk: expect `key_status` events in order (cooldown for g1, success for g2) and the chunk from g2.
- `streamChat` with one key that throws a 400 invalid error: expect a single `key_status` `'error'` event and an `error` event; no second attempt.
- `streamChat` with one key that throws a SAFETY error: same — no fallback.

## Risk / Mitigation

| Risk | Mitigation |
|---|---|
| Existing test asserts `input[type="text"]` and breaks | Update assertion to `[type="password"]` in the same patch |
| Stale cooldown bug — current code never re-resolves keys per request, so cooldowns written to storage by `key_status` handler never affect the next request | Fresh `resolveKeysForRequest` in `handleSend` reads from storage each time; new test covers the all-cooldown block |
| Friendly test message mock surface area | `testKey` returns `errorType`; UI maps to i18n key; tests assert on i18n text so they don't break if message copy changes |
| `npm run lint` drops unused `getAllKeysForRequest` after App.jsx switches | Emit `getAllKeysForRequest` from `keyManager.js` (still used internally by tests) or remove if truly unused; verify with `npm run lint` |
| `failCount` never reset on success except via existing code path | Existing `key_status` `'success'` handler already sets `failCount: 0, cooldownUntil: null` — kept |
| `mode === 'web'` with both pools in cooldown | Block on whichever pool is exhausted; show the corresponding provider's earliest time |

## Verification

```bash
npm run lint
npm run test:run
npm run build
```

All three must pass before the work is considered done.

## Out of Scope

- Re-adding a backend or `.env` support.
- "Show full key" affordance for saved keys.
- Drag-and-drop key reordering.
- Round-robin key rotation.
- Changes to quick actions, scroll behavior, vision, manga, stats, popup, i18n locales beyond the new keys listed.