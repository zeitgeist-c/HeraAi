# HeraAi Windows Setup

## Türkçe

`HeraAi-Setup-<sürüm>.exe`, derlenmiş HeraAi uzantısını kullanıcı profiline
kurar. Hedef bilgisayarda Node.js veya kaynak kod gerekmez.

Chrome güvenlik kuralları nedeniyle seçilen her tarayıcıda bir kez:

1. Kurulum sonunda açılan uzantılar sayfasında **Geliştirici modu**nu etkinleştirin.
2. **Paketlenmemiş öğe yükle** düğmesine basın.
3. Kurucunun açtığı ve panoya kopyaladığı `extension` klasörünü seçin.
4. Sonrasında Masaüstü veya Başlat menüsündeki HeraAi kısayolunu kullanın.

Desteklenen tarayıcılar: Chrome, Edge, Brave, Vivaldi, Opera ve Opera GX.
Yan panel API'si olmayan tarayıcılarda HeraAi normal sekmede açılır.

### Kurucuyu yeniden oluşturma

Gereksinimler: Node.js 18+, npm ve Inno Setup 6.

```powershell
npm ci
npm run setup
```

Çıktı: `setup\HeraAi-Setup-<sürüm>.exe`

Inno Setup farklı konumdaysa `INNO_SETUP_COMPILER` değişkenini `ISCC.exe`
yoluna ayarlayın. Kontrolleri atlamak için
`setup\build-installer.ps1 -SkipChecks` kullanılabilir.

İsteğe bağlı kod imzalama için, sertifikayı depoya koymadan
`HERAAI_SIGNTOOL` ve `HERAAI_SIGN_CERT_SHA1` değişkenlerini ayarlayın.

## English

`HeraAi-Setup-<version>.exe` installs only the compiled extension. The target
computer does not need Node.js or the source code.

Complete these steps once in every selected browser:

1. Enable **Developer mode** on the extensions page opened by the installer.
2. Click **Load unpacked**.
3. Select the `extension` folder opened and copied to the clipboard.
4. Use the HeraAi Desktop or Start menu shortcut afterwards.

Supported browsers: Chrome, Edge, Brave, Vivaldi, Opera and Opera GX. HeraAi
opens in a normal tab when the side panel API is unavailable.

### Rebuild

Requirements: Node.js 18+, npm and Inno Setup 6.

```powershell
npm ci
npm run setup
```

Output: `setup\HeraAi-Setup-<version>.exe`

Set `INNO_SETUP_COMPILER` to the full `ISCC.exe` path when needed. Use
`setup\build-installer.ps1 -SkipChecks` to skip lint and tests. Optional
signing uses `HERAAI_SIGNTOOL` and `HERAAI_SIGN_CERT_SHA1`.
