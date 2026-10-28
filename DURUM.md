# HeraAi — DURUM (ortak — Desktop + Telegram okur)

**Güncelleme:** 2026-10-14 (yedek: opera yedeği + tam sayfa + model yenileme + arama kapısı)
**Versiyon:** 1.11.0 (`package.json` + `manifest.json` + `package-lock.json` + changelog senkron)
**Branch:** master (origin ile eşit)
**Son commit:** 8d021fc (release: HeraAi 1.11.0 opera fallback, full-page button, model refresh and search gate)
**Tag:** v1.11.0 (yerel + uzak eşit, release commitinde)
**Yayın:** v1.11.0 GitHub Latest, stabil; zip + sha256 ekli
**Ağaç:** temiz (DURUM.md izlenmeyen)
**Not:** lint + 1027 test (49 dosya) + build + normal paket + mağaza paketi (`-store.zip`, key yok) yeşil.
**Mağaza:** 1.10.29 incelemeden geçti, yayında; panele 1.11.0-store.zip yüklenmeli. Görünürlük Liste dışı, otomatik yayın açık.

## Sırada
- Ayrı işler: App.jsx etaplı bölünme, sohbet listesi sanallaştırma araştırması.
- Yerel v1.10.20-22 tagları uzakta yok; yayınları açılmadı (tek Latest: v1.10.25).
- Kullanıcı söyler.

## Bağımlılık (2026-10-14)
- react/react-dom 19.3.0→19.3.1, postcss 8.5.29→8.5.30 (patch); ölü @types/react, @types/react-dom çıkarıldı.
- npm audit: 17 bulgu (9 high/8 moderate, kritik yok) — hepsi dev-only veya pakete girmeyen kod (tailwind zinciri, grpc-js, argparse/sprintf-js) ya da erişilemez yol (exceljs uuid v4); işlem yok.
- Erteli: @google/genai 2.29 (akış birleştirme değişikliği, yayın öncesi risk) + majörler (vite 8, tailwind 4, i18next 26, eslint 10, vitest 5, lucide 1, crxjs 3, jsdom 30, firebase 13, globals 17, react-i18next 17).
