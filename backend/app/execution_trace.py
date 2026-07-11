from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal, Mapping
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, ValidationError


SUPPORTED_SCHEMA_VERSION = "1.0"
ALLOWED_ACTION_TYPES = {"navigate", "fill", "click", "press", "wait", "capture"}


class TraceValidationError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class TraceEvidence(BaseModel):
    screenshot_path: str = ""
    visible_text: list[str] = Field(default_factory=list)

    model_config = {"extra": "forbid"}


class TraceAction(BaseModel):
    id: str
    type: Literal["navigate", "fill", "click", "press", "wait", "capture"]
    target_url: str = ""
    selector: str = ""
    ref: str = ""
    label: str = ""
    value_key: str = ""
    key: str = ""
    duration_ms: int | None = None
    observed_url: str
    expected_after: str = ""
    evidence: TraceEvidence | None = None

    model_config = {"extra": "forbid"}


class TraceStep(BaseModel):
    id: str
    title: str
    narration: str
    actions: list[TraceAction]

    model_config = {"extra": "forbid"}


class CompletionEvidence(BaseModel):
    final_url: str
    assertions: list[str]
    screenshot_path: str

    model_config = {"extra": "forbid"}


class ExecutionTrace(BaseModel):
    schema_version: str
    status: Literal["completed"]
    request_summary: str
    input_values: list[str] = Field(default_factory=list)
    steps: list[TraceStep]
    completion_evidence: CompletionEvidence

    model_config = {"extra": "forbid"}


@dataclass(frozen=True)
class ExecutionTracePolicy:
    allowed_origins: tuple[str, ...] = ()
    dangerous_keywords: tuple[str, ...] = (
        "저장",
        "등록",
        "제출",
        "삭제",
        "결재",
        "발송",
        "승인",
        "확정",
        "업로드",
        "save",
        "submit",
        "delete",
        "remove",
        "approve",
        "confirm",
        "upload",
        "send",
        "create",
        "publish",
        "pay",
        "purchase",
        "checkout",
    )
    sensitive_key_markers: tuple[str, ...] = (
        "password",
        "passwd",
        "pwd",
        "secret",
        "token",
        "api_key",
        "apikey",
        "otp",
        "credential",
        "비밀번호",
        "암호",
        "인증번호",
    )


def validate_execution_trace(
    trace: ExecutionTrace | Mapping[str, Any],
    request: Any,
    policy: ExecutionTracePolicy | None = None,
) -> ExecutionTrace:
    policy = policy or ExecutionTracePolicy()
    raw = trace.model_dump(mode="json") if isinstance(trace, ExecutionTrace) else dict(trace)

    _validate_raw_shape(raw)
    try:
        parsed = ExecutionTrace.model_validate(raw)
    except ValidationError as exc:
        raise TraceValidationError("invalid_trace", str(exc)) from exc

    request_values = _request_value(request, "input_values", {})
    if not isinstance(request_values, Mapping):
        request_values = {}
    _validate_sensitive_data(parsed, raw, request_values, policy)
    _validate_actions(parsed, request_values, policy)
    _validate_origins(parsed, str(_request_value(request, "target_url", "")), policy)
    _validate_completion(parsed)
    return parsed


def _validate_raw_shape(raw: Mapping[str, Any]) -> None:
    if raw.get("schema_version") != SUPPORTED_SCHEMA_VERSION:
        raise TraceValidationError(
            "unsupported_schema_version",
            f"execution trace schema must be {SUPPORTED_SCHEMA_VERSION}",
        )

    steps = raw.get("steps")
    if not isinstance(steps, list) or not steps:
        raise TraceValidationError("empty_steps", "execution trace must contain at least one step")
    if not raw.get("completion_evidence"):
        raise TraceValidationError(
            "missing_completion_evidence",
            "execution trace must include completion evidence",
        )

    for step in steps:
        if not isinstance(step, Mapping):
            raise TraceValidationError("invalid_trace", "trace steps must be objects")
        actions = step.get("actions")
        if not isinstance(actions, list) or not actions:
            raise TraceValidationError("empty_actions", "each trace step must contain an action")
        for action in actions:
            if not isinstance(action, Mapping):
                raise TraceValidationError("invalid_trace", "trace actions must be objects")
            action_type = str(action.get("type") or "")
            if action_type not in ALLOWED_ACTION_TYPES:
                raise TraceValidationError("unknown_action", f"unsupported trace action: {action_type}")
            if "value" in action:
                raise TraceValidationError(
                    "literal_input_value",
                    "fill values must be referenced by value_key and never serialized",
                )
            if not str(action.get("observed_url") or "").strip():
                raise TraceValidationError(
                    "missing_observed_provenance",
                    f"action {action.get('id', '<unknown>')} has no observed URL",
                )


def _validate_actions(
    trace: ExecutionTrace,
    request_values: Mapping[str, Any],
    policy: ExecutionTracePolicy,
) -> None:
    seen_ids: set[str] = set()
    for step in trace.steps:
        if not step.id or step.id in seen_ids:
            raise TraceValidationError("duplicate_id", f"duplicate or empty trace id: {step.id}")
        seen_ids.add(step.id)
        for action in step.actions:
            if not action.id or action.id in seen_ids:
                raise TraceValidationError("duplicate_id", f"duplicate or empty trace id: {action.id}")
            seen_ids.add(action.id)
            _validate_action_target(action)

            if action.type in {"click", "press"} and not action.label.strip():
                raise TraceValidationError(
                    "missing_action_label",
                    f"trace action {action.id} needs an observed label for risk classification",
                )

            if action.type == "fill":
                if not action.value_key:
                    raise TraceValidationError(
                        "literal_input_value",
                        f"fill action {action.id} must use value_key",
                    )
                if action.value_key not in request_values:
                    raise TraceValidationError(
                        "unknown_value_key",
                        f"fill action {action.id} references an unknown input value",
                    )
            if action.type == "press" and not action.key:
                raise TraceValidationError("missing_key", f"press action {action.id} has no key")
            if action.type == "navigate" and not action.target_url:
                raise TraceValidationError("missing_target", f"navigate action {action.id} has no URL")

            danger_text = " ".join((action.label, action.selector, action.target_url)).lower()
            if action.type in {"click", "press"} and any(
                _contains_keyword(danger_text, keyword) for keyword in policy.dangerous_keywords
            ):
                raise TraceValidationError(
                    "dangerous_action",
                    f"trace action {action.id} requires an approval workflow",
                )


def _validate_action_target(action: TraceAction) -> None:
    if action.type not in {"fill", "click", "press"}:
        return
    if not action.ref and not action.selector:
        raise TraceValidationError(
            "missing_target",
            f"trace action {action.id} needs an observed ref or selector",
        )
    if not action.ref and _is_ambiguous_selector(action.selector):
        raise TraceValidationError(
            "ambiguous_target",
            f"trace action {action.id} uses an ambiguous selector",
        )


def _is_ambiguous_selector(selector: str) -> bool:
    normalized = " ".join(selector.strip().lower().split())
    if normalized in {
        "*",
        "a",
        "button",
        "div",
        "input",
        "span",
        "textarea",
        "[role='button']",
        '[role="button"]',
        "//a",
        "//button",
        "//input",
    }:
        return True
    if re.fullmatch(r"\[role\s*=\s*['\"]?button['\"]?\]", normalized):
        return True
    if re.fullmatch(r"\.[a-z_][a-z0-9_-]*", normalized):
        return True
    return False


def _contains_keyword(text: str, keyword: str) -> bool:
    normalized = keyword.strip().lower()
    if not normalized:
        return False
    if normalized.isascii() and normalized.replace("_", "").isalpha():
        return re.search(rf"(?<![a-z]){re.escape(normalized)}(?![a-z])", text) is not None
    return normalized in text


def _validate_sensitive_data(
    trace: ExecutionTrace,
    raw: Mapping[str, Any],
    request_values: Mapping[str, Any],
    policy: ExecutionTracePolicy,
) -> None:
    referenced_keys = set(trace.input_values)
    referenced_keys.update(
        action.value_key
        for step in trace.steps
        for action in step.actions
        if action.value_key
    )
    if any(_is_sensitive_key(key, policy.sensitive_key_markers) for key in referenced_keys):
        raise TraceValidationError(
            "sensitive_input_reference",
            "execution traces cannot reference credential or secret inputs",
        )

    sensitive_keys = {
        str(key)
        for key in request_values
        if _is_sensitive_key(str(key), policy.sensitive_key_markers)
    }
    trace_strings = tuple(_iter_string_values(raw))
    for key in sensitive_keys:
        value = str(request_values.get(key) or "")
        if value and any(text == value or (len(value) >= 4 and value in text) for text in trace_strings):
            raise TraceValidationError(
                "secret_value_exposed",
                "execution trace contains a raw secret value",
            )


def _is_sensitive_key(key: str, markers: tuple[str, ...]) -> bool:
    lowered = key.strip().lower().replace("-", "_")
    return any(marker in lowered for marker in markers)


def _iter_string_values(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for item in value.values():
            yield from _iter_string_values(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _iter_string_values(item)


def _validate_origins(
    trace: ExecutionTrace,
    target_url: str,
    policy: ExecutionTracePolicy,
) -> None:
    allowed_origins = {_origin(target_url)}
    allowed_origins.update(_origin(value) for value in policy.allowed_origins)
    allowed_origins.discard("")
    if not allowed_origins:
        raise TraceValidationError("invalid_target_url", "request target URL has no valid origin")

    urls = [trace.completion_evidence.final_url]
    for step in trace.steps:
        for action in step.actions:
            urls.append(action.observed_url)
            if action.target_url:
                urls.append(action.target_url)
    for url in urls:
        if _origin(url) not in allowed_origins:
            raise TraceValidationError("off_origin_url", f"trace URL is outside the allowed origin: {url}")


def _origin(url: str) -> str:
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as exc:
        raise TraceValidationError("invalid_url", f"trace contains an invalid URL: {url}") from exc
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise TraceValidationError("invalid_url", f"trace contains an invalid URL: {url}")
    default_port = 443 if parsed.scheme.lower() == "https" else 80
    port = port or default_port
    return f"{parsed.scheme.lower()}://{parsed.hostname.lower()}:{port}"


def _validate_completion(trace: ExecutionTrace) -> None:
    evidence = trace.completion_evidence
    if not evidence.assertions or not any(value.strip() for value in evidence.assertions):
        raise TraceValidationError(
            "missing_completion_evidence",
            "completion evidence must contain at least one assertion",
        )
    if not evidence.screenshot_path.strip():
        raise TraceValidationError(
            "missing_completion_evidence",
            "completion evidence must contain a screenshot",
        )


def _request_value(request: Any, name: str, default: Any) -> Any:
    if isinstance(request, Mapping):
        return request.get(name, default)
    return getattr(request, name, default)
