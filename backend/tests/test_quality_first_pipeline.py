import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.app.adapters.browser_agent import decide_browser_agent_action
from backend.app.adapters.input_extractor import extract_input_values
from backend.app.adapters.planner import _normalize_plan, build_plan
from backend.app.config import load_settings
from backend.app.pipeline import (
    PipelineInput,
    _execute_browser_agent_actions,
    _media_plan_for_outputs,
    _media_plan_from_subtitles,
    _render_degrade_reason,
    run_pipeline,
)


def _request(**updates):
    values = {
        "request_text": "사내 챗봇에서 질문을 입력하고 답변을 확인하는 영상을 만들어줘",
        "target_url": "http://internal.example.local/chat",
        "role": "사용자",
        "completion_condition": "질문과 답변 영역이 보이면 완료",
        "input_values": {"질문": "st.form과 st.input의 차이를 알려줘"},
        "agent_brief": {
            "task_type": "chat_prompt",
            "required_inputs": ["질문"],
            "safe_click_intents": ["전송", "Send", "Enter"],
            "success_criteria": ["질문과 답변 영역이 보이면 완료"],
        },
    }
    values.update(updates)
    return PipelineInput(**values)


def _ollama_env(**updates):
    values = {
        "MANUAL_AGENT_LLM_PROVIDER": "ollama",
        "MANUAL_AGENT_LLM_BASE_URL": "http://127.0.0.1:11434/v1",
        "MANUAL_AGENT_LLM_MODEL": "gemma4:12b_qat",
        "MANUAL_AGENT_ENABLE_INPUT_EXTRACTOR": "true",
        "MANUAL_AGENT_ENABLE_INTERNAL_PLANNER": "true",
        "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
    }
    values.update(updates)
    return values


def test_ollama_input_extractor_uses_quality_prompt_and_json_response_format(tmp_path: Path):
    calls = []

    def fake_post(url, headers, payload, timeout_seconds):
        calls.append(payload)
        return {"choices": [{"message": {"content": '{"input_values":{"질문":"st.form과 st.input의 차이를 알려줘"}}'}}]}

    extract_input_values(
        _request(),
        load_settings(environ=_ollama_env()),
        package_dir=tmp_path,
        http_post=fake_post,
    )

    payload = calls[0]
    assert payload["response_format"] == {"type": "json_object"}
    assert payload["reasoning_effort"] == "none"
    assert payload["max_tokens"] == 300
    assert "업무 화면에 실제로 입력할 값만 추출" in payload["messages"][0]["content"]
    assert "영상 길이" in payload["messages"][0]["content"]


def test_ollama_planner_uses_evidence_bounded_prompt_and_json_response_format(tmp_path: Path):
    calls = []

    def fake_post(url, headers, payload, timeout_seconds):
        calls.append(payload)
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "steps": [{"id": "step_1", "title": "화면 진입", "caption": "대상 화면을 확인", "narration": "대상 화면을 확인합니다."}],
                                "actions": [{"id": "a1", "type": "navigate", "step_id": "step_1", "target": "http://internal.example.local/chat"}],
                            },
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }

    build_plan(_request(), load_settings(environ=_ollama_env()), package_dir=tmp_path, http_post=fake_post)

    payload = calls[0]
    assert payload["response_format"] == {"type": "json_object"}
    assert payload["reasoning_effort"] == "none"
    assert payload["max_tokens"] == 1200
    assert "실제 브라우저 DOM이나 스크린샷을 보지 못한다" in payload["messages"][0]["content"]
    assert "존재가 확인되지 않은" in payload["messages"][0]["content"]


def test_ollama_dom_browser_agent_uses_single_action_prompt_and_json_response_format(tmp_path: Path):
    calls = []

    def fake_post(url, headers, payload, timeout_seconds):
        calls.append(payload)
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {"type": "fill_by_label", "label": "질문", "value_key": "질문", "reason": "질문 입력"},
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }

    decide_browser_agent_action(
        _request(),
        load_settings(environ=_ollama_env()),
        {"fields": [{"label": "질문", "value": ""}], "clickables": [{"text": "전송"}], "body_text": "사내 챗봇"},
        [],
        step_index=1,
        http_post=fake_post,
        package_dir=tmp_path,
    )

    payload = calls[0]
    assert payload["response_format"] == {"type": "json_object"}
    assert payload["reasoning_effort"] == "none"
    assert payload["max_tokens"] == 350
    assert "다음 안전한 행동 하나만 선택" in payload["messages"][0]["content"]
    assert "성공 증거 없이 finish" in payload["messages"][0]["content"]


def test_ollama_vlm_browser_agent_uses_quality_prompt_and_json_response_format(tmp_path: Path):
    screenshot = tmp_path / "screen.png"
    screenshot.write_bytes(b"fake-png")
    calls = []

    def fake_post(url, headers, payload, timeout_seconds):
        calls.append(payload)
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {"type": "fill_by_label", "label": "질문", "value_key": "질문", "reason": "질문 입력"},
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }

    settings = load_settings(
        environ=_ollama_env(
            MANUAL_AGENT_VLM_PROVIDER="ollama",
            MANUAL_AGENT_VLM_BASE_URL="http://127.0.0.1:11434/v1",
            MANUAL_AGENT_VLM_MODEL="gemma4:12b_qat",
        )
    )
    decide_browser_agent_action(
        _request(),
        settings,
        {
            "fields": [{"label": "질문", "value": ""}],
            "clickables": [{"text": "전송"}],
            "body_text": "사내 챗봇",
            "screenshot": {"status": "ok", "path": str(screenshot)},
        },
        [],
        step_index=1,
        http_post=fake_post,
        package_dir=tmp_path,
    )

    payload = calls[0]
    assert payload["response_format"] == {"type": "json_object"}
    assert payload["reasoning_effort"] == "none"
    assert payload["max_tokens"] == 350
    prompt_text = payload["messages"][0]["content"][0]["text"]
    assert "스크린샷과 DOM observation" in prompt_text
    assert "정확히 한 행동만 반환" in prompt_text


def test_internal_provider_does_not_receive_ollama_response_format(tmp_path: Path):
    calls = []

    def fake_post(url, headers, payload, timeout_seconds):
        calls.append(payload)
        return {"choices": [{"message": {"content": '{"input_values":{}}'}}]}

    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_INPUT_EXTRACTOR": "true",
            "MANUAL_AGENT_LLM_PROVIDER": "internal",
            "MANUAL_AGENT_OPENAI_API_KEY": "key",
            "MANUAL_AGENT_LLM_BASE_URL": "http://api.net/v1",
            "MANUAL_AGENT_LLM_MODEL": "QWEN3",
            "MANUAL_AGENT_DEP_TICKET": "ticket",
            "MANUAL_AGENT_SEND_SYSTEM_NAME": "manual-agent",
            "MANUAL_AGENT_USER_ID": "USER01",
            "MANUAL_AGENT_USER_TYPE": "AD_ID",
        }
    )
    extract_input_values(_request(), settings, package_dir=tmp_path, http_post=fake_post)

    assert "response_format" not in calls[0]
    assert "reasoning_effort" not in calls[0]
    assert "max_tokens" not in calls[0]


def test_planner_normalizes_gemma_style_missing_action_fields_from_request_contract():
    raw = {
        "steps": [
            {"id": "step_1", "title": "접속"},
            {"id": "step_2", "title": "질문 입력"},
            {"id": "step_3", "title": "답변 확인"},
        ],
        "actions": [
            {"id": "a1", "type": "navigate", "step_id": "step_1", "url": "http://wrong.invalid"},
            {
                "id": "a2",
                "type": "fill_by_label",
                "step_id": "step_2",
                "질문": "st.form과 st.input의 차이를 알려줘",
            },
            {"id": "a3", "type": "click_by_text", "step_id": "step_3"},
            {"id": "a4", "type": "wait", "step_id": "step_3"},
            {"id": "a5", "type": "capture_step", "step_id": "step_3"},
        ],
    }
    request = _request(
        input_values={"질문": "st.form과 st.input의 차이를 알려줘"},
        agent_brief={**_request().agent_brief, "safe_click_intents": ["Ask"]},
    )

    plan = _normalize_plan(raw, request)

    assert plan["actions"][0]["target"] == request.target_url
    assert plan["actions"][1]["label"] == "질문"
    assert plan["actions"][1]["value_key"] == "질문"
    assert plan["actions"][1]["value"] == "st.form과 st.input의 차이를 알려줘"
    assert plan["actions"][2]["texts"] == ["Ask"]
    assert plan["actions"][2]["label"] == "Ask"


def test_planner_restores_fill_label_when_gemma_returns_only_value_key_and_value():
    raw = {
        "steps": [{"id": "step_1", "title": "질문 입력"}],
        "actions": [
            {
                "id": "a1",
                "type": "fill_by_label",
                "step_id": "step_1",
                "value_key": "질문",
                "value": "st.form과 st.input의 차이를 알려줘",
            }
        ],
    }

    plan = _normalize_plan(raw, _request(input_values={"질문": "st.form과 st.input의 차이를 알려줘"}))

    fill = next(item for item in plan["actions"] if item["type"] == "fill_by_label")
    assert fill["label"] == "질문"
    assert fill["value_key"] == "질문"


def test_utf8_subprocess_runner_decodes_non_cp949_output():
    from backend.app.subprocess_utils import run_text_command

    completed = run_text_command(
        subprocess.run,
        [sys.executable, "-c", "import sys; sys.stdout.buffer.write('✓ 렌더 완료'.encode('utf-8'))"],
        capture_output=True,
        timeout=10,
    )

    assert completed.returncode == 0
    assert completed.stdout == "✓ 렌더 완료"


@pytest.mark.parametrize("event_type", ["capture", "wait"])
def test_replay_treats_capture_and_wait_events_as_successful_holds(event_type):
    from backend.app import pipeline as pipeline_module

    waits = []

    class FakePage:
        def evaluate(self, *args, **kwargs):
            return None

        def wait_for_timeout(self, timeout):
            waits.append(timeout)

    log = pipeline_module._execute_demonstration_replay_event(
        FakePage(),
        {"type": event_type, "reason": "현재 화면을 확인한다."},
        {"id": "step_hold"},
        1.2,
    )

    assert log["status"] == "ok"
    assert log["method"] == f"{event_type}_hold"
    assert sum(waits) >= 1200


@pytest.mark.parametrize(
    ("duration_text", "expected_seconds"),
    [
        ("5분짜리 영상", 300.0),
        ("30초 영상", 30.0),
        ("1분 30초 길이", 90.0),
    ],
)
def test_input_extractor_adds_requested_video_duration_to_scenario_brief(
    tmp_path: Path,
    duration_text: str,
    expected_seconds: float,
):
    request = _request(
        request_text=f"LOT-001을 조회하는 {duration_text}을 만들어줘",
        input_values={"LOT": "LOT-001"},
    )

    result = extract_input_values(request, load_settings(environ={}), package_dir=tmp_path)

    assert result["scenario_brief"]["target_video_duration_seconds"] == expected_seconds
    assert result["effective_input_values"] == {"LOT": "LOT-001"}


def test_input_extractor_omits_video_duration_when_request_has_no_duration(tmp_path: Path):
    result = extract_input_values(_request(), load_settings(environ={}), package_dir=tmp_path)

    assert "target_video_duration_seconds" not in result["scenario_brief"]


def test_compact_observation_bounds_large_dom_and_preserves_selectors():
    from backend.app.adapters.browser_quality import compact_observation

    observation = {
        "url": "http://internal.example.local/chat",
        "title": "사내 챗봇",
        "headings": [f"heading-{index}" for index in range(30)],
        "fields": [
            {
                "selector": f"input[data-index='{index}']",
                "label": f"필드 {index}",
                "value": "",
                "placeholder": f"placeholder {index}",
            }
            for index in range(80)
        ],
        "clickables": [
            {
                "selector": f"button[data-index='{index}']",
                "text": f"버튼 {index}",
                "agent_name": f"버튼 {index}",
            }
            for index in range(100)
        ],
        "body_text": "본문 " * 2000,
        "screenshot": {"status": "ok", "path": "C:/tmp/screen.png", "bytes": "do-not-send"},
        "page_agent": {"status": "ok", "candidate_count": 100, "contract": "dom-observe-act-verify"},
    }

    compacted = compact_observation(observation)

    assert len(compacted["body_text"]) <= 2400
    assert len(compacted["headings"]) <= 12
    assert len(compacted["fields"]) <= 40
    assert len(compacted["clickables"]) <= 60
    assert compacted["fields"][0]["selector"] == "input[data-index='0']"
    assert compacted["clickables"][0]["selector"] == "button[data-index='0']"
    assert compacted["screenshot"] == {"status": "ok", "path": "C:/tmp/screen.png"}
    assert compacted["page_agent"]["candidate_count"] == 100


def test_compact_observation_preserves_mcp_refs_and_source_metadata():
    from backend.app.adapters.browser_quality import compact_observation

    compacted = compact_observation(
        {
            "fields": [{"label": "질문", "ref": "e_input", "role": "textbox", "type": "textbox"}],
            "clickables": [{"text": "전송", "ref": "e_send", "role": "button"}],
            "body_text": "질문 입력 화면",
            "observation_source": "browser_snapshot_compact",
            "snapshot_truncated": True,
            "snapshot_total_chars": 250000,
        }
    )

    assert compacted["fields"][0]["ref"] == "e_input"
    assert compacted["clickables"][0]["ref"] == "e_send"
    assert compacted["observation_source"] == "browser_snapshot_compact"
    assert compacted["snapshot_truncated"] is True
    assert compacted["snapshot_total_chars"] == 250000


def test_compact_history_keeps_recent_action_evidence_without_nested_payloads():
    from backend.app.adapters.browser_quality import compact_history

    history = [
        {
            "step": index,
            "type": "click_by_selector",
            "selector": f"button[data-index='{index}']",
            "status": "ok",
            "reason": f"단계 {index}",
            "observation": {"body_text": "x" * 5000},
            "result": {"raw": "y" * 5000},
            "verification": {"status": "ok", "changed": index % 2 == 0, "reason": "page_changed"},
        }
        for index in range(10)
    ]

    compacted = compact_history(history)

    assert [item["step"] for item in compacted] == [4, 5, 6, 7, 8, 9]
    assert all("observation" not in item for item in compacted)
    assert all("result" not in item for item in compacted)
    assert compacted[-1]["selector"] == "button[data-index='9']"
    assert compacted[-1]["verification"] == {"status": "ok", "changed": False, "reason": "page_changed"}


def test_browser_agent_payload_uses_compact_observation_and_history(tmp_path: Path):
    calls = []

    def fake_post(url, headers, payload, timeout_seconds):
        calls.append(payload)
        return {"choices": [{"message": {"content": '{"type":"wait","timeout_ms":2000,"reason":"재관찰"}'}}]}

    observation = {
        "fields": [{"selector": "textarea#question", "label": "질문", "value": ""}],
        "clickables": [{"selector": "button#send", "text": "전송"}],
        "body_text": "본문 " * 2000,
    }
    history = [
        {"step": index, "type": "wait", "status": "ok", "reason": "대기", "result": {"raw": "x" * 5000}}
        for index in range(10)
    ]

    decide_browser_agent_action(
        _request(),
        load_settings(environ=_ollama_env()),
        observation,
        history,
        step_index=11,
        http_post=fake_post,
        package_dir=tmp_path,
    )

    context = json.loads(calls[0]["messages"][1]["content"])
    assert len(context["observation"]["body_text"]) <= 2400
    assert len(context["history"]) == 6
    assert "result" not in context["history"][-1]


@pytest.mark.parametrize(
    ("action", "observation", "history", "error_code"),
    [
        (
            {"type": "click_by_selector", "selector": "button#missing"},
            {"fields": [], "clickables": [{"selector": "button#send", "text": "전송"}], "body_text": "챗봇"},
            [],
            "selector_not_observed",
        ),
        (
            {"type": "fill_by_label", "label": "없는 필드", "value_key": "질문"},
            {"fields": [{"selector": "textarea#question", "label": "질문", "value": ""}], "clickables": [], "body_text": "챗봇"},
            [],
            "fill_target_not_observed",
        ),
        (
            {"type": "click_by_text", "texts": ["Web Search"]},
            {"fields": [], "clickables": [{"selector": "button#web", "text": "Web Search"}], "body_text": "챗봇"},
            [],
            "disallowed_click",
        ),
        (
            {"type": "capture_step"},
            {"fields": [], "clickables": [], "body_text": "결과"},
            [{"type": "capture_step", "status": "ok"}],
            "consecutive_capture",
        ),
        (
            {"type": "finish"},
            {"fields": [], "clickables": [], "body_text": "챗봇 입력 화면"},
            [{"type": "fill_by_label", "status": "ok"}],
            "finish_without_success_evidence",
        ),
    ],
)
def test_quality_validator_rejects_unsafe_or_unverified_actions(action, observation, history, error_code):
    from backend.app.adapters.browser_quality import validate_browser_action

    errors = validate_browser_action(action, _request(), observation, history)

    assert error_code in errors


def test_quality_validator_rejects_repeated_action_when_page_did_not_change():
    from backend.app.adapters.browser_quality import validate_browser_action

    action = {"type": "click_by_selector", "selector": "button#send"}
    history = [
        {
            "type": "click_by_selector",
            "selector": "button#send",
            "status": "ok",
            "verification": {"status": "ok", "changed": False, "reason": "page_unchanged"},
        }
    ]
    observation = {"fields": [], "clickables": [{"selector": "button#send", "text": "전송"}], "body_text": "챗봇"}

    errors = validate_browser_action(action, _request(), observation, history)

    assert "repeated_action_without_page_change" in errors


def test_quality_validator_rejects_submit_click_before_visible_required_input_is_filled():
    from backend.app.adapters.browser_quality import validate_browser_action

    observation = {
        "fields": [{"selector": "textarea#question", "label": "질문 입력", "value": ""}],
        "clickables": [{"selector": "button#send", "text": "전송"}],
        "body_text": "질문 입력 화면",
    }

    errors = validate_browser_action(
        {"type": "click_by_selector", "selector": "button#send"},
        _request(),
        observation,
        [],
    )

    assert "click_before_required_input" in errors


def test_quality_validator_allows_finish_after_success_capture():
    from backend.app.adapters.browser_quality import validate_browser_action

    history = [
        {"type": "fill_by_label", "label": "질문", "status": "ok"},
        {"type": "click_by_selector", "selector": "button#send", "status": "ok"},
        {"type": "wait", "status": "ok"},
        {"type": "capture_step", "status": "ok", "capture": "result.png"},
    ]
    observation = {
        "fields": [{"selector": "textarea#question", "label": "질문", "value": "st.form과 st.input의 차이를 알려줘"}],
        "clickables": [{"selector": "button#send", "text": "전송"}],
        "body_text": "질문에 대한 답변 영역과 응답 텍스트가 표시되었습니다.",
    }

    errors = validate_browser_action({"type": "finish"}, _request(), observation, history)

    assert errors == []


def test_quality_first_vlm_repairs_invalid_action_once(tmp_path: Path):
    screenshot = tmp_path / "screen.png"
    screenshot.write_bytes(b"fake-png")
    calls = []
    responses = [
        {"type": "click_by_selector", "selector": "button#invented", "reason": "전송"},
        {"type": "fill_by_label", "label": "질문", "value_key": "질문", "reason": "관찰된 질문 필드 입력"},
    ]

    def fake_post(url, headers, payload, timeout_seconds):
        calls.append(payload)
        return {"choices": [{"message": {"content": json.dumps(responses.pop(0), ensure_ascii=False)}}]}

    settings = load_settings(
        environ=_ollama_env(
            MANUAL_AGENT_ENABLE_PAGE_AGENT="true",
            MANUAL_AGENT_BROWSER_DECISION_POLICY="quality_first",
            MANUAL_AGENT_VLM_PROVIDER="ollama",
            MANUAL_AGENT_VLM_BASE_URL="http://127.0.0.1:11434/v1",
            MANUAL_AGENT_VLM_MODEL="gemma4:12b_qat",
        )
    )
    action = decide_browser_agent_action(
        _request(),
        settings,
        {
            "fields": [{"selector": "textarea#question", "label": "질문", "value": ""}],
            "clickables": [{"selector": "button#send", "text": "전송"}],
            "body_text": "사내 챗봇 질문 입력 화면",
            "screenshot": {"status": "ok", "path": str(screenshot)},
        },
        [],
        step_index=1,
        http_post=fake_post,
        package_dir=tmp_path,
    )

    assert len(calls) == 2
    assert action["type"] == "fill_by_label"
    assert action["source"] == "browser-agent-vlm-repair"
    assert action["vlm_attempt"] == 2
    assert action["repair_applied"] is True
    repair_prompt = calls[1]["messages"][0]["content"][0]["text"]
    assert "selector_not_observed" in repair_prompt
    assert "button#invented" in repair_prompt


def test_quality_first_accepts_gemma_nested_single_action_without_repair(tmp_path: Path):
    screenshot = tmp_path / "screen.png"
    screenshot.write_bytes(b"fake-png")
    calls = []

    def fake_post(url, headers, payload, timeout_seconds):
        calls.append(payload)
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "fill_by_label": {
                                    "label": "질문",
                                    "value_key": "질문",
                                    "reason": "관찰된 질문 필드를 입력한다.",
                                }
                            },
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }

    settings = load_settings(
        environ=_ollama_env(
            MANUAL_AGENT_BROWSER_DECISION_POLICY="quality_first",
            MANUAL_AGENT_VLM_PROVIDER="ollama",
            MANUAL_AGENT_VLM_BASE_URL="http://127.0.0.1:11434/v1",
            MANUAL_AGENT_VLM_MODEL="gemma4:12b_qat",
        )
    )
    action = decide_browser_agent_action(
        _request(),
        settings,
        {
            "fields": [{"selector": "textarea#question", "label": "질문", "value": ""}],
            "clickables": [{"selector": "button#send", "text": "전송"}],
            "body_text": "사내 챗봇 질문 입력 화면",
            "screenshot": {"status": "ok", "path": str(screenshot)},
        },
        [],
        step_index=1,
        http_post=fake_post,
        package_dir=tmp_path,
    )

    assert len(calls) == 1
    assert action["type"] == "fill_by_label"
    assert action["label"] == "질문"
    assert action["vlm_attempt"] == 1
    assert action["repair_applied"] is False


def test_quality_first_policy_is_exposed_in_safe_status():
    settings = load_settings(environ={"MANUAL_AGENT_BROWSER_DECISION_POLICY": "quality_first"})

    assert settings.browser_decision_policy == "quality_first"
    assert settings.safe_status()["runtime"]["browser_decision_policy"] == "quality_first"


def test_llm_response_log_records_latency_and_payload_sizes(tmp_path: Path):
    def fake_post(url, headers, payload, timeout_seconds):
        return {"choices": [{"message": {"content": '{"input_values":{}}'}}]}

    extract_input_values(
        _request(),
        load_settings(environ=_ollama_env()),
        package_dir=tmp_path,
        http_post=fake_post,
    )

    event = json.loads((tmp_path / "llm_responses.jsonl").read_text(encoding="utf-8").splitlines()[0])
    details = event["details"]
    assert details["elapsed_ms"] >= 0
    assert details["request_bytes"] > 0
    assert details["response_bytes"] > 0
    assert details["attempt"] == 1


def test_quality_first_dom_llm_rejects_premature_finish_and_uses_local_action(tmp_path: Path):
    def fake_post(url, headers, payload, timeout_seconds):
        return {"choices": [{"message": {"content": '{"type":"finish","reason":"완료"}'}}]}

    settings = load_settings(
        environ=_ollama_env(
            MANUAL_AGENT_BROWSER_DECISION_POLICY="quality_first",
            MANUAL_AGENT_VLM_BASE_URL="",
            MANUAL_AGENT_VLM_MODEL="",
        )
    )
    action = decide_browser_agent_action(
        _request(),
        settings,
        {"fields": [{"selector": "textarea#question", "label": "질문", "value": ""}], "clickables": [], "body_text": "질문 입력 화면"},
        [],
        step_index=1,
        http_post=fake_post,
        package_dir=tmp_path,
    )

    assert action["type"] == "fill_by_label"
    assert action["source"] == "browser-agent-local-fallback"
    assert "finish_without_success_evidence" in action["validation_errors"]


def test_pipeline_history_preserves_action_target_and_verification(tmp_path: Path):
    seen_history = []

    class FakeLocator:
        def click(self):
            return None

    class FakePage:
        def locator(self, selector):
            return FakeLocator()

        def wait_for_timeout(self, timeout):
            return None

        def screenshot(self, path, full_page=False):
            Path(path).write_bytes(b"png")

        def evaluate(self, *args, **kwargs):
            return None

    class Settings:
        enable_browser_agent = True
        enable_page_agent = False
        browser_agent_max_steps = 2
        login = type("Login", (), {"mode": "none"})()

    def decide_next(request, settings, observation, history, step_index):
        if not history:
            return {"type": "click_by_selector", "selector": "button#send", "status": "ok", "reason": "전송"}
        seen_history.extend(history)
        return {"type": "finish", "status": "ok", "reason": "종료"}

    observation = {
        "fields": [],
        "clickables": [{"selector": "button#send", "text": "전송"}],
        "body_text": "챗봇",
    }
    _execute_browser_agent_actions(
        FakePage(),
        _request(),
        {"steps": [], "actions": []},
        tmp_path,
        Settings(),
        decide_next=decide_next,
        observe_page=lambda page: observation,
        verify_action=lambda page, action, log_entry, previous: {"status": "ok", "changed": False, "reason": "page_unchanged"},
    )

    assert seen_history[0]["selector"] == "button#send"
    assert seen_history[0]["verification"] == {"status": "ok", "changed": False, "reason": "page_unchanged"}


def test_quality_first_pipeline_attaches_pre_action_screenshot_to_each_observation(tmp_path: Path):
    observed_screenshots = []

    class FakePage:
        def screenshot(self, path, full_page=False):
            Path(path).write_bytes(b"png")

        def wait_for_timeout(self, timeout):
            return None

        def add_style_tag(self, content):
            return None

        def evaluate(self, *args, **kwargs):
            return None

    class Settings:
        enable_browser_agent = True
        enable_page_agent = False
        browser_decision_policy = "quality_first"
        browser_agent_max_steps = 1
        login = type("Login", (), {"mode": "none"})()

    def decide_next(request, settings, observation, history, step_index):
        observed_screenshots.append(observation["screenshot"])
        return {"type": "capture_step", "status": "ok", "reason": "현재 화면 증거를 캡처합니다."}

    result = _execute_browser_agent_actions(
        FakePage(),
        _request(),
        {"steps": [], "actions": []},
        tmp_path,
        Settings(),
        decide_next=decide_next,
        observe_page=lambda page: {"fields": [], "clickables": [], "body_text": "챗봇"},
    )

    assert observed_screenshots[0]["status"] == "ok"
    assert Path(observed_screenshots[0]["path"]).read_bytes() == b"png"
    assert Path(observed_screenshots[0]["path"]).parent.name == "observations"
    assert result["captures"]
    assert result["status"] == "degraded"
    assert result["degrade_reason"] == "browser_agent_max_steps_exhausted"
    assert result["action_log"][-1]["reason"] == "browser_agent_max_steps_exhausted"


def test_browser_media_plan_excludes_failed_actions_and_duplicate_narration():
    request = _request(agent_brief={**_request().agent_brief, "target_video_duration_seconds": 90})
    action_log = [
        {"type": "fill_by_label", "status": "ok", "label": "질문", "value": "st.form과 st.input의 차이를 알려줘", "reason": "질문을 입력합니다."},
        {"type": "capture_step", "status": "ok", "reason": "질문 입력 화면을 확인합니다."},
        {"type": "capture_step", "status": "ok", "reason": "질문 입력 화면을 확인합니다."},
        {"type": "click_by_selector", "status": "failed", "selector": "button#wrong", "reason": "잘못된 버튼"},
        {"type": "click_by_selector", "status": "ok", "selector": "button#send", "label": "전송", "reason": "질문을 전송합니다."},
    ]

    media_plan = _media_plan_for_outputs(request, {"steps": [], "actions": []}, action_log)

    narrations = [step["narration"] for step in media_plan["steps"]]
    assert narrations == [
        "질문에 st.form과 st.input의 차이를 알려줘 값을 입력합니다.",
        "질문 입력 화면을 확인합니다.",
        "질문을 전송합니다.",
    ]
    assert all("잘못된 버튼" not in narration for narration in narrations)
    assert sum(step["duration_seconds"] for step in media_plan["steps"]) == pytest.approx(90.0)


def test_subtitle_rerender_uses_caption_once_for_tts_narration(tmp_path: Path):
    subtitles = tmp_path / "subtitles.vtt"
    subtitles.write_text(
        "WEBVTT\n\n00:00:00.000 --> 00:00:05.000\n질문 입력\n질문 입력창에 예시 질문을 입력합니다.\n",
        encoding="utf-8",
    )

    media_plan = _media_plan_from_subtitles(subtitles, SimpleNamespace(plan={}))

    assert media_plan["steps"][0]["title"] == "질문 입력"
    assert media_plan["steps"][0]["caption"] == "질문 입력창에 예시 질문을 입력합니다."
    assert media_plan["steps"][0]["narration"] == "질문 입력창에 예시 질문을 입력합니다."


def test_render_quality_report_flags_audio_subtitle_and_duration_failures(tmp_path: Path, monkeypatch):
    from backend.app.adapters import video as video_module

    video_path = tmp_path / "manual_video_agent_usage.mp4"
    video_path.write_bytes(b"video")
    (tmp_path / "subtitles.vtt").write_text("WEBVTT\n", encoding="utf-8")
    monkeypatch.setattr(video_module, "_probe_media_duration_seconds", lambda path: 15.0)
    monkeypatch.setattr(video_module, "_probe_video_dimensions", lambda path: (1920, 1080))
    metadata = {
        "status": "completed",
        "audio": {
            "status": "failed",
            "input_count": 1,
            "mux_target_duration_seconds": 10.0,
            "subtitles_burned_in": False,
        },
    }

    quality = video_module._build_render_quality_report(video_path, metadata, tmp_path, enforced=True)

    assert quality["status"] == "failed"
    assert quality["enforced"] is True
    assert {issue["code"] for issue in quality["issues"]} == {
        "audio_mux_failed",
        "subtitles_not_burned_in",
        "duration_drift_exceeded",
    }


def test_render_quality_report_passes_valid_muxed_video(tmp_path: Path, monkeypatch):
    from backend.app.adapters import video as video_module

    video_path = tmp_path / "manual_video_agent_usage.mp4"
    video_path.write_bytes(b"video")
    (tmp_path / "subtitles.vtt").write_text("WEBVTT\n", encoding="utf-8")
    monkeypatch.setattr(video_module, "_probe_media_duration_seconds", lambda path: 10.0)
    monkeypatch.setattr(video_module, "_probe_video_dimensions", lambda path: (1920, 1080))
    metadata = {
        "status": "completed",
        "audio": {
            "status": "completed",
            "input_count": 1,
            "mux_target_duration_seconds": 10.0,
            "subtitles_burned_in": True,
        },
    }

    quality = video_module._build_render_quality_report(video_path, metadata, tmp_path, enforced=True)

    assert quality["status"] == "passed"
    assert quality["issues"] == []
    assert quality["video_duration_seconds"] == 10.0
    assert quality["video_width"] == 1920
    assert quality["video_height"] == 1080


def test_render_quality_rejects_portrait_video_for_desktop_manual(tmp_path: Path, monkeypatch):
    from backend.app.adapters import video as video_module

    video_path = tmp_path / "manual_video_agent_usage.mp4"
    video_path.write_bytes(b"video")
    monkeypatch.setattr(video_module, "_probe_media_duration_seconds", lambda path: 10.0)
    monkeypatch.setattr(video_module, "_probe_video_dimensions", lambda path: (1080, 1920))
    metadata = {
        "status": "completed",
        "audio": {"status": "skipped", "input_count": 0, "mux_target_duration_seconds": 10.0},
    }

    quality = video_module._build_render_quality_report(video_path, metadata, tmp_path, enforced=True)

    assert quality["status"] == "failed"
    assert "video_not_landscape" in {issue["code"] for issue in quality["issues"]}


def test_quality_first_hyperframes_command_forces_landscape_high_quality_png_frames(tmp_path: Path):
    from backend.app.adapters.video import render_final_video

    commands = []

    def fake_runner(command, **kwargs):
        commands.append(command)
        output_index = command.index("--output") + 1
        Path(command[output_index]).write_bytes(b"mp4")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    settings = load_settings(
        environ={
            "MANUAL_AGENT_VIDEO_RENDERER": "hyperframes",
            "MANUAL_AGENT_HYPERFRAMES_COMMAND": "hyperframes render",
            "MANUAL_AGENT_BROWSER_DECISION_POLICY": "quality_first",
        }
    )
    preview = tmp_path / "preview.html"
    preview.write_text("<html></html>", encoding="utf-8")
    fallback = tmp_path / "source.webm"
    fallback.write_bytes(b"webm")

    render_final_video(
        plan={"steps": [{"id": "s1", "title": "화면", "caption": "화면 확인"}]},
        package_dir=tmp_path,
        preview_html=preview,
        fallback_video=fallback,
        settings=settings,
        command_runner=fake_runner,
    )

    assert "--resolution=landscape" in commands[0]
    assert "--quality=high" in commands[0]
    assert "--video-frame-format=png" in commands[0]


def test_render_degrade_reason_prioritizes_enforced_quality_failure(tmp_path: Path):
    metadata_path = tmp_path / "video_render.json"
    metadata_path.write_text(
        json.dumps({"quality": {"status": "failed", "enforced": True, "issues": [{"code": "audio_mux_failed"}]}}),
        encoding="utf-8",
    )

    reason = _render_degrade_reason(False, "hyperframes", metadata_path)

    assert reason == "render_quality_failed"


def test_package_manifest_exposes_render_quality_summary(tmp_path: Path):
    result = run_pipeline(_request(), base_dir=tmp_path, capture_browser=False)

    manifest = json.loads(result.artifacts.package_manifest.read_text(encoding="utf-8"))

    assert manifest["render_quality"] == json.loads(result.artifacts.video_render_metadata.read_text(encoding="utf-8"))["quality"]
