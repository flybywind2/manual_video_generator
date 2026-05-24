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
    allow_live: bool = True,
    deferred_reason: str = "",
    mcp_client_factory: McpClientFactory | None = None,
) -> dict[str, Any]:
    actions = [action for action in plan.get("actions", []) if isinstance(action, dict)]
    calls = [_action_to_mcp_call(action) for action in actions]
    calls = [call for call in calls if call is not None]
    artifact_calls = [_action_to_mcp_call(redact_sensitive(action)) for action in actions]
    artifact_calls = [call for call in artifact_calls if call is not None]
    calls_path = package_dir / "playwright_mcp_calls.json"
    calls_path.write_text(json.dumps({"calls": artifact_calls}, ensure_ascii=False, indent=2), encoding="utf-8")

    mode = settings.playwright_mcp_mode.lower()
    executed = False
    requires_live_mode = False
    if mode in {"off", "disabled", "none"}:
        status = "skipped"
        adapter = "playwright-mcp-disabled"
    elif mode == "live" and not allow_live:
        status = "deferred-until-authenticated"
        adapter = "playwright-mcp-live-deferred"
        requires_live_mode = True
    elif mode == "live":
        return _run_live_mcp(plan, settings, package_dir, calls, artifact_calls, calls_path, mcp_client_factory)
    else:
        status = "manifest-only"
        adapter = "playwright-mcp-manifest"
        requires_live_mode = True

    return {
        "status": status,
        "adapter": adapter,
        "mode": mode,
        "executed": executed,
        "requires_live_mode": requires_live_mode,
        "candidate_call_count": len(artifact_calls),
        "command": settings.playwright_mcp_command if mode != "off" else "",
        "calls_path": str(calls_path),
        "observations": [
            (
                "로그인 완료 전이라 Playwright MCP live 실행은 지연하고 후보 tool call manifest만 생성했습니다."
                if status == "deferred-until-authenticated"
                else "Playwright MCP 후보 tool call manifest만 생성했습니다."
            ),
            (
                "로그인 세션이 필요한 대상은 인증 후 캡처 단계에서 실행해야 합니다."
                if status == "deferred-until-authenticated"
                else "실제 브라우저 리허설은 MANUAL_AGENT_PLAYWRIGHT_MCP_MODE=live에서만 실행됩니다."
            ),
        ],
        "checked_actions": [action.get("id", "") for action in actions],
        "candidate_calls": artifact_calls,
        "deferred_reason": deferred_reason if status == "deferred-until-authenticated" else "",
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
    actions = [action for action in plan.get("actions", []) if isinstance(action, dict)]
    client_factory = mcp_client_factory or (
        lambda command, timeout_seconds: StdioMcpClient(command=command, timeout_seconds=timeout_seconds, cwd=package_dir)
    )
    execution: dict[str, Any] = {
        "status": "live-started",
        "command": settings.playwright_mcp_command,
        "calls_path": str(calls_path),
        "executed": True,
        "attempted_actions": len(actions),
        "executed_actions": 0,
        "skipped_actions": [],
        "results": [],
    }
    sso_profile_mode = str(getattr(getattr(settings, "login", None), "mode", "") or "").lower() == "sso_profile"
    try:
        with client_factory(settings.playwright_mcp_command, settings.request_timeout_seconds) as client:
            execution["initialize"] = client.initialize()
            available_tools = client.list_tools()
            execution["available_tools"] = sorted(available_tools)
            for action in actions:
                live_call = _action_to_live_mcp_call(action, available_tools)
                if live_call is None:
                    execution["skipped_actions"].append({"action_id": action.get("id"), "type": action.get("type")})
                    continue
                result = client.call_tool(live_call["tool"], live_call["arguments"])
                artifact_action = redact_sensitive(action)
                artifact_live_call = _action_to_live_mcp_call(artifact_action, available_tools) or redact_sensitive(live_call)
                if isinstance(result, dict) and result.get("isError"):
                    execution["had_tool_errors"] = True
                execution["executed_actions"] += 1
                execution["results"].append(
                    {
                        "action_id": action.get("id"),
                        "tool": artifact_live_call["tool"],
                        "arguments": artifact_live_call["arguments"],
                        "result": result,
                    }
                )
                if sso_profile_mode and _is_auth_redirect_result(result) and action.get("type") == "navigate":
                    execution.setdefault("auth_interstitials", []).append(
                        {"action_id": action.get("id"), "reason": "sso_auth_redirect_detected"}
                    )
                    continue
                if _mcp_result_has_login_blocker(result):
                    execution["status"] = "blocked-login"
                    execution["blocked_reason"] = "login_required"
                    execution["blocked_action_id"] = action.get("id")
                    break
            if execution["status"] == "live-started":
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
            "executed": True,
            "requires_live_mode": False,
            "attempted_actions": execution.get("attempted_actions", 0),
            "executed_actions": execution.get("executed_actions", 0),
            "skipped_actions": execution.get("skipped_actions", []),
            "command": settings.playwright_mcp_command,
            "calls_path": str(calls_path),
            "execution_path": str(execution_path),
            "observations": ["Playwright MCP live session이 action plan을 실행했습니다."],
            "checked_actions": [action.get("id", "") for action in actions],
            "candidate_calls": artifact_calls,
        }
    if execution["status"] == "blocked-login":
        return {
            "status": "blocked-login",
            "adapter": "playwright-mcp-live",
            "mode": "live",
            "executed": True,
            "requires_live_mode": True,
            "attempted_actions": execution.get("attempted_actions", 0),
            "executed_actions": execution.get("executed_actions", 0),
            "skipped_actions": execution.get("skipped_actions", []),
            "command": settings.playwright_mcp_command,
            "calls_path": str(calls_path),
            "execution_path": str(execution_path),
            "observations": [
                "Playwright MCP live session이 로그인 화면을 감지해 추가 tool call을 중단했습니다.",
                "로그인 세션이 필요한 대상은 직접 로그인 또는 credentials 로그인 후 Python Playwright 캡처 단계에서 진행합니다.",
            ],
            "checked_actions": [action.get("id", "") for action in actions],
            "candidate_calls": artifact_calls,
            "deferred_reason": "login_required",
        }
    return {
        "status": "live-failed",
        "adapter": "playwright-mcp-live",
        "mode": "live",
        "executed": True,
        "requires_live_mode": False,
        "attempted_actions": execution.get("attempted_actions", 0),
        "executed_actions": execution.get("executed_actions", 0),
        "skipped_actions": execution.get("skipped_actions", []),
        "command": settings.playwright_mcp_command,
        "calls_path": str(calls_path),
        "execution_path": str(execution_path),
        "observations": [
            "Playwright MCP live session 실행에 실패했습니다.",
            "파이프라인은 Python Playwright 캡처 또는 placeholder 캡처로 계속 진행합니다.",
        ],
        "checked_actions": [action.get("id", "") for action in actions],
        "candidate_calls": artifact_calls,
        "error": execution.get("error", ""),
    }


def _mcp_result_has_login_blocker(result: Any) -> bool:
    text = _flatten_mcp_result_text(result).lower()
    if not text:
        return False
    blockers = [
        "로그인 또는 회원가입",
        "로그인이 필요",
        "로그인 후",
        "로그인하세요",
        "sign in",
        "signin",
        "log in",
        "login required",
        "continue with google",
        "continue with apple",
        "password",
        "비밀번호",
    ]
    return any(blocker.lower() in text for blocker in blockers)


def _is_auth_redirect_result(result: Any) -> bool:
    text = _flatten_mcp_result_text(result).lower()
    if not text:
        return False
    redirect_markers = [
        "sso",
        "saml",
        "adfs",
        "single sign-on",
        "single sign on",
        "redirect",
        "redirecting",
        "인증",
        "자동 로그인",
        "windows authentication",
    ]
    return any(marker in text for marker in redirect_markers)


def _flatten_mcp_result_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        parts: list[str] = []
        for key, item in value.items():
            if key in {"text", "content", "message", "result", "title", "ariaLabel"}:
                parts.append(_flatten_mcp_result_text(item))
            elif isinstance(item, (dict, list, tuple)):
                parts.append(_flatten_mcp_result_text(item))
        return " ".join(part for part in parts if part)
    if isinstance(value, (list, tuple)):
        return " ".join(_flatten_mcp_result_text(item) for item in value)
    return ""


def _action_to_mcp_call(action: dict[str, Any]) -> dict[str, Any] | None:
    action_type = action.get("type")
    if action_type == "navigate":
        return {"tool": "browser_navigate", "arguments": {"url": action.get("target", "")}, "action_id": action.get("id")}
    if action_type == "fill_by_label":
        return {
            "tool": "browser_run_code",
            "arguments": {"code": _fill_by_label_code(str(action.get("label") or ""), str(action.get("value") or ""))},
            "action_id": action.get("id"),
        }
    if action_type == "click_by_text":
        return {
            "tool": "browser_run_code",
            "arguments": {"code": _click_by_text_code(_text_candidates(action))},
            "action_id": action.get("id"),
        }
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
    if action_type == "fill_by_label":
        tool = _run_code_tool(available_tools)
        if tool:
            return {
                "tool": tool,
                "arguments": {"code": _fill_by_label_code(str(action.get("label") or ""), str(action.get("value") or ""))},
            }
        return None
    if action_type == "click_by_text":
        tool = _run_code_tool(available_tools)
        if tool:
            return {"tool": tool, "arguments": {"code": _click_by_text_code(_text_candidates(action))}}
        return None
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


def _run_code_tool(available_tools: set[str]) -> str:
    if "browser_run_code_unsafe" in available_tools:
        return "browser_run_code_unsafe"
    if "browser_run_code" in available_tools:
        return "browser_run_code"
    return ""


def _fill_by_label_code(label: str, value: str) -> str:
    return (
        "async (page) => { "
        f"await page.getByLabel({_js(label)}, {{ exact: false }}).fill({_js(value)}); "
        "return 'filled_by_label'; "
        "}"
    )


def _click_by_text_code(texts: list[str]) -> str:
    return (
        "async (page) => { "
        f"const texts = {_js_array(texts)}; "
        "for (const text of texts) { "
        "const locators = ["
        "page.getByRole('button', { name: text, exact: false }), "
        "page.getByRole('link', { name: text, exact: false }), "
        "page.getByText(text, { exact: false })"
        "]; "
        "for (const locator of locators) { "
        "if (await locator.count()) { await locator.first().click(); return `clicked:${text}`; } "
        "} "
        "} "
        "throw new Error(`text not found: ${texts.join(', ')}`); "
        "}"
    )


def _text_candidates(action: dict[str, Any]) -> list[str]:
    raw = action.get("texts", action.get("text", action.get("label", "")))
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    value = str(raw).strip()
    return [value] if value else []


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


def _js_array(values: list[str]) -> str:
    return json.dumps(values, ensure_ascii=False)
