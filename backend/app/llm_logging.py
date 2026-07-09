from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from backend.app.redaction import is_sensitive_key, redact_sensitive
from backend.app.terminal_logging import TerminalRunLogger


_SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)\b(password|passwd|pwd|otp|pin|token|secret|api[_ -]?key|ticket|credential|authorization)\b"
    r"\s*[:=]\s*['\"]?[^,'\"}\s]+"
)


def record_llm_response(
    *,
    component: str,
    model: str,
    response: Any,
    content: Any,
    terminal_enabled: bool,
    package_dir: Path | None = None,
    status: str = "ok",
    metrics: dict[str, Any] | None = None,
) -> dict[str, Any]:
    summary = _response_summary(
        component=component,
        model=model,
        response=response,
        content=content,
        status=status,
        metrics=metrics,
    )
    event = {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "actor": "llm_response",
        "run_id": _run_id_from_package_dir(package_dir),
        "status": status,
        "details": summary,
    }
    if package_dir is not None:
        package_dir.mkdir(parents=True, exist_ok=True)
        with (package_dir / "llm_responses.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(redact_sensitive(event), ensure_ascii=False, default=str) + "\n")
    TerminalRunLogger(enabled=terminal_enabled).record(
        run_id=event["run_id"],
        actor="llm_response",
        status=status,
        details=summary,
        artifacts=[package_dir / "llm_responses.jsonl"] if package_dir is not None else [],
    )
    return summary


def _response_summary(
    *,
    component: str,
    model: str,
    response: Any,
    content: Any,
    status: str,
    metrics: dict[str, Any] | None = None,
) -> dict[str, Any]:
    content_text = "" if content is None else str(content)
    summary = {
        "component": component,
        "model": model,
        "status": status,
        "content_preview": _content_preview(content_text),
        "content_length": len(content_text),
    }
    if isinstance(response, dict):
        choices = response.get("choices")
        if isinstance(choices, list):
            summary["choice_count"] = len(choices)
            if choices and isinstance(choices[0], dict) and choices[0].get("finish_reason"):
                summary["finish_reason"] = str(choices[0]["finish_reason"])
    if metrics:
        summary.update(redact_sensitive(metrics))
    return summary


def _content_preview(content: str, *, limit: int = 1000) -> str:
    sanitized = _sanitize_json_content(content)
    if sanitized is None:
        sanitized = _redact_text(content.strip())
    if len(sanitized) > limit:
        return f"{sanitized[:limit]}..."
    return sanitized


def _sanitize_json_content(content: str) -> str | None:
    text = _strip_code_fence(content.strip())
    if not text:
        return ""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    sanitized = _drop_sensitive_values(parsed)
    return json.dumps(sanitized, ensure_ascii=False, separators=(",", ":"))


def _drop_sensitive_values(value: Any) -> Any:
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            if is_sensitive_key(key_text):
                continue
            sanitized[key_text] = _drop_sensitive_values(item)
        return sanitized
    if isinstance(value, list):
        return [_drop_sensitive_values(item) for item in value]
    if isinstance(value, str):
        return _redact_text(value)
    return value


def _strip_code_fence(text: str) -> str:
    if not text.startswith("```"):
        return text
    lines = text.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines).strip()


def _redact_text(text: str) -> str:
    return _SECRET_ASSIGNMENT_RE.sub(lambda match: f"{match.group(1)}=<redacted>", text)


def _run_id_from_package_dir(package_dir: Path | None) -> str:
    if package_dir is None:
        return ""
    return package_dir.name
