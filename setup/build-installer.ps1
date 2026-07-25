[CmdletBinding()]
param([switch]$SkipChecks)

$ErrorActionPreference = 'Stop'
$setupDir = $PSScriptRoot
$projectRoot = Split-Path -Parent $setupDir
$buildDir = Join-Path $setupDir '.build'
$extensionDir = Join-Path $buildDir 'extension'
$packageJson = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
$outputPath = Join-Path $setupDir "HeraAi-Setup-$version.exe"

function Find-InnoCompiler {
    $candidates = @()
    if ($env:INNO_SETUP_COMPILER) { $candidates += $env:INNO_SETUP_COMPILER }

    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }

    if (${env:ProgramFiles(x86)}) {
        $candidates += Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
    }
    if ($env:ProgramFiles) {
        $candidates += Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'
    }
    if ($env:LOCALAPPDATA) {
        $candidates += Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
    }

    $uninstallRoots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    Get-ItemProperty $uninstallRoots -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like 'Inno Setup*' -and $_.InstallLocation } |
        ForEach-Object {
            $candidates += Join-Path $_.InstallLocation 'ISCC.exe'
        }

    return $candidates | Where-Object {
        $_ -and (Test-Path -LiteralPath $_)
    } | Select-Object -First 1
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(ValueFromRemainingArguments)][string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
    }
}

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$vite = Join-Path $projectRoot 'node_modules\.bin\vite.cmd'

try {
    if (Test-Path -LiteralPath $buildDir) {
        Remove-Item -LiteralPath $buildDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $extensionDir -Force | Out-Null

    Push-Location $projectRoot
    try {
        if (-not $SkipChecks) {
            Invoke-CheckedCommand $npm run lint
            Invoke-CheckedCommand $npm run test:run
        }
        Invoke-CheckedCommand $vite build --outDir $extensionDir
    }
    finally {
        Pop-Location
    }

    $innoCompiler = Find-InnoCompiler
    if (-not $innoCompiler) {
        throw @"
Inno Setup 6 compiler (ISCC.exe) was not found.
Install it with: winget install --id JRSoftware.InnoSetup -e
Alternatively set INNO_SETUP_COMPILER to the full ISCC.exe path.
"@
    }

    Invoke-CheckedCommand $innoCompiler "/DMyAppVersion=$version" (Join-Path $setupDir 'HeraAi.iss')
    if (-not (Test-Path -LiteralPath $outputPath)) {
        throw "Installer output was not created: $outputPath"
    }

    $signTool = $env:HERAAI_SIGNTOOL
    $certificateSha1 = $env:HERAAI_SIGN_CERT_SHA1
    if ($signTool -or $certificateSha1) {
        if (-not ($signTool -and $certificateSha1)) {
            throw 'Set both HERAAI_SIGNTOOL and HERAAI_SIGN_CERT_SHA1 to enable signing.'
        }
        Invoke-CheckedCommand $signTool sign /sha1 $certificateSha1 /fd SHA256 `
            /tr 'http://timestamp.digicert.com' /td SHA256 $outputPath
    }

    Write-Host "Created installer: $outputPath"
}
finally {
    if (Test-Path -LiteralPath $buildDir) {
        Remove-Item -LiteralPath $buildDir -Recurse -Force
    }
}
