from __future__ import annotations

import re
from typing import Any

from backend.app.action_safety import is_disallowed_click_texts


_ICON_NAME_HINTS = [
    ("plus", "더하기"),
    ("add", "더하기"),
    ("create", "더하기"),
    ("close", "닫기"),
    ("xmark", "닫기"),
    ("remove", "삭제"),
    ("search", "검색"),
    ("send", "전송"),
    ("submit", "전송"),
]


def enrich_page_agent_observation(observation: dict[str, Any]) -> dict[str, Any]:
    enriched = dict(observation)
    clickables: list[dict[str, Any]] = []
    for item in observation.get("clickables") or []:
        if not isinstance(item, dict):
            continue
        clickable = dict(item)
        agent_name = _agent_name(clickable)
        if agent_name:
            clickable["agent_name"] = agent_name
        clickable["agent_role"] = _agent_role(clickable)
        clickables.append(clickable)
    enriched["clickables"] = clickables
    enriched["page_agent"] = {
        "status": "ok",
        "candidate_count": len(clickables),
        "contract": "dom-observe-act-verify",
    }
    return enriched


def decide_page_agent_action(
    request: Any,
    observation: dict[str, Any],
    history: list[dict[str, Any]],
    *,
    step_index: int,
) -> dict[str, Any]:
    del step_index
    enriched = enrich_page_agent_observation(observation)
    input_action = _input_action(request, enriched, history)
    if input_action:
        return input_action
    click_action = _click_action(request, enriched, history)
    if click_action:
        return click_action
    return {"status": "skipped", "source": "page-agent-dom", "type": "finish", "reason": "no_page_agent_candidate"}


def _input_action(request: Any, observation: dict[str, Any], history: list[dict[str, Any]]) -> dict[str, Any] | None:
    input_values = getattr(request, "input_values", {}) or {}
    if not isinstance(input_values, dict) or not input_values:
        return None
    fields = [item for item in observation.get("fields") or [] if isinstance(item, dict)]
    for key, value in input_values.items():
        value_text = str(value or "").strip()
        if not value_text:
            continue
        for field in fields:
            label = _field_name(field)
            selector = str(field.get("selector") or "").strip()
            current_value = str(field.get("value") or "").strip()
            if current_value and current_value != "<redacted>":
                continue
            if not selector or not _text_matches(str(key), label):
                continue
            if _recent_failed(history, "fill_by_label", selector):
                continue
            return {
                "status": "ok",
                "source": "page-agent-dom",
                "type": "fill_by_label",
                "label": label or str(key),
                "value": value_text,
                "value_key": str(key),
                "selector": selector,
                "selector_source": "page_agent.fields",
                "reason": f"{label or key} 입력칸을 selector로 채웁니다.",
            }
    return None


def _click_action(request: Any, observation: dict[str, Any], history: list[dict[str, Any]]) -> dict[str, Any] | None:
    intents = _safe_click_intents(request)
    if not intents:
        return None
    clickables = [item for item in observation.get("clickables") or [] if isinstance(item, dict)]
    for intent in intents:
        if is_disallowed_click_texts([intent]):
            continue
        for item in clickables:
            selector = str(item.get("selector") or "").strip()
            name = _agent_name(item)
            if not selector or not name or not _text_matches(intent, name):
                continue
            if is_disallowed_click_texts([name]) or _recent_failed(history, "click_by_selector", selector):
                continue
            return {
                "status": "ok",
                "source": "page-agent-dom",
                "type": "click_by_selector",
                "selector": selector,
                "selector_source": "page_agent.clickables",
                "reason": f"{name} 요소를 selector로 선택합니다.",
            }
    return None


def _safe_click_intents(request: Any) -> list[str]:
    brief = getattr(request, "agent_brief", {}) or {}
    intents = [str(item).strip() for item in brief.get("safe_click_intents", []) or [] if str(item).strip()]
    text = f"{getattr(request, 'request_text', '')} {getattr(request, 'completion_condition', '')}"
    if any(token in text for token in ("더하기", "추가", "plus", "add")):
        intents.extend(["더하기", "추가"])
    if any(token in text for token in ("닫", "close", "modal", "모달")):
        intents.extend(["닫기", "확인"])
    if any(token in text for token in ("검색", "조회", "search")):
        intents.extend(["검색", "조회"])
    if any(token in text for token in ("전송", "질문", "send", "chat", "챗봇")):
        intents.extend(["전송", "Send", "Enter"])
    return list(dict.fromkeys(item for item in intents if item))


def _agent_name(item: dict[str, Any]) -> str:
    explicit = str(
        item.get("agent_name")
        or item.get("text")
        or item.get("title")
        or item.get("aria")
        or item.get("aria_label")
        or item.get("label")
        or ""
    ).strip()
    if explicit:
        return explicit
    class_name = str(item.get("class_name") or "").lower()
    selector = str(item.get("selector") or "").lower()
    haystack = f"{class_name} {selector}"
    for marker, name in _ICON_NAME_HINTS:
        if marker in haystack:
            return name
    return ""


def _agent_role(item: dict[str, Any]) -> str:
    role = str(item.get("role") or "").strip().lower()
    if role and role not in {"i", "svg", "span", "div"}:
        return role
    return "button"


def _field_name(field: dict[str, Any]) -> str:
    return str(field.get("label") or field.get("placeholder") or field.get("name") or field.get("agent_name") or "").strip()


def _text_matches(needle: str, haystack: str) -> bool:
    left = _compact(needle)
    right = _compact(haystack)
    return bool(left and right and (left == right or left in right or right in left))


def _compact(value: str) -> str:
    return re.sub(r"\s+", "", str(value or "")).lower()


def _recent_failed(history: list[dict[str, Any]], action_type: str, target: str) -> bool:
    target_norm = _compact(target)
    for item in history[-5:]:
        if item.get("status") not in {"failed", "blocked", "degraded"}:
            continue
        if str(item.get("type") or "") != action_type:
            continue
        reason = _compact(" ".join(str(item.get(key) or "") for key in ("reason", "selector", "label")))
        if target_norm and target_norm in reason:
            return True
    return False
