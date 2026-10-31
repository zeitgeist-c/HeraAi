param([switch]$AllowPrivateCloud)
$ErrorActionPreference = 'Stop'

# Produces the Chrome Web Store package: strips the `key` field from the copy in
# dist and writes the zip plus sha256. The repo manifest.json is left untouched, so
# local/zip installs keep the same extension identity.
# Output: release/store/HeraAi-<version>.zip (+ .sha256)

$repoRoot = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $repoRoot 'dist'
$releaseDir = Join-Path $repoRoot 'release/store'
$manifestPath = Join-Path $distDir 'manifest.json'

if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "Build manifest not found at $manifestPath. Run npm run build first."
}

$manifestRaw = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = [string]$manifestRaw.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') {
  throw "Invalid extension version in ${manifestPath}: $version"
}

$cloudBuildPath = Join-Path $distDir 'cloud-build.json'
if (-not (Test-Path -LiteralPath $cloudBuildPath)) { throw 'Cloud build metadata missing. Rebuild before packaging.' }
$cloudBuild = Get-Content -LiteralPath $cloudBuildPath -Raw | ConvertFrom-Json
if ($cloudBuild.version -ne $version) { throw 'Cloud build version mismatch.' }
if ($cloudBuild.transport -ne 'gateway' -and -not $AllowPrivateCloud) {
  throw 'Public packaging requires the cloud gateway. For an explicitly private/unlisted package use -AllowPrivateCloud.'
}

# key is stripped only from the copy that goes to the store (new store identity + clean install).
$distManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$distManifestBackup = Get-Content -LiteralPath $manifestPath -Raw
if ($distManifest.PSObject.Properties.Name -contains 'key') {
  $distManifest.PSObject.Properties.Remove('key')
  # Write UTF-8 without a BOM (Set-Content -Encoding UTF8 adds one, which we do not want in the manifest).
  $storeJson = $distManifest | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($manifestPath, $storeJson, (New-Object System.Text.UTF8Encoding $false))
  Write-Host 'Removed key field from store manifest copy.'
} else {
  Write-Host 'Store manifest copy has no key field.'
}
try {

$zipPath = Join-Path $releaseDir "HeraAi-$version.zip"

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

$sidecarPath = "$zipPath.sha256"
$sidecarLine = "$hashValue  $([System.IO.Path]::GetFileName($zipPath))`n"
[System.IO.File]::WriteAllText($sidecarPath, $sidecarLine, [System.Text.Encoding]::ASCII)
Write-Host "Created $sidecarPath"
} finally {
  # dist is left as it is: the unpacked install must keep its identity.
  [System.IO.File]::WriteAllText($manifestPath, $distManifestBackup, (New-Object System.Text.UTF8Encoding $false))
  Write-Host 'Restored dist manifest with key.'
}
