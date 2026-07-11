param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [switch]$Json,
    [switch]$Collect
)

$ErrorActionPreference = "Stop"
$doctorJson = $Json
. (Join-Path $PSScriptRoot "bootstrap.ps1") -Root $Root -Quiet -AllowInvalidPython
$pythonRuntime = . (Join-Path $PSScriptRoot "python_runtime.ps1")
$Json = $doctorJson
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

$pythonStatus = if ($pythonRuntime.valid) { "PASS" } else { "FAIL" }
$pythonMessage = if ($null -eq $pythonRuntime.actual_version) {
    "Python runtime unavailable; expected $($pythonRuntime.expected_version)"
} else {
    "Python $($pythonRuntime.actual_version); expected $($pythonRuntime.expected_version)"
}
$checks.Add([ordered]@{
    name = "python"
    status = $pythonStatus
    message = $pythonMessage
    action = if ($pythonRuntime.valid) { "" } else { "Set MANUAL_AGENT_PYTHON to the Python $($pythonRuntime.expected_version) executable." }
    expected_version = $pythonRuntime.expected_version
    actual_version = $pythonRuntime.actual_version
    executable = $pythonRuntime.executable
}) | Out-Null
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
        Add-Check "playwright_browsers" "WARN" "No chrome.exe under $pwPath" "Run the resolved Python runtime with -m playwright install chromium on a connected build PC."
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
    Add-Check "hf_cache" "WARN" "$hfHome missing" "Preload this cache only for adapters that use Hugging Face assets in restricted networks."
}

$supertonicCache = if ($env:SUPERTONIC_CACHE_DIR) {
    $env:SUPERTONIC_CACHE_DIR
} else {
    Join-Path $Root "runtime\supertonic3"
}
$supertonicVoice = "M1"
$supertonicRequiredFiles = @(
    "onnx\duration_predictor.onnx",
    "onnx\text_encoder.onnx",
    "onnx\vector_estimator.onnx",
    "onnx\vocoder.onnx",
    "onnx\tts.json",
    "onnx\unicode_indexer.json",
    "voice_styles\$supertonicVoice.json"
)
$missingSupertonicFiles = @(
    $supertonicRequiredFiles | Where-Object { -not (Test-Path (Join-Path $supertonicCache $_) -PathType Leaf) }
)
if ($missingSupertonicFiles.Count -eq 0) {
    Add-Check "supertonic_cache" "PASS" "$supertonicCache (model config and $supertonicVoice voice ready)"
} else {
    Add-Check `
        "supertonic_cache" `
        "WARN" `
        "$supertonicCache missing: $($missingSupertonicFiles -join ', ')" `
        "Preload the Supertonic model into SUPERTONIC_CACHE_DIR on a connected build PC."
}

if (-not $pythonRuntime.valid) {
    Add-Check "app_config" "FAIL" "Skipped because the Python runtime contract failed." "Fix Python runtime before starting the app."
} else {
    try {
        $configArguments = [object[]]@($pythonRuntime.arguments) + @(
            "-c",
            "from backend.app.config import load_settings; import json; print(json.dumps(load_settings().safe_status(), ensure_ascii=False))"
        )
        $configStatus = & ([string]$pythonRuntime.executable) @configArguments 2>&1
        if ($LASTEXITCODE -eq 0) {
            Add-Check "app_config" "PASS" "settings loaded"
        } else {
            Add-Check "app_config" "FAIL" ($configStatus -join " ") "Fix .env or Python path."
        }
    } catch {
        Add-Check "app_config" "FAIL" $_.Exception.Message "Fix Python runtime before starting the app."
    }
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
    $safeManualAgentVariables = @(
        "MANUAL_AGENT_BROWSER_CHANNEL",
        "MANUAL_AGENT_BUNDLE_ROOT",
        "MANUAL_AGENT_ENABLE_BROWSER_AGENT",
        "MANUAL_AGENT_ENABLE_INTERNAL_PLANNER",
        "MANUAL_AGENT_ENV_FILE",
        "MANUAL_AGENT_OUTPUT_DIR",
        "MANUAL_AGENT_PYTHON",
        "MANUAL_AGENT_RENDER_POLICY",
        "MANUAL_AGENT_TTS_PROVIDER"
    )
    $safeRuntimeVariables = @(
        "PLAYWRIGHT_BROWSERS_PATH",
        "HF_HOME",
        "SUPERTONIC_CACHE_DIR",
        "NPM_CONFIG_CACHE",
        "REQUESTS_CA_BUNDLE",
        "NODE_EXTRA_CA_CERTS"
    )
    $diagnosticReplacements = New-Object System.Collections.Generic.List[object]
    if ($env:USERPROFILE) {
        $diagnosticReplacements.Add([pscustomobject]@{ value = $env:USERPROFILE; placeholder = "<user-profile>" })
        $diagnosticReplacements.Add([pscustomobject]@{
            value = $env:USERPROFILE.Replace("/", "\")
            placeholder = "<user-profile>"
        })
        $diagnosticReplacements.Add([pscustomobject]@{
            value = $env:USERPROFILE.Replace("\", "/")
            placeholder = "<user-profile>"
        })
    }
    if ($env:USERNAME) {
        $diagnosticReplacements.Add([pscustomobject]@{ value = $env:USERNAME; placeholder = "<username>" })
    }
    Get-ChildItem Env: | Where-Object {
        $_.Name -like "MANUAL_AGENT_*" -and $_.Name -notin $safeManualAgentVariables -and $_.Value
    } | ForEach-Object {
        $diagnosticReplacements.Add([pscustomobject]@{
            value = $_.Value
            placeholder = "<redacted:$($_.Name)>"
        })
    }
    $diagnosticReplacements = @($diagnosticReplacements | Sort-Object { ([string]$_.value).Length } -Descending)
    $diagnosticReplacementMap = @{}
    foreach ($replacement in $diagnosticReplacements) {
        if (-not $diagnosticReplacementMap.ContainsKey([string]$replacement.value)) {
            $diagnosticReplacementMap[[string]$replacement.value] = [string]$replacement.placeholder
        }
    }
    $diagnosticReplacementPattern = @($diagnosticReplacementMap.Keys |
        Sort-Object { ([string]$_).Length } -Descending |
        ForEach-Object { [regex]::Escape([string]$_) }) -join "|"

    function Protect-DiagnosticText {
        param([AllowEmptyString()][string]$Text)
        if (-not $diagnosticReplacementPattern -or -not $Text) { return $Text }
        $evaluator = [System.Text.RegularExpressions.MatchEvaluator]{
            param($match)
            return [string]$diagnosticReplacementMap[$match.Value]
        }
        return [regex]::Replace(
            $Text,
            $diagnosticReplacementPattern,
            $evaluator,
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
        )
    }

    function Protect-DiagnosticValue {
        param([AllowNull()]$Value)
        if ($null -eq $Value) { return $null }
        if ($Value -is [string]) { return Protect-DiagnosticText -Text $Value }
        if ($Value -is [System.Collections.IDictionary]) {
            $protectedDictionary = [ordered]@{}
            foreach ($key in $Value.Keys) {
                $protectedDictionary[$key] = Protect-DiagnosticValue -Value $Value[$key]
            }
            return $protectedDictionary
        }
        if ($Value -is [pscustomobject]) {
            $protectedObject = [ordered]@{}
            foreach ($property in $Value.PSObject.Properties) {
                $protectedObject[$property.Name] = Protect-DiagnosticValue -Value $property.Value
            }
            return [pscustomobject]$protectedObject
        }
        if ($Value -is [System.Collections.IEnumerable]) {
            return @($Value | ForEach-Object { Protect-DiagnosticValue -Value $_ })
        }
        return $Value
    }

    $protectedChecks = @($checks | ForEach-Object { Protect-DiagnosticValue -Value $_ })
    $protectedChecks | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $diag "doctor.json")

    Get-ChildItem Env: | Where-Object { $_.Name -like "MANUAL_AGENT_*" -or $_.Name -in $safeRuntimeVariables } |
        ForEach-Object {
            $value = if ($_.Name -like "MANUAL_AGENT_*" -and $_.Name -notin $safeManualAgentVariables) {
                "<redacted:$($_.Name)>"
            } else {
                Protect-DiagnosticText -Text $_.Value
            }
            "$($_.Name)=$value"
        } | Set-Content -Encoding UTF8 (Join-Path $diag "environment.redacted.txt")
    $proxyText = (netsh winhttp show proxy | Out-String)
    Protect-DiagnosticText -Text $proxyText | Set-Content -Encoding UTF8 (Join-Path $diag "winhttp-proxy.txt")
    Compress-Archive -Path (Join-Path $diag "*") -DestinationPath "$diag.zip" -Force
    if (-not $Json) {
        Write-Host "Diagnostics collected: $diag.zip"
    }
}

if (@($checks | Where-Object { $_.status -eq "FAIL" }).Count -gt 0) {
    exit 1
}
