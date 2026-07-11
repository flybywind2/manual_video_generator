param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$EnvFile = "",
    [switch]$Quiet,
    [switch]$AllowInvalidPython
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path $Root).Path
$Runtime = Join-Path $Root "runtime"

function Add-PathEntry {
    param([string]$PathEntry)
    if ((Test-Path $PathEntry) -and -not (($env:PATH -split [IO.Path]::PathSeparator) -contains $PathEntry)) {
        $env:PATH = "$PathEntry$([IO.Path]::PathSeparator)$env:PATH"
    }
}

$env:MANUAL_AGENT_BUNDLE_ROOT = $Root
if (-not $env:MANUAL_AGENT_OUTPUT_DIR) {
    $env:MANUAL_AGENT_OUTPUT_DIR = Join-Path $Root "output"
}
if (-not $env:NPM_CONFIG_CACHE) {
    $env:NPM_CONFIG_CACHE = Join-Path $Runtime "npm-cache"
}
if (-not $env:SUPERTONIC_CACHE_DIR) {
    $env:SUPERTONIC_CACHE_DIR = Join-Path $Runtime "supertonic3"
}

$CorpCa = Join-Path $Root "config\corp-root-ca.pem"
if (Test-Path $CorpCa) {
    if (-not $env:REQUESTS_CA_BUNDLE) { $env:REQUESTS_CA_BUNDLE = $CorpCa }
    if (-not $env:SSL_CERT_FILE) { $env:SSL_CERT_FILE = $CorpCa }
    if (-not $env:PIP_CERT) { $env:PIP_CERT = $CorpCa }
    if (-not $env:NODE_EXTRA_CA_CERTS) { $env:NODE_EXTRA_CA_CERTS = $CorpCa }
}

Add-PathEntry (Join-Path $Runtime "python")
Add-PathEntry (Join-Path $Runtime "node")
Add-PathEntry (Join-Path $Runtime "node\bin")
Add-PathEntry (Join-Path $Runtime "ffmpeg\bin")

$script:ManualAgentPythonRuntime = if ($AllowInvalidPython) {
    . (Join-Path $PSScriptRoot "python_runtime.ps1")
} else {
    . (Join-Path $PSScriptRoot "python_runtime.ps1") -Strict
}
$script:ManualAgentPythonExecutable = [string]$script:ManualAgentPythonRuntime.executable
$script:ManualAgentPythonPrefixArguments = [object[]]@($script:ManualAgentPythonRuntime.arguments)

if ($EnvFile -and (Test-Path $EnvFile)) {
    $env:MANUAL_AGENT_ENV_FILE = (Resolve-Path $EnvFile).Path
}

New-Item -ItemType Directory -Force -Path $env:MANUAL_AGENT_OUTPUT_DIR | Out-Null

if (-not $Quiet) {
    Write-Host "Manual Video Agent runtime prepared"
    Write-Host "Root: $Root"
    Write-Host "Output: $env:MANUAL_AGENT_OUTPUT_DIR"
    Write-Host "NPM cache: $env:NPM_CONFIG_CACHE"
    Write-Host "Supertonic cache: $env:SUPERTONIC_CACHE_DIR"
    Write-Host "Python: $($script:ManualAgentPythonRuntime.actual_version) ($script:ManualAgentPythonExecutable)"
}
