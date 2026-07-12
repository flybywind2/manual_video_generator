from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from backend.app.execution_trace import ExecutionTrace


_PAGE_URL_RE = re.compile(r"(?im)^\s*-?\s*Page URL:\s*(https?://\S+)\s*$")
_ARTIFACT_LINK_RE = re.compile(r"\(([^)]+\.(?:png|jpe?g|ya?ml))\)", re.IGNORECASE)
_FAILURE_MARKERS = ("### error", "timeouterror", "toolerror", "tool_error")


class DiscoveryEvidenceError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class DiscoveryEvidenceSummary:
    status: str
    final_url: str
    observed_urls: list[str]
    screenshot_paths: list[Path]
    successful_tool_count: int
    failed_tool_count: int

    def to_safe_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "final_url": self.final_url,
            "observed_urls": list(self.observed_urls),
            "screenshot_paths": [str(path) for path in self.screenshot_paths],
            "successful_tool_count": self.successful_tool_count,
            "failed_tool_count": self.failed_tool_count,
        }


def validate_discovery_evidence(
    trace: ExecutionTrace,
    *,
    event_log_path: Path,
    job_dir: Path,
) -> DiscoveryEvidenceSummary:
    events = _read_jsonl(event_log_path)
    successful_outputs: list[str] = []
    failed_tool_count = 0
    for event in events:
        tool_state = _tool_state(event)
        if tool_state is None:
            continue
        output = str(tool_state.get("output") or "")
        status = str(tool_state.get("status") or "").strip().lower()
        if status != "completed" or _output_is_failure(output):
            failed_tool_count += 1
            continue
        successful_outputs.append(output)

    if not successful_outputs:
        raise DiscoveryEvidenceError(
            "discovery_evidence_missing",
            "OpenCode produced no successful Playwright evidence",
        )

    observed_urls = _deduplicate(
        match.group(1).rstrip(".,)")
        for output in successful_outputs
        for match in _PAGE_URL_RE.finditer(output)
    )
    if trace.completion_evidence.final_url not in observed_urls:
        raise DiscoveryEvidenceError(
            "completion_url_unverified",
            "the trace completion URL was not observed in a successful Playwright result",
        )

    for step in trace.steps:
        for action in step.actions:
            if action.observed_url not in observed_urls:
                raise DiscoveryEvidenceError(
                    "observed_url_unverified",
                    f"trace action {action.id} references a URL that was not observed",
                )

    evidence_corpus = "\n".join(successful_outputs)
    evidence_corpus += _referenced_snapshot_text(successful_outputs, job_dir)
    for step in trace.steps:
        for action in step.actions:
            if action.type in {"click", "fill", "press"}:
                target_tokens = [token for token in (action.ref, action.label) if token.strip()]
                if not target_tokens or not any(token in evidence_corpus for token in target_tokens):
                    raise DiscoveryEvidenceError(
                        "target_provenance_missing",
                        f"trace action {action.id} has no matching snapshot evidence",
                    )
            if action.evidence:
                for visible_text in action.evidence.visible_text:
                    if visible_text.strip() and visible_text not in evidence_corpus:
                        raise DiscoveryEvidenceError(
                            "visible_text_unverified",
                            f"trace action {action.id} cites text that was not observed",
                        )

    reported_artifacts = {
        _normalized_relative_path(match.group(1))
        for output in successful_outputs
        for match in _ARTIFACT_LINK_RE.finditer(output)
    }
    screenshot_paths = _trace_screenshot_paths(trace)
    resolved_screenshots: list[Path] = []
    for screenshot_path in screenshot_paths:
        normalized = _normalized_relative_path(screenshot_path)
        if normalized not in reported_artifacts:
            raise DiscoveryEvidenceError(
                "screenshot_unverified",
                f"trace screenshot was not reported by Playwright MCP: {screenshot_path}",
            )
        resolved = _resolve_job_artifact(job_dir, normalized)
        if not resolved.is_file() or resolved.stat().st_size <= 0:
            raise DiscoveryEvidenceError(
                "screenshot_missing",
                f"trace screenshot does not exist or is empty: {screenshot_path}",
            )
        resolved_screenshots.append(resolved)

    return DiscoveryEvidenceSummary(
        status="verified",
        final_url=trace.completion_evidence.final_url,
        observed_urls=observed_urls,
        screenshot_paths=_deduplicate_paths(resolved_screenshots),
        successful_tool_count=len(successful_outputs),
        failed_tool_count=failed_tool_count,
    )


def _read_jsonl(path: Path) -> list[Any]:
    events: list[Any] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise DiscoveryEvidenceError(
                "discovery_event_log_invalid",
                f"invalid discovery event on line {line_number}",
            ) from exc
    return events


def _tool_state(event: Any) -> Mapping[str, Any] | None:
    if not isinstance(event, Mapping) or event.get("type") != "tool_use":
        return None
    part = event.get("part")
    tool = str(part.get("tool") or "") if isinstance(part, Mapping) else ""
    if not isinstance(part, Mapping) or not tool.startswith(("playwright_", "backend_playwright_")):
        return None
    state = part.get("state")
    return state if isinstance(state, Mapping) else None


def _output_is_failure(output: str) -> bool:
    lowered = output.lower()
    return any(marker in lowered for marker in _FAILURE_MARKERS)


def _referenced_snapshot_text(outputs: list[str], job_dir: Path) -> str:
    chunks: list[str] = []
    for output in outputs:
        for match in _ARTIFACT_LINK_RE.finditer(output):
            relative = _normalized_relative_path(match.group(1))
            if not relative.lower().endswith((".yml", ".yaml")):
                continue
            path = _resolve_job_artifact(job_dir, relative)
            if path.is_file():
                chunks.append(path.read_text(encoding="utf-8", errors="replace"))
    return "\n" + "\n".join(chunks) if chunks else ""


def _trace_screenshot_paths(trace: ExecutionTrace) -> list[str]:
    values = [trace.completion_evidence.screenshot_path]
    values.extend(
        action.evidence.screenshot_path
        for step in trace.steps
        for action in step.actions
        if action.evidence and action.evidence.screenshot_path
    )
    return _deduplicate(values)


def _normalized_relative_path(value: str) -> str:
    return Path(value.strip().replace("\\", "/")).as_posix()


def _resolve_job_artifact(job_dir: Path, relative: str) -> Path:
    root = job_dir.resolve()
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise DiscoveryEvidenceError(
            "evidence_path_escape",
            "discovery evidence path escapes the job directory",
        ) from exc
    return candidate


def _deduplicate(values) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def _deduplicate_paths(values: list[Path]) -> list[Path]:
    seen: set[Path] = set()
    result: list[Path] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result
