from __future__ import annotations

import json
import re
import shlex
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit, urlunsplit

from backend.app.adapters.opencode import build_opencode_run_command
from backend.app.config import AppSettings
from backend.app.subprocess_utils import run_text_command


CommandRunner = Callable[..., subprocess.CompletedProcess]
CheckpointCollector = Callable[..., dict[str, Any]]
JOB_AGENT_NAME = "manual-video-browser"
FINALIZER_AGENT_NAME = "manual-video-finalizer"
_OBSERVED_CONTROL_REF_RE = re.compile(
    r'^\s*-\s*(?:button|link|textbox|checkbox|radio|combobox|menuitem|tab)\s+"([^"\r\n]+)"[^\r\n]*\[ref=([^\]\s]+)\]',
    re.IGNORECASE | re.MULTILINE,
)


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
    observe_event_log_path: Path
    finalize_event_log_path: Path
    trace_path: Path
    metadata_path: Path
    support_summary_path: Path


class OpenCodeBrowserDiscovery:
    def __init__(
        self,
        settings: AppSettings,
        *,
        command_runner: CommandRunner | None = None,
        checkpoint_collector: CheckpointCollector | None = None,
    ) -> None:
        self.settings = settings
        self.command_runner = subprocess.run if command_runner is None else command_runner
        self.checkpoint_collector = (
            _collect_browser_checkpoint if checkpoint_collector is None else checkpoint_collector
        )

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
            "agent": JOB_AGENT_NAME,
            "configured_agent_ignored": bool(self.settings.opencode_agent),
            "model_source": "opencode-default",
            "model_override": "",
            "configured_model_ignored": bool(self.settings.opencode_model),
            "cdp_endpoint": cdp_endpoint,
            "config_path": str(paths["config"]),
            "prompt_path": str(paths["prompt"]),
            "event_log_path": str(paths["events"]),
            "observe_event_log_path": str(paths["observe_events"]),
            "finalize_event_log_path": str(paths["finalize_events"]),
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
        command = build_opencode_run_command(
            self.settings,
            prompt,
            agent_override=JOB_AGENT_NAME,
        )
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
            paths["observe_events"].write_text(stdout, encoding="utf-8")
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
        paths["observe_events"].write_text(stdout, encoding="utf-8")
        paths["finalize_events"].write_text("", encoding="utf-8")
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
        observer_trace = _extract_final_trace(events)
        session_id = _extract_session_id(events)
        metadata["observer_trace_present"] = observer_trace is not None
        metadata["observe_session_id"] = session_id
        if observer_trace is not None:
            _write_json(paths["observer_trace"], observer_trace)
        elif not session_id:
            metadata["event_count"] = len(events)
            self._fail(
                "opencode_trace_missing",
                "OpenCode completed without an execution trace or resumable session",
                metadata,
                paths,
            )

        try:
            checkpoint = self.checkpoint_collector(
                cdp_endpoint=cdp_endpoint,
                job_dir=job_dir,
            )
        except Exception as exc:  # noqa: BLE001 - converted to an adapter boundary error.
            metadata["error"] = f"{type(exc).__name__}: {exc}"
            self._fail(
                "browser_checkpoint_failed",
                "Backend Playwright checkpoint capture failed",
                metadata,
                paths,
            )
        checkpoint_event = _checkpoint_event(session_id or "opencode-observe", checkpoint)
        checkpoint_line = json.dumps(checkpoint_event, ensure_ascii=False)
        request_input_values = _request_value(request, "input_values", {})
        allowed_input_keys = [
            str(key)
            for key in (request_input_values.keys() if isinstance(request_input_values, Mapping) else [])
            if not _is_sensitive_input_key(str(key))
        ]
        if observer_trace is not None:
            trace, removed_action_evidence_count = _normalize_observer_trace(
                observer_trace,
                original_target_url=str(_request_value(request, "target_url", "")),
                completion_condition=str(_request_value(request, "completion_condition", "")),
                allowed_input_keys=allowed_input_keys,
                checkpoint=checkpoint,
            )
            events = [*events, checkpoint_event]
            paths["events"].write_text(
                _join_jsonl(stdout, checkpoint_line),
                encoding="utf-8",
            )
            metadata.update(
                {
                    "checkpoint": checkpoint,
                    "trace_source": "observer-normalized",
                    "removed_action_evidence_count": removed_action_evidence_count,
                    "status": "completed",
                    "event_count": len(events),
                }
            )
            _write_json(paths["trace"], trace)
            _write_json(paths["metadata"], metadata)
            _write_support_summary(paths["support"], status="OK", code="completed", metadata=metadata)
            return OpenCodeBrowserDiscoveryResult(
                status="completed",
                trace=trace,
                config_path=paths["config"],
                prompt_path=paths["prompt"],
                event_log_path=paths["events"],
                observe_event_log_path=paths["observe_events"],
                finalize_event_log_path=paths["finalize_events"],
                trace_path=paths["trace"],
                metadata_path=paths["metadata"],
                support_summary_path=paths["support"],
            )

        observation_evidence = _compact_observation_evidence(events)
        finalize_prompt = _build_finalize_prompt(
            request,
            checkpoint,
            observation_evidence,
            observer_trace or {},
        )
        paths["finalize_prompt"].write_text(finalize_prompt, encoding="utf-8")
        finalize_command = build_opencode_run_command(
            self.settings,
            finalize_prompt,
            agent_override=FINALIZER_AGENT_NAME,
        )
        metadata["finalize_session_reused"] = False
        metadata["finalize_command"] = finalize_command[:-1] + [f"@{paths['finalize_prompt'].name}"]
        try:
            finalized = run_text_command(
                self.command_runner,
                finalize_command,
                cwd=str(job_dir),
                capture_output=True,
                timeout=self.settings.opencode_timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            finalize_stdout = _process_text(exc.output)
            finalize_stderr = _process_text(exc.stderr)
            paths["finalize_events"].write_text(finalize_stdout, encoding="utf-8")
            paths["events"].write_text(
                _join_jsonl(stdout, checkpoint_line, finalize_stdout),
                encoding="utf-8",
            )
            metadata.update(
                {
                    "finalize_returncode": None,
                    "finalize_stdout": finalize_stdout[-12000:],
                    "finalize_stderr": finalize_stderr[-12000:],
                }
            )
            self._fail(
                "opencode_finalize_timeout",
                "OpenCode trace finalization timed out",
                metadata,
                paths,
            )
        finalize_stdout = finalized.stdout or ""
        finalize_stderr = finalized.stderr or ""
        paths["finalize_events"].write_text(finalize_stdout, encoding="utf-8")
        combined_stdout = _join_jsonl(stdout, checkpoint_line, finalize_stdout)
        paths["events"].write_text(combined_stdout, encoding="utf-8")
        metadata.update(
            {
                "finalize_returncode": finalized.returncode,
                "finalize_stdout": finalize_stdout[-12000:],
                "finalize_stderr": finalize_stderr[-12000:],
                "checkpoint": checkpoint,
            }
        )
        if finalized.returncode != 0:
            self._fail(
                "opencode_finalize_nonzero_exit",
                f"OpenCode trace finalization exited with code {finalized.returncode}",
                metadata,
                paths,
            )
        try:
            finalize_events = _parse_jsonl(finalize_stdout)
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            metadata["error"] = f"{type(exc).__name__}: {exc}"
            self._fail(
                "opencode_finalize_malformed_output",
                "OpenCode trace finalization was not valid JSONL",
                metadata,
                paths,
            )
        trace = _extract_final_trace(finalize_events)
        metadata["finalize_session_id"] = _extract_session_id(finalize_events)
        events = [*events, checkpoint_event, *finalize_events]
        if trace is None:
            metadata["event_count"] = len(events)
            self._fail(
                "opencode_trace_missing",
                "OpenCode finalization completed without an execution trace",
                metadata,
                paths,
            )
        trace, removed_action_evidence_count = _normalize_final_trace(
            trace,
            allowed_input_keys=allowed_input_keys,
            observed_refs_by_label=_observed_unique_refs_by_label(events),
        )
        metadata["removed_action_evidence_count"] = removed_action_evidence_count
        metadata["trace_source"] = "finalizer"

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
            observe_event_log_path=paths["observe_events"],
            finalize_event_log_path=paths["finalize_events"],
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
        "observe_events": job_dir / "opencode_observe_events.jsonl",
        "finalize_events": job_dir / "opencode_finalize_events.jsonl",
        "finalize_prompt": job_dir / "opencode_finalize_prompt.md",
        "observer_trace": job_dir / "opencode_observer_trace.json",
        "trace": job_dir / "opencode_execution_trace.json",
        "metadata": job_dir / "opencode_browser_metadata.json",
        "support": job_dir / "opencode_support_summary.txt",
    }


def _build_job_config(settings: AppSettings, cdp_endpoint: str) -> dict[str, Any]:
    tools = {
        "*": False,
        "playwright_*": True,
        "playwright_browser_run_code_unsafe": False,
    }
    permission = {
        "*": "deny",
        "playwright_*": "allow",
        "playwright_browser_run_code_unsafe": "deny",
        "bash": "deny",
        "edit": "deny",
        "write": "deny",
        "webfetch": "deny",
        "websearch": "deny",
        "task": "deny",
    }
    agent_tools = {**tools, "read": True, "grep": True}
    agent_permission = {
        **permission,
        "read": {"*": "deny", ".playwright-mcp/*": "allow"},
        "grep": "allow",
    }
    return {
        "$schema": "https://opencode.ai/config.json",
        "default_agent": JOB_AGENT_NAME,
        "agent": {
            JOB_AGENT_NAME: {
                "description": "Observe a browser and return a verifiable manual-video execution trace",
                "mode": "primary",
                "prompt": _browser_agent_system_prompt(),
                "steps": 32,
                "temperature": 0,
                "tools": agent_tools,
                "permission": agent_permission,
            },
            FINALIZER_AGENT_NAME: {
                "description": "Convert verified browser observations into the final execution trace",
                "mode": "primary",
                "prompt": _browser_finalizer_system_prompt(),
                "steps": 2,
                "temperature": 0,
                "tools": {"*": False},
                "permission": {"*": "deny"},
            }
        },
        "mcp": {
            "playwright": {
                "type": "local",
                "enabled": True,
                "command": _build_playwright_mcp_command(settings.playwright_mcp_command, cdp_endpoint),
            }
        },
        "tools": tools,
        "permission": permission,
    }


def _browser_agent_system_prompt() -> str:
    return """You are a read-only browser discovery planner for manual-video generation.

Mandatory discovery sequence:
1. Navigate to the exact target URL.
2. Call `playwright_browser_take_screenshot` for a real PNG, then use `playwright_browser_snapshot`
   for accessibility refs. A .yml snapshot is not screenshot evidence.
3. Search the saved snapshot with grep for relevant links, buttons, fields, headings, and /url lines.
   Never request or read an entire unbounded snapshot into the conversation.
   Search exact labels explicitly named in the request before trying synonyms.
4. Observe exact refs, labels, text, and link hrefs. Do not invent selectors or evidence.
5. Do not click cookie-consent or preference controls during discovery. Record them in the final trace only.
6. To inspect a link destination, navigate directly only to an href observed in the saved snapshot.
   Do not spend discovery steps retrying a link click when its read-only href is already known. Record
   the visible click for the final trace, then navigate directly to the observed href for inspection.
7. At each meaningful destination, take a real PNG and search a fresh accessibility snapshot.
8. Immediately before the final JSON, call `playwright_browser_take_screenshot` exactly as
   `{"type":"png","scale":"css","filename":"discovery_final.png","fullPage":false}`. Use the
   screenshot path returned by that successful tool call; never derive a .png name from a .yml snapshot.

Playwright MCP 0.0.78 action contract:
- For `playwright_browser_click`, call exactly `{"target":"e42","element":"observed link label"}`.
- target must be only the bare ref such as `e42`, or a unique CSS selector. Never put a full
  snapshot line such as `link "Name" [ref=e42]` in `target`.
- For `playwright_browser_type`, use the same bare-ref rule and pass text separately in `text`.
- If a call failed because `target` was formatted incorrectly, correct it to the bare ref once. Do not
  repeat an unchanged failed call.

Never retry the same failed browser action. A tool output containing Error or TimeoutError failed even
when the wrapper status says completed. Only Playwright MCP evidence can justify completed. If the
requested completion state was not observed and captured, do not claim completed. Use a snapshot ref
exactly as shown, such as e42; never prefix it with a filename or ref=. Never invent screenshot paths.
Return only the exact JSON shape requested by the user message and no prose."""


def _browser_finalizer_system_prompt() -> str:
    return """You finalize a manual-video execution trace from evidence supplied in the current user message.
Do not call tools. Return exactly one JSON object matching the schema in the current user message.
Use only observed absolute URLs, bare refs, labels, visible text, and exact artifact paths. Never invent
or rename evidence files. Omit optional fields instead of emitting null. Only the original target URL
may use a navigate action; represent observed links and controls as click, fill, or press actions."""


def _build_finalize_prompt(
    request: Any,
    checkpoint: Mapping[str, Any],
    observation_evidence: list[dict[str, Any]],
    observer_trace_candidate: Mapping[str, Any],
) -> str:
    request_values = _request_value(request, "input_values", {})
    safe_keys = [
        str(key)
        for key in (request_values.keys() if isinstance(request_values, Mapping) else [])
        if not _is_sensitive_input_key(str(key))
    ]
    target_url = str(_request_value(request, "target_url", ""))
    required_click_labels, candidate_link_destinations = _observer_trace_constraints(
        observer_trace_candidate,
        target_url,
    )
    inventory = {
        "request_text": str(_request_value(request, "request_text", "")),
        "role": str(_request_value(request, "role", "")),
        "completion_condition": str(_request_value(request, "completion_condition", "")),
        "target_url": target_url,
        "allowed_input_value_keys": safe_keys,
        "backend_checkpoint": dict(checkpoint),
        "playwright_observation_evidence": observation_evidence,
        "observer_trace_candidate": dict(observer_trace_candidate),
        "required_observed_click_labels": required_click_labels,
        "candidate_link_destinations": candidate_link_destinations,
    }
    return f"""Finalize the execution trace now. Do not call any tools and do not return prose.

The backend checkpoint below is authoritative. `completion_evidence.final_url` must equal its `url`,
and `completion_evidence.screenshot_path` must exactly equal its `screenshot_path`. Do not add or
change a file extension. Omit action-level evidence entirely; the backend preserves source evidence in
the OpenCode event log and replay captures. Use only bare snapshot refs such as `e42`, never
`filename:e42`, `ref=e42`, or a snapshot filename. A link that a viewer should click must be a `click`
action with its observed ref/label, not a direct `navigate` action. The only permitted `navigate`
target in the final trace is the original target_url. `input_values` must exactly match the allowed key
list below. Do not add an initial navigate action because backend replay already opens target_url.
Every step must contain at least one action; omit narration-only steps. Every action must include an absolute observed_url,
including navigate and capture actions. Use a capture action for a static explanatory screen only when
its successful screenshot evidence is listed below. A record whose status is `failed` is diagnostic
context only and must never justify a trace claim. The backend checkpoint must prove the requested
completion_condition before status may be completed. The observer_trace_candidate is an untrusted editing
draft, not evidence. Preserve every requested workflow step from that draft when successful Playwright
evidence supports it, especially requested consent/modal handling. Remove unknown fields and repair the
schema instead of replacing the workflow with a shorter one. Keep visible links and controls as click
actions; do not turn an observed link into navigate. A navigate action is allowed only for the exact
original target_url and must include target_url. Never put a URL in label. Include every value in
required_observed_click_labels as an exact click label when its target appears in successful evidence.
Represent each candidate_link_destination as its observed visible click, not direct navigation. Build 4 to 8 concise Korean narration steps when
the evidence supports them. Return exactly this
nested shape, omitting optional action fields that do not apply:

```json
{{
  "schema_version": "1.0",
  "status": "completed",
  "request_summary": "사용자 요청 요약",
  "input_values": [],
  "steps": [
    {{
      "id": "step-01",
      "title": "단계 제목",
      "narration": "해당 화면 동작과 보이는 내용을 설명하는 한국어 내레이션",
      "actions": [
        {{
          "id": "action-01",
          "type": "click",
          "ref": "e42",
          "label": "관찰된 버튼 이름",
          "observed_url": "https://example.invalid/current",
          "expected_after": "관찰할 다음 상태"
        }}
      ]
    }}
  ],
  "completion_evidence": {{
    "final_url": "https://example.invalid/completed",
    "assertions": ["실제로 확인한 완료 조건"],
    "screenshot_path": "실제로 생성된 최종 스크린샷 경로"
  }}
}}
```

```json
{json.dumps(inventory, ensure_ascii=False, indent=2)}
```
"""


def _compact_observation_evidence(events: list[Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for event in events:
        if not isinstance(event, Mapping) or event.get("type") != "tool_use":
            continue
        part = event.get("part")
        if not isinstance(part, Mapping):
            continue
        tool = str(part.get("tool") or "")
        if not tool.startswith("playwright_"):
            continue
        state = part.get("state")
        if not isinstance(state, Mapping):
            continue
        output = str(state.get("output") or "")
        state_status = str(state.get("status") or "").strip().lower()
        failed = state_status != "completed" or _tool_output_failed(output)
        records.append(
            {
                "tool": tool,
                "status": "failed" if failed else "completed",
                "input": _safe_tool_input(tool, state.get("input")),
                "evidence": _compact_tool_output(tool, output),
            }
        )
    if len(records) <= 24:
        return records
    return [*records[:8], *records[-16:]]


def _observer_trace_constraints(
    candidate: Mapping[str, Any],
    original_target_url: str,
) -> tuple[list[str], list[str]]:
    click_labels: list[str] = []
    link_destinations: list[str] = []
    steps = candidate.get("steps")
    if not isinstance(steps, list):
        return click_labels, link_destinations
    for step in steps:
        actions = step.get("actions") if isinstance(step, Mapping) else None
        if not isinstance(actions, list):
            continue
        for action in actions:
            if not isinstance(action, Mapping):
                continue
            action_type = str(action.get("type") or "")
            label = str(action.get("label") or "").strip()
            target_url = str(action.get("target_url") or "").strip()
            if action_type == "click" and label and label not in click_labels:
                click_labels.append(label)
            if (
                action_type == "navigate"
                and target_url
                and target_url != original_target_url
                and target_url not in link_destinations
            ):
                link_destinations.append(target_url)
    return click_labels, link_destinations


def _normalize_final_trace(
    trace: Mapping[str, Any],
    *,
    allowed_input_keys: list[str] | tuple[str, ...] = (),
    observed_refs_by_label: Mapping[str, str] | None = None,
) -> tuple[dict[str, Any], int]:
    normalized = json.loads(json.dumps(trace, ensure_ascii=False, default=str))
    removed = 0
    allowed_keys = tuple(
        dict.fromkeys(str(key).strip() for key in allowed_input_keys if str(key).strip())
    )
    normalized["input_values"] = _trusted_declared_input_keys(
        normalized.get("input_values"),
        allowed_keys,
    )
    steps = normalized.get("steps")
    if not isinstance(steps, list):
        return normalized, removed
    for step in steps:
        if not isinstance(step, Mapping):
            continue
        actions = step.get("actions")
        if not isinstance(actions, list):
            continue
        for action in actions:
            if not isinstance(action, dict):
                continue
            if "evidence" in action:
                action.pop("evidence", None)
                removed += 1
            label = " ".join(str(action.get("label") or "").split())
            if (
                action.get("type") in {"fill", "click", "press"}
                and not action.get("ref")
                and not action.get("selector")
                and label
                and observed_refs_by_label
                and observed_refs_by_label.get(label)
            ):
                action["ref"] = observed_refs_by_label[label]
            if action.get("type") != "fill":
                continue
            value_key = str(action.get("value_key") or "").strip()
            if value_key not in allowed_keys:
                value_key = _infer_fill_value_key(action, allowed_keys)
                if value_key:
                    action["value_key"] = value_key
            if value_key in allowed_keys and value_key not in normalized["input_values"]:
                normalized["input_values"].append(value_key)
    return normalized, removed


def _observed_unique_refs_by_label(events: list[Any]) -> dict[str, str]:
    latest_ref_by_label: dict[str, str] = {}
    ambiguous_labels: set[str] = set()
    for event in events:
        if not isinstance(event, Mapping) or event.get("type") != "tool_use":
            continue
        part = event.get("part")
        state = part.get("state") if isinstance(part, Mapping) else None
        if not isinstance(state, Mapping) or str(state.get("status") or "").lower() != "completed":
            continue
        output = str(state.get("output") or "")
        if _tool_output_failed(output):
            continue
        output_refs: dict[str, set[str]] = {}
        for match in _OBSERVED_CONTROL_REF_RE.finditer(output):
            label = " ".join(match.group(1).split())
            ref = match.group(2).strip()
            if label and ref:
                output_refs.setdefault(label, set()).add(ref)
        for label, refs in output_refs.items():
            if len(refs) != 1:
                ambiguous_labels.add(label)
                latest_ref_by_label.pop(label, None)
            elif label not in ambiguous_labels:
                latest_ref_by_label[label] = next(iter(refs))
    return latest_ref_by_label


def _normalize_observer_trace(
    trace: Mapping[str, Any],
    *,
    original_target_url: str,
    completion_condition: str = "",
    allowed_input_keys: list[str] | tuple[str, ...] = (),
    checkpoint: Mapping[str, Any],
) -> tuple[dict[str, Any], int]:
    raw = json.loads(json.dumps(trace, ensure_ascii=False, default=str))
    normalized: dict[str, Any] = {
        key: raw[key]
        for key in ("schema_version", "status", "request_summary")
        if raw.get(key) is not None
    }
    allowed_keys = tuple(
        dict.fromkeys(str(key).strip() for key in allowed_input_keys if str(key).strip())
    )
    normalized["input_values"] = _trusted_declared_input_keys(
        raw.get("input_values"),
        allowed_keys,
    )
    removed_evidence = 0
    normalized_steps: list[dict[str, Any]] = []
    for raw_step in raw.get("steps", []):
        if not isinstance(raw_step, Mapping):
            continue
        step = {
            key: raw_step[key]
            for key in ("id", "title", "narration")
            if raw_step.get(key) is not None
        }
        normalized_actions: list[dict[str, Any]] = []
        for raw_action in raw_step.get("actions", []):
            if not isinstance(raw_action, Mapping):
                continue
            evidence = raw_action.get("evidence")
            visible_text = evidence.get("visible_text", []) if isinstance(evidence, Mapping) else []
            if "evidence" in raw_action:
                removed_evidence += 1
            action = {
                key: raw_action[key]
                for key in (
                    "id",
                    "type",
                    "target_url",
                    "selector",
                    "ref",
                    "label",
                    "value_key",
                    "key",
                    "duration_ms",
                    "observed_url",
                    "expected_after",
                )
                if raw_action.get(key) not in (None, "")
            }
            if action.get("type") == "navigate":
                destination = str(action.get("target_url") or "")
                if destination == original_target_url:
                    action["observed_url"] = str(action.get("observed_url") or original_target_url)
                elif destination and _same_origin(destination, original_target_url):
                    label = str(action.get("label") or "").strip()
                    if not label or label.startswith(("http://", "https://")):
                        label = next(
                            (str(value).strip() for value in visible_text if str(value).strip()),
                            "",
                        )
                    click_action = {
                        "id": str(action.get("id") or ""),
                        "type": "click",
                        "selector": _href_selector(destination),
                        "label": label,
                        "observed_url": str(action.get("observed_url") or original_target_url),
                    }
                    if action.get("expected_after"):
                        click_action["expected_after"] = action["expected_after"]
                    action = click_action
                elif not destination:
                    capture_action = {
                        "id": str(action.get("id") or ""),
                        "type": "capture",
                        "observed_url": str(action.get("observed_url") or original_target_url),
                    }
                    for key in ("selector", "ref", "label", "expected_after"):
                        if action.get(key):
                            capture_action[key] = action[key]
                    action = capture_action
            if action.get("type") == "fill":
                value_key = str(action.get("value_key") or "").strip()
                if value_key not in allowed_keys:
                    value_key = _infer_fill_value_key(action, allowed_keys)
                    if value_key:
                        action["value_key"] = value_key
                if value_key in allowed_keys and value_key not in normalized["input_values"]:
                    normalized["input_values"].append(value_key)
            normalized_actions.append(action)
        step["actions"] = normalized_actions
        normalized_steps.append(step)
    completion = raw.get("completion_evidence")
    completion = dict(completion) if isinstance(completion, Mapping) else {}
    final_url = str(checkpoint.get("url") or completion.get("final_url") or "")
    _ensure_boundary_steps(
        normalized_steps,
        original_target_url=original_target_url,
        final_url=final_url,
        completion_condition=completion_condition,
    )
    normalized["steps"] = normalized_steps
    normalized["completion_evidence"] = {
        "final_url": final_url,
        "assertions": [str(value) for value in completion.get("assertions", [])],
        "screenshot_path": str(
            checkpoint.get("screenshot_path") or completion.get("screenshot_path") or ""
        ),
    }
    return normalized, removed_evidence


def _infer_fill_value_key(
    action: Mapping[str, Any],
    allowed_input_keys: list[str] | tuple[str, ...],
) -> str:
    keys = [str(key).strip() for key in allowed_input_keys if str(key).strip()]
    if len(keys) == 1:
        return keys[0]
    context = _input_key_token(
        " ".join(
            str(action.get(name) or "")
            for name in ("value_key", "label", "selector", "ref")
        )
    )
    matches = [key for key in keys if _input_key_token(key) and _input_key_token(key) in context]
    return matches[0] if len(matches) == 1 else ""


def _input_key_token(value: str) -> str:
    return "".join(character for character in value.casefold() if character.isalnum())


def _trusted_declared_input_keys(value: Any, allowed_keys: tuple[str, ...]) -> list[str]:
    candidates: list[Any] = []
    if isinstance(value, Mapping):
        candidates.extend(value.keys())
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, Mapping):
                candidates.extend(item.keys())
            else:
                candidates.append(item)
    allowed = set(allowed_keys)
    return list(
        dict.fromkeys(
            key
            for item in candidates
            for key in [str(item).strip()]
            if key in allowed
        )
    )


def _ensure_boundary_steps(
    steps: list[dict[str, Any]],
    *,
    original_target_url: str,
    final_url: str,
    completion_condition: str,
) -> None:
    used_ids = {
        str(item.get("id") or "")
        for step in steps
        for item in [step, *(step.get("actions") or [])]
        if isinstance(item, Mapping)
    }
    has_initial_navigation = any(
        action.get("type") == "navigate"
        for step in steps
        for action in step.get("actions", [])
        if isinstance(action, Mapping)
    )
    if not has_initial_navigation:
        step_id = _unique_trace_id("step-open-target", used_ids)
        action_id = _unique_trace_id("action-open-target", used_ids)
        steps.insert(
            0,
            {
                "id": step_id,
                "title": "서비스 첫 화면 열기",
                "narration": "먼저 대상 서비스의 첫 화면을 열어 주요 구성과 시작 위치를 확인합니다.",
                "actions": [
                    {
                        "id": action_id,
                        "type": "navigate",
                        "target_url": original_target_url,
                        "observed_url": original_target_url,
                        "expected_after": "대상 서비스 첫 화면이 표시됩니다.",
                    }
                ],
            },
        )

    last_action = next(
        (
            action
            for step in reversed(steps)
            for action in reversed(step.get("actions", []))
            if isinstance(action, Mapping)
        ),
        None,
    )
    completion_already_captured = bool(
        last_action
        and last_action.get("type") == "capture"
        and _same_page_location(str(last_action.get("observed_url") or ""), final_url)
    )
    if completion_already_captured:
        return

    step_id = _unique_trace_id("step-completion", used_ids)
    action_id = _unique_trace_id("action-completion-capture", used_ids)
    steps.append(
        {
            "id": step_id,
            "title": "완료 화면 확인",
            "narration": _completion_narration(completion_condition),
            "actions": [
                {
                    "id": action_id,
                    "type": "capture",
                    "observed_url": final_url,
                    "expected_after": completion_condition.strip(),
                }
            ],
        }
    )


def _unique_trace_id(base: str, used_ids: set[str]) -> str:
    candidate = base
    suffix = 2
    while candidate in used_ids:
        candidate = f"{base}-{suffix}"
        suffix += 1
    used_ids.add(candidate)
    return candidate


def _completion_narration(completion_condition: str) -> str:
    condition = completion_condition.strip().rstrip(".。")
    replacements = (
        ("보이면 완료", "보이는지 확인합니다."),
        ("표시되면 완료", "표시되는지 확인합니다."),
        ("나오면 완료", "나오는지 확인합니다."),
        ("닫히면 완료", "닫혔는지 확인합니다."),
    )
    for ending, replacement in replacements:
        if condition.endswith(ending):
            return f"마지막으로 {condition[:-len(ending)]}{replacement}"
    if condition.endswith("확인"):
        return "마지막으로 요청한 상세 화면에서 결과가 올바르게 표시되는지 확인합니다."
    if condition:
        return f"마지막으로 {condition} 상태를 화면에서 확인합니다."
    return "마지막으로 완료 화면에서 요청한 결과를 확인합니다."


def _same_page_location(left: str, right: str) -> bool:
    try:
        left_url = urlsplit(left)
        right_url = urlsplit(right)
    except ValueError:
        return False
    return (
        left_url.scheme.lower(),
        left_url.netloc.lower(),
        left_url.path.rstrip("/") or "/",
        left_url.query,
        left_url.fragment,
    ) == (
        right_url.scheme.lower(),
        right_url.netloc.lower(),
        right_url.path.rstrip("/") or "/",
        right_url.query,
        right_url.fragment,
    )


def _same_origin(left: str, right: str) -> bool:
    try:
        left_url = urlsplit(left)
        right_url = urlsplit(right)
    except ValueError:
        return False
    return (left_url.scheme.lower(), left_url.netloc.lower()) == (
        right_url.scheme.lower(),
        right_url.netloc.lower(),
    )


def _href_selector(url: str) -> str:
    parsed = urlsplit(url)
    href = urlunsplit(("", "", parsed.path or "/", parsed.query, parsed.fragment))
    escaped = href.replace("\\", "\\\\").replace("'", "\\'")
    return f"a[href='{escaped}']"


def _safe_tool_input(tool: str, value: Any) -> Any:
    if not isinstance(value, Mapping):
        return value
    sensitive_action = any(marker in tool.lower() for marker in ("fill", "type"))
    sanitized: dict[str, Any] = {}
    for key, item in value.items():
        normalized = str(key).lower().replace("-", "_")
        if sensitive_action and normalized in {"text", "value", "values", "fields"}:
            sanitized[str(key)] = "<request-input-redacted>"
        else:
            sanitized[str(key)] = item
    return sanitized


def _compact_tool_output(tool: str, output: str) -> str:
    if not output:
        return ""
    lines = [line.rstrip() for line in output.splitlines() if line.strip()]
    selected: list[str] = []
    keep_all = "find" in tool.lower() and len(output) <= 4000
    markers = (
        "page url:",
        "page title:",
        "[ref=",
        "/url:",
        "[screenshot",
        "[snapshot",
        "### error",
        "timeouterror",
    )
    for line in lines:
        lowered = line.lower()
        if keep_all or any(marker in lowered for marker in markers):
            selected.append(line[:500])
        if len(selected) >= 16:
            break
    if not selected:
        selected = lines[:4]
    compact = "\n".join(selected)
    return compact[:5000]


def _tool_output_failed(output: str) -> bool:
    lowered = output.lower()
    return any(marker in lowered for marker in ("### error", "timeouterror", "toolerror", "tool_error"))


def _collect_browser_checkpoint(*, cdp_endpoint: str, job_dir: Path) -> dict[str, Any]:
    from playwright.sync_api import sync_playwright

    screenshot_path = job_dir / "discovery_final.png"
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(cdp_endpoint)
        pages = [
            page
            for context in list(getattr(browser, "contexts", []) or [])
            for page in list(getattr(context, "pages", []) or [])
            if str(getattr(page, "url", "") or "").startswith(("http://", "https://"))
        ]
        if not pages:
            raise RuntimeError("CDP browser has no HTTP page for discovery checkpoint")
        page = pages[-1]
        page.screenshot(path=str(screenshot_path), full_page=False)
        body_text = str(page.locator("body").inner_text(timeout=5000) or "")
        visible_text = []
        for line in body_text.splitlines():
            normalized = " ".join(line.split())
            if normalized and normalized not in visible_text:
                visible_text.append(normalized[:240])
            if len(visible_text) >= 20:
                break
        return {
            "url": str(page.url),
            "title": str(page.title()),
            "screenshot_path": screenshot_path.name,
            "visible_text": visible_text,
        }


def _checkpoint_event(session_id: str, checkpoint: Mapping[str, Any]) -> dict[str, Any]:
    visible_lines = "\n".join(f"- {value}" for value in checkpoint.get("visible_text", []) if value)
    output = (
        "### Backend Playwright checkpoint\n"
        f"### Page\n- Page URL: {checkpoint.get('url', '')}\n"
        f"- Page Title: {checkpoint.get('title', '')}\n"
        "### Result\n"
        f"- [Screenshot of viewport]({checkpoint.get('screenshot_path', '')})\n"
        f"### Visible Text\n{visible_lines}"
    )
    return {
        "type": "tool_use",
        "sessionID": session_id,
        "part": {
            "tool": "backend_playwright_capture",
            "state": {"status": "completed", "input": {}, "output": output},
        },
    }


def _extract_session_id(events: list[Any]) -> str:
    for event in events:
        if not isinstance(event, Mapping):
            continue
        session_id = str(event.get("sessionID") or "").strip()
        if session_id:
            return session_id
        part = event.get("part")
        if isinstance(part, Mapping):
            session_id = str(part.get("sessionID") or "").strip()
            if session_id:
                return session_id
    return ""


def _join_jsonl(*chunks: str) -> str:
    return "\n".join(chunk.strip("\r\n") for chunk in chunks if chunk.strip())


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
    _ensure_mcp_capability(cleaned, "vision")
    if not _has_mcp_option(cleaned, "--timeout-action"):
        cleaned.append("--timeout-action=15000")
    if not _has_mcp_option(cleaned, "--viewport-size"):
        cleaned.append("--viewport-size=1280x800")
    if not _has_mcp_option(cleaned, "--output-mode"):
        cleaned.append("--output-mode=file")
    cleaned.extend(["--cdp-endpoint", cdp_endpoint])
    return cleaned


def _ensure_mcp_capability(command: list[str], capability: str) -> None:
    for index, token in enumerate(command):
        normalized = token.lower()
        if normalized == "--caps" and index + 1 < len(command):
            values = [value.strip() for value in command[index + 1].split(",") if value.strip()]
            if capability not in {value.lower() for value in values}:
                values.append(capability)
            command[index + 1] = ",".join(values)
            return
        if normalized.startswith("--caps="):
            values = [value.strip() for value in token.split("=", 1)[1].split(",") if value.strip()]
            if capability not in {value.lower() for value in values}:
                values.append(capability)
            command[index] = f"--caps={','.join(values)}"
            return
    command.append(f"--caps={capability}")


def _has_mcp_option(command: list[str], option: str) -> bool:
    normalized_option = option.lower()
    return any(
        token.lower() == normalized_option or token.lower().startswith(f"{normalized_option}=")
        for token in command
    )


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
    trace_example = json.dumps(
        {
            "schema_version": "1.0",
            "status": "completed",
            "request_summary": "사용자 요청을 한 문장으로 요약",
            "input_values": ["request_input_key"],
            "steps": [
                {
                    "id": "step-01",
                    "title": "화면 단계 제목",
                    "narration": "이 단계의 화면 동작만 설명하는 자연스러운 한국어 내레이션입니다.",
                    "actions": [
                        {
                            "id": "action-01",
                            "type": "click",
                            "selector": "button:has-text('관찰된 버튼 이름')",
                            "ref": "관찰 결과에 실제 ref가 있을 때만 입력",
                            "label": "관찰된 버튼 이름",
                            "observed_url": "https://target.example/current-page",
                            "expected_after": "클릭 후 관찰해야 하는 화면 상태",
                            "evidence": {
                                "screenshot_path": "실제로 생성된 스크린샷 경로",
                                "visible_text": ["실제로 관찰한 화면 텍스트"],
                            },
                        }
                    ],
                }
            ],
            "completion_evidence": {
                "final_url": "https://target.example/completed-page",
                "assertions": ["실제로 확인한 완료 조건"],
                "screenshot_path": "실제로 생성된 최종 스크린샷 경로",
            },
        },
        ensure_ascii=False,
        indent=2,
    )
    return f"""# OpenCode Browser Discovery

Use only the configured safe Playwright MCP tools. Never call
`playwright_browser_run_code_unsafe`. Inspect the live page before every action with a screenshot
and accessibility snapshot, then act only on elements that were actually observed. Discovery is
observation-first: inspect UI controls and links, and use an observed link URL for read-only destination
inspection when needed. The final trace must still describe the visible click that a viewer will see.
Complete the user's read-only documentation scenario on the provided target. Do not submit, save, delete,
approve, purchase, upload, or perform any other state-changing action. Never inspect, extract, or
serialize credentials, OTP values, session cookies, or SSO tokens. A visible cookie-consent button
may be included in the final trace when the request asks for it, but cookie values must never be inspected.
Do not activate cookie-consent or preference controls during discovery because they persist state needed
for deterministic replay. Observe their exact ref, label, selector, and bounds instead.

For text inputs, use the non-sensitive values below while operating the page. In the final trace,
record only the corresponding `value_key`, never the literal value. Every click or key action must
include the observed semantic label and an exact Playwright ref or specific selector. Stay on the
target origin, capture evidence before/after meaningful actions, and verify the completion condition.
Do not replace a requested visible click with direct navigation. The initial target navigation is
allowed; later navigation must be the observed result of a recorded click unless the user explicitly
requested entering that URL. This rule applies to the final trace; read-only destination inspection
during discovery may navigate to an href that was observed in the snapshot.

Produce 4 to 8 meaningful steps when the site supports them. Each step must have a concise Korean
title and one or two natural Korean narration sentences describing only that step's visible actions.
The narration becomes TTS and controls replay timing, so do not combine unrelated actions or repeat
the same explanation. Every action must include its own unique id and the URL observed immediately
before that action. Replay initialization is owned by the backend, so do not add a narration step only
to reset the browser. Every observed_url and final_url must be an absolute URL including scheme and host. For click, fill,
and press, include an exact observed ref or a specific selector.
For click and press, include the observed label. For fill, use `value_key`; never emit `value`. For
press, include `key`; for navigate, include `target_url`; for wait, include `duration_ms`; for capture,
include evidence with an actual screenshot path and visible text. Allowed action types are navigate,
fill, click, press, wait, and capture.

Return one final JSON object and no prose. Follow this exact nested shape and do not add fields:
```json
{trace_example}
```

`input_values must be a JSON array` containing only non-sensitive request input key names. It must
not be an object. When the request input_values object is empty, return an empty array.
Omit fields that do not apply; never emit null. Do not use action_type, description, current_url, page_title, or observed_elements.
Do not flatten actions directly into steps. Use an `actions` array inside every step. Replace every
example value above with evidence from the live page; do not invent refs, selectors, URLs, text, or
screenshot paths. The final completion_evidence must contain final_url, at least one assertion, and
the actual final screenshot_path. A tool result containing ### Error or TimeoutError is a failed action;
never treat it as completed or use it as evidence. Before returning completed, take a final screenshot,
verify that its reported path exists, and verify the current page URL and requested visible text.

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
