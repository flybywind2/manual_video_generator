from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, TextIO

from backend.app.redaction import redact_sensitive


class TerminalRunLogger:
    def __init__(self, *, enabled: bool, stream: TextIO | None = None) -> None:
        self.enabled = enabled
        self.stream = stream or sys.stderr

    def record(
        self,
        *,
        run_id: str,
        actor: str,
        status: str,
        degrade_reason: str = "",
        details: dict[str, Any] | None = None,
        artifacts: list[Any] | None = None,
    ) -> None:
        if not self.enabled:
            return
        artifact_names = _artifact_names(artifacts or [])
        payload = {
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "run_id": run_id,
            "actor": actor,
            "status": status,
            "degrade_reason": degrade_reason,
            "details": redact_sensitive(details or {}),
            "artifact_count": len(artifact_names),
            "artifact_names": artifact_names,
        }
        rendered = json.dumps(payload, ensure_ascii=False, default=str)
        print(f"[manual-agent] {rendered}", file=self.stream, flush=True)

    def record_audit_event(self, event: dict[str, Any], *, details: dict[str, Any] | None = None) -> None:
        merged_details = dict(event.get("details") or {})
        if details:
            merged_details.update(details)
        self.record(
            run_id=str(event.get("run_id", "")),
            actor=str(event.get("actor", "")),
            status=str(event.get("status", "")),
            degrade_reason=str(event.get("degrade_reason", "")),
            details=merged_details,
            artifacts=list(event.get("artifacts") or []),
        )


def _artifact_names(artifacts: list[Any]) -> list[str]:
    names: list[str] = []
    for artifact in artifacts:
        if not artifact or str(artifact) == "None":
            continue
        names.append(Path(str(artifact)).name)
    return names
