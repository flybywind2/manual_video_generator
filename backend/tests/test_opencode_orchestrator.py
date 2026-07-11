from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace

import pytest

from backend.app.execution_trace import (
    ExecutionTrace,
    ExecutionTracePolicy,
    TraceValidationError,
    validate_execution_trace,
)


def _request(**overrides: object) -> SimpleNamespace:
    values = {
        "target_url": "https://qsike.com/",
        "input_values": {"search_query": "Playwright"},
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _valid_trace() -> dict[str, object]:
    return {
        "schema_version": "1.0",
        "status": "completed",
        "request_summary": "QSike Tech Notes의 주요 영역과 글 탐색 방법을 설명한다.",
        "input_values": ["search_query"],
        "steps": [
            {
                "id": "step-intro",
                "title": "홈 화면 소개",
                "narration": "QSike Tech Notes 홈 화면에서 주요 기술 주제를 확인합니다.",
                "actions": [
                    {
                        "id": "action-nav",
                        "type": "navigate",
                        "target_url": "https://qsike.com/",
                        "observed_url": "https://qsike.com/",
                    },
                    {
                        "id": "action-capture",
                        "type": "capture",
                        "observed_url": "https://qsike.com/",
                        "evidence": {
                            "screenshot_path": "discovery/step-intro.png",
                            "visible_text": ["QSike Tech Notes"],
                        },
                    },
                ],
            },
            {
                "id": "step-open-note",
                "title": "최근 글 열기",
                "narration": "최근 글 목록에서 하나를 열어 상세 내용을 확인합니다.",
                "actions": [
                    {
                        "id": "action-click-note",
                        "type": "click",
                        "ref": "e42",
                        "label": "최근 글",
                        "observed_url": "https://qsike.com/",
                        "expected_after": "글 상세 화면이 표시된다.",
                    }
                ],
            },
        ],
        "completion_evidence": {
            "final_url": "https://qsike.com/notes/playwright",
            "assertions": ["글 제목과 본문이 표시된다."],
            "screenshot_path": "discovery/completed.png",
        },
    }


def _validate(raw: dict[str, object], *, request: SimpleNamespace | None = None) -> ExecutionTrace:
    return validate_execution_trace(raw, request or _request(), ExecutionTracePolicy())


def test_valid_execution_trace_is_parsed_and_returned() -> None:
    trace = _validate(_valid_trace())

    assert isinstance(trace, ExecutionTrace)
    assert trace.schema_version == "1.0"
    assert [step.id for step in trace.steps] == ["step-intro", "step-open-note"]
    assert trace.completion_evidence.assertions == ["글 제목과 본문이 표시된다."]


@pytest.mark.parametrize(
    ("mutate", "expected_code"),
    [
        (lambda trace: trace.update(schema_version="2.0"), "unsupported_schema_version"),
        (lambda trace: trace.update(steps=[]), "empty_steps"),
        (
            lambda trace: trace["steps"][0]["actions"][0].update(type="evaluate"),
            "unknown_action",
        ),
        (
            lambda trace: trace["steps"][1]["actions"][0].pop("ref"),
            "missing_target",
        ),
        (
            lambda trace: trace["steps"][0]["actions"][0].pop("observed_url"),
            "missing_observed_provenance",
        ),
        (
            lambda trace: trace["steps"][0]["actions"][0].update(
                target_url="https://example.com/escape"
            ),
            "off_origin_url",
        ),
        (
            lambda trace: trace["steps"][1]["actions"][0].update(
                ref="", selector="button", label="글 열기"
            ),
            "ambiguous_target",
        ),
        (
            lambda trace: trace["steps"][1]["actions"][0].update(label="삭제 후 확정"),
            "dangerous_action",
        ),
        (
            lambda trace: trace.pop("completion_evidence"),
            "missing_completion_evidence",
        ),
    ],
)
def test_invalid_execution_trace_is_rejected(mutate, expected_code: str) -> None:
    raw = deepcopy(_valid_trace())
    mutate(raw)

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw)

    assert exc_info.value.code == expected_code


def test_fill_action_requires_value_key_instead_of_a_literal_value() -> None:
    raw = deepcopy(_valid_trace())
    raw["steps"][1]["actions"][0] = {
        "id": "action-fill",
        "type": "fill",
        "ref": "e-input",
        "observed_url": "https://qsike.com/",
        "value": "Playwright",
    }

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw)

    assert exc_info.value.code == "literal_input_value"


def test_trace_rejects_raw_request_secrets_anywhere_in_serialized_output() -> None:
    raw = deepcopy(_valid_trace())
    raw["steps"][0]["narration"] = "비밀번호 plain-password를 입력합니다."
    request = _request(input_values={"password": "plain-password"})

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw, request=request)

    assert exc_info.value.code == "secret_value_exposed"


def test_trace_rejects_raw_secret_containing_json_escape_characters() -> None:
    raw = deepcopy(_valid_trace())
    raw["request_summary"] = '로그인 암호 pa"ss\\word가 노출됐다.'
    request = _request(input_values={"password": 'pa"ss\\word'})

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw, request=request)

    assert exc_info.value.code == "secret_value_exposed"


def test_trace_rejects_sensitive_value_key_references() -> None:
    raw = deepcopy(_valid_trace())
    raw["input_values"] = ["password"]
    raw["steps"][1]["actions"][0] = {
        "id": "action-fill-password",
        "type": "fill",
        "ref": "e-password",
        "observed_url": "https://qsike.com/",
        "value_key": "password",
    }

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw, request=_request(input_values={"password": "plain-password"}))

    assert exc_info.value.code == "sensitive_input_reference"


def test_trace_rejects_sensitive_reference_even_when_request_omits_that_key() -> None:
    raw = deepcopy(_valid_trace())
    raw["input_values"] = ["password"]

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw)

    assert exc_info.value.code == "sensitive_input_reference"


def test_fill_action_value_key_must_exist_in_the_request() -> None:
    raw = deepcopy(_valid_trace())
    raw["steps"][1]["actions"][0] = {
        "id": "action-fill",
        "type": "fill",
        "selector": "#search-query",
        "observed_url": "https://qsike.com/",
        "value_key": "unknown_value",
    }

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw)

    assert exc_info.value.code == "unknown_value_key"


def test_trace_rejects_dangerous_write_synonym() -> None:
    raw = deepcopy(_valid_trace())
    raw["steps"][1]["actions"][0]["label"] = "Remove account"

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw)

    assert exc_info.value.code == "dangerous_action"


def test_completion_word_in_expected_state_is_not_misclassified_as_a_write() -> None:
    raw = deepcopy(_valid_trace())
    raw["steps"][1]["actions"][0]["expected_after"] = "Confirmation page opens"

    trace = _validate(raw)

    assert trace.steps[1].actions[0].expected_after == "Confirmation page opens"


@pytest.mark.parametrize("selector", ["[role=button]", ".btn", "//button"])
def test_trace_rejects_broad_selector_variants(selector: str) -> None:
    raw = deepcopy(_valid_trace())
    action = raw["steps"][1]["actions"][0]
    action["ref"] = ""
    action["selector"] = selector

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw)

    assert exc_info.value.code == "ambiguous_target"


def test_ref_only_click_requires_observed_label_for_risk_classification() -> None:
    raw = deepcopy(_valid_trace())
    raw["steps"][1]["actions"][0]["label"] = ""

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw)

    assert exc_info.value.code == "missing_action_label"


def test_malformed_trace_url_is_reported_as_a_trace_validation_error() -> None:
    raw = deepcopy(_valid_trace())
    raw["steps"][0]["actions"][0]["target_url"] = "https://qsike.com:bad/"

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw)

    assert exc_info.value.code == "invalid_url"
