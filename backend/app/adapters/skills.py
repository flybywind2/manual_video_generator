from __future__ import annotations

import json
import shlex
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from backend.app.config import AppSettings
from backend.app.subprocess_utils import run_text_command


CommandRunner = Callable[..., subprocess.CompletedProcess]


@dataclass(frozen=True)
class SkillsResult:
    status: str
    metadata_path: Path
    enabled: bool


def ensure_hyperframes_skills(
    settings: AppSettings,
    package_dir: Path,
    *,
    command_runner: CommandRunner | None = None,
) -> SkillsResult:
    metadata_path = package_dir / "hyperframes_skills.json"
    enabled = settings.enable_hyperframes_skills
    metadata = {"enabled": enabled, "status": "skipped"}
    if not enabled:
        metadata["reason"] = "MANUAL_AGENT_ENABLE_HYPERFRAMES_SKILLS is false"
        _write_metadata(metadata_path, metadata)
        return SkillsResult(status="skipped", metadata_path=metadata_path, enabled=False)

    command = shlex.split(settings.hyperframes_skills_command, posix=False)
    if command:
        resolved = shutil.which(command[0])
        if resolved:
            command[0] = resolved
    metadata["command"] = command
    if not command:
        metadata["status"] = "failed"
        metadata["error"] = "hyperframes skills command is empty"
        _write_metadata(metadata_path, metadata)
        return SkillsResult(status="failed", metadata_path=metadata_path, enabled=True)

    runner = subprocess.run if command_runner is None else command_runner
    try:
        completed = run_text_command(runner, command, cwd=str(package_dir), capture_output=True, timeout=300)
        metadata["returncode"] = completed.returncode
        metadata["stdout"] = completed.stdout[-4000:] if completed.stdout else ""
        metadata["stderr"] = completed.stderr[-4000:] if completed.stderr else ""
        metadata["status"] = "completed" if completed.returncode == 0 else "failed"
    except Exception as exc:  # noqa: BLE001 - skills are optional; rendering can continue.
        metadata["status"] = "failed"
        metadata["error"] = f"{type(exc).__name__}: {exc}"

    _write_metadata(metadata_path, metadata)
    return SkillsResult(status=str(metadata["status"]), metadata_path=metadata_path, enabled=True)


def _write_metadata(path: Path, metadata: dict) -> None:
    path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
