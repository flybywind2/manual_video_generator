param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [switch]$SkipTests,
    [switch]$LiveBrowser
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "bootstrap.ps1") -Root $Root -Quiet
Set-Location $Root

Write-Host "== Doctor =="
& (Join-Path $PSScriptRoot "doctor.ps1") -Root $Root

Write-Host "== Python imports =="
python -c "import fastapi, pydantic, PIL, playwright; print('python runtime ok')"

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
    $server = Start-Process -FilePath "python" -ArgumentList "-m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000" -WorkingDirectory $Root -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr -WindowStyle Hidden -PassThru
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
        $manifest = $smoke | python -
    } finally {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
} else {
    $manifest = $smoke | python -
}
python tools\verify_package.py $manifest

if (-not $SkipTests) {
    Write-Host "== Pytest =="
    python -m pytest -q --basetemp .pytest_tmp
}
