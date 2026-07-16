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

function Get-SupertonicListenerPid {
    $listener = Get-NetTCPConnection -State Listen -LocalPort 7788 -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $listener) {
        return $null
    }
    return [int]$listener.OwningProcess
}

function Test-ProcessDescendant {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][int]$AncestorId
    )

    $currentId = $ProcessId
    $visited = @{}
    for ($depth = 0; $depth -lt 32; $depth += 1) {
        if ($currentId -eq $AncestorId) {
            return $true
        }
        if ($currentId -le 0 -or $visited.ContainsKey($currentId)) {
            return $false
        }
        $visited[$currentId] = $true
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $currentId" -ErrorAction SilentlyContinue
        if ($null -eq $process) {
            return $false
        }
        $currentId = [int]$process.ParentProcessId
    }
    return $false
}

if ($Check) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $BootstrapScript -Check -RuntimeRoot $RuntimeRoot -CacheRoot $CacheRoot
    exit $LASTEXITCODE
}

if ([bool]$WhatIfPreference) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $BootstrapScript -WhatIf -RuntimeRoot $RuntimeRoot -CacheRoot $CacheRoot
    exit $LASTEXITCODE
}

$bootstrapOutput = . $BootstrapScript -RuntimeRoot $RuntimeRoot -CacheRoot $CacheRoot
if (@($bootstrapOutput).Count -ne 1) {
    throw "Manual Video Studio prerequisites are not ready."
}
try {
    $bootstrapStatus = $bootstrapOutput | ConvertFrom-Json -ErrorAction Stop
} catch {
    throw "Manual Video Studio prerequisites are not ready."
}
if ($bootstrapStatus.ready -ne $true) {
    throw "Manual Video Studio prerequisites are not ready."
}
if (
    -not $env:MANUAL_STUDIO_OPENCODE_PATH -or
    -not [System.IO.Path]::IsPathRooted($env:MANUAL_STUDIO_OPENCODE_PATH) -or
    [System.IO.Path]::GetExtension($env:MANUAL_STUDIO_OPENCODE_PATH) -ine ".exe" -or
    $env:MANUAL_STUDIO_OPENCODE_VERSION -notmatch "^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$"
) {
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
$sidecarListenerPid = $null

$existingListenerPid = Get-SupertonicListenerPid
if ($null -ne $existingListenerPid) {
    throw "Supertonic port 7788 is already in use. Stop the existing listener before starting the studio."
}

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
            $healthMatches =
                $health.status -eq "ok" -and
                $health.model -eq "supertonic-3" -and
                $health.version -eq "1.3.1" -and
                [int]$health.sample_rate -eq 44100 -and
                [int]$health.voices_loaded -ge 10
        } catch {
            $healthMatches = $false
        }

        $candidateListenerPid = Get-SupertonicListenerPid
        if ($null -ne $candidateListenerPid) {
            if (-not (Test-ProcessDescendant -ProcessId $candidateListenerPid -AncestorId $sidecar.Id)) {
                throw "The Supertonic listener is not owned by the sidecar process tree."
            }
            $sidecarListenerPid = $candidateListenerPid
        }
        if ($healthMatches -and $null -ne $sidecarListenerPid) {
            $healthy = $true
            break
        }
        if (-not $healthy) {
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
    if ($sidecar) {
        $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
        $ownedProcessIds = @($sidecar.Id, $sidecarListenerPid) |
            Where-Object { $null -ne $_ } |
            Sort-Object -Unique
        foreach ($ownedPid in $ownedProcessIds) {
            try {
                & $taskkill /PID ([string]$ownedPid) /T /F 2>$null | Out-Null
            } catch {
                # A parent may already have exited after its owned tree was terminated.
            }
        }

        $shutdownDeadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
        do {
            $remainingListenerPid = Get-SupertonicListenerPid
            if ($null -eq $remainingListenerPid -or $remainingListenerPid -ne $sidecarListenerPid) {
                break
            }
            Start-Sleep -Milliseconds 200
        } while ([DateTimeOffset]::UtcNow -lt $shutdownDeadline)

        if ($null -ne $sidecarListenerPid -and (Get-SupertonicListenerPid) -eq $sidecarListenerPid) {
            throw "The owned Supertonic listener remained open after shutdown."
        }
    }
}
