from __future__ import annotations

import json
import re
import shlex
import base64
from pathlib import Path
from typing import Any, Callable

from backend.app.adapters.browser_agent import decide_browser_agent_action
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
    request: Any | None = None,
    decide_next: Any = decide_browser_agent_action,
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
        return _run_live_mcp(
            plan,
            settings,
            package_dir,
            calls,
            artifact_calls,
            calls_path,
            mcp_client_factory,
            request=request,
            decide_next=decide_next,
        )
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
    *,
    request: Any | None = None,
    decide_next: Any = decide_browser_agent_action,
) -> dict[str, Any]:
    execution_path = package_dir / "playwright_mcp_execution.json"
    effective_command = _effective_mcp_command(settings)
    actions = [action for action in plan.get("actions", []) if isinstance(action, dict)]
    client_factory = mcp_client_factory or (
        lambda command, timeout_seconds: StdioMcpClient(command=command, timeout_seconds=timeout_seconds, cwd=package_dir)
    )
    execution: dict[str, Any] = {
        "status": "live-started",
        "command": effective_command,
        "calls_path": str(calls_path),
        "executed": True,
        "attempted_actions": len(actions),
        "executed_actions": 0,
        "skipped_actions": [],
        "results": [],
    }
    sso_profile_mode = str(getattr(getattr(settings, "login", None), "mode", "") or "").lower() == "sso_profile"
    if request is not None and getattr(settings, "enable_browser_agent", False):
        return _run_live_mcp_browser_agent(
            plan,
            settings,
            package_dir,
            calls_path,
            mcp_client_factory,
            request=request,
            decide_next=decide_next,
            sso_profile_mode=sso_profile_mode,
            effective_command=effective_command,
        )
    try:
        with client_factory(effective_command, settings.request_timeout_seconds) as client:
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
                if _mcp_result_has_login_blocker(result, allow_auth_redirect=sso_profile_mode):
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
            "command": effective_command,
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
            "command": effective_command,
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
        "command": effective_command,
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


def _run_live_mcp_browser_agent(
    plan: dict[str, Any],
    settings: AppSettings,
    package_dir: Path,
    calls_path: Path,
    mcp_client_factory: McpClientFactory | None,
    *,
    request: Any,
    decide_next: Any,
    sso_profile_mode: bool,
    effective_command: str,
) -> dict[str, Any]:
    execution_path = package_dir / "playwright_mcp_execution.json"
    client_factory = mcp_client_factory or (
        lambda command, timeout_seconds: StdioMcpClient(command=command, timeout_seconds=timeout_seconds, cwd=package_dir)
    )
    execution: dict[str, Any] = {
        "status": "live-agent-started",
        "adapter": "playwright-mcp-live-agent",
        "contract": "observe-act-verify",
        "command": effective_command,
        "calls_path": str(calls_path),
        "executed": True,
        "attempted_actions": 0,
        "executed_actions": 0,
        "turns": [],
        "results": [],
    }
    candidate_calls: list[dict[str, Any]] = []
    history: list[dict[str, Any]] = []
    max_steps = max(int(getattr(settings, "browser_agent_max_steps", 8) or 8), 1)
    max_sso_wait_turns = 30 if sso_profile_mode else 0

    try:
        with client_factory(effective_command, settings.request_timeout_seconds) as client:
            execution["initialize"] = client.initialize()
            available_tools = client.list_tools()
            execution["available_tools"] = sorted(available_tools)
            navigate_call = _initial_navigate_call(plan, request, available_tools)
            if navigate_call:
                result = client.call_tool(navigate_call["tool"], navigate_call["arguments"])
                candidate_calls.append({"action_id": "agent_navigate", **redact_sensitive(navigate_call)})
                execution["results"].append({"action_id": "agent_navigate", **redact_sensitive(navigate_call), "result": result})
                if sso_profile_mode and _is_auth_redirect_result(result):
                    execution.setdefault("auth_interstitials", []).append(
                        {"action_id": "agent_navigate", "reason": "sso_auth_redirect_detected"}
                    )
                elif _mcp_result_has_login_blocker(result, allow_auth_redirect=sso_profile_mode):
                    execution["status"] = "blocked-login"
                    execution["blocked_reason"] = "login_required"
            if execution["status"] != "blocked-login":
                step_index = 1
                functional_steps = 0
                sso_wait_turns = 0
                while functional_steps < max_steps and step_index <= max_steps + max_sso_wait_turns:
                    expect_inputs = bool(getattr(request, "input_values", {}) or {})
                    priority_labels = _observation_priority_labels(request)
                    observation = _observe_with_mcp(
                        client,
                        available_tools,
                        expect_inputs=expect_inputs,
                        priority_labels=priority_labels,
                    )
                    screenshot_before = _take_mcp_step_screenshot(client, available_tools, package_dir, step_index)
                    if screenshot_before:
                        observation["screenshot"] = screenshot_before
                    decide_kwargs: dict[str, Any] = {"step_index": step_index}
                    if decide_next is decide_browser_agent_action:
                        decide_kwargs["package_dir"] = package_dir
                    action = dict(decide_next(request, settings, observation, history, **decide_kwargs))
                    action.setdefault("id", f"mcp_agent_{step_index}")
                    action.setdefault("source", "browser-agent-llm")
                    turn: dict[str, Any] = {
                        "step": step_index,
                        "observation": observation,
                        "screenshot_before": screenshot_before,
                        "action": redact_sensitive(action),
                    }
                    execution["attempted_actions"] += 1
                    is_sso_wait = sso_profile_mode and _is_sso_wait_action(action)
                    if is_sso_wait:
                        sso_wait_turns += 1
                        execution["sso_wait_turns"] = sso_wait_turns
                    else:
                        functional_steps += 1
                    if action.get("type") == "finish":
                        turn["result"] = {"status": action.get("status", "ok"), "reason": action.get("reason", "")}
                        turn["verification"] = {"phase": "verify", "status": "ok", "reason": "agent_finished"}
                        execution["turns"].append(turn)
                        history.append(
                            {
                                "step": step_index,
                                "type": "finish",
                                "status": action.get("status", "ok"),
                                "reason": action.get("reason", ""),
                            }
                        )
                        execution["status"] = "live-agent-completed"
                        break
                    if is_sso_wait and max_sso_wait_turns > 0 and sso_wait_turns > max_sso_wait_turns:
                        turn["result"] = {"status": "blocked", "reason": "sso_auth_redirect_timeout"}
                        turn["verification"] = {"phase": "verify", "status": "blocked", "reason": "sso_auth_redirect_timeout"}
                        execution["turns"].append(turn)
                        history.append({"step": step_index, "type": action.get("type"), "status": "blocked", "reason": "sso_auth_redirect_timeout"})
                        execution["status"] = "blocked-login"
                        execution["blocked_reason"] = "sso_auth_redirect_timeout"
                        break
                    live_call = _action_to_live_mcp_call(action, available_tools, observation=observation)
                    if live_call is None:
                        turn["result"] = {"status": "skipped", "reason": "no_mcp_tool_for_action"}
                        turn["verification"] = {"phase": "verify", "status": "failed", "reason": "no_mcp_tool_for_action"}
                        execution["turns"].append(turn)
                        history.append({"step": step_index, "type": action.get("type"), "status": "skipped", "reason": "no_mcp_tool_for_action"})
                        step_index += 1
                        continue
                    result = client.call_tool(live_call["tool"], live_call["arguments"])
                    artifact_call = {"action_id": action.get("id"), **redact_sensitive(live_call)}
                    candidate_calls.append(artifact_call)
                    execution["executed_actions"] += 1
                    turn["tool"] = artifact_call["tool"]
                    turn["arguments"] = artifact_call["arguments"]
                    turn["result"] = result
                    if _mcp_result_has_login_blocker(result, allow_auth_redirect=sso_profile_mode):
                        turn["verification"] = {"phase": "verify", "status": "blocked", "reason": "login_required"}
                        execution["turns"].append(turn)
                        history.append({"step": step_index, "type": action.get("type"), "status": "blocked", "reason": "login_required"})
                        execution["status"] = "blocked-login"
                        execution["blocked_reason"] = "login_required"
                        execution["blocked_action_id"] = action.get("id")
                        break
                    verification = _verify_mcp_agent_turn(
                        client,
                        available_tools,
                        observation,
                        expect_inputs=expect_inputs,
                        priority_labels=priority_labels,
                    )
                    turn["verification"] = verification
                    execution["turns"].append(turn)
                    history.append(
                        {
                            "step": step_index,
                            "type": action.get("type"),
                            "status": "ok" if verification.get("status") != "failed" else "failed",
                            "verification_status": verification.get("status"),
                            "reason": action.get("reason", ""),
                        }
                    )
                    step_index += 1
            if execution["status"] == "live-agent-started":
                execution["status"] = "live-agent-completed"
            _maybe_hold_mcp_browser_for_auth_debug(client, available_tools, settings, execution)
    except Exception as exc:  # noqa: BLE001 - direct Playwright capture remains the fallback path.
        execution["status"] = "live-failed"
        execution["error"] = f"{type(exc).__name__}: {exc}"

    calls_path.write_text(
        json.dumps(
            {
                "mode": "dynamic-browser-agent",
                "contract": "observe-act-verify",
                "calls": candidate_calls,
            },
            ensure_ascii=False,
            indent=2,
            default=str,
        ),
        encoding="utf-8",
    )
    execution_path.write_text(json.dumps(redact_sensitive(execution), ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    if execution["status"] == "blocked-login":
        return {
            "status": "blocked-login",
            "adapter": "playwright-mcp-live-agent",
            "mode": "live",
            "executed": True,
            "requires_live_mode": True,
            "attempted_actions": execution.get("attempted_actions", 0),
            "executed_actions": execution.get("executed_actions", 0),
            "command": effective_command,
            "calls_path": str(calls_path),
            "execution_path": str(execution_path),
            "observations": [
                "Playwright MCP browser agent가 로그인 화면을 감지해 추가 tool call을 중단했습니다.",
                "SSO 프로필 인증 경유가 아닌 실제 로그인 입력 화면이면 인증 후 다시 실행해야 합니다.",
            ],
            "candidate_calls": candidate_calls,
            "deferred_reason": "login_required",
        }
    if execution["status"] == "live-failed":
        return {
            "status": "live-failed",
            "adapter": "playwright-mcp-live-agent",
            "mode": "live",
            "executed": True,
            "requires_live_mode": False,
            "attempted_actions": execution.get("attempted_actions", 0),
            "executed_actions": execution.get("executed_actions", 0),
            "command": effective_command,
            "calls_path": str(calls_path),
            "execution_path": str(execution_path),
            "observations": [
                "Playwright MCP browser agent 실행에 실패했습니다.",
                "파이프라인은 Python Playwright 캡처 또는 placeholder 캡처로 계속 진행합니다.",
            ],
            "candidate_calls": candidate_calls,
            "error": execution.get("error", ""),
        }
    return {
        "status": "live-agent-completed",
        "adapter": "playwright-mcp-live-agent",
        "mode": "live",
        "executed": True,
        "requires_live_mode": False,
        "attempted_actions": execution.get("attempted_actions", 0),
        "executed_actions": execution.get("executed_actions", 0),
        "command": effective_command,
        "calls_path": str(calls_path),
        "execution_path": str(execution_path),
        "observations": ["Playwright MCP browser agent가 observe-act-verify 방식으로 요구사항을 단계별 실행했습니다."],
        "candidate_calls": candidate_calls,
    }


def _initial_navigate_call(plan: dict[str, Any], request: Any, available_tools: set[str]) -> dict[str, Any] | None:
    target_url = str(getattr(request, "target_url", "") or "")
    for action in plan.get("actions", []) or []:
        if isinstance(action, dict) and action.get("type") == "navigate" and action.get("target"):
            target_url = str(action.get("target") or target_url)
            break
    if not target_url or "browser_navigate" not in available_tools:
        return None
    return {"tool": "browser_navigate", "arguments": {"url": target_url}}


def _effective_mcp_command(settings: AppSettings) -> str:
    command = str(settings.playwright_mcp_command or "").strip()
    login = getattr(settings, "login", None)
    if str(getattr(login, "mode", "") or "").lower() != "sso_profile":
        return command

    tokens = [token for token in _split_mcp_command(command) if token and token != "--headless"]
    browser_channel = str(getattr(login, "browser_channel", "") or "").strip()
    if browser_channel and not _has_cli_option(tokens, "--browser"):
        tokens.extend(["--browser", browser_channel])

    user_data_dir = str(getattr(login, "sso_profile_dir", "") or "").strip()
    if user_data_dir and not _has_cli_option(tokens, "--user-data-dir"):
        tokens.extend(["--user-data-dir", _quote_cli_value(user_data_dir)])

    return " ".join(tokens)


def _has_cli_option(tokens: list[str], option: str) -> bool:
    option_prefix = f"{option}="
    return any(token == option or token.startswith(option_prefix) for token in tokens)


def _split_mcp_command(command: str) -> list[str]:
    try:
        return shlex.split(command, posix=False)
    except ValueError:
        return command.split()


def _quote_cli_value(value: str) -> str:
    if not value or value.startswith('"') and value.endswith('"'):
        return value
    if any(ch.isspace() for ch in value):
        return f'"{value.replace(chr(34), chr(92) + chr(34))}"'
    return value


def _maybe_hold_mcp_browser_for_auth_debug(
    client: Any,
    available_tools: set[str],
    settings: AppSettings,
    execution: dict[str, Any],
) -> None:
    seconds = _bounded_debug_hold_seconds(getattr(settings, "auth_debug_keep_browser_open_seconds", 0.0))
    if seconds <= 0 or not _execution_touched_auth_boundary(execution):
        return
    timeout_ms = int(seconds * 1000)
    tool = _run_code_tool(available_tools)
    live_call = (
        {
            "tool": tool,
            "arguments": {"code": f"async (page) => {{ await page.waitForTimeout({timeout_ms}); return 'debug_hold:{timeout_ms}'; }}"},
        }
        if tool
        else None
    )
    if live_call is None:
        execution["debug_keep_browser_open_seconds"] = seconds
        execution["debug_keep_browser_open_status"] = "unsupported"
        return
    try:
        result = client.call_tool(live_call["tool"], live_call["arguments"])
        execution["debug_keep_browser_open_seconds"] = seconds
        execution["debug_keep_browser_open_status"] = "ok"
        execution["debug_keep_browser_open_result"] = result
    except Exception as exc:  # noqa: BLE001 - debug hold failure should not hide the original run.
        execution["debug_keep_browser_open_seconds"] = seconds
        execution["debug_keep_browser_open_status"] = "failed"
        execution["debug_keep_browser_open_error"] = f"{type(exc).__name__}: {exc}"


def _execution_touched_auth_boundary(execution: dict[str, Any]) -> bool:
    if execution.get("auth_interstitials") or execution.get("sso_wait_turns"):
        return True
    blocked_reason = str(execution.get("blocked_reason") or "")
    if blocked_reason in {"login_required", "sso_auth_redirect_timeout"}:
        return True
    for turn in execution.get("turns") or []:
        if not isinstance(turn, dict):
            continue
        action = turn.get("action") if isinstance(turn.get("action"), dict) else {}
        if str(action.get("reason") or "") == "sso_auth_redirect_wait":
            return True
    return False


def _bounded_debug_hold_seconds(value: Any) -> float:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return 0.0
    return min(max(seconds, 0.0), 3600.0)


def _is_sso_wait_action(action: dict[str, Any]) -> bool:
    return str(action.get("type") or "") == "wait" and str(action.get("reason") or "") == "sso_auth_redirect_wait"


def _observe_with_mcp(
    client: Any,
    available_tools: set[str],
    *,
    expect_inputs: bool = False,
    priority_labels: list[str] | None = None,
) -> dict[str, Any]:
    tool = _run_code_tool(available_tools)
    if not tool:
        if "browser_evaluate" in available_tools:
            result = client.call_tool("browser_evaluate", {"function": _mcp_observe_function()})
            parsed = _parse_mcp_observation(result)
            if parsed:
                return _recover_sparse_mcp_observation(
                    client,
                    available_tools,
                    parsed,
                    source="browser_evaluate",
                    expect_inputs=expect_inputs,
                    priority_labels=priority_labels,
                )
        if "browser_snapshot" in available_tools:
            return _snapshot_observation(client, priority_labels=priority_labels)
        return {"body_text": "", "fields": [], "clickables": []}
    result = client.call_tool(tool, {"code": _mcp_observe_code()})
    parsed = _parse_mcp_observation(result)
    if parsed:
        return _recover_sparse_mcp_observation(
            client,
            available_tools,
            parsed,
            source=tool,
            expect_inputs=expect_inputs,
            priority_labels=priority_labels,
        )
    if "browser_snapshot" in available_tools:
        snapshot = _snapshot_observation(client, priority_labels=priority_labels)
        snapshot["observation_source"] = f"{tool}+browser_snapshot_compact"
        return snapshot
    return {"body_text": _flatten_mcp_result_text(result), "fields": [], "clickables": []}


def _verify_mcp_agent_turn(
    client: Any,
    available_tools: set[str],
    before_observation: dict[str, Any],
    *,
    expect_inputs: bool = False,
    priority_labels: list[str] | None = None,
) -> dict[str, Any]:
    try:
        after = _observe_with_mcp(
            client,
            available_tools,
            expect_inputs=expect_inputs,
            priority_labels=priority_labels,
        )
    except Exception as exc:  # noqa: BLE001
        return {"phase": "verify", "status": "failed", "reason": f"observe_failed:{type(exc).__name__}"}
    return {
        "phase": "verify",
        "status": "ok",
        "changed": _mcp_observation_signature(after) != _mcp_observation_signature(before_observation),
        "reason": "observed_after_action",
    }


def _take_mcp_step_screenshot(
    client: Any,
    available_tools: set[str],
    package_dir: Path,
    step_index: int,
) -> dict[str, Any]:
    if "browser_take_screenshot" not in available_tools:
        return {"status": "unsupported", "reason": "browser_take_screenshot_unavailable"}
    screenshots_dir = package_dir / "mcp_screenshots"
    screenshots_dir.mkdir(parents=True, exist_ok=True)
    filename = f"mcp_step_{step_index:02d}_before.png"
    target_path = screenshots_dir / filename
    result: Any
    try:
        result = client.call_tool("browser_take_screenshot", {"filename": filename})
    except Exception as exc:  # noqa: BLE001 - screenshot is diagnostic context, not the action itself.
        return {"status": "failed", "reason": f"{type(exc).__name__}: {exc}", "filename": filename}

    saved_path = _save_mcp_screenshot_content(result, target_path)
    metadata: dict[str, Any] = {
        "status": "ok",
        "tool": "browser_take_screenshot",
        "filename": filename,
        "path": str(saved_path) if saved_path else "",
        "result": redact_sensitive(result),
    }
    if not saved_path:
        metadata["status"] = "captured_by_mcp"
        metadata["reason"] = "no_inline_image_content"
    return metadata


def _save_mcp_screenshot_content(result: Any, target_path: Path) -> Path | None:
    image_data = _find_mcp_image_data(result)
    if not image_data:
        return None
    try:
        target_path.write_bytes(base64.b64decode(image_data))
    except Exception:  # noqa: BLE001 - malformed image payload should still leave MCP result metadata.
        return None
    return target_path


def _find_mcp_image_data(value: Any) -> str:
    if isinstance(value, dict):
        mime_type = str(value.get("mimeType") or value.get("mime_type") or "")
        data = value.get("data")
        if isinstance(data, str) and mime_type.startswith("image/"):
            return data
        for item in value.values():
            found = _find_mcp_image_data(item)
            if found:
                return found
    if isinstance(value, list):
        for item in value:
            found = _find_mcp_image_data(item)
            if found:
                return found
    return ""


def _mcp_observation_signature(observation: dict[str, Any]) -> tuple[Any, ...]:
    return (
        observation.get("url"),
        observation.get("title"),
        tuple(observation.get("headings") or []),
        tuple((item.get("text"), item.get("href")) for item in observation.get("clickables") or []),
        tuple((item.get("label"), item.get("value")) for item in observation.get("fields") or []),
        observation.get("body_text"),
    )


def _parse_mcp_observation(result: Any) -> dict[str, Any]:
    if isinstance(result, dict) and isinstance(result.get("observation"), dict):
        candidate = result["observation"]
        return candidate if _is_mcp_observation(candidate) else {}
    text = _flatten_mcp_result_text(result).strip()
    if not text:
        return {}
    decoder = json.JSONDecoder()
    starts: list[int] = []
    stripped_start = len(text) - len(text.lstrip())
    if stripped_start < len(text) and text[stripped_start] == "{":
        starts.append(stripped_start)
    for match in re.finditer(r'"(?:fields|clickables|body_text)"\s*:', text):
        start = text.rfind("{", 0, match.start())
        if start >= 0 and start not in starts:
            starts.append(start)
        if len(starts) >= 32:
            break
    for start in starts:
        try:
            parsed, _end = decoder.raw_decode(text, start)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(parsed, dict) and _is_mcp_observation(parsed):
            return parsed
    return {}


def _is_mcp_observation(value: dict[str, Any]) -> bool:
    if not any(key in value for key in ("fields", "clickables", "body_text")):
        return False
    if "fields" in value and not isinstance(value.get("fields"), list):
        return False
    if "clickables" in value and not isinstance(value.get("clickables"), list):
        return False
    return True


_SNAPSHOT_LINE_RE = re.compile(
    r'^\s*-\s*(?P<role>[A-Za-z][\w-]*)\s*(?:"(?P<name>(?:\\.|[^"])*)")?.*?\[ref=(?P<ref>[^\]\s]+)\]'
)
_SNAPSHOT_FIELD_ROLES = {"textbox", "searchbox", "combobox", "spinbutton", "slider"}
_SNAPSHOT_CLICKABLE_ROLES = {"button", "link", "checkbox", "radio", "menuitem", "option", "tab", "switch"}
_SNAPSHOT_HEADING_ROLES = {"heading"}
_SNAPSHOT_BODY_LIMIT = 4000


def _snapshot_observation(client: Any, *, priority_labels: list[str] | None = None) -> dict[str, Any]:
    result = client.call_tool("browser_snapshot", {})
    return _compact_mcp_snapshot(_flatten_mcp_result_text(result), priority_labels=priority_labels)


def _compact_mcp_snapshot(text: str, *, priority_labels: list[str] | None = None) -> dict[str, Any]:
    exact_priority_fields: list[dict[str, Any]] = []
    partial_priority_fields: list[dict[str, Any]] = []
    regular_fields: list[dict[str, Any]] = []
    clickables: list[dict[str, Any]] = []
    headings: list[str] = []
    interaction_text: list[str] = []
    first_context: list[str] = []
    tail_context: list[str] = []
    seen: set[tuple[str, str]] = set()
    priorities = [_normalize_match_text(item) for item in (priority_labels or []) if _normalize_match_text(item)]
    url = ""
    title = ""
    total_lines = 0
    context_lines = 0
    total_fields = 0
    total_clickables = 0

    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        total_lines += 1
        url_match = re.match(r"^-?\s*Page URL:\s*(.+)$", line, flags=re.IGNORECASE)
        if url_match:
            url = url_match.group(1).strip()
            continue
        title_match = re.match(r"^-?\s*Page Title:\s*(.+)$", line, flags=re.IGNORECASE)
        if title_match:
            title = title_match.group(1).strip()
            continue
        match = _SNAPSHOT_LINE_RE.match(line)
        if match:
            role = match.group("role").lower()
            name = _decode_snapshot_name(match.group("name") or role)
            ref = match.group("ref")
            identity = (role, ref)
            if identity in seen:
                continue
            if role in _SNAPSHOT_FIELD_ROLES:
                total_fields += 1
                password = _is_password_snapshot_field(name, line)
                field = {
                    "label": name,
                    "ref": ref,
                    "role": role,
                    "type": "password" if password else role,
                }
                if password:
                    field["value"] = "<redacted>"
                normalized_name = _normalize_match_text(name)
                is_exact_priority = any(priority == normalized_name for priority in priorities)
                is_partial_priority = not is_exact_priority and any(
                    priority in normalized_name or normalized_name in priority for priority in priorities
                )
                if is_exact_priority:
                    destination = exact_priority_fields
                elif is_partial_priority:
                    destination = partial_priority_fields
                else:
                    destination = regular_fields
                destination_limit = min(max(len(priorities) * 2, 2), 20) if (is_exact_priority or is_partial_priority) else 60
                if len(destination) < destination_limit:
                    destination.append(field)
                    seen.add(identity)
                    if len(interaction_text) < 140:
                        interaction_text.append(f"{role}: {name}")
                continue
            if role in _SNAPSHOT_CLICKABLE_ROLES:
                total_clickables += 1
                if len(clickables) < 80:
                    clickables.append({"text": name, "ref": ref, "role": role})
                    seen.add(identity)
                    if len(interaction_text) < 140:
                        interaction_text.append(f"{role}: {name}")
                continue
            if role in _SNAPSHOT_HEADING_ROLES:
                if len(headings) < 20:
                    headings.append(name)
        context = re.sub(r"\s*\[ref=[^\]]+\]", "", line)
        context_lines += 1
        if len(first_context) < 24:
            first_context.append(context[:240])
        tail_context.append(context[:240])
        if len(tail_context) > 24:
            tail_context.pop(0)

    priority_fields = [*exact_priority_fields, *partial_priority_fields]
    priority_refs = {item["ref"] for item in priority_fields}
    fields = [*priority_fields, *(item for item in regular_fields if item["ref"] not in priority_refs)][:60]
    identity_context = [item for item in (f"Page URL: {url}" if url else "", f"Page Title: {title}" if title else "") if item]
    body_source = " ".join([*identity_context, *interaction_text, *first_context, *tail_context])
    body_text = body_source[:_SNAPSHOT_BODY_LIMIT]
    candidates_truncated = total_fields > len(fields) or total_clickables > len(clickables)
    context_truncated = context_lines > len(first_context) + len(tail_context)
    body_truncated = len(body_source) > len(body_text)
    observation = {
        "headings": headings[:20],
        "fields": fields,
        "clickables": clickables,
        "body_text": body_text,
        "observation_source": "browser_snapshot_compact",
        "snapshot_truncated": candidates_truncated or context_truncated or body_truncated,
        "snapshot_candidates_truncated": candidates_truncated,
        "snapshot_total_chars": len(text),
        "snapshot_total_lines": total_lines,
    }
    if url:
        observation["url"] = url
    if title:
        observation["title"] = title
    return observation


def _decode_snapshot_name(value: str) -> str:
    try:
        return json.loads(f'"{value}"')
    except (json.JSONDecodeError, TypeError):
        return str(value).replace('\\"', '"').strip()


def _is_password_snapshot_field(name: str, raw_line: str) -> bool:
    normalized = _normalize_match_text(f"{name} {raw_line}")
    return any(token in normalized for token in ("password", "passwd", "비밀번호", "암호"))


def _recover_sparse_mcp_observation(
    client: Any,
    available_tools: set[str],
    observation: dict[str, Any],
    *,
    source: str,
    expect_inputs: bool,
    priority_labels: list[str] | None,
) -> dict[str, Any]:
    base = dict(observation)
    base.setdefault("fields", [])
    base.setdefault("clickables", [])
    base.setdefault("body_text", "")
    base.setdefault("observation_source", source)
    sparse = not base["fields"]
    if not sparse or "browser_snapshot" not in available_tools:
        return base

    snapshot = _snapshot_observation(client, priority_labels=priority_labels)
    if snapshot.get("fields"):
        base["fields"] = snapshot["fields"]
    if snapshot.get("clickables") and not base["clickables"]:
        base["clickables"] = snapshot["clickables"]
    if snapshot.get("headings") and not base.get("headings"):
        base["headings"] = snapshot["headings"]
    if snapshot.get("body_text") and not base["body_text"]:
        base["body_text"] = snapshot["body_text"]
    base["observation_source"] = f"{source}+browser_snapshot_compact"
    base["snapshot_truncated"] = snapshot.get("snapshot_truncated", False)
    base["snapshot_candidates_truncated"] = snapshot.get("snapshot_candidates_truncated", False)
    base["snapshot_total_chars"] = snapshot.get("snapshot_total_chars", 0)
    base["snapshot_total_lines"] = snapshot.get("snapshot_total_lines", 0)
    if snapshot.get("url") and not base.get("url"):
        base["url"] = snapshot["url"]
    if snapshot.get("title") and not base.get("title"):
        base["title"] = snapshot["title"]
    return base


def _observation_priority_labels(request: Any) -> list[str]:
    labels = [str(item) for item in (getattr(request, "input_values", {}) or {}).keys()]
    brief = getattr(request, "agent_brief", {}) or {}
    labels.extend(str(item) for item in brief.get("safe_click_intents", []) or [])
    return list(dict.fromkeys(item.strip() for item in labels if item.strip()))


def _mcp_observe_code() -> str:
    return """
async (page) => {
  return await page.evaluate(() => {
    const manualMcpObserve = true;
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const iconTextOf = (el) => {
      const classText = [el.className, ...Array.from(el.querySelectorAll('[class]')).map((child) => child.className)].join(' ').toLowerCase();
      const tokens = [];
      if (classText.includes('plus') || classText.includes('add')) tokens.push('+', '추가', 'plus', 'add');
      if (classText.includes('close') || classText.includes('times') || classText.includes('xmark')) tokens.push('닫기', 'close', 'x');
      if (classText.includes('search')) tokens.push('검색', 'search');
      if (classText.includes('edit') || classText.includes('pencil')) tokens.push('수정', 'edit');
      if (classText.includes('delete') || classText.includes('trash')) tokens.push('삭제', 'delete');
      return tokens.join(' ');
    };
    const textOf = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || iconTextOf(el) || '').trim();
    const labelFor = (el) => {
      const labels = Array.from(el.labels || []).map((label) => label.innerText.trim()).filter(Boolean);
      if (labels.length) return labels.join(' ');
      const id = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      return (id?.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '').trim();
    };
    const cssEscape = (value) => {
      try { return CSS.escape(String(value)); } catch { return String(value).replace(/"/g, '\\"'); }
    };
    const selectorFor = (el) => {
      if (!el || !el.tagName) return '';
      if (el.id) return `#${cssEscape(el.id)}`;
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-action');
      if (testId) return `[${el.getAttribute('data-testid') ? 'data-testid' : el.getAttribute('data-test') ? 'data-test' : 'data-action'}="${cssEscape(testId)}"]`;
      const name = el.getAttribute('name');
      if (name) return `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
      const aria = el.getAttribute('aria-label');
      if (aria) return `${el.tagName.toLowerCase()}[aria-label="${cssEscape(aria)}"]`;
      return el.tagName.toLowerCase();
    };
    const fields = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="textbox"]')).filter(visible).slice(0, 60).map((el) => ({
      selector: selectorFor(el),
      label: labelFor(el),
      name: el.name || '',
      placeholder: el.getAttribute('placeholder') || '',
      type: el.getAttribute('type') || el.getAttribute('role') || (el.isContentEditable ? 'contenteditable' : el.tagName.toLowerCase()),
      value: el.type === 'password' ? '<redacted>' : String(el.value || el.innerText || '').slice(0, 80),
    }));
    const clickables = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a, [onclick], [class*="icon-"]')).filter(visible).slice(0, 60).map((el) => ({
      selector: selectorFor(el),
      text: textOf(el).slice(0, 120),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      href: el.tagName.toLowerCase() === 'a' ? el.getAttribute('href') || '' : '',
    })).filter((item) => item.text || item.href);
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]')).filter(visible).slice(0, 20).map((el) => textOf(el).slice(0, 160)).filter(Boolean);
    return {
      marker: manualMcpObserve,
      url: location.href,
      title: document.title,
      headings,
      fields,
      clickables,
      body_text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 4000),
    };
  });
}
""".strip()


def _mcp_observe_function() -> str:
    return """
() => {
  const visible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const iconTextOf = (el) => {
    const classText = [el.className, ...Array.from(el.querySelectorAll('[class]')).map((child) => child.className)].join(' ').toLowerCase();
    const tokens = [];
    if (classText.includes('plus') || classText.includes('add')) tokens.push('+', '추가', 'plus', 'add');
    if (classText.includes('close') || classText.includes('times') || classText.includes('xmark')) tokens.push('닫기', 'close', 'x');
    if (classText.includes('search')) tokens.push('검색', 'search');
    if (classText.includes('edit') || classText.includes('pencil')) tokens.push('수정', 'edit');
    if (classText.includes('delete') || classText.includes('trash')) tokens.push('삭제', 'delete');
    return tokens.join(' ');
  };
  const textOf = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || iconTextOf(el) || '').trim();
  const labelFor = (el) => {
    const labels = Array.from(el.labels || []).map((label) => label.innerText.trim()).filter(Boolean);
    if (labels.length) return labels.join(' ');
    const id = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    return (id?.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '').trim();
  };
  const cssEscape = (value) => {
    try { return CSS.escape(String(value)); } catch { return String(value).replace(/"/g, '\\"'); }
  };
  const selectorFor = (el) => {
    if (!el || !el.tagName) return '';
    if (el.id) return `#${cssEscape(el.id)}`;
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-action');
    if (testId) return `[${el.getAttribute('data-testid') ? 'data-testid' : el.getAttribute('data-test') ? 'data-test' : 'data-action'}="${cssEscape(testId)}"]`;
    const name = el.getAttribute('name');
    if (name) return `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
    const aria = el.getAttribute('aria-label');
    if (aria) return `${el.tagName.toLowerCase()}[aria-label="${cssEscape(aria)}"]`;
    return el.tagName.toLowerCase();
  };
  const fields = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="textbox"]')).filter(visible).slice(0, 60).map((el) => ({
    selector: selectorFor(el),
    label: labelFor(el),
    name: el.name || '',
    placeholder: el.getAttribute('placeholder') || '',
    type: el.getAttribute('type') || el.getAttribute('role') || (el.isContentEditable ? 'contenteditable' : el.tagName.toLowerCase()),
    value: el.type === 'password' ? '<redacted>' : String(el.value || el.innerText || '').slice(0, 80),
  }));
  const clickables = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a, [aria-label], [title], [onclick], [class*="icon-"]')).filter(visible).slice(0, 80).map((el) => ({
    selector: selectorFor(el),
    text: textOf(el).slice(0, 120),
    role: el.getAttribute('role') || el.tagName.toLowerCase(),
    href: el.tagName.toLowerCase() === 'a' ? el.getAttribute('href') || '' : '',
  })).filter((item) => item.text || item.href);
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]')).filter(visible).slice(0, 20).map((el) => textOf(el).slice(0, 160)).filter(Boolean);
  return {
    marker: true,
    url: location.href,
    title: document.title,
    headings,
    fields,
    clickables,
    body_text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 4000),
  };
}
""".strip()


def _mcp_result_has_login_blocker(result: Any, *, allow_auth_redirect: bool = False) -> bool:
    text = _flatten_mcp_result_text(result).lower()
    if not text:
        return False
    if allow_auth_redirect and _is_auth_redirect_text(text):
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
    return _is_auth_redirect_text(text)


def _is_auth_redirect_text(text: str) -> bool:
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
    if action_type == "click_by_selector":
        return {
            "tool": "browser_run_code",
            "arguments": {"code": _click_by_selector_code(str(action.get("selector") or ""))},
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


def _action_to_live_mcp_call(
    action: dict[str, Any],
    available_tools: set[str],
    *,
    observation: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    action_type = action.get("type")
    if action_type == "navigate" and "browser_navigate" in available_tools:
        return {"tool": "browser_navigate", "arguments": {"url": action.get("target", "")}}
    if action_type == "fill_by_label":
        field = _match_snapshot_field(action, observation)
        if field and "browser_type" in available_tools:
            return {
                "tool": "browser_type",
                "arguments": {
                    "element": str(field.get("label") or action.get("label") or "입력 필드"),
                    "ref": field["ref"],
                    "text": str(action.get("value") or ""),
                },
            }
        if _snapshot_ref_candidates(observation, "fields"):
            return None
        tool = _run_code_tool(available_tools)
        if tool:
            return {
                "tool": tool,
                "arguments": {"code": _fill_by_label_code(str(action.get("label") or ""), str(action.get("value") or ""))},
            }
        if "browser_evaluate" in available_tools:
            return {
                "tool": "browser_evaluate",
                "arguments": {"function": _fill_by_label_function(str(action.get("label") or ""), str(action.get("value") or ""))},
            }
        return None
    if action_type == "click_by_text":
        target = _match_snapshot_clickable(action, observation)
        if target and "browser_click" in available_tools:
            return {
                "tool": "browser_click",
                "arguments": {
                    "element": str(target.get("text") or "클릭 대상"),
                    "ref": target["ref"],
                },
            }
        if _snapshot_ref_candidates(observation, "clickables"):
            return None
        tool = _run_code_tool(available_tools)
        if tool:
            return {"tool": tool, "arguments": {"code": _click_by_text_code(_text_candidates(action))}}
        if "browser_evaluate" in available_tools:
            return {"tool": "browser_evaluate", "arguments": {"function": _click_by_text_function(_text_candidates(action))}}
        return None
    if action_type == "click_by_selector":
        selector = str(action.get("selector") or "").strip()
        if not selector:
            return None
        tool = _run_code_tool(available_tools)
        if tool:
            return {"tool": tool, "arguments": {"code": _click_by_selector_code(selector)}}
        if "browser_evaluate" in available_tools:
            return {"tool": "browser_evaluate", "arguments": {"function": _click_function(selector)}}
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
    if action_type == "wait":
        timeout_ms = _bounded_wait_timeout_ms(action.get("timeout_ms", action.get("timeout", 1000)))
        tool = _run_code_tool(available_tools)
        if tool:
            return {
                "tool": tool,
                "arguments": {
                    "code": f"async (page) => {{ await page.waitForTimeout({timeout_ms}); return 'waited:{timeout_ms}'; }}"
                },
            }
        if "browser_wait_for" in available_tools:
            return {"tool": "browser_wait_for", "arguments": {"time": timeout_ms / 1000}}
        return None
    if action_type == "capture_step" and "browser_snapshot" in available_tools:
        return {"tool": "browser_snapshot", "arguments": {}}
    return None


def _match_snapshot_field(action: dict[str, Any], observation: dict[str, Any] | None) -> dict[str, Any] | None:
    fields = _snapshot_ref_candidates(observation, "fields")
    explicit_ref = str(action.get("ref") or "").strip()
    if explicit_ref:
        return next((field for field in fields if str(field.get("ref")) == explicit_ref), None)
    label = _normalize_match_text(action.get("label"))
    return _unique_text_match(fields, label, ("label", "placeholder", "name", "agent_name"))


def _match_snapshot_clickable(action: dict[str, Any], observation: dict[str, Any] | None) -> dict[str, Any] | None:
    clickables = _snapshot_ref_candidates(observation, "clickables")
    explicit_ref = str(action.get("ref") or "").strip()
    if explicit_ref:
        return next((item for item in clickables if str(item.get("ref")) == explicit_ref), None)
    for text in [_normalize_match_text(item) for item in _text_candidates(action)]:
        matched = _unique_text_match(clickables, text, ("text", "aria", "title", "agent_name"))
        if matched:
            return matched
    return None


def _snapshot_ref_candidates(observation: dict[str, Any] | None, key: str) -> list[dict[str, Any]]:
    return [
        item
        for item in (observation or {}).get(key) or []
        if isinstance(item, dict) and str(item.get("ref") or "").strip()
    ]


def _unique_text_match(
    candidates: list[dict[str, Any]],
    target: str,
    keys: tuple[str, ...],
) -> dict[str, Any] | None:
    if not target:
        return None
    named = [
        (item, _normalize_match_text(next((item.get(key) for key in keys if item.get(key)), "")))
        for item in candidates
    ]
    exact = [item for item, name in named if name == target]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        return None
    partial = [item for item, name in named if name and (target in name or name in target)]
    return partial[0] if len(partial) == 1 else None


def _normalize_match_text(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "")).lower()


def _bounded_wait_timeout_ms(value: Any) -> int:
    try:
        timeout_ms = int(value)
    except (TypeError, ValueError):
        timeout_ms = 1000
    return min(max(timeout_ms, 0), 30000)


def _run_code_tool(available_tools: set[str]) -> str:
    if "browser_run_code_unsafe" in available_tools:
        return "browser_run_code_unsafe"
    if "browser_run_code" in available_tools:
        return "browser_run_code"
    return ""


def _fill_by_label_code(label: str, value: str) -> str:
    return (
        "async (page) => { "
        f"const label = {_js(label)}; "
        f"const value = {_js(value)}; "
        "const filledByDom = await page.evaluate(({ label, value }) => { "
        "const norm = (item) => String(item || '').replace(/\\s+/g, ' ').trim().toLowerCase(); "
        "const target = norm(label); "
        "const visible = (el) => { const style = window.getComputedStyle(el); const rect = el.getBoundingClientRect(); return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0; }; "
        "const labelFor = (el) => { const labels = Array.from(el.labels || []).map((item) => item.innerText).filter(Boolean); const explicit = el.id ? document.querySelector(`label[for=\"${CSS.escape(el.id)}\"]`) : null; return norm([...labels, explicit?.innerText, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.name, el.getAttribute('title'), el.innerText].filter(Boolean).join(' ')); }; "
        "const candidates = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable=\"true\"], [role=\"textbox\"]')).filter(visible); "
        "for (const el of candidates) { const candidateLabel = labelFor(el); if (!candidateLabel || !(candidateLabel.includes(target) || target.includes(candidateLabel))) continue; if (el.isContentEditable || el.getAttribute('role') === 'textbox') { el.focus(); el.textContent = value; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); el.dispatchEvent(new Event('change', { bubbles: true })); return `filled:${label}`; } el.focus(); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return `filled:${label}`; } "
        "return ''; "
        "}, { label, value }); "
        "if (filledByDom) return filledByDom; "
        "await page.getByLabel(label, { exact: false }).fill(value); "
        "return 'filled_by_label'; "
        "}"
    )


def _click_by_text_code(texts: list[str]) -> str:
    return (
        "async (page) => { "
        f"const texts = {_js_array(texts)}; "
        "const clickedByDom = await page.evaluate((texts) => { "
        "const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase(); "
        "const visible = (el) => { const style = window.getComputedStyle(el); const rect = el.getBoundingClientRect(); return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0; }; "
        "const iconTextOf = (el) => { const classText = [el.className, ...Array.from(el.querySelectorAll('[class]')).map((child) => child.className)].join(' ').toLowerCase(); const tokens = []; if (classText.includes('plus') || classText.includes('add')) tokens.push('+', '추가', 'plus', 'add'); if (classText.includes('close') || classText.includes('times') || classText.includes('xmark')) tokens.push('닫기', 'close', 'x'); if (classText.includes('search')) tokens.push('검색', 'search'); if (classText.includes('edit') || classText.includes('pencil')) tokens.push('수정', 'edit'); if (classText.includes('delete') || classText.includes('trash')) tokens.push('삭제', 'delete'); return tokens.join(' '); }; "
        "const labelOf = (el) => norm(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || iconTextOf(el)); "
        "const candidates = Array.from(document.querySelectorAll('button, [role=\"button\"], a, input[type=\"button\"], input[type=\"submit\"], [aria-label], [title], [onclick], [class*=\"icon-\"]')); "
        "for (const text of texts) { const target = norm(text); if (!target) continue; for (const el of candidates) { if (!visible(el)) continue; const label = labelOf(el); if (label && (label.includes(target) || target.includes(label))) { el.click(); return `clicked:${text}`; } } } "
        "return ''; "
        "}, texts); "
        "if (clickedByDom) return clickedByDom; "
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


def _click_by_selector_code(selector: str) -> str:
    return (
        "async (page) => { "
        f"await page.locator({_js(selector)}).first().click(); "
        "return 'clicked_by_selector'; "
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


def _fill_by_label_function(label: str, value: str) -> str:
    return (
        "() => { "
        f"const label = {_js(label)}; "
        f"const value = {_js(value)}; "
        "const norm = (item) => String(item || '').replace(/\\s+/g, ' ').trim().toLowerCase(); "
        "const target = norm(label); "
        "const visible = (el) => { "
        "const style = window.getComputedStyle(el); "
        "const rect = el.getBoundingClientRect(); "
        "return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0; "
        "}; "
        "const labelFor = (el) => { "
        "const labels = Array.from(el.labels || []).map((item) => item.innerText).filter(Boolean); "
        "const explicit = el.id ? document.querySelector(`label[for=\"${CSS.escape(el.id)}\"]`) : null; "
        "return norm([...labels, explicit?.innerText, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.name, el.getAttribute('title'), el.innerText].filter(Boolean).join(' ')); "
        "}; "
        "const candidates = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable=\"true\"], [role=\"textbox\"]')).filter(visible); "
        "for (const el of candidates) { "
        "const candidateLabel = labelFor(el); "
        "if (!candidateLabel || !(candidateLabel.includes(target) || target.includes(candidateLabel))) continue; "
        "if (el.isContentEditable || el.getAttribute('role') === 'textbox') { "
        "el.focus(); "
        "el.textContent = value; "
        "el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); "
        "el.dispatchEvent(new Event('change', { bubbles: true })); "
        "return `filled:${label}`; "
        "} "
        "el.focus(); "
        "el.value = value; "
        "el.dispatchEvent(new Event('input', { bubbles: true })); "
        "el.dispatchEvent(new Event('change', { bubbles: true })); "
        "return `filled:${label}`; "
        "} "
        "throw new Error(`field not found: ${label}`); "
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


def _click_by_text_function(texts: list[str]) -> str:
    return (
        "() => { "
        f"const texts = {_js_array(texts)}; "
        "const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase(); "
        "const visible = (el) => { "
        "const style = window.getComputedStyle(el); "
        "const rect = el.getBoundingClientRect(); "
        "return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0; "
        "}; "
        "const iconTextOf = (el) => { "
        "const classText = [el.className, ...Array.from(el.querySelectorAll('[class]')).map((child) => child.className)].join(' ').toLowerCase(); "
        "const tokens = []; "
        "if (classText.includes('plus') || classText.includes('add')) tokens.push('+', '추가', 'plus', 'add'); "
        "if (classText.includes('close') || classText.includes('times') || classText.includes('xmark')) tokens.push('닫기', 'close', 'x'); "
        "if (classText.includes('search')) tokens.push('검색', 'search'); "
        "if (classText.includes('edit') || classText.includes('pencil')) tokens.push('수정', 'edit'); "
        "if (classText.includes('delete') || classText.includes('trash')) tokens.push('삭제', 'delete'); "
        "return tokens.join(' '); "
        "}; "
        "const candidates = Array.from(document.querySelectorAll('button, [role=\"button\"], a, input[type=\"button\"], input[type=\"submit\"], [aria-label], [title], [onclick], [class*=\"icon-\"]')); "
        "for (const text of texts) { "
        "const target = norm(text); "
        "if (!target) continue; "
        "for (const el of candidates) { "
        "if (!visible(el)) continue; "
        "const label = norm(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || iconTextOf(el)); "
        "if (label && (label.includes(target) || target.includes(label))) { el.click(); return `clicked:${text}`; } "
        "} "
        "} "
        "throw new Error(`text not found: ${texts.join(', ')}`); "
        "}"
    )


def _js(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _js_array(values: list[str]) -> str:
    return json.dumps(values, ensure_ascii=False)
