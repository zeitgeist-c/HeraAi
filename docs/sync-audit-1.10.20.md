# HeraAi 1.10.20 eşitleme denetimi

## Amaç ve sınır

Manuel eşitlemenin yanlış başarı bildirmesini ve yerel kuyruktaki değişikliklerin kaybolmasını düzeltmek. Kurtarma kodu, cihaz bağlama ve uçtan uca şifreleme mimarisi korunmuştur. Firebase projesine dağıtım yapılmamıştır.

## Düzeltilen bulgular

- Gönderim sürerken aynı varlık yeniden kuyruğa alındığında eski gönderimin koşulsuz silme işlemi yeni kaydı da siliyordu. Kuyruk onayı artık aynı IndexedDB işleminde gönderilen kayıtla mevcut kaydı karşılaştırır; yeni kayıt korunur.
- Üç kez çözülemeyen uzak belge sessizce atlanıyor ve imleç ilerliyordu. Artık açık hata verilir, imleç ilerlemez. Geçersiz varlık sürümü de sessizce atlanmaz.
- Manuel eşitlemede kilit, duraklatma veya oturum nedeniyle atlanan işlem başarı bildiriyordu. Artık atlama nedeni kullanıcıya gösterilir.
- Yerel depolama olaylarının kuyruğa alınması eşitleme başlangıcıyla yarışıyordu. Olaylar sırayla işlenir ve eşitleme mevcut kuyruk işlerini bekler.
- Aynı milisaniyedeki yerel değişiklikler aynı sürümü alabiliyordu. Çalışan bağlamda monoton zaman ve mantıksal sayaç kullanılır.
- Firebase zaman damgası yalnız milisaniye olarak imlece yazılıyordu. Saniye ve nanosaniye korunur; eski imleçler desteklenmeye devam eder.
- Firebase indeks/yapılandırma hataları genel hataya indirgeniyordu. Ayrı hata kodları eklendi; güvenli servis hata kodu panelde gösterilir.

## Doğrulama

Gerçek Web Crypto ve fake-indexeddb ile gönderim sırasında yeni değişiklik testi, hassas imleç testi, bozuk belgenin tekrar denemelerde atlanmaması ve hata eşleme testleri eklendi/güncellendi. Tam Vitest takımı, lint ve üretim derlemesi çalıştırılır.

## Canlı doğrulanmayanlar

Kurulu uzantının gerçekten bu paket olması, canlı Firebase kuralları/indeksleri, gerçek proje kotası ve iki Chrome profili arasındaki uçtan uca eşitleme bu kaynak kodu denetiminde doğrulanmadı. Önceki sürümlerin atladığı belgeler otomatik kurtarılmış sayılmaz. Bulut verisi, cihaz sırları veya yerel veriler silinmedi.
