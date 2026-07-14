[CmdletBinding()]
param(
    [switch]$Ensure,
    [switch]$Download,
    [switch]$Start,
    [switch]$Check,
    [string]$RuntimeRoot = (Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "ManualVideoStudio\supertonic")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ExpectedPythonVersion = "3.13.14"
$ExpectedPackageVersion = "1.3.1"
$ExpectedPackage = "supertonic[serve]==1.3.1"
$ExpectedModel = "supertonic-3"
$VenvRoot = Join-Path $RuntimeRoot "venv"
$VenvPython = Join-Path $VenvRoot "Scripts\python.exe"
$VenvSupertonic = Join-Path $VenvRoot "Scripts\supertonic.exe"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath"
    }
}

function Get-PythonVersion {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$PrefixArguments = @()
    )

    $output = & $FilePath @PrefixArguments -c "import platform; print(platform.python_version())" 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $null
    }
    return ([string]($output | Select-Object -Last 1)).Trim()
}

function Resolve-BasePython {
    $candidates = @()
    if ($env:SUPERTONIC_PYTHON) {
        $candidates += [pscustomobject]@{
            FilePath = $env:SUPERTONIC_PYTHON
            Arguments = @()
        }
    }

    $launcher = Get-Command "py.exe" -ErrorAction SilentlyContinue
    if ($launcher) {
        $candidates += [pscustomobject]@{
            FilePath = $launcher.Source
            Arguments = @("-3.13")
        }
    }

    $python313 = Get-Command "python3.13.exe" -ErrorAction SilentlyContinue
    if ($python313) {
        $candidates += [pscustomobject]@{
            FilePath = $python313.Source
            Arguments = @()
        }
    }

    foreach ($candidate in $candidates) {
        try {
            $version = Get-PythonVersion -FilePath $candidate.FilePath -PrefixArguments $candidate.Arguments
        } catch {
            # A launcher may exist without the requested runtime. Continue to
            # the next exact-version candidate instead of aborting discovery.
            continue
        }
        if ($version -eq $ExpectedPythonVersion) {
            return $candidate
        }
    }

    throw "Python $ExpectedPythonVersion is required. Install that exact version or set SUPERTONIC_PYTHON to its python.exe."
}

function Assert-VenvPython {
    if (-not (Test-Path -LiteralPath $VenvPython -PathType Leaf)) {
        throw "Supertonic virtual environment is missing: $VenvPython"
    }
    $version = Get-PythonVersion -FilePath $VenvPython
    if ($version -ne $ExpectedPythonVersion) {
        throw "Supertonic virtual environment must use Python $ExpectedPythonVersion; found $version."
    }
}

function Get-InstalledSupertonicVersion {
    if (-not (Test-Path -LiteralPath $VenvPython -PathType Leaf)) {
        return $null
    }
    try {
        $output = & $VenvPython -c "import importlib.metadata as m; print(m.version('supertonic'))" 2>$null
    } catch {
        return $null
    }
    if ($LASTEXITCODE -ne 0) {
        return $null
    }
    return ([string]($output | Select-Object -Last 1)).Trim()
}

function Ensure-Runtime {
    if (-not (Test-Path -LiteralPath $VenvPython -PathType Leaf)) {
        New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
        $basePython = Resolve-BasePython
        Invoke-Checked -FilePath $basePython.FilePath -Arguments ($basePython.Arguments + @("-m", "venv", $VenvRoot))
    }

    Assert-VenvPython
    $installed = Get-InstalledSupertonicVersion
    if ($installed -ne $ExpectedPackageVersion) {
        Invoke-Checked -FilePath $VenvPython -Arguments @(
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--upgrade",
            $ExpectedPackage
        )
    }

    $installed = Get-InstalledSupertonicVersion
    if ($installed -ne $ExpectedPackageVersion) {
        throw "Expected Supertonic $ExpectedPackageVersion after installation; found $installed."
    }
    if (-not (Test-Path -LiteralPath $VenvSupertonic -PathType Leaf)) {
        throw "The pinned Supertonic CLI was not installed in the virtual environment."
    }
}

function Write-RuntimeStatus {
    $pythonVersion = $null
    if (Test-Path -LiteralPath $VenvPython -PathType Leaf) {
        $pythonVersion = Get-PythonVersion -FilePath $VenvPython
    }
    $packageVersion = Get-InstalledSupertonicVersion
    $ready =
        $pythonVersion -eq $ExpectedPythonVersion -and
        $packageVersion -eq $ExpectedPackageVersion -and
        (Test-Path -LiteralPath $VenvSupertonic -PathType Leaf)

    [pscustomobject]@{
        ready = $ready
        python = $pythonVersion
        supertonic = $packageVersion
        model = $ExpectedModel
        endpoint = "http://127.0.0.1:7788"
    } | ConvertTo-Json -Compress

    if (-not $ready) {
        $global:LASTEXITCODE = 1
    }
}

if (-not ($Ensure -or $Download -or $Start -or $Check)) {
    Write-Error "Choose -Check, -Ensure, -Download, or -Start."
    exit 2
}

if ($Check -and -not ($Ensure -or $Download -or $Start)) {
    Write-RuntimeStatus
    exit $LASTEXITCODE
}

Ensure-Runtime

if ($Download) {
    Invoke-Checked -FilePath $VenvPython -Arguments @(
        "-c",
        "from supertonic import TTS; TTS(model='supertonic-3', auto_download=True); print('supertonic-3 ready')"
    )
}

if ($Start) {
    $env:NO_PROXY = "127.0.0.1,localhost"
    Invoke-Checked -FilePath $VenvSupertonic -Arguments @(
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "7788",
        "--model",
        "supertonic-3"
    )
} else {
    Write-RuntimeStatus
}
