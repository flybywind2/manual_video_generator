from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable

from backend.app.action_safety import is_disallowed_click_texts
from backend.app.adapters.planner import post_json
from backend.app.config import AppSettings
from backend.app.llm_logging import record_llm_response


HttpPost = Callable[[str, dict[str, str], dict[str, Any], float], dict[str, Any]]

_ALLOWED_ACTION_TYPES = {"fill_by_label", "click_by_text", "press_key", "wait", "capture_step", "finish"}
_DANGEROUS_CLICK_KEYWORDS = {
    "삭제",
    "저장",
    "등록",
    "생성",
    "수정",
    "확정",
    "승인",
    "반려",
    "제출",
    "취소",
    "delete",
    "save",
    "submit",
    "approve",
    "reject",
}


def decide_browser_agent_action(
    request: Any,
    settings: AppSettings,
    observation: dict[str, Any],
    history: list[dict[str, Any]],
    *,
    step_index: int,
    http_post: HttpPost | None = None,
    package_dir: Path | None = None,
) -> dict[str, Any]:
    if not settings.enable_browser_agent:
        return {"status": "disabled", "type": "finish", "reason": "browser_agent_disabled"}
    if not settings.llm.is_configured:
        return {"status": "disabled", "type": "finish", "reason": "llm_not_configured"}
    if _has_login_blocker(observation):
        return {"status": "blocked", "type": "finish", "reason": "login_required"}

    post = post_json if http_post is None else http_post
    url = f"{settings.llm.base_url.rstrip('/')}/chat/completions"
    headers = settings.llm.chat_headers()
    payload = {
        "model": settings.llm.model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a browser automation agent for an internal system manual video. "
                    "Inspect the current Playwright page observation, the augmented agent brief, and the recent history. "
                    "Choose exactly one next safe action that moves the user objective forward. "
                    "Each turn will be executed as observe -> act -> verify, so choose an action that can be verified from the next page state. "
                    "Return JSON only. Allowed types: fill_by_label, click_by_text, press_key, wait, capture_step, finish. "
                    "Use fill_by_label only with provided input_values; if the visible field label differs from the input key, map the closest field to the value. "
                    "Use click_by_text only for navigation/search/detail/read/send actions listed in safe_click_intents or clearly required by the objective. "
                    "Use press_key only for Enter after a chat/search input has already been filled and needs submission. "
                    "If the previous action failed, do not repeat the same label/text; pick another visible candidate or finish with a clear reason. "
                    "Capture meaningful milestones after data entry, after search/send, and before finish. "
                    "Finish only after success_criteria is likely satisfied or a login/blocker prevents progress. "
                    "Never click optional feature toggles, tool switches, model/provider selectors, or web search/browsing controls. "
                    "Never choose destructive or write actions such as save, submit, delete, approve, reject, create, update, register."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "step_index": step_index,
                        "request_text": request.request_text,
                        "target_url": request.target_url,
                        "role": request.role,
                        "completion_condition": request.completion_condition,
                        "input_values": request.input_values,
                        "agent_brief": getattr(request, "agent_brief", {}) or {},
                        "observation": observation,
                        "history": history[-8:],
                        "recent_failures": [item for item in history[-8:] if item.get("status") in {"failed", "blocked", "degraded"}],
                        "output_schema": {
                            "type": "fill_by_label|click_by_text|press_key|wait|capture_step|finish",
                            "label": "field label for fill_by_label",
                            "value_key": "key from input_values",
                            "texts": ["button/link text candidates for click_by_text"],
                            "key": "Enter for press_key",
                            "timeout_ms": "wait duration for wait",
                            "reason": "short Korean reason",
                        },
                    },
                    ensure_ascii=False,
                ),
            },
        ],
        "temperature": 0.1,
        "extra_body": {"chat_template_kwargs": {"enable_thinking": False}},
    }
    response = post(url, headers, payload, settings.llm_timeout_seconds)
    content = response["choices"][0]["message"]["content"]
    record_llm_response(
        component="browser_agent",
        model=settings.llm.model,
        response=response,
        content=content,
        terminal_enabled=settings.enable_terminal_logs,
        package_dir=package_dir,
    )
    return _normalize_browser_agent_action(_parse_json_content(content), request)


def _normalize_browser_agent_action(data: dict[str, Any], request: Any) -> dict[str, Any]:
    action_type = str(data.get("type") or "").strip().lower()
    if action_type not in _ALLOWED_ACTION_TYPES:
        return {"status": "failed", "type": "finish", "reason": "unsupported_action_type", "raw_type": action_type}

    action: dict[str, Any] = {
        "status": "ok",
        "source": "browser-agent-llm",
        "type": action_type,
        "reason": str(data.get("reason") or "").strip(),
    }
    if action_type == "fill_by_label":
        label = str(data.get("label") or data.get("name") or "").strip()
        value_key = str(data.get("value_key") or label).strip()
        value = _resolve_fill_value(data, request, value_key=value_key, label=label)
        if not label or value is None or str(value) == "":
            return {"status": "failed", "type": "finish", "reason": "missing_fill_label_or_value"}
        action.update({"label": label, "value": str(value), "value_key": value_key})
    elif action_type == "click_by_text":
        texts = _text_candidates(data.get("texts", data.get("text", data.get("label", ""))))
        if not texts:
            return {"status": "failed", "type": "finish", "reason": "missing_click_text"}
        if _is_enter_key_text(texts):
            return {
                "status": "ok",
                "source": "browser-agent-llm",
                "type": "press_key",
                "reason": action["reason"],
                "key": "Enter",
            }
        if _has_dangerous_text(texts):
            return {"status": "blocked", "type": "finish", "reason": "dangerous_click_text", "texts": texts}
        if is_disallowed_click_texts(texts):
            return {"status": "blocked", "type": "finish", "reason": "disallowed_click_text", "texts": texts}
        action["texts"] = texts
    elif action_type == "press_key":
        key = str(data.get("key") or "").strip()
        if key.lower() not in {"enter", "return"}:
            return {"status": "blocked", "type": "finish", "reason": "unsupported_key", "key": key}
        action["key"] = "Enter"
    elif action_type == "wait":
        action["timeout_ms"] = _positive_int(data.get("timeout_ms", data.get("timeout", 1000)), default=1000)
    return action


def _resolve_fill_value(data: dict[str, Any], request: Any, *, value_key: str, label: str) -> Any:
    input_values = getattr(request, "input_values", {}) or {}
    if value_key in input_values:
        return input_values[value_key]
    if label in input_values:
        return input_values[label]
    normalized_label = _compact_text(label)
    for key, value in input_values.items():
        normalized_key = _compact_text(str(key))
        if normalized_key and (normalized_key in normalized_label or normalized_label in normalized_key):
            return value
    if "value" in data:
        return data.get("value")
    if len(input_values) == 1:
        return next(iter(input_values.values()))
    return ""


def _compact_text(value: str) -> str:
    return re.sub(r"\s+", "", value).lower()


def _parse_json_content(content: str) -> dict[str, Any]:
    text = content.strip()
    candidates = [match.group(1).strip() for match in re.finditer(r"```(?:json)?\s*(.*?)```", text, flags=re.I | re.S)]
    candidates.append(text)
    for candidate in reversed([item for item in candidates if item]):
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data

    decoder = json.JSONDecoder()
    parsed_objects: list[dict[str, Any]] = []
    for index, char in enumerate(text):
        if char != "{":
            continue
        try:
            data, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            parsed_objects.append(data)
    if parsed_objects:
        return parsed_objects[-1]
    raise ValueError("browser agent response must contain a JSON object")


def _text_candidates(raw: Any) -> list[str]:
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    value = str(raw).strip()
    return [value] if value else []


def _has_dangerous_text(texts: list[str]) -> bool:
    lowered = " ".join(texts).lower()
    return any(keyword in lowered for keyword in _DANGEROUS_CLICK_KEYWORDS)


def _is_enter_key_text(texts: list[str]) -> bool:
    normalized = {text.strip().lower() for text in texts if text.strip()}
    return bool(normalized) and normalized.issubset({"enter", "return", "엔터"})


def _has_login_blocker(observation: dict[str, Any]) -> bool:
    text = str(observation.get("body_text") or "").lower()
    if not text:
        return False
    korean_login = "로그인 또는 회원가입" in text or ("google로 계속하기" in text and "apple로 계속하기" in text)
    english_login = "sign in" in text and ("continue with google" in text or "continue with apple" in text)
    return korean_login or english_login


def _positive_int(value: Any, *, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(parsed, 0)
