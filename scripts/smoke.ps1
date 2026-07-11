param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [switch]$SkipTests,
    [switch]$LiveBrowser,
    [ValidateRange(0, 65535)]
    [int]$Port = 0
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "bootstrap.ps1") -Root $Root -Quiet
$pythonRuntime = . (Join-Path $PSScriptRoot "python_runtime.ps1") -Strict
. (Join-Path $PSScriptRoot "smoke_port.ps1")
Set-Location $Root

function Get-AvailableLoopbackPort {
    param([int]$RequestedPort)
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $RequestedPort)
    try {
        $listener.Start()
        return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    } catch {
        if ($RequestedPort -gt 0) {
            throw "Requested loopback port $RequestedPort is unavailable."
        }
        throw "Unable to allocate an available loopback port."
    } finally {
        $listener.Stop()
    }
}

Write-Host "== Doctor =="
$powershellExecutable = (Get-Process -Id $PID).Path
$doctorArguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    (Join-Path $PSScriptRoot "doctor.ps1"), "-Root", $Root
)
Invoke-CheckedNativeCommand -Executable $powershellExecutable -Arguments $doctorArguments -Operation "Doctor"

Write-Host "== Python imports =="
$importArguments = [object[]]@($pythonRuntime.arguments) + @(
    "-c", "import fastapi, pydantic, PIL, playwright; print('python runtime ok')"
)
Invoke-CheckedNativeCommand `
    -Executable ([string]$pythonRuntime.executable) `
    -Arguments $importArguments `
    -Operation "Python import check"

Write-Host "== Pipeline smoke =="
$captureBrowser = if ($LiveBrowser) { "True" } else { "False" }
$livePort = if ($LiveBrowser) { Get-AvailableLoopbackPort -RequestedPort $Port } else { 0 }
$liveBaseUrl = if ($LiveBrowser) { "http://127.0.0.1:$livePort" } else { "http://127.0.0.1" }
$smoke = @"
from pathlib import Path
from backend.app.pipeline import PipelineInput, create_pipeline_draft, continue_pipeline_draft

base = Path("output") / "smoke"
draft = create_pipeline_draft(
    PipelineInput(
        request_text="MES LOT lookup smoke",
        target_url="$liveBaseUrl/sample",
        role="operator",
        completion_condition="detail panel visible",
        input_values={"LOT": "LOT-001"},
        login_mode="none",
    ),
    base_dir=base,
    capture_browser=$captureBrowser,
)
result = continue_pipeline_draft(draft.job_id, base_dir=base, capture_browser=$captureBrowser)
print(result.artifacts.package_manifest)
"@

if ($LiveBrowser) {
    Write-Host "== Starting local app for live browser smoke =="
    $serverOut = Join-Path $env:MANUAL_AGENT_OUTPUT_DIR "smoke-server.out.log"
    $serverErr = Join-Path $env:MANUAL_AGENT_OUTPUT_DIR "smoke-server.err.log"
    $serverArguments = [object[]]@($pythonRuntime.arguments) + @(
        "-m", "uvicorn", "backend.app.main:app", "--host", "127.0.0.1", "--port", ([string]$livePort)
    )
    $server = Start-Process -FilePath ([string]$pythonRuntime.executable) -ArgumentList $serverArguments -WorkingDirectory $Root -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr -WindowStyle Hidden -PassThru
    try {
        $deadline = (Get-Date).AddSeconds(30)
        do {
            if ($server.HasExited) {
                $server.Refresh()
                throw "Live smoke app process exited before readiness with exit code $($server.ExitCode)."
            }
            $identityReady = $false
            try {
                $health = Invoke-RestMethod "$liveBaseUrl/api/health" -TimeoutSec 2
                $openApi = Invoke-RestMethod "$liveBaseUrl/openapi.json" -TimeoutSec 2
                if ($health.status -eq "ok" -and $openApi.info.title -eq "Manual Video Agent") {
                    $identityReady = $true
                }
            } catch {
                Start-Sleep -Milliseconds 500
            }
            if ($identityReady) {
                if (-not (Test-PortOwnedByProcessTree -Port $livePort -RootProcessId $server.Id)) {
                    throw "Live smoke port $livePort is owned by a process outside spawned process tree $($server.Id)."
                }
                $ready = $true
                break
            }
        } while ((Get-Date) -lt $deadline)
        if (-not $ready) {
            Get-Content -Path $serverErr -Tail 80
            throw "Local app did not become ready for live browser smoke."
        }
        if ($server.HasExited) {
            $server.Refresh()
            throw "Live smoke app process exited after readiness with exit code $($server.ExitCode)."
        }
        if (-not (Test-PortOwnedByProcessTree -Port $livePort -RootProcessId $server.Id)) {
            throw "Live smoke lost ownership of port $livePort before pipeline execution."
        }
        $stdinArguments = [object[]]@($pythonRuntime.arguments) + @("-")
        $manifest = Invoke-CheckedNativeCommand `
            -Executable ([string]$pythonRuntime.executable) `
            -Arguments $stdinArguments `
            -Operation "Pipeline smoke" `
            -InputObject $smoke
    } finally {
        if ($server -and -not $server.HasExited) {
            Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
            $server.WaitForExit(5000) | Out-Null
        }
    }
    $verifyArguments = [object[]]@($pythonRuntime.arguments) + @("tools\verify_package.py", [string]$manifest)
    Invoke-CheckedNativeCommand `
        -Executable ([string]$pythonRuntime.executable) `
        -Arguments $verifyArguments `
        -Operation "Package verification"
} else {
    Write-Host "Live pipeline skipped. Use -LiveBrowser to run OpenCode, Edge/CDP, Supertonic, and render."
}

if (-not $SkipTests) {
    Write-Host "== Pytest =="
    $pytestArguments = [object[]]@($pythonRuntime.arguments) + @("-m", "pytest", "-q", "--basetemp", ".pytest_tmp")
    Invoke-CheckedNativeCommand `
        -Executable ([string]$pythonRuntime.executable) `
        -Arguments $pytestArguments `
        -Operation "Pytest"
}
