$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $repoRoot 'dist'
$releaseDir = Join-Path $repoRoot 'release'
$zipPath = Join-Path $releaseDir 'HeraAi-extension.zip'

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

if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

Compress-Archive -Path (Join-Path $distDir '*') -DestinationPath $zipPath -Force

Write-Host "Created $zipPath"
$hash = Get-FileHash -LiteralPath $zipPath -Algorithm SHA256
Write-Host "SHA-256 $($hash.Hash)"
