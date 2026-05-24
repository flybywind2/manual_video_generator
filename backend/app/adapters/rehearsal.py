from __future__ import annotations

import json
import shlex
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
                    observation = _observe_with_mcp(client, available_tools)
                    decide_kwargs: dict[str, Any] = {"step_index": step_index}
                    if decide_next is decide_browser_agent_action:
                        decide_kwargs["package_dir"] = package_dir
                    action = dict(decide_next(request, settings, observation, history, **decide_kwargs))
                    action.setdefault("id", f"mcp_agent_{step_index}")
                    action.setdefault("source", "browser-agent-llm")
                    turn: dict[str, Any] = {
                        "step": step_index,
                        "observation": observation,
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
                    live_call = _action_to_live_mcp_call(action, available_tools)
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
                    verification = _verify_mcp_agent_turn(client, available_tools, observation)
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


def _observe_with_mcp(client: Any, available_tools: set[str]) -> dict[str, Any]:
    tool = _run_code_tool(available_tools)
    if not tool:
        if "browser_evaluate" in available_tools:
            result = client.call_tool("browser_evaluate", {"function": _mcp_observe_function()})
            parsed = _parse_mcp_observation(result)
            if parsed:
                return parsed
        if "browser_snapshot" in available_tools:
            result = client.call_tool("browser_snapshot", {})
            return {"body_text": _flatten_mcp_result_text(result), "fields": [], "clickables": []}
        return {"body_text": "", "fields": [], "clickables": []}
    result = client.call_tool(tool, {"code": _mcp_observe_code()})
    parsed = _parse_mcp_observation(result)
    if parsed:
        return parsed
    return {"body_text": _flatten_mcp_result_text(result), "fields": [], "clickables": []}


def _verify_mcp_agent_turn(client: Any, available_tools: set[str], before_observation: dict[str, Any]) -> dict[str, Any]:
    try:
        after = _observe_with_mcp(client, available_tools)
    except Exception as exc:  # noqa: BLE001
        return {"phase": "verify", "status": "failed", "reason": f"observe_failed:{type(exc).__name__}"}
    return {
        "phase": "verify",
        "status": "ok",
        "changed": _mcp_observation_signature(after) != _mcp_observation_signature(before_observation),
        "reason": "observed_after_action",
    }


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
        return result["observation"]
    text = _flatten_mcp_result_text(result).strip()
    if not text:
        return {}
    candidates = [text]
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        candidates.insert(0, text[start : end + 1])
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return {}


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
    const fields = Array.from(document.querySelectorAll('input, textarea, select')).filter(visible).slice(0, 40).map((el) => ({
      selector: selectorFor(el),
      label: labelFor(el),
      name: el.name || '',
      placeholder: el.getAttribute('placeholder') || '',
      type: el.getAttribute('type') || el.tagName.toLowerCase(),
      value: el.type === 'password' ? '<redacted>' : String(el.value || '').slice(0, 80),
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
  const fields = Array.from(document.querySelectorAll('input, textarea, select')).filter(visible).slice(0, 40).map((el) => ({
    selector: selectorFor(el),
    label: labelFor(el),
    name: el.name || '',
    placeholder: el.getAttribute('placeholder') || '',
    type: el.getAttribute('type') || el.tagName.toLowerCase(),
    value: el.type === 'password' ? '<redacted>' : String(el.value || '').slice(0, 80),
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
        if "browser_evaluate" in available_tools:
            return {"tool": "browser_evaluate", "arguments": {"function": _click_by_text_function(_text_candidates(action))}}
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
        f"await page.getByLabel({_js(label)}, {{ exact: false }}).fill({_js(value)}); "
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
    return json.dumps(value)


def _js_array(values: list[str]) -> str:
    return json.dumps(values, ensure_ascii=False)
