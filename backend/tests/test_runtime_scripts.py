import json
import os
import shutil
import subprocess
import tomllib
import zipfile
from pathlib import Path

import pytest


def test_python_runtime_contract_is_exact_3_13_14():
    assert Path(".python-version").read_text(encoding="utf-8").strip() == "3.13.14"

    pyproject = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["project"]["requires-python"] == "==3.13.14"


def _powershell() -> str:
    executable = shutil.which("powershell") or shutil.which("pwsh")
    if not executable:
        pytest.skip("PowerShell is not available")
    return executable


def _run_python_runtime(*arguments: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    command = [
        _powershell(),
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ".\\scripts\\python_runtime.ps1",
        "-Json",
        *arguments,
    ]
    return subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
    )


@pytest.mark.parametrize(
    ("version_output", "expected_actual", "expected_valid"),
    [
        ("3.13.14", "3.13.14", True),
        ("3.13.13", "3.13.13", False),
        ("3.14.0", "3.14.0", False),
        ("not-a-python-version", None, False),
    ],
)
def test_python_runtime_json_mode_validates_exact_version_output(
    version_output: str,
    expected_actual: str | None,
    expected_valid: bool,
):
    completed = _run_python_runtime("-VersionOutput", version_output)

    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)
    assert result == {
        "command": "<version-output>",
        "arguments": [],
        "executable": None,
        "expected_version": "3.13.14",
        "actual_version": expected_actual,
        "valid": expected_valid,
    }


def test_python_runtime_strict_mode_rejects_patch_mismatch():
    completed = _run_python_runtime("-Strict", "-VersionOutput", "3.13.13")

    assert completed.returncode != 0
    assert "Expected Python 3.13.14 but found 3.13.13" in completed.stderr


def test_python_runtime_reports_missing_configured_executable(tmp_path: Path):
    missing_python = tmp_path / "missing-python.exe"
    env = os.environ.copy()
    env["MANUAL_AGENT_PYTHON"] = str(missing_python)

    completed = _run_python_runtime(env=env)

    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)
    assert result["command"] == str(missing_python)
    assert result["arguments"] == []
    assert result["executable"] == str(missing_python)
    assert result["expected_version"] == "3.13.14"
    assert result["actual_version"] is None
    assert result["valid"] is False


def test_python_runtime_strict_mode_identifies_missing_configured_executable(tmp_path: Path):
    missing_python = tmp_path / "missing-python.exe"
    env = os.environ.copy()
    env["MANUAL_AGENT_PYTHON"] = str(missing_python)

    completed = _run_python_runtime("-Strict", env=env)

    assert completed.returncode != 0
    assert str(missing_python) in completed.stderr
    assert "Expected Python 3.13.14" in completed.stderr


def test_python_runtime_falls_back_to_path_python_when_py_313_is_unavailable(tmp_path: Path):
    (tmp_path / "py.cmd").write_text("@exit /b 1\n", encoding="utf-8")
    path_python = tmp_path / "python.cmd"
    path_python.write_text("@echo 3.13.14\n", encoding="utf-8")
    env = os.environ.copy()
    env.pop("MANUAL_AGENT_PYTHON", None)
    env["PATH"] = str(tmp_path)

    completed = _run_python_runtime(env=env)

    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)
    assert result["command"] == "python"
    assert Path(result["executable"]) == path_python
    assert result["actual_version"] == "3.13.14"
    assert result["valid"] is True


def test_doctor_script_emits_machine_readable_json_contract():
    command = [
        _powershell(),
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ".\\scripts\\doctor.ps1",
        "-Json",
    ]

    completed = subprocess.run(command, check=False, capture_output=True, text=True, encoding="utf-8")

    checks = json.loads(completed.stdout)
    names = {item["name"] for item in checks}
    assert {
        "python",
        "node",
        "npm",
        "npx",
        "ffmpeg",
        "playwright_browsers",
        "hf_cache",
        "corp_ca",
        "onedrive_path",
        "long_paths",
        "app_config",
    }.issubset(names)
    assert all(item["status"] in {"PASS", "WARN", "FAIL"} for item in checks)
    if completed.returncode != 0:
        assert any(item["status"] == "FAIL" for item in checks)


def test_build_bundle_skip_downloads_creates_manifest_and_zip(tmp_path: Path):
    dist = tmp_path / "bundle"
    command = [
        _powershell(),
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ".\\scripts\\build_bundle.ps1",
        "-SkipDownloads",
        "-Dist",
        str(dist),
    ]

    completed = subprocess.run(command, check=False, capture_output=True, text=True, encoding="utf-8")

    assert completed.returncode == 0, completed.stderr
    assert (dist / "versions.json").is_file()
    assert dist.with_suffix(".zip").is_file()
    versions = json.loads((dist / "versions.json").read_text(encoding="utf-8-sig"))
    assert versions["files"]
    assert any(item["path"] == "scripts\\doctor.ps1" for item in versions["files"])
    assert not any(".pytest_tmp" in item["path"] for item in versions["files"])
    assert not any("bundle\\runtime" in item["path"] for item in versions["files"])


def test_build_bundle_script_excludes_pytest_temp_dirs_and_dist_self_copy():
    script = Path("scripts/build_bundle.ps1").read_text(encoding="utf-8")

    assert ".pytest_tmp*" in script
    assert "Test-IsInsidePath" in script
    assert "$Dist" in script


def test_smoke_script_supports_live_browser_and_output_smoke_dir():
    script = Path("scripts/smoke.ps1").read_text(encoding="utf-8")

    assert "[switch]$LiveBrowser" in script
    assert "create_pipeline_draft" in script
    assert "continue_pipeline_draft" in script
    assert "output\") / \"smoke\"" in script
    assert "uvicorn backend.app.main:app" in script


def test_doctor_collect_writes_redacted_diagnostics_to_configured_output_dir(tmp_path: Path):
    output_dir = tmp_path / "manual-output"
    env = os.environ.copy()
    env["MANUAL_AGENT_OUTPUT_DIR"] = str(output_dir)
    env["MANUAL_AGENT_OPENAI_API_KEY"] = "super-secret"
    env["MANUAL_AGENT_DEP_TICKET"] = "credential:SECRET"
    command = [
        _powershell(),
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ".\\scripts\\doctor.ps1",
        "-Collect",
    ]

    subprocess.run(command, check=False, capture_output=True, text=True, encoding="utf-8", env=env)

    zips = list((output_dir / "diagnostics").glob("*.zip"))
    assert zips
    with zipfile.ZipFile(zips[0]) as archive:
        env_text = archive.read("environment.redacted.txt").decode("utf-8-sig")
    assert "MANUAL_AGENT_OPENAI_API_KEY=<redacted>" in env_text
    assert "MANUAL_AGENT_DEP_TICKET=<redacted>" in env_text
    assert "super-secret" not in env_text
    assert "credential:SECRET" not in env_text
