from __future__ import annotations

import hashlib
import json
from datetime import datetime
from pathlib import Path
from typing import Any


class AuditLog:
    def __init__(self, *, run_id: str, path: Path, reset: bool = True) -> None:
        self.run_id = run_id
        self.path = path
        self.events: list[dict[str, Any]] = []
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if reset:
            self.path.write_text("", encoding="utf-8")
        elif self.path.exists():
            self.events = _read_existing_events(self.path)
        else:
            self.path.write_text("", encoding="utf-8")

    def record(
        self,
        *,
        actor: str,
        status: str,
        step_id: str = "",
        input_data: Any = None,
        output_data: Any = None,
        degrade_reason: str = "",
        artifacts: list[Path] | None = None,
        details: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        event = {
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "run_id": self.run_id,
            "actor": actor,
            "step_id": step_id,
            "status": status,
            "input_hash": stable_hash(input_data),
            "output_hash": stable_hash(output_data),
            "degrade_reason": degrade_reason,
            "artifacts": [str(path) for path in artifacts or []],
            "details": details or {},
        }
        self.events.append(event)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
        return event

    def degradations(self) -> list[dict[str, str]]:
        return [
            {
                "actor": str(event["actor"]),
                "reason": str(event["degrade_reason"]),
                "status": str(event["status"]),
            }
            for event in self.events
            if event.get("status") == "degraded" and event.get("degrade_reason")
        ]

    def fallback_events(self) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        for event in self.events:
            reason = str(event.get("degrade_reason") or "")
            status = str(event.get("status") or "")
            if status != "degraded" or not reason:
                continue
            events.append(
                {
                    "timestamp": str(event.get("timestamp") or ""),
                    "actor": str(event.get("actor") or ""),
                    "status": status,
                    "reason": reason,
                    "details": event.get("details") or {},
                    "artifacts": event.get("artifacts") or [],
                }
            )
        return events


def stable_hash(value: Any) -> str:
    if value is None:
        return ""
    rendered = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(rendered.encode("utf-8")).hexdigest()


def _read_existing_events(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events
