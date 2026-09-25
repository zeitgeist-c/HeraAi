$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $repoRoot 'dist'
$releaseDir = Join-Path $repoRoot 'release'
$manifestPath = Join-Path $distDir 'manifest.json'

if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "Build manifest not found at $manifestPath. Run npm run build first."
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = [string]$manifest.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') {
  throw "Invalid extension version in ${manifestPath}: $version"
}

$zipPath = Join-Path $releaseDir "HeraAi-$version.zip"

if (-not (Test-Path $distDir)) {
  throw "Build output not found at $distDir. Run npm run build first."
}

$requiredFiles = @(
  (Join-Path $distDir 'manifest.json'),
  (Join-Path $distDir 'index.html'),
  (Join-Path $distDir 'mic-permission.html'),
  (Join-Path $distDir 'offscreen.html'),
  (Join-Path $distDir 'service-worker-loader.js')
)
foreach ($requiredFile in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $requiredFile)) {
    throw "Required extension output is missing: $requiredFile"
  }
}

$assetsDir = Join-Path $distDir 'assets'
$generationWorkerFiles = @()
if (Test-Path -LiteralPath $assetsDir) {
  $generationWorkerFiles = @(Get-ChildItem -LiteralPath $assetsDir -Filter 'generation-worker-*.js' -File -Recurse)
}
if ($generationWorkerFiles.Count -eq 0) {
  throw "Required generation worker bundle is missing from $assetsDir"
}

if (-not (Test-Path $releaseDir)) {
  New-Item -ItemType Directory -Path $releaseDir | Out-Null
}

Compress-Archive -Path (Join-Path $distDir '*') -DestinationPath $zipPath -Force

Write-Host "Created $zipPath"
$getFileHash = Get-Command Get-FileHash -ErrorAction SilentlyContinue
if ($getFileHash) {
  $hashValue = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
} else {
  $stream = [System.IO.File]::OpenRead($zipPath)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hashBytes = $sha256.ComputeHash($stream)
      $hashValue = [System.BitConverter]::ToString($hashBytes).Replace('-', '')
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}
Write-Host "SHA-256 $hashValue"

# sha256sum uyumlu yan dosya (LF satır sonu, iki boşluk ayırıcı) — denetim notu:
# 1.10.18'e kadar elle üretiliyordu, artık paketleme adımı kendisi yazıyor.
$sidecarPath = "$zipPath.sha256"
$sidecarLine = "$hashValue  $([System.IO.Path]::GetFileName($zipPath))`n"
[System.IO.File]::WriteAllText($sidecarPath, $sidecarLine, [System.Text.Encoding]::ASCII)
Write-Host "Created $sidecarPath"
