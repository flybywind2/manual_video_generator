from __future__ import annotations

from copy import deepcopy
from contextlib import contextmanager
import json
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace

import pytest

from backend.app.execution_trace import (
    ExecutionTrace,
    ExecutionTracePolicy,
    TraceValidationError,
    validate_execution_trace,
)
from backend.app.config import load_settings
from backend.app.adapters.opencode_browser import (
    OpenCodeBrowserDiscovery,
    OpenCodeBrowserDiscoveryError,
    _compact_observation_evidence,
    _normalize_observer_trace,
    _observed_unique_refs_by_label,
)
from backend.app.browser_session import BrowserSessionError, BrowserSessionManager
from backend.app.discovery_evidence import DiscoveryEvidenceError
from backend.app.env_bootstrap import discover_browser_executable
from backend.app.opencode_orchestrator import (
    OpenCodeVideoOrchestrator,
    OrchestratorServices,
    _frame_durations_for_media_plan,
)
from backend.app.adapters.tts import SupertonicTtsError
from backend.app.pipeline import PipelineInput
from tools.verify_package import verify_manifest


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


def test_execution_trace_may_start_with_observed_ui_action_because_replay_owns_reset() -> None:
    raw = _valid_trace()
    raw["steps"][0]["actions"].pop(0)

    trace = _validate(raw)

    assert trace.steps[0].actions[0].type == "capture"


def test_execution_trace_rejects_input_keys_not_supplied_by_request() -> None:
    raw = _valid_trace()
    raw["input_values"] = ["invented_key"]

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw)

    assert exc_info.value.code == "unknown_value_key"


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


def _browser_request(**overrides: object) -> SimpleNamespace:
    values = {
        "request_text": "QSike 서비스를 소개하고 최근 글을 여는 방법을 보여줘",
        "target_url": "https://qsike.com/",
        "role": "방문자",
        "completion_condition": "최근 글 상세 화면 확인",
        "input_values": {"search_query": "Playwright", "password": "plain-password"},
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _opencode_settings(**overrides: str):
    environ = {
        "MANUAL_AGENT_ENABLE_OPENCODE": "true",
        "MANUAL_AGENT_OPENCODE_COMMAND": "opencode run --format json",
        "MANUAL_AGENT_OPENCODE_AGENT": "browser",
        "MANUAL_AGENT_OPENCODE_MODEL": "ignored/model",
        "MANUAL_AGENT_PLAYWRIGHT_MCP_COMMAND": "npx @playwright/mcp@1.2.3 --headless",
        "MANUAL_AGENT_OPENCODE_TIMEOUT_SECONDS": "45",
    }
    environ.update(overrides)
    return load_settings(environ=environ)


def _opencode_stdout(trace: dict[str, object] | None = None) -> str:
    events = [{"type": "step_start", "name": "browser discovery"}]
    if trace is not None:
        events.append({"type": "text", "part": {"text": json.dumps(trace, ensure_ascii=False)}})
    return "\n".join(json.dumps(event, ensure_ascii=False) for event in events)


def test_compact_observation_evidence_keeps_home_and_latest_page_events() -> None:
    events = [
        {
            "type": "tool_use",
            "part": {
                "tool": "playwright_browser_find",
                "state": {
                    "status": "completed",
                    "input": {"text": f"item-{index:02d}"},
                    "output": f"### Result\nFound item-{index:02d}",
                },
            },
        }
        for index in range(30)
    ]

    compact = _compact_observation_evidence(events)

    assert [record["input"]["text"] for record in compact] == [
        *(f"item-{index:02d}" for index in range(8)),
        *(f"item-{index:02d}" for index in range(14, 30)),
    ]


def test_observed_ref_recovery_uses_latest_ref_across_snapshot_generations() -> None:
    def snapshot(ref: str) -> dict[str, object]:
        return {
            "type": "tool_use",
            "part": {
                "tool": "playwright_browser_snapshot",
                "state": {
                    "status": "completed",
                    "output": f'- button "확인" [ref={ref}] [cursor=pointer]',
                },
            },
        }

    assert _observed_unique_refs_by_label([snapshot("e33"), snapshot("f2e33")]) == {
        "확인": "f2e33"
    }


def test_observed_ref_recovery_does_not_guess_duplicate_labels_in_one_snapshot() -> None:
    events = [
        {
            "type": "tool_use",
            "part": {
                "tool": "playwright_browser_snapshot",
                "state": {
                    "status": "completed",
                    "output": (
                        '- button "확인" [ref=e33] [cursor=pointer]\n'
                        '- button "확인" [ref=e44] [cursor=pointer]'
                    ),
                },
            },
        }
    ]

    assert "확인" not in _observed_unique_refs_by_label(events)


def test_normalize_observer_trace_turns_observed_link_navigation_into_click() -> None:
    candidate = {
        "schema_version": "1.0",
        "status": "completed",
        "request_summary": "AI 인프라 영역을 연다.",
        "input_values": [],
        "steps": [
            {
                "id": "step-home",
                "title": "홈",
                "narration": "홈 화면을 연다.",
                "actions": [
                    {
                        "id": "action-home",
                        "type": "navigate",
                        "target_url": "https://qsike.com/",
                        "observed_url": None,
                    },
                    {
                        "id": "action-overview",
                        "type": "navigate",
                        "label": "서비스 소개",
                        "observed_url": "https://qsike.com/",
                    }
                ],
            },
            {
                "id": "step-category",
                "title": "AI 인프라",
                "narration": "AI 인프라 링크를 선택한다.",
                "actions": [
                    {
                        "id": "action-category",
                        "type": "navigate",
                        "target_url": "https://qsike.com/categories/#ai-infra",
                        "observed_url": "https://qsike.com/",
                        "evidence": {
                            "screenshot_path": "category.png",
                            "visible_text": ["AI 인프라"],
                        },
                    }
                ],
            },
        ],
        "completion_evidence": {
            "final_url": "https://qsike.com/categories/#ai-infra",
            "assertions": ["AI 인프라 목록이 보인다."],
            "screenshot_path": "invented.png",
        },
    }

    normalized, removed = _normalize_observer_trace(
        candidate,
        original_target_url="https://qsike.com/",
        completion_condition="AI 인프라 목록이 보이면 완료",
        checkpoint={
            "url": "https://qsike.com/categories/#ai-infra",
            "screenshot_path": "discovery_final.png",
        },
    )

    home = normalized["steps"][0]["actions"][0]
    overview = normalized["steps"][0]["actions"][1]
    category = normalized["steps"][1]["actions"][0]
    assert home["observed_url"] == "https://qsike.com/"
    assert overview == {
        "id": "action-overview",
        "type": "capture",
        "label": "서비스 소개",
        "observed_url": "https://qsike.com/",
    }
    assert category == {
        "id": "action-category",
        "type": "click",
        "selector": "a[href='/categories/#ai-infra']",
        "label": "AI 인프라",
        "observed_url": "https://qsike.com/",
    }
    assert normalized["steps"][-1] == {
        "id": "step-completion",
        "title": "완료 화면 확인",
        "narration": "마지막으로 AI 인프라 목록이 보이는지 확인합니다.",
        "actions": [
            {
                "id": "action-completion-capture",
                "type": "capture",
                "observed_url": "https://qsike.com/categories/#ai-infra",
                "expected_after": "AI 인프라 목록이 보이면 완료",
            }
        ],
    }
    assert normalized["completion_evidence"]["screenshot_path"] == "discovery_final.png"
    assert removed == 1


def test_normalize_observer_trace_adds_intro_and_completion_around_click_only_trace() -> None:
    candidate = {
        "schema_version": "1.0",
        "status": "completed",
        "request_summary": "기술 노트 사용 방법을 설명한다.",
        "input_values": [],
        "steps": [
            {
                "id": "step-category",
                "title": "주제 선택",
                "narration": "AI 인프라 주제를 선택합니다.",
                "actions": [
                    {
                        "id": "action-category",
                        "type": "click",
                        "selector": "a[href='/categories/#ai-infra']",
                        "label": "AI 인프라",
                        "observed_url": "https://qsike.com/",
                    }
                ],
            },
            {
                "id": "step-note",
                "title": "글 선택",
                "narration": "대표 글을 선택합니다.",
                "actions": [
                    {
                        "id": "action-note",
                        "type": "click",
                        "selector": "a:has-text('대표 글')",
                        "label": "대표 글",
                        "observed_url": "https://qsike.com/categories/#ai-infra",
                    }
                ],
            },
        ],
        "completion_evidence": {
            "final_url": "https://qsike.com/posts/example/",
            "assertions": ["글 제목과 본문이 보인다."],
            "screenshot_path": "invented.png",
        },
    }

    normalized, _removed = _normalize_observer_trace(
        candidate,
        original_target_url="https://qsike.com/",
        completion_condition="글 제목, 발행일, 태그와 본문이 보이면 완료",
        checkpoint={
            "url": "https://qsike.com/posts/example/",
            "screenshot_path": "discovery_final.png",
        },
    )

    assert normalized["steps"][0] == {
        "id": "step-open-target",
        "title": "서비스 첫 화면 열기",
        "narration": "먼저 대상 서비스의 첫 화면을 열어 주요 구성과 시작 위치를 확인합니다.",
        "actions": [
            {
                "id": "action-open-target",
                "type": "navigate",
                "target_url": "https://qsike.com/",
                "observed_url": "https://qsike.com/",
                "expected_after": "대상 서비스 첫 화면이 표시됩니다.",
            }
        ],
    }
    assert normalized["steps"][-1]["actions"] == [
        {
            "id": "action-completion-capture",
            "type": "capture",
            "observed_url": "https://qsike.com/posts/example/",
            "expected_after": "글 제목, 발행일, 태그와 본문이 보이면 완료",
        }
    ]
    assert normalized["steps"][-1]["narration"] == (
        "마지막으로 글 제목, 발행일, 태그와 본문이 보이는지 확인합니다."
    )


def test_normalize_observer_trace_does_not_duplicate_existing_boundary_steps() -> None:
    candidate = _valid_trace()
    candidate["steps"][-1]["actions"] = [
        {
            "id": "action-final-capture",
            "type": "capture",
            "observed_url": "https://qsike.com/notes/playwright/",
        }
    ]

    normalized, _removed = _normalize_observer_trace(
        candidate,
        original_target_url="https://qsike.com/",
        completion_condition="최근 글 상세 화면 확인",
        checkpoint={
            "url": "https://qsike.com/notes/playwright",
            "screenshot_path": "discovery_final.png",
        },
    )

    assert len(normalized["steps"]) == len(candidate["steps"])
    assert normalized["steps"][0]["actions"][0]["type"] == "navigate"
    assert normalized["steps"][-1]["actions"][-1]["id"] == "action-final-capture"


def test_normalize_observer_trace_recovers_missing_fill_value_key_from_request_contract() -> None:
    candidate = _valid_trace()
    candidate["input_values"] = ["LOT 번호"]
    candidate["steps"][1]["actions"] = [
        {
            "id": "action-fill-lot",
            "type": "fill",
            "selector": "#e13",
            "ref": "e13",
            "label": "LOT 번호 조회",
            "observed_url": "https://qsike.com/",
        }
    ]

    normalized, _removed = _normalize_observer_trace(
        candidate,
        original_target_url="https://qsike.com/",
        allowed_input_keys=["LOT 번호"],
        checkpoint={
            "url": "https://qsike.com/notes/playwright",
            "screenshot_path": "discovery_final.png",
        },
    )

    fill = normalized["steps"][1]["actions"][0]
    assert fill["value_key"] == "LOT 번호"


def test_normalize_observer_trace_rebuilds_input_keys_from_request_contract() -> None:
    candidate = _valid_trace()
    candidate["input_values"] = ["lot_number_search"]
    candidate["steps"][1]["actions"] = [
        {
            "id": "action-fill-lot",
            "type": "fill",
            "selector": "input[data-action='lot-search']",
            "ref": "e13",
            "label": "LOT 번호 조회",
            "observed_url": "https://qsike.com/",
        }
    ]

    normalized, _removed = _normalize_observer_trace(
        candidate,
        original_target_url="https://qsike.com/",
        allowed_input_keys=["LOT 번호"],
        checkpoint={
            "url": "https://qsike.com/notes/playwright",
            "screenshot_path": "discovery_final.png",
        },
    )

    assert normalized["input_values"] == ["LOT 번호"]
    assert normalized["steps"][1]["actions"][0]["value_key"] == "LOT 번호"


def test_normalize_observer_trace_repairs_untrusted_fill_key_when_unambiguous() -> None:
    candidate = _valid_trace()
    candidate["input_values"] = ["lot_number_search"]
    candidate["steps"][1]["actions"] = [
        {
            "id": "action-fill-lot",
            "type": "fill",
            "selector": "input[data-action='lot-search']",
            "label": "LOT 번호 조회",
            "value_key": "lot_number_search",
            "observed_url": "https://qsike.com/",
        }
    ]

    normalized, _removed = _normalize_observer_trace(
        candidate,
        original_target_url="https://qsike.com/",
        allowed_input_keys=["LOT 번호"],
        checkpoint={
            "url": "https://qsike.com/notes/playwright",
            "screenshot_path": "discovery_final.png",
        },
    )

    assert normalized["input_values"] == ["LOT 번호"]
    assert normalized["steps"][1]["actions"][0]["value_key"] == "LOT 번호"


def test_normalize_observer_trace_does_not_guess_ambiguous_fill_value_key() -> None:
    candidate = _valid_trace()
    candidate["steps"][1]["actions"] = [
        {
            "id": "action-fill",
            "type": "fill",
            "selector": "input",
            "label": "검색 조건",
            "observed_url": "https://qsike.com/",
        }
    ]

    normalized, _removed = _normalize_observer_trace(
        candidate,
        original_target_url="https://qsike.com/",
        allowed_input_keys=["LOT 번호", "라인"],
        checkpoint={
            "url": "https://qsike.com/notes/playwright",
            "screenshot_path": "discovery_final.png",
        },
    )

    assert "value_key" not in normalized["steps"][1]["actions"][0]


def test_opencode_browser_discovery_writes_isolated_mcp_config_and_extracts_trace(
    tmp_path: Path,
) -> None:
    settings = _opencode_settings()
    request = _browser_request()
    observer_trace = _valid_trace()
    expected_trace = deepcopy(observer_trace)
    expected_trace["completion_evidence"]["screenshot_path"] = "discovery_final.png"
    expected_trace["steps"][0]["actions"][1].pop("evidence")
    expected_trace["steps"].append(
        {
            "id": "step-completion",
            "title": "완료 화면 확인",
            "narration": "마지막으로 요청한 상세 화면에서 결과가 올바르게 표시되는지 확인합니다.",
            "actions": [
                {
                    "id": "action-completion-capture",
                    "type": "capture",
                    "observed_url": "https://qsike.com/notes/playwright",
                    "expected_after": "최근 글 상세 화면 확인",
                }
            ],
        }
    )
    endpoint = "http://127.0.0.1:43129"
    calls: list[list[str]] = []

    def fake_runner(args, **kwargs):
        calls.append(list(args))
        assert kwargs["cwd"] == str(tmp_path)
        assert kwargs["timeout"] == 45.0
        assert args[1:4] == ["run", "--format", "json"]
        assert "--agent" in args
        assert args[args.index("--agent") + 1] == "manual-video-browser"
        assert "--model" not in args
        assert "ignored/model" not in args

        config = json.loads((tmp_path / "opencode.json").read_text(encoding="utf-8"))
        assert list(config["mcp"]) == ["playwright"]
        assert config["default_agent"] == "manual-video-browser"
        finalizer = config["agent"]["manual-video-finalizer"]
        assert finalizer["mode"] == "primary"
        assert finalizer["steps"] == 2
        assert finalizer["tools"] == {"*": False}
        assert finalizer["permission"] == {"*": "deny"}
        assert "model" not in finalizer
        agent = config["agent"]["manual-video-browser"]
        assert agent["mode"] == "primary"
        assert agent["steps"] == 32
        assert agent["temperature"] == 0
        assert "model" not in agent
        assert agent["tools"]["read"] is True
        assert agent["tools"]["grep"] is True
        assert agent["permission"]["read"] == {
            "*": "deny",
            ".playwright-mcp/*": "allow",
        }
        assert agent["permission"]["grep"] == "allow"
        assert "Never retry the same failed browser action" in agent["prompt"]
        assert "Do not click cookie-consent or preference controls during discovery" in agent["prompt"]
        assert "Only Playwright MCP evidence can justify completed" in agent["prompt"]
        assert "Search the saved snapshot with grep" in agent["prompt"]
        assert '`{"target":"e42","element":"observed link label"}`' in agent["prompt"]
        assert "target must be only the bare ref" in agent["prompt"]
        assert '`{"type":"png","scale":"css","filename":"discovery_final.png","fullPage":false}`' in agent["prompt"]
        assert "A .yml snapshot is not screenshot evidence" in agent["prompt"]
        assert "Search exact labels explicitly named in the request" in agent["prompt"]
        mcp_command = config["mcp"]["playwright"]["command"]
        assert Path(mcp_command[0]).name.lower() in {"npx", "npx.cmd"}
        assert mcp_command[1] == "@playwright/mcp@1.2.3"
        assert mcp_command[-2:] == ["--cdp-endpoint", endpoint]
        assert "--headless" not in mcp_command
        assert "--caps=vision" in mcp_command
        assert "--timeout-action=15000" in mcp_command
        assert "--viewport-size=1280x800" in mcp_command
        assert "--output-mode=file" in mcp_command
        assert config["tools"] == {
            "*": False,
            "playwright_*": True,
            "playwright_browser_run_code_unsafe": False,
        }
        assert config["permission"]["*"] == "deny"
        assert config["permission"]["playwright_*"] == "allow"
        assert config["permission"]["playwright_browser_run_code_unsafe"] == "deny"

        prompt = (tmp_path / "opencode_browser_prompt.md").read_text(encoding="utf-8")
        assert "QSike 서비스를 소개" in prompt
        assert "https://qsike.com/" in prompt
        assert "search_query" in prompt
        assert "Playwright" in prompt
        assert "plain-password" not in prompt
        assert '"steps": [' in prompt
        assert '"actions": [' in prompt
        assert '"observed_url":' in prompt
        assert '"completion_evidence": {' in prompt
        assert '"final_url":' in prompt
        assert '"assertions": [' in prompt
        assert '"screenshot_path":' in prompt
        assert "input_values must be a JSON array" in prompt
        assert "Do not use action_type, description, current_url, page_title, or observed_elements" in prompt
        assert "Do not replace a requested visible click with direct navigation" in prompt
        assert "Replay initialization is owned by the backend" in prompt
        assert "Omit fields that do not apply; never emit null" in prompt
        assert "Every observed_url and final_url must be an absolute URL" in prompt
        assert "A tool result containing ### Error or TimeoutError is a failed action" in prompt
        assert "Do not activate cookie-consent or preference controls during discovery" in prompt
        return subprocess.CompletedProcess(
            args=args,
            returncode=0,
            stdout=_opencode_stdout(observer_trace),
            stderr="diagnostic stderr",
        )

    def checkpoint_collector(*, cdp_endpoint: str, job_dir: Path):
        assert cdp_endpoint == endpoint
        (job_dir / "discovery_final.png").write_bytes(b"png")
        return {
            "url": "https://qsike.com/notes/playwright",
            "title": "Playwright note",
            "screenshot_path": "discovery_final.png",
            "visible_text": ["글 제목과 본문이 표시된다."],
        }

    result = OpenCodeBrowserDiscovery(
        settings,
        command_runner=fake_runner,
        checkpoint_collector=checkpoint_collector,
    ).run(
        request=request,
        job_dir=tmp_path,
        cdp_endpoint=endpoint,
    )

    assert result.status == "completed"
    assert len(calls) == 1
    assert result.trace == expected_trace
    assert result.config_path == tmp_path / "opencode.json"
    combined = result.event_log_path.read_text(encoding="utf-8")
    assert "backend_playwright_capture" in combined
    assert json.loads(result.trace_path.read_text(encoding="utf-8")) == expected_trace
    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert metadata["returncode"] == 0
    assert metadata["stderr"] == "diagnostic stderr"
    assert metadata["model_source"] == "opencode-default"
    assert metadata["observer_trace_present"] is True
    assert metadata["trace_source"] == "observer-normalized"
    assert metadata["removed_action_evidence_count"] == 1
    assert result.support_summary_path.read_text(encoding="utf-8").startswith("OPENCODE_BROWSER_OK")


def test_opencode_browser_discovery_fails_when_disabled_and_still_writes_support_files(
    tmp_path: Path,
) -> None:
    settings = _opencode_settings(MANUAL_AGENT_ENABLE_OPENCODE="false")

    with pytest.raises(OpenCodeBrowserDiscoveryError) as exc_info:
        OpenCodeBrowserDiscovery(settings).run(
            request=_browser_request(),
            job_dir=tmp_path,
            cdp_endpoint="http://127.0.0.1:9222",
        )

    assert exc_info.value.code == "opencode_disabled"
    assert (tmp_path / "opencode_browser_metadata.json").exists()
    assert "opencode_disabled" in (tmp_path / "opencode_support_summary.txt").read_text(encoding="utf-8")


def test_opencode_browser_discovery_fails_fast_on_timeout(tmp_path: Path) -> None:
    def fake_runner(args, **kwargs):
        raise subprocess.TimeoutExpired(args, kwargs["timeout"], output="partial", stderr="slow")

    with pytest.raises(OpenCodeBrowserDiscoveryError) as exc_info:
        OpenCodeBrowserDiscovery(_opencode_settings(), command_runner=fake_runner).run(
            request=_browser_request(),
            job_dir=tmp_path,
            cdp_endpoint="http://127.0.0.1:9222",
        )

    assert exc_info.value.code == "opencode_timeout"
    metadata = json.loads((tmp_path / "opencode_browser_metadata.json").read_text(encoding="utf-8"))
    assert metadata["status"] == "failed"
    assert metadata["stderr"] == "slow"


def test_opencode_browser_discovery_fails_fast_on_nonzero_exit(tmp_path: Path) -> None:
    def fake_runner(args, **kwargs):
        return subprocess.CompletedProcess(args, 7, stdout="partial", stderr="command failed")

    with pytest.raises(OpenCodeBrowserDiscoveryError) as exc_info:
        OpenCodeBrowserDiscovery(_opencode_settings(), command_runner=fake_runner).run(
            request=_browser_request(),
            job_dir=tmp_path,
            cdp_endpoint="http://127.0.0.1:9222",
        )

    assert exc_info.value.code == "opencode_nonzero_exit"
    metadata = json.loads((tmp_path / "opencode_browser_metadata.json").read_text(encoding="utf-8"))
    assert metadata["returncode"] == 7
    assert metadata["stderr"] == "command failed"


def test_opencode_browser_discovery_rejects_malformed_jsonl(tmp_path: Path) -> None:
    def fake_runner(args, **kwargs):
        return subprocess.CompletedProcess(args, 0, stdout='{"type":"step"}\nnot-json', stderr="")

    with pytest.raises(OpenCodeBrowserDiscoveryError) as exc_info:
        OpenCodeBrowserDiscovery(_opencode_settings(), command_runner=fake_runner).run(
            request=_browser_request(),
            job_dir=tmp_path,
            cdp_endpoint="http://127.0.0.1:9222",
        )

    assert exc_info.value.code == "opencode_malformed_output"


def test_opencode_browser_discovery_rejects_success_without_final_trace(tmp_path: Path) -> None:
    def fake_runner(args, **kwargs):
        return subprocess.CompletedProcess(args, 0, stdout=_opencode_stdout(), stderr="")

    with pytest.raises(OpenCodeBrowserDiscoveryError) as exc_info:
        OpenCodeBrowserDiscovery(_opencode_settings(), command_runner=fake_runner).run(
            request=_browser_request(),
            job_dir=tmp_path,
            cdp_endpoint="http://127.0.0.1:9222",
        )

    assert exc_info.value.code == "opencode_trace_missing"


def test_opencode_browser_discovery_finalizes_fresh_session_with_compact_observation_evidence(
    tmp_path: Path,
) -> None:
    calls: list[list[str]] = []
    finalizer_trace = _valid_trace()
    finalizer_trace["input_values"] = [{"search_query": "Playwright"}]
    finalizer_trace["steps"][1]["actions"].insert(
        0,
        {
            "id": "action-fill-search",
            "type": "fill",
            "selector": "input[name='search']",
            "label": "검색어",
            "observed_url": "https://qsike.com/",
        },
    )
    finalizer_trace["steps"][1]["actions"][1].pop("ref")
    finalizer_trace["completion_evidence"]["screenshot_path"] = "discovery_final.png"
    expected_trace = deepcopy(finalizer_trace)
    expected_trace["input_values"] = ["search_query"]
    expected_trace["steps"][1]["actions"][0]["value_key"] = "search_query"
    expected_trace["steps"][1]["actions"][1]["ref"] = "e42"
    expected_trace["steps"][0]["actions"][1].pop("evidence")
    observe_stdout = "\n".join(
        [
            json.dumps(
                {
                    "type": "step_start",
                    "sessionID": "ses-observe-1",
                    "part": {"type": "step-start"},
                }
            ),
            json.dumps(
                {
                    "type": "tool_use",
                    "sessionID": "ses-observe-1",
                    "part": {
                        "tool": "playwright_browser_navigate",
                        "state": {
                            "status": "completed",
                            "input": {"url": "https://qsike.com/"},
                            "output": "### Page\n- Page URL: https://qsike.com/",
                        },
                    },
                }
            ),
            json.dumps(
                {
                    "type": "tool_use",
                    "sessionID": "ses-observe-1",
                    "part": {
                        "tool": "playwright_browser_snapshot",
                        "state": {
                            "status": "completed",
                            "input": {},
                            "output": (
                                "### Page\n- Page URL: https://qsike.com/\n"
                                "### Snapshot\n- button \"최근 글\" [ref=e42] [cursor=pointer]"
                            ),
                        },
                    },
                },
                ensure_ascii=False,
            ),
        ]
    )

    def checkpoint_collector(*, cdp_endpoint: str, job_dir: Path):
        assert cdp_endpoint == "http://127.0.0.1:43129"
        screenshot = job_dir / "discovery_final.png"
        screenshot.write_bytes(b"png")
        return {
            "url": "https://qsike.com/notes/playwright",
            "title": "Playwright note",
            "screenshot_path": "discovery_final.png",
            "visible_text": ["글 제목과 본문이 표시된다."],
        }

    def fake_runner(args, **kwargs):
        calls.append(list(args))
        if len(calls) == 1:
            return subprocess.CompletedProcess(args, 0, stdout=observe_stdout, stderr="")
        assert "--session" not in args
        assert args[args.index("--agent") + 1] == "manual-video-finalizer"
        assert "--model" not in args
        assert "discovery_final.png" in args[-1]
        assert "playwright_browser_navigate" in args[-1]
        assert "https://qsike.com/" in args[-1]
        assert "Every step must contain at least one action" in args[-1]
        assert "Every action must include an absolute observed_url" in args[-1]
        assert "Do not add an initial navigate action" in args[-1]
        assert "Omit action-level evidence" in args[-1]
        assert '"observer_trace_candidate": {}' in args[-1]
        return subprocess.CompletedProcess(args, 0, stdout=_opencode_stdout(finalizer_trace), stderr="")

    result = OpenCodeBrowserDiscovery(
        _opencode_settings(),
        command_runner=fake_runner,
        checkpoint_collector=checkpoint_collector,
    ).run(
        request=_browser_request(),
        job_dir=tmp_path,
        cdp_endpoint="http://127.0.0.1:43129",
    )

    assert len(calls) == 2
    assert result.trace == expected_trace
    assert result.observe_event_log_path.read_text(encoding="utf-8") == observe_stdout
    assert result.finalize_event_log_path.read_text(encoding="utf-8") == _opencode_stdout(finalizer_trace)
    combined = result.event_log_path.read_text(encoding="utf-8")
    assert "backend_playwright_capture" in combined
    assert "ses-observe-1" in combined
    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert metadata["observe_session_id"] == "ses-observe-1"
    assert metadata["finalize_session_reused"] is False


def test_opencode_browser_discovery_combines_split_final_text_events(tmp_path: Path) -> None:
    finalizer_trace = _valid_trace()
    finalizer_trace["completion_evidence"]["screenshot_path"] = "discovery_final.png"
    expected_trace = deepcopy(finalizer_trace)
    expected_trace["steps"][0]["actions"][1].pop("evidence")
    trace_text = json.dumps(finalizer_trace, ensure_ascii=False)
    midpoint = len(trace_text) // 2
    finalize_stdout = "\n".join(
        json.dumps({"type": "text", "part": {"text": chunk}}, ensure_ascii=False)
        for chunk in (trace_text[:midpoint], trace_text[midpoint:])
    )
    calls = 0
    observer_stdout = json.dumps(
        {"type": "step_start", "sessionID": "ses-split-finalizer", "part": {"type": "step-start"}}
    )

    def fake_runner(args, **kwargs):
        nonlocal calls
        calls += 1
        stdout = observer_stdout if calls == 1 else finalize_stdout
        return subprocess.CompletedProcess(args, 0, stdout=stdout, stderr="")

    def checkpoint_collector(*, cdp_endpoint: str, job_dir: Path):
        (job_dir / "discovery_final.png").write_bytes(b"png")
        return {
            "url": "https://qsike.com/notes/playwright",
            "title": "Playwright note",
            "screenshot_path": "discovery_final.png",
            "visible_text": ["글 제목과 본문이 표시된다."],
        }

    result = OpenCodeBrowserDiscovery(
        _opencode_settings(),
        command_runner=fake_runner,
        checkpoint_collector=checkpoint_collector,
    ).run(
        request=_browser_request(),
        job_dir=tmp_path,
        cdp_endpoint="http://127.0.0.1:9222",
    )

    assert calls == 2
    assert result.trace == expected_trace


@pytest.mark.parametrize(
    ("overrides", "expected_code"),
    [
        ({"MANUAL_AGENT_OPENCODE_COMMAND": ""}, "opencode_command_empty"),
        ({"MANUAL_AGENT_PLAYWRIGHT_MCP_COMMAND": ""}, "playwright_mcp_command_invalid"),
    ],
)
def test_opencode_browser_discovery_reports_invalid_required_commands(
    tmp_path: Path,
    overrides: dict[str, str],
    expected_code: str,
) -> None:
    with pytest.raises(OpenCodeBrowserDiscoveryError) as exc_info:
        OpenCodeBrowserDiscovery(_opencode_settings(**overrides)).run(
            request=_browser_request(),
            job_dir=tmp_path,
            cdp_endpoint="http://127.0.0.1:9222",
        )

    assert exc_info.value.code == expected_code
    assert expected_code in (tmp_path / "opencode_support_summary.txt").read_text(encoding="utf-8")


def _session_settings(tmp_path: Path, **overrides: object) -> SimpleNamespace:
    login_values = {
        "sso_profile_dir": str(tmp_path / "edge-profile"),
        "browser_channel": "msedge",
        "auth_server_allowlist": "*.corp.local",
        "auth_negotiate_delegate_allowlist": "*.corp.local",
        "username": "employee-id",
        "password": "plain-password",
    }
    login_overrides = overrides.pop("login", {})
    if isinstance(login_overrides, dict):
        login_values.update(login_overrides)
    values = {
        "browser_runner": "playwright",
        "cdp_endpoint": "",
        "playwright_executable_path": "",
        "request_timeout_seconds": 10.0,
        "login": SimpleNamespace(**login_values),
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class _FakeBrowserProcess:
    def __init__(self, *, pid: int = 4242, poll_result: int | None = None) -> None:
        self.pid = pid
        self.poll_result = poll_result

    def poll(self):
        return self.poll_result


def test_browser_session_launches_edge_on_dynamic_loopback_cdp_and_cleans_process_tree(
    tmp_path: Path,
) -> None:
    settings = _session_settings(tmp_path)
    process = _FakeBrowserProcess()
    launches: list[tuple[list[str], dict[str, object]]] = []
    probes: list[str] = []
    terminated: list[int] = []

    def process_factory(command, **kwargs):
        launches.append((command, kwargs))
        return process

    def readiness_probe(endpoint: str) -> bool:
        probes.append(endpoint)
        return len(probes) >= 2

    manager = BrowserSessionManager(
        settings,
        process_factory=process_factory,
        readiness_probe=readiness_probe,
        port_allocator=lambda: 43129,
        executable_resolver=lambda *_args, **_kwargs: Path("C:/Edge/msedge.exe"),
        process_tree_terminator=lambda item: terminated.append(item.pid),
        sleep=lambda _seconds: None,
    )

    with manager as session:
        assert session.cdp_endpoint == "http://127.0.0.1:43129"
        assert session.owned is True
        assert session.pid == 4242
        assert session.profile_path == (tmp_path / "edge-profile").resolve()
        assert session.browser_channel == "msedge"
        assert session.to_safe_dict()["owned"] is True
        assert "password" not in json.dumps(session.to_safe_dict()).lower()

    assert probes == ["http://127.0.0.1:43129", "http://127.0.0.1:43129"]
    assert terminated == [4242]
    command = launches[0][0]
    assert command[0] == "C:\\Edge\\msedge.exe"
    assert "--remote-debugging-address=127.0.0.1" in command
    assert "--remote-debugging-port=43129" in command
    assert "--edge-skip-compat-layer-relaunch" in command
    assert "--disable-sync" in command
    assert f"--user-data-dir={(tmp_path / 'edge-profile').resolve()}" in command
    assert "--window-size=1280,800" in command
    assert "--auth-server-allowlist=*.corp.local" in command
    assert "--auth-negotiate-delegate-allowlist=*.corp.local" in command
    assert "employee-id" not in " ".join(command)
    assert "plain-password" not in " ".join(command)
    assert not (tmp_path / "edge-profile" / ".manual-agent-cdp.lock").exists()


def test_browser_session_reuses_existing_loopback_cdp_without_owning_process(tmp_path: Path) -> None:
    settings = _session_settings(
        tmp_path,
        browser_runner="cdp_attach",
        cdp_endpoint="http://localhost:9333",
    )
    probes: list[str] = []

    def fail_process_factory(*_args, **_kwargs):
        raise AssertionError("existing CDP mode must not launch a browser")

    with BrowserSessionManager(
        settings,
        process_factory=fail_process_factory,
        readiness_probe=lambda endpoint: probes.append(endpoint) or True,
    ) as session:
        assert session.cdp_endpoint == "http://localhost:9333"
        assert session.owned is False
        assert session.pid is None
        assert session.profile_path is None

    assert probes == ["http://localhost:9333"]


@pytest.mark.parametrize(
    "endpoint",
    ["http://10.0.0.5:9222", "https://example.com:9222", "http://127.0.0.1.evil:9222"],
)
def test_browser_session_rejects_non_loopback_cdp_endpoint(tmp_path: Path, endpoint: str) -> None:
    settings = _session_settings(tmp_path, browser_runner="cdp_attach", cdp_endpoint=endpoint)

    with pytest.raises(BrowserSessionError) as exc_info:
        with BrowserSessionManager(settings, readiness_probe=lambda _endpoint: True):
            pass

    assert exc_info.value.code == "non_loopback_cdp_endpoint"


def test_browser_session_reports_profile_lock_without_launching(tmp_path: Path) -> None:
    settings = _session_settings(tmp_path)
    profile = tmp_path / "edge-profile"
    profile.mkdir(parents=True)
    (profile / ".manual-agent-cdp.lock").write_text("existing-owner", encoding="utf-8")

    def fail_process_factory(*_args, **_kwargs):
        raise AssertionError("locked profile must not launch")

    with pytest.raises(BrowserSessionError) as exc_info:
        with BrowserSessionManager(
            settings,
            process_factory=fail_process_factory,
            readiness_probe=lambda _endpoint: True,
            executable_resolver=lambda *_args, **_kwargs: Path("C:/Edge/msedge.exe"),
        ):
            pass

    assert exc_info.value.code == "profile_locked"
    assert "existing-owner" not in str(exc_info.value)


def test_browser_session_reclaims_dead_pid_profile_lock(tmp_path: Path) -> None:
    settings = _session_settings(tmp_path)
    profile = tmp_path / "edge-profile"
    profile.mkdir(parents=True)
    (profile / ".manual-agent-cdp.lock").write_text("pid=4242\n", encoding="utf-8")
    process = _FakeBrowserProcess(pid=5252)
    checked_pids: list[int] = []
    terminated: list[int] = []

    manager = BrowserSessionManager(
        settings,
        process_factory=lambda *_args, **_kwargs: process,
        readiness_probe=lambda _endpoint: True,
        port_allocator=lambda: 43129,
        executable_resolver=lambda *_args, **_kwargs: Path("C:/Edge/msedge.exe"),
        process_tree_terminator=lambda item: terminated.append(item.pid),
        process_alive_probe=lambda pid: checked_pids.append(pid) or False,
    )

    with manager as session:
        assert session.pid == 5252
        assert (profile / ".manual-agent-cdp.lock").read_text(encoding="utf-8") == "pid=5252\n"

    assert checked_pids == [4242]
    assert terminated == [5252]
    assert not (profile / ".manual-agent-cdp.lock").exists()


def test_browser_session_keeps_live_pid_profile_lock(tmp_path: Path) -> None:
    settings = _session_settings(tmp_path)
    profile = tmp_path / "edge-profile"
    profile.mkdir(parents=True)
    (profile / ".manual-agent-cdp.lock").write_text("pid=4242\n", encoding="utf-8")

    with pytest.raises(BrowserSessionError) as exc_info:
        with BrowserSessionManager(
            settings,
            process_factory=lambda *_args, **_kwargs: pytest.fail("live profile lock must not launch"),
            readiness_probe=lambda _endpoint: True,
            executable_resolver=lambda *_args, **_kwargs: Path("C:/Edge/msedge.exe"),
            process_alive_probe=lambda pid: pid == 4242,
        ):
            pass

    assert exc_info.value.code == "profile_locked"
    assert (profile / ".manual-agent-cdp.lock").read_text(encoding="utf-8") == "pid=4242\n"


def test_browser_session_timeout_terminates_owned_process_and_releases_profile(tmp_path: Path) -> None:
    settings = _session_settings(tmp_path)
    process = _FakeBrowserProcess()
    terminated: list[int] = []
    clock_values = iter([0.0, 0.0, 1.0])

    manager = BrowserSessionManager(
        settings,
        process_factory=lambda *_args, **_kwargs: process,
        readiness_probe=lambda _endpoint: False,
        port_allocator=lambda: 43129,
        executable_resolver=lambda *_args, **_kwargs: Path("C:/Edge/msedge.exe"),
        process_tree_terminator=lambda item: terminated.append(item.pid),
        sleep=lambda _seconds: None,
        clock=lambda: next(clock_values),
        startup_timeout_seconds=0.5,
    )

    with pytest.raises(BrowserSessionError) as exc_info:
        with manager:
            pass

    assert exc_info.value.code == "cdp_start_timeout"
    assert terminated == [4242]
    assert not (tmp_path / "edge-profile" / ".manual-agent-cdp.lock").exists()


def test_discover_browser_executable_uses_configuration_or_path_without_fixed_driver_location(
    tmp_path: Path,
) -> None:
    configured = tmp_path / "portable" / "msedge.exe"
    configured.parent.mkdir(parents=True)
    configured.write_bytes(b"edge")

    assert discover_browser_executable("msedge", configured_path=str(configured)) == configured.resolve()

    path_edge = tmp_path / "path" / "msedge.exe"
    path_edge.parent.mkdir()
    path_edge.write_bytes(b"edge")
    assert discover_browser_executable(
        "msedge",
        environ={"PATH": str(path_edge.parent)},
        which=lambda _name, **_kwargs: str(path_edge),
    ) == path_edge.resolve()


def _orchestrator_request() -> PipelineInput:
    return PipelineInput(
        request_text="QSike 서비스를 소개하고 최근 글을 여는 방법을 보여줘",
        target_url="https://qsike.com/",
        role="방문자",
        completion_condition="최근 글 상세 화면 확인",
        input_values={"search_query": "Playwright"},
    )


def _orchestrator_services(
    calls: list[str],
    *,
    fail_stage: str = "",
    render_fallback: bool = False,
) -> OrchestratorServices:
    @contextmanager
    def browser_session_factory(_settings):
        calls.append("browser_session.enter")
        try:
            yield SimpleNamespace(
                cdp_endpoint="http://127.0.0.1:43129",
                to_safe_dict=lambda: {"cdp_endpoint": "http://127.0.0.1:43129", "owned": True},
            )
        finally:
            calls.append("browser_session.exit")

    class Discovery:
        def run(self, *, request, job_dir, cdp_endpoint):
            calls.append("opencode_discovery")
            prompt = job_dir / "opencode_browser_prompt.md"
            events = job_dir / "opencode_events.jsonl"
            trace_path = job_dir / "opencode_execution_trace.json"
            config = job_dir / "opencode.json"
            metadata = job_dir / "opencode_browser_metadata.json"
            support = job_dir / "opencode_support_summary.txt"
            prompt.write_text("prompt", encoding="utf-8")
            events.write_text("{}\n", encoding="utf-8")
            trace_path.write_text(json.dumps(_valid_trace(), ensure_ascii=False), encoding="utf-8")
            config.write_text("{}", encoding="utf-8")
            metadata.write_text('{"status":"completed"}', encoding="utf-8")
            support.write_text("OPENCODE_BROWSER_OK\n", encoding="utf-8")
            if fail_stage == "opencode":
                raise OpenCodeBrowserDiscoveryError(
                    "opencode_nonzero_exit",
                    "failed",
                    metadata_path=metadata,
                    support_summary_path=support,
                )
            return SimpleNamespace(
                status="completed",
                trace=_valid_trace(),
                config_path=config,
                prompt_path=prompt,
                event_log_path=events,
                trace_path=trace_path,
                metadata_path=metadata,
                support_summary_path=support,
            )

    def discovery_factory(_settings):
        return Discovery()

    def trace_validator(trace, request, policy):
        calls.append("trace_validation")
        return validate_execution_trace(trace, request, policy)

    def discovery_evidence_validator(trace, *, event_log_path, job_dir):
        calls.append("discovery_evidence")
        if fail_stage == "discovery_evidence":
            raise DiscoveryEvidenceError("completion_url_unverified", "failed")
        return SimpleNamespace(
            to_safe_dict=lambda: {
                "status": "verified",
                "final_url": trace.completion_evidence.final_url,
            }
        )

    def tts_synthesizer(plan, settings, tts_dir):
        calls.append("supertonic")
        if fail_stage == "tts":
            raise SupertonicTtsError("supertonic_synthesis_failed", "failed", step_id="step-intro")
        tts_dir.mkdir(parents=True, exist_ok=True)
        audio = tts_dir / "01_step-intro.wav"
        audio.write_bytes(b"RIFF" + b"\x00" * 128)
        metadata = tts_dir / "tts_metadata.json"
        entries = [
            {
                "step_id": "step-intro",
                "provider": "supertonic",
                "speaker": "M1",
                "language": "ko",
                "duration_seconds": 1.0,
                "audio": str(audio),
            }
        ]
        metadata.write_text(json.dumps({"status": "completed", "entries": entries}), encoding="utf-8")
        return SimpleNamespace(audio_paths=[audio], metadata_path=metadata, entries=entries)

    def trace_replayer(**kwargs):
        calls.append("trace_replay")
        job_dir = kwargs["job_dir"]
        capture_dir = job_dir / "captures" / "replay"
        capture_dir.mkdir(parents=True, exist_ok=True)
        capture = capture_dir / "01_after.png"
        capture.write_bytes(b"png")
        final_frame = job_dir / "final_frame.png"
        final_frame.write_bytes(b"png")
        action_log_path = job_dir / "trace_replay_log.json"
        action_log = [{"action_id": "navigate", "status": "ok"}]
        action_log_path.write_text(json.dumps(action_log), encoding="utf-8")
        selector_trace_path = job_dir / "selector_trace.json"
        selector_trace_path.write_text("[]", encoding="utf-8")
        return SimpleNamespace(
            status="ok",
            captures=[capture],
            final_frame=final_frame,
            action_log=action_log,
            action_log_path=action_log_path,
            selector_trace_path=selector_trace_path,
            media_plan={
                "source": "opencode-trace-replay",
                "steps": [
                    {
                        "id": "step-intro",
                        "title": "QSike 소개",
                        "caption": "QSike를 소개합니다.",
                        "narration": "QSike를 소개합니다.",
                        "duration_seconds": 1.0,
                    }
                ],
            },
        )

    def masker(captures, masked_dir, input_values):
        calls.append("masking")
        masked_dir.mkdir(parents=True, exist_ok=True)
        for capture in captures:
            shutil.copy2(capture, masked_dir / capture.name)
        path = masked_dir.parent / "masking_log.json"
        path.write_text('{"status":"completed","entries":[]}', encoding="utf-8")
        return path

    def source_video_builder(package_dir, captures, *, frame_durations_seconds=None):
        calls.append("source_video")
        assert frame_durations_seconds
        path = package_dir / "manual_video_agent_usage.webm"
        path.write_bytes(b"webm")
        return path

    def subtitle_renderer(plan, package_dir, redaction=None):
        calls.append("subtitles")
        path = package_dir / "subtitles.vtt"
        path.write_text("WEBVTT\n", encoding="utf-8")
        return path

    def preview_renderer(request, plan, dirs, masked_names, tts_audio, **_kwargs):
        calls.append("preview")
        path = dirs.package / "preview.html"
        path.write_text("<html>preview</html>", encoding="utf-8")
        return path

    def markdown_renderer(request, plan, dirs, masked_names, settings):
        calls.append("manual")
        path = dirs.package / "manual.md"
        path.write_text("# manual", encoding="utf-8")
        return path

    def pdf_renderer(request, dirs):
        calls.append("pdf")
        path = dirs.package / "manual.pdf"
        path.write_bytes(b"%PDF")
        return path

    def video_renderer(**kwargs):
        calls.append("render")
        package_dir = kwargs["package_dir"]
        video = package_dir / "manual_video_agent_usage.mp4"
        video.write_bytes(b"mp4")
        composition = package_dir / "hyperframes"
        composition.mkdir(parents=True, exist_ok=True)
        (composition / "index.html").write_text("<html></html>", encoding="utf-8")
        (composition / "hyperframes_manifest.json").write_text("{}", encoding="utf-8")
        metadata = package_dir / "video_render.json"
        metadata.write_text('{"status":"completed","quality":{"status":"passed"}}', encoding="utf-8")
        skills = package_dir / "hyperframes_skills.json"
        skills.write_text('{"status":"skipped"}', encoding="utf-8")
        return SimpleNamespace(
            video_path=video,
            composition_dir=composition,
            metadata_path=metadata,
            skills_metadata_path=skills,
            used_fallback=render_fallback,
        )

    return OrchestratorServices(
        environment_fingerprint=lambda: calls.append("environment") or {"python_version": "3.13.14"},
        browser_session_factory=browser_session_factory,
        discovery_factory=discovery_factory,
        trace_validator=trace_validator,
        discovery_evidence_validator=discovery_evidence_validator,
        tts_synthesizer=tts_synthesizer,
        trace_replayer=trace_replayer,
        masker=masker,
        source_video_builder=source_video_builder,
        subtitle_renderer=subtitle_renderer,
        preview_renderer=preview_renderer,
        markdown_renderer=markdown_renderer,
        pdf_renderer=pdf_renderer,
        video_renderer=video_renderer,
    )


def test_opencode_orchestrator_runs_only_the_new_fail_fast_pipeline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import backend.app.pipeline as pipeline_module

    def forbidden(*_args, **_kwargs):
        raise AssertionError("legacy planner/agent path was called")

    for name in (
        "build_plan",
        "extract_input_values",
        "rehearse_plan",
        "run_opencode_agent",
        "decide_browser_agent_action",
        "enrich_page_agent_observation",
    ):
        monkeypatch.setattr(pipeline_module, name, forbidden)

    calls: list[str] = []
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_OPENCODE": "true",
            "MANUAL_AGENT_VIDEO_RENDERER": "hyperframes",
        }
    )
    result = OpenCodeVideoOrchestrator(
        settings=settings,
        services=_orchestrator_services(calls),
    ).run(_orchestrator_request(), base_dir=tmp_path)

    assert result.status == "completed"
    assert calls == [
        "environment",
        "browser_session.enter",
        "opencode_discovery",
        "trace_validation",
        "discovery_evidence",
        "supertonic",
        "trace_replay",
        "browser_session.exit",
        "masking",
        "source_video",
        "subtitles",
        "preview",
        "manual",
        "pdf",
        "render",
    ]
    manifest = json.loads(result.artifacts.package_manifest.read_text(encoding="utf-8"))
    assert manifest["pipeline"] == "opencode-only"
    assert manifest["degradations"] == []
    assert manifest["render_quality"]["status"] == "passed"
    assert Path(manifest["supporting_artifacts"]["opencode_execution_trace"]).exists()
    assert result.artifacts.video.read_bytes() == b"mp4"
    assert verify_manifest(result.artifacts.package_manifest) == []
    actors = {
        json.loads(line)["actor"]
        for line in result.artifacts.audit_log.read_text(encoding="utf-8").splitlines()
    }
    assert actors == {
        "environment",
        "browser_session",
        "opencode",
        "discovery_evidence",
        "trace_validation",
        "tts",
        "replay",
        "masking",
        "render",
        "manifest",
    }


def test_frame_durations_follow_each_narrated_step_timeline() -> None:
    captures = [
        Path("01_01_before.png"),
        Path("01_01_after.png"),
        Path("02_01_before.png"),
        Path("02_01_focus.png"),
        Path("02_01_after.png"),
    ]
    media_plan = {
        "steps": [
            {"id": "step-one", "duration_seconds": 4.0},
            {"id": "step-two", "duration_seconds": 6.0},
        ]
    }

    durations = _frame_durations_for_media_plan(captures, media_plan)

    assert durations == {
        "01_01_before.png": 2.0,
        "01_01_after.png": 2.0,
        "02_01_before.png": 2.0,
        "02_01_focus.png": 2.0,
        "02_01_after.png": 2.0,
    }
    assert sum(durations.values()) == 10.0


@pytest.mark.parametrize(
    ("fail_stage", "error_type"),
    [
        ("opencode", OpenCodeBrowserDiscoveryError),
        ("discovery_evidence", DiscoveryEvidenceError),
        ("tts", SupertonicTtsError),
    ],
)
def test_opencode_orchestrator_marks_required_stage_failure_without_degradation(
    tmp_path: Path,
    fail_stage: str,
    error_type: type[Exception],
) -> None:
    calls: list[str] = []
    orchestrator = OpenCodeVideoOrchestrator(
        settings=load_settings(environ={"MANUAL_AGENT_ENABLE_OPENCODE": "true"}),
        services=_orchestrator_services(calls, fail_stage=fail_stage),
    )

    with pytest.raises(error_type):
        orchestrator.run(_orchestrator_request(), base_dir=tmp_path)

    [state_path] = list((tmp_path / "jobs").glob("*/workflow_state.json"))
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["status"] == "failed"
    assert state["current_step"] == "execution_failed"
    assert state["can_continue"] is True
    assert state["details"]["degraded"] is False
    support = state_path.parent / "support_log.md"
    assert support.exists()
    assert fail_stage in support.read_text(encoding="utf-8").lower()


def test_opencode_orchestrator_rejects_hyperframes_fallback_as_failed_render(
    tmp_path: Path,
) -> None:
    calls: list[str] = []
    orchestrator = OpenCodeVideoOrchestrator(
        settings=load_settings(
            environ={
                "MANUAL_AGENT_ENABLE_OPENCODE": "true",
                "MANUAL_AGENT_VIDEO_RENDERER": "hyperframes",
            }
        ),
        services=_orchestrator_services(calls, render_fallback=True),
    )

    with pytest.raises(RuntimeError, match="HyperFrames.*fallback"):
        orchestrator.run(_orchestrator_request(), base_dir=tmp_path)

    [state_path] = list((tmp_path / "jobs").glob("*/workflow_state.json"))
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["status"] == "failed"
    assert state["details"]["actor"] == "render"
    assert state["details"]["degraded"] is False


def test_opencode_orchestrator_draft_and_continue_keep_public_workflow_contract(
    tmp_path: Path,
) -> None:
    calls: list[str] = []
    orchestrator = OpenCodeVideoOrchestrator(
        settings=load_settings(environ={"MANUAL_AGENT_ENABLE_OPENCODE": "true"}),
        services=_orchestrator_services(calls),
    )

    draft = orchestrator.create_draft(_orchestrator_request(), base_dir=tmp_path)

    assert draft.status == "awaiting_plan_review"
    assert draft.can_continue is True
    assert draft.plan["planner"] == "opencode-pending"
    assert draft.plan["actions"] == []
    assert calls == ["environment"]
    state = json.loads((draft.package_dir / "workflow_state.json").read_text(encoding="utf-8"))
    assert state["current_step"] == "plan_review"

    result = orchestrator.continue_draft(draft.job_id, base_dir=tmp_path)

    assert result.job_id == draft.job_id
    assert result.status == "completed"
    assert result.package_dir == draft.package_dir
    again = orchestrator.continue_draft(draft.job_id, base_dir=tmp_path)
    assert again.artifacts.package_manifest == result.artifacts.package_manifest


def test_pipeline_public_run_function_delegates_to_opencode_orchestrator(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import backend.app.opencode_orchestrator as orchestrator_module
    import backend.app.pipeline as pipeline_module

    sentinel = object()
    calls: list[tuple] = []

    class FakeOrchestrator:
        def run(self, request, *, base_dir, capture_browser):
            calls.append((request, base_dir, capture_browser))
            return sentinel

    monkeypatch.setattr(orchestrator_module, "OpenCodeVideoOrchestrator", FakeOrchestrator)

    result = pipeline_module.run_pipeline(
        _orchestrator_request(),
        base_dir=tmp_path,
        capture_browser=False,
    )

    assert result is sentinel
    assert calls == [(_orchestrator_request(), tmp_path, False)]


def test_qsike_acceptance_fixture_defines_live_quality_and_package_contract() -> None:
    fixture_path = Path("test_scenarios/qsike_service_manual.json")
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    request = PipelineInput.model_validate(fixture["request"])
    assert request.target_url == "https://qsike.com/"
    assert "쿠키" in request.request_text
    assert "대표 기술 노트" in request.request_text
    assert fixture["policy"]["allowed_origins"] == ["https://qsike.com"]
    assert fixture["policy"]["read_only"] is True
    assert fixture["expected_trace"]["minimum_steps"] >= 4
    assert {"QSike Tech Notes", "주제별 기술 노트", "발행"}.issubset(
        set(fixture["expected_trace"]["visible_evidence"])
    )
    assert fixture["expected_media"]["minimum_duration_seconds"] >= 20
    assert fixture["expected_media"]["require_audio"] is True
    assert fixture["expected_media"]["require_subtitles"] is True
    assert fixture["expected_media"]["require_nonblank_frames"] is True
    assert fixture["expected_media"]["forbid_duplicate_narration"] is True
    assert {
        "opencode_execution_trace.json",
        "trace_replay_log.json",
        "selector_trace.json",
        "tts/tts_metadata.json",
        "subtitles.vtt",
        "package_manifest.json",
    }.issubset(set(fixture["required_artifacts"]))
