# HeraAi — a private AI assistant in the Chrome Side Panel

> Turkish: [README.tr.md](./README.tr.md)

**Every model you have keys for, in a panel beside the page you are reading.**

HeraAi lives in Chrome's Side Panel. It talks to Gemini, OpenRouter Free and Ollama Cloud, searches the web through Tavily, crops a region off your screen, attaches files and speaks its answers. API keys are encrypted and kept in an IndexedDB vault on your device. Optional Google sign-in syncs end-to-end encrypted data through Firebase/Firestore.

![HeraAi · Chat](./docs/screenshots/00-ana-sohbet.png)

---

## Contents

- [What it does](#what-it-does)
- [Screens, one by one](#screens-one-by-one)
  - [1. Chat](#1-chat)
  - [2. Setup — API keys](#2-setup--api-keys)
  - [3. Main screen and menu](#3-main-screen-and-menu)
  - [4. Model picker](#4-model-picker)
  - [5. My models](#5-my-models)
  - [6. General settings](#6-general-settings)
- [Install](#install)
- [Providers and models](#providers-and-models)
- [Key handling](#key-handling)
- [Privacy and the optional cloud](#privacy-and-the-optional-cloud)
- [Build from source](#build-from-source)
- [Known limits](#known-limits)
- [License](#license)

---

## What it does

| Capability | Detail |
|---|---|
| **Side panel** | stays open beside the page; does not cover what you are reading |
| **Three providers** | Gemini (5 models), OpenRouter Free (2 models), Ollama Cloud (Nemotron 3 Ultra, GPT-OSS 120B) |
| **Streaming chat** | SSE for Gemini and OpenRouter, NDJSON for Ollama |
| **Vision input** | images and PDF pages inline, plus screen-region capture |
| **URL context** | reads a public page directly instead of scraping it |
| **Tavily fallback** | web search plus page extraction when URL context cannot reach a page |
| **Key rotation** | primary key or balanced rotation, with automatic failover, cooldown and retry timing |
| **Model catalogue** | fetch the models your own keys can see and choose which appear in the chat picker |
| **Local vault** | keys encrypted in IndexedDB on the device |
| **Optional sync** | Google sign-in, end-to-end encrypted, through Firebase/Firestore |
| **Bilingual UI** | Turkish and English, light / dark / system |

---

## Screens, one by one

### 1. Chat

![Chat](./docs/screenshots/00-ana-sohbet.png)

The main surface, sized for a side panel.

- **Header** — session title, rename, search inside the chat, export as Markdown, copy the whole chat, open in a full page, new chat, and the *more* menu.
- **Welcome state** — `Hello, how can I help you?` with three starter cards: **Web research** (Tavily), **Select from screen** (crop a region and ask about it), **Attach file** (image, PDF, document or text).
- **Composer** — the message box, plus tools for attach, voice input, screen-region capture, OCR from an attached image, translate the selection, and the send button.
- **Footer** — the active model pill (`Gemini 3.1 Flash Lite` with a `GEMINI` tag), and the standing note that AI can be wrong and important facts should be checked.

The panel is deliberately narrow: one column, one composer, no sidebars competing for space.

### 2. Setup — API keys

![Setup · API keys](./docs/screenshots/01-kurulum-api.png)

First launch asks for keys, one row per provider: **Gemini**, **OpenRouter**, **Ollama (no vision support)**, **Tavily search**.

Each row shows how many keys are registered (`0` until you add one) and accepts several keys per provider. `Save and continue` saves and continues.

Nothing else works before this step — the app does not ship with a key and does not proxy through someone else's account.

### 3. Main screen and menu

![Main screen and menu](./docs/screenshots/02-ana-ekran-menu.png)

The *more* menu, opened from the header:

| Item | What it does |
|---|---|
| **New chat** | start a fresh session |
| **History** | the history overlay |
| **Import** / **Export** | import or export a chat |
| **Statistics** | usage statistics |
| **Release notes** | changelog |
| **Settings** | the settings panel |
| **Clear** | bulk delete, with confirmation |

### 4. Model picker

![Model picker](./docs/screenshots/03-model-secici.png)

The pill at the bottom opens the picker. Models are grouped by provider — `GEMINI` first, then `OPENROUTER`, then `OLLAMA` — and each entry shows the model name and whether it accepts images (the camera icon).

Choosing a model changes the active provider for the next message. The picker only lists models you enabled in *My models*, so it stays short.

### 5. My models

![My models](./docs/screenshots/04-modellerim.png)

The catalogue view, inside Setup.

`Fetch / refresh models` asks each provider what your keys can actually see, then lists the result with a checkbox per model: name, provider and API identifier (`gemini-3.5-flash-lite`, `google/gemma-4-26b-a4b-it:free`, `nvidia/nemotron-3-super-120b-a12b:free`), plus a camera mark for vision.

The note above the list is honest: *"Being listed is not a guarantee of access or free use."* Appearing in the catalogue does not mean the account can use it or that it stays free. Choices are saved to this browser only.

### 6. General settings

![General settings](./docs/screenshots/05-genel-ayarlar.png)

- **API key usage** — `Use primary keys` (primary keys only) or `Use keys in rotation` (rotate through all keys).
- **Appearance** — `System default`, `Light theme`, `Dark theme`, plus an accent colour picker.
- **Language** — Turkish or English for the whole interface.
- **Show sources** — whether a research answer renders its source cards.
- **System prompt** — the base instruction sent with every conversation (`You are a general-purpose AI assistant…`). Editing it changes the assistant's default behaviour for your account, not for anyone else.

`Save and continue` applies the changes.

---

## Providers and models

| Provider | Models | Streaming | Vision |
|---|---|---|---|
| **Gemini** | 5 (3.1 Flash Lite → 3.8 Flash) | SSE | yes, images and PDF pages |
| **OpenRouter Free** | 2 | SSE | yes |
| **Ollama Cloud** | Nemotron 3 Ultra, GPT-OSS 120B | NDJSON | no |

Plus **Tavily** for web search and page extraction, used when URL context cannot reach a page.

## Key handling

- Keys live in an **encrypted IndexedDB vault** on the device.
- Multiple keys per provider are supported.
- **Primary mode** always uses the first key. **Rotation mode** walks the list, so one key's quota does not stall the session.
- A key that fails is put on a cooldown with a visible retry clock; the next key takes over.
- A request that already failed is not silently re-sent to a paid path.

## Privacy and the optional cloud

- Nothing is sent anywhere until you add a key. There is no built-in key, no proxy account.
- Chats and keys stay on the device in the default setup.
- **Google sign-in is optional.** When enabled, end-to-end encrypted data syncs through Firebase/Firestore — the server stores ciphertext, not your plaintext chats.
- Screen crops and files are sent only to the provider you selected for that message.

## Build from source

```powershell
npm install
npm run build          # production build into dist/
npm run package        # build + zip the extension for the store
```

Then load the built folder as an unpacked extension:

1. `chrome://extensions` → enable **Developer mode**.
2. `Load unpacked` → pick `dist/` (or `.tools/public-build/`).
3. Open the side panel from the toolbar.

Tests:

```powershell
npx vitest run
```

## Known limits

- **Ollama has no vision** — the provider is marked as such in Setup, and the composer's image tools are not offered for it.
- Free-tier models are rate-limited and their availability changes; the catalogue is a snapshot, not a promise.
- The optional cloud requires a live Firebase project and billing for anything beyond the free tier; the local path needs neither.
- Sync is end-to-end encrypted, which means a lost passphrase cannot be recovered by the server.

## License

MIT — see [LICENSE](./LICENSE).
