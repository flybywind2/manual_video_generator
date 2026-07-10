import base64
import json
import os
import shutil
import subprocess
import sys
import tomllib
import zipfile
from pathlib import Path

import pytest


def test_python_runtime_contract_is_exact_3_13_14():
    assert Path(".python-version").read_text(encoding="utf-8").strip() == "3.13.14"

    pyproject = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["project"]["requires-python"] == "==3.13.14"


def _markdown_section(content: str, heading: str, next_heading_prefix: str) -> str:
    start = content.index(heading)
    end = content.find(f"\n{next_heading_prefix}", start + len(heading))
    return content[start:] if end == -1 else content[start:end]


def test_current_docs_target_python_3_13_14_only():
    readme = Path("README.md").read_text(encoding="utf-8")
    environment_setup = _markdown_section(readme, "## 환경 준비", "## ")
    assert "정확히 `3.13.14`" in environment_setup
    assert "py -3.13 -m venv .venv" in environment_setup
    assert "py -3.10 -m venv" not in environment_setup

    scenario = Path("test_secnario.md").read_text(encoding="utf-8")
    common_setup = _markdown_section(scenario, "## 공통 준비", "## ")
    assert "Python `3.13.14` 가상환경" in common_setup
    assert "py -3.13 -m venv .venv" in common_setup
    assert "py -3.10 -m venv" not in common_setup

    expected_tech_stacks = {
        Path("docs/plans/2026-07-10-gemma4-12b-qat-video-prompt-implementation-plan.md"):
            "Python 3.13.14 JSON contracts",
        Path("docs/plans/2026-07-10-quality-first-pipeline-implementation-plan.md"):
            "**Tech Stack:** Python 3.13.14,",
    }
    for path, expected in expected_tech_stacks.items():
        assert expected in path.read_text(encoding="utf-8")


def test_readme_documents_supertonic_preload_and_runtime_cache_layout():
    readme = Path("README.md").read_text(encoding="utf-8")
    tts_setup = _markdown_section(readme, "### 5. Supertonic", "### ")

    preload = "TTS(auto_download=True)"
    offline_verify = "TTS(auto_download=False)"
    assert preload in tts_setup
    assert offline_verify in tts_setup
    assert tts_setup.index(preload) < tts_setup.index(offline_verify)
    assert "SUPERTONIC_CACHE_DIR=runtime\\supertonic3" in tts_setup
    assert "runtime\\supertonic3\\" in tts_setup
    assert "onnx\\" in tts_setup
    for model in (
        "duration_predictor.onnx",
        "text_encoder.onnx",
        "vector_estimator.onnx",
        "vocoder.onnx",
    ):
        assert model in tts_setup


def test_readme_describes_current_bundle_builder_scope_without_overclaiming():
    readme = Path("README.md").read_text(encoding="utf-8")
    bundle_setup = _markdown_section(readme, "### 오프라인 번들 생성", "### ")

    assert "완전한 오프라인 배포 번들이 아닙니다" in bundle_setup
    assert "core Python wheels" in bundle_setup
    assert "Playwright Chromium" in bundle_setup
    assert "Playwright MCP npm cache" in bundle_setup
    for prerequisite in (
        "Python 3.13.14 runtime",
        "Supertonic/ONNX Runtime wheels와 모델",
        "FFmpeg",
        "HyperFrames",
        "OpenCode",
        "사내 루트 CA",
    ):
        assert prerequisite in bundle_setup
    assert "별도 staging" in bundle_setup


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


OPERATIONAL_SCRIPTS = (
    "bootstrap.ps1",
    "start.ps1",
    "doctor.ps1",
    "build_bundle.ps1",
    "smoke.ps1",
)
BUNDLE_OWNERSHIP_MARKER = ".manual-video-agent-bundle-owned"


def _powershell_script(name: str, *arguments: str, env: dict[str, str] | None = None):
    return subprocess.run(
        [
            _powershell(),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            f".\\scripts\\{name}",
            *arguments,
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
    )


def _fake_python_3_13_14(tmp_path: Path) -> Path:
    executable = tmp_path / "fake python 3.13.14.cmd"
    executable.write_text("@echo 3.13.14\n", encoding="utf-8")
    return executable


def _controlled_python_3_13_14(tmp_path: Path) -> Path:
    executable = tmp_path / "controlled python 3.13.14.cmd"
    executable.write_text(
        "@echo off\n"
        "echo %* | %SystemRoot%\\System32\\findstr.exe /C:\"platform.python_version\" >nul && (echo 3.13.14 & exit /b 0)\n"
        "echo %* | %SystemRoot%\\System32\\findstr.exe /C:\"backend.app.config\" >nul && exit /b 0\n"
        "if \"%~1\"==\"-c\" if \"%FAKE_FAIL_STAGE%\"==\"import\" exit /b 31\n"
        "if \"%~1\"==\"-c\" exit /b 0\n"
        "if \"%~1\"==\"-\" (echo fake-manifest.json & exit /b 0)\n"
        "if \"%~1\"==\"tools\\verify_package.py\" if \"%FAKE_FAIL_STAGE%\"==\"verify\" exit /b 32\n"
        "if \"%~1\"==\"tools\\verify_package.py\" exit /b 0\n"
        "if \"%~1\"==\"-m\" if \"%~2\"==\"pytest\" if \"%FAKE_FAIL_STAGE%\"==\"pytest\" exit /b 33\n"
        "if \"%~1\"==\"-m\" if \"%~2\"==\"pytest\" exit /b 0\n"
        "if \"%~1\"==\"-m\" if \"%~2\"==\"uvicorn\" if \"%FAKE_FAIL_STAGE%\"==\"uvicorn\" exit /b 34\n"
        "if \"%~1\"==\"-m\" if \"%~2\"==\"uvicorn\" exit /b 0\n"
        "if \"%~1\"==\"-m\" if \"%~2\"==\"pip\" if \"%FAKE_FAIL_STAGE%\"==\"pip\" exit /b 35\n"
        "if \"%~1\"==\"-m\" if \"%~2\"==\"pip\" exit /b 0\n"
        "if \"%~1\"==\"-m\" if \"%~2\"==\"playwright\" if \"%FAKE_FAIL_STAGE%\"==\"playwright\" exit /b 36\n"
        "if \"%~1\"==\"-m\" if \"%~2\"==\"playwright\" exit /b 0\n"
        "exit /b 0\n",
        encoding="utf-8",
    )
    return executable


def _minimal_bundle_root(tmp_path: Path) -> Path:
    root = tmp_path / "source"
    scripts = root / "scripts"
    scripts.mkdir(parents=True)
    (scripts / "doctor.ps1").write_text("Write-Host 'fixture'\n", encoding="utf-8")
    (root / "pyproject.toml").write_text("[project]\nname='fixture'\n", encoding="utf-8")
    return root


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
    compact_stderr = "".join(completed.stderr.split())
    assert missing_python.name in compact_stderr
    assert "ExpectedPython3.13.14" in compact_stderr


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


def test_python_runtime_cli_decodes_multiple_arguments_for_command_path_with_spaces(tmp_path: Path):
    command_dir = tmp_path / "runtime with spaces"
    command_dir.mkdir()
    command = command_dir / "fake python.cmd"
    command.write_text(
        '@if "%~1"=="first value" if "%~2"=="second value" @echo 3.13.14 & @exit /b 0\n'
        "@exit /b 9\n",
        encoding="utf-8",
    )
    encoded_arguments = base64.b64encode(
        json.dumps(["first value", "second value"]).encode("utf-8")
    ).decode("ascii")

    completed = _run_python_runtime(
        "-Command",
        str(command),
        "-CommandArgumentsBase64",
        encoded_arguments,
    )

    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)
    assert result["command"] == str(command)
    assert Path(result["executable"]) == command
    assert result["arguments"] == ["first value", "second value"]
    assert result["actual_version"] == "3.13.14"
    assert result["valid"] is True


def test_python_runtime_cli_accepts_multiline_json_command_arguments(tmp_path: Path):
    command = tmp_path / "fake-python.cmd"
    command.write_text(
        '@if "%~1"=="first value" if "%~2"=="second value" @echo 3.13.14 & @exit /b 0\n'
        "@exit /b 9\n",
        encoding="utf-8",
    )
    multiline_json = json.dumps(["first value", "second value"], indent=2)
    encoded_arguments = base64.b64encode(multiline_json.encode("utf-8")).decode("ascii")

    completed = _run_python_runtime(
        "-Command",
        str(command),
        "-CommandArgumentsBase64",
        encoded_arguments,
    )

    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)
    assert result["arguments"] == ["first value", "second value"]
    assert result["actual_version"] == "3.13.14"
    assert result["valid"] is True


def test_python_runtime_cli_preserves_empty_json_command_arguments(tmp_path: Path):
    command = tmp_path / "fake-python.cmd"
    command.write_text("@echo 3.13.14\n", encoding="utf-8")
    encoded_arguments = base64.b64encode(b"[]").decode("ascii")

    completed = _run_python_runtime(
        "-Command",
        str(command),
        "-CommandArgumentsBase64",
        encoded_arguments,
    )

    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)
    assert result["arguments"] == []
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


def test_runtime_scripts_use_resolved_python_without_bare_operational_invocations():
    forbidden = (
        "python -m ",
        "python -c ",
        "| python -",
        "python tools\\",
        '-FilePath "python"',
    )

    for name in OPERATIONAL_SCRIPTS:
        script = Path("scripts", name).read_text(encoding="utf-8")
        assert "python_runtime.ps1" in script, name
        assert not any(token in script for token in forbidden), name

    for name in ("start.ps1", "build_bundle.ps1", "smoke.ps1"):
        script = Path("scripts", name).read_text(encoding="utf-8")
        assert "-Strict" in script, name
        assert "Invoke-CheckedNativeCommand" in script, name


def test_doctor_python_check_reports_structured_exact_version_mismatch():
    env = os.environ.copy()
    env["MANUAL_AGENT_PYTHON"] = sys.executable

    completed = _powershell_script("doctor.ps1", "-Json", env=env)

    assert completed.returncode != 0
    checks = json.loads(completed.stdout)
    python_check = next(item for item in checks if item["name"] == "python")
    assert python_check["status"] == "FAIL"
    assert python_check["expected_version"] == "3.13.14"
    assert python_check["actual_version"] != "3.13.14"
    assert Path(python_check["executable"]).resolve() == Path(sys.executable).resolve()


def test_build_bundle_rejects_mismatch_without_touching_existing_unmarked_dist(tmp_path: Path):
    dist = tmp_path / "mismatch-bundle"
    root = _minimal_bundle_root(tmp_path)
    dist.mkdir()
    keep = dist / "keep-me.txt"
    keep.write_text("keep\n", encoding="utf-8")
    dist.with_suffix(".zip").write_bytes(b"stale-success")
    env = os.environ.copy()
    env["MANUAL_AGENT_PYTHON"] = sys.executable

    completed = _powershell_script(
        "build_bundle.ps1",
        "-Root",
        str(root),
        "-SkipDownloads",
        "-Dist",
        str(dist),
        env=env,
    )

    assert completed.returncode != 0
    assert "Expected Python 3.13.14" in completed.stderr
    assert keep.read_text(encoding="utf-8") == "keep\n"
    assert dist.with_suffix(".zip").read_bytes() == b"stale-success"


def test_build_bundle_rejects_valid_runtime_for_existing_unmarked_dist_without_modifying_it(tmp_path: Path):
    root = _minimal_bundle_root(tmp_path)
    dist = tmp_path / "unmarked-bundle"
    dist.mkdir()
    keep = dist / "keep-me.txt"
    keep.write_text("keep\n", encoding="utf-8")
    stale_zip = dist.with_suffix(".zip")
    stale_zip.write_bytes(b"stale-success")
    env = os.environ.copy()
    env["MANUAL_AGENT_PYTHON"] = str(_fake_python_3_13_14(tmp_path))

    completed = _powershell_script(
        "build_bundle.ps1", "-Root", str(root), "-SkipDownloads", "-Dist", str(dist), env=env
    )

    assert completed.returncode != 0
    assert "ownership marker" in completed.stderr.lower()
    assert keep.read_text(encoding="utf-8") == "keep\n"
    assert stale_zip.read_bytes() == b"stale-success"


def test_build_bundle_manifest_records_resolved_python_runtime(tmp_path: Path):
    dist = tmp_path / "valid-bundle"
    root = _minimal_bundle_root(tmp_path)
    fake_python = _fake_python_3_13_14(tmp_path)
    env = os.environ.copy()
    env["MANUAL_AGENT_PYTHON"] = str(fake_python)

    completed = _powershell_script(
        "build_bundle.ps1",
        "-Root",
        str(root),
        "-SkipDownloads",
        "-Dist",
        str(dist),
        env=env,
    )

    assert completed.returncode == 0, completed.stderr
    versions = json.loads((dist / "versions.json").read_text(encoding="utf-8-sig"))
    assert versions["required_python"] == "3.13.14"
    assert versions["python"] == "3.13.14"
    assert Path(versions["python_executable"]) == fake_python
    assert (dist / BUNDLE_OWNERSHIP_MARKER).is_file()
    assert any(item["path"] == BUNDLE_OWNERSHIP_MARKER for item in versions["files"])


def test_build_bundle_excludes_secret_env_files_but_keeps_example(tmp_path: Path):
    root = _minimal_bundle_root(tmp_path)
    (root / ".env").write_text("SECRET=top-secret\n", encoding="utf-8")
    (root / ".env.local").write_text("SECRET=local\n", encoding="utf-8")
    (root / "service.env").write_text("SECRET=service\n", encoding="utf-8")
    (root / "service.env.local").write_text("SECRET=service-local\n", encoding="utf-8")
    (root / ".ENV").write_text("SECRET=uppercase\n", encoding="utf-8")
    (root / ".env.example").write_text("SECRET=placeholder\n", encoding="utf-8")
    nested = root / "backend" / "private"
    nested.mkdir(parents=True)
    (nested / ".env.production").write_text("SECRET=prod\n", encoding="utf-8")
    dist = tmp_path / "bundle"
    env = os.environ.copy()
    env["MANUAL_AGENT_PYTHON"] = str(_fake_python_3_13_14(tmp_path))

    completed = _powershell_script(
        "build_bundle.ps1", "-Root", str(root), "-SkipDownloads", "-Dist", str(dist), env=env
    )

    assert completed.returncode == 0, completed.stderr
    manifest = json.loads((dist / "versions.json").read_text(encoding="utf-8-sig"))
    manifest_paths = {item["path"].replace("\\", "/") for item in manifest["files"]}
    with zipfile.ZipFile(dist.with_suffix(".zip")) as archive:
        zip_paths = {name.replace("\\", "/") for name in archive.namelist()}
    assert ".env.example" in manifest_paths
    assert any(name.endswith("/.env.example") or name == ".env.example" for name in zip_paths)
    secret_names = {".env", ".env.local", "service.env", "service.env.local", ".env.production", ".env"}
    for paths in (manifest_paths, zip_paths):
        assert not any(Path(name).name.lower() in secret_names for name in paths)
        assert not any(
            Path(name).name.lower() != ".env.example"
            and (Path(name).name.lower().startswith(".env") or Path(name).name.lower().endswith(".env"))
            for name in paths
        )


@pytest.mark.parametrize("failure_stage", ["pip", "playwright", "npx"])
def test_build_bundle_native_failure_removes_partial_outputs(tmp_path: Path, failure_stage: str):
    root = _minimal_bundle_root(tmp_path)
    dist = tmp_path / f"{failure_stage}-bundle"
    stale_zip = dist.with_suffix(".zip")
    initial_env = os.environ.copy()
    initial_env["MANUAL_AGENT_PYTHON"] = str(_fake_python_3_13_14(tmp_path))
    initial = _powershell_script(
        "build_bundle.ps1", "-Root", str(root), "-SkipDownloads", "-Dist", str(dist), env=initial_env
    )
    assert initial.returncode == 0, initial.stderr
    (dist / "stale.txt").write_text("stale\n", encoding="utf-8")
    env = os.environ.copy()
    env["MANUAL_AGENT_PYTHON"] = str(_controlled_python_3_13_14(tmp_path))
    env["FAKE_FAIL_STAGE"] = failure_stage
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    (fake_bin / "npx.cmd").write_text(
        '@if "%FAKE_FAIL_STAGE%"=="npx" @exit /b 37\n@exit /b 0\n', encoding="utf-8"
    )
    env["PATH"] = f"{fake_bin}{os.pathsep}{env['PATH']}"

    completed = _powershell_script(
        "build_bundle.ps1", "-Root", str(root), "-Dist", str(dist), env=env
    )

    assert completed.returncode != 0
    expected_exit = {"pip": 35, "playwright": 36, "npx": 37}[failure_stage]
    assert f"exit code {expected_exit}" in completed.stderr
    assert dist.is_dir()
    assert {item.name for item in dist.iterdir()} == {BUNDLE_OWNERSHIP_MARKER}
    assert not stale_zip.exists()


def test_build_bundle_cleans_stale_dist_before_success(tmp_path: Path):
    root = _minimal_bundle_root(tmp_path)
    dist = tmp_path / "clean-bundle"
    env = os.environ.copy()
    env["MANUAL_AGENT_PYTHON"] = str(_fake_python_3_13_14(tmp_path))
    initial = _powershell_script(
        "build_bundle.ps1", "-Root", str(root), "-SkipDownloads", "-Dist", str(dist), env=env
    )
    assert initial.returncode == 0, initial.stderr
    (dist / "deleted-source.txt").write_text("stale\n", encoding="utf-8")

    completed = _powershell_script(
        "build_bundle.ps1", "-Root", str(root), "-SkipDownloads", "-Dist", str(dist), env=env
    )

    assert completed.returncode == 0, completed.stderr
    assert (dist / BUNDLE_OWNERSHIP_MARKER).is_file()
    assert not (dist / "deleted-source.txt").exists()
    with zipfile.ZipFile(dist.with_suffix(".zip")) as archive:
        assert not any(name.endswith("deleted-source.txt") for name in archive.namelist())


def test_build_bundle_rejects_source_root_as_dist_without_deleting_it(tmp_path: Path):
    root = _minimal_bundle_root(tmp_path)
    marker = root / "keep-me.txt"
    marker.write_text("keep\n", encoding="utf-8")
    env = os.environ.copy()
    env["MANUAL_AGENT_PYTHON"] = str(_fake_python_3_13_14(tmp_path))

    completed = _powershell_script(
        "build_bundle.ps1", "-Root", str(root), "-SkipDownloads", "-Dist", str(root), env=env
    )

    assert completed.returncode != 0
    assert marker.read_text(encoding="utf-8") == "keep\n"


def test_build_bundle_rejects_reparse_point_dist_without_touching_target(tmp_path: Path):
    root = _minimal_bundle_root(tmp_path)
    target = tmp_path / "junction-target"
    target.mkdir()
    marker = target / "keep-me.txt"
    marker.write_text("keep\n", encoding="utf-8")
    dist = tmp_path / "bundle-junction"
    linked = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(dist), str(target)],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if linked.returncode != 0:
        pytest.skip("Windows junction creation is unavailable")
    env = os.environ.copy()
    env["MANUAL_AGENT_PYTHON"] = str(_fake_python_3_13_14(tmp_path))

    completed = _powershell_script(
        "build_bundle.ps1", "-Root", str(root), "-SkipDownloads", "-Dist", str(dist), env=env
    )

    assert completed.returncode != 0
    assert "reparse point" in completed.stderr.lower()
    assert marker.read_text(encoding="utf-8") == "keep\n"


def test_build_bundle_rejects_reparse_point_ancestor_without_touching_target(tmp_path: Path):
    root = _minimal_bundle_root(tmp_path)
    target = tmp_path / "junction-parent-target"
    target.mkdir()
    marker = target / "keep-me.txt"
    marker.write_text("keep\n", encoding="utf-8")
    junction_parent = tmp_path / "junction-parent"
    linked = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(junction_parent), str(target)],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if linked.returncode != 0:
        pytest.skip("Windows junction creation is unavailable")
    dist = junction_parent / "bundle"
    env = os.environ.copy()
    env["MANUAL_AGENT_PYTHON"] = str(_fake_python_3_13_14(tmp_path))

    completed = _powershell_script(
        "build_bundle.ps1", "-Root", str(root), "-SkipDownloads", "-Dist", str(dist), env=env
    )

    assert completed.returncode != 0
    assert "reparse point" in completed.stderr.lower()
    assert marker.read_text(encoding="utf-8") == "keep\n"
    assert not (target / "bundle").exists()


def test_doctor_json_collect_keeps_stdout_parseable(tmp_path: Path):
    output_dir = tmp_path / "diagnostics-output"
    env = os.environ.copy()
    env["MANUAL_AGENT_OUTPUT_DIR"] = str(output_dir)
    env["MANUAL_AGENT_PYTHON"] = sys.executable

    completed = _powershell_script("doctor.ps1", "-Json", "-Collect", env=env)

    checks = json.loads(completed.stdout)
    assert any(item["name"] == "python" for item in checks)
    assert list((output_dir / "diagnostics").glob("*.zip"))


def test_bootstrap_rejects_mismatch_before_creating_output_directory(tmp_path: Path):
    output_dir = tmp_path / "must-not-exist"
    env = os.environ.copy()
    env["MANUAL_AGENT_OUTPUT_DIR"] = str(output_dir)
    env["MANUAL_AGENT_PYTHON"] = sys.executable

    completed = _powershell_script("bootstrap.ps1", env=env)

    assert completed.returncode != 0
    assert not output_dir.exists()


def test_start_propagates_uvicorn_native_failure(tmp_path: Path):
    env = os.environ.copy()
    env["MANUAL_AGENT_PYTHON"] = str(_controlled_python_3_13_14(tmp_path))
    env["FAKE_FAIL_STAGE"] = "uvicorn"

    completed = _powershell_script("start.ps1", env=env)

    assert completed.returncode != 0
    assert "Uvicorn failed with exit code 34" in completed.stderr


def _smoke_env(tmp_path: Path, failure_stage: str) -> dict[str, str]:
    browser_dir = tmp_path / "browsers" / "chromium"
    browser_dir.mkdir(parents=True)
    (browser_dir / "chrome.exe").write_bytes(b"")
    env = os.environ.copy()
    env["MANUAL_AGENT_PYTHON"] = str(_controlled_python_3_13_14(tmp_path))
    env["FAKE_FAIL_STAGE"] = failure_stage
    env["PLAYWRIGHT_BROWSERS_PATH"] = str(tmp_path / "browsers")
    env["HF_HOME"] = str(tmp_path / "hf-cache")
    Path(env["HF_HOME"]).mkdir()
    return env


def test_smoke_stops_when_doctor_fails(tmp_path: Path):
    env = _smoke_env(tmp_path, "")
    env["PLAYWRIGHT_BROWSERS_PATH"] = str(tmp_path / "missing-browsers")

    completed = _powershell_script("smoke.ps1", "-SkipTests", env=env)

    assert completed.returncode != 0
    assert "Doctor failed with exit code" in completed.stderr
    assert "== Python imports ==" not in completed.stdout


@pytest.mark.parametrize(
    ("failure_stage", "later_marker", "expected_error"),
    [
        ("import", "== Pipeline smoke ==", "Python import check failed with exit code 31"),
        ("verify", "== Pytest ==", "Package verification failed with exit code 32"),
        ("pytest", None, "Pytest failed with exit code 33"),
    ],
)
def test_smoke_propagates_native_failures(
    tmp_path: Path, failure_stage: str, later_marker: str | None, expected_error: str
):
    env = _smoke_env(tmp_path, failure_stage)
    completed = _powershell_script("smoke.ps1", env=env)

    assert completed.returncode != 0
    assert expected_error in completed.stderr
    if later_marker:
        assert later_marker not in completed.stdout


def test_build_bundle_skip_downloads_creates_manifest_and_zip(tmp_path: Path):
    dist = tmp_path / "bundle"
    root = _minimal_bundle_root(tmp_path)
    env = os.environ.copy()
    env["MANUAL_AGENT_PYTHON"] = str(_fake_python_3_13_14(tmp_path))
    command = [
        _powershell(),
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ".\\scripts\\build_bundle.ps1",
        "-Root",
        str(root),
        "-SkipDownloads",
        "-Dist",
        str(dist),
    ]

    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
    )

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
    assert '"uvicorn", "backend.app.main:app"' in script


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
