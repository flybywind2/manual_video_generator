import json
import shutil
import subprocess
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
        "ffmpeg",
        "playwright_browsers",
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
