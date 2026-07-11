from __future__ import annotations

import json
import shlex
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

from backend.app.adapters.opencode import build_opencode_run_command
from backend.app.config import AppSettings
from backend.app.subprocess_utils import run_text_command


CommandRunner = Callable[..., subprocess.CompletedProcess]


class OpenCodeBrowserDiscoveryError(RuntimeError):
    def __init__(self, code: str, message: str, *, metadata_path: Path, support_summary_path: Path) -> None:
        super().__init__(message)
        self.code = code
        self.metadata_path = metadata_path
        self.support_summary_path = support_summary_path


@dataclass(frozen=True)
class OpenCodeBrowserDiscoveryResult:
    status: str
    trace: dict[str, Any]
    config_path: Path
    prompt_path: Path
    event_log_path: Path
    trace_path: Path
    metadata_path: Path
    support_summary_path: Path


class OpenCodeBrowserDiscovery:
    def __init__(
        self,
        settings: AppSettings,
        *,
        command_runner: CommandRunner | None = None,
    ) -> None:
        self.settings = settings
        self.command_runner = subprocess.run if command_runner is None else command_runner

    def run(
        self,
        *,
        request: Any,
        job_dir: Path,
        cdp_endpoint: str,
    ) -> OpenCodeBrowserDiscoveryResult:
        job_dir.mkdir(parents=True, exist_ok=True)
        paths = _artifact_paths(job_dir)
        metadata: dict[str, Any] = {
            "status": "starting",
            "enabled": self.settings.enable_opencode,
            "agent": self.settings.opencode_agent,
            "model_source": "opencode-default",
            "model_override": "",
            "configured_model_ignored": bool(self.settings.opencode_model),
            "cdp_endpoint": cdp_endpoint,
            "config_path": str(paths["config"]),
            "prompt_path": str(paths["prompt"]),
            "event_log_path": str(paths["events"]),
            "trace_path": str(paths["trace"]),
        }
        if not self.settings.enable_opencode:
            self._fail(
                "opencode_disabled",
                "OpenCode browser discovery is required but disabled",
                metadata,
                paths,
            )

        try:
            config = _build_job_config(self.settings, cdp_endpoint)
        except ValueError as exc:
            metadata["error"] = f"{type(exc).__name__}: {exc}"
            self._fail(
                "playwright_mcp_command_invalid",
                "Playwright MCP command is empty or invalid",
                metadata,
                paths,
            )
        _write_json(paths["config"], config)
        prompt = _build_browser_prompt(request)
        paths["prompt"].write_text(prompt, encoding="utf-8")
        command = build_opencode_run_command(self.settings, prompt)
        if not command:
            self._fail("opencode_command_empty", "OpenCode command is empty", metadata, paths)
        metadata["command"] = command[:-1] + [f"@{paths['prompt'].name}"]

        try:
            completed = run_text_command(
                self.command_runner,
                command,
                cwd=str(job_dir),
                capture_output=True,
                timeout=self.settings.opencode_timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            stdout = _process_text(exc.output)
            stderr = _process_text(exc.stderr)
            paths["events"].write_text(stdout, encoding="utf-8")
            metadata.update({"returncode": None, "stdout": stdout[-12000:], "stderr": stderr[-12000:]})
            self._fail(
                "opencode_timeout",
                f"OpenCode browser discovery exceeded {self.settings.opencode_timeout_seconds:g} seconds",
                metadata,
                paths,
            )
        except Exception as exc:  # noqa: BLE001 - normalized into a typed adapter failure.
            metadata["error"] = f"{type(exc).__name__}: {exc}"
            self._fail("opencode_invocation_failed", "OpenCode could not be started", metadata, paths)

        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        paths["events"].write_text(stdout, encoding="utf-8")
        metadata.update(
            {
                "returncode": completed.returncode,
                "stdout": stdout[-12000:],
                "stderr": stderr[-12000:],
            }
        )
        if completed.returncode != 0:
            self._fail(
                "opencode_nonzero_exit",
                f"OpenCode browser discovery exited with code {completed.returncode}",
                metadata,
                paths,
            )

        try:
            events = _parse_jsonl(stdout)
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            metadata["error"] = f"{type(exc).__name__}: {exc}"
            self._fail(
                "opencode_malformed_output",
                "OpenCode output was not valid JSONL",
                metadata,
                paths,
            )
        trace = _extract_final_trace(events)
        if trace is None:
            metadata["event_count"] = len(events)
            self._fail(
                "opencode_trace_missing",
                "OpenCode completed without an execution trace",
                metadata,
                paths,
            )

        _write_json(paths["trace"], trace)
        metadata.update({"status": "completed", "event_count": len(events)})
        _write_json(paths["metadata"], metadata)
        _write_support_summary(paths["support"], status="OK", code="completed", metadata=metadata)
        return OpenCodeBrowserDiscoveryResult(
            status="completed",
            trace=trace,
            config_path=paths["config"],
            prompt_path=paths["prompt"],
            event_log_path=paths["events"],
            trace_path=paths["trace"],
            metadata_path=paths["metadata"],
            support_summary_path=paths["support"],
        )

    def _fail(
        self,
        code: str,
        message: str,
        metadata: dict[str, Any],
        paths: Mapping[str, Path],
    ) -> None:
        metadata.update({"status": "failed", "error_code": code, "error_message": message})
        _write_json(paths["metadata"], metadata)
        _write_support_summary(paths["support"], status="FAILED", code=code, metadata=metadata)
        raise OpenCodeBrowserDiscoveryError(
            code,
            message,
            metadata_path=paths["metadata"],
            support_summary_path=paths["support"],
        )


def _artifact_paths(job_dir: Path) -> dict[str, Path]:
    return {
        "config": job_dir / "opencode.json",
        "prompt": job_dir / "opencode_browser_prompt.md",
        "events": job_dir / "opencode_events.jsonl",
        "trace": job_dir / "opencode_execution_trace.json",
        "metadata": job_dir / "opencode_browser_metadata.json",
        "support": job_dir / "opencode_support_summary.txt",
    }


def _build_job_config(settings: AppSettings, cdp_endpoint: str) -> dict[str, Any]:
    return {
        "$schema": "https://opencode.ai/config.json",
        "mcp": {
            "playwright": {
                "type": "local",
                "enabled": True,
                "command": _build_playwright_mcp_command(settings.playwright_mcp_command, cdp_endpoint),
            }
        },
        "tools": {"*": False, "playwright_*": True},
        "permission": {
            "*": "deny",
            "playwright_*": "allow",
            "bash": "deny",
            "edit": "deny",
            "write": "deny",
            "webfetch": "deny",
            "websearch": "deny",
            "task": "deny",
        },
    }


def _build_playwright_mcp_command(command_text: str, cdp_endpoint: str) -> list[str]:
    command = shlex.split(command_text, posix=False)
    if not command:
        raise ValueError("Playwright MCP command is empty")
    resolved = shutil.which(command[0])
    if resolved:
        command[0] = resolved

    launch_only_flags = {"--headless", "--isolated"}
    launch_options = {"--browser", "--channel", "--user-data-dir", "--executable-path", "--cdp-endpoint"}
    cleaned: list[str] = []
    skip_value = False
    for token in command:
        if skip_value:
            skip_value = False
            continue
        normalized = token.lower()
        if normalized in launch_only_flags:
            continue
        if normalized in launch_options:
            skip_value = True
            continue
        if any(normalized.startswith(f"{option}=") for option in launch_options):
            continue
        cleaned.append(token)
    cleaned.extend(["--cdp-endpoint", cdp_endpoint])
    return cleaned


def _build_browser_prompt(request: Any) -> str:
    input_values = _request_value(request, "input_values", {})
    safe_values = {
        str(key): str(value)
        for key, value in (input_values.items() if isinstance(input_values, Mapping) else [])
        if not _is_sensitive_input_key(str(key))
    }
    request_payload = {
        "request_text": str(_request_value(request, "request_text", "")),
        "target_url": str(_request_value(request, "target_url", "")),
        "role": str(_request_value(request, "role", "")),
        "completion_condition": str(_request_value(request, "completion_condition", "")),
        "input_values": safe_values,
    }
    payload = json.dumps(request_payload, ensure_ascii=False, indent=2)
    return f"""# OpenCode Browser Discovery

Use only the configured Playwright MCP tools. Inspect the live page before every action and use
screenshots or accessibility snapshots as evidence. Complete the user's read-only documentation
scenario on the provided target. Do not submit, save, delete, approve, purchase, upload, or perform
any other state-changing action. Never handle credentials, OTP values, cookies, or SSO tokens.

For text inputs, use the non-sensitive values below while operating the page. In the final trace,
record only the corresponding `value_key`, never the literal value. Every click or key action must
include the observed semantic label and an exact Playwright ref or specific selector. Stay on the
target origin, capture evidence before/after meaningful actions, and verify the completion condition.

Return one final JSON object and no prose. It must use schema_version `1.0`, status `completed`, and
contain request_summary, input_values (key names only), non-empty steps, and completion_evidence.
Allowed action types are navigate, fill, click, press, wait, and capture.

Request:
```json
{payload}
```
"""


def _parse_jsonl(stdout: str) -> list[Any]:
    events: list[Any] = []
    for line_number, line in enumerate(stdout.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise json.JSONDecodeError(
                f"invalid OpenCode JSON event on line {line_number}: {exc.msg}",
                exc.doc,
                exc.pos,
            ) from exc
    if not events:
        raise ValueError("OpenCode produced no JSON events")
    return events


def _extract_final_trace(events: list[Any]) -> dict[str, Any] | None:
    for event in reversed(events):
        candidate = _find_trace(event)
        if candidate is not None:
            return candidate
    combined_text = "".join(
        chunk
        for event in events
        for chunk in _event_text_chunks(event)
    )
    if combined_text:
        return _find_trace(combined_text)
    return None


def _event_text_chunks(value: Any):
    if isinstance(value, Mapping):
        text = value.get("text")
        if isinstance(text, str):
            yield text
        for key in ("part", "message", "content", "output", "result"):
            if key in value:
                yield from _event_text_chunks(value[key])
    elif isinstance(value, list):
        for item in value:
            yield from _event_text_chunks(item)


def _find_trace(value: Any) -> dict[str, Any] | None:
    if isinstance(value, Mapping):
        if {"schema_version", "steps", "completion_evidence"}.issubset(value):
            return dict(value)
        for child in reversed(list(value.values())):
            candidate = _find_trace(child)
            if candidate is not None:
                return candidate
        return None
    if isinstance(value, list):
        for child in reversed(value):
            candidate = _find_trace(child)
            if candidate is not None:
                return candidate
        return None
    if isinstance(value, str):
        for candidate in _json_objects_from_text(value):
            trace = _find_trace(candidate)
            if trace is not None:
                return trace
    return None


def _json_objects_from_text(text: str):
    decoder = json.JSONDecoder()
    stripped = text.strip()
    if stripped.startswith("```json") and stripped.endswith("```"):
        stripped = stripped[7:-3].strip()
    elif stripped.startswith("```") and stripped.endswith("```"):
        stripped = stripped[3:-3].strip()
    for index, character in enumerate(stripped):
        if character not in "[{":
            continue
        try:
            value, _ = decoder.raw_decode(stripped[index:])
        except json.JSONDecodeError:
            continue
        yield value


def _request_value(request: Any, name: str, default: Any) -> Any:
    if isinstance(request, Mapping):
        return request.get(name, default)
    return getattr(request, name, default)


def _is_sensitive_input_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return any(
        marker in normalized
        for marker in (
            "password",
            "passwd",
            "pwd",
            "secret",
            "token",
            "api_key",
            "apikey",
            "otp",
            "credential",
            "비밀번호",
            "암호",
            "인증번호",
        )
    )


def _process_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def _write_support_summary(
    path: Path,
    *,
    status: str,
    code: str,
    metadata: Mapping[str, Any],
) -> None:
    lines = [
        f"OPENCODE_BROWSER_{status}",
        f"code={code}",
        f"returncode={metadata.get('returncode', '')}",
        f"event_count={metadata.get('event_count', '')}",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
