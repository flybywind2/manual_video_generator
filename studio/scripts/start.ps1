[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Low")]
param(
    [switch]$Check,
    [ValidateRange(1, 65535)][int]$Port = 4317
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$StudioRoot = Split-Path -Parent $PSScriptRoot
$BootstrapScript = Join-Path $PSScriptRoot "bootstrap.ps1"
$SupertonicScript = Join-Path $PSScriptRoot "supertonic.ps1"
$RuntimeRoot = Join-Path $StudioRoot ".runtime\supertonic"
$CacheRoot = Join-Path $StudioRoot "data\cache\supertonic-3"
$SupertonicExecutable = Join-Path $RuntimeRoot "venv\Scripts\supertonic.exe"

if ($Check) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $BootstrapScript -Check -RuntimeRoot $RuntimeRoot -CacheRoot $CacheRoot
    exit $LASTEXITCODE
}

if ([bool]$WhatIfPreference) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $BootstrapScript -WhatIf -RuntimeRoot $RuntimeRoot -CacheRoot $CacheRoot
    exit $LASTEXITCODE
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $BootstrapScript -RuntimeRoot $RuntimeRoot -CacheRoot $CacheRoot
if ($LASTEXITCODE -ne 0) {
    throw "Manual Video Studio prerequisites are not ready."
}
if (
    -not (Test-Path -LiteralPath $SupertonicScript -PathType Leaf) -or
    -not (Test-Path -LiteralPath $SupertonicExecutable -PathType Leaf)
) {
    throw "The pinned Supertonic sidecar executable is missing."
}

$env:MANUAL_STUDIO_PORT = [string]$Port
$env:SUPERTONIC_CACHE_DIR = $CacheRoot
$sidecar = $null

try {
    if ($PSCmdlet.ShouldProcess("127.0.0.1:7788", "Start the pinned Supertonic sidecar")) {
        $arguments = @(
            "serve",
            "--host", "127.0.0.1",
            "--port", "7788",
            "--model", "supertonic-3"
        )
        $sidecar = Start-Process -FilePath $SupertonicExecutable -ArgumentList $arguments -WindowStyle Hidden -PassThru
    }

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(90)
    $healthy = $false
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        if ($sidecar -and $sidecar.HasExited) {
            throw "The Supertonic sidecar stopped before becoming ready."
        }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:7788/v1/health" -TimeoutSec 2
            $healthy =
                $health.status -eq "ok" -and
                $health.model -eq "supertonic-3" -and
                $health.version -eq "1.3.1" -and
                [int]$health.sample_rate -eq 44100 -and
                [int]$health.voices_loaded -ge 10
            if ($healthy) {
                break
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $healthy) {
        throw "The pinned Supertonic sidecar did not become ready on loopback."
    }

    Write-Host "Manual Video Studio: http://127.0.0.1:$Port"
    if ($PSCmdlet.ShouldProcess("127.0.0.1:$Port", "Start the Node.js studio service")) {
        Push-Location $StudioRoot
        try {
            & node.exe "src\index.js"
            if ($LASTEXITCODE -ne 0) {
                throw "The Manual Video Studio service stopped unexpectedly."
            }
        } finally {
            Pop-Location
        }
    }
} finally {
    if ($sidecar -and -not $sidecar.HasExited) {
        Stop-Process -Id $sidecar.Id -Force -ErrorAction SilentlyContinue
        $sidecar.WaitForExit(5000) | Out-Null
    }
}
