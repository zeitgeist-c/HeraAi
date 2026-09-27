# Sohbet gezinme standardı — uygulama planı

1. Açılış: varsayılan son açık yerel sohbeti sürdür. Kayıtlı kimlik bulunmazsa listeden rastgele/ilk sohbet seçmek yerine yeni sohbet oluştur. Kullanıcının açıkça seçtiği her açılışta yeni sohbet ayarını koru.
2. Geçmiş: seçim yapılmadan kapatma mevcut sohbeti korur; seçim yapılınca seçilen sohbet açılır. Yıldızlama yalnız metadata değiştirir. Bulut içeriği açık sohbet seçimini değiştirmez.
3. Yeni sohbet: eski sohbetler korunur. Mesajsız taslaklar temizlenebilir ancak yıldızlı taslaklar korunur.
4. Temizleme: varsayılan işlem yıldızsızları siler. Yıldızlılar dahil tümünü silme, onay penceresinde ayrı açık seçim ve farklı onay metni gerektirir. Arama filtresi silme kapsamını değiştirmez.
5. Başarılı temizleme: her durumda yeni sohbet oluştur, geçmişi kapat, taslak eklerini temizle. Korunan yıldızlı sohbetin yanıt üretimi varsa arka planda kalabilir; silinecek üretim güvenle durdurulmadan silme yapılmaz.
6. Hata/iptal: mevcut sohbet, ekran ve veriler korunur. Aktif seçim yerel kalır; buluta gönderilmez.
7. Doğrulama: açılış, silinmiş kimlik, geçmişten dönüş, yıldızlı koruma/tam silme, aktif üretim ve yazma hatası testleri; lint, Vitest ve üretim derlemesi. Sürüm paketi yerel commit ve etiketle teslim edilir; canlı dağıtım yapılmaz.
