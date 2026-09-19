// Yama notları veri dosyası. Yeni sürümde en üste { version, date, changes } ekle.
// changes: { tr: [...], en: [...] } — kısa, öz madde listesi; tr/en sayısı eşit olmalı.
export const CHANGELOG = Object.freeze([
  {
    version: '1.9.4',
    date: '2026-09-19',
    changes: {
      tr: [
        'Güvenlik: yalnızca eklentinin kendi bağlamından gelen mesajlar işlenir',
        'API anahtarı artık URL sorgusunda değil, istek başlığında gönderilir',
      ],
      en: [
        'Security: only messages from the extension contexts are processed',
        'API key is now sent in the request header instead of the URL query',
      ],
    },
  },
  {
    version: '1.9.3',
    date: '2026-09-12',
    changes: {
      tr: [
        'API anahtar kartları: büyük maskeli kart ve gradyan Test düğmesi',
        'Anahtar sayaç özeti ve birleşik anahtar ekleme kartı',
      ],
      en: [
        'API key cards: large masked card and gradient Test button',
        'Key count summary and joined key entry card',
      ],
    },
  },
  {
    version: '1.9.2',
    date: '2026-09-12',
    changes: {
      tr: [
        'Yama Notları paneli ve 31 sürümlük geçmiş',
        'Model menüsü: hap grup başlığı, hız ve kalite rozetleri',
        'Karşılaştırma düello kartları ve VS madalyonu',
        'Karşılaştırmada seçim öncesi yalnız yeniden dene gizli',
        'Karşılaştırma kutularında koyu tema okunabilirliği',
        'Ses ve karşılaştırma düğmelerinin sırası değişti',
        'Grafik tarih etiketleri kısaltması',
      ],
      en: [
        'Changelog panel with 31-version history',
        'Model menu: pill group headers, speed and quality badges',
        'Comparison duel cards and VS medallion',
        'Only retry hidden before comparison pick',
        'Dark theme readability in comparison boxes',
        'Voice and comparison button order swapped',
        'Compact chart date labels',
      ],
    },
  },
  {
    version: '1.9.1',
    date: '2026-09-12',
    changes: {
      tr: [
        'Karşılaştırma kazanan seçmeden devam edebilir; iki yanıt da bağlamda kalır',
        'Kompakt yanıt çubuğu, model rozeti ve canlı süre sayacı',
        'Sesli okumada TTS yedek zinciri, sesli girişte diksiyon yedek zinciri',
        'Yeniden denemede seçilen modelin korunması düzeltmesi',
        'Görüntülenen sürenin canlı sayaçla aynı olması düzeltmesi',
        'İstatistik paneli v2: dönem sekmeleri, alan grafiği, model tablosu',
      ],
      en: [
        'Comparisons can continue without picking a winner; both answers stay in context',
        'Compact reply bar with model badge and live duration counter',
        'TTS fallback chain for read-aloud, dictation fallback chain for voice input',
        'Retry keeps the selected model fix',
        'Displayed duration now matches the live counter fix',
        'Stats panel v2: range tabs, area chart, model table',
      ],
    },
  },
  {
    version: '1.9.0',
    date: '2026-09-12',
    changes: {
      tr: [
        'İhtiyaç bazlı otomatik model seçimi (hız + kalite + kodlama puanı)',
        'İki modelli karşılaştırma modu',
        'Üretim altyapısında karşılaştırma desteği',
      ],
      en: [
        'Need-based automatic model selection (speed + quality + coding score)',
        'Two-model comparison mode',
        'Comparison support in the generation pipeline',
      ],
    },
  },
  {
    version: '1.8.3',
    date: '2026-09-09',
    changes: {
      tr: [
        'Nemotron Ultra yerine Nemotron Super',
        'Yeniden deneme satırlarında sağlayıcı rozeti',
      ],
      en: [
        'Nemotron Super replaces Nemotron Ultra',
        'Provider badge on retry lines',
      ],
    },
  },
  {
    version: '1.8.2',
    date: '2026-09-09',
    changes: {
      tr: [
        'Ücretsiz Nemotron modeli',
        'Model kataloğu düzenlemesi',
        'Dil dosyası temizliği',
      ],
      en: [
        'Free Nemotron model',
        'Model catalog rework',
        'Locale file cleanup',
      ],
    },
  },
  {
    version: '1.8.1',
    date: '2026-09-09',
    changes: {
      tr: [
        'Açılır sağlayıcılı özel model seçici',
        'Ücretsiz etiketleri',
      ],
      en: [
        'Custom model selector with collapsible providers',
        'Free labels',
      ],
    },
  },
  {
    version: '1.8.0',
    date: '2026-09-09',
    changes: {
      tr: [
        'Otomatik DuckDuckGo araması',
        'Bağımsız sağlayıcı kartları',
        'Inkling modeli ve uzak yedekler',
      ],
      en: [
        'Automatic DuckDuckGo search',
        'Independent provider cards',
        'Inkling model and remote fallbacks',
      ],
    },
  },
  {
    version: '1.7.11',
    date: '2026-09-09',
    changes: {
      tr: [
        'Uzunluğa göre bildirim süresi',
        'Özet simgesi, kopyalama metni, dar menü',
        'Ayarlar ekranı düzenlemesi',
      ],
      en: [
        'Length-based notification duration',
        'Summarize icon, copy wording, narrow menu',
        'Settings screen rework',
      ],
    },
  },
  {
    version: '1.7.10',
    date: '2026-09-09',
    changes: {
      tr: [
        'Yapıştırılan bağlantıları otomatik okuma',
        'Kısa menü etiketleri, kısayol paneli kaldırıldı',
        'Üst çubukta markdown ve kopyalama düğmeleri',
      ],
      en: [
        'Auto-read pasted URLs',
        'Short menu labels, shortcuts panel removed',
        'Header markdown and copy buttons',
      ],
    },
  },
  {
    version: '1.7.9',
    date: '2026-09-09',
    changes: {
      tr: [
        'Sohbet içi başlık araması',
        'Geçmiş içerik araması',
        'Hazır istem çipleri kaldırıldı',
      ],
      en: [
        'In-chat header search',
        'History content search',
        'Prompt chips removed',
      ],
    },
  },
  {
    version: '1.7.8',
    date: '2026-09-09',
    changes: {
      tr: [
        'Excel ekleri',
        'Düzenleyici yapıştır ve sayfa düğmeleri',
        'Markdown dışa aktarma',
        'Hazır istem çipleri',
        'Geçmiş araması',
      ],
      en: [
        'Excel attachments',
        'Composer paste and page buttons',
        'Markdown export',
        'Prompt chips',
        'History search',
      ],
    },
  },
  {
    version: '1.7.6',
    date: '2026-09-09',
    changes: {
      tr: [
        'Gemini 3.8 Flash modeli',
        'Bağlam seçimi altyapısı',
        'Sohbet yanıtı düzenlemeleri ve testleri',
      ],
      en: [
        'Gemini 3.8 Flash model',
        'Context selection infrastructure',
        'Chat reply rework and tests',
      ],
    },
  },
  {
    version: '1.7.5',
    date: '2026-08-29',
    changes: {
      tr: [
        'Ollama model sıralaması ve etiket düzeltmeleri',
        'Sohbet akışı küçük iyileştirmeleri',
      ],
      en: [
        'Ollama model ordering and label fixes',
        'Chat flow minor improvements',
      ],
    },
  },
  {
    version: '1.7.4',
    date: '2026-08-29',
    changes: {
      tr: [
        'Ollama görsel desteği etiket açıklamaları',
        'Dil metni düzeltmeleri',
      ],
      en: [
        'Ollama image support label clarifications',
        'Locale text fixes',
      ],
    },
  },
  {
    version: '1.7.3',
    date: '2026-08-29',
    changes: {
      tr: [
        'MiniMax kaldırıldı',
        'Model geçiş desteği',
        'API anahtarı test onarımları',
      ],
      en: [
        'MiniMax removed',
        'Model migration support',
        'API key test repairs',
      ],
    },
  },
  {
    version: '1.7.2',
    date: '2026-08-29',
    changes: {
      tr: [
        'Ücretsiz Ollama Cloud model seçenekleri',
        'Model kataloğu genişlemesi',
      ],
      en: [
        'Free Ollama Cloud model options',
        'Model catalog expansion',
      ],
    },
  },
  {
    version: '1.7.1',
    date: '2026-08-29',
    changes: {
      tr: [
        'Basitleşen API anahtarı yönetimi',
        'Sağlayıcı yedekleme mantığı',
        'Ayarlar ekranı yenilemesi',
      ],
      en: [
        'Simplified API key management',
        'Provider fallback logic',
        'Settings screen refresh',
      ],
    },
  },
  {
    version: '1.7.0',
    date: '2026-08-29',
    changes: {
      tr: [
        'OpenRouter Free sağlayıcısı',
        'Ollama MiniMax M3 sağlayıcısı',
        'Sağlayıcı API altyapısı',
      ],
      en: [
        'OpenRouter Free provider',
        'Ollama MiniMax M3 provider',
        'Provider API infrastructure',
      ],
    },
  },
  {
    version: '1.6.3',
    date: '2026-08-27',
    changes: {
      tr: [
        'Yanıt kartı yenilemesi',
        'İçe ve dışa aktarma onarımları',
        'Servis worker küçük düzeltmesi',
        'Kapsamlı regresyon testleri',
      ],
      en: [
        'Reply card refresh',
        'Import and export repairs',
        'Service worker minor fix',
        'Extensive regression tests',
      ],
    },
  },
  {
    version: '1.6.2',
    date: '2026-08-22',
    changes: {
      tr: [
        'Bağlantı ve sayfa içeriği okuma',
        'Ek dosya deposu ve limitleri',
        'Dosya eki doğrulama ve ayrıştırma',
        'Servis worker üretim iyileştirmeleri',
        'İçe ve dışa aktarma düzeltmeleri',
      ],
      en: [
        'Link and page content reading',
        'Attachment store and limits',
        'Attachment validation and parsing',
        'Service worker generation improvements',
        'Import and export fixes',
      ],
    },
  },
  {
    version: '1.5.3',
    date: '2026-08-20',
    changes: {
      tr: ['Geri alma sonrası kararlı yeniden yayın'],
      en: ['Stable re-release after the rollback'],
    },
  },
  {
    version: '1.5.2',
    date: '2026-08-09',
    changes: {
      tr: ['1.5.0 paketine dönüş'],
      en: ['Rollback to the 1.5.0 package'],
    },
  },
  {
    version: '1.5.1',
    date: '2026-08-09',
    changes: {
      tr: [
        'Sistem talimatı altyapısı',
        'Ayarlar ekranı sadeleşmesi',
        'Yayın sonrası geri alındı',
      ],
      en: [
        'System instruction infrastructure',
        'Settings screen simplification',
        'Reverted after release',
      ],
    },
  },
  {
    version: '1.5.0',
    date: '2026-08-09',
    changes: {
      tr: [
        'Sesli giriş düğmesi ve kayıt akışı',
        'Mikrofon izin sayfası',
        'Konuşmayı metne çevirme',
        'Ses kayıt yardımcıları',
        'Sesli giriş testleri',
      ],
      en: [
        'Voice input button and recording flow',
        'Microphone permission page',
        'Speech-to-text transcription',
        'Audio recording helpers',
        'Voice input tests',
      ],
    },
  },
  {
    version: '1.4.5',
    date: '2026-08-08',
    changes: {
      tr: [
        'Sohbet yanıtı küçük düzeltmeleri',
        'Yanıt kartı dokunuşları',
        'Regresyon testleri',
      ],
      en: [
        'Chat reply minor fixes',
        'Reply card touches',
        'Regression tests',
      ],
    },
  },
  {
    version: '1.4.4',
    date: '2026-08-08',
    changes: {
      tr: ['Kurulum paketi bakımı'],
      en: ['Installer package maintenance'],
    },
  },
  {
    version: '1.4.3',
    date: '2026-08-08',
    changes: {
      tr: [
        'Kaynak görünürlük düğmesi',
        'Ayarlar ekranı iyileştirmesi',
        'Dil metni düzeltmeleri',
      ],
      en: [
        'Source visibility toggle',
        'Settings screen improvement',
        'Locale text fixes',
      ],
    },
  },
  {
    version: '1.4.2',
    date: '2026-07-29',
    changes: {
      tr: [
        'Sohbet yönetimi: oturum listesi ve geçmiş paneli',
        'Model seçilebilir yeniden deneme akışı',
        'Kopyalama ve sesli okuma dahil mesaj eylemleri',
        'Kararlı Gemini yanıt akışı',
        'Arka planda offscreen üretim altyapısı',
        'Servis worker yenilemesi ve kurulum betikleri',
        'İçe ve dışa aktarma desteği',
        'Ekran kırpma iyileştirmeleri',
      ],
      en: [
        'Chat management: session list and history panel',
        'Model-selectable retry flow',
        'Message actions including copy and read-aloud',
        'Stable Gemini response flow',
        'Background offscreen generation infrastructure',
        'Service worker refresh and installer scripts',
        'Import and export support',
        'Screen crop improvements',
      ],
    },
  },
  {
    version: '1.2.1',
    date: '2026-07-26',
    changes: {
      tr: [
        'Yan panel yaşam döngüsü düzeltmesi',
        'Üretim akışı sağlamlaştırması',
        'Yanıt kartı düzeltmesi ve regresyon testleri',
      ],
      en: [
        'Side panel lifecycle fix',
        'Generation flow hardening',
        'Reply card fix and regression tests',
      ],
    },
  },
  {
    version: '1.2.0',
    date: '2026-07-26',
    changes: {
      tr: [
        'Model seçici bileşeni ve üst bilgi çubuğu',
        'Karşılama ekranı',
        'İstatistik paneli yenilemesi',
        'Tema ve stil yenilemesi',
        'Kısayol paneli düzenlemesi',
        'Ayarlar ekranı iyileştirmeleri',
        'Ekran kırpma düzeltmesi',
      ],
      en: [
        'Model selector component and header bar',
        'Welcome screen',
        'Stats panel refresh',
        'Theme and style refresh',
        'Shortcuts panel rework',
        'Settings screen improvements',
        'Screen crop fix',
      ],
    },
  },
  {
    version: '1.1',
    date: '2026-07-25',
    changes: {
      tr: [
        'Çok anahtarlı API yedekleme ve anahtar kasası',
        'Ayarlar ekranında anahtar yönetimi (.env kaldırıldı)',
        'Web araştırma altyapısı',
        'Dosya eki okuma altyapısı',
        'Otomatik dil algılama',
        'Geçmiş paneli ve kısayol paneli',
        'Kullanılmayan 10 dil kaldırıldı, istatistik Türkçe desteği',
      ],
      en: [
        'Multi-key API fallback and key vault',
        'Key management in Settings (.env removed)',
        'Web research infrastructure',
        'File attachment reading infrastructure',
        'Automatic language detection',
        'History panel and shortcuts panel',
        'Unused languages removed, Turkish stats support',
      ],
    },
  },
  {
    version: '1.0',
    date: '2026-03-29',
    changes: {
      tr: [
        'İlk sürüm: yan panelde Gemini destekli sohbet',
        'Türkçe ve İngilizce arayüz',
        'Ayarlar ekranı ve API anahtarı girişi',
      ],
      en: [
        'First release: Gemini chat in the side panel',
        'Turkish and English interface',
        'Settings screen and API key entry',
      ],
    },
  },
])

export const LATEST_VERSION = CHANGELOG[0]?.version ?? null
