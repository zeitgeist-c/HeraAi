# HeraAi — Private Chrome Side Panel assistant

> Türkçe için: [README.tr.md](./README.tr.md)

Private AI assistant living in Chrome's Side Panel. Chat with Gemini, OpenRouter Free, and Ollama Cloud, research the web with Tavily, crop screenshots, attach files, and talk by voice. API keys live in a device-encrypted IndexedDB vault. Optional Google sign-in syncs end-to-end encrypted data through Firebase/Firestore.

![HeraAi screenshots](./docs/screenshots/)

> Screenshots are being added from a clean install (no sample data). The folder above will hold them.

## Providers and models

- **Gemini** (5 models) — streaming chat + multimodal, image/PDF inline, public-URL reading via URL Context.
- **OpenRouter Free** (2 models) — SSE streaming chat + multimodal.
- **Ollama Cloud** — Nemotron 3 Ultra, GPT-OSS 120B via NDJSON streaming.
- **Tavily** — web search + page extraction fallback when URL Context can't reach a page.
- **Key selection** — primary-first or balanced rotation, with automatic failover, pause, cooldown, and retry clock.

## Features

- **Web Research mode** — globe button; Tavily search/extract with Gemini URL Context first.
- **Screen crop** — `captureVisibleTab` + canvas overlay; crops stored in `heraai-attachments` IndexedDB (not on `chrome://` pages).
- **File attachments** — images (Gemini/OpenRouter), PDF + audio Gemini-only, Office text extraction.
- **Voice** — Gemini-only STT/TTS.
- **Sessions** — history overlay, chat search, import/export.
- **Encrypted cloud sync** — settings, chats, stats, API keys, and attachments up to 3 MiB across browsers; per-chat device-only mode.
- **Recovery and backup** — recovery-code device linking, device revocation, and encrypted full backup/restore.
- **Compare + auto-route** — model comparison panel and automatic provider routing.
- **Bilingual UI** — TR/EN via i18next; light/dark/system themes; stats and response-time display.
- **Background** — service worker + offscreen generation worker + context menus.

## Install

```bash
npm install
npm run build
```

Load `dist/` in Chrome as an unpacked extension, open the Side Panel, go to Settings, and add at least one provider key (+ Tavily for Web Research).

## Development

```bash
npm install
npm run dev      # HMR dev server
npm run preview  # preview production build
npm run lint     # eslint — run before committing
npm run test     # vitest + jsdom (chrome APIs mocked)
npm run package  # release/HeraAi-<version>.zip (currently 1.10.3)
```

## Project structure

```text
manifest.json        MV3 (sidePanel, storage, identity, alarms, activeTab, scripting, contextMenus, offscreen)
src/App.jsx          Side Panel React app
src/background/      service worker
src/offscreen/       generation worker
src/components/      Settings, ModelSelector, ChatMessage, History, Comparison, Stats, ...
src/lib/             providerApi, models, keyManager, fileParsers, voiceApi, autoRouter, ...
src/locales/         en.json, tr.json
```

## Contributing

New UI strings need both `en.json` and `tr.json` keys; map features to test cases. See [.github/PULL_REQUEST_TEMPLATE.md](./.github/PULL_REQUEST_TEMPLATE.md).

## License

See [LICENSE](./LICENSE) (pending — to be confirmed).
