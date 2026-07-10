# Python 3.13.14 Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enforce Python 3.13.14 as the only supported company runtime across packaging, startup, diagnostics, smoke tests, and offline bundle creation.

**Architecture:** Store the exact required version in `.python-version` and centralize PowerShell interpreter selection and validation in `scripts/python_runtime.ps1`. Every operational script dot-sources that helper and invokes the resolved interpreter command, while tests validate both the pure version rules and script integration without changing the local Python 3.14 installation.

**Tech Stack:** Python 3.13.14, PowerShell, PEP 621 `pyproject.toml`, pytest, FastAPI/Uvicorn, Playwright, Supertonic/ONNX Runtime.

---

### Task 1: Define the exact runtime contract

**Files:**
- Create: `.python-version`
- Modify: `pyproject.toml`
- Test: `backend/tests/test_runtime_scripts.py`

**Step 1: Write the failing test**

Add a test that reads `.python-version` and `pyproject.toml`, asserting both contain the exact value `3.13.14` and `requires-python = "==3.13.14"`.

**Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_runtime_scripts.py::test_python_runtime_contract_is_exact_3_13_14 -q`

Expected: FAIL because `.python-version` is missing and `pyproject.toml` still targets Python 3.10.

**Step 3: Write minimal implementation**

Create `.python-version` containing `3.13.14` and change `requires-python` to `==3.13.14`.

**Step 4: Run test to verify it passes**

Run the same focused test and expect PASS.

**Step 5: Commit**

```powershell
git add .python-version pyproject.toml backend/tests/test_runtime_scripts.py
git commit -m "build: pin Python 3.13.14 runtime"
```

### Task 2: Add shared Python resolution and validation

**Files:**
- Create: `scripts/python_runtime.ps1`
- Test: `backend/tests/test_runtime_scripts.py`

**Step 1: Write failing contract tests**

Add PowerShell subprocess tests for a validation-only entry point in the helper. Cover exact `3.13.14`, `3.13.13`, `3.14.0`, malformed version output, and a missing configured executable. Use temporary executable shims so tests do not depend on the workstation Python version.

**Step 2: Run tests to verify they fail**

Run: `python -m pytest backend/tests/test_runtime_scripts.py -k "python_runtime_resolution or python_runtime_rejects" -q`

Expected: FAIL because `scripts/python_runtime.ps1` does not exist.

**Step 3: Implement the helper**

Implement functions that:

- Read the required version from `.python-version`.
- Resolve `MANUAL_AGENT_PYTHON`, bundled `runtime\python\python.exe`, `py -3.13`, then `python`.
- Execute `-c "import platform; print(platform.python_version())"` through the selected command.
- Return a structured object containing command, arguments, executable, expected version, actual version, and validity.
- Throw an actionable error when strict validation is requested and the runtime is missing or mismatched.

Provide an executable test mode that emits JSON without bootstrapping the application.

**Step 4: Run tests to verify they pass**

Run the focused tests and expect PASS.

**Step 5: Commit**

```powershell
git add scripts/python_runtime.ps1 backend/tests/test_runtime_scripts.py
git commit -m "feat: validate exact Python runtime"
```

### Task 3: Enforce the runtime across operational scripts

**Files:**
- Modify: `scripts/bootstrap.ps1`
- Modify: `scripts/start.ps1`
- Modify: `scripts/doctor.ps1`
- Modify: `scripts/build_bundle.ps1`
- Modify: `scripts/smoke.ps1`
- Test: `backend/tests/test_runtime_scripts.py`

**Step 1: Write failing integration tests**

Add assertions that all five scripts dot-source `python_runtime.ps1`, avoid operational bare `python` invocations, and expose the Python doctor fields `expected_version`, `actual_version`, and `executable`. Add a mismatch test asserting bundle creation exits nonzero before writing a zip.

**Step 2: Run tests to verify they fail**

Run: `python -m pytest backend/tests/test_runtime_scripts.py -k "runtime_scripts or doctor_python or bundle_rejects" -q`

Expected: FAIL because the scripts currently use PATH `python` and doctor only warns on a `Python 3.10` prefix.

**Step 3: Implement script integration**

- Dot-source `python_runtime.ps1` from bootstrap and export the resolved invocation for child scripts.
- Use the resolved invocation for Uvicorn, settings checks, wheel download, Playwright installation, smoke code, package verification, and pytest.
- Make start, smoke, and bundle strict.
- Keep doctor machine-readable and record exact mismatch as `FAIL`.
- Add `required_python`, `python`, and `python_executable` to `versions.json`.

**Step 4: Run integration tests**

Run the focused tests and expect PASS. On the local Python 3.14 workstation, doctor and bundle mismatch paths must fail intentionally and structurally.

**Step 5: Commit**

```powershell
git add scripts backend/tests/test_runtime_scripts.py
git commit -m "feat: enforce Python 3.13.14 in runtime scripts"
```

### Task 4: Update current deployment and test documentation

**Files:**
- Modify: `README.md`
- Modify: `test_secnario.md`
- Modify: `docs/plans/2026-07-10-quality-first-pipeline-design.md`
- Modify: `docs/plans/2026-07-10-gemma4-12b-qat-video-prompt-design.md`
- Test: `backend/tests/test_runtime_scripts.py`

**Step 1: Write the failing documentation regression test**

Assert README and `test_secnario.md` specify `3.13.14`, use `py -3.13`, and contain no active `3.10.19` or `py -3.10` setup instructions. Assert current July 10 design documents no longer claim Python 3.10 compatibility.

**Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_runtime_scripts.py::test_current_docs_target_python_3_13_14_only -q`

Expected: FAIL on existing Python 3.10 references.

**Step 3: Update documentation**

Rewrite installation, doctor, smoke, and offline bundle instructions for exact Python 3.13.14. Replace obsolete MeloTTS/Python 3.9 isolation guidance with Supertonic and ONNX Runtime notes. Preserve genuinely historical May design documents.

**Step 4: Run test to verify it passes**

Run the focused test and expect PASS.

**Step 5: Commit**

```powershell
git add README.md test_secnario.md docs/plans backend/tests/test_runtime_scripts.py
git commit -m "docs: migrate deployment to Python 3.13.14"
```

### Task 5: Verify locally and define company acceptance

**Files:**
- Modify if needed: `backend/tests/test_runtime_scripts.py`
- Modify if needed: `README.md`

**Step 1: Run focused tests on the local workstation**

Run: `python -m pytest backend/tests/test_runtime_scripts.py -q --basetemp .pytest_tmp_python313`

Expected: PASS. Tests must treat local 3.14 runtime rejection as the correct deployment behavior.

**Step 2: Run the full source test suite**

Run: `$env:TEMP='C:\tmp'; $env:TMP='C:\tmp'; python -m pytest -q --basetemp C:\tmp\manual_video_py313_tests`

Expected: PASS, noting that this checks source compatibility only because the local interpreter is unsupported.

**Step 3: Run static stale-reference checks**

Run: `rg -n "3\.10\.19|py -3\.10|requires-python = \"\>=3\.10" README.md test_secnario.md pyproject.toml scripts docs/plans/2026-07-10-*`

Expected: No current-runtime matches.

**Step 4: Document company acceptance commands**

On the company machine with Python 3.13.14:

```powershell
py -3.13 --version
.\scripts\doctor.ps1
.\scripts\build_bundle.ps1 -SkipDownloads
.\scripts\smoke.ps1
```

Expected: exact `Python 3.13.14`, doctor Python PASS, bundle manifest records `3.13.14`, and smoke completes.

**Step 5: Final commit if verification required adjustments**

```powershell
git add -A
git commit -m "test: verify Python 3.13.14 deployment contract"
```
