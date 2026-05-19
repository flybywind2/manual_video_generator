import json
import os
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest


def _powershell() -> str:
    executable = shutil.which("powershell") or shutil.which("pwsh")
    if not executable:
        pytest.skip("PowerShell is not available")
    return executable


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
