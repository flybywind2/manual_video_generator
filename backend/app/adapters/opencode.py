from __future__ import annotations

import json
import shlex
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from backend.app.config import AppSettings
from backend.app.subprocess_utils import run_text_command


CommandRunner = Callable[..., subprocess.CompletedProcess]


@dataclass(frozen=True)
class OpencodeResult:
    status: str
    metadata_path: Path
    prompt_path: Path
    enabled: bool


def run_opencode_agent(
    *,
    plan: dict[str, Any],
    package_dir: Path,
    settings: AppSettings,
    command_runner: CommandRunner | None = None,
) -> OpencodeResult:
    package_dir.mkdir(parents=True, exist_ok=True)
    metadata_path = package_dir / "opencode_agent.json"
    prompt_path = package_dir / "opencode_prompt.md"
    prompt = _build_prompt(plan, package_dir)
    prompt_path.write_text(prompt, encoding="utf-8")

    metadata: dict[str, Any] = {
        "enabled": settings.enable_opencode,
        "status": "skipped",
        "prompt_path": str(prompt_path),
        "cwd": str(package_dir),
        "agent": settings.opencode_agent,
        "model_source": "opencode-default",
        "model_override": "",
        "configured_model_ignored": bool(settings.opencode_model),
    }
    if not settings.enable_opencode:
        metadata["reason"] = "MANUAL_AGENT_ENABLE_OPENCODE is false"
        _write_metadata(metadata_path, metadata)
        return OpencodeResult("skipped", metadata_path, prompt_path, False)

    command = _build_command(settings, prompt)
    metadata["command"] = command
    if not command:
        metadata["status"] = "failed"
        metadata["error"] = "OpenCode command is empty"
        _write_metadata(metadata_path, metadata)
        return OpencodeResult("failed", metadata_path, prompt_path, True)

    runner = subprocess.run if command_runner is None else command_runner
    try:
        completed = run_text_command(
            runner,
            command,
            cwd=str(package_dir),
            capture_output=True,
            timeout=settings.opencode_timeout_seconds,
        )
        metadata["returncode"] = completed.returncode
        metadata["stdout"] = completed.stdout[-12000:] if completed.stdout else ""
        metadata["stderr"] = completed.stderr[-12000:] if completed.stderr else ""
        metadata["status"] = "completed" if completed.returncode == 0 else "failed"
    except Exception as exc:  # noqa: BLE001 - opencode is optional.
        metadata["status"] = "failed"
        metadata["error"] = f"{type(exc).__name__}: {exc}"

    _write_metadata(metadata_path, metadata)
    return OpencodeResult(str(metadata["status"]), metadata_path, prompt_path, True)


def _build_command(settings: AppSettings, prompt: str) -> list[str]:
    return build_opencode_run_command(settings, prompt)


def build_opencode_run_command(
    settings: AppSettings,
    prompt: str,
    *,
    agent_override: str | None = None,
    session_id: str = "",
) -> list[str]:
    command = shlex.split(settings.opencode_command, posix=False)
    if not command:
        return []
    if command:
        resolved = shutil.which(command[0])
        if resolved:
            command[0] = resolved
    agent = settings.opencode_agent if agent_override is None else agent_override
    if session_id:
        command.extend(["--session", session_id])
    if agent:
        command.extend(["--agent", agent])
    command.append(prompt)
    return command


def _build_prompt(plan: dict[str, Any], package_dir: Path) -> str:
    plan_json = json.dumps(plan, ensure_ascii=False, indent=2)
    return f"""# Manual Video Agent OpenCode Pass

You are running inside a generated manual-video package directory.

Goal:
- Inspect the generated package.
- Improve HyperFrames composition files only when a clear issue is visible.
- Preserve the artifact contract used by the backend.

Allowed files to edit:
- `hyperframes/index.html`
- `hyperframes/hyperframes_manifest.json`
- Optional notes under `opencode_notes.md`

Do not edit:
- `action_plan.json`
- `approval_log.json`
- `masking_log.json`
- `package_manifest.json`
- captured images, masked images, audio, or video files

Expected output:
- Briefly summarize what you checked.
- List changed files.
- If nothing needs changing, say so.

Package directory:
`{package_dir}`

Action plan:
```json
{plan_json}
```
"""


def _write_metadata(path: Path, metadata: dict[str, Any]) -> None:
    path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
