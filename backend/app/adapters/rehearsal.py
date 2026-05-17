from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from backend.app.config import AppSettings


def rehearse_plan(plan: dict[str, Any], settings: AppSettings, package_dir: Path) -> dict[str, Any]:
    calls = [_action_to_mcp_call(action) for action in plan.get("actions", [])]
    calls = [call for call in calls if call is not None]
    calls_path = package_dir / "playwright_mcp_calls.json"
    calls_path.write_text(json.dumps({"calls": calls}, ensure_ascii=False, indent=2), encoding="utf-8")

    mode = settings.playwright_mcp_mode.lower()
    if mode in {"off", "disabled", "none"}:
        status = "skipped"
        adapter = "playwright-mcp-disabled"
    else:
        status = "manifest-created"
        adapter = "playwright-mcp-manifest"

    return {
        "status": status,
        "adapter": adapter,
        "mode": mode,
        "command": settings.playwright_mcp_command if mode != "off" else "",
        "calls_path": str(calls_path),
        "observations": [
            "Playwright MCP에서 사용할 후보 tool call manifest를 생성했습니다.",
            "실제 MCP 세션에서는 browser_snapshot으로 ref를 확인한 뒤 click/type call을 확정해야 합니다.",
        ],
        "checked_actions": [action["id"] for action in plan.get("actions", [])],
        "candidate_calls": calls,
    }


def _action_to_mcp_call(action: dict[str, Any]) -> dict[str, Any] | None:
    action_type = action.get("type")
    if action_type == "navigate":
        return {"tool": "browser_navigate", "arguments": {"url": action.get("target", "")}, "action_id": action.get("id")}
    if action_type == "click":
        return {
            "tool": "browser_click",
            "arguments": {
                "selector_hint": action.get("selector", ""),
                "element": action.get("label") or action.get("selector", ""),
                "ref": "resolve-with-browser_snapshot",
            },
            "action_id": action.get("id"),
        }
    if action_type == "fill":
        return {
            "tool": "browser_type",
            "arguments": {
                "selector_hint": action.get("selector", ""),
                "element": action.get("label") or action.get("selector", ""),
                "ref": "resolve-with-browser_snapshot",
                "text": action.get("value", ""),
            },
            "action_id": action.get("id"),
        }
    if action_type == "capture_step":
        return {"tool": "browser_screenshot", "arguments": {"filename_hint": action.get("step_id", "")}, "action_id": action.get("id")}
    return None
