// Yama notları veri dosyası. Yeni sürümde en üste { version, date, changes } ekle.
// changes: { tr: [...], en: [...] } — kısa, öz madde listesi; tr/en sayısı eşit olmalı.
export const CHANGELOG = Object.freeze([
  {
    version: '1.10.14',
    date: '2026-09-24',
    changes: {
      tr: [
        'Model listesindeki hız ve kalite (Q) rozetleri kaldırıldı; yerine her modelin ne işe yaradığını anlatan kısa etiketler geldi',
        'Model sıralaması üç sağlayıcıda da hızlıdan yavaşa düzenlendi',
        'OpenRouter\'da Nemotron 3.5 Lightning yerine Gemma 4 26B geldi (hızlı, görsel destekli)',
        'Ollama\'da Nemotron 3 Ultra yerine Gemma 4 31B geldi (güçlü, görsel destekli)',
        'Yeni sohbet artık ilk mesajınızı yazana kadar geçmiş listesinde görünmüyor; boş sohbet kayıtları birikmiyor',
        'Sohbet geçmişi boşken "Sohbet geçmişi bulunamadı" yazısı gösteriliyor ve "Tümünü sil" düğmesi kapalı duruyor',
        'Kaldırılan bir model seçili kalmışsa uygulama sizi sessizce güncel modele taşıyor (örnek: Nemotron 3 Ultra → Gemma 4 31B)',
      ],
      en: [
        'Speed and quality (Q) badges in the model list were removed; each model now shows a short label describing what it is best for',
        'Model ordering is now fastest-to-slowest across all three providers',
        'OpenRouter: Nemotron 3.5 Lightning was replaced by Gemma 4 26B (fast, vision-capable)',
        'Ollama: Nemotron 3 Ultra was replaced by Gemma 4 31B (strong, vision-capable)',
        'A new chat no longer appears in history until you send the first message; empty chat records no longer pile up',
        'An empty history now shows "No chat history found" and keeps "Bulk delete" disabled',
        'If a removed model is still selected, the app quietly moves you to a current one (for example Nemotron 3 Ultra → Gemma 4 31B)',
      ],
    },
  },
  {
    version: '1.10.13',
    date: '2026-09-24',
    changes: {
      tr: [
        'Uzun sorular artık kısaltılıyor: 12 satırdan uzun mesajlar "Tümünü göster" düğmesiyle açılıyor',
        'Yazı alanı düzeltildi: tekerlekle kaydırma doğru çalışıyor, alan yazdıkça kendiliğinden büyüyor, üstteki tutamaçla ekranın %70\'ine kadar genişletilebiliyor',
        'Otomatik model seçimi kaldırıldı: her istek artık seçtiğin modelle gider, varsayılan mod Manuel',
        'Model seçicisinde görsel kabul eden modeller 📷 ile işaretlendi',
        'OpenRouter listesi yenilendi: Qwen3.8 27B, Nex-N2.5 Pro ve Nemotron 3.5 Lightning (ücretsiz)',
        'Nemotron 3 Super artık Ollama\'da: GPT-OSS 120B ile Nemotron 3 Ultra arasında',
        'Ollama başlığındaki 🚫📷 işareti kaldırıldı',
        'Çalışmayan modeller listeden çıkarıldı; bir model hata verirse konuşma görünmez hata yedeğiyle kurtarılmaya devam ediyor',
      ],
      en: [
        'Long questions now collapse: messages over 12 lines open with a "Show all" button',
        'Composer fixed: wheel scrolling works correctly, the field grows as you type, and the handle above expands it up to 70% of the screen',
        'Automatic model selection removed: every request now uses the model you picked, and the default mode is Manual',
        'Image-capable models are marked with 📷 in the model picker',
        'OpenRouter list refreshed: Qwen3.8 27B, Nex-N2.5 Pro and Nemotron 3.5 Lightning (free)',
        'Nemotron 3 Super is now on Ollama: between GPT-OSS 120B and Nemotron 3 Ultra',
        'The 🚫📷 marker was removed from the Ollama heading',
        'Non-working models were removed from the list; if a model fails, the conversation is still rescued by the invisible error fallback',
      ],
    },
  },
  {
    version: '1.10.12',
    date: '2026-09-24',
    changes: {
      tr: [
        'Otomatik eşitleme eklendi: bulut bölümünden aralık seçilir (Manuel / 1 saat / 2 saat / 6 saat) ve panel açıkken seçilen aralıkta kendiliğinden eşitlenir',
        'Bir değişiklik yaptığında sohbet ve ayarlar 1 dakika içinde kendiliğinden buluta gönderilir; düğmeye basmak gerekmez',
        'Panel kapalıyken veya bilgisayar boştayken otomatik eşitleme çalışmaz, boşuna veri harcamaz',
        'Bulut bölümünde günlük Firebase kullanımı görünüyor (okuma/yazma yüzdesi)',
        'Günlük kullanım ücretsiz sınırın yarısını geçerse otomatik eşitleme yavaşlar ve panelde uyarı çıkar',
        'Aynı anda iki eşitleme çalışması engellendi: üst üste gelen istekler tek koşuda birleşir',
        'API anahtarlarının yanında artık son kullanım saati de görünüyor, anahtar sırayla kullanımı gözle izlenebiliyor',
        'Yeni izin istenmiyor; güncelleme sorunsuz kurulur',
      ],
      en: [
        'Automatic sync added: pick an interval in the cloud section (Manual / 1 hour / 2 hours / 6 hours) and it syncs on its own while the panel is open',
        'Chats and settings are sent to the cloud within a minute of a change; no button press needed',
        'Automatic sync does not run while the panel is closed or the computer is idle, so it never wastes quota',
        "The cloud section shows today's Firebase usage (read/write percentage)",
        'If daily usage passes half of the free tier, automatic sync slows down and the panel shows a warning',
        'Two syncs can no longer run at the same time: overlapping requests collapse into one run',
        'API key rows now show the last-used time, so key rotation can be watched',
        'No new permissions are requested; the update installs cleanly',
      ],
    },
  },
  {
    version: '1.10.11',
    date: '2026-09-23',
    changes: {
      tr: [
        "Genel Ayarlar'da dil seçimi artık anında uygulanıyor: İngilizce seçince arayüz gerçekten İngilizce oluyor",
        'Bağlı cihazlar listesi katlanır oldu: başlığa tıklayınca açılıyor, kapalıyken hesabın son eşitlenme zamanı görünüyor',
        'Kendi cihazın (Bu cihaz) cihaz listesinde her zaman en üstte',
        'Cihaz satırları sadeleşti: platform ve cihaz kimliği satırları kaldırıldı, işlem düğmeleri başlıkta kaldı',
        'Ayarlar bölümlerindeki aç/kapa hatası giderildi: kartlar artık gerçekten açılıp kapanıyor',
        'Bozuk içerikli bir sohbet dosyası içe aktarıldığında panelin çökmesi engellendi',
        'Sohbet kaydedilemezse (tarayıcı depolaması dolu) artık uyarı gösteriliyor, sohbet sessizce kaybolmuyor',
        'Üst başlıkta sürüm numarası görünüyor',
      ],
      en: [
        'Language switching in Settings now applies instantly: picking English really switches the interface',
        "The linked-devices list is now collapsible: click the header to open it, and the account's last sync time shows while it is closed",
        'Your own device always sorts first in the device list',
        'Cleaner device rows: the platform and device-id lines are gone, action buttons stay in the header',
        'Fixed the expand/collapse bug in settings sections: cards now actually open and close',
        'Importing a chat file with malformed content no longer crashes the panel',
        'A failed chat save (browser storage full) now shows a warning instead of losing the chat silently',
        'The version number now appears in the top header',
      ],
    },
  },
  {
    version: '1.10.10',
    date: '2026-09-23',
    changes: {
      tr: [
        'Başka cihazdan eşitlenen yeni sohbet artık geçmiş listesinde anında görünür',
        'Kurtarma koduyla bağlanan cihaz, bağlanmadan önce oluşturduğu sohbetleri de buluta yükler',
        'API Yönetimi\'nde sağlayıcı kartları kapalı açılır; yalnızca tıkladığınız kart genişler',
        'Bağlı cihazlar akordeon oldu: kapat/aç, ad ver ve sil düğmeleri başlıkta durur, ayrıntılar tıklayınca açılır',
        'Yama notları ve tarih biçimleri artık arayüz diline göre gösterilir',
        'Genel Ayarlar\'daki dil seçimi yenilendi: TR/EN etiketli düğmeler, bayrak emojisi kaldırıldı',
      ],
      en: [
        'A chat synced from another device now appears in the history list immediately',
        'A device linked with a recovery code also uploads the chats it created before linking',
        'Provider cards in API Management start collapsed; only the card you click expands',
        'Linked devices became accordions: pause/resume, rename and revoke buttons sit in the header, details expand on click',
        'Patch notes and date formats now follow the interface language',
        'The language picker in General Settings was redesigned: TR/EN labelled buttons, flag emoji removed',
      ],
    },
  },
  {
    version: '1.10.9',
    date: '2026-09-23',
    changes: {
      tr: [
        'Erişimi kaldırılmış cihazlar artık "Bağlı cihazlar" listesinde görünmez',
        'Listede yalnızca erişimi açık cihazlar kalır; kapatma ve ad verme butonları her satırda çalışır',
      ],
      en: [
        'Devices with revoked access no longer appear in the Linked devices list',
        'Only devices with active access stay in the list; the turn-off and rename buttons work on every row',
      ],
    },
  },
  {
    version: '1.10.8',
    date: '2026-09-23',
    changes: {
      tr: [
        'Bulut sekmesindeki bağlı cihazları kapatıp açabilirsiniz; kapalı cihaz yeniden açılana kadar eşitleme yapmaz',
        'Bağlı cihazlara ad verebilirsiniz; ad diğer cihazlarda da görünür ve cihaz yeniden bağlansa bile korunur',
        'Bir cihaz başka bir cihazdan kapatıldığında o cihazın panelinde durum açıkça gösterilir; eşitle, yedek ve kurtarma kodu işlemleri kapalıyken çalışmaz',
      ],
      en: [
        'You can now turn linked devices off and on from the Cloud tab; a turned-off device stops syncing until it is turned back on',
        'You can give linked devices a name; the name shows up on other devices and survives re-linking',
        'When a device is turned off from another device, its panel shows the state clearly; sync, backup, and recovery-code actions stay disabled while it is off',
      ],
    },
  },
  {
    version: '1.10.7',
    date: '2026-09-23',
    changes: {
      tr: [
        'Google girişi Firestore durum sorgusundan ayrıldı; kota dolu olsa bile oturum başarıyla açık kalır',
        'Firebase kotası dolduğunda tekrar eden istekler engellenir, bekleyen veriler korunur ve sıfırlanma zamanı gösterilir',
      ],
      en: [
        'Google sign-in is now independent from Firestore status checks, so the session remains signed in when quota is exhausted',
        'When Firebase quota is exhausted, repeated requests are blocked, pending data is preserved, and the reset time is shown',
      ],
    },
  },
  {
    version: '1.10.6',
    date: '2026-09-22',
    changes: {
      tr: [
        'Dosya, görsel, PDF ve ekran kırpıntılarının yalnız metadatası eşitlenir; ikili içerik cihazda kalır',
        'Otomatik Firestore çağrıları kaldırıldı; eşitleme elle veya panel açılışında 15 dakikalık korumayla çalışır',
        'Firebase kota, kural, çevrimdışı, şema ve bozuk parça hataları güvenli durum kodlarıyla gösterilir',
        'Büyük sohbetler ayrı şifreli parçalarla saklanır ve eski bulut verileri kullanıcı onayıyla temizlenebilir',
      ],
      en: [
        'Only metadata for files, images, PDFs, and screen crops is synced; binary content stays on the device',
        'Automatic Firestore calls were removed; sync runs manually or on panel open with a 15-minute guard',
        'Firebase quota, rules, offline, schema, and corrupt-chunk failures now use safe status codes',
        'Large chats use separately encrypted chunks, and legacy cloud data can be cleaned with user approval',
      ],
    },
  },
  {
    version: '1.10.5',
    date: '2026-09-22',
    changes: {
      tr: [
        'API anahtarlarına ekleme sırasında isteğe bağlı ad verme ve bu adı kompakt listede gösterme desteği eklendi',
      ],
      en: [
        'Added optional names while adding API keys and displayed them in the compact key list',
      ],
    },
  },
  {
    version: '1.10.4',
    date: '2026-09-22',
    changes: {
      tr: [
        'Çok sayıda API anahtarı için kompakt, simge tabanlı ve bağımsız kaydırılabilir anahtar listesi eklendi',
      ],
      en: [
        'Added a compact, icon-based, independently scrollable key list for large API-key pools',
      ],
    },
  },
  {
    version: '1.10.3',
    date: '2026-09-22',
    changes: {
      tr: [
        'API anahtarı kullanım biçimi seçimi Genel Ayarlar bölümüne taşındı',
        'Bağlı cihazdan yeni kurtarma kodu oluşturma ve önceki kodu güvenli biçimde geçersiz kılma eklendi',
        'API ve ses ayarlarındaki dört gereksiz bilgilendirme metni kaldırıldı',
      ],
      en: [
        'Moved API-key usage mode selection to General Settings',
        'Added secure recovery-code regeneration from a linked device, invalidating the previous code',
        'Removed four unnecessary information notices from API and voice settings',
      ],
    },
  },
  {
    version: '1.10.2',
    date: '2026-09-22',
    changes: {
      tr: [
        'Chrome MV3 servis çalışanında şifreli alan oluşturmayı engelleyen XMLHttpRequest hatası giderildi',
        'Firestore iletişimi servis çalışanıyla uyumlu REST tabanlı Lite istemcisine geçirildi',
      ],
      en: [
        'Fixed the XMLHttpRequest error that blocked encrypted-space creation in the Chrome MV3 service worker',
        'Moved Firestore communication to the service-worker-compatible REST-based Lite client',
      ],
    },
  },
  {
    version: '1.10.1',
    date: '2026-09-22',
    changes: {
      tr: [
        '1.10.0 bulut modülleri gerçek uygulama akışına bağlandı: Google girişi, ilk kurulum, kurtarma kodu ve cihaz yönetimi artık Ayarlar > Bulut bölümünde çalışıyor',
        'Ayarlar, sohbetler, istatistikler ve şifreli API anahtarları Firestore üzerinden otomatik veya elle eşitleniyor',
        'Ana API ve anahtarlar arasında sırayla dolaşma seçenekleri istek seçim katmanına bağlandı; anahtarlar tek tek duraklatılabiliyor',
        '1.9.4 anahtarları şifreli kasaya güvenli taşınıyor; 1.10.0\'ın bırakabildiği açık geri dönüş kopyası temizleniyor',
        'Sohbetler bulut veya yalnız cihaz olarak seçilebiliyor; 3 MiB\'a kadar ekler şifreli parçalarla aktarılıyor',
        'Şifreli tam yedek indirme ve aynı hesap anahtarıyla geri yükleme eklendi',
      ],
      en: [
        'The 1.10.0 cloud modules are now connected to the real app flow: Google sign-in, onboarding, recovery code, and device management work under Settings > Cloud',
        'Settings, chats, statistics, and encrypted API keys now sync through Firestore automatically or on demand',
        'Primary-key and balanced-rotation modes are connected to request selection; individual keys can be paused',
        '1.9.4 keys migrate safely into the encrypted vault, and any plaintext rollback copy left by 1.10.0 is removed',
        'Chats can be cloud-synced or device-only; attachments up to 3 MiB transfer in encrypted chunks',
        'Encrypted full-backup download and restore with the same account key are now available',
      ],
    },
  },
  {
    version: '1.10.0',
    date: '2026-09-22',
    changes: {
      tr: [
        'Uçtan uca şifreli bulut eşitleme için veri modeli, kripto, kuyruk ve test altyapısı',
        'API anahtarları artık açık metin tutulmaz; şifreli kasada saklanır',
        'Kurtarma kodu ile ikinci cihaz kurulumu ve 7 günlük geri dönüş noktaları',
        'Anahtarları sırayla kullan modu ve sağlık takibi (bekleme, geçersiz, duraklatıldı)',
        '3 MiB\'a kadar ek dosyalar şifreli parçalarla eşitlenir; büyük ekler cihazda kalır',
        'Çevrimdışıyken çalışmaya devam edilir; bağlantı gelince kuyruk kendiliğinden eşitlenir',
      ],
      en: [
        'Data model, cryptography, queue, and test infrastructure for end-to-end encrypted cloud sync',
        'API keys are no longer stored in plain text; they live in an encrypted vault',
        'Second-device setup with a recovery code and 7-day restore points',
        'Balanced key rotation mode with health tracking (cooldown, invalid, paused)',
        'Attachments up to 3 MiB sync in encrypted chunks; larger ones stay on the device',
        'Works offline; the queue syncs itself once the connection returns',
      ],
    },
  },
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
