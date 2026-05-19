from __future__ import annotations

import re
from typing import Any


SENSITIVE_KEY_PARTS = (
    "password",
    "passwd",
    "pwd",
    "token",
    "secret",
    "apikey",
    "api_key",
    "ticket",
    "otp",
    "pin",
    "credential",
    "authorization",
)


def redact_sensitive(value: Any) -> Any:
    return _redact(value, sensitive_context=False)


class RedactionPipeline:
    def __init__(self, *, sensitive_values: dict[str, Any] | None = None) -> None:
        self.sensitive_values = {
            str(key): str(value)
            for key, value in (sensitive_values or {}).items()
            if str(value) and is_sensitive_key(str(key))
        }

    def redact_json(self, value: Any) -> Any:
        return redact_sensitive(value)

    def redact_text(self, value: str) -> str:
        redacted = _SECRET_ASSIGNMENT_RE.sub(lambda match: f"{match.group(1)}=<redacted>", value)
        for item in sorted(set(self.sensitive_values.values()), key=len, reverse=True):
            if not item or item == "<redacted>":
                continue
            redacted = redacted.replace(item, "<redacted>")
        return redacted


def is_sensitive_key(value: str) -> bool:
    return _is_sensitive_text(value)


def _redact(value: Any, *, sensitive_context: bool) -> Any:
    if sensitive_context:
        return "<redacted>"
    if isinstance(value, dict):
        return _redact_dict(value)
    if isinstance(value, list):
        return [_redact(item, sensitive_context=False) for item in value]
    return value


def _redact_dict(value: dict[Any, Any]) -> dict[Any, Any]:
    value_context_is_sensitive = _dict_value_context_is_sensitive(value)
    redacted: dict[Any, Any] = {}
    for key, item in value.items():
        key_text = str(key)
        key_is_sensitive = _is_sensitive_text(key_text)
        item_context_is_sensitive = key_is_sensitive or (key_text in {"value", "text"} and value_context_is_sensitive)
        redacted[key] = _redact(item, sensitive_context=item_context_is_sensitive)
    return redacted


def _dict_value_context_is_sensitive(value: dict[Any, Any]) -> bool:
    for context_key in ("selector", "selector_hint", "element", "name", "label", "id", "field", "target"):
        context_value = value.get(context_key)
        if isinstance(context_value, str) and _is_sensitive_text(context_value):
            return True
    return False


def _is_sensitive_text(value: str) -> bool:
    normalized = value.lower().replace("-", "_").replace(" ", "_")
    compact = normalized.replace("_", "")
    return any(part in normalized or part.replace("_", "") in compact for part in SENSITIVE_KEY_PARTS)


_SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)\b(password|passwd|pwd|token|secret|api[_-]?key|authorization|otp|pin)\s*[:=]\s*([^\s,;]+)"
)
