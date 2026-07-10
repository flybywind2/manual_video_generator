param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [switch]$SkipTests,
    [switch]$LiveBrowser
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "bootstrap.ps1") -Root $Root -Quiet
$pythonRuntime = . (Join-Path $PSScriptRoot "python_runtime.ps1") -Strict
Set-Location $Root

Write-Host "== Doctor =="
& (Join-Path $PSScriptRoot "doctor.ps1") -Root $Root

Write-Host "== Python imports =="
$importArguments = [object[]]@($pythonRuntime.arguments) + @(
    "-c", "import fastapi, pydantic, PIL, playwright; print('python runtime ok')"
)
& ([string]$pythonRuntime.executable) @importArguments

Write-Host "== Pipeline smoke =="
$captureBrowser = if ($LiveBrowser) { "True" } else { "False" }
$smoke = @"
from pathlib import Path
from backend.app.pipeline import PipelineInput, create_pipeline_draft, continue_pipeline_draft

base = Path("output") / "smoke"
draft = create_pipeline_draft(
    PipelineInput(
        request_text="MES LOT lookup smoke",
        target_url="http://127.0.0.1:8000/sample",
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
        "-m", "uvicorn", "backend.app.main:app", "--host", "127.0.0.1", "--port", "8000"
    )
    $server = Start-Process -FilePath ([string]$pythonRuntime.executable) -ArgumentList $serverArguments -WorkingDirectory $Root -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr -WindowStyle Hidden -PassThru
    try {
        $deadline = (Get-Date).AddSeconds(30)
        do {
            try {
                $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8000/api/health" -TimeoutSec 2
                if ($response.StatusCode -eq 200) { $ready = $true; break }
            } catch {
                Start-Sleep -Milliseconds 500
            }
        } while ((Get-Date) -lt $deadline)
        if (-not $ready) {
            Get-Content -Path $serverErr -Tail 80
            throw "Local app did not become ready for live browser smoke."
        }
        $stdinArguments = [object[]]@($pythonRuntime.arguments) + @("-")
        $manifest = $smoke | & ([string]$pythonRuntime.executable) @stdinArguments
    } finally {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
} else {
    $stdinArguments = [object[]]@($pythonRuntime.arguments) + @("-")
    $manifest = $smoke | & ([string]$pythonRuntime.executable) @stdinArguments
}
$verifyArguments = [object[]]@($pythonRuntime.arguments) + @("tools\verify_package.py", [string]$manifest)
& ([string]$pythonRuntime.executable) @verifyArguments

if (-not $SkipTests) {
    Write-Host "== Pytest =="
    $pytestArguments = [object[]]@($pythonRuntime.arguments) + @("-m", "pytest", "-q", "--basetemp", ".pytest_tmp")
    & ([string]$pythonRuntime.executable) @pytestArguments
}
