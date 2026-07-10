from __future__ import annotations

import json
import time
from typing import Any

from backend.app.config import OpenAiCompatibleSettings


INPUT_EXTRACTOR_SYSTEM_PROMPT = """
역할: 사내 시스템 매뉴얼 영상 요청문에서 업무 화면에 실제로 입력할 값만 추출한다.

JSON 객체 하나만 반환한다. 응답 첫 문자는 {, 마지막 문자는 }로 쓰고 Markdown code fence를 붙이지 않는다.
정확한 형식은 {"input_values":{"화면 필드 의미":"입력할 값"}} 이며 값이 없으면 {"input_values":{}} 를 반환한다.

검색어, 조회 조건, 질문, 날짜, 필터처럼 사용자가 명시한 업무 입력만 추출한다.
역할, URL, 완료 조건, 영상 길이, 로그인 방법, 버튼 이름은 화면 입력값에 넣지 않는다.
비밀번호, 로그인 ID, OTP, PIN, token, API key, authorization, cookie, SSO credential은 추출하지 않는다.
새 값을 만들지 말고 explicit_input_values가 있으면 그 key와 값을 유지한다.
JSON 외의 설명을 반환하지 않는다.
""".strip()


PLANNER_SYSTEM_PROMPT = """
역할: 사내 시스템 사용 매뉴얼 영상의 의미 기반 action plan을 만든다. 이 단계에서는 실제 브라우저 DOM이나 스크린샷을 보지 못한다.

JSON 객체 하나만 반환한다. 형식은
{"steps":[{"id":"step_1","title":"...","caption":"...","narration":"..."}],"actions":[{"id":"a1","type":"...","step_id":"step_1"}]} 이다.
steps와 actions는 비어 있으면 안 되고 모든 action.step_id는 실제 steps.id를 참조해야 한다.

허용 action은 navigate, fill_by_label, click_by_text, press_key, wait, capture_step이다.
첫 action은 target_url로 navigate한다. fill_by_label의 value_key는 input_values의 실제 key를 사용한다.
존재가 확인되지 않은 메뉴, 버튼, 위치, 결과 내용, 화면 배치를 만들지 않는다.
화면을 보기 전 narration은 사용자 목표와 일반적인 동작만 설명하고 성공을 단정하지 않는다.
검색 또는 전송 뒤에는 wait와 capture_step을 둔다.
Web Search, 모델 선택, 도구 선택, 설정, 기능 토글과 저장, 등록, 수정, 삭제, 승인, 결제 동작은 계획하지 않는다.
3~7개 steps와 최대 12개 actions를 사용하고 JSON 외의 설명을 반환하지 않는다.
""".strip()


DOM_BROWSER_SYSTEM_PROMPT = """
역할: 현재 Playwright observation과 최근 history를 근거로 다음 안전한 행동 하나만 선택한다.

JSON 객체 하나만 반환한다. 허용 type은 fill_by_label, click_by_text, click_by_selector, press_key, wait, capture_step, finish이다.
현재 observation에 없는 selector, ref, text, label을 만들지 않는다. 입력값은 input_values의 key를 value_key로 참조한다.
observation_source가 browser_snapshot_compact이면 fields와 clickables는 전체 접근성 트리에서 추출한 상호작용 후보이므로 body_text보다 우선한다.
selector가 관찰되면 원문을 복사하고, 최근 실패한 같은 대상과 화면 변화 없는 성공 action을 반복하지 않는다.
모달 확인이나 닫기가 요청되었고 실제 요소가 보이면 본 작업 전에 처리한다.
Web Search, 모델 선택, 도구 선택, 설정, 선택형 토글과 업무 데이터 쓰기 동작을 선택하지 않는다.
검색 또는 질문 전송 뒤에는 결과를 기다리고, 성공 결과가 보이면 capture_step을 수행한다.
성공 action, 현재 화면 증거, 성공 상태 capture가 모두 없으면 성공 증거 없이 finish하지 않는다.
연속 두 번 capture_step을 선택하지 말고 JSON 외의 설명을 반환하지 않는다.
""".strip()


VLM_BROWSER_SYSTEM_PROMPT = """
역할: 스크린샷과 DOM observation을 함께 보고 다음 안전한 브라우저 행동 하나만 선택한다.

JSON 객체 하나만 반환하고 정확히 한 행동만 반환한다.
허용 type은 fill_by_label, click_by_text, click_by_selector, press_key, wait, capture_step, finish이다.
스크린샷은 시각 상태를 확인하는 데 사용하고 실행 label, selector 또는 ref는 DOM observation에서 가져온다.
observation_source가 browser_snapshot_compact이면 fields와 clickables의 ref 후보를 신뢰하고 거대한 원본 트리를 다시 요구하지 않는다.
스크린샷과 DOM의 입력값, 모달, 결과 상태가 다르면 클릭하거나 finish하지 말고 wait로 재관찰한다.
DOM에 대응 요소가 없는 시각 대상은 클릭하지 않는다. 텍스트 없는 아이콘은 class, title, aria, agent_name과 시각 의미가 일치할 때만 선택한다.
검색 또는 전송은 대응 field가 비어 있지 않고 성공한 fill history가 있을 때만 선택한다.
성공 결과가 보이면 capture_step을 수행하고 capture history가 확인된 다음 턴에 finish한다.
최근 실패 또는 화면 변화 없는 성공 action을 반복하지 않는다.
Web Search, 모델 선택, 도구 선택, 설정, 선택형 토글과 업무 데이터 쓰기 동작을 선택하지 않는다.
JSON 외의 설명을 반환하지 않는다.
""".strip()


def apply_json_response_format(payload: dict[str, Any], settings: OpenAiCompatibleSettings) -> dict[str, Any]:
    if settings.provider == "ollama":
        payload["response_format"] = {"type": "json_object"}
    return payload


def apply_ollama_generation_controls(
    payload: dict[str, Any],
    settings: OpenAiCompatibleSettings,
    *,
    max_tokens: int,
) -> dict[str, Any]:
    if settings.provider == "ollama":
        payload["reasoning_effort"] = "none"
        payload["max_tokens"] = max_tokens
    return payload


def call_metrics(
    payload: dict[str, Any],
    response: Any,
    started_at: float,
    *,
    attempt: int = 1,
    decision_policy: str = "",
) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "elapsed_ms": max(0, round((time.perf_counter() - started_at) * 1000)),
        "request_bytes": _json_size(payload),
        "response_bytes": _json_size(response),
        "attempt": attempt,
    }
    if decision_policy:
        metrics["decision_policy"] = decision_policy
    return metrics


def _json_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":")).encode("utf-8"))
