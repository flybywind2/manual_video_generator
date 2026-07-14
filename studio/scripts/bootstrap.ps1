[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Low")]
param(
    [switch]$Check,
    [string]$RuntimeRoot,
    [string]$CacheRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$StudioRoot = Split-Path -Parent $PSScriptRoot
if (-not $RuntimeRoot) {
    $RuntimeRoot = Join-Path $StudioRoot ".runtime\supertonic"
}
if (-not $CacheRoot) {
    $CacheRoot = Join-Path $StudioRoot "data\cache\supertonic-3"
}

$ExpectedNodeMajor = 22
$ExpectedOpenCode = "1.4.1"
$ExpectedPython = "3.13.14"
$ExpectedSupertonic = "1.3.1"
$ExpectedPlaywrightMcp = "0.0.78" # @playwright/mcp
$ExpectedHyperFrames = "0.7.57"
$ExpectedFFmpeg = "8.1.1"
$SupertonicScript = Join-Path $PSScriptRoot "supertonic.ps1"
$ReadOnly = $Check -or [bool]$WhatIfPreference
$env:SUPERTONIC_CACHE_DIR = $CacheRoot

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$WorkingDirectory = $StudioRoot
    )

    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "A required bootstrap command failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
}

function Get-CommandPath {
    param([Parameter(Mandatory = $true)][string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) {
        return $null
    }
    return $command.Source
}

function Get-VersionOutput {
    param(
        [string]$FilePath,
        [string[]]$Arguments
    )
    if (-not $FilePath) {
        return $null
    }
    try {
        $output = & $FilePath @Arguments 2>$null
        if ($LASTEXITCODE -ne 0) {
            return $null
        }
        return ([string]($output | Select-Object -First 1)).Trim()
    } catch {
        return $null
    }
}

function Get-SemanticVersion {
    param([string]$Output)
    if (-not $Output) {
        return $null
    }
    $match = [regex]::Match($Output, "(?<!\d)(\d+\.\d+\.\d+)(?!\d)")
    if (-not $match.Success) {
        return $null
    }
    return $match.Groups[1].Value
}

function Get-NodeStatus {
    $path = Get-CommandPath "node.exe"
    $version = Get-VersionOutput -FilePath $path -Arguments @("--version")
    $match = if ($version) { [regex]::Match($version, "(\d+)\.(\d+)\.(\d+)") } else { $null }
    $ready = $null -ne $match -and $match.Success -and [int]$match.Groups[1].Value -ge $ExpectedNodeMajor
    return [pscustomobject]@{ ready = $ready; expected = ">=22"; actual = $version; path = $path }
}

function Get-InstalledPackageVersion {
    param([Parameter(Mandatory = $true)][string]$PackageName)
    $manifest = Join-Path $StudioRoot ("node_modules\" + ($PackageName -replace "/", "\") + "\package.json")
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
        return $null
    }
    try {
        return ([string]((Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json).version)).Trim()
    } catch {
        return $null
    }
}

function Get-PythonStatus {
    $candidates = @()
    $launcher = Get-CommandPath "py.exe"
    if ($launcher) {
        $candidates += [pscustomobject]@{ path = $launcher; arguments = @("-3.13") }
    }
    $python = Get-CommandPath "python3.13.exe"
    if ($python) {
        $candidates += [pscustomobject]@{ path = $python; arguments = @() }
    }
    foreach ($candidate in $candidates) {
        try {
            $output = & $candidate.path @($candidate.arguments) -c "import platform; print(platform.python_version())" 2>$null
            if ($LASTEXITCODE -eq 0 -and ([string]($output | Select-Object -Last 1)).Trim() -eq $ExpectedPython) {
                return [pscustomobject]@{ ready = $true; expected = $ExpectedPython; actual = $ExpectedPython; path = $candidate.path }
            }
        } catch {
            continue
        }
    }
    return [pscustomobject]@{ ready = $false; expected = $ExpectedPython; actual = $null; path = $null }
}

function Get-SupertonicStatus {
    if (-not (Test-Path -LiteralPath $SupertonicScript -PathType Leaf)) {
        return [pscustomobject]@{ ready = $false; expected = $ExpectedSupertonic; actual = $null; modelReady = $false }
    }
    try {
        $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $SupertonicScript -Check -RuntimeRoot $RuntimeRoot 2>$null
        $line = [string]($output | Select-Object -Last 1)
        $status = $line | ConvertFrom-Json
        $requiredModelFiles = @(
            "onnx\duration_predictor.onnx",
            "onnx\text_encoder.onnx",
            "onnx\vector_estimator.onnx",
            "onnx\vocoder.onnx",
            "voice_styles\M1.json"
        )
        $modelReady = @($requiredModelFiles | Where-Object {
            -not (Test-Path -LiteralPath (Join-Path $CacheRoot $_) -PathType Leaf)
        }).Count -eq 0
        return [pscustomobject]@{
            ready = [bool]$status.ready -and $status.python -eq $ExpectedPython -and $status.supertonic -eq $ExpectedSupertonic -and $modelReady
            expected = $ExpectedSupertonic
            actual = $status.supertonic
            modelReady = $modelReady
        }
    } catch {
        return [pscustomobject]@{ ready = $false; expected = $ExpectedSupertonic; actual = $null; modelReady = $false }
    }
}

function Install-WingetPackage {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [string]$Version
    )
    $winget = Get-CommandPath "winget.exe"
    if (-not $winget) {
        throw "winget is required to prepare a missing external runtime: $Id"
    }
    $arguments = @("install", "--id", $Id, "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements")
    if ($Version) {
        $arguments += @("--version", $Version)
    }
    if ($PSCmdlet.ShouldProcess($Id, "Install required runtime")) {
        Invoke-Checked -FilePath $winget -Arguments $arguments
    }
}

function Prepare-Runtime {
    $node = Get-NodeStatus
    if (-not $node.ready) {
        Install-WingetPackage -Id "OpenJS.NodeJS.LTS"
        $node = Get-NodeStatus
        if (-not $node.ready) {
            throw "Node.js 22 or newer is required. Reopen the terminal after installation and run start.ps1 again."
        }
    }

    $npm = Get-CommandPath "npm.cmd"
    if (-not $npm) {
        throw "npm is required with Node.js 22 or newer."
    }
    if (
        (Get-InstalledPackageVersion "@playwright/mcp") -ne $ExpectedPlaywrightMcp -or
        (Get-InstalledPackageVersion "hyperframes") -ne $ExpectedHyperFrames
    ) {
        if ($PSCmdlet.ShouldProcess($StudioRoot, "Install pinned Node dependencies with npm ci")) {
            Invoke-Checked -FilePath $npm -Arguments @("ci")
        }
    }

    $opencodePath = Get-CommandPath "opencode.exe"
    $opencodeOutput = Get-VersionOutput -FilePath $opencodePath -Arguments @("--version")
    $opencodeVersion = Get-SemanticVersion -Output $opencodeOutput
    if ($opencodeVersion -ne $ExpectedOpenCode) {
        if ($PSCmdlet.ShouldProcess("opencode-ai", "Install OpenCode CLI")) {
            Invoke-Checked -FilePath $npm -Arguments @("install", "--global", "opencode-ai@1.4.1")
        }
        $opencodePath = Get-CommandPath "opencode.exe"
        $opencodeOutput = Get-VersionOutput -FilePath $opencodePath -Arguments @("--version")
        $opencodeVersion = Get-SemanticVersion -Output $opencodeOutput
        if ($opencodeVersion -ne $ExpectedOpenCode) {
            throw "OpenCode 1.4.1 is required. Reopen the terminal and run start.ps1 again."
        }
    }

    $python = Get-PythonStatus
    if (-not $python.ready) {
        Install-WingetPackage -Id "Python.Python.3.13" -Version $ExpectedPython
        $python = Get-PythonStatus
        if (-not $python.ready) {
            throw "Python 3.13.14 is required. Reopen the terminal after installation and run start.ps1 again."
        }
    }

    $ffmpegPath = Get-CommandPath "ffmpeg.exe"
    $ffmpegOutput = Get-VersionOutput -FilePath $ffmpegPath -Arguments @("-version")
    $ffmpegVersion = Get-SemanticVersion -Output $ffmpegOutput
    if ($ffmpegVersion -ne $ExpectedFFmpeg) {
        Install-WingetPackage -Id "Gyan.FFmpeg" -Version $ExpectedFFmpeg
        $ffmpegPath = Get-CommandPath "ffmpeg.exe"
    }
    $ffprobePath = Get-CommandPath "ffprobe.exe"
    $ffmpegOutput = Get-VersionOutput -FilePath $ffmpegPath -Arguments @("-version")
    $ffprobeOutput = Get-VersionOutput -FilePath $ffprobePath -Arguments @("-version")
    $ffmpegVersion = Get-SemanticVersion -Output $ffmpegOutput
    $ffprobeVersion = Get-SemanticVersion -Output $ffprobeOutput
    if ($ffmpegVersion -ne $ExpectedFFmpeg -or $ffprobeVersion -ne $ExpectedFFmpeg) {
        throw "FFmpeg and FFprobe 8.1.1 are required. Reopen the terminal and run start.ps1 again."
    }

    if ($PSCmdlet.ShouldProcess($RuntimeRoot, "Prepare Supertonic 1.3.1 and download supertonic-3")) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $SupertonicScript -Ensure -Download -RuntimeRoot $RuntimeRoot
        if ($LASTEXITCODE -ne 0) {
            throw "The pinned Supertonic runtime could not be prepared."
        }
    }
}

if (-not $ReadOnly) {
    Prepare-Runtime
}

$node = Get-NodeStatus
$python = Get-PythonStatus
$supertonic = Get-SupertonicStatus
$opencodePath = Get-CommandPath "opencode.exe"
$ffmpegPath = Get-CommandPath "ffmpeg.exe"
$ffprobePath = Get-CommandPath "ffprobe.exe"
$opencodeOutput = Get-VersionOutput -FilePath $opencodePath -Arguments @("--version")
$ffmpegOutput = Get-VersionOutput -FilePath $ffmpegPath -Arguments @("-version")
$ffprobeOutput = Get-VersionOutput -FilePath $ffprobePath -Arguments @("-version")
$opencodeVersion = Get-SemanticVersion -Output $opencodeOutput
$ffmpegVersion = Get-SemanticVersion -Output $ffmpegOutput
$ffprobeVersion = Get-SemanticVersion -Output $ffprobeOutput
$playwrightVersion = Get-InstalledPackageVersion "@playwright/mcp"
$hyperframesVersion = Get-InstalledPackageVersion "hyperframes"

$checks = [ordered]@{
    node = [ordered]@{ ready = $node.ready; expected = ">=22"; actual = $node.actual }
    opencode = [ordered]@{ ready = $opencodeVersion -eq $ExpectedOpenCode; expected = $ExpectedOpenCode; actual = $opencodeVersion }
    python = [ordered]@{ ready = $python.ready; expected = $ExpectedPython; actual = $python.actual }
    supertonic = [ordered]@{ ready = $supertonic.ready; expected = $ExpectedSupertonic; actual = $supertonic.actual; modelReady = $supertonic.modelReady }
    playwrightMcp = [ordered]@{ ready = $playwrightVersion -eq $ExpectedPlaywrightMcp; expected = $ExpectedPlaywrightMcp; actual = $playwrightVersion }
    hyperframes = [ordered]@{ ready = $hyperframesVersion -eq $ExpectedHyperFrames; expected = $ExpectedHyperFrames; actual = $hyperframesVersion }
    ffmpeg = [ordered]@{ ready = $ffmpegVersion -eq $ExpectedFFmpeg; expected = $ExpectedFFmpeg; actual = $ffmpegVersion }
    ffprobe = [ordered]@{ ready = $ffprobeVersion -eq $ExpectedFFmpeg; expected = $ExpectedFFmpeg; actual = $ffprobeVersion }
}
$ready = @($checks.Values | Where-Object { -not $_.ready }).Count -eq 0
[ordered]@{
    ready = $ready
    mode = if ($ReadOnly) { "check" } else { "prepare" }
    cache = "data/cache/supertonic-3"
    runtime = ".runtime/supertonic"
    checks = $checks
} | ConvertTo-Json -Depth 5

if (-not $ready) {
    exit 1
}
