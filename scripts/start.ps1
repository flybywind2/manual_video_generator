param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$HostName = "127.0.0.1",
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "bootstrap.ps1") -Root $Root -Quiet
Set-Location $Root

Write-Host "Starting Manual Video Agent on http://$HostName`:$Port"
python -m uvicorn backend.app.main:app --host $HostName --port $Port
