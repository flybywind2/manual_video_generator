from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable

from backend.app.adapters.planner import post_json
from backend.app.config import AppSettings
from backend.app.llm_logging import record_llm_response
from backend.app.redaction import is_sensitive_key, redact_sensitive


HttpPost = Callable[[str, dict[str, str], dict[str, Any], float], dict[str, Any]]


def extract_input_values(
    request: Any,
    settings: AppSettings,
    *,
    package_dir: Path | None = None,
    http_post: HttpPost | None = None,
) -> dict[str, Any]:
    explicit_values = _filter_values(getattr(request, "input_values", {}) or {})
    if not settings.enable_input_extractor:
        result = _result(
            status="skipped",
            source="disabled",
            extracted_values={},
            explicit_values=explicit_values,
            reason="input extractor disabled",
        )
        _write_metadata(package_dir, result)
        return result

    source = "local-deterministic"
    status = "ok"
    reason = ""
    try:
        extracted_values = (
            _extract_with_llm(request, settings, package_dir=package_dir, http_post=http_post)
            if settings.llm.is_configured
            else _extract_locally(request)
        )
        source = "internal-llm" if settings.llm.is_configured else "local-deterministic"
    except Exception as exc:  # noqa: BLE001 - local extraction keeps the pipeline usable.
        extracted_values = _extract_locally(request)
        source = "local-deterministic-fallback"
        status = "degraded"
        reason = f"{type(exc).__name__}: {exc}"

    result = _result(
        status=status,
        source=source,
        extracted_values=_filter_values(extracted_values),
        explicit_values=explicit_values,
        reason=reason,
    )
    _write_metadata(package_dir, result)
    return result


def _extract_with_llm(
    request: Any,
    settings: AppSettings,
    *,
    package_dir: Path | None,
    http_post: HttpPost | None,
) -> dict[str, str]:
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
                    "너는 사내 시스템 매뉴얼 영상 제작 요청문에서 화면 입력에 필요한 값만 추출한다. "
                    "반드시 JSON만 반환한다. JSON schema: {\"input_values\":{\"필드명\":\"값\"}}. "
                    "비밀번호, OTP, PIN, token, API key, ticket, credential, authorization 값은 절대 추출하지 않는다. "
                    "로그인 계정 정보도 추출하지 않는다. 조회/검색/필터 조건처럼 화면에 입력할 업무 값만 추출한다."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "request_text": request.request_text,
                        "target_url": request.target_url,
                        "role": request.role,
                        "completion_condition": request.completion_condition,
                        "explicit_input_values": redact_sensitive(getattr(request, "input_values", {}) or {}),
                    },
                    ensure_ascii=False,
                ),
            },
        ],
        "temperature": 0.0,
        "extra_body": {"chat_template_kwargs": {"enable_thinking": False}},
    }
    response = post(url, headers, payload, settings.llm_timeout_seconds)
    content = response["choices"][0]["message"]["content"]
    record_llm_response(
        component="input_extractor",
        model=settings.llm.model,
        response=response,
        content=content,
        terminal_enabled=settings.enable_terminal_logs,
        package_dir=package_dir,
    )
    return _parse_llm_values(content)


def _parse_llm_values(content: str) -> dict[str, str]:
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
        raise ValueError("input extractor response must be an object")
    values = data.get("input_values", data.get("values", data))
    if not isinstance(values, dict):
        raise ValueError("input extractor response must contain input_values object")
    return {str(key).strip(): str(value).strip() for key, value in values.items() if str(key).strip() and str(value).strip()}


def _extract_locally(request: Any) -> dict[str, str]:
    text = f"{request.request_text} {request.completion_condition}"
    values: dict[str, str] = {}
    _put(values, "LOT", _first_match(text, r"(?<![A-Za-z0-9])(LOT[-_]?[A-Za-z0-9]+)", flags=re.IGNORECASE))
    _put(values, "라인", _first_match(text, r"(?:라인|line)\s*[:=]?\s*([A-Za-z][A-Za-z0-9_-]{0,12})", flags=re.IGNORECASE))
    _put(values, "사용자ID", _first_match(text, r"(?:사용자\s*(?:ID|아이디)?|user\s*id)\s*[:=]?\s*([A-Za-z][A-Za-z0-9_-]{1,30})", flags=re.IGNORECASE))
    _put(values, "사번", _first_match(text, r"사번\s*[:=]?\s*([A-Za-z0-9_-]{3,30})"))
    _put(values, "부서", _first_match(text, r"부서\s*[:=]?\s*([가-힣A-Za-z0-9_-]{2,30})"))

    for key, value in re.findall(r"([A-Za-z가-힣][A-Za-z0-9가-힣_-]{1,20})\s*[:=]\s*([A-Za-z0-9가-힣_.-]{1,60})", text):
        _put(values, key, value)
    return values


def _result(
    *,
    status: str,
    source: str,
    extracted_values: dict[str, str],
    explicit_values: dict[str, str],
    reason: str,
) -> dict[str, Any]:
    effective_values = {**extracted_values, **explicit_values}
    return {
        "status": status,
        "source": source,
        "reason": reason,
        "extracted_input_values": extracted_values,
        "explicit_input_keys": sorted(explicit_values),
        "effective_input_values": effective_values,
        "extracted_count": len(extracted_values),
        "effective_count": len(effective_values),
    }


def _filter_values(values: dict[str, Any]) -> dict[str, str]:
    filtered: dict[str, str] = {}
    for key, value in values.items():
        key_text = str(key).strip()
        value_text = str(value).strip()
        if not key_text or not value_text or is_sensitive_key(key_text):
            continue
        filtered[key_text] = value_text
    return filtered


def _put(values: dict[str, str], key: str, value: str) -> None:
    if value and not is_sensitive_key(key):
        values.setdefault(key, value.strip())


def _first_match(text: str, pattern: str, *, flags: int = 0) -> str:
    match = re.search(pattern, text, flags)
    return match.group(1).strip() if match else ""


def _write_metadata(package_dir: Path | None, result: dict[str, Any]) -> None:
    if package_dir is None:
        return
    package_dir.mkdir(parents=True, exist_ok=True)
    (package_dir / "input_extraction.json").write_text(
        json.dumps(redact_sensitive(result), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
