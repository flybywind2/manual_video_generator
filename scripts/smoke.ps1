param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "bootstrap.ps1") -Root $Root -Quiet
Set-Location $Root

Write-Host "== Doctor =="
& (Join-Path $PSScriptRoot "doctor.ps1") -Root $Root

Write-Host "== Python imports =="
python -c "import fastapi, pydantic, PIL, playwright; print('python runtime ok')"

Write-Host "== Pipeline smoke =="
$smoke = @'
from pathlib import Path
from backend.app.pipeline import PipelineInput, run_pipeline

result = run_pipeline(
    PipelineInput(
        request_text="MES LOT lookup smoke",
        target_url="http://127.0.0.1:8000/sample",
        role="operator",
        completion_condition="detail panel visible",
        input_values={"LOT": "LOT-001"},
    ),
    capture_browser=False,
)
print(result.artifacts.package_manifest)
'@
$manifest = $smoke | python -
python tools\verify_package.py $manifest

if (-not $SkipTests) {
    Write-Host "== Pytest =="
    python -m pytest -q --basetemp .pytest_tmp
}
