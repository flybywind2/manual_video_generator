from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from backend.app.adapters.mcp_client import StdioMcpClient
from backend.app.config import AppSettings
from backend.app.redaction import redact_sensitive


McpClientFactory = Callable[..., Any]


def rehearse_plan(
    plan: dict[str, Any],
    settings: AppSettings,
    package_dir: Path,
    *,
    mcp_client_factory: McpClientFactory | None = None,
) -> dict[str, Any]:
    calls = [_action_to_mcp_call(action) for action in plan.get("actions", [])]
    calls = [call for call in calls if call is not None]
    artifact_calls = redact_sensitive(calls)
    calls_path = package_dir / "playwright_mcp_calls.json"
    calls_path.write_text(json.dumps({"calls": artifact_calls}, ensure_ascii=False, indent=2), encoding="utf-8")

    mode = settings.playwright_mcp_mode.lower()
    if mode in {"off", "disabled", "none"}:
        status = "skipped"
        adapter = "playwright-mcp-disabled"
    elif mode == "live":
        return _run_live_mcp(plan, settings, package_dir, calls, artifact_calls, calls_path, mcp_client_factory)
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
        "candidate_calls": artifact_calls,
    }


def _run_live_mcp(
    plan: dict[str, Any],
    settings: AppSettings,
    package_dir: Path,
    calls: list[dict[str, Any]],
    artifact_calls: list[dict[str, Any]],
    calls_path: Path,
    mcp_client_factory: McpClientFactory | None,
) -> dict[str, Any]:
    execution_path = package_dir / "playwright_mcp_execution.json"
    client_factory = mcp_client_factory or (
        lambda command, timeout_seconds: StdioMcpClient(command=command, timeout_seconds=timeout_seconds, cwd=package_dir)
    )
    execution: dict[str, Any] = {
        "status": "live-started",
        "command": settings.playwright_mcp_command,
        "calls_path": str(calls_path),
        "results": [],
    }
    try:
        with client_factory(settings.playwright_mcp_command, settings.request_timeout_seconds) as client:
            execution["initialize"] = client.initialize()
            available_tools = client.list_tools()
            execution["available_tools"] = sorted(available_tools)
            for action in plan.get("actions", []):
                live_call = _action_to_live_mcp_call(action, available_tools)
                if live_call is None:
                    continue
                result = client.call_tool(live_call["tool"], live_call["arguments"])
                artifact_action = redact_sensitive(action)
                artifact_live_call = _action_to_live_mcp_call(artifact_action, available_tools) or redact_sensitive(live_call)
                if isinstance(result, dict) and result.get("isError"):
                    execution["had_tool_errors"] = True
                execution["results"].append(
                    {
                        "action_id": action.get("id"),
                        "tool": artifact_live_call["tool"],
                        "arguments": artifact_live_call["arguments"],
                        "result": result,
                    }
                )
            execution["status"] = "live-failed" if execution.get("had_tool_errors") else "live-completed"
    except Exception as exc:  # noqa: BLE001 - direct Playwright capture remains the fallback path.
        execution["status"] = "live-failed"
        execution["error"] = f"{type(exc).__name__}: {exc}"

    execution_path.write_text(json.dumps(execution, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    if execution["status"] == "live-completed":
        return {
            "status": "live-completed",
            "adapter": "playwright-mcp-live",
            "mode": "live",
            "command": settings.playwright_mcp_command,
            "calls_path": str(calls_path),
            "execution_path": str(execution_path),
            "observations": ["Playwright MCP live session이 action plan을 실행했습니다."],
            "checked_actions": [action["id"] for action in plan.get("actions", [])],
            "candidate_calls": artifact_calls,
        }
    return {
        "status": "live-failed",
        "adapter": "playwright-mcp-live",
        "mode": "live",
        "command": settings.playwright_mcp_command,
        "calls_path": str(calls_path),
        "execution_path": str(execution_path),
        "observations": [
            "Playwright MCP live session 실행에 실패했습니다.",
            "파이프라인은 Python Playwright 캡처 또는 placeholder 캡처로 계속 진행합니다.",
        ],
        "checked_actions": [action["id"] for action in plan.get("actions", [])],
        "candidate_calls": artifact_calls,
        "error": execution.get("error", ""),
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
        return {"tool": "browser_snapshot", "arguments": {"filename_hint": action.get("step_id", "")}, "action_id": action.get("id")}
    return None


def _action_to_live_mcp_call(action: dict[str, Any], available_tools: set[str]) -> dict[str, Any] | None:
    action_type = action.get("type")
    if action_type == "navigate" and "browser_navigate" in available_tools:
        return {"tool": "browser_navigate", "arguments": {"url": action.get("target", "")}}
    if action_type == "fill":
        selector = action.get("selector", "")
        value = action.get("value", "")
        if "browser_run_code_unsafe" in available_tools:
            return {
                "tool": "browser_run_code_unsafe",
                "arguments": {"code": f"async (page) => {{ await page.locator({_js(selector)}).fill({_js(value)}); return 'filled'; }}"},
            }
        if "browser_run_code" in available_tools:
            return {
                "tool": "browser_run_code",
                "arguments": {"code": f"async (page) => {{ await page.locator({_js(selector)}).fill({_js(value)}); return 'filled'; }}"},
            }
        if "browser_evaluate" in available_tools:
            return {"tool": "browser_evaluate", "arguments": {"function": _fill_function(selector, value)}}
        return None
    if action_type == "click":
        selector = action.get("selector", "")
        if "browser_run_code_unsafe" in available_tools:
            return {
                "tool": "browser_run_code_unsafe",
                "arguments": {"code": f"async (page) => {{ await page.locator({_js(selector)}).click(); return 'clicked'; }}"},
            }
        if "browser_run_code" in available_tools:
            return {"tool": "browser_run_code", "arguments": {"code": f"async (page) => {{ await page.locator({_js(selector)}).click(); return 'clicked'; }}"}}
        if "browser_evaluate" in available_tools:
            return {"tool": "browser_evaluate", "arguments": {"function": _click_function(selector)}}
        return None
    if action_type == "capture_step" and "browser_snapshot" in available_tools:
        return {"tool": "browser_snapshot", "arguments": {}}
    return None


def _fill_function(selector: str, value: str) -> str:
    return (
        "() => { "
        f"const el = document.querySelector({_js(selector)}); "
        "if (!el) throw new Error('selector not found'); "
        f"el.value = {_js(value)}; "
        "el.dispatchEvent(new Event('input', { bubbles: true })); "
        "el.dispatchEvent(new Event('change', { bubbles: true })); "
        "return 'filled'; "
        "}"
    )


def _click_function(selector: str) -> str:
    return (
        "() => { "
        f"const el = document.querySelector({_js(selector)}); "
        "if (!el) throw new Error('selector not found'); "
        "el.click(); "
        "return 'clicked'; "
        "}"
    )


def _js(value: str) -> str:
    return json.dumps(value)
