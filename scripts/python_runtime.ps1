[CmdletBinding()]
param(
    [switch]$Json,
    [switch]$Strict,
    [AllowEmptyString()]
    [string]$VersionOutput,
    [string]$Command,
    [string]$CommandArgumentsBase64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$versionFile = Join-Path $projectRoot ".python-version"

if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf)) {
    throw "Python runtime contract is missing: $versionFile"
}

$expectedVersion = (Get-Content -LiteralPath $versionFile -Raw).Trim()
if ($expectedVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "Python runtime contract is malformed in ${versionFile}: '$expectedVersion'"
}

function New-RuntimeResult {
    param(
        [string]$SelectedCommand,
        [object[]]$SelectedArguments,
        [AllowNull()]
        [object]$SelectedExecutable,
        [AllowNull()]
        [object]$ActualVersion
    )

    [pscustomobject]@{
        command = $SelectedCommand
        arguments = [object[]]$SelectedArguments
        executable = $SelectedExecutable
        expected_version = $expectedVersion
        actual_version = $ActualVersion
        valid = ($null -ne $ActualVersion -and $ActualVersion -eq $expectedVersion)
    }
}

function ConvertTo-PythonVersion {
    param([AllowNull()][string]$Output)

    if ($null -ne $Output -and $Output.Trim() -match '^(\d+\.\d+\.\d+)$') {
        return $Matches[1]
    }
    return $null
}

function Resolve-ExecutablePath {
    param([string]$Name)

    $resolved = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $resolved) {
        return $null
    }
    if ($resolved.Source) {
        return $resolved.Source
    }
    return $resolved.Path
}

function ConvertFrom-CommandArgumentsBase64 {
    param([string]$EncodedArguments)

    try {
        $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedArguments))
        $parsed = $json | ConvertFrom-Json
    }
    catch {
        throw "CommandArgumentsBase64 must contain valid Base64-encoded UTF-8 JSON."
    }

    if ($null -eq $parsed -or $parsed -isnot [System.Collections.IList]) {
        throw "CommandArgumentsBase64 must decode to a JSON array of strings."
    }

    $decoded = [object[]]$parsed
    foreach ($argument in $decoded) {
        if ($argument -isnot [string]) {
            throw "CommandArgumentsBase64 must decode to a JSON array containing only strings."
        }
    }
    return [object[]]$decoded
}

function Invoke-PythonVersion {
    param(
        [string]$Executable,
        [object[]]$PrefixArguments
    )

    try {
        $versionCommandArguments = [object[]]$PrefixArguments + @(
            "-c",
            "import platform; print(platform.python_version())"
        )
        $output = & $Executable @versionCommandArguments 2>$null
        if ($LASTEXITCODE -ne 0) {
            return $null
        }
        return ConvertTo-PythonVersion (($output | Out-String).Trim())
    }
    catch {
        return $null
    }
}

$result = $null

if ($PSBoundParameters.ContainsKey("VersionOutput")) {
    $actualVersion = ConvertTo-PythonVersion $VersionOutput
    $result = New-RuntimeResult "<version-output>" @() $null $actualVersion
}
else {
    $selectedCommand = $null
    $selectedArguments = [object[]]@()
    $selectedExecutable = $null

    if ($PSBoundParameters.ContainsKey("Command")) {
        $selectedCommand = $Command
        if ($PSBoundParameters.ContainsKey("CommandArgumentsBase64")) {
            $selectedArguments = ConvertFrom-CommandArgumentsBase64 $CommandArgumentsBase64
        }
        $selectedExecutable = Resolve-ExecutablePath $Command
    }
    elseif (-not [string]::IsNullOrWhiteSpace($env:MANUAL_AGENT_PYTHON)) {
        $selectedCommand = $env:MANUAL_AGENT_PYTHON
        $selectedExecutable = if (Test-Path -LiteralPath $selectedCommand -PathType Leaf) {
            (Resolve-Path -LiteralPath $selectedCommand).Path
        } else {
            $selectedCommand
        }
    }
    else {
        $bundledPython = Join-Path $projectRoot "runtime\python\python.exe"
        if (Test-Path -LiteralPath $bundledPython -PathType Leaf) {
            $selectedCommand = $bundledPython
            $selectedExecutable = (Resolve-Path -LiteralPath $bundledPython).Path
        }
        else {
            $pyExecutable = Resolve-ExecutablePath "py"
            if ($null -ne $pyExecutable) {
                $selectedCommand = "py"
                $selectedArguments = [object[]]@("-3.13")
                $selectedExecutable = $pyExecutable
            }
            else {
                $pythonExecutable = Resolve-ExecutablePath "python"
                if ($null -ne $pythonExecutable) {
                    $selectedCommand = "python"
                    $selectedExecutable = $pythonExecutable
                }
            }
        }
    }

    if ($null -eq $selectedCommand -or $null -eq $selectedExecutable -or -not (Test-Path -LiteralPath $selectedExecutable -PathType Leaf)) {
        $displayCommand = if ($null -ne $selectedCommand) { $selectedCommand } else { "<not-found>" }
        $result = New-RuntimeResult $displayCommand $selectedArguments $selectedExecutable $null
    }
    else {
        $actualVersion = Invoke-PythonVersion $selectedExecutable $selectedArguments

        if ($selectedCommand -eq "py" -and $null -eq $actualVersion) {
            $pathPython = Resolve-ExecutablePath "python"
            if ($null -ne $pathPython) {
                $selectedCommand = "python"
                $selectedArguments = [object[]]@()
                $selectedExecutable = $pathPython
                $actualVersion = Invoke-PythonVersion $selectedExecutable $selectedArguments
            }
        }

        $result = New-RuntimeResult $selectedCommand $selectedArguments $selectedExecutable $actualVersion
    }
}

if ($Json) {
    $result | ConvertTo-Json -Depth 4
}
else {
    $result
}

if ($Strict -and -not $result.valid) {
    if ($null -eq $result.actual_version) {
        throw "Python runtime '$($result.command)' is unavailable or returned an invalid version. Expected Python $expectedVersion. Set MANUAL_AGENT_PYTHON to the Python $expectedVersion executable."
    }
    $location = if ([string]::IsNullOrWhiteSpace([string]$result.executable)) { "" } else { " at $($result.executable)" }
    throw "Expected Python $expectedVersion but found $($result.actual_version)$location. Set MANUAL_AGENT_PYTHON to the Python $expectedVersion executable."
}
