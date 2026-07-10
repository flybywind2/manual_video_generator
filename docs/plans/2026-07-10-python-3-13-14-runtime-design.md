# Python 3.13.14 Runtime Design

## Goal

Make Python 3.13.14 the only supported runtime for company deployment, startup, diagnostics, smoke tests, and offline bundle creation.

## Decision

The deployment contract is exact, not a minor-version range. `pyproject.toml` declares `==3.13.14`, and every operational PowerShell entry point validates the selected interpreter before doing work.

The local workstation is not modified by this change. A developer may inspect or run source-level tests with another interpreter, but installation, application startup, smoke execution, and bundle creation are unsupported and must fail clearly unless the selected interpreter is exactly Python 3.13.14.

## Runtime Selection

The required version is stored in `.python-version` as the single source of truth. A shared PowerShell helper resolves the interpreter in this order:

1. `MANUAL_AGENT_PYTHON` when explicitly configured.
2. `runtime\python\python.exe` in an offline bundle.
3. The Python launcher command `py -3.13`.
4. `python` from `PATH`.

The resolved interpreter must report `3.13.14`. A missing interpreter or any other patch version is a hard failure with an actionable message.

## Script Contract

- `bootstrap.ps1` prepares runtime paths and resolves the Python command.
- `start.ps1` refuses to start Uvicorn on a mismatched runtime.
- `doctor.ps1` reports the exact expected and actual versions and marks mismatch as `FAIL`.
- `build_bundle.ps1` refuses to download wheels or create a distributable bundle with another interpreter. Its manifest records `required_python`, `python`, and the resolved executable.
- `smoke.ps1` uses the same resolved interpreter for imports, application startup, package verification, and pytest.

Scripts invoke Python through the resolved command instead of a bare `python`, preventing PATH order from silently changing the runtime.

## Dependency Compatibility

The active browser and speech stack has Python 3.13-compatible distributions: Playwright supports Python 3.13, Supertonic is Python 3.9+, and ONNX Runtime publishes CPython 3.13 Windows wheels. Company bundle creation remains the final compatibility proof because it downloads the exact Windows wheel set under Python 3.13.14.

## Documentation

README installation, diagnostics, and offline deployment sections use Python 3.13.14 exclusively. `test_secnario.md` uses `py -3.13`, verifies the exact patch version, and treats any mismatch as a failed prerequisite. Obsolete active guidance for Python 3.10 and MeloTTS-specific Python 3.9 isolation is removed or rewritten for Supertonic.

Historical design documents remain unchanged unless they are presented as current installation instructions.

## Testing

Tests cover the runtime contract without requiring the local workstation to be reconfigured:

- Static contract tests verify `.python-version`, `pyproject.toml`, and all operational scripts agree on `3.13.14`.
- Pure version-validation tests exercise exact match, wrong patch, wrong minor, malformed output, and missing interpreter cases.
- Doctor integration tests accept a nonzero result on an unsupported local interpreter but require a structured Python `FAIL` explaining the mismatch.
- Bundle tests verify mismatched runtimes are rejected before a distributable zip is produced. Bundle success is an acceptance test to run on the company Python 3.13.14 machine.
- Documentation regression tests reject active Python 3.10 installation guidance.

## Acceptance Criteria

1. The application cannot start through supported scripts with Python other than 3.13.14.
2. Doctor output identifies expected version, actual version, and executable.
3. Offline bundles can only be produced by Python 3.13.14 and record that fact in `versions.json`.
4. All current setup and test instructions use Python 3.13.14.
5. Unit and contract tests pass locally; the company machine completes the Python 3.13.14 bundle and live smoke acceptance tests.
