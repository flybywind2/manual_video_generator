param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$Dist = "",
    [switch]$SkipDownloads
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path $Root).Path
Set-Location $Root
$pythonRuntime = . (Join-Path $PSScriptRoot "python_runtime.ps1") -Strict
if (-not $Dist) {
    $Dist = Join-Path $Root "dist\manual-video-agent-bundle"
}

$Runtime = Join-Path $Dist "runtime"
$Wheels = Join-Path $Runtime "wheels"
$Browsers = Join-Path $Runtime "browsers"
$NpmCache = Join-Path $Runtime "npm-cache"
$HfCache = Join-Path $Runtime "hf-cache"

New-Item -ItemType Directory -Force -Path $Dist, $Runtime, $Wheels, $Browsers, $NpmCache, $HfCache | Out-Null

function Test-IsInsidePath {
    param(
        [string]$Path,
        [string]$Parent
    )
    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $fullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    return $fullPath.Equals($fullParent, [System.StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullParent + [System.IO.Path]::AltDirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-ExcludedSource {
    param([System.IO.FileSystemInfo]$Item)
    $excludedNames = @(".git", ".pytest_cache", "output", "dist", "runtime", "__pycache__")
    $excludedPatterns = @(".pytest_tmp*")
    if ($excludedNames -contains $Item.Name) {
        return $true
    }
    foreach ($pattern in $excludedPatterns) {
        if ($Item.Name -like $pattern) {
            return $true
        }
    }
    if (Test-IsInsidePath -Path $Dist -Parent $Item.FullName) {
        return $true
    }
    return $false
}

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
Get-ChildItem -Force $Root | Where-Object { -not (Test-ExcludedSource $_) } | ForEach-Object {
    $target = Join-Path $Dist $_.Name
    if ($_.PSIsContainer) {
        Copy-Item -Recurse -Force $_.FullName $target
    } else {
        Copy-Item -Force $_.FullName $target
    }
}

if (-not $SkipDownloads) {
    Write-Host "Downloading Python wheels"
    $wheelArguments = [object[]]@($pythonRuntime.arguments) + @(
        "-m", "pip", "download", "-d", $Wheels,
        "fastapi", "uvicorn[standard]", "pydantic", "pillow", "playwright", "httpx", "pytest"
    )
    & ([string]$pythonRuntime.executable) @wheelArguments

    Write-Host "Installing Playwright Chromium into bundle browsers"
    $env:PLAYWRIGHT_BROWSERS_PATH = $Browsers
    $playwrightArguments = [object[]]@($pythonRuntime.arguments) + @("-m", "playwright", "install", "chromium")
    & ([string]$pythonRuntime.executable) @playwrightArguments

    Write-Host "Priming npm cache for Playwright MCP"
    $env:NPM_CONFIG_CACHE = $NpmCache
    npx --yes @playwright/mcp@latest --help | Out-Null
} else {
    Write-Host "SkipDownloads enabled; bundle skeleton only."
}

$versions = [ordered]@{
    created_at = (Get-Date).ToString("s")
    root = $Root
    required_python = $pythonRuntime.expected_version
    python = $pythonRuntime.actual_version
    python_executable = $pythonRuntime.executable
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
