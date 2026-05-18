from __future__ import annotations

import json
from typing import Any, Callable

from backend.app.config import AppSettings
from backend.app.adapters.planner import post_json


HttpPost = Callable[[str, dict[str, str], dict[str, Any], float], dict[str, Any]]

_ALLOWED_ACTION_TYPES = {"fill_by_label", "click_by_text", "wait", "capture_step", "finish"}
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
) -> dict[str, Any]:
    if not settings.enable_browser_agent:
        return {"status": "disabled", "type": "finish", "reason": "browser_agent_disabled"}
    if not settings.llm.is_configured:
        return {"status": "disabled", "type": "finish", "reason": "llm_not_configured"}

    post = post_json if http_post is None else http_post
    url = f"{settings.llm.base_url.rstrip('/')}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.llm.api_key}",
        **settings.llm.default_headers(),
    }
    payload = {
        "model": settings.llm.model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a browser automation agent for an internal system manual video. "
                    "Inspect the current Playwright page observation and choose exactly one next safe read-only action. "
                    "Return JSON only. Allowed types: fill_by_label, click_by_text, wait, capture_step, finish. "
                    "Use fill_by_label only with provided input_values. Use click_by_text only for navigation/search/detail/read actions. "
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
                        "observation": observation,
                        "history": history[-8:],
                        "output_schema": {
                            "type": "fill_by_label|click_by_text|wait|capture_step|finish",
                            "label": "field label for fill_by_label",
                            "value_key": "key from input_values",
                            "texts": ["button/link text candidates for click_by_text"],
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
    response = post(url, headers, payload, settings.request_timeout_seconds)
    content = response["choices"][0]["message"]["content"]
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
        value = request.input_values.get(value_key, request.input_values.get(label, data.get("value", "")))
        if not label or value is None or str(value) == "":
            return {"status": "failed", "type": "finish", "reason": "missing_fill_label_or_value"}
        action.update({"label": label, "value": str(value), "value_key": value_key})
    elif action_type == "click_by_text":
        texts = _text_candidates(data.get("texts", data.get("text", data.get("label", ""))))
        if not texts:
            return {"status": "failed", "type": "finish", "reason": "missing_click_text"}
        if _has_dangerous_text(texts):
            return {"status": "blocked", "type": "finish", "reason": "dangerous_click_text", "texts": texts}
        action["texts"] = texts
    elif action_type == "wait":
        action["timeout_ms"] = _positive_int(data.get("timeout_ms", data.get("timeout", 1000)), default=1000)
    return action


def _parse_json_content(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("browser agent response must be a JSON object")
    return data


def _text_candidates(raw: Any) -> list[str]:
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    value = str(raw).strip()
    return [value] if value else []


def _has_dangerous_text(texts: list[str]) -> bool:
    lowered = " ".join(texts).lower()
    return any(keyword in lowered for keyword in _DANGEROUS_CLICK_KEYWORDS)


def _positive_int(value: Any, *, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(parsed, 0)
