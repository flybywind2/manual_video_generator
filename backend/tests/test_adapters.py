import json
import subprocess
import wave
import base64
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.app.adapters.browser_agent import decide_browser_agent_action
from backend.app.adapters.extension_bridge import ExtensionBridgeClient
from backend.app.adapters.input_extractor import extract_input_values
from backend.app.adapters.planner import build_plan, deterministic_plan
from backend.app.adapters.opencode import run_opencode_agent
from backend.app.adapters.rehearsal import rehearse_plan
from backend.app.adapters.skills import ensure_hyperframes_skills
from backend.app.adapters.tts import synthesize_tts
from backend.app.adapters.video import render_final_video
from backend.app.config import load_settings
from backend.app.pipeline import PipelineInput


def test_input_extractor_derives_values_from_request_text_without_llm(tmp_path: Path):
    request = PipelineInput(
        request_text="MES에서 LOT-001을 조회하고 라인 A3 조건으로 상세 화면 확인",
        target_url="http://127.0.0.1:8000/sample",
        role="작업자",
        completion_condition="상세 화면",
    )
    settings = load_settings(environ={})

    result = extract_input_values(request, settings, package_dir=tmp_path)

    assert result["status"] == "ok"
    assert result["source"] == "local-deterministic"
    assert result["extracted_input_values"]["LOT"] == "LOT-001"
    assert result["extracted_input_values"]["라인"] == "A3"
    assert result["effective_input_values"]["LOT"] == "LOT-001"
    assert (tmp_path / "input_extraction.json").exists()


def test_input_extractor_uses_llm_json_and_filters_sensitive_values(tmp_path: Path, capsys):
    request = PipelineInput(
        request_text="사용자 U100 권한 조회하고 OTP 123456은 쓰지 마",
        target_url="http://internal.example.local",
        role="관리자",
        completion_condition="권한 화면",
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_INPUT_EXTRACTOR": "true",
            "MANUAL_AGENT_OPENAI_API_KEY": "local-api-key",
            "MANUAL_AGENT_LLM_BASE_URL": "http://api.net:8000/v1",
            "MANUAL_AGENT_LLM_MODEL": "QWEN3",
            "MANUAL_AGENT_DEP_TICKET": "credential:TICKET-123",
            "MANUAL_AGENT_SEND_SYSTEM_NAME": "manual-video-agent",
            "MANUAL_AGENT_USER_ID": "USER01",
            "MANUAL_AGENT_USER_TYPE": "AD_ID",
            "MANUAL_AGENT_LLM_TIMEOUT_SECONDS": "180",
            "MANUAL_AGENT_ENABLE_TERMINAL_LOGS": "true",
        }
    )
    calls = []

    def fake_post(url, headers, payload, timeout_seconds):
        calls.append({"url": url, "headers": headers, "payload": payload, "timeout": timeout_seconds})
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {"input_values": {"사용자ID": "U100", "otp_code": "123456", "password": "plain"}},
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }

    result = extract_input_values(request, settings, package_dir=tmp_path, http_post=fake_post)

    assert result["status"] == "ok"
    assert result["source"] == "internal-llm"
    assert result["effective_input_values"] == {"사용자ID": "U100"}
    assert calls[0]["url"] == "http://api.net:8000/v1/chat/completions"
    assert calls[0]["headers"]["Accept"] == "application/json"
    assert calls[0]["timeout"] == 180
    rendered = (tmp_path / "input_extraction.json").read_text(encoding="utf-8")
    assert "123456" not in rendered
    assert "plain" not in rendered
    llm_log = tmp_path / "llm_responses.jsonl"
    assert llm_log.exists()
    llm_log_text = llm_log.read_text(encoding="utf-8")
    terminal_log_text = capsys.readouterr().err
    assert '"actor": "llm_response"' in terminal_log_text
    assert '"component": "input_extractor"' in terminal_log_text
    assert '"content_preview"' in terminal_log_text
    assert "123456" not in llm_log_text
    assert "plain" not in llm_log_text
    assert "123456" not in terminal_log_text
    assert "plain" not in terminal_log_text


def test_input_extractor_strict_mode_raises_llm_errors(tmp_path: Path):
    request = PipelineInput(
        request_text="사용자 U100 권한 조회",
        target_url="http://internal.example.local",
        role="관리자",
        completion_condition="권한 화면",
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_STRICT_MODE": "true",
            "MANUAL_AGENT_OPENAI_API_KEY": "local-api-key",
            "MANUAL_AGENT_LLM_BASE_URL": "http://api.net:8000/v1",
            "MANUAL_AGENT_LLM_MODEL": "QWEN3",
            "MANUAL_AGENT_DEP_TICKET": "credential:TICKET-123",
            "MANUAL_AGENT_SEND_SYSTEM_NAME": "manual-video-agent",
            "MANUAL_AGENT_USER_ID": "USER01",
            "MANUAL_AGENT_USER_TYPE": "AD_ID",
        }
    )

    def fail_post(url, headers, payload, timeout_seconds):
        raise RuntimeError("LLM timeout")

    with pytest.raises(RuntimeError, match="LLM timeout"):
        extract_input_values(request, settings, package_dir=tmp_path, http_post=fail_post)


def test_input_extractor_preserves_explicit_input_values_over_extracted(tmp_path: Path):
    request = PipelineInput(
        request_text="LOT-001 조회",
        target_url="http://127.0.0.1:8000/sample",
        role="작업자",
        completion_condition="상세 화면",
        input_values={"LOT": "MANUAL-999"},
    )
    settings = load_settings(environ={})

    result = extract_input_values(request, settings, package_dir=tmp_path)

    assert result["extracted_input_values"]["LOT"] == "LOT-001"
    assert result["effective_input_values"]["LOT"] == "MANUAL-999"
    assert result["explicit_input_keys"] == ["LOT"]
    assert result["scenario_brief"]["required_inputs"] == ["LOT"]


def test_input_extractor_augments_chatbot_request_with_safe_intents(tmp_path: Path):
    request = PipelineInput(
        request_text="사내 chatbot 서비스에 prompt 입력하고 결과 받는 영상",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변이 보이면 완료",
        input_values={"프롬프트": "st.form과 st.input 차이"},
    )
    settings = load_settings(environ={})

    result = extract_input_values(request, settings, package_dir=tmp_path)
    brief = result["scenario_brief"]

    assert brief["task_type"] == "chat_prompt"
    assert "프롬프트" in brief["required_inputs"]
    assert "전송" in brief["safe_click_intents"]


def test_input_extractor_adds_modal_close_intents_before_later_work(tmp_path: Path):
    request = PipelineInput(
        request_text="모달창 내용을 확인하고 닫은 다음 사내 화면을 조회",
        target_url="http://internal.example.local/app",
        role="사용자",
        completion_condition="모달이 닫히고 조회 화면",
    )
    settings = load_settings(environ={})

    result = extract_input_values(request, settings, package_dir=tmp_path)
    brief = result["scenario_brief"]

    assert "닫기" in brief["safe_click_intents"]
    assert "확인" in brief["safe_click_intents"]
    assert "모달창" in brief["autonomy_guidance"]


def test_browser_agent_decides_next_action_from_page_observation(tmp_path: Path, capsys):
    request = PipelineInput(
        request_text="MES에서 LOT 조회 후 상세 화면 확인 방법 영상 만들기",
        target_url="http://127.0.0.1:8000/sample",
        role="작업자",
        completion_condition="상세 화면이 보이면 완료",
        input_values={"LOT": "LOT-001"},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_OPENAI_API_KEY": "local-api-key",
            "MANUAL_AGENT_LLM_BASE_URL": "http://api.net:8000/v1",
            "MANUAL_AGENT_LLM_MODEL": "QWEN3",
            "MANUAL_AGENT_DEP_TICKET": "credential:TICKET-123",
            "MANUAL_AGENT_SEND_SYSTEM_NAME": "manual-video-agent",
            "MANUAL_AGENT_USER_ID": "USER01",
            "MANUAL_AGENT_USER_TYPE": "AD_ID",
            "MANUAL_AGENT_LLM_TIMEOUT_SECONDS": "180",
            "MANUAL_AGENT_ENABLE_TERMINAL_LOGS": "true",
        }
    )
    calls = []

    def fake_post(url, headers, payload, timeout_seconds):
        calls.append({"url": url, "headers": headers, "payload": payload, "timeout": timeout_seconds})
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "type": "fill_by_label",
                                "label": "LOT",
                                "value_key": "LOT",
                                "reason": "LOT 입력칸이 보입니다.",
                            },
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }

    action = decide_browser_agent_action(
        request,
        settings,
        observation={"url": request.target_url, "fields": [{"label": "LOT"}], "clickables": [{"text": "조회"}]},
        history=[],
        step_index=1,
        http_post=fake_post,
        package_dir=tmp_path,
    )

    assert action["status"] == "ok"
    assert action["type"] == "fill_by_label"
    assert action["label"] == "LOT"
    assert action["value"] == "LOT-001"
    assert action["source"] == "browser-agent-llm"
    assert calls[0]["url"] == "http://api.net:8000/v1/chat/completions"
    assert calls[0]["headers"]["Accept"] == "application/json"
    assert calls[0]["timeout"] == 180
    assert calls[0]["payload"]["messages"][1]["content"]
    log_text = capsys.readouterr().err
    assert '"actor": "llm_response"' in log_text
    assert '"component": "browser_agent"' in log_text
    assert "LOT 입력칸이 보입니다." in log_text
    assert "LOT 입력칸이 보입니다." in (tmp_path / "llm_responses.jsonl").read_text(encoding="utf-8")


def test_browser_agent_prompt_includes_augmented_brief_and_failure_history(tmp_path: Path):
    request = PipelineInput(
        request_text="사내 chatbot 서비스에 prompt 입력하고 결과 받는 영상",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변 표시",
        input_values={"프롬프트": "st.form과 st.input 차이"},
        agent_brief={
            "task_type": "chat_prompt",
            "safe_click_intents": ["전송", "Send"],
            "forbidden_click_intents": ["Web Search"],
            "success_criteria": ["답변 표시"],
        },
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_OPENAI_API_KEY": "local-api-key",
            "MANUAL_AGENT_LLM_BASE_URL": "http://api.net:8000/v1",
            "MANUAL_AGENT_LLM_MODEL": "QWEN3",
            "MANUAL_AGENT_DEP_TICKET": "credential:TICKET-123",
            "MANUAL_AGENT_SEND_SYSTEM_NAME": "manual-video-agent",
            "MANUAL_AGENT_USER_ID": "USER01",
            "MANUAL_AGENT_USER_TYPE": "AD_ID",
        }
    )
    calls = []

    def fake_post(url, headers, payload, timeout_seconds):
        calls.append(payload)
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {"type": "fill_by_label", "label": "질문", "reason": "질문 입력"},
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }

    action = decide_browser_agent_action(
        request,
        settings,
        observation={"fields": [{"label": "질문", "value": ""}], "clickables": [{"text": "전송"}]},
        history=[{"step": 1, "type": "click_by_text", "status": "failed", "reason": "missing target"}],
        step_index=2,
        http_post=fake_post,
        package_dir=tmp_path,
    )

    user_payload = json.loads(calls[0]["messages"][1]["content"])
    assert user_payload["agent_brief"]["task_type"] == "chat_prompt"
    assert user_payload["recent_failures"][0]["status"] == "failed"
    assert "Web Search" in user_payload["agent_brief"]["forbidden_click_intents"]
    assert action["type"] == "fill_by_label"
    assert action["label"] == "질문"
    assert action["value"] == "st.form과 st.input 차이"


def test_browser_agent_local_policy_fills_visible_field_without_llm():
    request = PipelineInput(
        request_text="사내 chatbot 서비스에 prompt 입력하고 결과 받는 영상",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변 표시",
        input_values={"프롬프트": "st.form과 st.input 차이"},
        agent_brief={
            "task_type": "chat_prompt",
            "safe_click_intents": ["전송", "Send", "Enter"],
            "forbidden_click_intents": ["Web Search"],
        },
    )
    settings = load_settings(environ={"MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true"})

    action = decide_browser_agent_action(
        request,
        settings,
        observation={"fields": [{"label": "질문", "value": ""}], "clickables": [{"text": "전송"}]},
        history=[],
        step_index=1,
    )

    assert action["status"] == "ok"
    assert action["source"] == "browser-agent-local"
    assert action["type"] == "fill_by_label"
    assert action["label"] == "질문"
    assert action["value"] == "st.form과 st.input 차이"


def test_browser_agent_local_policy_clicks_safe_send_after_fill_without_llm():
    request = PipelineInput(
        request_text="사내 chatbot 서비스에 prompt 입력하고 결과 받는 영상",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변 표시",
        input_values={"프롬프트": "st.form과 st.input 차이"},
        agent_brief={
            "task_type": "chat_prompt",
            "safe_click_intents": ["전송", "Send", "Enter"],
            "forbidden_click_intents": ["Web Search"],
        },
    )
    settings = load_settings(environ={"MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true"})

    action = decide_browser_agent_action(
        request,
        settings,
        observation={
            "fields": [{"label": "질문", "value": "st.form과 st.input 차이"}],
            "clickables": [{"text": "Web Search"}, {"text": "전송"}],
            "body_text": "사내 챗봇",
        },
        history=[{"step": 1, "type": "fill_by_label", "status": "ok"}],
        step_index=2,
    )

    assert action["status"] == "ok"
    assert action["source"] == "browser-agent-local"
    assert action["type"] == "click_by_text"
    assert action["texts"] == ["전송"]


def test_browser_agent_llm_error_falls_back_to_local_policy_when_not_strict():
    request = PipelineInput(
        request_text="MES에서 LOT 조회",
        target_url="http://internal.example.local/mes",
        role="사용자",
        completion_condition="조회 결과",
        input_values={"LOT": "LOT-001"},
        agent_brief={"task_type": "lookup", "safe_click_intents": ["조회", "검색"]},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_OPENAI_API_KEY": "local-api-key",
            "MANUAL_AGENT_LLM_BASE_URL": "http://api.net:8000/v1",
            "MANUAL_AGENT_LLM_MODEL": "QWEN3",
            "MANUAL_AGENT_DEP_TICKET": "credential:TICKET-123",
            "MANUAL_AGENT_SEND_SYSTEM_NAME": "manual-video-agent",
            "MANUAL_AGENT_USER_ID": "USER01",
            "MANUAL_AGENT_USER_TYPE": "AD_ID",
        }
    )

    def fail_post(url, headers, payload, timeout_seconds):
        raise RuntimeError("browser agent timeout")

    action = decide_browser_agent_action(
        request,
        settings,
        observation={"fields": [{"label": "LOT", "value": ""}], "clickables": [{"text": "조회"}]},
        history=[],
        step_index=1,
        http_post=fail_post,
    )

    assert action["status"] == "ok"
    assert action["source"] == "browser-agent-local-fallback"
    assert action["type"] == "fill_by_label"
    assert action["llm_error"] == "RuntimeError: browser agent timeout"


def test_browser_agent_blocks_dangerous_click_texts():
    request = PipelineInput(
        request_text="계정 조회",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="조회 결과",
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_OPENAI_API_KEY": "local-api-key",
            "MANUAL_AGENT_LLM_BASE_URL": "http://api.net:8000/v1",
            "MANUAL_AGENT_LLM_MODEL": "QWEN3",
            "MANUAL_AGENT_DEP_TICKET": "credential:TICKET-123",
            "MANUAL_AGENT_SEND_SYSTEM_NAME": "manual-video-agent",
            "MANUAL_AGENT_USER_ID": "USER01",
            "MANUAL_AGENT_USER_TYPE": "AD_ID",
            "MANUAL_AGENT_LLM_TIMEOUT_SECONDS": "180",
        }
    )

    def fake_post(url, headers, payload, timeout_seconds):
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps({"type": "click_by_text", "texts": ["삭제"], "reason": "삭제 버튼 클릭"})
                    }
                }
            ]
        }

    action = decide_browser_agent_action(
        request,
        settings,
        observation={"clickables": [{"text": "삭제"}]},
        history=[],
        step_index=1,
        http_post=fake_post,
    )

    assert action["status"] == "blocked"
    assert action["type"] == "finish"
    assert action["reason"] == "dangerous_click_text"


def test_browser_agent_blocks_web_search_toggle_clicks():
    request = PipelineInput(
        request_text="사내 chatbot 서비스에 프롬프트를 입력하고 응답 결과를 확인",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변이 보이면 완료",
        input_values={"프롬프트": "사내 휴가 규정을 요약해줘"},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_OPENAI_API_KEY": "local-api-key",
            "MANUAL_AGENT_LLM_BASE_URL": "http://api.net:8000/v1",
            "MANUAL_AGENT_LLM_MODEL": "QWEN3",
            "MANUAL_AGENT_DEP_TICKET": "credential:TICKET-123",
            "MANUAL_AGENT_SEND_SYSTEM_NAME": "manual-video-agent",
            "MANUAL_AGENT_USER_ID": "USER01",
            "MANUAL_AGENT_USER_TYPE": "AD_ID",
        }
    )

    def fake_post(url, headers, payload, timeout_seconds):
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {"type": "click_by_text", "texts": ["Web Search"], "reason": "웹 검색 토글을 켭니다."}
                        )
                    }
                }
            ]
        }

    action = decide_browser_agent_action(
        request,
        settings,
        observation={"clickables": [{"text": "Web Search"}, {"text": "전송"}]},
        history=[],
        step_index=2,
        http_post=fake_post,
    )

    assert action["status"] == "blocked"
    assert action["type"] == "finish"
    assert action["reason"] == "disallowed_click_text"
    assert action["texts"] == ["Web Search"]


def test_browser_agent_uses_last_json_object_when_model_self_corrects():
    request = PipelineInput(
        request_text="Genspark AI Chat에 질문 입력",
        target_url="https://www.genspark.ai/agents?type=ai_chat",
        role="사용자",
        completion_condition="답변 확인",
        input_values={"프롬프트": "st.form과 st.input 차이"},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_LLM_PROVIDER": "ollama",
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_LLM_BASE_URL": "http://127.0.0.1:11434/v1",
            "MANUAL_AGENT_LLM_MODEL": "gemma4:31b-cloud",
        }
    )

    def fake_post(url, headers, payload, timeout_seconds):
        return {
            "choices": [
                {
                    "message": {
                        "content": (
                            "```json\n"
                            "{\"type\":\"click_by_text\",\"texts\":[\"Enter\"],\"reason\":\"전송\"}\n"
                            "```\n"
                            "Correction: 버튼이 없으니 대기합니다.\n"
                            "```json\n"
                            "{\"type\":\"wait\",\"timeout_ms\":3000,\"reason\":\"답변 대기\"}\n"
                            "```"
                        )
                    }
                }
            ]
        }

    action = decide_browser_agent_action(
        request,
        settings,
        observation={"fields": [{"label": "무엇이든 물어보고 만들어보세요"}]},
        history=[],
        step_index=2,
        http_post=fake_post,
    )

    assert action["status"] == "ok"
    assert action["type"] == "wait"
    assert action["timeout_ms"] == 3000
    assert action["reason"] == "답변 대기"


def test_browser_agent_allows_enter_key_for_chat_submission():
    request = PipelineInput(
        request_text="Genspark AI Chat에 질문 입력 후 전송",
        target_url="https://www.genspark.ai/agents?type=ai_chat",
        role="사용자",
        completion_condition="답변 확인",
        input_values={"프롬프트": "st.form과 st.input 차이"},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_LLM_PROVIDER": "ollama",
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_LLM_BASE_URL": "http://127.0.0.1:11434/v1",
            "MANUAL_AGENT_LLM_MODEL": "gemma4:31b-cloud",
        }
    )

    def fake_post(url, headers, payload, timeout_seconds):
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {"type": "press_key", "key": "Enter", "reason": "채팅 질문을 전송합니다."},
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }

    action = decide_browser_agent_action(
        request,
        settings,
        observation={"fields": [{"label": "무엇이든 물어보고 만들어보세요", "value": "st.form과 st.input 차이"}]},
        history=[{"step": 1, "type": "fill_by_label", "status": "ok"}],
        step_index=2,
        http_post=fake_post,
    )

    assert action["status"] == "ok"
    assert action["type"] == "press_key"
    assert action["key"] == "Enter"


def test_browser_agent_stops_when_login_modal_blocks_target():
    request = PipelineInput(
        request_text="Genspark AI Chat에 질문 입력 후 답변 확인",
        target_url="https://www.genspark.ai/agents?type=ai_chat",
        role="사용자",
        completion_condition="답변 확인",
        input_values={"프롬프트": "st.form과 st.input 차이"},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_LLM_PROVIDER": "ollama",
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_LLM_BASE_URL": "http://127.0.0.1:11434/v1",
            "MANUAL_AGENT_LLM_MODEL": "gemma4:31b-cloud",
        }
    )

    def fail_post(url, headers, payload, timeout_seconds):
        raise AssertionError("login blocker should be handled before calling LLM")

    action = decide_browser_agent_action(
        request,
        settings,
        observation={"body_text": "로그인 또는 회원가입 Google로 계속하기 Apple로 계속하기"},
        history=[],
        step_index=3,
        http_post=fail_post,
    )

    assert action["status"] == "blocked"
    assert action["type"] == "finish"
    assert action["reason"] == "login_required"


def test_browser_agent_waits_on_sso_profile_auth_interstitial_instead_of_finishing():
    request = PipelineInput(
        request_text="사내 시스템에서 챗봇에 질문 입력 후 답변 확인",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변 확인",
        input_values={"프롬프트": "st.form과 st.input 차이"},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_LOGIN_MODE": "sso_profile",
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_OPENAI_API_KEY": "local-api-key",
            "MANUAL_AGENT_LLM_BASE_URL": "http://api.net:8000/v1",
            "MANUAL_AGENT_LLM_MODEL": "QWEN3",
            "MANUAL_AGENT_USER_DATA_DIR": "C:\\AppBundle\\manualgen\\browser-profile",
        }
    )

    def fail_post(url, headers, payload, timeout_seconds):
        raise AssertionError("SSO auth interstitial should be waited without asking the LLM to finish")

    action = decide_browser_agent_action(
        request,
        settings,
        observation={
            "url": "https://adfs.corp.local/adfs/ls/SAMLRequest=...",
            "title": "Corporate SSO",
            "body_text": "SAML 인증을 진행 중입니다. Login Password Windows Authentication Redirecting",
            "fields": [{"label": "Password", "type": "password", "value": "<redacted>"}],
            "clickables": [],
        },
        history=[],
        step_index=2,
        http_post=fail_post,
    )

    assert action["status"] == "ok"
    assert action["type"] == "wait"
    assert action["timeout_ms"] >= 1000
    assert action["reason"] == "sso_auth_redirect_wait"


def test_browser_agent_does_not_wait_on_app_home_with_auth_words_after_sso():
    request = PipelineInput(
        request_text="사내 시스템 홈에서 공지 확인",
        target_url="http://internal.example.local/home",
        role="사용자",
        completion_condition="홈 화면 확인",
        input_values={},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_LOGIN_MODE": "sso_profile",
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
        }
    )

    action = decide_browser_agent_action(
        request,
        settings,
        observation={
            "url": "http://internal.example.local/home",
            "title": "사내 시스템 홈",
            "body_text": "홈 대시보드 권한 인증 관리 사용자 메뉴 공지사항",
            "headings": ["홈"],
            "fields": [],
            "clickables": [{"text": "공지사항"}, {"text": "사용자 인증 관리"}],
        },
        history=[],
        step_index=2,
        http_post=lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("LLM should not be required")),
    )

    assert action["reason"] != "sso_auth_redirect_wait"


def test_browser_agent_accepts_explicit_click_by_selector_from_llm():
    request = PipelineInput(
        request_text="화면의 .icon-plus-bold 클래스를 click_by_selector로 클릭",
        target_url="http://internal.example.local/home",
        role="사용자",
        completion_condition="추가 창 확인",
        input_values={},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_LLM_PROVIDER": "openai",
            "MANUAL_AGENT_OPENAI_API_KEY": "local-api-key",
            "MANUAL_AGENT_LLM_BASE_URL": "http://api.net:8000/v1",
            "MANUAL_AGENT_LLM_MODEL": "QWEN3",
        }
    )

    def fake_post(url, headers, payload, timeout_seconds):
        assert "click_by_selector" in payload["messages"][0]["content"]
        assert "selector" in payload["messages"][1]["content"]
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {"type": "click_by_selector", "selector": ".icon-plus-bold", "reason": "사용자가 class selector 클릭을 지시함"},
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }

    action = decide_browser_agent_action(
        request,
        settings,
        observation={
            "url": request.target_url,
            "body_text": "홈",
            "fields": [],
            "clickables": [{"text": "+ 추가 plus add", "selector": ".icon-plus-bold"}],
        },
        history=[],
        step_index=1,
        http_post=fake_post,
    )

    assert action["type"] == "click_by_selector"
    assert action["selector"] == ".icon-plus-bold"


def test_extension_bridge_client_uses_observe_act_verify_contract():
    calls = []

    def fake_post(url, headers, payload, timeout_seconds):
        calls.append({"url": url, "headers": headers, "payload": payload, "timeout": timeout_seconds})
        if url.endswith("/observe"):
            return {"status": "ok", "observation": {"url": "https://internal.local", "fields": []}}
        if url.endswith("/act"):
            return {"status": "ok", "result": {"status": "ok", "method": "extension.click"}}
        if url.endswith("/verify"):
            return {"status": "ok", "verification": {"status": "ok", "changed": True}}
        raise AssertionError(url)

    client = ExtensionBridgeClient(
        endpoint="http://127.0.0.1:8765/",
        token="local-token",
        timeout_seconds=5,
        http_post=fake_post,
    )

    observation = client.observe()
    act_result = client.act({"type": "click_by_text", "texts": ["조회"]})
    verification = client.verify({"type": "click_by_text", "texts": ["조회"]}, act_result)

    assert observation["url"] == "https://internal.local"
    assert act_result["method"] == "extension.click"
    assert verification["status"] == "ok"
    assert [call["url"] for call in calls] == [
        "http://127.0.0.1:8765/observe",
        "http://127.0.0.1:8765/act",
        "http://127.0.0.1:8765/verify",
    ]
    assert all(call["headers"]["Authorization"] == "Bearer local-token" for call in calls)


def test_internal_planner_uses_llm_json_when_enabled(tmp_path: Path, capsys):
    request = PipelineInput(
        request_text="MES에서 LOT 조회 방법 영상 만들기",
        target_url="http://127.0.0.1:8000/sample",
        role="작업자",
        completion_condition="상세 화면이 보이면 완료",
        input_values={"LOT": "LOT-001"},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_INTERNAL_PLANNER": "true",
            "MANUAL_AGENT_OPENAI_API_KEY": "local-api-key",
            "MANUAL_AGENT_LLM_BASE_URL": "http://api.net:8000/v1",
            "MANUAL_AGENT_LLM_MODEL": "QWEN3",
            "MANUAL_AGENT_DEP_TICKET": "credential:TICKET-123",
            "MANUAL_AGENT_SEND_SYSTEM_NAME": "manual-video-agent",
            "MANUAL_AGENT_USER_ID": "USER01",
            "MANUAL_AGENT_USER_TYPE": "AD_ID",
            "MANUAL_AGENT_ENABLE_TERMINAL_LOGS": "true",
        }
    )
    calls = []

    def fake_post(url, headers, payload, timeout_seconds):
        calls.append({"url": url, "headers": headers, "payload": payload, "timeout": timeout_seconds})
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "steps": [
                                    {
                                        "id": "step_custom",
                                        "title": "LLM 생성 단계",
                                        "caption": "LLM이 생성한 설명입니다.",
                                        "narration": "LLM이 생성한 내레이션입니다.",
                                    }
                                ],
                                "actions": [
                                    {
                                        "id": "a1",
                                        "type": "navigate",
                                        "target": "http://127.0.0.1:8000/sample",
                                        "step_id": "step_custom",
                                    }
                                ],
                            },
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }

    plan = build_plan(request, settings, package_dir=tmp_path, http_post=fake_post)

    assert plan["source"] == "internal-llm-planner"
    assert plan["steps"][0]["title"] == "LLM 생성 단계"
    assert plan["actions"][0]["type"] == "navigate"
    assert calls[0]["url"] == "http://api.net:8000/v1/chat/completions"
    assert calls[0]["payload"]["model"] == "QWEN3"
    assert "Authorization" in calls[0]["headers"]
    assert calls[0]["headers"]["Accept"] == "application/json"
    assert calls[0]["timeout"] == 180
    trace = json.loads((tmp_path / "planner_trace.json").read_text(encoding="utf-8"))
    assert trace["rag"] == {"status": "skipped"}
    assert trace["reranker"] == {"status": "skipped", "reason": "rag_context_skipped"}
    llm_log = tmp_path / "llm_responses.jsonl"
    assert llm_log.exists()
    llm_log_text = llm_log.read_text(encoding="utf-8")
    terminal_log_text = capsys.readouterr().err
    assert '"actor": "llm_response"' in terminal_log_text
    assert '"component": "planner"' in terminal_log_text


def test_internal_planner_prompt_receives_agent_brief(tmp_path: Path):
    request = PipelineInput(
        request_text="사내 chatbot에 질문 입력",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변 표시",
        input_values={"프롬프트": "st.form과 st.input 차이"},
        agent_brief={
            "task_type": "chat_prompt",
            "safe_click_intents": ["전송"],
            "forbidden_click_intents": ["Web Search"],
        },
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_INTERNAL_PLANNER": "true",
            "MANUAL_AGENT_OPENAI_API_KEY": "local-api-key",
            "MANUAL_AGENT_LLM_BASE_URL": "http://api.net:8000/v1",
            "MANUAL_AGENT_LLM_MODEL": "QWEN3",
            "MANUAL_AGENT_DEP_TICKET": "credential:TICKET-123",
            "MANUAL_AGENT_SEND_SYSTEM_NAME": "manual-video-agent",
            "MANUAL_AGENT_USER_ID": "USER01",
            "MANUAL_AGENT_USER_TYPE": "AD_ID",
        }
    )
    calls = []

    def fake_post(url, headers, payload, timeout_seconds):
        calls.append(payload)
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "steps": [{"id": "step_chat", "title": "질문", "caption": "질문", "narration": "질문"}],
                                "actions": [
                                    {"id": "a1", "type": "navigate", "target": request.target_url, "step_id": "step_chat"}
                                ],
                            },
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }

    build_plan(request, settings, package_dir=tmp_path, http_post=fake_post)
    prompt_payload = json.loads(calls[0]["messages"][1]["content"])

    assert prompt_payload["agent_brief"]["task_type"] == "chat_prompt"
    assert "Web Search" in prompt_payload["agent_brief"]["forbidden_click_intents"]


def test_internal_planner_calls_ollama_openai_endpoint_without_internal_headers(tmp_path: Path):
    request = PipelineInput(
        request_text="Genspark AI Chat에서 질문 입력 후 답변 확인",
        target_url="https://www.genspark.ai/agents?type=ai_chat",
        role="사용자",
        completion_condition="답변이 보이면 완료",
        input_values={"프롬프트": "st.form과 st.input의 입력 차이점을 알려줘"},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_LLM_PROVIDER": "ollama",
            "MANUAL_AGENT_ENABLE_INTERNAL_PLANNER": "true",
            "MANUAL_AGENT_LLM_BASE_URL": "http://127.0.0.1:11434/v1",
            "MANUAL_AGENT_LLM_MODEL": "gemma4:31b-cloud",
            "MANUAL_AGENT_LLM_TIMEOUT_SECONDS": "300",
        }
    )
    calls = []

    def fake_post(url, headers, payload, timeout_seconds):
        calls.append({"url": url, "headers": headers, "payload": payload, "timeout": timeout_seconds})
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "steps": [{"id": "step_ask", "title": "질문 입력", "caption": "질문을 입력합니다.", "narration": "질문을 입력합니다."}],
                                "actions": [{"id": "a1", "type": "capture_step", "step_id": "step_ask"}],
                            },
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }

    plan = build_plan(request, settings, package_dir=tmp_path, http_post=fake_post)

    assert plan["source"] == "ollama-llm-planner"
    assert calls[0]["url"] == "http://127.0.0.1:11434/v1/chat/completions"
    assert calls[0]["payload"]["model"] == "gemma4:31b-cloud"
    assert calls[0]["headers"] == {"Content-Type": "application/json", "Accept": "application/json"}
    assert calls[0]["timeout"] == 300


def test_internal_planner_replaces_web_search_toggle_click_with_capture_step(tmp_path: Path):
    request = PipelineInput(
        request_text="사내 chatbot 서비스에 프롬프트를 입력하고 응답 결과를 확인",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변이 보이면 완료",
        input_values={"프롬프트": "사내 휴가 규정을 요약해줘"},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_INTERNAL_PLANNER": "true",
            "MANUAL_AGENT_OPENAI_API_KEY": "local-api-key",
            "MANUAL_AGENT_LLM_BASE_URL": "http://api.net:8000/v1",
            "MANUAL_AGENT_LLM_MODEL": "QWEN3",
            "MANUAL_AGENT_DEP_TICKET": "credential:TICKET-123",
            "MANUAL_AGENT_SEND_SYSTEM_NAME": "manual-video-agent",
            "MANUAL_AGENT_USER_ID": "USER01",
            "MANUAL_AGENT_USER_TYPE": "AD_ID",
        }
    )

    def fake_post(url, headers, payload, timeout_seconds):
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "steps": [{"id": "step_chat", "title": "챗봇 실행", "caption": "챗봇", "narration": "챗봇"}],
                                "actions": [
                                    {"id": "a1", "type": "navigate", "target": request.target_url, "step_id": "step_chat"},
                                    {"id": "a2", "type": "click_by_text", "texts": ["Web Search"], "step_id": "step_chat"},
                                    {
                                        "id": "a3",
                                        "type": "fill_by_label",
                                        "label": "프롬프트",
                                        "value": "사내 휴가 규정을 요약해줘",
                                        "step_id": "step_chat",
                                    },
                                ],
                            },
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }

    plan = build_plan(request, settings, package_dir=tmp_path, http_post=fake_post)

    assert not any(action.get("type") == "click_by_text" and action.get("texts") == ["Web Search"] for action in plan["actions"])
    assert any(
        action.get("type") == "capture_step" and action.get("reason") == "blocked_disallowed_click_text"
        for action in plan["actions"]
    )


def test_internal_planner_falls_back_and_records_trace_when_llm_response_is_invalid(tmp_path: Path):
    request = PipelineInput(
        request_text="MES에서 LOT 조회 방법 영상 만들기",
        target_url="http://127.0.0.1:8000/sample",
        role="작업자",
        completion_condition="상세 화면이 보이면 완료",
        input_values={"LOT": "LOT-001"},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_INTERNAL_PLANNER": "true",
            "MANUAL_AGENT_OPENAI_API_KEY": "local-api-key",
            "MANUAL_AGENT_LLM_BASE_URL": "http://api.net:8000/v1",
            "MANUAL_AGENT_LLM_MODEL": "QWEN3",
            "MANUAL_AGENT_DEP_TICKET": "credential:TICKET-123",
            "MANUAL_AGENT_SEND_SYSTEM_NAME": "manual-video-agent",
            "MANUAL_AGENT_USER_ID": "USER01",
            "MANUAL_AGENT_USER_TYPE": "AD_ID",
        }
    )

    def fake_post(url, headers, payload, timeout_seconds):
        return {"choices": [{"message": {"content": "not-json"}}]}

    plan = build_plan(request, settings, package_dir=tmp_path, http_post=fake_post)

    assert plan["source"] == "local-deterministic-planner-fallback"
    assert plan["planner_error"].startswith("JSONDecodeError:")
    trace = json.loads((tmp_path / "planner_trace.json").read_text(encoding="utf-8"))
    assert trace["planner"] == "internal-llm"
    assert trace["error"] == plan["planner_error"]


def test_internal_planner_strict_mode_raises_llm_errors(tmp_path: Path):
    request = PipelineInput(
        request_text="MES에서 LOT 조회 방법 영상 만들기",
        target_url="http://127.0.0.1:8000/sample",
        role="작업자",
        completion_condition="상세 화면",
        input_values={"LOT": "LOT-001"},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_STRICT_MODE": "true",
            "MANUAL_AGENT_ENABLE_INTERNAL_PLANNER": "true",
            "MANUAL_AGENT_OPENAI_API_KEY": "local-api-key",
            "MANUAL_AGENT_LLM_BASE_URL": "http://api.net:8000/v1",
            "MANUAL_AGENT_LLM_MODEL": "QWEN3",
            "MANUAL_AGENT_DEP_TICKET": "credential:TICKET-123",
            "MANUAL_AGENT_SEND_SYSTEM_NAME": "manual-video-agent",
            "MANUAL_AGENT_USER_ID": "USER01",
            "MANUAL_AGENT_USER_TYPE": "AD_ID",
        }
    )

    def fail_post(url, headers, payload, timeout_seconds):
        raise RuntimeError("planner timeout")

    with pytest.raises(RuntimeError, match="planner timeout"):
        build_plan(request, settings, package_dir=tmp_path, http_post=fail_post)


def test_deterministic_planner_does_not_emit_mes_sample_selectors():
    request = PipelineInput(
        request_text="사내 포털에서 권한 신청 방법 영상 만들기",
        target_url="http://internal.example.local/portal",
        role="신청자",
        completion_condition="신청 완료 화면이 보이면 완료",
        input_values={"사용자ID": "U100", "부서": "AI센터"},
    )

    plan = deterministic_plan(request, config_status={})

    rendered = json.dumps(plan, ensure_ascii=False)
    assert "[name='lot']" not in rendered
    assert "[data-action='search']" not in rendered
    assert "[data-action='detail']" not in rendered
    assert "LOT" not in rendered
    assert plan["actions"][0] == {"id": "a1", "type": "navigate", "target": request.target_url, "step_id": "step_intro"}
    assert any(action["type"] == "capture_step" for action in plan["actions"])


def test_deterministic_planner_emits_semantic_actions_from_request_and_inputs():
    request = PipelineInput(
        request_text="MES에서 LOT 조회 후 상세 화면 확인 방법 영상 만들기",
        target_url="http://127.0.0.1:8000/sample",
        role="작업자",
        completion_condition="상세 화면이 보이면 완료",
        input_values={"LOT": "LOT-001"},
    )

    plan = deterministic_plan(request, config_status={})

    actions = plan["actions"]
    rendered = json.dumps(actions, ensure_ascii=False)
    assert "[name='lot']" not in rendered
    assert "[data-action='search']" not in rendered
    assert any(
        action["type"] == "fill_by_label"
        and action["label"] == "LOT"
        and action["value"] == "LOT-001"
        and action["step_id"] == "step_inputs"
        for action in actions
    )
    assert any(action["type"] == "click_by_text" and "조회" in action["texts"] for action in actions)
    assert any(action["type"] == "click_by_text" and "상세 보기" in action["texts"] for action in actions)
    assert sum(1 for action in actions if action["type"] == "capture_step") >= 3


def test_melotts_provider_falls_back_to_silent_wav_when_library_is_missing(tmp_path: Path):
    settings = load_settings(environ={"MANUAL_AGENT_TTS_PROVIDER": "melotts"})
    plan = {
        "steps": [
            {
                "id": "step_intro",
                "title": "요청 확인",
                "caption": "요청을 확인합니다.",
                "narration": "요청을 확인합니다.",
            }
        ]
    }

    result = synthesize_tts(plan, settings, tmp_path)

    assert result.audio_paths[0].exists()
    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert metadata["status"] == "completed"
    assert metadata["entries"][0]["provider"] in {"melotts", "silent-fallback"}
    assert metadata["entries"][0]["text"] == "요청을 확인합니다."


def test_supertonic_provider_uses_preset_voice_and_writes_license_metadata(tmp_path: Path, monkeypatch):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_TTS_PROVIDER": "supertonic",
            "MANUAL_AGENT_SUPERTONIC_VOICE": "F1",
            "MANUAL_AGENT_SUPERTONIC_LANG": "ko",
            "MANUAL_AGENT_SUPERTONIC_AUTO_DOWNLOAD": "false",
        }
    )
    plan = {
        "steps": [
            {
                "id": "step_intro",
                "title": "요청 확인",
                "caption": "요청을 확인합니다.",
                "narration": "요청을 확인합니다.",
            }
        ]
    }
    calls = []

    monkeypatch.setenv("SUPERTONIC_CACHE_DIR", str(tmp_path / "supertonic3"))
    monkeypatch.setenv("HF_HOME", str(tmp_path / "hf-cache"))

    class FakeSupertonicTts:
        def __init__(self, **kwargs):
            calls.append(("init", kwargs))

        def get_voice_style(self, *, voice_name):
            calls.append(("style", voice_name))
            return {"preset": voice_name}

        def synthesize(self, text, *, voice_style, lang):
            calls.append(("synthesize", text, voice_style, lang))
            return [0.0, 0.1], 1.23

        def save_audio(self, wav, path):
            calls.append(("save", wav, path))
            Path(path).write_bytes(b"RIFFsupertonic")

    class FakeSupertonicModule:
        TTS = FakeSupertonicTts

    monkeypatch.setattr("backend.app.adapters.tts.importlib.import_module", lambda name: FakeSupertonicModule)

    result = synthesize_tts(plan, settings, tmp_path)

    assert result.audio_paths[0].read_bytes() == b"RIFFsupertonic"
    assert calls[:3] == [
        ("init", {"auto_download": False, "model_dir": str(tmp_path / "supertonic3")}),
        ("style", "F1"),
        ("synthesize", "요청을 확인합니다.", {"preset": "F1"}, "ko"),
    ]
    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert metadata["requested_provider"] == "supertonic"
    assert metadata["license"]["model"] == "Supertone/supertonic-3"
    assert metadata["license"]["license"] == "BigScience Open RAIL-M License"
    assert metadata["voice_policy"]["custom_voice_allowed"] is False
    assert metadata["voice_policy"]["allowed_voice_source"] == "preset"
    assert "AI 음성 합성" in metadata["ai_voice_disclosure"]
    assert metadata["entries"][0]["provider"] == "supertonic"
    assert metadata["entries"][0]["speaker"] == "F1"
    assert metadata["entries"][0]["language"] == "ko"
    assert metadata["entries"][0]["voice_source"] == "preset"
    assert metadata["runtime"]["supertonic_cache_dir"] == str(tmp_path / "supertonic3")
    assert metadata["runtime"]["hf_home"] == str(tmp_path / "hf-cache")


def test_hyperframes_render_creates_composition_and_keeps_fallback_video(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_VIDEO_RENDERER": "hyperframes",
            "MANUAL_AGENT_HYPERFRAMES_COMMAND": "missing-hyperframes-command",
        }
    )
    preview = tmp_path / "preview.html"
    preview.write_text("<html><body>preview</body></html>", encoding="utf-8")
    fallback_video = tmp_path / "manual_video_agent_usage.webm"
    fallback_video.write_bytes(b"webm")
    plan = {
        "steps": [
            {
                "id": "step_intro",
                "title": "요청 확인",
                "caption": "요청을 확인합니다.",
                "narration": "요청을 확인합니다.",
            }
        ]
    }

    result = render_final_video(
        plan=plan,
        package_dir=tmp_path,
        preview_html=preview,
        fallback_video=fallback_video,
        settings=settings,
        command_runner=lambda *args, **kwargs: (_ for _ in ()).throw(FileNotFoundError("missing")),
    )

    assert result.video_path == fallback_video
    assert result.composition_dir.joinpath("index.html").exists()
    html = result.composition_dir.joinpath("index.html").read_text(encoding="utf-8")
    assert "../manual_video_agent_usage.webm" in html
    assert "manual-source-video" in html
    assert "manual-video-pointer" in html
    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert metadata["renderer"] == "hyperframes"
    assert metadata["fallback_video"] == str(fallback_video)
    assert metadata["used_fallback"] is True


def test_hyperframes_render_uses_mp4_when_command_produces_output(tmp_path: Path, monkeypatch):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_VIDEO_RENDERER": "hyperframes",
            "MANUAL_AGENT_HYPERFRAMES_COMMAND": "hyperframes render",
        }
    )
    preview = tmp_path / "preview.html"
    preview.write_text("<html><body>preview</body></html>", encoding="utf-8")
    fallback_video = tmp_path / "manual_video_agent_usage.webm"
    fallback_video.write_bytes(b"webm")
    plan = {
        "steps": [
            {
                "id": "step_intro",
                "title": "요청 확인",
                "caption": "요청을 확인합니다.",
                "narration": "요청을 확인합니다.",
            }
        ]
    }
    monkeypatch.setattr(
        "backend.app.adapters.video.shutil.which",
        lambda command: r"C:\tools\ffmpeg.exe" if command == "ffmpeg" else None,
    )

    def fake_runner(args, **kwargs):
        assert args[2] == str(tmp_path / "hyperframes")
        assert not args[2].endswith("index.html")
        output_path = Path(args[args.index("--output") + 1])
        output_path.write_bytes(b"mp4")
        return subprocess.CompletedProcess(args=args, returncode=0, stdout="rendered", stderr="")

    result = render_final_video(
        plan=plan,
        package_dir=tmp_path,
        preview_html=preview,
        fallback_video=fallback_video,
        settings=settings,
        command_runner=fake_runner,
    )

    assert result.video_path.name == "manual_video_agent_usage.mp4"
    assert result.used_fallback is False
    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert metadata["status"] == "completed"
    assert metadata["video"] == str(result.video_path)


def test_hyperframes_render_muxes_tts_audio_into_final_video(tmp_path: Path, monkeypatch):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_VIDEO_RENDERER": "hyperframes",
            "MANUAL_AGENT_HYPERFRAMES_COMMAND": "hyperframes render",
        }
    )
    preview = tmp_path / "preview.html"
    preview.write_text("<html><body>preview</body></html>", encoding="utf-8")
    fallback_video = tmp_path / "manual_video_agent_usage.webm"
    fallback_video.write_bytes(b"webm")
    audio_1 = tmp_path / "tts" / "01_intro.wav"
    audio_2 = tmp_path / "tts" / "02_search.wav"
    audio_1.parent.mkdir()
    audio_1.write_bytes(b"RIFFaudio1")
    audio_2.write_bytes(b"RIFFaudio2")
    plan = {"steps": [{"id": "step_intro", "title": "요청 확인", "caption": "요청을 확인합니다."}]}
    commands = []
    monkeypatch.setattr(
        "backend.app.adapters.video.shutil.which",
        lambda command: r"C:\tools\ffmpeg.exe" if command == "ffmpeg" else None,
    )

    def fake_runner(args, **kwargs):
        commands.append(args)
        if "--output" in args:
            Path(args[args.index("--output") + 1]).write_bytes(b"mp4-without-audio")
            return subprocess.CompletedProcess(args=args, returncode=0, stdout="rendered", stderr="")
        output_path = Path(args[-1])
        output_path.write_bytes(b"muxed")
        return subprocess.CompletedProcess(args=args, returncode=0, stdout="ffmpeg ok", stderr="")

    result = render_final_video(
        plan=plan,
        package_dir=tmp_path,
        preview_html=preview,
        fallback_video=fallback_video,
        settings=settings,
        tts_audio=[audio_1, audio_2],
        command_runner=fake_runner,
    )

    assert result.video_path.name == "manual_video_agent_usage.mp4"
    assert result.video_path.read_bytes() == b"muxed"
    assert any("-f" in command and "concat" in command for command in commands)
    assert any("-map" in command and "1:a:0" in command for command in commands)
    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert metadata["audio"]["status"] == "completed"
    assert metadata["audio"]["input_count"] == 2
    assert metadata["audio"]["video"] == str(result.video_path)


def test_hyperframes_composition_duration_tracks_tts_audio(tmp_path: Path):
    def write_wav(path: Path, duration_seconds: float):
        frame_rate = 8000
        frame_count = int(frame_rate * duration_seconds)
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(frame_rate)
            handle.writeframes(b"\x00\x00" * frame_count)

    settings = load_settings(
        environ={
            "MANUAL_AGENT_VIDEO_RENDERER": "hyperframes",
            "MANUAL_AGENT_HYPERFRAMES_COMMAND": "missing-hyperframes-command",
        }
    )
    preview = tmp_path / "preview.html"
    preview.write_text("<html><body>preview</body></html>", encoding="utf-8")
    fallback_video = tmp_path / "manual_video_agent_usage.webm"
    fallback_video.write_bytes(b"webm")
    audio_1 = tmp_path / "tts" / "01_intro.wav"
    audio_2 = tmp_path / "tts" / "02_search.wav"
    write_wav(audio_1, 1.25)
    write_wav(audio_2, 2.75)
    plan = {"steps": [{"id": "step_intro", "title": "요청 확인"}, {"id": "step_search", "title": "조회"}]}

    render_final_video(
        plan=plan,
        package_dir=tmp_path,
        preview_html=preview,
        fallback_video=fallback_video,
        settings=settings,
        tts_audio=[audio_1, audio_2],
        command_runner=lambda *args, **kwargs: (_ for _ in ()).throw(FileNotFoundError("missing")),
    )

    html = (tmp_path / "hyperframes" / "index.html").read_text(encoding="utf-8")
    manifest = json.loads((tmp_path / "hyperframes" / "hyperframes_manifest.json").read_text(encoding="utf-8"))

    assert 'data-duration="4.000"' in html
    assert manifest["duration_seconds"] == 4.0
    assert manifest["duration_source"] == "tts_audio"
    assert manifest["captions"][0]["start"] == 0.0
    assert manifest["captions"][0]["end"] == 1.25
    assert manifest["captions"][1]["start"] == 1.25
    assert manifest["captions"][1]["end"] == 4.0


def test_hyperframes_composition_burns_visible_step_captions(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_VIDEO_RENDERER": "hyperframes",
            "MANUAL_AGENT_HYPERFRAMES_COMMAND": "missing-hyperframes-command",
        }
    )
    preview = tmp_path / "preview.html"
    preview.write_text("<html><body>preview</body></html>", encoding="utf-8")
    fallback_video = tmp_path / "manual_video_agent_usage.webm"
    fallback_video.write_bytes(b"webm")
    plan = {
        "steps": [
            {"id": "demo_start", "title": "시작", "caption": "시연을 시작합니다."},
            {"id": "demo_01_input", "title": "질문 입력", "caption": "질문에 값을 입력합니다."},
            {"id": "demo_02_click", "title": "전송 클릭", "caption": "전송 버튼을 클릭합니다."},
        ]
    }

    render_final_video(
        plan=plan,
        package_dir=tmp_path,
        preview_html=preview,
        fallback_video=fallback_video,
        settings=settings,
        command_runner=lambda *args, **kwargs: (_ for _ in ()).throw(FileNotFoundError("missing")),
    )

    html = (tmp_path / "hyperframes" / "index.html").read_text(encoding="utf-8")
    manifest = json.loads((tmp_path / "hyperframes" / "hyperframes_manifest.json").read_text(encoding="utf-8"))

    assert "manual-video-caption" in html
    assert "updateManualVideoCaption" in html
    assert "질문에 값을 입력합니다." in html
    assert "전송 버튼을 클릭합니다." in html
    assert manifest["captions"][1]["caption"] == "질문에 값을 입력합니다."


def test_hyperframes_render_reports_missing_ffmpeg(tmp_path: Path, monkeypatch):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_VIDEO_RENDERER": "hyperframes",
            "MANUAL_AGENT_HYPERFRAMES_COMMAND": "hyperframes render",
        }
    )
    preview = tmp_path / "preview.html"
    preview.write_text("<html><body>preview</body></html>", encoding="utf-8")
    fallback_video = tmp_path / "manual_video_agent_usage.webm"
    fallback_video.write_bytes(b"webm")
    plan = {"steps": [{"id": "step_intro", "title": "요청 확인", "caption": "요청을 확인합니다."}]}
    monkeypatch.setattr(
        "backend.app.adapters.video.shutil.which",
        lambda command: None if command == "ffmpeg" else f"C:\\tools\\{command}.exe",
    )

    def fail_runner(*args, **kwargs):
        raise AssertionError("HyperFrames CLI should not run when ffmpeg is missing")

    result = render_final_video(
        plan=plan,
        package_dir=tmp_path,
        preview_html=preview,
        fallback_video=fallback_video,
        settings=settings,
        command_runner=fail_runner,
    )

    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert result.used_fallback is True
    assert metadata["status"] == "failed"
    assert metadata["reason"] == "ffmpeg not found"
    assert metadata["ffmpeg_path"] == ""


def test_hyperframes_render_uses_shell_for_windows_cmd_launchers(monkeypatch, tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_VIDEO_RENDERER": "hyperframes",
            "MANUAL_AGENT_HYPERFRAMES_COMMAND": "npx --yes hyperframes render",
        }
    )
    preview = tmp_path / "preview.html"
    preview.write_text("<html><body>preview</body></html>", encoding="utf-8")
    fallback_video = tmp_path / "manual_video_agent_usage.webm"
    fallback_video.write_bytes(b"webm")
    plan = {"steps": [{"id": "step_intro", "title": "요청 확인", "caption": "요청을 확인합니다."}]}
    monkeypatch.setattr(
        "backend.app.adapters.video.shutil.which",
        lambda command: (
            r"C:\Program Files\nodejs\npx.CMD"
            if command == "npx"
            else r"C:\tools\ffmpeg.exe"
            if command == "ffmpeg"
            else None
        ),
    )

    def fake_runner(args, **kwargs):
        assert kwargs["shell"] is True
        assert isinstance(args, str)
        assert "npx.CMD" in args
        assert "--yes hyperframes render" in args
        assert str(tmp_path / "hyperframes") in args
        (tmp_path / "manual_video_agent_usage.mp4").write_bytes(b"mp4")
        return subprocess.CompletedProcess(args=args, returncode=0, stdout="rendered", stderr="")

    result = render_final_video(
        plan=plan,
        package_dir=tmp_path,
        preview_html=preview,
        fallback_video=fallback_video,
        settings=settings,
        command_runner=fake_runner,
    )

    assert result.used_fallback is False
    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert metadata["command"][0] == r"C:\Program Files\nodejs\npx.CMD"
    assert metadata["shell"] is True
    assert "npx.CMD" in metadata["shell_command"]


def test_playwright_mcp_live_mode_calls_mcp_client_and_writes_execution_log(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live",
            "MANUAL_AGENT_PLAYWRIGHT_MCP_COMMAND": "npx @playwright/mcp@latest --headless",
        }
    )
    plan = {
        "steps": [{"id": "step_search", "title": "검색", "caption": "검색", "narration": "검색"}],
        "actions": [
            {"id": "a1", "type": "navigate", "target": "http://127.0.0.1:8000/sample", "step_id": "step_search"},
            {"id": "a2", "type": "fill", "selector": "[name='lot']", "value": "LOT-001", "step_id": "step_search"},
            {"id": "a3", "type": "click", "selector": "[data-action='search']", "step_id": "step_search"},
        ],
    }
    calls = []

    class FakeMcpClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def initialize(self):
            calls.append(("initialize", {}))
            return {"serverInfo": {"name": "fake-playwright"}}

        def list_tools(self):
            calls.append(("tools/list", {}))
            return {"browser_navigate", "browser_run_code", "browser_snapshot"}

        def call_tool(self, name, arguments):
            calls.append((name, arguments))
            function = arguments.get("function", "")
            if name == "browser_evaluate" and "body_text" in function:
                return {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(
                                {
                                    "body_text": "공지 모달",
                                    "fields": [],
                                    "clickables": [{"text": "닫기", "selector": "button.close"}],
                                },
                                ensure_ascii=False,
                            ),
                        }
                    ]
                }
            return {"content": [{"type": "text", "text": f"{name} ok"}]}

    result = rehearse_plan(plan, settings, tmp_path, mcp_client_factory=lambda *_args, **_kwargs: FakeMcpClient())

    assert result["status"] == "live-completed"
    assert result["adapter"] == "playwright-mcp-live"
    assert ("browser_navigate", {"url": "http://127.0.0.1:8000/sample"}) in calls
    assert any(name == "browser_run_code" and "locator" in args["code"] for name, args in calls)
    execution = json.loads((tmp_path / "playwright_mcp_execution.json").read_text(encoding="utf-8"))
    assert execution["status"] == "live-completed"
    assert execution["results"]


def test_playwright_mcp_live_mode_executes_semantic_planner_actions(tmp_path: Path):
    settings = load_settings(environ={"MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live"})
    plan = {
        "steps": [{"id": "step_search", "title": "검색", "caption": "검색", "narration": "검색"}],
        "actions": [
            {"id": "a1", "type": "navigate", "target": "http://127.0.0.1:8000/sample", "step_id": "step_search"},
            {"id": "a2", "type": "fill_by_label", "label": "LOT", "value": "LOT-001", "step_id": "step_search"},
            {"id": "a3", "type": "click_by_text", "texts": ["조회", "검색"], "step_id": "step_search"},
            {"id": "a4", "type": "capture_step", "step_id": "step_search"},
        ],
    }
    calls = []

    class FakeMcpClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def initialize(self):
            return {"serverInfo": {"name": "fake-playwright"}}

        def list_tools(self):
            return {"browser_navigate", "browser_run_code", "browser_snapshot"}

        def call_tool(self, name, arguments):
            calls.append((name, arguments))
            function = arguments.get("function", "")
            if name == "browser_evaluate" and "body_text" in function:
                return {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(
                                {
                                    "body_text": "공지 모달",
                                    "fields": [],
                                    "clickables": [{"text": "닫기", "selector": "button.close"}],
                                },
                                ensure_ascii=False,
                            ),
                        }
                    ]
                }
            return {"content": [{"type": "text", "text": f"{name} ok"}]}

    result = rehearse_plan(plan, settings, tmp_path, mcp_client_factory=lambda *_args, **_kwargs: FakeMcpClient())

    assert result["status"] == "live-completed"
    assert result["executed"] is True
    assert len(calls) == 4
    assert any(name == "browser_run_code" and "getByLabel" in args["code"] for name, args in calls)
    assert any(name == "browser_run_code" and "getByRole" in args["code"] and "조회" in args["code"] for name, args in calls)
    execution = json.loads((tmp_path / "playwright_mcp_execution.json").read_text(encoding="utf-8"))
    assert execution["executed"] is True
    assert execution["attempted_actions"] == 4
    assert execution["executed_actions"] == 4


def test_playwright_mcp_live_mode_can_run_dynamic_browser_agent_loop(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live",
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS": "3",
        }
    )
    request = SimpleNamespace(
        request_text="챗봇에 프롬프트를 입력하고 답변을 확인",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변 확인",
        input_values={"프롬프트": "st.form과 st.input 차이"},
        agent_brief={"task_type": "chat_prompt", "safe_click_intents": ["전송"]},
    )
    plan = {
        "steps": [{"id": "step_chat", "title": "챗봇", "caption": "챗봇", "narration": "챗봇"}],
        "actions": [
            {"id": "a1", "type": "navigate", "target": request.target_url, "step_id": "step_chat"},
            {"id": "a2", "type": "click_by_text", "texts": ["엉뚱한 버튼"], "step_id": "step_chat"},
        ],
    }
    calls = []

    class FakeMcpClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def initialize(self):
            return {}

        def list_tools(self):
            return {"browser_navigate", "browser_run_code", "browser_snapshot"}

        def call_tool(self, name, arguments):
            calls.append((name, arguments))
            if name == "browser_run_code" and "manualMcpObserve" in arguments.get("code", ""):
                return {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(
                                {
                                    "url": request.target_url,
                                    "title": "Chat",
                                    "fields": [{"label": "프롬프트", "selector": "#prompt", "value": ""}],
                                    "clickables": [{"text": "전송", "selector": "#send"}],
                                    "body_text": "프롬프트 전송",
                                },
                                ensure_ascii=False,
                            ),
                        }
                    ]
                }
            return {"content": [{"type": "text", "text": f"{name} ok"}]}

    decisions = [
        {"status": "ok", "type": "fill_by_label", "label": "프롬프트", "value": "st.form과 st.input 차이", "reason": "질문을 입력합니다."},
        {"status": "ok", "type": "click_by_text", "texts": ["전송"], "reason": "전송합니다."},
        {"status": "ok", "type": "finish", "reason": "답변 화면을 확인했습니다."},
    ]

    def decide_next(*_args, **_kwargs):
        return decisions.pop(0)

    result = rehearse_plan(
        plan,
        settings,
        tmp_path,
        request=request,
        decide_next=decide_next,
        mcp_client_factory=lambda *_args, **_kwargs: FakeMcpClient(),
    )

    assert result["status"] == "live-agent-completed"
    assert result["adapter"] == "playwright-mcp-live-agent"
    assert result["executed"] is True
    assert result["executed_actions"] == 2
    run_code_payloads = [args["code"] for name, args in calls if name == "browser_run_code"]
    assert any("getByLabel" in code for code in run_code_payloads)
    assert any("getByRole" in code and "전송" in code for code in run_code_payloads)
    assert not any("엉뚱한 버튼" in code for code in run_code_payloads)
    execution = json.loads((tmp_path / "playwright_mcp_execution.json").read_text(encoding="utf-8"))
    assert execution["contract"] == "observe-act-verify"
    assert [turn["action"]["type"] for turn in execution["turns"]] == ["fill_by_label", "click_by_text", "finish"]
    calls_manifest = json.loads((tmp_path / "playwright_mcp_calls.json").read_text(encoding="utf-8"))
    assert calls_manifest["mode"] == "dynamic-browser-agent"


def test_playwright_mcp_live_agent_maps_wait_action_to_timeout_tool_call(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live",
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS": "2",
        }
    )
    request = SimpleNamespace(
        request_text="SSO 경유 후 챗봇에 질문",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변 확인",
        input_values={"프롬프트": "테스트"},
        agent_brief={"task_type": "chat_prompt", "safe_click_intents": ["전송"]},
    )
    calls = []

    class FakeMcpClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def initialize(self):
            return {}

        def list_tools(self):
            return {"browser_navigate", "browser_run_code"}

        def call_tool(self, name, arguments):
            calls.append((name, arguments))
            if name == "browser_run_code" and "manualMcpObserve" in arguments.get("code", ""):
                return {"content": [{"type": "text", "text": json.dumps({"body_text": "SSO redirecting"}, ensure_ascii=False)}]}
            return {"content": [{"type": "text", "text": f"{name} ok"}]}

    decisions = [
        {"status": "ok", "type": "wait", "timeout_ms": 2500, "reason": "sso_auth_redirect_wait"},
        {"status": "ok", "type": "finish", "reason": "SSO 대기 완료"},
    ]

    def decide_next(*_args, **_kwargs):
        return decisions.pop(0)

    result = rehearse_plan(
        {"steps": [], "actions": [{"id": "a1", "type": "navigate", "target": request.target_url}]},
        settings,
        tmp_path,
        request=request,
        decide_next=decide_next,
        mcp_client_factory=lambda *_args, **_kwargs: FakeMcpClient(),
    )

    assert result["status"] == "live-agent-completed"
    wait_calls = [args["code"] for name, args in calls if name == "browser_run_code" and "waitForTimeout" in args["code"]]
    assert len(wait_calls) == 1
    assert "2500" in wait_calls[0]
    execution = json.loads((tmp_path / "playwright_mcp_execution.json").read_text(encoding="utf-8"))
    assert execution["turns"][0]["action"]["type"] == "wait"
    assert execution["turns"][0]["tool"] == "browser_run_code"
    assert execution["executed_actions"] == 1


def test_playwright_mcp_live_agent_extends_loop_for_sso_waits(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live",
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS": "1",
            "MANUAL_AGENT_LOGIN_MODE": "sso_profile",
        }
    )
    request = SimpleNamespace(
        request_text="SSO 경유 후 챗봇에 질문",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변 확인",
        input_values={"프롬프트": "테스트"},
        agent_brief={"task_type": "chat_prompt", "safe_click_intents": ["전송"]},
    )
    calls = []

    class FakeMcpClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def initialize(self):
            return {}

        def list_tools(self):
            return {"browser_navigate", "browser_run_code"}

        def call_tool(self, name, arguments):
            calls.append((name, arguments))
            if name == "browser_run_code" and "manualMcpObserve" in arguments.get("code", ""):
                return {"content": [{"type": "text", "text": json.dumps({"body_text": "SAML SSO redirecting"}, ensure_ascii=False)}]}
            return {"content": [{"type": "text", "text": f"{name} ok"}]}

    decisions = [
        {"status": "ok", "type": "wait", "timeout_ms": 1000, "reason": "sso_auth_redirect_wait"},
        {"status": "ok", "type": "wait", "timeout_ms": 1000, "reason": "sso_auth_redirect_wait"},
        {"status": "ok", "type": "finish", "reason": "SSO 경유 완료"},
    ]

    def decide_next(*_args, **_kwargs):
        return decisions.pop(0)

    result = rehearse_plan(
        {"steps": [], "actions": [{"id": "a1", "type": "navigate", "target": request.target_url}]},
        settings,
        tmp_path,
        request=request,
        decide_next=decide_next,
        mcp_client_factory=lambda *_args, **_kwargs: FakeMcpClient(),
    )

    assert result["status"] == "live-agent-completed"
    execution = json.loads((tmp_path / "playwright_mcp_execution.json").read_text(encoding="utf-8"))
    assert [turn["action"]["type"] for turn in execution["turns"]] == ["wait", "wait", "finish"]
    assert execution["sso_wait_turns"] == 2


def test_playwright_mcp_live_agent_can_hold_browser_open_after_sso_wait(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live",
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS": "1",
            "MANUAL_AGENT_LOGIN_MODE": "sso_profile",
            "MANUAL_AGENT_AUTH_DEBUG_KEEP_BROWSER_OPEN_SECONDS": "120",
        }
    )
    request = SimpleNamespace(
        request_text="SSO 경유 후 챗봇에 질문",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변 확인",
        input_values={"프롬프트": "테스트"},
        agent_brief={"task_type": "chat_prompt", "safe_click_intents": ["전송"]},
    )
    calls = []

    class FakeMcpClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            calls.append(("closed", {}))
            return False

        def initialize(self):
            return {}

        def list_tools(self):
            return {"browser_navigate", "browser_run_code"}

        def call_tool(self, name, arguments):
            calls.append((name, arguments))
            if name == "browser_run_code" and "manualMcpObserve" in arguments.get("code", ""):
                return {"content": [{"type": "text", "text": json.dumps({"body_text": "SAML SSO redirecting"}, ensure_ascii=False)}]}
            return {"content": [{"type": "text", "text": f"{name} ok"}]}

    decisions = [
        {"status": "ok", "type": "wait", "timeout_ms": 1000, "reason": "sso_auth_redirect_wait"},
        {"status": "ok", "type": "finish", "reason": "SSO 경유 완료"},
    ]

    def decide_next(*_args, **_kwargs):
        return decisions.pop(0)

    result = rehearse_plan(
        {"steps": [], "actions": [{"id": "a1", "type": "navigate", "target": request.target_url}]},
        settings,
        tmp_path,
        request=request,
        decide_next=decide_next,
        mcp_client_factory=lambda *_args, **_kwargs: FakeMcpClient(),
    )

    assert result["status"] == "live-agent-completed"
    wait_codes = [args["code"] for name, args in calls if name == "browser_run_code" and "waitForTimeout" in args["code"]]
    assert any("120000" in code for code in wait_codes)
    assert calls[-1] == ("closed", {})
    execution = json.loads((tmp_path / "playwright_mcp_execution.json").read_text(encoding="utf-8"))
    assert execution["debug_keep_browser_open_seconds"] == 120


def test_playwright_mcp_live_agent_uses_headed_sso_profile_command(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live",
            "MANUAL_AGENT_PLAYWRIGHT_MCP_COMMAND": "npx @playwright/mcp@latest --headless",
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS": "1",
            "MANUAL_AGENT_LOGIN_MODE": "sso_profile",
            "MANUAL_AGENT_BROWSER_CHANNEL": "msedge",
            "MANUAL_AGENT_USER_DATA_DIR": r"C:\Users\xiro1\OneDrive\Documents\New project 5\runtime\browser-profile",
        }
    )
    request = SimpleNamespace(
        request_text="SSO 경유 후 챗봇에 질문",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변 확인",
        input_values={"프롬프트": "테스트"},
        agent_brief={},
    )
    factory_calls = []

    class FakeMcpClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def initialize(self):
            return {}

        def list_tools(self):
            return {"browser_navigate", "browser_run_code"}

        def call_tool(self, name, arguments):
            if name == "browser_run_code" and "manualMcpObserve" in arguments.get("code", ""):
                return {"content": [{"type": "text", "text": json.dumps({"body_text": "앱 화면"}, ensure_ascii=False)}]}
            return {"content": [{"type": "text", "text": f"{name} ok"}]}

    def factory(command, timeout_seconds):
        factory_calls.append(command)
        return FakeMcpClient()

    result = rehearse_plan(
        {"steps": [], "actions": [{"id": "a1", "type": "navigate", "target": request.target_url}]},
        settings,
        tmp_path,
        request=request,
        decide_next=lambda *_args, **_kwargs: {"status": "ok", "type": "finish", "reason": "확인"},
        mcp_client_factory=factory,
    )

    assert result["status"] == "live-agent-completed"
    command = factory_calls[0]
    assert "--headless" not in command
    assert "--browser msedge" in command
    assert "--user-data-dir" in command
    assert '"C:\\Users\\xiro1\\OneDrive\\Documents\\New project 5\\runtime\\browser-profile"' in command
    execution = json.loads((tmp_path / "playwright_mcp_execution.json").read_text(encoding="utf-8"))
    assert execution["command"] == command


def test_playwright_mcp_live_mode_can_be_deferred_until_after_login(tmp_path: Path):
    settings = load_settings(environ={"MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live"})
    plan = {
        "steps": [{"id": "step_chat", "title": "챗봇", "caption": "챗봇", "narration": "챗봇"}],
        "actions": [
            {"id": "a1", "type": "navigate", "target": "http://internal.example.local/chat", "step_id": "step_chat"},
            {"id": "a2", "type": "fill_by_label", "label": "프롬프트", "value": "테스트", "step_id": "step_chat"},
        ],
    }
    calls = []

    class FakeMcpClient:
        def __enter__(self):
            calls.append("entered")
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    result = rehearse_plan(
        plan,
        settings,
        tmp_path,
        allow_live=False,
        deferred_reason="login_required",
        mcp_client_factory=lambda *_args, **_kwargs: FakeMcpClient(),
    )

    assert result["status"] == "deferred-until-authenticated"
    assert result["mode"] == "live"
    assert result["executed"] is False
    assert result["requires_live_mode"] is True
    assert result["deferred_reason"] == "login_required"
    assert calls == []
    assert (tmp_path / "playwright_mcp_calls.json").exists()
    assert not (tmp_path / "playwright_mcp_execution.json").exists()


def test_playwright_mcp_live_mode_stops_when_login_screen_is_detected(tmp_path: Path):
    settings = load_settings(environ={"MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live"})
    plan = {
        "steps": [{"id": "step_chat", "title": "챗봇", "caption": "챗봇", "narration": "챗봇"}],
        "actions": [
            {"id": "a1", "type": "navigate", "target": "http://internal.example.local/chat", "step_id": "step_chat"},
            {"id": "a2", "type": "fill_by_label", "label": "프롬프트", "value": "테스트", "step_id": "step_chat"},
        ],
    }
    calls = []

    class FakeMcpClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def initialize(self):
            return {}

        def list_tools(self):
            return {"browser_navigate", "browser_run_code"}

        def call_tool(self, name, arguments):
            calls.append((name, arguments))
            return {"content": [{"type": "text", "text": "로그인 또는 회원가입 후 계속하세요"}]}

    result = rehearse_plan(plan, settings, tmp_path, mcp_client_factory=lambda *_args, **_kwargs: FakeMcpClient())

    assert result["status"] == "blocked-login"
    assert result["deferred_reason"] == "login_required"
    assert result["executed_actions"] == 1
    assert [name for name, _args in calls] == ["browser_navigate"]
    execution = json.loads((tmp_path / "playwright_mcp_execution.json").read_text(encoding="utf-8"))
    assert execution["status"] == "blocked-login"
    assert execution["blocked_reason"] == "login_required"


def test_playwright_mcp_live_mode_allows_sso_profile_auth_redirect(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live",
            "MANUAL_AGENT_LOGIN_MODE": "sso_profile",
            "MANUAL_AGENT_USER_DATA_DIR": "C:\\AppBundle\\manualgen\\browser-profile",
        }
    )
    plan = {
        "steps": [{"id": "step_chat", "title": "챗봇", "caption": "챗봇", "narration": "챗봇"}],
        "actions": [
            {"id": "a1", "type": "navigate", "target": "http://internal.example.local/chat", "step_id": "step_chat"},
            {"id": "a2", "type": "fill_by_label", "label": "프롬프트", "value": "테스트", "step_id": "step_chat"},
            {"id": "a3", "type": "capture_step", "step_id": "step_chat"},
        ],
    }
    calls = []

    class FakeMcpClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def initialize(self):
            return {}

        def list_tools(self):
            return {"browser_navigate", "browser_run_code", "browser_snapshot"}

        def call_tool(self, name, arguments):
            calls.append((name, arguments))
            if name == "browser_navigate":
                return {"content": [{"type": "text", "text": "SAML SSO redirecting through corporate authentication"}]}
            return {"content": [{"type": "text", "text": f"{name} ok"}]}

    result = rehearse_plan(plan, settings, tmp_path, mcp_client_factory=lambda *_args, **_kwargs: FakeMcpClient())

    assert result["status"] == "live-completed"
    assert result["executed_actions"] == 3
    assert [name for name, _args in calls] == ["browser_navigate", "browser_run_code", "browser_snapshot"]
    execution = json.loads((tmp_path / "playwright_mcp_execution.json").read_text(encoding="utf-8"))
    assert execution["status"] == "live-completed"
    assert execution["auth_interstitials"] == [{"action_id": "a1", "reason": "sso_auth_redirect_detected"}]


def test_playwright_mcp_live_mode_does_not_block_sso_profile_on_auth_page_password_text(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live",
            "MANUAL_AGENT_LOGIN_MODE": "sso_profile",
            "MANUAL_AGENT_USER_DATA_DIR": "C:\\AppBundle\\manualgen\\browser-profile",
        }
    )
    plan = {
        "steps": [{"id": "step_chat", "title": "챗봇", "caption": "챗봇", "narration": "챗봇"}],
        "actions": [
            {"id": "a1", "type": "navigate", "target": "http://internal.example.local/chat", "step_id": "step_chat"},
            {"id": "a2", "type": "capture_step", "step_id": "step_chat"},
            {"id": "a3", "type": "fill_by_label", "label": "프롬프트", "value": "테스트", "step_id": "step_chat"},
            {"id": "a4", "type": "capture_step", "step_id": "step_chat"},
        ],
    }
    calls = []

    class FakeMcpClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def initialize(self):
            return {}

        def list_tools(self):
            return {"browser_navigate", "browser_run_code", "browser_snapshot"}

        def call_tool(self, name, arguments):
            calls.append((name, arguments))
            if len(calls) == 3:
                return {"content": [{"type": "text", "text": "SAML authentication page Login password redirecting"}]}
            return {"content": [{"type": "text", "text": f"{name} ok"}]}

    result = rehearse_plan(plan, settings, tmp_path, mcp_client_factory=lambda *_args, **_kwargs: FakeMcpClient())

    assert result["status"] == "live-completed"
    assert result["executed_actions"] == 4
    assert [name for name, _args in calls] == ["browser_navigate", "browser_snapshot", "browser_run_code", "browser_snapshot"]
    execution = json.loads((tmp_path / "playwright_mcp_execution.json").read_text(encoding="utf-8"))
    assert execution["status"] == "live-completed"
    assert "blocked_action_id" not in execution


def test_playwright_mcp_manifest_mode_is_explicitly_not_rehearsed(tmp_path: Path):
    settings = load_settings(environ={"MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "manifest"})
    plan = {
        "steps": [{"id": "step_search", "title": "검색", "caption": "검색", "narration": "검색"}],
        "actions": [
            {"id": "a1", "type": "fill_by_label", "label": "LOT", "value": "LOT-001", "step_id": "step_search"},
            {"id": "a2", "type": "click_by_text", "texts": ["조회"], "step_id": "step_search"},
        ],
    }

    result = rehearse_plan(plan, settings, tmp_path)
    calls = json.loads((tmp_path / "playwright_mcp_calls.json").read_text(encoding="utf-8"))["calls"]

    assert result["status"] == "manifest-only"
    assert result["executed"] is False
    assert result["requires_live_mode"] is True
    assert [call["action_id"] for call in calls] == ["a1", "a2"]
    assert all(call["tool"] == "browser_run_code" for call in calls)


def test_playwright_mcp_live_agent_click_by_text_falls_back_to_browser_evaluate(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live",
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS": "2",
        }
    )
    request = SimpleNamespace(
        request_text="모달창을 확인하고 닫기",
        target_url="http://internal.example.local/home",
        role="사용자",
        completion_condition="모달창 닫기",
        input_values={},
        agent_brief={"safe_click_intents": ["닫기", "창닫기"]},
    )
    calls = []

    class FakeMcpClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def initialize(self):
            return {}

        def list_tools(self):
            return {"browser_navigate", "browser_evaluate"}

        def call_tool(self, name, arguments):
            calls.append((name, arguments))
            function = arguments.get("function", "")
            if name == "browser_evaluate" and "body_text" in function:
                return {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(
                                {
                                    "body_text": "공지 모달",
                                    "fields": [],
                                    "clickables": [{"text": "닫기", "selector": "button.close"}],
                                },
                                ensure_ascii=False,
                            ),
                        }
                    ]
                }
            return {"content": [{"type": "text", "text": f"{name} ok"}]}

    decisions = [
        {"status": "ok", "type": "click_by_text", "texts": ["닫기", "창닫기"], "reason": "모달창 닫기"},
        {"status": "ok", "type": "finish", "reason": "모달창을 닫았습니다."},
    ]

    def decide_next(*_args, **_kwargs):
        return decisions.pop(0)

    result = rehearse_plan(
        {"steps": [], "actions": [{"id": "a1", "type": "navigate", "target": request.target_url}]},
        settings,
        tmp_path,
        request=request,
        decide_next=decide_next,
        mcp_client_factory=lambda *_args, **_kwargs: FakeMcpClient(),
    )

    assert result["status"] == "live-agent-completed"
    evaluate_functions = [args["function"] for name, args in calls if name == "browser_evaluate"]
    assert any("querySelectorAll" in function for function in evaluate_functions)
    assert any("닫기" in function for function in evaluate_functions)
    execution = json.loads((tmp_path / "playwright_mcp_execution.json").read_text(encoding="utf-8"))
    assert execution["turns"][0]["observation"]["clickables"] == [{"text": "닫기", "selector": "button.close"}]
    assert execution["turns"][0]["tool"] == "browser_evaluate"
    assert execution["turns"][0]["result"]["content"][0]["text"] == "browser_evaluate ok"
    assert execution["turns"][0]["result"].get("status") != "skipped"


def test_playwright_mcp_live_agent_fill_by_label_falls_back_to_browser_evaluate_for_chat_input(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live",
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS": "2",
        }
    )
    request = SimpleNamespace(
        request_text="대화 입력창에 질문 입력",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="입력 완료",
        input_values={"대화 입력창": "테스트 질문"},
        agent_brief={"task_type": "chat_prompt"},
    )
    calls = []

    class FakeMcpClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def initialize(self):
            return {}

        def list_tools(self):
            return {"browser_navigate", "browser_evaluate"}

        def call_tool(self, name, arguments):
            calls.append((name, arguments))
            function = arguments.get("function", "")
            if name == "browser_evaluate" and "body_text" in function:
                return {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(
                                {
                                    "body_text": "챗봇 화면",
                                    "fields": [{"label": "대화 입력창", "selector": "[role='textbox']", "type": "textbox", "value": ""}],
                                    "clickables": [],
                                },
                                ensure_ascii=False,
                            ),
                        }
                    ]
                }
            return {"content": [{"type": "text", "text": f"{name} ok"}]}

    decisions = [
        {
            "status": "ok",
            "type": "fill_by_label",
            "label": "대화 입력창",
            "value": "테스트 질문",
            "value_key": "대화 입력창",
            "reason": "대화 입력창이 보이므로 입력값을 채운다",
        },
        {"status": "ok", "type": "finish", "reason": "입력 완료"},
    ]

    result = rehearse_plan(
        {"steps": [], "actions": [{"id": "a1", "type": "navigate", "target": request.target_url}]},
        settings,
        tmp_path,
        request=request,
        decide_next=lambda *_args, **_kwargs: decisions.pop(0),
        mcp_client_factory=lambda *_args, **_kwargs: FakeMcpClient(),
    )

    assert result["status"] == "live-agent-completed"
    evaluate_functions = [args["function"] for name, args in calls if name == "browser_evaluate"]
    assert any("대화 입력창" in function and "테스트 질문" in function for function in evaluate_functions)
    execution = json.loads((tmp_path / "playwright_mcp_execution.json").read_text(encoding="utf-8"))
    assert execution["turns"][0]["tool"] == "browser_evaluate"
    assert execution["turns"][0]["result"].get("status") != "skipped"


def test_playwright_mcp_live_agent_captures_screenshot_before_each_action(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live",
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS": "2",
        }
    )
    request = SimpleNamespace(
        request_text="대화 입력창에 질문 입력",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="입력 완료",
        input_values={"대화 입력창": "테스트 질문"},
        agent_brief={"task_type": "chat_prompt"},
    )
    calls = []
    png_1x1 = base64.b64encode(
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
        b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
    ).decode("ascii")

    class FakeMcpClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def initialize(self):
            return {}

        def list_tools(self):
            return {"browser_navigate", "browser_run_code", "browser_take_screenshot"}

        def call_tool(self, name, arguments):
            calls.append((name, arguments))
            if name == "browser_take_screenshot":
                return {"content": [{"type": "image", "mimeType": "image/png", "data": png_1x1}]}
            if name == "browser_run_code" and "manualMcpObserve" in arguments.get("code", ""):
                return {"content": [{"type": "text", "text": json.dumps({"body_text": "챗봇", "fields": [], "clickables": []}, ensure_ascii=False)}]}
            return {"content": [{"type": "text", "text": f"{name} ok"}]}

    decisions = [
        {"status": "ok", "type": "capture_step", "reason": "현재 화면 확인"},
        {"status": "ok", "type": "finish", "reason": "입력 완료"},
    ]

    result = rehearse_plan(
        {"steps": [], "actions": [{"id": "a1", "type": "navigate", "target": request.target_url}]},
        settings,
        tmp_path,
        request=request,
        decide_next=lambda *_args, **_kwargs: decisions.pop(0),
        mcp_client_factory=lambda *_args, **_kwargs: FakeMcpClient(),
    )

    assert result["status"] == "live-agent-completed"
    screenshot_calls = [arguments for name, arguments in calls if name == "browser_take_screenshot"]
    assert screenshot_calls[0]["filename"] == "mcp_step_01_before.png"
    assert screenshot_calls[1]["filename"] == "mcp_step_02_before.png"
    execution = json.loads((tmp_path / "playwright_mcp_execution.json").read_text(encoding="utf-8"))
    assert execution["turns"][0]["screenshot_before"]["status"] == "ok"
    assert execution["turns"][0]["observation"]["screenshot"]["filename"] == "mcp_step_01_before.png"
    assert (tmp_path / "mcp_screenshots" / "mcp_step_01_before.png").exists()


def test_playwright_mcp_live_agent_clicks_icon_only_plus_controls(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live",
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS": "2",
        }
    )
    request = SimpleNamespace(
        request_text="새 항목 추가 버튼을 누르기",
        target_url="http://internal.example.local/home",
        role="사용자",
        completion_condition="추가 모달 확인",
        input_values={},
        agent_brief={"safe_click_intents": ["+", "추가"]},
    )
    calls = []

    class FakeMcpClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def initialize(self):
            return {}

        def list_tools(self):
            return {"browser_navigate", "browser_run_code"}

        def call_tool(self, name, arguments):
            calls.append((name, arguments))
            if name == "browser_run_code" and "manualMcpObserve" in arguments.get("code", ""):
                return {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(
                                {
                                    "body_text": "홈",
                                    "fields": [],
                                    "clickables": [{"text": "+ 추가 plus add", "selector": ".icon-plus-bold"}],
                                },
                                ensure_ascii=False,
                            ),
                        }
                    ]
                }
            return {"content": [{"type": "text", "text": f"{name} ok"}]}

    decisions = [
        {"status": "ok", "type": "click_by_text", "texts": ["+", "추가"], "reason": "아이콘 추가 버튼 클릭"},
        {"status": "ok", "type": "finish", "reason": "추가 화면 확인"},
    ]

    result = rehearse_plan(
        {"steps": [], "actions": [{"id": "a1", "type": "navigate", "target": request.target_url}]},
        settings,
        tmp_path,
        request=request,
        decide_next=lambda *_args, **_kwargs: decisions.pop(0),
        mcp_client_factory=lambda *_args, **_kwargs: FakeMcpClient(),
    )

    assert result["status"] == "live-agent-completed"
    click_codes = [args["code"] for name, args in calls if name == "browser_run_code" and "clickedByDom" in args.get("code", "")]
    assert click_codes
    assert "icon-" in click_codes[0]
    assert "plus" in click_codes[0]
    assert "추가" in click_codes[0]


def test_playwright_mcp_live_agent_executes_click_by_selector(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live",
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS": "2",
        }
    )
    request = SimpleNamespace(
        request_text="화면의 .icon-plus-bold를 click_by_selector로 클릭",
        target_url="http://internal.example.local/home",
        role="사용자",
        completion_condition="추가 화면 확인",
        input_values={},
        agent_brief={},
    )
    calls = []

    class FakeMcpClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def initialize(self):
            return {}

        def list_tools(self):
            return {"browser_navigate", "browser_run_code"}

        def call_tool(self, name, arguments):
            calls.append((name, arguments))
            if name == "browser_run_code" and "manualMcpObserve" in arguments.get("code", ""):
                return {"content": [{"type": "text", "text": json.dumps({"body_text": "홈", "fields": [], "clickables": []}, ensure_ascii=False)}]}
            return {"content": [{"type": "text", "text": f"{name} ok"}]}

    decisions = [
        {"status": "ok", "type": "click_by_selector", "selector": ".icon-plus-bold", "reason": "사용자 요청 selector 클릭"},
        {"status": "ok", "type": "finish", "reason": "추가 화면 확인"},
    ]

    result = rehearse_plan(
        {"steps": [], "actions": [{"id": "a1", "type": "navigate", "target": request.target_url}]},
        settings,
        tmp_path,
        request=request,
        decide_next=lambda *_args, **_kwargs: decisions.pop(0),
        mcp_client_factory=lambda *_args, **_kwargs: FakeMcpClient(),
    )

    assert result["status"] == "live-agent-completed"
    click_codes = [args["code"] for name, args in calls if name == "browser_run_code" and "clicked_by_selector" in args.get("code", "")]
    assert click_codes
    assert ".icon-plus-bold" in click_codes[0]
    execution = json.loads((tmp_path / "playwright_mcp_execution.json").read_text(encoding="utf-8"))
    assert execution["turns"][0]["tool"] == "browser_run_code"
    assert execution["turns"][0]["arguments"]["code"] == click_codes[0]


def test_playwright_mcp_manifest_redacts_sensitive_fill_values(tmp_path: Path):
    settings = load_settings(environ={"MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "manifest"})
    plan = {
        "steps": [{"id": "step_login", "title": "로그인", "caption": "로그인", "narration": "로그인"}],
        "actions": [
            {"id": "a1", "type": "fill", "selector": "[name='password']", "value": "plain-password"},
            {"id": "a2", "type": "fill", "selector": "[name='lot']", "value": "LOT-001"},
        ],
    }

    result = rehearse_plan(plan, settings, tmp_path)
    calls_text = (tmp_path / "playwright_mcp_calls.json").read_text(encoding="utf-8")

    assert "plain-password" not in calls_text
    assert "plain-password" not in json.dumps(result, ensure_ascii=False)
    assert result["candidate_calls"][0]["arguments"]["text"] == "<redacted>"
    assert result["candidate_calls"][1]["arguments"]["text"] == "LOT-001"


def test_playwright_mcp_live_execution_log_redacts_sensitive_fill_values(tmp_path: Path):
    settings = load_settings(environ={"MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live"})
    plan = {
        "steps": [{"id": "step_login", "title": "로그인", "caption": "로그인", "narration": "로그인"}],
        "actions": [
            {"id": "a1", "type": "fill", "selector": "[name='password']", "value": "plain-password"},
        ],
    }
    tool_arguments = []

    class FakeMcpClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def initialize(self):
            return {}

        def list_tools(self):
            return {"browser_run_code"}

        def call_tool(self, name, arguments):
            tool_arguments.append(arguments)
            return {"content": [{"type": "text", "text": "ok"}]}

    rehearse_plan(plan, settings, tmp_path, mcp_client_factory=lambda *_args, **_kwargs: FakeMcpClient())
    execution_text = (tmp_path / "playwright_mcp_execution.json").read_text(encoding="utf-8")

    assert "plain-password" in json.dumps(tool_arguments, ensure_ascii=False)
    assert "plain-password" not in execution_text
    assert "<redacted>" in execution_text


def test_playwright_mcp_live_mode_reports_tool_errors(tmp_path: Path):
    settings = load_settings(environ={"MANUAL_AGENT_PLAYWRIGHT_MCP_MODE": "live"})
    plan = {
        "steps": [{"id": "step_search", "title": "검색", "caption": "검색", "narration": "검색"}],
        "actions": [{"id": "a1", "type": "click", "selector": "[data-action='search']", "step_id": "step_search"}],
    }

    class ErrorMcpClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def initialize(self):
            return {}

        def list_tools(self):
            return {"browser_evaluate"}

        def call_tool(self, name, arguments):
            return {"isError": True, "content": [{"type": "text", "text": "bad args"}]}

    result = rehearse_plan(plan, settings, tmp_path, mcp_client_factory=lambda *_args, **_kwargs: ErrorMcpClient())

    assert result["status"] == "live-failed"
    execution = json.loads((tmp_path / "playwright_mcp_execution.json").read_text(encoding="utf-8"))
    assert execution["had_tool_errors"] is True
    assert execution["results"][0]["arguments"]["function"].startswith("() =>")


def test_hyperframes_skills_command_runs_when_enabled(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_HYPERFRAMES_SKILLS": "true",
            "MANUAL_AGENT_HYPERFRAMES_SKILLS_COMMAND": "npx skills add heygen-com/hyperframes",
        }
    )

    def fake_runner(args, **kwargs):
        return subprocess.CompletedProcess(args=args, returncode=0, stdout="skills installed", stderr="")

    result = ensure_hyperframes_skills(settings, tmp_path, command_runner=fake_runner)

    assert result.status == "completed"
    assert result.metadata_path.exists()
    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert metadata["enabled"] is True
    assert Path(metadata["command"][0]).name.lower() in {"npx", "npx.cmd"}
    assert metadata["command"][1:] == ["skills", "add", "heygen-com/hyperframes"]
    assert metadata["stdout"] == "skills installed"


def test_opencode_agent_runs_prompt_in_package_directory(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_OPENCODE": "true",
            "MANUAL_AGENT_OPENCODE_COMMAND": "opencode run --format json",
            "MANUAL_AGENT_OPENCODE_AGENT": "build",
            "MANUAL_AGENT_OPENCODE_MODEL": "openai/gpt-5",
        }
    )
    plan = {
        "steps": [{"id": "step_intro", "title": "요청 확인", "caption": "요청 확인", "narration": "요청 확인"}],
        "actions": [{"id": "a1", "type": "navigate", "target": "http://127.0.0.1:8000/sample"}],
    }
    (tmp_path / "hyperframes").mkdir()
    (tmp_path / "hyperframes" / "index.html").write_text("<html></html>", encoding="utf-8")

    def fake_runner(args, **kwargs):
        assert kwargs["cwd"] == str(tmp_path)
        assert Path(tmp_path / "opencode_prompt.md").exists()
        assert Path(args[0]).name.lower() in {"opencode", "opencode.exe", "opencode.cmd"}
        assert args[1:4] == ["run", "--format", "json"]
        assert "--agent" in args
        assert "--model" in args
        assert "Manual Video Agent" in args[-1]
        return subprocess.CompletedProcess(args=args, returncode=0, stdout='{"type":"message","text":"ok"}', stderr="")

    result = run_opencode_agent(
        plan=plan,
        package_dir=tmp_path,
        settings=settings,
        command_runner=fake_runner,
    )

    assert result.status == "completed"
    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert metadata["enabled"] is True
    assert metadata["agent"] == "build"
    assert metadata["model"] == "openai/gpt-5"
    assert metadata["stdout"] == '{"type":"message","text":"ok"}'


def test_opencode_agent_records_failed_command_without_raising(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_OPENCODE": "true",
            "MANUAL_AGENT_OPENCODE_COMMAND": "opencode run --format json",
        }
    )

    def fake_runner(args, **kwargs):
        return subprocess.CompletedProcess(args=args, returncode=2, stdout="", stderr="failed")

    result = run_opencode_agent(
        plan={"steps": [], "actions": []},
        package_dir=tmp_path,
        settings=settings,
        command_runner=fake_runner,
    )

    assert result.status == "failed"
    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert metadata["returncode"] == 2
    assert metadata["stderr"] == "failed"


def test_opencode_agent_skips_when_disabled(tmp_path: Path):
    settings = load_settings(environ={})
    result = run_opencode_agent(plan={"steps": [], "actions": []}, package_dir=tmp_path, settings=settings)

    assert result.status == "skipped"
    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert metadata["enabled"] is False
