from __future__ import annotations

from typing import Any

import re

from backend.app.action_safety import is_disallowed_click_texts


BODY_TEXT_LIMIT = 2400
HEADING_LIMIT = 12
FIELD_LIMIT = 40
CLICKABLE_LIMIT = 60
HISTORY_LIMIT = 6

_FIELD_KEYS = ("selector", "label", "name", "placeholder", "type", "value", "agent_name", "agent_role")
_CLICKABLE_KEYS = ("selector", "text", "title", "aria", "class_name", "role", "href", "agent_name", "agent_role")
_HISTORY_KEYS = (
    "step",
    "action_id",
    "step_id",
    "type",
    "source",
    "status",
    "reason",
    "label",
    "value_key",
    "texts",
    "selector",
    "key",
    "timeout_ms",
    "capture",
)


def compact_observation(observation: dict[str, Any]) -> dict[str, Any]:
    compacted: dict[str, Any] = {}
    for key in ("url", "title"):
        value = observation.get(key)
        if value not in (None, ""):
            compacted[key] = value
    compacted["headings"] = [str(item)[:300] for item in (observation.get("headings") or [])[:HEADING_LIMIT]]
    compacted["fields"] = _compact_items(observation.get("fields"), _FIELD_KEYS, FIELD_LIMIT)
    compacted["clickables"] = _compact_items(observation.get("clickables"), _CLICKABLE_KEYS, CLICKABLE_LIMIT)
    compacted["body_text"] = str(observation.get("body_text") or "")[:BODY_TEXT_LIMIT]

    screenshot = observation.get("screenshot")
    if isinstance(screenshot, dict):
        compacted["screenshot"] = {
            key: screenshot.get(key)
            for key in ("status", "path", "filename")
            if screenshot.get(key) not in (None, "")
        }
    page_agent = observation.get("page_agent")
    if isinstance(page_agent, dict):
        compacted["page_agent"] = {
            key: page_agent.get(key)
            for key in ("status", "candidate_count", "contract")
            if page_agent.get(key) not in (None, "")
        }
    return compacted


def compact_history(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    compacted: list[dict[str, Any]] = []
    for item in history[-HISTORY_LIMIT:]:
        if not isinstance(item, dict):
            continue
        summary = {key: item.get(key) for key in _HISTORY_KEYS if item.get(key) not in (None, "", [], {})}
        verification = item.get("verification")
        if isinstance(verification, dict):
            summary["verification"] = {
                key: verification.get(key)
                for key in ("status", "changed", "reason")
                if verification.get(key) not in (None, "")
            }
        compacted.append(summary)
    return compacted


def validate_browser_action(
    action: dict[str, Any],
    request: Any,
    observation: dict[str, Any],
    history: list[dict[str, Any]],
) -> list[str]:
    errors: list[str] = []
    action_type = str(action.get("type") or "")
    fields = [item for item in observation.get("fields") or [] if isinstance(item, dict)]
    clickables = [item for item in observation.get("clickables") or [] if isinstance(item, dict)]
    observed_selectors = {
        str(item.get("selector") or "").strip()
        for item in [*fields, *clickables]
        if str(item.get("selector") or "").strip()
    }

    if str(action.get("status") or "ok") not in {"ok", ""}:
        errors.append("action_status_not_ok")
    if action_type == "fill_by_label":
        value_key = str(action.get("value_key") or "").strip()
        input_values = getattr(request, "input_values", {}) or {}
        if value_key not in input_values:
            errors.append("fill_value_key_not_provided")
        selector = str(action.get("selector") or "").strip()
        label = str(action.get("label") or "").strip()
        if selector and selector not in observed_selectors:
            errors.append("selector_not_observed")
        if not selector and not any(_text_matches(label, _field_name(field)) for field in fields):
            errors.append("fill_target_not_observed")
    elif action_type == "click_by_selector":
        selector = str(action.get("selector") or "").strip()
        if not selector or selector not in observed_selectors:
            errors.append("selector_not_observed")
        matched = [item for item in clickables if str(item.get("selector") or "").strip() == selector]
        if matched and is_disallowed_click_texts([_clickable_name(matched[0])]):
            errors.append("disallowed_click")
        if matched and _is_submission_target(_clickable_name(matched[0])) and _has_pending_visible_input(request, fields):
            errors.append("click_before_required_input")
    elif action_type == "click_by_text":
        texts = _text_values(action.get("texts") or action.get("text") or action.get("label"))
        if is_disallowed_click_texts(texts):
            errors.append("disallowed_click")
        if not any(_text_matches(text, _clickable_name(item)) for text in texts for item in clickables):
            errors.append("click_target_not_observed")
        if any(_is_submission_target(text) for text in texts) and _has_pending_visible_input(request, fields):
            errors.append("click_before_required_input")
    elif action_type == "press_key":
        if str(action.get("key") or "").lower() not in {"enter", "return"}:
            errors.append("unsupported_key")
        if not any(item.get("type") == "fill_by_label" and item.get("status") == "ok" for item in history):
            errors.append("press_without_successful_fill")
    elif action_type == "capture_step":
        if history and str(history[-1].get("type") or "") == "capture_step":
            errors.append("consecutive_capture")
    elif action_type == "finish":
        if not _success_evidence(request, observation, history):
            errors.append("finish_without_success_evidence")
        if not any(item.get("type") == "capture_step" and item.get("status") == "ok" for item in history):
            errors.append("finish_without_success_capture")

    if _repeats_unchanged_action(action, history):
        errors.append("repeated_action_without_page_change")
    return list(dict.fromkeys(errors))


def _compact_items(value: Any, keys: tuple[str, ...], limit: int) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    compacted: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for item in value:
        if not isinstance(item, dict):
            continue
        summary = {key: item.get(key) for key in keys if item.get(key) not in (None, "")}
        identity = (
            str(summary.get("selector") or ""),
            str(summary.get("label") or summary.get("text") or ""),
            str(summary.get("value") or ""),
        )
        if identity in seen:
            continue
        seen.add(identity)
        compacted.append(summary)
        if len(compacted) >= limit:
            break
    return compacted


def _field_name(field: dict[str, Any]) -> str:
    return str(field.get("label") or field.get("placeholder") or field.get("name") or field.get("agent_name") or "").strip()


def _clickable_name(item: dict[str, Any]) -> str:
    return str(
        item.get("agent_name")
        or item.get("text")
        or item.get("title")
        or item.get("aria")
        or item.get("href")
        or ""
    ).strip()


def _text_values(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    text = str(value or "").strip()
    return [text] if text else []


def _text_matches(left: str, right: str) -> bool:
    left_norm = _normalize_text(left)
    right_norm = _normalize_text(right)
    return bool(left_norm and right_norm and (left_norm == right_norm or left_norm in right_norm or right_norm in left_norm))


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", "", str(value or "")).lower()


def _repeats_unchanged_action(action: dict[str, Any], history: list[dict[str, Any]]) -> bool:
    if not history:
        return False
    previous = history[-1]
    verification = previous.get("verification") if isinstance(previous.get("verification"), dict) else {}
    unchanged = verification.get("changed") is False or previous.get("verification_status") == "failed"
    return unchanged and _action_signature(action) == _action_signature(previous)


def _action_signature(action: dict[str, Any]) -> tuple[str, str]:
    action_type = str(action.get("type") or "")
    target = str(
        action.get("selector")
        or action.get("label")
        or action.get("key")
        or "|".join(_text_values(action.get("texts") or action.get("text")))
        or ""
    )
    return action_type, _normalize_text(target)


def _success_evidence(request: Any, observation: dict[str, Any], history: list[dict[str, Any]]) -> bool:
    has_successful_action = any(
        item.get("status") == "ok" and item.get("type") in {"click_by_selector", "click_by_text", "press_key"}
        for item in history
    )
    if not has_successful_action:
        return False
    text = _normalize_text(
        " ".join(
            [
                str(observation.get("title") or ""),
                str(observation.get("body_text") or ""),
                " ".join(str(item) for item in observation.get("headings") or []),
            ]
        )
    )
    task_type = str((getattr(request, "agent_brief", {}) or {}).get("task_type") or "")
    if task_type == "chat_prompt":
        return any(token in text for token in ("답변", "응답", "assistant", "answer", "response"))
    if task_type == "lookup":
        return any(token in text for token in ("조회결과", "검색결과", "결과", "건수", "목록"))
    criteria = [str(getattr(request, "completion_condition", "") or "")]
    criteria.extend(str(item) for item in (getattr(request, "agent_brief", {}) or {}).get("success_criteria", []) or [])
    meaningful = [
        _normalize_text(re.sub(r"(보이면|표시되면|완료|확인)", "", item))
        for item in criteria
        if len(_normalize_text(item)) >= 3
    ]
    return any(item and item in text for item in meaningful)


def _has_pending_visible_input(request: Any, fields: list[dict[str, Any]]) -> bool:
    input_values = getattr(request, "input_values", {}) or {}
    for key, expected_value in input_values.items():
        expected = str(expected_value or "").strip()
        if not expected:
            continue
        if any(str(field.get("value") or "").strip() == expected for field in fields):
            continue
        candidates = [field for field in fields if _field_matches_input_key(field, str(key))]
        if candidates and any(str(field.get("value") or "").strip() in {"", "<redacted>"} for field in candidates):
            return True
    return False


def _field_matches_input_key(field: dict[str, Any], key: str) -> bool:
    name = _field_name(field)
    if _text_matches(key, name):
        return True
    normalized_name = _normalize_text(name)
    return any(alias in normalized_name or normalized_name in alias for alias in _input_aliases(key) if normalized_name)


def _input_aliases(key: str) -> list[str]:
    normalized = _normalize_text(key)
    aliases: list[str] = []
    if any(token in normalized for token in ("질문", "프롬프트", "메시지", "prompt", "question", "chat")):
        aliases.extend(["질문", "프롬프트", "메시지", "ask", "question", "prompt", "chat", "groundedquestion"])
    if any(token in normalized for token in ("검색", "조회", "search", "query", "keyword")):
        aliases.extend(["검색", "조회", "search", "query", "keyword", "publishedwikipages"])
    return [_normalize_text(item) for item in aliases]


def _is_submission_target(value: str) -> bool:
    normalized = _normalize_text(value)
    return any(token in normalized for token in ("전송", "send", "ask", "검색", "search", "조회", "submit"))
