param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [switch]$Json,
    [switch]$Collect
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "bootstrap.ps1") -Root $Root -Quiet
$Root = (Resolve-Path $Root).Path
Set-Location $Root

$checks = New-Object System.Collections.Generic.List[object]

function Add-Check {
    param(
        [string]$Name,
        [string]$Status,
        [string]$Message,
        [string]$Action = ""
    )
    $checks.Add([ordered]@{
        name = $Name
        status = $Status
        message = $Message
        action = $Action
    }) | Out-Null
}

function Get-CommandText {
    param([string[]]$Command)
    try {
        $output = & $Command[0] @($Command[1..($Command.Length - 1)]) 2>&1
        return ($output | Select-Object -First 1) -join ""
    } catch {
        return ""
    }
}

function Test-Command {
    param(
        [string]$Name,
        [string[]]$Command,
        [string]$RequiredPrefix = ""
    )
    $resolved = Get-Command $Command[0] -ErrorAction SilentlyContinue
    if (-not $resolved) {
        Add-Check $Name "FAIL" "$($Command[0]) not found" "Use the offline bundle runtime or install the pinned tool."
        return
    }
    $text = Get-CommandText $Command
    if ($RequiredPrefix -and -not $text.StartsWith($RequiredPrefix)) {
        Add-Check $Name "WARN" $text "Expected prefix: $RequiredPrefix"
        return
    }
    Add-Check $Name "PASS" $text
}

Test-Command "python" @("python", "--version") "Python 3.10"
Test-Command "node" @("node", "--version")
Test-Command "npm" @("npm", "--version")
Test-Command "npx" @("npx", "--version")
Test-Command "ffmpeg" @("ffmpeg", "-version")

$pwPath = $env:PLAYWRIGHT_BROWSERS_PATH
if (Test-Path $pwPath) {
    $chromium = Get-ChildItem -Path $pwPath -Recurse -Filter "chrome.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($chromium) {
        Add-Check "playwright_browsers" "PASS" $chromium.FullName
    } else {
        Add-Check "playwright_browsers" "WARN" "No chrome.exe under $pwPath" "Run python -m playwright install chromium on a connected build PC and bundle the browsers directory."
    }
} else {
    Add-Check "playwright_browsers" "FAIL" "$pwPath missing" "Set PLAYWRIGHT_BROWSERS_PATH to a bundled browsers directory."
}

if ($Root -match "OneDrive") {
    Add-Check "onedrive_path" "WARN" $Root "Install to a short local ASCII path such as C:\AppBundle\manualgen."
} else {
    Add-Check "onedrive_path" "PASS" $Root
}

if ($Root.Length -gt 80) {
    Add-Check "path_length" "WARN" "$($Root.Length) characters" "Use a shorter install path to avoid MAX_PATH failures."
} else {
    Add-Check "path_length" "PASS" "$($Root.Length) characters"
}

try {
    $longPaths = Get-ItemPropertyValue -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -ErrorAction Stop
    if ($longPaths -eq 1) {
        Add-Check "long_paths" "PASS" "LongPathsEnabled=1"
    } else {
        Add-Check "long_paths" "WARN" "LongPathsEnabled=$longPaths" "Ask IT to enable long paths or use a short install path."
    }
} catch {
    Add-Check "long_paths" "WARN" "Unable to read LongPathsEnabled" "Run doctor from a policy-readable shell or use a short install path."
}

$corpCa = Join-Path $Root "config\corp-root-ca.pem"
if (Test-Path $corpCa) {
    Add-Check "corp_ca" "PASS" $corpCa
} else {
    Add-Check "corp_ca" "WARN" "No corp-root-ca.pem found" "Required when TLS inspection or private CA is used."
}

$hfHome = $env:HF_HOME
if (Test-Path $hfHome) {
    Add-Check "hf_cache" "PASS" $hfHome
} else {
    Add-Check "hf_cache" "WARN" "$hfHome missing" "Needed before enabling MeloTTS in restricted networks."
}

try {
    $configStatus = python -c "from backend.app.config import load_settings; import json; print(json.dumps(load_settings().safe_status(), ensure_ascii=False))" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Add-Check "app_config" "PASS" "settings loaded"
    } else {
        Add-Check "app_config" "FAIL" ($configStatus -join " ") "Fix .env or Python path."
    }
} catch {
    Add-Check "app_config" "FAIL" $_.Exception.Message "Fix Python runtime before starting the app."
}

if ($Json) {
    $checks | ConvertTo-Json -Depth 5
} else {
    foreach ($check in $checks) {
        $line = "[{0}] {1}: {2}" -f $check.status, $check.name, $check.message
        Write-Host $line
        if ($check.action) { Write-Host "      action: $($check.action)" }
    }
}

if ($Collect) {
    $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $diagRoot = Join-Path $env:MANUAL_AGENT_OUTPUT_DIR "diagnostics"
    $diag = Join-Path $diagRoot $stamp
    New-Item -ItemType Directory -Force -Path $diag | Out-Null
    $checks | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $diag "doctor.json")
    Get-ChildItem Env: | Where-Object { $_.Name -like "MANUAL_AGENT_*" -or $_.Name -in @("PLAYWRIGHT_BROWSERS_PATH", "HF_HOME", "NPM_CONFIG_CACHE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS") } |
        ForEach-Object {
            $value = $_.Value
            if ($_.Name -match "KEY|SECRET|TOKEN|TICKET|PASSWORD") { $value = "<redacted>" }
            "$($_.Name)=$value"
        } | Set-Content -Encoding UTF8 (Join-Path $diag "environment.redacted.txt")
    netsh winhttp show proxy | Set-Content -Encoding UTF8 (Join-Path $diag "winhttp-proxy.txt")
    Compress-Archive -Path (Join-Path $diag "*") -DestinationPath "$diag.zip" -Force
    Write-Host "Diagnostics collected: $diag.zip"
}

if (($checks | Where-Object { $_.status -eq "FAIL" }).Count -gt 0) {
    exit 1
}
