# HeraAi 1.10.21 — Yerel eşitleme kilidi

## Bulgular

Koordinatör yalnız background service worker tarafından kullanılıyor. Bu nedenle farklı tarayıcılar aynı yerel kilidi paylaşmıyor. Önceki worker yaşamından kalan syncLease değeri ise yeni worker'da beş dakika boyunca işlem çalışıyormuş gibi bildiriliyordu. Çalışan otomatik eşitleme sırasında manuel istek de reddediliyordu.

## Düzeltme

- Eşzamanlı otomatik/manuel çağrılar tek çalışan işlemin Promise'ini ve gerçek sonucunu paylaşır; ikinci bulut işi başlatılmaz.
- Yeni worker önceki worker'dan kalan işareti devralır. Depolama işareti artık canlı işlem kanıtı sayılmaz.
- Başarıda ve hatada işaret temizlenir. Temizleme sırasında başka çağrı da mevcut Promise'i bekler.
- Motorun IndexedDB kiralama ve veri kuyruğu korunur. Hiçbir kullanıcı verisi silinmez.

## Test sınırı

Aynı Promise'i bekleme, taze/eski işaretin devralınması ve hata sonrası yeniden deneme regresyon testleri vardır. Gerçek kurulu tarayıcıdaki işlemin neden uzun sürdüğü ve ekran görüntüsündeki sync_failed hatasının sunucu kök nedeni yalnız görüntülerden belirlenemez. İki profille canlı Firebase eşitlemesi doğrulanmadı.
