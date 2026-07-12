$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $repoRoot 'dist'
$releaseDir = Join-Path $repoRoot 'release'
$zipPath = Join-Path $releaseDir 'HeraAi-extension.zip'

if (-not (Test-Path $distDir)) {
  throw "Build output not found at $distDir. Run npm run build first."
}

if (-not (Test-Path $releaseDir)) {
  New-Item -ItemType Directory -Path $releaseDir | Out-Null
}

if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

Compress-Archive -Path (Join-Path $distDir '*') -DestinationPath $zipPath -Force

Write-Host "Created $zipPath"
