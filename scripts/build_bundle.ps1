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

function Test-IsSecretEnvironmentFile {
    param([string]$Name)
    $normalizedName = $Name.ToLowerInvariant()
    if ($normalizedName -eq ".env.example") {
        return $false
    }
    return $normalizedName -eq ".env" -or
        $normalizedName.StartsWith(".env.") -or
        $normalizedName.EndsWith(".env") -or
        $normalizedName.Contains(".env.")
}

function Assert-NoReparsePointInPath {
    param([string]$Target)
    $fullTarget = [System.IO.Path]::GetFullPath($Target)
    $pathRoot = [System.IO.Path]::GetPathRoot($fullTarget)
    $current = $pathRoot
    $relative = $fullTarget.Substring($pathRoot.Length)
    $segments = $relative.Split(
        [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar),
        [System.StringSplitOptions]::RemoveEmptyEntries
    )
    foreach ($segment in $segments) {
        $current = Join-Path $current $segment
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Unsafe bundle target: reparse point found in Dist path at $current."
            }
        }
    }
}

function Assert-SafeBuildTarget {
    param(
        [string]$Target,
        [string]$SourceRoot
    )
    $fullTarget = [System.IO.Path]::GetFullPath($Target).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $fullSource = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $pathRoot = [System.IO.Path]::GetPathRoot($fullTarget).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    if ([string]::IsNullOrWhiteSpace($fullTarget) -or $fullTarget.Equals($pathRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe bundle target: filesystem roots are not allowed."
    }
    if (Test-IsInsidePath -Path $fullSource -Parent $fullTarget) {
        throw "Unsafe bundle target: Dist must not equal or contain the source root."
    }
    Assert-NoReparsePointInPath -Target $fullTarget
    return $fullTarget
}

$ownershipMarkerName = ".manual-video-agent-bundle-owned"
$ownershipMarkerContent = "manual-video-agent-bundle:v1"

function Test-BundleOwnership {
    param([string]$Target)
    $marker = Join-Path $Target $ownershipMarkerName
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        return $false
    }
    return (Get-Content -LiteralPath $marker -Raw).Trim() -eq $ownershipMarkerContent
}

function Write-BundleOwnershipMarker {
    param([string]$Target)
    $marker = Join-Path $Target $ownershipMarkerName
    $temporaryMarker = Join-Path $Target "$ownershipMarkerName.tmp.$PID"
    try {
        [System.IO.File]::WriteAllText($temporaryMarker, $ownershipMarkerContent, [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryMarker -Destination $marker -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryMarker) {
            Remove-Item -LiteralPath $temporaryMarker -Force -ErrorAction SilentlyContinue
        }
    }
}

function Clear-OwnedBundleDirectory {
    param([string]$Target)
    if (-not (Test-BundleOwnership -Target $Target)) {
        throw "Refusing to clean bundle Dist without a valid ownership marker: $Target"
    }
    Get-ChildItem -LiteralPath $Target -Force |
        Where-Object { $_.Name -ne $ownershipMarkerName } |
        Remove-Item -Recurse -Force
    if (-not (Test-BundleOwnership -Target $Target)) {
        Write-BundleOwnershipMarker -Target $Target
    }
}

function Test-ExcludedSource {
    param([System.IO.FileSystemInfo]$Item)
    $excludedNames = @(".git", ".pytest_cache", "output", "dist", "runtime", "__pycache__")
    $excludedPatterns = @(".pytest_tmp*")
    if (-not $Item.PSIsContainer -and (Test-IsSecretEnvironmentFile $Item.Name)) {
        return $true
    }
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

$pythonRuntime = . (Join-Path $PSScriptRoot "python_runtime.ps1") -Strict
$Dist = Assert-SafeBuildTarget -Target $Dist -SourceRoot $Root
$zipPath = "$Dist.zip"

$Runtime = Join-Path $Dist "runtime"
$Wheels = Join-Path $Runtime "wheels"
$Browsers = Join-Path $Runtime "browsers"
$NpmCache = Join-Path $Runtime "npm-cache"
$HfCache = Join-Path $Runtime "hf-cache"
$buildSucceeded = $false
$ownershipProven = $false
$createdByThisRun = $false

try {
    if (Test-Path -LiteralPath $Dist) {
        if (-not (Test-Path -LiteralPath $Dist -PathType Container)) {
            throw "Bundle Dist exists but is not a directory: $Dist"
        }
        if (-not (Test-BundleOwnership -Target $Dist)) {
            throw "Refusing to clean existing bundle Dist without a valid ownership marker: $Dist"
        }
        $ownershipProven = $true
    } else {
        if (Test-Path -LiteralPath $zipPath) {
            throw "Refusing to replace bundle zip without a matching owned Dist: $zipPath"
        }
        New-Item -ItemType Directory -Path $Dist | Out-Null
        $createdByThisRun = $true
        Write-BundleOwnershipMarker -Target $Dist
        $ownershipProven = $true
    }

    Clear-OwnedBundleDirectory -Target $Dist
    if (Test-Path -LiteralPath $zipPath) {
        Remove-Item -LiteralPath $zipPath -Force
    }
    New-Item -ItemType Directory -Force -Path $Dist, $Runtime, $Wheels, $Browsers, $NpmCache, $HfCache | Out-Null

    Write-Host "Copying source files"
    Get-ChildItem -Force $Root | Where-Object { -not (Test-ExcludedSource $_) } | ForEach-Object {
        $target = Join-Path $Dist $_.Name
        if ($_.PSIsContainer) {
            Copy-Item -Recurse -Force $_.FullName $target
        } else {
            Copy-Item -Force $_.FullName $target
        }
    }

    Get-ChildItem -LiteralPath $Dist -Recurse -Force -File |
        Where-Object { Test-IsSecretEnvironmentFile $_.Name } |
        Remove-Item -Force

    if (-not $SkipDownloads) {
        Write-Host "Downloading Python wheels"
        $wheelArguments = [object[]]@($pythonRuntime.arguments) + @(
            "-m", "pip", "download", "-d", $Wheels,
            "fastapi", "uvicorn[standard]", "pydantic", "pillow", "playwright", "httpx", "pytest"
        )
        Invoke-CheckedNativeCommand -Executable ([string]$pythonRuntime.executable) -Arguments $wheelArguments -Operation "pip download"

        Write-Host "Installing Playwright Chromium into bundle browsers"
        $env:PLAYWRIGHT_BROWSERS_PATH = $Browsers
        $playwrightArguments = [object[]]@($pythonRuntime.arguments) + @("-m", "playwright", "install", "chromium")
        Invoke-CheckedNativeCommand -Executable ([string]$pythonRuntime.executable) -Arguments $playwrightArguments -Operation "Playwright install"

        Write-Host "Priming npm cache for Playwright MCP"
        $env:NPM_CONFIG_CACHE = $NpmCache
        $npxCommand = Get-Command npx -ErrorAction Stop | Select-Object -First 1
        $npxExecutable = if ($npxCommand.Source) { $npxCommand.Source } else { $npxCommand.Path }
        Invoke-CheckedNativeCommand -Executable $npxExecutable -Arguments @("--yes", "@playwright/mcp@latest", "--help") -Operation "npx Playwright MCP"
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

    Compress-Archive -Path (Join-Path $Dist "*") -DestinationPath $zipPath -Force
    $buildSucceeded = $true
    Write-Host "Bundle created: $zipPath"
} finally {
    if (-not $buildSucceeded -and $ownershipProven) {
        try {
            Clear-OwnedBundleDirectory -Target $Dist
        } catch {
            Write-Warning "Unable to clean owned bundle Dist after failure: $($_.Exception.Message)"
        }
        if (Test-Path -LiteralPath $zipPath) {
            Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
        }
    } elseif (-not $buildSucceeded -and $createdByThisRun -and (Test-Path -LiteralPath $Dist)) {
        $remaining = @(Get-ChildItem -LiteralPath $Dist -Force -ErrorAction SilentlyContinue)
        if ($remaining.Count -eq 0) {
            Remove-Item -LiteralPath $Dist -Force -ErrorAction SilentlyContinue
        }
    }
}
