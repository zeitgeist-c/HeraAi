# HeraAi — Özel Chrome Yan Panel asistanı

> English: [README.md](./README.md)

Chrome Yan Panel'de yaşayan özel yapay zekâ asistanı. Gemini, OpenRouter Free ve Ollama Cloud ile sohbet, Tavily ile web araştırması, ekran kırpma, dosya eki ve sesli konuşma sunar. API anahtarları cihazda şifreli IndexedDB kasasında tutulur. İsteğe bağlı Google girişi, uçtan uca şifrelenmiş verileri Firebase/Firestore üzerinden eşitler.

![HeraAi ekran görüntüleri](./docs/screenshots/)

> Ekran görüntüleri temiz kurulumdan ekleniyor (örnek veri yok). Yukarıdaki klasöre konacak.

## Sağlayıcılar ve modeller

- **Gemini** (5 model) — akan sohbet + çoklu ortam, görsel/PDF satır içi, URL Context ile herkese açık sayfa okuma.
- **OpenRouter Free** (2 model) — SSE akan sohbet + çoklu ortam.
- **Ollama Cloud** — NDJSON akışla Nemotron 3 Ultra, GPT-OSS 120B.
- **Tavily** — URL Context erişemediğinde web arama + sayfa çıkarma yedeği.
- **Anahtar seçimi** — ana API veya dengeli rotasyon; otomatik geçiş, duraklatma, bekleme ve yeniden deneme saati.

## Özellikler

- **Web Araştırma modu** — küre butonu; önce Gemini URL Context, yedekte Tavily.
- **Ekran kırpma** — `captureVisibleTab` + canvas katmanı; kırpıntılar `heraai-attachments` IndexedDB'de (`chrome://` sayfalarında çalışmaz).
- **Dosya eki** — görsel (Gemini/OpenRouter), PDF + ses yalnız Gemini, Office metin çıkarma.
- **Ses** — yalnız Gemini STT/TTS.
- **Oturumlar** — geçmiş katmanı, sohbet arama, içe/dışa aktarma.
- **Şifreli bulut eşitleme** — ayar, sohbet, istatistik, API anahtarı ve 3 MiB'a kadar ekleri tarayıcılar arasında taşır; sohbet bazında yalnız cihaz seçeneği vardır.
- **Kurtarma ve yedek** — kurtarma koduyla cihaz bağlama, cihaz erişimini kaldırma ve şifreli tam yedek alma/geri yükleme.
- **Karşılaştırma + oto-yönlendirme** — model karşılaştırma paneli ve otomatik sağlayıcı seçimi.
- **İki dil** — i18next ile TR/EN; açık/koyu/sistem teması; istatistik ve yanıt süresi.
- **Arkaplan** — service worker + offscreen üretim worker'ı + sağ-tık menüleri.

## Kurulum

```bash
npm install
npm run build
```

`dist/` Chrome'a paketlenmemiş eklenti olarak yüklenir, Yan Panel açılır, Ayarlar'dan en az bir sağlayıcı anahtarı (+ Web Araştırma için Tavily) girilir.

## Geliştirme

```bash
npm install
npm run dev      # HMR geliştirme sunucusu
npm run preview  # üretim derlemesi önizleme
npm run lint     # eslint — commit öncesi çalıştır
npm run test     # vitest + jsdom (chrome API'leri taklit)
npm run package  # release/HeraAi-<sürüm>.zip (şu an 1.10.2)
```

## Proje yapısı

```text
manifest.json        MV3 (sidePanel, storage, identity, alarms, activeTab, scripting, contextMenus, offscreen)
src/App.jsx          Yan Panel React uygulaması
src/background/      service worker
src/offscreen/       üretim worker'ı
src/components/      Settings, ModelSelector, ChatMessage, History, Comparison, Stats, ...
src/lib/             providerApi, models, keyManager, fileParsers, voiceApi, autoRouter, ...
src/locales/         en.json, tr.json
```

## Katkı

Yeni arayüz metinleri `en.json` + `tr.json` anahtarı ister; özellikler test senaryosuna bağlanır. Bkz. [.github/PULL_REQUEST_TEMPLATE.md](./.github/PULL_REQUEST_TEMPLATE.md).

## Lisans

Bkz. [LICENSE](./LICENSE) (bekliyor — teyit edilecek).
