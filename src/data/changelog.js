// Yama notları veri dosyası. Yeni sürümde en üste { version, date, changes } ekle.
// changes: { tr: [...], en: [...] } — kısa, öz madde listesi; tr/en sayısı eşit olmalı.
import manifest from '../../manifest.json';

export const CHANGELOG = Object.freeze([
{
  version: '1.10.28',
  date: '2026-10-12',
  changes: {
    tr: [
      'Bağımlılık bakımı: Gemini istemcisi ve derleme yamaları güncellendi; emekli edilen eski eşitleme modülleri paketten çıkarıldı',
    ],
    en: [
      'Dependency maintenance: updated the Gemini client and build patches; retired legacy sync modules dropped from the package',
    ],
  },
},
{
  version: '1.10.27',
  date: '2026-10-12',
  changes: {
    tr: [
      'Ekran kırpma artık kilitlenmiyor: görüntü alınamaz veya kayıt takılırsa hata gösteriliyor, yeniden deneme açılıyor',
    ],
    en: [
      'Screen crop no longer locks up: a stalled capture or save now shows an error and frees the flow for retry',
    ],
  },
},
{
  version: '1.10.26',
  date: '2026-10-12',
  changes: {
    tr: [
      'Chrome Web Store yayınına hazırlık: mağaza paketi yerel imza anahtarı olmadan üretiliyor, kurulum boş başlıyor',
    ],
    en: [
      'Chrome Web Store readiness: the store package ships without the local signing key, installs start clean',
    ],
  },
},
{
  version: '1.10.25',
  date: '2026-10-03',
  changes: {
    tr: [
      'Dikte yeniden kararlı modele döndü; saçma tamamlama ve uydurma azaldı',
      'Uzun kayıt parça talimatı sertleşti; yarım kelime tamamlanmıyor',
    ],
    en: [
      'Dictation is back on the stable model; stray completions reduced',
      'Long-recording chunk instruction hardened; partial words are not completed',
    ],
  },
},
{
  version: '1.10.24',
  date: '2026-09-30',
  changes: {
    tr: [
      'Başlık sürümü manifest dosyasından okunuyor; geçmiş yama notları tamamlandı',
      'Kullanılmayan anahtar seçim kodu kaldırıldı; dışa aktarma/içe aktarma turu testlerle doğrulandı',
      'Belge okuma (mammoth) 1.13.0 sürümüne yükseltildi; eşitleme hata kayıtları tanı için zenginleştirildi',
    ],
    en: [
      'Header version is read from the manifest file; past release notes were backfilled',
      'Unused key-selection code removed; export/import round-trip verified by tests',
      'Document reading (mammoth) upgraded to 1.13.0; sync error logs enriched for diagnosis',
    ],
  },
},
{
  version: '1.10.23',
  date: '2026-09-29',
  changes: {
    tr: [
      'Dikte kaydı ses üretmeden biterse sessizce sönmüyor; anlaşılır bir uyarı gösteriliyor',
      'Durdurulacak kayıt yoksa arayüz kayıtta takılı kalmıyor; panel gizlenince iptal bilgisi veriliyor',
      'Yanıt uygulama içinde başlatılamazsa genel hata yerine “Yanıt uygulama içinde başlatılamadı” bildiriliyor',
      'Bulut durumu okunamazsa oturum ayrı kanaldan doğrulanıyor; giriş yapılmışken yanlış “çıkış yapıldı” gösterilmiyor',
    ],
    en: [
      'A dictation recording that ends without audio no longer dies silently; a clear warning is shown',
      'With no recording to stop the interface no longer sticks in recording state; hiding the panel reports the cancellation',
      'When a response cannot start inside the app, “The extension could not start the response” is reported instead of a generic error',
      'When cloud status is unreadable the session is verified on a separate channel; a signed-in user is no longer shown as signed out',
    ],
  },
},
{
  version: '1.10.22',
  date: '2026-09-27',
  changes: {
    tr: [
      'Açılışta son açık sohbet sürdürülüyor; kayıtlı sohbet yoksa rastgele seçim yerine yeni sohbet açılıyor',
      'Geçmişten seçim yapmadan kapatma mevcut sohbeti koruyor; yıldızlama yalnız bilgiyi değiştiriyor',
      'Temizleme varsayılanı yıldızsızları siliyor; yıldızlılar dahil tam silme onay penceresinde ayrı seçim istiyor',
      'Temizleme sonrası yeni sohbet açılıyor, geçmiş kapanıyor ve taslak ekleri temizleniyor',
    ],
    en: [
      'Startup resumes the last open chat; with no stored chat a new chat opens instead of a random pick',
      'Closing history without a selection keeps the current chat; starring only changes metadata',
      'Cleanup deletes unstarred chats by default; full deletion including starred chats needs a separate confirmation choice',
      'After cleanup a new chat opens, history closes and draft attachments are cleared',
    ],
  },
},
{
  version: '1.10.21',
  date: '2026-09-27',
  changes: {
    tr: [
      'Çalışan bir eşitleme varken gelen ikinci istek ayrı iş başlatmıyor; çalışan işin gerçek sonucunu bekliyor',
      'Önceki arka plan yaşamından kalan kilit işareti artık işlem çalışıyormuş gibi gösterilmiyor',
      'Kilit işareti başarıda ve hatada temizleniyor; hata sonrası yeniden deneme mümkün',
    ],
    en: [
      'A second request arriving while a sync is running no longer starts a separate job; it waits for the running job’s real result',
      'A lock marker left by a previous background lifetime is no longer shown as a running operation',
      'The lock marker is cleared on success and on error; retrying after a failure works',
    ],
  },
},
{
  version: '1.10.20',
  date: '2026-09-27',
  changes: {
    tr: [
      'Gönderim sürerken gelen yeni değişiklik artık kaybolmuyor; kuyruk onayı gönderilen kayıtla mevcut kaydı karşılaştırıyor',
      'Çözülemeyen uzak belge sessizce atlanmıyor; açık hata veriliyor ve imleç ilerlemiyor',
      'Manuel eşitlemede kilit, duraklatma veya oturum nedeniyle atlanan işlem artık başarı bildirilmiyor; atlama nedeni gösteriliyor',
      'Eşitleme durum paneli gerçek durumu bildiriyor; Firebase zaman damgası tam duyarlıkla saklanıyor',
    ],
    en: [
      'A change arriving mid-upload is no longer lost; queue acknowledgement now compares the sent record with the current one',
      'An unresolvable remote document is no longer skipped silently; a clear error is shown and the cursor does not advance',
      'A manual sync run skipped on lock, pause or session no longer reports success; the skip reason is shown',
      'The sync status panel reports the real state; Firebase timestamps are stored at full precision',
    ],
  },
},
{
  version: '1.10.19',
  date: '2026-09-25',
  changes: {
    tr: [
      'Eşitlemede "Senkronizasyon tamamlanamadı" hatasının gerçek nedeni giderildi: aynı API anahtarı iki cihazda farklı kimlikle kayıtlıysa eşitleme artık hata vermiyor, kayıtlar tek kimlikte birleşiyor',
      'Eşitleme kilidi tazeyken atlanan koşu artık kilidi bırakmıyor; gereksiz yeniden denemeler ve tekrarlayan hata bildirimleri azaldı',
      'Ollama "Gemma 4 31B" satırından görsel simgesi kaldırıldı — bu sağlayıcı görsel kabul etmiyor, otomatik seçim görselli sorularda artık bu modeli seçmiyor',
      'Yeni sohbet başlatırken eşzamanlı yazımların birbirini ezmesi engellendi (silinen sohbetin geri gelmesi) ve biten iş için diğer pencerede canlı akış göstergesi kalmıyor',
      'Ekran kırpma: ilk kırpıntı hazırlanırken yapılan ikinci deneme sessizce yutulmuyor (uyarı gösteriliyor) ve bozuk görüntü kırpma akışını kilitlemiyor',
      'Ayarlar kaydedilemezse artık "kaydedildi" denmiyor; model seçimi ve senkronizasyon panelindeki "Durumu yenile" hataları da sessizce kaybolmuyor',
      'Denetim düzeltmeleri: sohbet oturumu yazımı, cihaz anahtarı üretimi, web arama kaynaklarına güvenlik uyarısı ve eşitleme hata ayrıntısının saklanması',
      'Yayın paketi artık SHA-256 doğrulama dosyasıyla birlikte üretiliyor',
    ],
    en: [
      'Fixed the real cause of the "Sync could not be completed" error: when the same API key is stored under two different identities on two devices, sync now converges instead of failing',
      'A sync run that skips on a fresh lease no longer releases that lease, cutting pointless retries and repeated error notices',
      'Removed the image icon from the Ollama "Gemma 4 31B" row — that provider takes text only, so automatic selection no longer picks it for image questions',
      'Concurrent writes while starting a new chat can no longer overwrite each other (a deleted chat reappearing), and a finished job no longer leaves a live stream indicator in another window',
      'Screen capture: a second attempt while the first crop is still being prepared now warns instead of being swallowed, and a broken image no longer stalls the crop flow',
      'When settings cannot be saved you get an error instead of a false "saved"; model-selection and sync panel "Refresh status" failures are no longer silent',
      'Audit fixes: session write handling, device key creation, a safety notice on web search sources, and sync error detail persistence',
      'The release package now ships with its SHA-256 checksum file',
    ],
  },
},
{
  version: '1.10.18',
  date: '2026-09-25',
  changes: {
    tr: [
      'Sesli okuma (cevabı dinleme) özelliği tamamen kaldırıldı; dikte (konuşmayı yazıya çevirme) korundu',
      'Dikte model zinciri yenilendi: Gemini 3.5 Flash Lite ana, 3.1 Flash Lite yedek, 3.6 Flash son çare',
      'Uzun dikte kayıtları 30 saniyelik parçalara bölünerek çevriliyor; 200 saniyelik kayıt sınırı korundu ve sayaç gerçek saniyeyi gösteriyor',
      'Diktede kaydın son sözcüklerinin kesilmesi giderildi; bir parça çevrilemezse elde edilen metin kaybolmuyor',
      'Mikrofon izni penceresi yanıt vermezse dikte artık kilitlenmiyor, doğrudan kayıt denemesi yapılıyor',
      'Temizlikten sonra yıldızlı sohbet açılmıyor, yeni sohbet başlıyor; yıldızlı sohbetler listede kalıyor',
      'Denetim düzeltmeleri: sağlayıcı ek dosya kapıları, bulut eşitleme karantinası ve deneme sınırları, özel ağ adresi filtresi, Tavily ağ hatası sınıflaması, depolama yazma hatası bildirimi',
    ],
    en: [
      'Removed the read-aloud feature entirely; dictation (speech to text) is kept',
      'Renewed the dictation model chain: Gemini 3.5 Flash Lite primary, 3.1 Flash Lite fallback, 3.6 Flash last resort',
      'Long dictation recordings are transcribed in 30 second chunks; the 200 second recording limit stays and the counter shows real seconds',
      'Fixed dictation cutting off the last words of a recording; when one chunk fails the captured text is no longer lost',
      'Dictation no longer hangs when the microphone permission window never answers; it falls back to a direct recording attempt',
      'Clearing unstarred chats now opens a fresh chat instead of a starred one; starred chats stay in the list',
      'Audit fixes: provider attachment gates, cloud sync quarantine and retry limits, private network URL filtering, Tavily network classification, storage write failure notice',
    ],
  },
},
{
  version: '1.10.17',
  date: '2026-09-24',
  changes: {
    tr: [
      'Modelleri karşılaştırma özelliği tamamen kaldırıldı (düğme, panel ve kazanan seçme akışı)',
      'Model listesinde amaç etiketleri kaldırıldı; satırlarda yalnızca model adı ve görüntü simgesi kaldı, uzun adlar artık kesilmiyor',
      'Varsayılan sistem komutu yenilendi; kendi talimatını yazmamış kurulumlara otomatik uygulanır',
      'Kullanılmayan DuckDuckGo site izni manifest’ten çıkarıldı',
    ],
    en: [
      'Removed the model comparison feature entirely (button, panel and winner selection flow)',
      'Removed purpose labels from the model list; rows now show only the model name and the image icon, and long names are no longer truncated',
      'Refreshed the default system prompt; it applies automatically to installs without a custom instruction',
      'Dropped the unused DuckDuckGo host permission from the manifest',
    ],
  },
},
  {
    version: '1.10.16',
    date: '2026-09-24',
    changes: {
      tr: [
        'Web\'de araştır butonu kaldırıldı; araştırma artık her mesajda hazır ve gerektiğinde kendiliğinden çalışıyor',
        'Güncel bilgi isteyen sorularda (bugün, güncel fiyat, hava durumu, haber, "internette araştır") cevap Tavily kaynakları ve kaynak listesiyle geliyor',
        'Selamlama, çeviri, kod ve dosya sorularında gereksiz internet araması yapılmıyor',
        'Arama motoru olarak yalnızca Tavily kullanılıyor; zayıf sonuç veren DuckDuckGo kaldırıldı',
        'Tavily kotası bittiğinde veya anahtar hatalı olduğunda hata yerine normal cevap üretiliyor',
        'Yapıştırılan sayfa bağlantıları eskisi gibi okunup özetleniyor',
        'OpenRouter modeli yanıt vermezse sıradaki katalog modeline geçiliyor; katalogda olmayan model adı artık görünmüyor',
      ],
      en: [
        'The "Search the web" button is gone; research is now ready on every message and runs automatically when needed',
        'Questions about current information (today, current prices, weather, news, "search the web") are answered with Tavily sources and a source list',
        'Greetings, translation, code and file questions no longer trigger a pointless web search',
        'Tavily is the only search engine; the weak DuckDuckGo path was removed',
        'When Tavily runs out of quota or the key fails, the answer is produced normally instead of showing an error',
        'Pasted page links are still read and summarized as before',
        'When an OpenRouter model stops responding, the next catalog model takes over; ids that are not in the catalog no longer appear',
      ],
    },
  },
  {
    version: '1.10.15',
    date: '2026-09-24',
    changes: {
      tr: [
        'Google hesabına giriş ve uzun süren bulut işlemleri sırasında arka plan servisi uyanık tutuluyor; "İşlem tamamlanamadı: The message port closed..." hatası giderildi',
        'Bağlantı yine koparsa işlem ham İngilizce hata metni yerine anlaşılır Türkçe açıklamayla bildiriliyor',
        'Giriş gerçekten tamamlandıysa panel bunu doğrulayıp başarılı sayıyor; yarıda kalan girişte yeniden denemeniz isteniyor',
        '"Şimdi eşitle" işlemi bağlantı kopmasına rağmen tamamlandıysa otomatik başarılı sayılıyor',
        'Yeni uyanan arka plan servisi oturumun geri yüklenmesini bekliyor; giriş yapılmışken "giriş yok" görünmesi giderildi',
        'Şifreli alan kurulumunda kurtarma kodu gösterilemezse uyarı veriliyor ve kurtarma kodu bölümünden yeni kod oluşturmanız isteniyor',
        'Bozuk veya yanlış yedek dosyasında teknik ayrıştırma hatası yerine anlaşılır uyarı gösteriliyor; eksik hata nedenleri (şifreli alan zaten var, cihaz bağlı değil) artık açıkça yazılıyor',
      ],
      en: [
        'The background service is kept awake during Google sign-in and long cloud operations; the "message port closed" failure is fixed',
        'If the connection drops anyway, the operation now shows a clear explanation instead of a raw technical error',
        'A sign-in that actually completed is verified and reported as successful; an interrupted one asks you to try again',
        '"Sync now" is reported as successful when the sync finished on the server despite the dropped connection',
        'A freshly woken background service waits for the session to be restored, so a signed-in account no longer looks signed out',
        'If the recovery code cannot be shown during the first setup, you are warned and asked to create a new code from the recovery section',
        'A corrupt or wrong backup file now shows a clear warning instead of a parser error, and missing causes (space already exists, device not linked) are spelled out',
      ],
    },
  },
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

// Başlıkta gösterilen sürüm tek kaynaktan gelir: manifest.json (release akışında
// package.json ile eşitlenir). CHANGELOG yalnızca yama notu listesidir; bir sürümde
// girdi atlanırsa bile başlık eski sürümü göstermez.
export const LATEST_VERSION = manifest.version ?? CHANGELOG[0]?.version ?? null
