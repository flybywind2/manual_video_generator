param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$Dist = "",
    [switch]$SkipDownloads
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path $Root).Path
Set-Location $Root
if (-not $Dist) {
    $Dist = Join-Path $Root "dist\manual-video-agent-bundle"
}

$Runtime = Join-Path $Dist "runtime"
$Wheels = Join-Path $Runtime "wheels"
$Browsers = Join-Path $Runtime "browsers"
$NpmCache = Join-Path $Runtime "npm-cache"
$HfCache = Join-Path $Runtime "hf-cache"

New-Item -ItemType Directory -Force -Path $Dist, $Runtime, $Wheels, $Browsers, $NpmCache, $HfCache | Out-Null

function Get-Sha256 {
    param([string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $hash = $sha.ComputeHash($stream)
            return (($hash | ForEach-Object { $_.ToString("x2") }) -join "")
        } finally {
            $sha.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

Write-Host "Copying source files"
$exclude = @(".git", ".pytest_cache", ".pytest_tmp", ".playwright-mcp", "output", "dist", "runtime")
Get-ChildItem -Force $Root | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
    $target = Join-Path $Dist $_.Name
    if ($_.PSIsContainer) {
        Copy-Item -Recurse -Force $_.FullName $target
    } else {
        Copy-Item -Force $_.FullName $target
    }
}

if (-not $SkipDownloads) {
    Write-Host "Downloading Python wheels"
    python -m pip download -d $Wheels fastapi "uvicorn[standard]" pydantic pillow playwright httpx pytest

    Write-Host "Installing Playwright Chromium into bundle browsers"
    $env:PLAYWRIGHT_BROWSERS_PATH = $Browsers
    python -m playwright install chromium

    Write-Host "Priming npm cache for Playwright MCP"
    $env:NPM_CONFIG_CACHE = $NpmCache
    npx --yes @playwright/mcp@latest --help | Out-Null
} else {
    Write-Host "SkipDownloads enabled; bundle skeleton only."
}

$versions = [ordered]@{
    created_at = (Get-Date).ToString("s")
    root = $Root
    python = (python --version 2>&1 | Select-Object -First 1)
    node = if (Get-Command node -ErrorAction SilentlyContinue) { (node --version 2>&1 | Select-Object -First 1) } else { "missing" }
    npm = if (Get-Command npm -ErrorAction SilentlyContinue) { (npm --version 2>&1 | Select-Object -First 1) } else { "missing" }
    playwright_browsers_path = $Browsers
    files = @()
}

$versions.files = Get-ChildItem -Path $Dist -Recurse -File | Where-Object { $_.FullName -notlike "*\versions.json" } | ForEach-Object {
    [ordered]@{
        path = $_.FullName.Substring($Dist.Length + 1)
        sha256 = Get-Sha256 $_.FullName
        size = $_.Length
    }
}
$versions | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $Dist "versions.json")

$zipPath = "$Dist.zip"
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
Compress-Archive -Path (Join-Path $Dist "*") -DestinationPath $zipPath -Force
Write-Host "Bundle created: $zipPath"
