import json
import subprocess
from pathlib import Path

from backend.app.adapters.browser_agent import decide_browser_agent_action
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


def test_input_extractor_uses_llm_json_and_filters_sensitive_values(tmp_path: Path):
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


def test_browser_agent_decides_next_action_from_page_observation():
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


def test_internal_planner_uses_llm_json_when_enabled(tmp_path: Path):
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
    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert metadata["renderer"] == "hyperframes"
    assert metadata["fallback_video"] == str(fallback_video)
    assert metadata["used_fallback"] is True


def test_hyperframes_render_uses_mp4_when_command_produces_output(tmp_path: Path):
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

    def fake_runner(args, **kwargs):
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
            "MANUAL_AGENT_HYPERFRAMES_SKILLS_COMMAND": "npx hyperframes skills --codex",
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
    assert metadata["command"][1:] == ["hyperframes", "skills", "--codex"]
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
