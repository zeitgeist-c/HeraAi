# HeraAi 1.3.0 — Kalıcı Yanıt Akışı Düzeltmesi (Design Spec)

**Date:** 2026-07-26
**Spec owner:** HeraAi maintainer
**Target release:** v1.3.0
**Branch policy (onaylı):** `codex/fix-visible-thinking-flow` dalındaki mevcut commit edilmemiş değişiklikler önce `feat: 1.3.0 hazırlık + visible-thinking flow` commitiyle kaydedilir. Offscreen worker mimarisi bunun üstüne ayrı, anlamlı commitlerle inşa edilir.

## 0. Özet

"Düşünüyor…" ve cevap gösterimi `App.jsx` içindeki geçici timer/ref koşulundan çıkarılır. API isteği servis worker tarafından yönetilen, kalıcı (`chrome.storage.local.activeGeneration`) duruma sahip tek bir **offscreen Web Worker** tarafından yürütülür. Panel kapatılsa bile üretim arka planda devam eder; yeniden açıldığında kalıcı durumdan doğal biçimde sürdürülür. Tarayıcı tamamen kapanırsa son kaydedilen kısmi içerik `interrupted` durumuyla korunur; ikinci bir API isteği yapılmaz, yalnızca "Yeniden Dene" düğmesi sunulur.

Mimari karar (onaylı): **A — Düz `chrome.runtime.sendMessage` mesajları + revizyon temelli TAM içerik snapshot'ları.** SW `activeGeneration` kaydının tek yazıcısıdır; offscreen worker yalnız API isteğini çalıştırır ve SW'ye snapshot bildirir.

## 1. Mimari Genel Görünüm ve Veri Akışı

### Katmanlar (sahiplik kesin ayrım)
- **Panel (side-panel React app, `src/App.jsx` + components):** yalnız `sessions` ve `messages` ile görünür asistan içeriğini yönetir.
- **Service Worker (`src/background/service_worker.js`):** `activeGeneration` kaydının tek yazıcısı; anahtar çözümleme (`resolveKeysForRequest`); offscreen doc lifecycle; heartbeat supervisor; CANCEL / GET_STATE koordinatörü.
- **Offscreen doküman (`src/offscreen/offscreen.html` + `src/offscreen/offscreen-bootstrap.js`):** görünmez sayfa; `generation-worker.js` Web Worker'ını başlatır; SW→offscreen mesajlarını alıp worker'a iletir, worker çıktılarını SW'ye paketler.
- **Shared engine (`src/lib/api.js` refactor):** React/toast/i18n bağımlılıklarından arındırılır; hata metni yerine `errorCode` döndürür; çeviri panel tarafında yapılır.

### Veri akışı (normal akış)
```dot
digraph flow {
  "Panel: handleSend" -> "Panel: atomic write {sessions, activeSessionId, activeGeneration:{status:queued, revision:0}}" [label="1"];
  "Panel: atomic write ..." -> "Panel: chrome.runtime.sendMessage(HERA_GENERATION_START)" [label="2"];
  "HERA_GENERATION_START" -> "SW: resolveKeysForRequest(gemini[,tavily]); createDocument(offscreen.html); forward to offscreen" [label="3-5"];
  "SW: ..." -> "Offscreen bootstrap: new Worker(generation-worker.js); worker runs streamChat|streamVision|streamResearch" [label="6"];
  "Offscreen: ..." -> "Offscreen: SW'ye SNAPSHOT{revision,content,sources,...}" [label="7"];
  "Offscreen: SNAPSHOT" -> "SW: if revision > storedRevision: write activeGeneration{status:running}; PRESENTED ack" [label="8"];
  "SW: if revision > ..." -> "SW: panel'e ACTIVE_GEN_CHANGED broadcast" [label="9"];
  "SW: ..." -> "Panel: typing-pump animasyonu (status:streaming)" [label="10"];
  "Offscreen: complete" -> "SW: activeGeneration{status:completed, lastSnapshot}; panel'e DONE broadcast; closeDocument" [label="11"];
  "SW: DONE broadcast" -> "Panel: drain pump; final assistant status=done; persistSessionMessages; DONE_ACK to SW" [label="12"];
  "Panel: DONE_ACK" -> "SW: storage.remove(['activeGeneration'])" [label="13"];
}
```

### Üretim durumları (`activeGeneration.status`)
`queued → running → completed` veya `cancelled | error | interrupted`. Aynı anda yalnızca tek aktif üretim; ikinci submit, mevcut zaten `queued|running` iken `already_running` hatası döndürür. Composer disable bayrağı global `isGenerating` ile devam eder (mevcut davranış korunur).

### İç mesaj tipleri (vocabulary)
Panel ↔ SW ↔ Offscreen: `HERA_GENERATION_START | CANCEL | GET_STATE | STATE | SNAPSHOT | ACTIVE_GEN_CHANGED | PRESENTED | DONE | DONE_ACK | HEARTBEAT | KEY_STATUS | START_REJECTED`. (Tümü `chrome.runtime.sendMessage({type, ...data})` ile dolaşır.)

## 2. Bileşen Sorumlulukları ve İç Mesaj Protokolü

### 2.1 Sorumluluk matrisi

| Sorumluluk | Panel | Service Worker | Offscreen / Worker | Engine (`api.js`) |
|---|---|---|---|---|
| `sessions`, `messages` yazımı | ✅ tek yazıcı | — | — | — |
| `activeGeneration` storage yazımı | — | ✅ tek yazıcı | — | — |
| Key çözümleme (`resolveKeysForRequest`) | — | ✅ | — | — |
| `streamChat/streamVision/streamResearch` çağrısı | — | — | ✅ (worker) | sağlayıcı |
| Hata metni/i18n | ✅ (translation) | — | — | — |
| Hata kodu sınıflandırma | — | — | ✅ (worker → SW) | ✅ (engine) |
| Offscreen doc lifecycle | — | ✅ | — | — |
| Typing-pump (görünür animasyon) | ✅ | — | — | — |
| Markdown çizimi | ✅ | — | — | — |

### 2.2 Panel: yeni davranış
- **Mevcut kaldırılacak**: `streamingControllerRef`, `streamBufferRef`, `displayedAssistantContentRef`, `streamDisplayFrameRef`, `streamRevealNotBeforeRef`, `queueAssistantText`, `scheduleAssistantDisplayFrame`, `resolveStreamDrainWaiters`, `waitForVisiblePaint`, `waitForPanelVisible`, `panelVisibilityWaitersRef`, `prevIsGeneratingRef`-temelli "stop display" mantığı, doğrudan `streamChat/streamResearch/streamVision` import + çağrı (App.jsx içi), mevcut `chrome.storage.local.remove(['activeGeneration'])` çağrısı (panel içinde artık anlamsız).
- **Yeni kalacak**: typing-pump mekanizması korunur; fakat giriş kaynağı yerel event buffer yerine `activeGeneration.content` snapshot'ı; görünür portion ayrımı `displayedLenRef` ile; throttle ve chunk-of-words davranışı korunur.
- **Mevcut korunacak**: `normalizeConversationMessages`, `repairMessageIds`, `repairStoredSessions`, `createUserMessage`, `createAssistantMessage`, scroll mekanikleri, attachment/crop/shortcuts/history panelleri, session CRUD.

### 2.3 Service Worker: `src/background/service_worker.js`
- Mevcut kısım (`sidePanel.setPanelBehavior`, context menu, `HERAAI_CROP_DONE` iletme) korunur.
- Yeni `chrome.runtime.onMessage` ana handler kurulur: `HERA_GENERATION_START | SNAPSHOT | CANCEL | GET_STATE | HEARTBEAT` tiplerini ele alır.
- `chrome.offscreen.hasDocument({reason:'WORKERS'})` → yoksa `chrome.offscreen.createDocument({url: chrome.runtime.getURL('offscreen.html'), reason:'WORKERS', justification:'Stream chat completions off the panel context for persistent generation.'})`.
- `onMessage` listener `async` (true döner; whenever a Promise yanıtı gerekirse `sendResponse` callback ile iletir).
- **Key çözümleme**: `resolveKeysForRequest('gemini')` ve web modunda `'tavily'` SW'de çalışır. Cooldown hatası `all_keys_cooldown` errorCode olarak panel'e iletilir.
- **Snapshot işleme**: her SNAPSHOT geldiğinde `if rev > activeGeneration.revision: storage.set({activeGeneration: {...revision:rev, content, status:'running', lastSnapshotAt:Date.now()}})`; ardından `chrome.runtime.sendMessage({type:'ACTIVE_GEN_CHANGED', snapshot})` panel'e; ve offscreen'e `{type:'PRESENTED', jobId, revision:rev}` ack. Sıra dışı veya tekrar gelen (`rev <= revision`) snapshot sessizce yok sayılır (rev dedup).
- **Heartbeat**: her 15 sn worker → bootstrap → SW'ye `HEARTBEAT` mesajı gönderilir; SW `lastHeartbeatAt` günceller. SW evicted olsa bile sonraki `chrome.runtime.sendMessage` SW'yi uyandırır; çağrı `chrome.runtime.lastError` ile reddedilirse bootstrap exponential backoff (1s → 2s → 5s → 10s) ile yeniden dener.
- **CANCEL**: evvela offscreen'e `CANCEL` iletilir, sonra `activeGeneration.status:'cancelled', cancelReason:reason` yazılır, sonra panel'e `CANCEL_DONE` broadcast, sonra `chrome.offscreen.closeDocument()`.
- **GET_STATE**: panel mount/uyanış sırasında çağırır; SW `activeGeneration` snapshot'ı + son `keyStatuses` döner.
- **closeDocument zamanlaması**: generation tamamlandığında (completed/error) panel'e DONE broadcast beklenir, ardından `closeDocument()` çağrılır. cancelled case'inde `CANCEL_DONE` broadcast sonrası close.

### 2.4 Offscreen bootstrap: `src/offscreen/offscreen.html` + `offscreen-bootstrap.js`
- `offscreen.html`: minimal gövde; `<script type="module" src="./offscreen-bootstrap.js"></script>`.
- `offscreen-bootstrap.js`: mount'ta `chrome.runtime.onMessage.addListener(handler)`.
  - `HERA_GENERATION_START` → `worker = new Worker(new URL('./generation-worker.js', import.meta.url), { type: 'module' })`; `worker.postMessage({ kind:'start', jobId, requestMessages, geminiKeys, tavilyKeys, model, mode, systemInstruction, language })`; aktif job map (`jobMap.set(jobId, worker)`).
  - `CANCEL` → `worker.postMessage({ kind:'cancel', jobId })` (worker AbortController.abort() yapar).
  - `worker.onmessage` → `{kind:'snapshot', rev, content, sources}` veya `{kind:'error', code, sources, content}` veya `{kind:'key_status', provider, keyId, status}` veya `{kind:'heartbeat', uptimeMs}` veya `{kind:'done', finalRev, content, sources, cancelled}` eventlerini SW'ye `{type:SNAPSHOT | WORKER_ERROR | KEY_STATUS | HEARTBEAT | WORKER_DONE, ...}` paketi olarak ilet.
  - `worker.onmessageerror`/`worker.onerror` → `WORKER_ERROR` (code:'generation_failed') mesajı SW'ye ilet + cleanup.
- Offscreen doküman 1 worker / job modunda çalışır; birden fazla eş zamanlı gönderimi SW zaten engellediği için tek worker olur.

### 2.5 Generation Worker: `src/offscreen/generation-worker.js`
- Module worker. ESM `import` ile `streamChat / streamVision / streamResearch` engine'lerini çağırır.
- `onmessage` ile `start` veya `cancel` mesajları.
- **start** işleyişi:
  1. `controller = new AbortController()` (cancel tetikler).
  2. mode'a göre uygun async iterator seç.
  3. accumulator: `content = ''`, `revision = 0`, `sources = null`, `lastPostedAt = 0`, kurulu bir flush timerı yok.
  4. **Throttle**: her chunk geldiğinde `content += chunk.text`; son post'tan bu yana en az 150 ms geçtiyse veya stream tamamlandıysa → `revision++`, `postMessage({kind:'snapshot', rev, content, status:'running', sources})` (TAM içerik snapshot); aksi halde kurulu bir tek-shot 150 ms flush timerı yoksa onu kur.
  5. `event:'sources'` geldiğinde `sources` güncelle → bir sonraki snapshot'a dahil.
  6. `event:'key_status'` geldiğinde: `postMessage({kind:'key_status', provider, keyId, status})` — bootstrap bunu SW'ye `{type:'KEY_STATUS', ...}` olarak iletir; SW key metadata'i günceller ve panel'e iletir.
  7. `event:'error'` → `revision++`, `postMessage({kind:'error', code, sources, content})`.
  8. İş bittiğinde → son snapshot (`status:'running'`) hala flush edilmemişse flush; ardından `postMessage({kind:'done', cancelled:false, finalRev:revision, content, sources})`.
- **cancel** → `controller.abort()`; işleyiş `AbortError` fırlatır; worker `postMessage({kind:'done', cancelled:true, finalRev:<last revision number>, content, sources, errorCode:null})` ile kapanış bildirir (SW `cancelled` state'iyle yazar).
- **Heartbeat**: her 15 s `postMessage({kind:'heartbeat', uptimeMs: Date.now()-startedAt})` gönderilir; bootstrap SW'ye `HEARTBEAT` mesajı olarak iletir.
- **Locale/i18n**: kod içi çeviri yok. Yalnız `errorCode` gönderir; metne dökme Panel'de yapılır.

### 2.6 Shared engine refactor: `src/lib/api.js`
- Mevcut async iterator API'leri (`streamChat`/`streamVision`/`streamResearch`) imzaları değiştirilmeden korunur; fakat `yield` edilen event payloadındaki `data.message` (TR metin) kaldırılır ve yalnız `data.code` iletilir. Kısa günlük amaçlı `console.error` mesajları korunabilir.
- Error code değerleri tekilleştirilir: `api_key_missing | all_keys_cooldown | generation_failed | rate_limited | quota_exceeded | network_error | timeout | empty_response`.
- `key_status` eventleri worker'a iletilir; worker bunu `{kind:'key_status'}` ile özetler.
- `initCrop`, `testKey`, locale-temelli prompt kurma (`buildResearchPrompt` gibi) `api.js` içinde kalmaya devam eder — bunlar zaten saf.
- `appConfig.systemInstruction` ve `language` parametreleri `requestOptions` üzerinden iletilir; engine hiçbir `react-i18next` veya `toast` importu yapmaz. Engine zaten bu importları içermiyor; refactor yalnızca `data.message` kaldırımı ve error code tekilleştirme.

## 3. Storage Şeması

### 3.1 `chrome.storage.local.activeGeneration` (tek kayıt)
```json
{
  "jobId": "<requestId>-<assistantId>",
  "requestId": "<Date.now>-<assistantId>",
  "sessionId": "1699999001",
  "userMessageId": "<uuid>",
  "assistantMessageId": "<uuid>",
  "startedAt": 1700000000000,
  "completedAt": null,
  "streamCompletedAt": null,
  "mode": "chat|vision|web",
  "model": "gemini-3.6-flash",
  "language": "tr",
  "status": "queued|running|completed|cancelled|error|interrupted",
  "revision": 7,
  "content": "...",
  "sources": [],
  "errorCode": null,
  "cancelReason": null,
  "lastSnapshotAt": 1700000001234,
  "lastHeartbeatAt": 1700000007123,
  "presentedRevision": 7
}
```
- **Ham API anahtar YAZILMAZ.** `geminiKeys`/`tavilyKeys` yalnız SW→offscreen forward mesajında taşınır; storage'a asla yazılmaz. `resolveKeysForRequest()` storage anahtarları `geminiApiKeys`/`tavilyApiKeys` üzerinden okuma yapar.
- Panel ile SW senkronizasyonu `revision` ve `presentedRevision` üzerinden yapılır; ek bir digest alanına gerek yoktur.

### 3.2 Storage lifecycle kuralları
1. **queued** (panel submit anında tek `set({sessions, activeSessionId, activeGeneration})` ile). SW `HERA_GENERATION_START` aldığında tek storage update'le `running`'e geçer (revision `0`, dolayısıyla ilk snapshot `revision:1` gönderir).
2. **running** + SNAPSHOT(rev=N):
   - `rev <= activeGeneration.revision` → yok say (dedup).
   - `rev > revision` → `revision=N, content=payload.content, sources=payload.sources, lastSnapshotAt=now, status:'running'` yazar. Storage write resolve olduktan sonra SW `presentedRevision=N` olarak ayarlar. Panel `ACTIVE_GEN_CHANGED` alır.
3. **completed**: worker `done` sinyali → SW `activeGeneration.status='completed', streamCompletedAt=now, completedAt=now, lastSnapshotAt=now, revision=finalRev, content=final, sources` yazar. Panel'e `{type:'DONE', status:'completed', finalRev, content, sources}` broadcast. SW `remove(['activeGeneration'])`'i **yalnızca panel'den `DONE_ACK` aldıktan sonra** yapar (panel typing-pump bitince ve sessions'a flush edince ACK gönderir). Panel kapalıyken ACK gelmezse kayıt storage'da kalır; panel bir sonraki açılışta `GET_STATE` ile alıp typing animasyonunu oynatır, bitince ACK gönderir.
4. **cancelled** (Stop / New Chat / session switch): SW `CANCEL`'ı offscreen'e iletir; worker `cancelled:true` döner; SW `activeGeneration.status='cancelled', cancelReason=reason, lastSnapshotAt` yazar; panel'e `CANCEL_DONE` broadcast. Bundan sonra SW `remove(['activeGeneration'])`'i yine **`DONE_ACK` (veya `CANCEL_DONE_ACK`) alana kadar** bekler.
5. **error**: SW worker'dan `WORKER_ERROR {code, sources, content}` → `activeGeneration.status='error', errorCode=code, lastSnapshotAt` yazar; panel'e `{type:'DONE', status:'error', errorCode, content, sources}` broadcast; SW `DONE_ACK` alana kadar `remove(['activeGeneration'])`'i bekler.
6. **interrupted**: Panel mount sırasında `GET_STATE` → `activeGeneration.status ∈ {queued, running}` ise (yani tarayıcı tamamen kapanmış, SW uyanmadığı için terminal değil):
   - İlgili `assistantMessageId`'yi `status:'interrupted'`, `content=activeGeneration.content` (kayıtlı kısmi) olarak `sessions` ve yerel `messages`'a yansıt.
   - Tek `chrome.storage.local.set({sessions})` + ardından `chrome.storage.local.remove(['activeGeneration'])` (kullanıcı bir daha tekrar etmek istemezse, kayıt temizlenir).
   - **İkinci otomatik API isteği yapılmaz.** Retry düğmesi mevcut `handleRetryMessage` callback'ini tetikler (`userMessageId` veya önceki kullanıcının mesajının `id`'siyle yeni generation başlatır).

**Not — `DONE_ACK` protokolu**: tüm terminal durumlar (completed, cancelled, error) için SW `remove(['activeGeneration'])`'i ancak panel'den `DONE_ACK` aldıktan sonra yapar. Panel typing-pump bittikten ve `chrome.storage.local.set({sessions: ...})` resolve olduktan sonra `chrome.runtime.sendMessage({type:'DONE_ACK', jobId, finalRevision})`'i SW'ye gönderir. SW timeout koymaz; eğer panel hiç bir zaman açılmazsa kayıt storage'da süresiz kalır (zararsız; yeni session aktivitesi sırasında panel ya da SW isteyerek silebilir). Panel mount sırasında `GET_STATE` terminal dönerse (örn. SW'ye ulaşamadan tarayıcı kapanıp açtıysa, ack SW'ye ulaşmadan storage'da kalmışsa), Panel yine de normal terminal finalize akışını işler ve ack gönderir.

### 3.3 `sessions[i]` mesaj yapısı
```json
{
  "id": "<uuid>",
  "role": "model",
  "requestId": "...",
  "userMessageId": "...",
  "startedAt": 1700000000000,
  "content": "Partial or full text...",
  "status": "thinking|streaming|done|cancelled|cancelled_empty|error|interrupted",
  "sources": [],
  "errorCode": null,
  "attachments": []
}
```
- **Backward compatibility**: Eski mesajlarda `status` alanı yoksa `done` varsayılır. `repairStoredSessions` mevcut migration korunur; **yeni migration kuralı**: kayıtlı `thinking`/`streaming` status'una sahip (içeriği olan) model mesajları artık `cancelled` yerine `interrupted`'a çevrilir. Açık `cancelled_empty` (içeriksiz) mesajlar düşürülür.
- **Duplicate id onarımı**: mevcut `repairMessageIds` ile devam eder.

### 3.4 Throttle ve flush kuralları
- **Panel `sessions` yazımı**: en fazla 150 ms aralıkla, mesaj kimliği bazında serialize edilip tek overwrite. `visibilitychange` (`document.hidden`) ve `window.pagehide` anında mevcut `messages` snapshot flush edilir.
- **SW `activeGeneration` yazımı**: her SNAPSHOT için senkron tek `storage.set`. revision dedup nedeniyle aynı revision tekrar yazılmaz (offscreen tarafı zaten 150ms throttle).
- **Panel → SW → Panel sıralama**: SW `ACTIVE_GEN_CHANGED` broadcast'leri `{jobId, revision, content, sources, status}` taşır. Panel yalnız kendi takip ettiği jobId ile eşleşen snapshot'ları işler; başka jobId'leri yok sayar.

## 4. Lifecycle Detayları

### 4.1 Gönderim fazı (Panel → SW → Offscreen)
1. **Panel `handleSend`**:
   - Guard: `isGeneratingRef.current` ise çık.
   - `userMessage` + `assistantMessage(status:'thinking', requestId, userMessageId, startedAt)` oluştur.
   - **Atomic storage write** (tek `chrome.storage.local.set({ sessions, activeSessionId, activeGeneration })`).
   - `chrome.runtime.sendMessage({type:'HERA_GENERATION_START', jobId, requestId, sessionId, userMessageId, assistantMessageId, startedAt, mode, model, requestMessages, systemInstruction, language})` gönderilir. **Yerleşik `setTimeout` gerekmez.** Yalnız `flushSync(setGenerating(true))` ve `stickToBottomOnNextRender()`.
2. **SW `HERA_GENERATION_START` handler**:
   - Zaten aktif generation (`status ∈ {queued, running}`) ve `jobId !== currentJobId` ise → `sendMessage({type:'START_REJECTED', errorCode:'already_running'})` panel'e.
   - `activeGeneration.status='running'` storage update (revision 0 korunur).
   - `resolveKeysForRequest('gemini')`: `allInCooldown` ise `activeGeneration.status='error', errorCode='all_keys_cooldown'` yazar, panel'e `{type:'DONE', status:'error', errorCode:'all_keys_cooldown'}` broadcast, `closeDocument()`. Yine SW `DONE_ACK` bekler (`remove` için).
   - Web modunda `resolveKeysForRequest('tavily')`: yine `all_keys_cooldown` kontrolü.
   - `chrome.offscreen.createDocument` (zaten varsa skip).
   - `chrome.runtime.sendMessage` to offscreen: `{type:'HERA_GENERATION_START', jobId, requestMessages, geminiKeys, tavilyKeys, model, mode, systemInstruction, language, assistantMessageId, userMessageId, requestId, startedAt}`.
3. **Offscreen bootstrap**:
   - Aktif worker varsa `terminate()`.
   - `worker = new Worker(new URL('./generation-worker.js', import.meta.url), {type:'module'})`.
   - `worker.postMessage({kind:'start', jobId, requestMessages, geminiKeys, tavilyKeys, model, mode, systemInstruction, language})` — ham keyleri yalnız worker context'ine taşır; storage'a yazmaz.
   - Aktif job kaydı `jobMap.set(jobId, worker)`.

### 4.2 Stream fazı (Worker → SW → Panel)
- **Worker** her ~150 ms'de (son post'tan sonra timer veya stream tamamlanmasıyla) `{kind:'snapshot', rev, content, sources, status:'running'}` postMsg.
- **Bootstrap** SNAPSHOT'ı SW'ye forward: `chrome.runtime.sendMessage({type:'SNAPSHOT', jobId, revision:rev, content, sources, status:'running'})`.
- **SW** SNAPSHOT geldiğinde: rev dedup kontrolü; `storage.set({activeGeneration: {..., revision:rev, content, status:'running', lastSnapshotAt:now()}})` (tek çağrı); broadcast `{type:'ACTIVE_GEN_CHANGED', snapshot:{jobId, revision, content, sources, status}}` to panel; offscreen'e `chrome.runtime.sendMessage({type:'PRESENTED', jobId, revision:rev})` ack.
- **Bootstrap** PRESENTED'i worker'a `postMessage({kind:'presented', rev})` olarak iletir; worker yalnız loglama amacıyla saklar (zamanlama/throttle etkisi yok; rev dedup SW tarafında yapılır).
- **Panel** `ACTIVE_GEN_CHANGED` aldığında:
  - `targetMessageId = assistantMessageId` (sadece kendi takip ettiği jobId eşleşirse).
  - Yerel `activeGenerationRef`'e snapshot'ı kaydet.
  - Typing-pump tetiklenir (Bölüm 4.3).

### 4.3 Typing-pump (Panel, canlı)
- **Pump girişi**: `activeGeneration.content` (kalıcı durum). Panel "görünür" portion ve "tam içerik" ayrımı yapar (görünür portion yavaşça artar).
- **`MIN_THINKING_PERSISTENT_MS` = 500** (yeni spec). Görünür içerik sıfır iken "Düşünüyor…" placeholder `animate-pulse` ile gösterilir; ilk chunk'tan sonra **en az 500 ms** boyunca placeholder kalır (mevcut `streamRevealNotBefore` mantığı yeni mekanizmaya taşınır).
- **Display step** (yeni spec):
  - küçük kuyruk (≤ `STREAM_SHORT_BUFFER` 240): `(characters: 2, delay: 30)` — 2 karakter / ~30 ms; spec'te "28–32 ms" aralığı kabul.
  - orta kuyruk (`> 240`, ≤ `STREAM_LONG_BUFFER` 900): `(characters: 24, delay: 60)`.
  - uzun kuyruk (`> 900`): `(characters: 36, delay: 60)`.
- **R-per-frame**: `requestDisplayFrame(pump)` korunur; görünür kare başına yalnız bir React güncellemesi.
- **Markdown gating**: `ChatMessage` `isPending` (`message.status === 'thinking' | 'streaming'`) iken düz text render; yalnız `status ∈ {'done', 'cancelled', 'error', 'interrupted'}` iken ReactMarkdown renderlanır. Mevcut `renderableMarkdown` (kapanmamış code-fence ekleme) korunur.
- **Panel görünürlük**: `panelVisibleRef`, `visibilitychange`, `freeze/resume`, `focus` listener korunur; fakat pump **artık `waitForVisiblePaint` blocklamaz** — pump yalnız `panelVisibleRef.current && document.visibilityState !== 'hidden'` iken ilerler. Gizli iken pump durur; panel tekrar görünür olduğunda kaldığı yerden sürdürür.

### 4.4 Tamamlama fazı (Worker → SW → Panel)
- **Worker** stream bitince: son snapshot'ı flush → `{kind:'done', cancelled:false, finalRev, content, sources}` postMsg. (cancelled durumda `{kind:'done', cancelled:true, finalRev, content, sources}`.)
- **Bootstrap** → `{type:'WORKER_DONE', cancelled, finalRev, content, sources}` SW'ye.
- **SW**:
  - `cancelled:true` ise `activeGeneration.status='cancelled', cancelReason=null` (cancel SW tarafından daha önce yazılmış zaten), yazar; `CANCEL_DONE` broadcast.
  - Aksi halde `status:'completed', revision:finalRev, content, sources, completedAt, streamCompletedAt` yazar (hata durumunda `status:'error', errorCode`).
  - Panel'e `{type:'DONE', status, finalRev, content, sources, errorCode}` broadcast.
  - `chrome.offscreen.closeDocument()` çağrılır (offscreen tarafı SW'den DONE ack beklemeden kapanabilir; önemli olan activeGeneration kaydın kalıcılığı).
  - **`remove(['activeGeneration'])`'i `DONE_ACK` bekler** (Bölüm 3.2 — terminal durum protokolu).
- **Panel DONE handler**:
  - pump drain (kalan visible-buffer'ı boşalt; son chunk'ı yaz).
  - assistant message `status`'unu `done | cancelled | error | interrupted` olarak güncelle, `content=activeGeneration.content`, `sources`.
  - `setGenerating(false)` ve `persistSessionMessages()` (flush sessions).
  - `chrome.runtime.sendMessage({type:'DONE_ACK', jobId, finalRevision})` SW'ye gönder.
  - Local `activeGenerationRef` temizle.

### 4.5 Kapat-Aç senaryoları
- **(a) Panel normal kapanış (yan panel kapanır, tarayıcı açık)**: Pump durur. SW + Offscreen üretime devam eder; SW `activeGeneration`'a yazmaya devam eder. Panel `pagehide`/`beforeunload` sırasında görünür içerik snapshot'ını `sessions`'a flush eder. Yeniden açıldığında: `GET_STATE` → `activeGeneration` snapshot'ı okur; typing-pump kaldığı yerden sürdürülür (default throttle ile).
- **(b) Tarayıcı tamamen kapandı (extension shutdown)**: SW + offscreen kapanır; son `activeGeneration` storage'da kalır (status 'queued'/'running'). Yeni açılışta Panel `GET_STATE` → aktif üretim var, status terminal değil → `interrupted` semantiği (Bölüm 3.2 / 5.2).
- **(c) Chromium yeniden başlatma mid-stream**: (b) ile aynı.

### 4.6 Hatalı faz (cooldown, ağ, kota)
- **All-keys-cooldown** (SW tarafı ön-kontrol): red ile panel'e `errorCode='all_keys_cooldown'` gönderilir; panel toast'u `t('chat.all_keys_cooldown')` ile gösterir (TR key mevcut).
- **Generation sırasında error**: worker → SW → DONE broadcast; panel toast'u `t('chat.generation_errors.<code>')` ile gösterir; assistantMessage `status:'error', errorCode`.
- **Timeout / empty_response**: engine içinde sınıflandırılır, errorCode olarak iletilir.
- **Worker çökmesi / mesaj error** (`onerror`): bootstrap `WORKER_ERROR` SW'ye iletir; SW `errorCode='generation_failed'` ile DONE akışı başlatır ve closeDocument.

## 5. Restart / Resume / Interrupted / Retry

### 5.1 Panel mount akışı
- `useEffect` (mount): önce `chrome.storage.local.get` → config + sessions + activeSessionId + selectedModel; mevcut `repairStoredSessions` + welcomeMsg uygulanır.
- **Yeni**: config okunduktan hemen sonra `chrome.runtime.sendMessage({type:'GET_STATE'})` ile SW'den `activeGeneration` snapshot'ı alınır. Sonuç:
  - **A: `activeGeneration.sessionId !== activeSessionId`** → yalnız `sessions` render edilir; arka planda üretim devam eder. Yerel `isGenerating` bayrağı **false** (kullanıcı farklı session'da); composer enable. (Spec: tek üretim global; farklı session olsa bile SW çalışmaya devam eder.)
  - **B: `activeGeneration.sessionId === activeSessionId` AND `status ∈ {queued, running}`**:
    - Üretimin `assistantMessageId`'sini `messages` içinde bul.
    - **Mevcut yerel mesaj `status` `thinking|streaming`'se**: içeriğini `activeGeneration.content` ile güncelle (UI tutarlı), typing-pump tetikle.
    - **Mevcut mesaj yoksa**: `createAssistantMessage` ile ekle (`content=activeGeneration.content`, `status=thinking|streaming`), typing-pump tetikle.
    - Yerel `isGenerating=true`; pump + listener aktif.
  - **C: `activeGeneration.sessionId === activeSessionId` AND `status = completed`** (worker panel açılmadan önce bitmiş ve `DONE_ACK` hiç gönderilmemiş):
    - Assistant message'a `status:'streaming', content=''` atanır ve typing-pump tam içeriği (`activeGeneration.content`'i) kademeli olarak yazar (spec: "tam cevap alınmış olsa bile doğrudan ekrana yazılmayacak"). Pump bittiğinde `status:'done'`, `persistSessionMessages()`, ardından `chrome.runtime.sendMessage({type:'DONE_ACK', jobId, finalRevision})` → SW `remove(['activeGeneration'])`.
  - **D: `activeGeneration.sessionId === activeSessionId` AND `status = error`** (hata storage'da kalmış, `DONE_ACK` gönderilmemiş):
    - assistant message `status:'error', errorCode=activeGeneration.errorCode, content=activeGeneration.content`, `toast.error(t('chat.generation_errors.<code>'))`; `persistSessionMessages()`; `DONE_ACK` → SW remove.
  - **E: `activeGeneration.sessionId === activeSessionId` AND `status = cancelled`**: cancel zaten panel açıkken tetiklenmiş olmalı (Stop / New Chat / session switch yalnız panel açık iken tetiklenir), dolayısıyla bu terminal kayıt nadiren storage'da kalır. Eğer öyle sıkışmışsa: assistant message `status:'cancelled', content=activeGeneration.content`, `persistSessionMessages()`, `DONE_ACK` → SW remove.
- **Edge case**: `GET_STATE` SW'ye ulaşamaz (SW evicted tekrar uyanma sırasında) → 2 sn timeout; başarısız olursa `repairStoredSessions` ile `interrupted` migration yapılır.

### 5.2 Interrupted migration (açılış sırasında, terminal olmayan aktif üretim)
- Panel `GET_STATE` non-terminal gördü ve SW iletişim kopmuş / gerçekten terminal değilse:
  - `messages`'daki ilgili `assistantMessageId` → `status:'interrupted'`, `content=activeGeneration.content`.
  - Tek `chrome.storage.local.set({sessions})` + ardından `chrome.storage.local.remove(['activeGeneration'])`.
  - `isGenerating(false)`; pump reset.
  - `toast.error(t('chat.status.interrupted'))` = "Tarayıcı yanıt tamamlanmadan kapandı. Güvenle yeniden deneyebilirsiniz."

### 5.3 Retry düğmesi → `handleRetryMessage`
- Mevcut `handleRetryMessage` davranışı:
  - User mesajı retry → `handleSend(content, {retryUserMessage:user})` → içinde `retryUserIndex > 0` ise `baseMessages = messages.slice(0, retryUserIndex)`; aynı `id` ile user message yeniden eklenir; thinking assistant replace edilir;
  - Assistant (model) mesajı retry → önceki user mesajı bulunur → aynı akış.
- **Yeni**: birebir korunur. Fark: `handleSend` artık `streamChat` çağırmaz; `HERA_GENERATION_START` gönderir. `retryUserMessage` parametresi SW'ye `requestMessages` içinde doğru önceki konuşma base'ine oturtulur.
- **Interrupted mesajdaki retry**: `ChatMessage` zaten `message.content || message.status === 'interrupted' || message.status === 'error'` koşulunda retry düğmesini gösterir; aynı `onRetry` callback. **Yeniden Dene aynı user mesajını yeni bir job ile başlatır** — eski interrupted mesaj `slice(0, retryUserIndex)` ile düşürülür.

### 5.4 Kapat-Aç döngüsünde panel kapanışı senaryoları
- **Düşünme fazında kapat → aç**: paneli kapat; SW + Offscreen üretme devam. Aç → `GET_STATE` → `status:'running'` → pump tetik; "Düşünüyor…" 500 ms sonra ilk chunk görünür.
- **Streaming sırasında kapat → aç**: snapshot `rev=K`'da `content` (K karakter). Aç → `displayedLenRef` yerel olarak `activeGeneration.content.len`'e sync; pump görünür portion'ı kademeleme işler.
- **Cevap alınmış ama animasyon bitmemişken kapat → aç**: SW `DONE` storage'da `status:'completed'`'ı yazar; panel açıldığında `GET_STATE` `completed` döner; panel yerelde `status:'streaming', content=''` ile pump başlatır, full içeriği animasyonla yazar; pump bitince `persistSessionMessages()` + `DONE_ACK` → SW `remove`.

## 6. Migration ve Backward Compatibility

- **Gemini Vision / Web research**: `streamVision`/`streamResearch` imzaları korunur. Worker bunları çağırır; `sources` event'leriyle snapshots güncellenir.
- **Mevcut API anahtarlar**: `keyManager` storage şeması korunur. SW `import { resolveKeysForRequest, updateKeyMetadata } from '../lib/keyManager.js'` ile alır (keyManager zaten self-contained chrome/localStorage fallback içerir).
- **Eski `interrupted` status yoksa**: ChatMessage değeri `done` varsayılır; mevcut kodla zaten uyumlu.
- **Eski kaydedilmiş `thinking/streaming` mesajlar**: `repairStoredSessions` **interrupted**'a çevirir (yeni kural). `cancelled_empty` düşürülür.
- **Duplicate id onarımı**: mevcut `repairMessageIds` ile devam edilir; ek kural yok.
- **Kullanıcının eski oturumları**: hiç dokunmadan açılır; yeni "interrupted" downgrade = sadece `status='thinking|streaming' AND content` koşulunda olur.
- **`apiProvider` OpenRouter**: artık kullanılmıyor (önceki release'de kaldırıldı); spec etkilenmez.
- **`chrome.storage.local` `apiKeys` legacy array**: kullanılmıyor; `geminiApiKeys` ve `tavilyApiKeys` storage anahtarları kullanılır.

## 7. Build / Vite Entegrasyonu

### 7.1 `manifest.json` (diff)
```json
{
  "permissions": ["sidePanel", "storage", "activeTab", "scripting", "contextMenus", "offscreen"],
  "web_accessible_resources": [{
    "resources": ["offscreen.html", "assets/*"],
    "matches": ["<all_urls>"]
  }]
}
```
- **Not**: `@crxjs/vite-plugin` `web_accessible_resources`'i manifest'ten okur; ancak `offscreen.html` ayrı Vite çoklu-giriş olarak manuel eklenir (crxjs beta bu durumda düzgün kurmayabilir, kontrol gerekir).
- `minimum_chrome_version: "114"` zaten mevcut commit'te — korunur.

### 7.2 `vite.config.js` (diff)
```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import { resolve } from 'node:path'
import manifest from './manifest.json'

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
      },
    },
  },
})
```
- **`offscreen.html`** ayrı HTML entry; bundle içinde `dist/offscreen.html` bulunması `Test-Path dist/offscreen.html` ile doğrulanır.
- `generation-worker.js` ESM worker olarak bundle'a kümelenecek (offscreen page `import.meta.url` ile çözer).
- crxjs beta çıktısı bazen sabit hash adlar üretir; olası çıktılar: `dist/offscreen.html`, `dist/assets/generation-worker-*.js` ve `dist/assets/offscreen-bootstrap-*.js`.

### 7.3 `scripts/package-extension.ps1` (diff)
- Mevcut `requiredFiles` array'ine ekle: `Join-Path $distDir 'offscreen.html'`.
- Build doğrulama: `dist/offscreen.html` ve `dist/assets/` klasöründe `generation-worker-*` bundle dosyasının bulunması (yalnız `offscreen.html` varsa yeterli sayılmaz).

## 8. Test Stratejisi (TestSprite UI Verification + Vitest)

### 8.1 Genel yaklaşım (onaylı: "Mock köprüye uydur")
- `vitest.setup.js` genişletme: `chrome.runtime.sendMessage` mock, `chrome.offscreen` mock (`hasDocument`, `createDocument`, `closeDocument`), listener captures ile async-resolved promise'lar; `chrome.runtime.lastError` unset varsayılan.
- `App.test.jsx` mevcut ≈51 `it/test` davranışları korunur; `streamChat` mock'ları yerine `chrome.runtime.sendMessage({type:'HERA_GENERATION_START',...})` capture + helper `emitSnapshot({rev, content, sources})` ve `emitDone({status, ...})` ile SW mesajlarını simule.

### 8.2 Test senaryoları (spec'ten gelenler + mevcut → "~88 → ~90")
1. İlk kurulum → welcome + `GET_STATE` boş.
2. Kapat-aç sırasında yeni gönderim → "thinking" 500ms + ilk SNAPSHOT.
3. İki ardışık kapat-aç döngüsü → resume doğru.
4. "Düşünüyor" fazında paneli kapat → aç; yerel pump kaldığı yerden.
5. Streaming sırasında kapat → aç; yerel pump kaldığı yerden.
6. Tam cevap alınmış ama animasyon bitmemişken kapat → aç; DONE geldi → tip-pump tetiklenir.
7. Servis worker `between-uptime` testi (mock): SW `chrome.storage.local.get(['activeGeneration'])` çağrısı sonrası daha yeni bir SNAPSHOT geldiyse ignore edilir.
8. Offscreen eski revision (rev=2 < rev=5) → SW yok sayar.
9. Yinelenen SNAPSHOT (rev=5 tekrar) → SW yok sayar (revision dedup).
10. Kayıp PRESENTED: SW storage yazmadan hata verirse, panel eski rev içeriğini gösterir; sonraki SNAPSHOT (yeni rev) ile düzelir.
11. Servis worker yeniden başlaması (EventPage mock): `chrome.offscreen.hasDocument` false → createDocument.
12. Stop / New Chat / session switch → CANCEL broadcast → panel `status:'cancelled'`.
13. Hata / kota (`errorCode:'quota_exceeded'`).
14. Timeout (`errorCode:'timeout'`).
15. Tarayıcı kapanması → açılışta `interrupted` + Retry.
16. Büyük tek API parçası: 1 SNAPSHOT rev=1 with 8000 chars → typing-pump DONE bound'ında düzgün.
17. Çokparçalı mock stream 5 SNAPSHOT rev=1..5 → panel sequential typing.
18. Uzun Markdown (code block + lists) → finalize rendering'de düzgün code-fence kapanması.
19. Kaynaklar (`web` modu SNAPSHOT `sources` ile) → `chat.sources_label` panel render'ı.
20. Ekli Vision istekleri (`attachments` ile `streamVision` path) → SW → worker doğru mod.
21. `already_running` red testi: zaten aktif job iken ikinci `HERA_GENERATION_START`.

### 8.3 Test komutları (`package.json`)
```
npm run lint           # ESLint: js/recommended + react-hooks
npm run test:run       # vitest run
npm run package        # build + package-extension.ps1
```

## 9. Release Plan

1. **(onaylandı)** Mevcut `codex/fix-visible-thinking-flow` dalındaki commit edilmemiş değişiklikler **`feat: 1.3.0 hazırlık + visible-thinking flow`** commitiyle kaydedilir.
2. Offscreen worker mimarisinin ayrı commitleri: `feat: extract shared engine error-codes`, `feat: add offscreen bootstrap + generation worker`, `feat: integrate revision-snapshot protocol in service worker`, `refactor: move key-resolution to service worker`, `feat: panel resume-on-reopen + interrupted`, `test: adopt mock-bridge tests`, `build: vite offscreen entry + manifest offscreen permission`, `chore: bump package/lock/setup to 1.3.0`.
3. `npm run lint`, `npm run test:run`, `npm run package` temiz geçer.
4. **Gerçek Chrome paketlenmemiş uzantıyla panel en az iki kez kapatılıp açılmadan** (`chrome://extensions` → Load unpacked → `dist/`) yayına geçilmez.
5. `manifest.json` `version` `1.3.0` (zaten), `package.json` `version` `1.3.0` (zaten), `setup/HeraAi.iss` sürüm aynı. Lock güncel.
6. ZIP SHA-256 `scripts/package-extension.ps1` çıktısı ile doğrulanır.
7. GitHub Release `v1.3.0` tag ve release notları.

## 10. Varsayımlar ve Out-of-Scope

- Normal yan panel kapanışında (tarayıcı açık) üretim arka planda devam eder.
- Tam tarayıcı kapanışında ağ isteğinin sürmesi garanti **edilmez**; kısmi sonuç güvenle korunur.
- `offscreen` izni, köklü ve güvenilir çözüm için kabul edilmiştir.
- Aynı anda tek aktif üretim (global) korunur. **İki farklı session'da iki farklı aktif üretim yok.**
- Out of scope: IndexedDB migration PoC, multi-window daraltma, OpenRouter/OpenAI/Anthropic (kaldırılmış), Karma/Jest geçişi, gerçek fiziksel offline-storage.
- Out of scope: Vite `WebSocket` HMR yarış farkı; production build reprodüksiyon determinizması.

## 11. Açık Karar Özeti

| Karar | Seçilen |
|---|---|
| Mimari | Düz `chrome.runtime.sendMessage` + revizyon-TAM-içerik snapshot |
| Branch | Önce commit hazırlık → ayrı commitlerle inşa |
| Tests | "Mock köprüye uydur": `streamChat` mock → `chrome.runtime.sendMessage` capture + `ACTIVE_GEN_CHANGED`/`DONE` emit helper |
| Offscreen lifecycle | İş bitince `closeDocument` (spec); rapid yeniden-gönderim ucunda yaratma maliyeti görünmez |
| Concurrent gen | global single; `already_running` red |
| i18n refactor | api.js artık `data.message` taşımaz; yalnız `data.code`; panel translate |
| Storage | Tek `activeGeneration` kaydı + `sessions`; atomic initial write |
| Heartbeat | 15 sn offscreen → SW; exponential retry 1→2→5→10 |
| Interrupted trigger | Terminal-olmayan activeGeneration panel mount'ta |
| Markdown gating | Yalnız terminal `status`'da ReactMarkdown |
