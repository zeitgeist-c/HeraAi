#ifndef MyAppVersion
  #define MyAppVersion "1.4.5"
#endif
#define MyAppName "HeraAi"
#define ExtensionId "pldmkijahkhpacdjflkkgipnkcgehfoj"
#define ExtensionUrl "chrome-extension://" + ExtensionId + "/index.html"

[Setup]
AppId={{5E19A466-5955-4E37-A1D0-47E51E95DB3F}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=HeraAi
DefaultDirName={localappdata}\Programs\HeraAi
DefaultGroupName=HeraAi
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=.
OutputBaseFilename=HeraAi-Setup-{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
MinVersion=10.0
InfoAfterFile=README.md
UninstallDisplayName=HeraAi
VersionInfoVersion={#MyAppVersion}
VersionInfoProductName=HeraAi
VersionInfoDescription=HeraAi multi-browser extension installer

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "turkish"; MessagesFile: "compiler:Languages\Turkish.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: ".build\extension\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\HeraAi (Google Chrome)"; Filename: "{code:GetBrowserPath|Google Chrome}"; Parameters: """{#ExtensionUrl}"""; WorkingDir: "{app}"; Check: IsBrowserSelected('Google Chrome')
Name: "{group}\HeraAi (Microsoft Edge)"; Filename: "{code:GetBrowserPath|Microsoft Edge}"; Parameters: """{#ExtensionUrl}"""; WorkingDir: "{app}"; Check: IsBrowserSelected('Microsoft Edge')
Name: "{group}\HeraAi (Brave)"; Filename: "{code:GetBrowserPath|Brave}"; Parameters: """{#ExtensionUrl}"""; WorkingDir: "{app}"; Check: IsBrowserSelected('Brave')
Name: "{group}\HeraAi (Vivaldi)"; Filename: "{code:GetBrowserPath|Vivaldi}"; Parameters: """{#ExtensionUrl}"""; WorkingDir: "{app}"; Check: IsBrowserSelected('Vivaldi')
Name: "{group}\HeraAi (Opera)"; Filename: "{code:GetBrowserPath|Opera}"; Parameters: """{#ExtensionUrl}"""; WorkingDir: "{app}"; Check: IsBrowserSelected('Opera')
Name: "{group}\HeraAi (Opera GX)"; Filename: "{code:GetBrowserPath|Opera GX}"; Parameters: """{#ExtensionUrl}"""; WorkingDir: "{app}"; Check: IsBrowserSelected('Opera GX')
Name: "{autodesktop}\HeraAi (Google Chrome)"; Filename: "{code:GetBrowserPath|Google Chrome}"; Parameters: """{#ExtensionUrl}"""; WorkingDir: "{app}"; Tasks: desktopicon; Check: IsBrowserSelected('Google Chrome')
Name: "{autodesktop}\HeraAi (Microsoft Edge)"; Filename: "{code:GetBrowserPath|Microsoft Edge}"; Parameters: """{#ExtensionUrl}"""; WorkingDir: "{app}"; Tasks: desktopicon; Check: IsBrowserSelected('Microsoft Edge')
Name: "{autodesktop}\HeraAi (Brave)"; Filename: "{code:GetBrowserPath|Brave}"; Parameters: """{#ExtensionUrl}"""; WorkingDir: "{app}"; Tasks: desktopicon; Check: IsBrowserSelected('Brave')
Name: "{autodesktop}\HeraAi (Vivaldi)"; Filename: "{code:GetBrowserPath|Vivaldi}"; Parameters: """{#ExtensionUrl}"""; WorkingDir: "{app}"; Tasks: desktopicon; Check: IsBrowserSelected('Vivaldi')
Name: "{autodesktop}\HeraAi (Opera)"; Filename: "{code:GetBrowserPath|Opera}"; Parameters: """{#ExtensionUrl}"""; WorkingDir: "{app}"; Tasks: desktopicon; Check: IsBrowserSelected('Opera')
Name: "{autodesktop}\HeraAi (Opera GX)"; Filename: "{code:GetBrowserPath|Opera GX}"; Parameters: """{#ExtensionUrl}"""; WorkingDir: "{app}"; Tasks: desktopicon; Check: IsBrowserSelected('Opera GX')

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -Command ""Set-Clipboard -Value '{app}\extension'"""; Flags: runhidden; Check: AnyBrowserSelected
Filename: "{code:GetBrowserPath|Google Chrome}"; Parameters: "chrome://extensions"; Description: "Google Chrome uzantıları aç / Open extensions"; Flags: postinstall nowait skipifsilent; Check: IsBrowserSelected('Google Chrome')
Filename: "{code:GetBrowserPath|Microsoft Edge}"; Parameters: "edge://extensions"; Description: "Microsoft Edge uzantıları aç / Open extensions"; Flags: postinstall nowait skipifsilent; Check: IsBrowserSelected('Microsoft Edge')
Filename: "{code:GetBrowserPath|Brave}"; Parameters: "brave://extensions"; Description: "Brave uzantıları aç / Open extensions"; Flags: postinstall nowait skipifsilent; Check: IsBrowserSelected('Brave')
Filename: "{code:GetBrowserPath|Vivaldi}"; Parameters: "vivaldi://extensions"; Description: "Vivaldi uzantıları aç / Open extensions"; Flags: postinstall nowait skipifsilent; Check: IsBrowserSelected('Vivaldi')
Filename: "{code:GetBrowserPath|Opera}"; Parameters: "opera://extensions"; Description: "Opera uzantıları aç / Open extensions"; Flags: postinstall nowait skipifsilent; Check: IsBrowserSelected('Opera')
Filename: "{code:GetBrowserPath|Opera GX}"; Parameters: "opera://extensions"; Description: "Opera GX uzantıları aç / Open extensions"; Flags: postinstall nowait skipifsilent; Check: IsBrowserSelected('Opera GX')
Filename: "{sys}\explorer.exe"; Parameters: """{app}\extension"""; Description: "Uzantı klasörünü aç / Open extension folder"; Flags: postinstall nowait skipifsilent; Check: AnyBrowserSelected

[Code]
var
  BrowserPage: TInputOptionWizardPage;
  BrowserNames: TStringList;
  BrowserPaths: TStringList;

function ExistingPath(const Path: String): String;
begin
  if (Path <> '') and FileExists(Path) then Result := Path else Result := '';
end;

function FirstExisting(const Path1, Path2, Path3, Path4: String): String;
begin
  Result := ExistingPath(Path1);
  if Result = '' then Result := ExistingPath(Path2);
  if Result = '' then Result := ExistingPath(Path3);
  if Result = '' then Result := ExistingPath(Path4);
end;

function FindAppPath(const FileName: String): String;
var
  Key: String;
begin
  Result := '';
  Key := 'Software\Microsoft\Windows\CurrentVersion\App Paths\' + FileName;
  if not RegQueryStringValue(HKCU, Key, '', Result) then
    if not RegQueryStringValue(HKLM64, Key, '', Result) then
      RegQueryStringValue(HKLM32, Key, '', Result);
  Result := ExistingPath(Result);
end;

procedure AddBrowser(const Name, Path: String);
var
  Index: Integer;
begin
  if Path = '' then Exit;
  Index := BrowserPage.Add(Name);
  BrowserPage.Values[Index] := True;
  BrowserNames.Add(Name);
  BrowserPaths.Add(Path);
end;

procedure DetectBrowsers;
var
  Path: String;
begin
  Path := FindAppPath('chrome.exe');
  if Path = '' then Path := FirstExisting(
    ExpandConstant('{localappdata}\Google\Chrome\Application\chrome.exe'),
    GetEnv('ProgramW6432') + '\Google\Chrome\Application\chrome.exe',
    GetEnv('ProgramFiles(x86)') + '\Google\Chrome\Application\chrome.exe', '');
  AddBrowser('Google Chrome', Path);

  Path := FindAppPath('msedge.exe');
  if Path = '' then Path := FirstExisting(
    ExpandConstant('{localappdata}\Microsoft\Edge\Application\msedge.exe'),
    GetEnv('ProgramW6432') + '\Microsoft\Edge\Application\msedge.exe',
    GetEnv('ProgramFiles(x86)') + '\Microsoft\Edge\Application\msedge.exe', '');
  AddBrowser('Microsoft Edge', Path);

  Path := FindAppPath('brave.exe');
  if Path = '' then Path := FirstExisting(
    ExpandConstant('{localappdata}\BraveSoftware\Brave-Browser\Application\brave.exe'),
    GetEnv('ProgramW6432') + '\BraveSoftware\Brave-Browser\Application\brave.exe',
    GetEnv('ProgramFiles(x86)') + '\BraveSoftware\Brave-Browser\Application\brave.exe', '');
  AddBrowser('Brave', Path);

  Path := FindAppPath('vivaldi.exe');
  if Path = '' then Path := FirstExisting(
    ExpandConstant('{localappdata}\Vivaldi\Application\vivaldi.exe'),
    GetEnv('ProgramW6432') + '\Vivaldi\Application\vivaldi.exe',
    GetEnv('ProgramFiles(x86)') + '\Vivaldi\Application\vivaldi.exe', '');
  AddBrowser('Vivaldi', Path);

  Path := FirstExisting(
    ExpandConstant('{localappdata}\Programs\Opera\launcher.exe'),
    GetEnv('ProgramW6432') + '\Opera\launcher.exe',
    GetEnv('ProgramFiles(x86)') + '\Opera\launcher.exe',
    FindAppPath('opera.exe'));
  AddBrowser('Opera', Path);

  Path := FirstExisting(
    ExpandConstant('{localappdata}\Programs\Opera GX\launcher.exe'),
    GetEnv('ProgramW6432') + '\Opera GX\launcher.exe',
    GetEnv('ProgramFiles(x86)') + '\Opera GX\launcher.exe', '');
  AddBrowser('Opera GX', Path);
end;

function BrowserIndex(const Name: String): Integer;
begin
  Result := BrowserNames.IndexOf(Name);
end;

function IsBrowserSelected(const Name: String): Boolean;
var
  Index: Integer;
begin
  Index := BrowserIndex(Name);
  Result := (Index >= 0) and BrowserPage.Values[Index];
end;

function AnyBrowserSelected: Boolean;
var
  Index: Integer;
begin
  Result := False;
  for Index := 0 to BrowserNames.Count - 1 do
    if BrowserPage.Values[Index] then begin Result := True; Exit; end;
end;

function GetBrowserPath(const Name: String): String;
var
  Index: Integer;
begin
  Result := '';
  Index := BrowserIndex(Name);
  if Index >= 0 then Result := BrowserPaths[Index];
end;

procedure InitializeWizard;
begin
  BrowserNames := TStringList.Create;
  BrowserPaths := TStringList.Create;
  BrowserPage := CreateInputOptionPage(
    wpSelectTasks,
    'Tarayıcı seçimi / Browser selection',
    'HeraAi hangi tarayıcılara eklensin?',
    'Bir veya daha fazla tarayıcı seçin. Select one or more browsers.',
    False, True);
  DetectBrowsers;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = BrowserPage.ID) and not AnyBrowserSelected then begin
    MsgBox(
      'Desteklenen bir tarayıcı bulunamadı veya seçilmedi.' + #13#10 +
      'No supported browser was found or selected.',
      mbError, MB_OK);
    Result := False;
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
    WizardForm.FinishedLabel.Caption :=
      WizardForm.FinishedLabel.Caption + #13#10#13#10 +
      'Uzantı klasörü panoya kopyalandı. Geliştirici modu > Paketlenmemiş öğe yükle adımlarını kullanın.' + #13#10 +
      'The extension folder was copied to the clipboard. Use Developer mode > Load unpacked.';
end;
