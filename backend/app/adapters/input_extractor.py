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
            request=request,
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
        source = settings.llm.source_label if settings.llm.is_configured else "local-deterministic"
    except Exception as exc:  # noqa: BLE001 - local extraction keeps the pipeline usable.
        extracted_values = _extract_locally(request)
        source = "local-deterministic-fallback"
        status = "degraded"
        reason = f"{type(exc).__name__}: {exc}"

    result = _result(
        request=request,
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
    headers = settings.llm.chat_headers()
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
    request: Any,
    status: str,
    source: str,
    extracted_values: dict[str, str],
    explicit_values: dict[str, str],
    reason: str,
) -> dict[str, Any]:
    effective_values = {**extracted_values, **explicit_values}
    scenario_brief = _build_scenario_brief(request, effective_values)
    return {
        "status": status,
        "source": source,
        "reason": reason,
        "extracted_input_values": extracted_values,
        "explicit_input_keys": sorted(explicit_values),
        "effective_input_values": effective_values,
        "scenario_brief": scenario_brief,
        "extracted_count": len(extracted_values),
        "effective_count": len(effective_values),
    }


def _build_scenario_brief(request: Any, effective_values: dict[str, str]) -> dict[str, Any]:
    request_text = str(getattr(request, "request_text", "") or "")
    completion_condition = str(getattr(request, "completion_condition", "") or "")
    combined = f"{request_text} {completion_condition}".lower()
    task_type = _infer_task_type(combined)
    safe_click_intents = _infer_safe_click_intents(combined, task_type)
    forbidden_click_intents = [
        "Web Search",
        "웹 검색",
        "검색 토글",
        "모델 선택",
        "도구 선택",
        "설정",
        "삭제",
        "저장",
        "등록",
        "수정",
        "승인",
        "반려",
        "제출",
    ]
    success_criteria = [item for item in [completion_condition.strip(), _inferred_success_criterion(task_type)] if item]
    return {
        "task_type": task_type,
        "objective": _redact_sensitive_free_text(request_text.strip()),
        "role": str(getattr(request, "role", "") or "").strip(),
        "success_criteria": list(dict.fromkeys(success_criteria)),
        "required_inputs": sorted(effective_values),
        "safe_click_intents": safe_click_intents,
        "forbidden_click_intents": forbidden_click_intents,
        "autonomy_guidance": _autonomy_guidance(task_type),
    }


def _infer_task_type(text: str) -> str:
    if any(keyword in text for keyword in ("chatbot", "chat bot", "챗봇", "채팅", "prompt", "프롬프트", "질문")):
        return "chat_prompt"
    if any(keyword in text for keyword in ("조회", "검색", "search", "lookup")):
        return "lookup"
    if any(keyword in text for keyword in ("상세", "detail", "details")):
        return "detail_review"
    return "guided_navigation"


def _infer_safe_click_intents(text: str, task_type: str) -> list[str]:
    intents: list[str] = []
    if task_type == "chat_prompt":
        intents.extend(["전송", "Send", "Enter"])
    if "조회" in text or "검색" in text or task_type == "lookup":
        intents.extend(["조회", "검색", "Search"])
    if "상세" in text or task_type == "detail_review":
        intents.extend(["상세", "상세 보기", "Detail", "Details"])
    if not intents:
        intents.extend(["다음", "확인", "Next"])
    return list(dict.fromkeys(intents))


def _inferred_success_criterion(task_type: str) -> str:
    if task_type == "chat_prompt":
        return "입력한 질문에 대한 답변 영역이나 응답 텍스트가 화면에 보이면 완료"
    if task_type == "lookup":
        return "조회 결과, 목록, 상세 버튼, 또는 결과 건수가 화면에 보이면 완료"
    if task_type == "detail_review":
        return "상세 화면의 제목, 주요 필드, 또는 상세 내용이 화면에 보이면 완료"
    return "요청한 업무 화면의 핵심 정보가 보이면 완료"


def _autonomy_guidance(task_type: str) -> str:
    if task_type == "chat_prompt":
        return "질문 입력칸을 찾아 프롬프트를 입력하고 전송 또는 Enter로 제출한 뒤 답변이 나타날 때까지 기다린다."
    if task_type == "lookup":
        return "업무 입력값을 가장 관련 있는 검색/조회 필드에 입력하고 조회 또는 검색 버튼을 누른 뒤 결과 화면을 확인한다."
    if task_type == "detail_review":
        return "목록 또는 결과 화면에서 상세 보기 성격의 안전한 링크나 버튼을 선택하고 상세 내용이 나타나는지 확인한다."
    return "화면의 제목, 입력 필드, 버튼 텍스트를 기준으로 다음 안전한 읽기 중심 행동을 선택한다."


def _redact_sensitive_free_text(value: str) -> str:
    redacted = re.sub(
        r"(?i)\b(password|passwd|pwd|token|secret|api[_-]?key|authorization|otp|pin)\s+([^\s,;]+)",
        lambda match: f"{match.group(1)} <redacted>",
        value,
    )
    redacted = re.sub(
        r"(?i)\b(password|passwd|pwd|token|secret|api[_-]?key|authorization|otp|pin)\s*[:=]\s*([^\s,;]+)",
        lambda match: f"{match.group(1)}=<redacted>",
        redacted,
    )
    return redacted


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
