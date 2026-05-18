import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.main import app
import backend.app.pipeline as pipeline_module
from backend.app.config import load_settings
from backend.app.pipeline import (
    PipelineInput,
    _authenticate_before_recording,
    _capture_with_playwright,
    _execute_capture_actions,
    _execute_browser_agent_actions,
    _handle_login,
    _install_manual_login_signal,
    _make_dirs,
    _playwright_launch_kwargs,
    _prepare_capture_page,
    _raise_if_login_failed,
    _resolve_login_options,
    run_pipeline,
)


def test_run_pipeline_creates_package_artifacts(tmp_path):
    result = run_pipeline(
        PipelineInput(
            request_text="MES에서 LOT 조회 방법 영상 만들기",
            target_url="http://127.0.0.1:8000/sample",
            role="작업자",
            completion_condition="상세 화면이 보이면 완료",
            input_values={"LOT": "LOT-001", "라인": "A3"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    assert result.status == "completed"
    assert result.artifacts.html_preview.exists()
    assert result.artifacts.markdown_manual.exists()
    assert result.artifacts.pdf_manual.exists()
    assert result.artifacts.video.exists()
    assert result.artifacts.action_plan.exists()
    assert result.artifacts.masking_log.exists()
    assert result.artifacts.capture_action_log
    assert result.artifacts.capture_action_log.exists()
    assert result.artifacts.tts_audio
    assert result.artifacts.package_manifest.exists()
    assert (result.package_dir / "tts" / "tts_metadata.json").exists()
    assert (result.package_dir / "hyperframes" / "index.html").exists()
    assert (result.package_dir / "playwright_mcp_calls.json").exists()
    assert (result.package_dir / "hyperframes_skills.json").exists()
    assert (result.package_dir / "opencode_agent.json").exists()
    manifest = result.artifacts.package_manifest.read_text(encoding="utf-8")
    assert '"tts_audio": [' in manifest
    assert '"video_render"' in manifest
    assert '"skills_metadata"' in manifest
    assert '"opencode_metadata"' in manifest
    assert "config_status" in result.plan


def test_package_manifest_lists_all_generated_supporting_artifacts(tmp_path):
    result = run_pipeline(
        PipelineInput(
            request_text="MES에서 LOT 조회 방법 영상 만들기",
            target_url="http://127.0.0.1:8000/sample",
            role="작업자",
            completion_condition="상세 화면이 보이면 완료",
            input_values={"LOT": "LOT-001", "라인": "A3"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    manifest = json.loads(result.artifacts.package_manifest.read_text(encoding="utf-8"))
    supporting = manifest["supporting_artifacts"]

    expected = {
        "request",
        "input_extraction",
        "planner_trace",
        "rehearsal_log",
        "playwright_mcp_calls",
        "tts_metadata",
        "video_render",
        "skills_metadata",
        "opencode_prompt",
        "opencode_metadata",
        "audit_log",
        "capture_action_log",
        "hyperframes_composition",
        "hyperframes_manifest",
    }
    assert expected.issubset(supporting)
    for key in expected:
        assert supporting[key], key
        assert Path(supporting[key]).exists(), key


def test_run_pipeline_extracts_missing_input_values_before_planning(tmp_path):
    result = run_pipeline(
        PipelineInput(
            request_text="MES에서 LOT-001을 조회하고 라인 A3 조건으로 상세 화면 확인",
            target_url="http://127.0.0.1:8000/sample",
            role="작업자",
            completion_condition="상세 화면이 보이면 완료",
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    request_payload = json.loads((result.package_dir / "request.json").read_text(encoding="utf-8"))
    extraction = json.loads((result.package_dir / "input_extraction.json").read_text(encoding="utf-8"))
    action_plan = json.loads(result.artifacts.action_plan.read_text(encoding="utf-8"))

    assert request_payload["input_values"]["LOT"] == "LOT-001"
    assert request_payload["input_values"]["라인"] == "A3"
    assert extraction["effective_input_values"] == {"LOT": "LOT-001", "라인": "A3"}
    assert any(action["type"] == "fill_by_label" and action["label"] == "LOT" for action in action_plan["actions"])
    assert any(action["type"] == "fill_by_label" and action["label"] == "라인" for action in action_plan["actions"])
    assert result.artifacts.input_extraction.exists()


def test_run_pipeline_falls_back_to_placeholder_when_browser_capture_raises(tmp_path, monkeypatch):
    def fail_capture(*_args, **_kwargs):
        raise RuntimeError("browser launch failed")

    monkeypatch.setattr(pipeline_module, "_capture_with_playwright", fail_capture)

    result = run_pipeline(
        PipelineInput(
            request_text="사내 포털 권한 신청 방법 영상 만들기",
            target_url="http://internal.example.local/portal",
            role="신청자",
            completion_condition="신청 화면 확인",
            input_values={"사용자ID": "U100"},
        ),
        base_dir=tmp_path,
        capture_browser=True,
    )

    manifest = json.loads(result.artifacts.package_manifest.read_text(encoding="utf-8"))
    capture_log = json.loads(result.artifacts.capture_action_log.read_text(encoding="utf-8"))

    assert result.status == "completed"
    assert result.artifacts.video.exists()
    assert capture_log["status"] == "failed"
    assert capture_log["reason"] == "playwright_capture_failed"
    assert any(item["actor"] == "capture" and item["reason"] == "playwright_capture_failed" for item in manifest["degradations"])


def test_pipeline_api_runs_and_returns_artifact_urls(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_OUTPUT_DIR", str(tmp_path))
    client = TestClient(app)

    response = client.post(
        "/api/pipeline/run?capture_browser=false",
        json={
            "request_text": "MES에서 LOT 조회 방법 영상 만들기",
            "target_url": "http://127.0.0.1:8000/sample",
            "role": "작업자",
            "completion_condition": "상세 화면이 보이면 완료",
            "input_values": {"LOT": "LOT-001", "라인": "A3"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "completed"
    assert body["artifacts"]["html_preview_url"].endswith("/preview.html")
    assert body["artifacts"]["video_url"].endswith("/manual_video_agent_usage.webm")
    assert body["artifacts"]["rehearsal_log_url"].endswith("/rehearsal_log.json")
    assert body["artifacts"]["planner_trace_url"].endswith("/planner_trace.json")
    assert body["artifacts"]["mcp_calls_url"].endswith("/playwright_mcp_calls.json")
    assert body["artifacts"]["hyperframes_composition_url"].endswith("/hyperframes/index.html")
    assert body["artifacts"]["opencode_prompt_url"].endswith("/opencode_prompt.md")
    assert body["supporting_artifacts"]["planner_trace"].endswith("/planner_trace.json")
    assert body["supporting_artifacts"]["hyperframes_manifest"].endswith("/hyperframes/hyperframes_manifest.json")
    assert Path(body["package_dir"]).exists()
    assert client.get(body["artifacts"]["html_preview_url"]).status_code == 200
    planner_trace = client.get(body["supporting_artifacts"]["planner_trace"])
    assert planner_trace.status_code == 200
    assert planner_trace.json()["planner"] == "local-deterministic"
    assert body["artifacts"]["audit_log_url"].endswith("/audit_log.jsonl")
    assert body["artifacts"]["input_extraction_url"].endswith("/input_extraction.json")
    assert body["artifacts"]["capture_action_log_url"].endswith("/capture_action_log.json")
    audit_response = client.get(body["supporting_artifacts"]["audit_log"])
    assert audit_response.status_code == 200
    assert "planner" in audit_response.text
    capture_action_log = client.get(body["supporting_artifacts"]["capture_action_log"])
    assert capture_action_log.status_code == 200
    assert capture_action_log.json()["status"] == "skipped"
    assert client.get(body["artifacts"]["input_extraction_url"]).status_code == 200


def test_pipeline_draft_api_stops_at_plan_review_without_capture_outputs(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_OUTPUT_DIR", str(tmp_path))
    client = TestClient(app)

    response = client.post(
        "/api/pipeline/draft?capture_browser=false",
        json={
            "request_text": "MES에서 LOT 조회 방법 영상 만들기",
            "target_url": "http://127.0.0.1:8000/sample",
            "role": "작업자",
            "completion_condition": "상세 화면이 보이면 완료",
            "input_values": {"LOT": "LOT-001"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "awaiting_plan_review"
    assert body["current_step"] == "plan_review"
    assert body["can_continue"] is True
    assert body["artifacts"]["action_plan_url"].endswith("/action_plan.json")
    assert body["artifacts"]["rehearsal_log_url"].endswith("/rehearsal_log.json")
    assert body["artifacts"]["video_url"] is None
    assert body["artifacts"]["html_preview_url"] is None

    package_dir = Path(body["package_dir"])
    assert (package_dir / "workflow_state.json").exists()
    assert not (package_dir / "capture_action_log.json").exists()
    assert not (package_dir / "manual_video_agent_usage.webm").exists()


def test_pipeline_draft_defers_live_mcp_when_login_is_required(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_OUTPUT_DIR", str(tmp_path))
    monkeypatch.setenv("MANUAL_AGENT_PLAYWRIGHT_MCP_MODE", "live")
    client = TestClient(app)

    response = client.post(
        "/api/pipeline/draft?capture_browser=false",
        json={
            "request_text": "사내 chatbot 서비스에 프롬프트를 입력하고 응답 결과를 확인",
            "target_url": "http://internal.example.local/chat",
            "role": "사용자",
            "completion_condition": "답변이 보이면 완료",
            "login_mode": "manual",
            "input_values": {"프롬프트": "사내 휴가 규정을 요약해줘"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["rehearsal"]["status"] == "deferred-until-authenticated"
    assert body["rehearsal"]["executed"] is False
    assert body["rehearsal"]["deferred_reason"] == "login_required"

    package_dir = Path(body["package_dir"])
    assert (package_dir / "playwright_mcp_calls.json").exists()
    assert not (package_dir / "playwright_mcp_execution.json").exists()


def test_pipeline_continue_api_runs_after_draft_plan_review(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_OUTPUT_DIR", str(tmp_path))
    client = TestClient(app)

    draft = client.post(
        "/api/pipeline/draft?capture_browser=false",
        json={
            "request_text": "MES에서 LOT 조회 방법 영상 만들기",
            "target_url": "http://127.0.0.1:8000/sample",
            "role": "작업자",
            "completion_condition": "상세 화면이 보이면 완료",
            "input_values": {"LOT": "LOT-001"},
        },
    ).json()

    response = client.post(f"/api/pipeline/continue/{draft['job_id']}?capture_browser=false")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "completed"
    assert body["job_id"] == draft["job_id"]
    assert body["artifacts"]["video_url"].endswith("/manual_video_agent_usage.webm")
    assert body["artifacts"]["html_preview_url"].endswith("/preview.html")
    assert client.get(body["artifacts"]["capture_action_log_url"]).json()["status"] == "skipped"
    workflow_state = json.loads((Path(body["package_dir"]) / "workflow_state.json").read_text(encoding="utf-8"))
    assert workflow_state["status"] == "completed"
    assert workflow_state["current_step"] == "completed"
    assert workflow_state["can_continue"] is False


def test_artifact_route_rejects_path_traversal(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_OUTPUT_DIR", str(tmp_path))
    client = TestClient(app)

    response = client.get("/artifacts/%2e%2e/README.md")

    assert response.status_code == 404


def test_package_manifest_records_audit_events_and_degradations(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_TTS_PROVIDER", "melotts")
    result = run_pipeline(
        PipelineInput(
            request_text="MES에서 LOT 조회 방법 영상 만들기",
            target_url="http://127.0.0.1:8000/sample",
            role="작업자",
            completion_condition="상세 화면이 보이면 완료",
            input_values={"LOT": "LOT-001", "라인": "A3"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    manifest = json.loads(result.artifacts.package_manifest.read_text(encoding="utf-8"))
    audit_path = Path(manifest["supporting_artifacts"]["audit_log"])
    events = [json.loads(line) for line in audit_path.read_text(encoding="utf-8").splitlines()]

    assert {event["actor"] for event in events}.issuperset(
        {"input_extractor", "planner", "rehearsal", "approval", "capture", "masking", "tts", "render", "opencode", "manifest"}
    )
    assert all(event["run_id"] == result.job_id for event in events)
    assert all("status" in event for event in events)
    assert manifest["degradations"]
    assert any(item["reason"] == "tts_silent_fallback" for item in manifest["degradations"])
    assert manifest["environment"]["python_version"]
    assert "playwright_browsers_path" in manifest["environment"]


def test_package_manifest_records_opencode_failure_as_degradation(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_ENABLE_OPENCODE", "true")
    monkeypatch.setenv("MANUAL_AGENT_OPENCODE_COMMAND", "definitely-missing-opencode-command")

    result = run_pipeline(
        PipelineInput(
            request_text="포털 조회 방법 영상 만들기",
            target_url="http://internal.example.local/portal",
            role="사용자",
            completion_condition="조회 결과",
            input_values={"사용자ID": "U100"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    manifest = json.loads(result.artifacts.package_manifest.read_text(encoding="utf-8"))
    opencode_metadata = json.loads(result.artifacts.opencode_metadata.read_text(encoding="utf-8"))

    assert opencode_metadata["status"] == "failed"
    assert any(item["actor"] == "opencode" and item["reason"] == "opencode_failed" for item in manifest["degradations"])


def test_audit_log_records_runtime_tool_usage_events(tmp_path):
    result = run_pipeline(
        PipelineInput(
            request_text="포털 권한 신청 영상 만들기",
            target_url="http://internal.example.local/portal",
            role="신청자",
            completion_condition="신청 완료 화면",
            input_values={"사용자ID": "U100"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    events = [json.loads(line) for line in result.artifacts.audit_log.read_text(encoding="utf-8").splitlines()]
    tools = {event["details"].get("tool") for event in events if event["actor"] == "tool"}

    assert {"llm", "playwright-python", "playwright-mcp", "ffmpeg", "tts", "hyperframes", "opencode"}.issubset(tools)
    assert all(event["run_id"] == result.job_id for event in events if event["actor"] == "tool")


def test_runtime_tool_log_marks_rag_disabled_when_context_toggle_is_false(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_RAG_RETRIEVE_URL", "http://api.net/elastic/v2/retrieve-rrf")
    monkeypatch.setenv("MANUAL_AGENT_RAG_API_KEY", "rag-key")
    monkeypatch.setenv("MANUAL_AGENT_RAG_DEP_TICKET", "credential:TICKET-123")
    monkeypatch.setenv("MANUAL_AGENT_RAG_INDEX_NAME", "manual-video")
    monkeypatch.setenv("MANUAL_AGENT_ENABLE_RAG_CONTEXT", "false")

    result = run_pipeline(
        PipelineInput(
            request_text="포털 권한 신청 영상 만들기",
            target_url="http://internal.example.local/portal",
            role="신청자",
            completion_condition="신청 완료 화면",
            input_values={"사용자ID": "U100"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    events = [json.loads(line) for line in result.artifacts.audit_log.read_text(encoding="utf-8").splitlines()]
    rag_event = next(event for event in events if event["actor"] == "tool" and event["details"].get("tool") == "rag")

    assert rag_event["status"] == "disabled"
    assert rag_event["details"]["enabled"] is False


def test_package_manifest_environment_fingerprint_does_not_include_secret_values(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_OPENAI_API_KEY", "super-secret-key")
    monkeypatch.setenv("MANUAL_AGENT_DEP_TICKET", "credential:SECRET")
    result = run_pipeline(
        PipelineInput(
            request_text="MES에서 LOT 조회 방법 영상 만들기",
            target_url="http://127.0.0.1:8000/sample",
            role="작업자",
            completion_condition="상세 화면이 보이면 완료",
            input_values={"LOT": "LOT-001", "password": "do-not-echo"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    manifest_text = result.artifacts.package_manifest.read_text(encoding="utf-8")

    assert "super-secret-key" not in manifest_text
    assert "credential:SECRET" not in manifest_text
    assert "do-not-echo" not in manifest_text


def test_pipeline_terminal_logs_are_disabled_by_default(tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("MANUAL_AGENT_ENABLE_TERMINAL_LOGS", raising=False)

    run_pipeline(
        PipelineInput(
            request_text="포털 권한 신청 영상 만들기",
            target_url="http://internal.example.local/portal",
            role="신청자",
            completion_condition="신청 완료 화면",
            input_values={"사용자ID": "U100"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    captured = capsys.readouterr()
    assert "[manual-agent]" not in captured.err


def test_pipeline_terminal_logs_all_stages_when_enabled_and_redacts_secrets(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_ENABLE_TERMINAL_LOGS", "true")
    monkeypatch.setenv("MANUAL_AGENT_OPENAI_API_KEY", "super-secret-key")
    monkeypatch.setenv("MANUAL_AGENT_DEP_TICKET", "credential:SECRET")

    result = run_pipeline(
        PipelineInput(
            request_text="포털 비밀번호 초기화 방법 영상 만들기",
            target_url="http://internal.example.local/portal",
            role="사용자",
            completion_condition="초기화 완료 화면",
            input_values={"password": "plain-password", "OTP": "123456"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    captured = capsys.readouterr()
    log_text = captured.err
    expected_actors = {
        "pipeline",
        "environment",
        "input_extractor",
        "planner",
        "rehearsal",
        "approval",
        "capture",
        "masking",
        "tts",
        "render",
        "opencode",
        "manifest",
    }
    for actor in expected_actors:
        assert f'"actor": "{actor}"' in log_text

    assert f'"run_id": "{result.job_id}"' in log_text
    assert '"status": "started"' in log_text
    assert '"status": "completed"' in log_text
    assert "super-secret-key" not in log_text
    assert "credential:SECRET" not in log_text
    assert "plain-password" not in log_text
    assert "123456" not in log_text
    assert "password" not in log_text.lower()
    assert "otp" not in log_text.lower()


def test_pipeline_terminal_logs_runtime_tool_usage_when_enabled(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_ENABLE_TERMINAL_LOGS", "true")

    run_pipeline(
        PipelineInput(
            request_text="포털 권한 신청 영상 만들기",
            target_url="http://internal.example.local/portal",
            role="신청자",
            completion_condition="신청 완료 화면",
            input_values={"사용자ID": "U100"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    log_text = capsys.readouterr().err

    for tool in ["llm", "playwright-python", "playwright-mcp", "ffmpeg", "tts", "hyperframes", "opencode"]:
        assert '"actor": "tool"' in log_text
        assert f'"tool": "{tool}"' in log_text
    assert '"component": "runtime"' in log_text


def test_generated_request_artifact_redacts_sensitive_input_values(tmp_path):
    result = run_pipeline(
        PipelineInput(
            request_text="MES에서 LOT 조회 방법 영상 만들기",
            target_url="http://127.0.0.1:8000/sample",
            role="작업자",
            completion_condition="상세 화면이 보이면 완료",
            input_values={
                "LOT": "LOT-001",
                "password": "plain-password",
                "otp_code": "123456",
                "api_key": "sk-secret",
            },
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    request_text = (result.package_dir / "request.json").read_text(encoding="utf-8")
    audit_text = result.artifacts.audit_log.read_text(encoding="utf-8")

    assert "LOT-001" in request_text
    assert "plain-password" not in request_text
    assert "123456" not in request_text
    assert "sk-secret" not in request_text
    assert "plain-password" not in audit_text
    assert "sk-secret" not in audit_text


def test_placeholder_capture_names_are_not_mes_specific(tmp_path):
    result = run_pipeline(
        PipelineInput(
            request_text="사내 포털 권한 신청 방법 영상 만들기",
            target_url="http://internal.example.local/portal",
            role="신청자",
            completion_condition="신청 완료 화면이 보이면 완료",
            input_values={"사용자ID": "U100", "부서": "AI센터"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    masking_log = json.loads(result.artifacts.masking_log.read_text(encoding="utf-8"))

    assert [item["capture"] for item in masking_log["entries"]] == ["step_intro.png", "step_inputs.png", "step_completion.png"]
    assert not (result.package_dir / "masked" / "step_search.png").exists()


def test_playwright_launch_kwargs_do_not_hardcode_user_chrome_path():
    settings = load_settings(environ={})

    launch_kwargs = _playwright_launch_kwargs(settings, browser_roots=[])

    rendered = json.dumps(launch_kwargs, ensure_ascii=False)
    assert "xiro1" not in rendered.lower()
    assert "chromium-1187" not in rendered
    assert launch_kwargs == {"headless": True}


def test_playwright_launch_kwargs_disables_headless_for_manual_login():
    settings = load_settings(environ={})

    launch_kwargs = _playwright_launch_kwargs(settings, interactive=True, browser_roots=[])

    assert launch_kwargs == {"headless": False}


def test_playwright_launch_kwargs_uses_configured_executable_path(tmp_path):
    chrome = tmp_path / "chrome.exe"
    chrome.write_text("", encoding="utf-8")
    settings = load_settings(environ={"MANUAL_AGENT_PLAYWRIGHT_EXECUTABLE_PATH": str(chrome)})

    launch_kwargs = _playwright_launch_kwargs(settings)

    assert launch_kwargs["headless"] is True
    assert launch_kwargs["executable_path"] == str(chrome)


def test_playwright_launch_kwargs_discovers_cached_chromium_without_hardcoded_revision(tmp_path):
    chrome = tmp_path / "chromium-9999" / "chrome-win" / "chrome.exe"
    chrome.parent.mkdir(parents=True)
    chrome.write_text("", encoding="utf-8")
    settings = load_settings(environ={})

    launch_kwargs = _playwright_launch_kwargs(settings, browser_roots=[tmp_path])

    assert launch_kwargs["headless"] is True
    assert launch_kwargs["executable_path"] == str(chrome)


def test_prepare_capture_page_waits_for_generic_js_ready_before_injecting_helpers():
    calls = []

    class FakePage:
        def goto(self, url, wait_until):
            calls.append(("goto", url, wait_until))

        def wait_for_load_state(self, state, timeout):
            calls.append(("wait_for_load_state", state, timeout))

        def wait_for_function(self, expression, timeout):
            calls.append(("wait_for_function", expression, timeout))

        def wait_for_selector(self, selector, timeout):
            raise AssertionError(f"sample-specific selector wait leaked into generic capture: {selector}")

        def add_style_tag(self, content):
            calls.append(("add_style_tag", "manual-caption" in content))

        def evaluate(self, script, *args):
            calls.append(("evaluate", script[:40], args))

    page = FakePage()

    _prepare_capture_page(page, "http://127.0.0.1:8000/sample")

    assert calls[0] == ("goto", "http://127.0.0.1:8000/sample", "load")
    assert ("wait_for_load_state", "networkidle", 5000) in calls
    assert any(call[0] == "wait_for_function" and "document.readyState" in call[1] for call in calls)
    assert all("data-action" not in str(call) for call in calls)
    assert calls[-2][0] == "add_style_tag"
    assert calls[-1][0] == "evaluate"


def test_execute_capture_actions_uses_plan_selectors_without_mes_defaults(tmp_path):
    calls = []

    class FakePage:
        def evaluate(self, script, *args):
            calls.append(("evaluate", script, args))

        def wait_for_timeout(self, timeout):
            calls.append(("wait_for_timeout", timeout))

        def fill(self, selector, value):
            calls.append(("fill", selector, value))

        def click(self, selector):
            calls.append(("click", selector))

        def screenshot(self, path, full_page):
            calls.append(("screenshot", Path(path).name, full_page))
            Path(path).write_bytes(b"png")

    plan = {
        "steps": [{"id": "step_1", "title": "사용자 검색", "caption": "사용자를 검색합니다.", "narration": "사용자를 검색합니다."}],
        "actions": [
            {"id": "a1", "type": "fill", "selector": "#user-id", "value": "U100", "step_id": "step_1"},
            {"id": "a2", "type": "click", "selector": "button.search", "step_id": "step_1"},
            {"id": "a3", "type": "capture_step", "step_id": "step_1"},
        ],
    }

    result = _execute_capture_actions(FakePage(), plan, tmp_path)

    assert [path.name for path in result["captures"]] == ["step_1.png"]
    assert ("fill", "#user-id", "U100") in calls
    assert ("click", "button.search") in calls
    rendered_calls = json.dumps(calls, ensure_ascii=False)
    assert "[name='lot']" not in rendered_calls
    assert "[data-action='search']" not in rendered_calls
    assert "[data-action='detail']" not in rendered_calls


def test_execute_capture_actions_runs_semantic_fill_and_text_clicks(tmp_path):
    calls = []

    class FakeLocator:
        def __init__(self, kind, value):
            self.kind = kind
            self.value = value

        def fill(self, value):
            calls.append(("fill", self.kind, self.value, value))

        def click(self):
            calls.append(("click", self.kind, self.value))

    class FakePage:
        def evaluate(self, script, *args):
            calls.append(("evaluate", args))

        def wait_for_timeout(self, timeout):
            calls.append(("wait_for_timeout", timeout))

        def get_by_label(self, text, **kwargs):
            calls.append(("get_by_label", text, kwargs))
            return FakeLocator("label", text)

        def get_by_role(self, role, **kwargs):
            calls.append(("get_by_role", role, kwargs))
            return FakeLocator(role, kwargs.get("name"))

        def screenshot(self, path, full_page):
            calls.append(("screenshot", Path(path).name, full_page))
            Path(path).write_bytes(b"png")

    plan = {
        "steps": [{"id": "step_search", "title": "조회", "caption": "조회합니다.", "narration": "조회합니다."}],
        "actions": [
            {"id": "a1", "type": "fill_by_label", "label": "LOT", "value": "LOT-001", "step_id": "step_search"},
            {"id": "a2", "type": "click_by_text", "texts": ["조회", "검색"], "step_id": "step_search"},
            {"id": "a3", "type": "capture_step", "step_id": "step_search"},
        ],
    }

    result = _execute_capture_actions(FakePage(), plan, tmp_path)

    assert ("fill", "label", "LOT", "LOT-001") in calls
    assert ("click", "button", "조회") in calls
    assert [entry["status"] for entry in result["action_log"][:2]] == ["ok", "ok"]
    assert [path.name for path in result["captures"]] == ["step_search.png"]


def test_execute_capture_actions_records_selector_failures_without_aborting(tmp_path):
    class FakePage:
        def evaluate(self, script, *args):
            pass

        def wait_for_timeout(self, timeout):
            pass

        def click(self, selector):
            raise TimeoutError(f"waiting for locator({selector!r}) to be visible")

        def screenshot(self, path, full_page):
            Path(path).write_bytes(b"png")

    plan = {
        "steps": [{"id": "step_1", "title": "대상 화면", "caption": "대상 화면", "narration": "대상 화면"}],
        "actions": [
            {"id": "a1", "type": "click", "selector": "[dataction='search']", "step_id": "step_1"},
            {"id": "a2", "type": "capture_step", "step_id": "step_1"},
        ],
    }

    result = _execute_capture_actions(FakePage(), plan, tmp_path)

    assert result["action_log"][0]["status"] == "failed"
    assert "TimeoutError" in result["action_log"][0]["error"]
    assert [path.name for path in result["captures"]] == ["step_1.png"]
    assert result["status"] == "degraded"
    assert result["degrade_reason"] == "capture_action_failed"


def test_execute_browser_agent_actions_marks_failed_dynamic_action_as_degraded(tmp_path):
    class FailingLocator:
        def click(self):
            raise TimeoutError("button not visible")

    class FakePage:
        def evaluate(self, script, *args):
            if "__manualSetCaption" in script or "__manualHighlight" in script:
                return None
            return {"url": "http://internal.example.local", "fields": [], "clickables": [{"text": "조회"}], "body_text": "조회"}

        def wait_for_timeout(self, timeout):
            pass

        def get_by_role(self, *args, **kwargs):
            return FailingLocator()

        def get_by_text(self, *args, **kwargs):
            return FailingLocator()

        def screenshot(self, path, full_page):
            Path(path).write_bytes(b"png")

    request = PipelineInput(
        request_text="조회 버튼을 눌러 결과 확인",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="조회 결과",
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS": "2",
            "MANUAL_AGENT_OPENAI_API_KEY": "key",
            "MANUAL_AGENT_LLM_BASE_URL": "http://llm.local",
            "MANUAL_AGENT_LLM_MODEL": "model",
            "MANUAL_AGENT_DEP_TICKET": "ticket",
            "MANUAL_AGENT_USER_ID": "user",
        }
    )
    decisions = [
        {"status": "ok", "type": "click_by_text", "texts": ["조회"], "reason": "조회합니다."},
        {"status": "ok", "type": "finish", "reason": "마칩니다."},
    ]

    def fake_decider(*_args, **_kwargs):
        return decisions.pop(0)

    result = _execute_browser_agent_actions(FakePage(), request, {"steps": [], "actions": []}, tmp_path, settings, decide_next=fake_decider)

    assert result["status"] == "degraded"
    assert result["degrade_reason"] == "browser_agent_action_failed"
    assert result["action_log"][0]["status"] == "failed"


def test_execute_browser_agent_actions_observes_page_and_executes_llm_actions(tmp_path):
    calls = []

    class FakeLocator:
        def __init__(self, kind, value):
            self.kind = kind
            self.value = value

        def fill(self, value):
            calls.append(("fill", self.kind, self.value, value))

        def click(self):
            calls.append(("click", self.kind, self.value))

    class FakePage:
        def evaluate(self, script, *args):
            if "__manualSetCaption" in script or "__manualHighlight" in script:
                calls.append(("evaluate_overlay", args))
                return None
            calls.append(("observe",))
            return {
                "url": "http://127.0.0.1:8000/sample",
                "title": "샘플 MES",
                "fields": [{"label": "LOT", "name": "lot", "value": ""}],
                "clickables": [{"text": "조회"}],
                "body_text": "LOT 조회",
            }

        def wait_for_timeout(self, timeout):
            calls.append(("wait_for_timeout", timeout))

        def get_by_label(self, text, **kwargs):
            calls.append(("get_by_label", text, kwargs))
            return FakeLocator("label", text)

        def get_by_role(self, role, **kwargs):
            calls.append(("get_by_role", role, kwargs))
            return FakeLocator(role, kwargs.get("name"))

        def screenshot(self, path, full_page):
            calls.append(("screenshot", Path(path).name, full_page))
            Path(path).write_bytes(b"png")

    request = PipelineInput(
        request_text="MES에서 LOT 조회 방법 영상 만들기",
        target_url="http://127.0.0.1:8000/sample",
        role="작업자",
        completion_condition="조회 결과가 보이면 완료",
        input_values={"LOT": "LOT-001"},
    )
    settings = load_settings(environ={"MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true", "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS": "3"})
    decisions = [
        {"status": "ok", "type": "fill_by_label", "label": "LOT", "value": "LOT-001", "reason": "LOT 값을 입력합니다."},
        {"status": "ok", "type": "click_by_text", "texts": ["조회"], "reason": "조회 버튼을 클릭합니다."},
        {"status": "ok", "type": "finish", "reason": "결과 화면을 확인했습니다."},
    ]

    def fake_decider(*args, **kwargs):
        return decisions.pop(0)

    result = _execute_browser_agent_actions(
        FakePage(),
        request,
        {"steps": [], "actions": []},
        tmp_path,
        settings,
        decide_next=fake_decider,
    )

    assert ("observe",) in calls
    assert ("fill", "label", "LOT", "LOT-001") in calls
    assert ("click", "button", "조회") in calls
    assert [path.name for path in result["captures"]] == ["browser_agent_step_3.png"]
    assert [entry["type"] for entry in result["action_log"] if entry.get("source") == "browser-agent-llm"] == [
        "fill_by_label",
        "click_by_text",
        "finish",
    ]


def test_execute_browser_agent_actions_degrades_to_plan_when_llm_is_not_configured(tmp_path):
    calls = []

    class FakePage:
        def evaluate(self, script, *args):
            calls.append(("evaluate", args))

        def wait_for_timeout(self, timeout):
            calls.append(("wait_for_timeout", timeout))

        def click(self, selector):
            calls.append(("click", selector))

        def screenshot(self, path, full_page):
            Path(path).write_bytes(b"png")

    request = PipelineInput(
        request_text="조회",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="조회 결과",
    )
    settings = load_settings(environ={"MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true"})
    plan = {
        "steps": [{"id": "step_1", "title": "조회", "caption": "조회", "narration": "조회"}],
        "actions": [
            {"id": "a1", "type": "click", "selector": "button.search", "step_id": "step_1"},
            {"id": "a2", "type": "capture_step", "step_id": "step_1"},
        ],
    }

    result = _execute_browser_agent_actions(FakePage(), request, plan, tmp_path, settings)

    assert result["status"] == "degraded"
    assert result["degrade_reason"] == "browser_agent_llm_not_configured"
    assert result["action_log"][0]["reason"] == "llm_not_configured"
    assert ("click", "button.search") in calls


def test_resolve_login_options_prefers_request_mode_and_env_credentials():
    settings = load_settings(
        environ={
            "MANUAL_AGENT_LOGIN_MODE": "none",
            "MANUAL_AGENT_LOGIN_USERNAME_SELECTOR": "#uid",
            "MANUAL_AGENT_LOGIN_PASSWORD_SELECTOR": "#pwd",
            "MANUAL_AGENT_LOGIN_SUBMIT_SELECTOR": "button.login",
            "MANUAL_AGENT_LOGIN_SUCCESS_SELECTOR": ".home",
            "MANUAL_AGENT_LOGIN_USERNAME": "user01",
            "MANUAL_AGENT_LOGIN_PASSWORD": "plain-password",
        }
    )
    request = PipelineInput(
        request_text="로그인 후 메뉴얼",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="홈 화면",
        login_mode="credentials",
        login_success_selector=".dashboard",
    )

    login = _resolve_login_options(request, settings)

    assert login["mode"] == "credentials"
    assert login["username"] == "user01"
    assert login["password"] == "plain-password"
    assert login["success_selector"] == ".dashboard"


def test_resolve_login_options_uses_env_mode_when_request_mode_is_empty():
    settings = load_settings(environ={"MANUAL_AGENT_LOGIN_MODE": "manual"})
    request = PipelineInput(
        request_text="로그인 후 메뉴얼",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="홈 화면",
    )

    login = _resolve_login_options(request, settings)

    assert login["mode"] == "manual"


def test_handle_login_uses_env_credentials_and_redacts_action_log():
    calls = []

    class FakePage:
        def fill(self, selector, value):
            calls.append(("fill", selector, value))

        def click(self, selector):
            calls.append(("click", selector))

        def wait_for_selector(self, selector, timeout):
            calls.append(("wait_for_selector", selector, timeout))

    login = {
        "mode": "credentials",
        "username_selector": "#uid",
        "password_selector": "#pwd",
        "submit_selector": "button.login",
        "success_selector": ".home",
        "username": "user01",
        "password": "plain-password",
        "credentials_timeout_ms": 30000,
        "manual_timeout_ms": 120000,
    }

    log = _handle_login(FakePage(), login)

    assert ("fill", "#uid", "user01") in calls
    assert ("fill", "#pwd", "plain-password") in calls
    assert ("click", "button.login") in calls
    assert ("wait_for_selector", ".home", 30000) in calls
    assert log["status"] == "ok"
    rendered_log = json.dumps(log, ensure_ascii=False)
    assert "plain-password" not in rendered_log
    assert "user01" not in rendered_log


def test_manual_login_waits_for_success_selector_without_credentials():
    calls = []

    class FakePage:
        def add_init_script(self, script):
            calls.append(("add_init_script", "로그인 완료" in script))

        def evaluate(self, script, *args):
            calls.append(("evaluate", "manualLoginSignal" in script, args))
            return {"completed": False, "successSelectorMatched": True}

        def wait_for_function(self, expression, *, arg=None, timeout):
            calls.append(("wait_for_function", "manualLoginCompleted" in expression, arg, timeout))

    login = {
        "mode": "manual",
        "success_selector": ".dashboard",
        "manual_timeout_ms": 90000,
        "credentials_timeout_ms": 30000,
    }

    log = _handle_login(FakePage(), login)

    assert calls[0] == ("add_init_script", True)
    assert any(call[0] == "evaluate" and call[2] == (".dashboard",) for call in calls)
    assert not any(call[0] == "wait_for_function" for call in calls)
    assert log == {
        "type": "login",
        "mode": "manual",
        "status": "ok",
        "success_selector_set": True,
        "signal_button_enabled": True,
        "completion_signal": "selector",
    }


def test_manual_login_installs_completion_button_and_waits_for_signal():
    calls = []

    class FakePage:
        def add_init_script(self, script):
            calls.append(("add_init_script", "manualLoginCompleted" in script and "로그인 완료" in script))

        def evaluate(self, script, *args):
            calls.append(("evaluate", "manualLoginSignal" in script, args))
            return {"completed": True, "successSelectorMatched": False}

        def wait_for_function(self, expression, *, arg=None, timeout):
            calls.append(("wait_for_function", "manualLoginCompleted" in expression, arg, timeout))

    login = {
        "mode": "manual",
        "success_selector": "",
        "manual_timeout_ms": 90000,
        "credentials_timeout_ms": 30000,
    }

    log = _handle_login(FakePage(), login)

    assert calls[0] == ("add_init_script", True)
    assert calls[1][0] == "evaluate"
    assert any(call[0] == "evaluate" and call[2] == ("",) for call in calls)
    assert not any(call[0] == "wait_for_function" for call in calls)
    assert log == {
        "type": "login",
        "mode": "manual",
        "status": "ok",
        "success_selector_set": False,
        "signal_button_enabled": True,
        "completion_signal": "button",
    }


def test_manual_login_accepts_python_binding_signal_when_page_window_flag_is_lost():
    calls = []
    exposed = {}

    class FakePage:
        def expose_function(self, name, callback):
            calls.append(("expose_function", name))
            exposed[name] = callback

        def add_init_script(self, script):
            calls.append(("add_init_script", "__manualLoginSignalFromPage" in script))

        def evaluate(self, script, *args):
            calls.append(("evaluate", "manualLoginCompleted" in script, args))
            return {"completed": False, "successSelectorMatched": False}

        def wait_for_timeout(self, timeout):
            calls.append(("wait_for_timeout", timeout))
            if "__manualLoginSignalFromPage" in exposed:
                exposed["__manualLoginSignalFromPage"]()
                exposed.clear()

        def wait_for_function(self, expression, *, arg=None, timeout=None):
            raise TimeoutError("window flag never reached playwright")

    login = {
        "mode": "manual",
        "success_selector": "",
        "manual_timeout_ms": 1000,
        "credentials_timeout_ms": 30000,
    }

    log = _handle_login(FakePage(), login)

    assert ("expose_function", "__manualLoginSignalFromPage") in calls
    assert log["status"] == "ok"
    assert log["completion_signal"] == "button"


def test_manual_login_removes_signal_button_after_completion():
    calls = []

    class FakePage:
        def add_init_script(self, script):
            calls.append(("add_init_script", script))

        def evaluate(self, script, *args):
            calls.append(("evaluate", script, args))
            return {"completed": True, "successSelectorMatched": False}

        def wait_for_function(self, expression, *, arg=None, timeout):
            calls.append(("wait_for_function", expression, arg, timeout))

    login = {
        "mode": "manual",
        "success_selector": "",
        "manual_timeout_ms": 90000,
        "credentials_timeout_ms": 30000,
    }

    log = _handle_login(FakePage(), login)

    assert log["status"] == "ok"
    assert any("__manualLoginCleanup" in call[1] for call in calls if call[0] == "evaluate")


def test_install_manual_login_signal_adds_persistent_button_script():
    calls = []

    class FakePage:
        def add_init_script(self, script):
            calls.append(("add_init_script", script))

        def evaluate(self, script, *args):
            calls.append(("evaluate", script, args))

    _install_manual_login_signal(FakePage())

    assert calls[0][0] == "add_init_script"
    assert "manual-login-signal" in calls[0][1]
    assert "로그인 완료" in calls[0][1]
    assert "MutationObserver" in calls[0][1]
    assert "setInterval" in calls[0][1]
    assert "__manualLoginCleanup" in calls[0][1]
    assert "clearInterval" in calls[0][1]
    assert "disconnect()" in calls[0][1]
    assert calls[1][0] == "evaluate"


def test_authenticate_before_recording_does_not_start_video_capture():
    context_options = []
    calls = []

    class FakePage:
        def goto(self, url, wait_until):
            calls.append(("goto", url, wait_until))

        def wait_for_load_state(self, state, timeout):
            calls.append(("wait_for_load_state", state, timeout))

        def wait_for_function(self, expression, timeout):
            calls.append(("wait_for_function", timeout))

        def add_style_tag(self, content):
            calls.append(("add_style_tag", "manual-caption" in content))

        def evaluate(self, script, *args):
            calls.append(("evaluate", args))

        def fill(self, selector, value):
            calls.append(("fill", selector, value))

        def click(self, selector):
            calls.append(("click", selector))

        def wait_for_selector(self, selector, timeout):
            calls.append(("wait_for_selector", selector, timeout))

    class FakeContext:
        def new_page(self):
            return FakePage()

        def storage_state(self):
            return {"cookies": [{"name": "sid", "value": "ok"}], "origins": []}

        def close(self):
            calls.append(("auth_context_close",))

    class FakeBrowser:
        def new_context(self, **kwargs):
            context_options.append(kwargs)
            return FakeContext()

    request = PipelineInput(
        request_text="로그인 후 매뉴얼",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="홈 화면",
        login_mode="credentials",
    )
    login = {
        "mode": "credentials",
        "username_selector": "#uid",
        "password_selector": "#pwd",
        "submit_selector": "#login",
        "success_selector": ".home",
        "username": "user01",
        "password": "plain-password",
        "credentials_timeout_ms": 30000,
        "manual_timeout_ms": 120000,
    }

    auth = _authenticate_before_recording(FakeBrowser(), request, login)

    assert context_options == [{"viewport": {"width": 1280, "height": 800}}]
    assert "record_video_dir" not in context_options[0]
    assert auth["storage_state"]["cookies"][0]["name"] == "sid"
    assert auth["action_log"][0]["status"] == "ok"
    assert ("fill", "#pwd", "plain-password") in calls


def test_authenticate_before_recording_does_not_return_storage_when_manual_login_fails():
    calls = []

    class FakePage:
        def goto(self, url, wait_until):
            calls.append(("goto", url, wait_until))

        def wait_for_load_state(self, state, timeout):
            calls.append(("wait_for_load_state", state, timeout))

        def wait_for_function(self, expression, *, arg=None, timeout=None):
            calls.append(("wait_for_function", expression, arg, timeout))
            if "manualLoginCompleted" in expression:
                raise TimeoutError("manual login was not confirmed")

        def add_style_tag(self, content):
            calls.append(("add_style_tag",))

        def add_init_script(self, script):
            calls.append(("add_init_script",))

        def evaluate(self, script, *args):
            calls.append(("evaluate", args))

    class FakeContext:
        def new_page(self):
            return FakePage()

        def storage_state(self):
            calls.append(("storage_state",))
            return {"cookies": [{"name": "sid", "value": "should-not-use"}], "origins": []}

        def close(self):
            calls.append(("auth_context_close",))

    class FakeBrowser:
        def new_context(self, **kwargs):
            return FakeContext()

    request = PipelineInput(
        request_text="로그인 후 매뉴얼",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="홈 화면",
        login_mode="manual",
    )
    login = {
        "mode": "manual",
        "success_selector": "",
        "credentials_timeout_ms": 30000,
        "manual_timeout_ms": 100,
    }

    auth = _authenticate_before_recording(FakeBrowser(), request, login)

    assert auth["storage_state"] is None
    assert auth["action_log"][0]["status"] == "failed"
    assert "manual login was not confirmed" in auth["action_log"][0]["error"]
    assert ("storage_state",) not in calls


def test_manual_capture_reuses_logged_in_recording_context(tmp_path, monkeypatch):
    import playwright.sync_api as sync_api

    events = []
    context_options = []

    class FakeLocator:
        def click(self):
            events.append(("locator_click",))

    class FakePage:
        def goto(self, url, wait_until):
            events.append(("goto", url, wait_until))

        def wait_for_load_state(self, state, timeout):
            events.append(("wait_for_load_state", state, timeout))

        def wait_for_function(self, expression, *args, **kwargs):
            events.append(("wait_for_function", "manualLoginCompleted" in expression, args, kwargs))

        def add_style_tag(self, content):
            events.append(("add_style_tag",))

        def add_init_script(self, script):
            events.append(("add_init_script",))

        def evaluate(self, script, *args):
            events.append(("evaluate", args))
            if "return { completed" in script:
                return {"completed": True, "successSelectorMatched": False}
            return None

        def wait_for_timeout(self, timeout):
            events.append(("wait_for_timeout", timeout))

        def screenshot(self, path, full_page):
            events.append(("screenshot", Path(path).name, full_page))
            Path(path).write_bytes(b"png")

        def get_by_role(self, *args, **kwargs):
            return FakeLocator()

    class FakeContext:
        def __init__(self, options):
            self.options = options

        def new_page(self):
            events.append(("new_page",))
            return FakePage()

        def storage_state(self):
            events.append(("storage_state",))
            return {"cookies": [{"name": "sid", "value": "manual"}], "origins": []}

        def close(self):
            events.append(("context_close",))
            raw_dir = self.options.get("record_video_dir")
            if raw_dir:
                Path(raw_dir).mkdir(parents=True, exist_ok=True)
                Path(raw_dir, "manual.webm").write_bytes(b"webm")

    class FakeBrowser:
        def new_context(self, **kwargs):
            context_options.append(kwargs)
            events.append(("new_context", bool(kwargs.get("record_video_dir"))))
            return FakeContext(kwargs)

        def close(self):
            events.append(("browser_close",))

    class FakeChromium:
        def launch(self, **kwargs):
            events.append(("launch", kwargs.get("headless")))
            return FakeBrowser()

    class FakePlaywright:
        chromium = FakeChromium()

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(sync_api, "sync_playwright", lambda: FakePlaywright())

    class Settings:
        playwright_executable_path = ""
        enable_browser_agent = False

        class login:
            mode = "manual"
            username_selector = ""
            password_selector = ""
            submit_selector = ""
            success_selector = ""
            username = ""
            password = ""
            manual_timeout_seconds = 120.0
            credentials_timeout_seconds = 30.0

    plan = {
        "steps": [{"id": "step_intro", "title": "홈", "caption": "홈", "narration": "홈"}],
        "actions": [
            {"id": "a1", "type": "navigate", "target": "http://internal.example.local", "step_id": "step_intro"},
            {"id": "a2", "type": "capture_step", "step_id": "step_intro"},
        ],
    }
    dirs = _make_dirs(tmp_path / "package")
    request = PipelineInput(
        request_text="로그인 후 화면 확인",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="홈",
        login_mode="manual",
    )

    result = _capture_with_playwright(request, plan, dirs, Settings())

    assert len(context_options) == 1
    assert "record_video_dir" in context_options[0]
    assert result["action_log"][0]["type"] == "login"
    assert result["action_log"][0]["status"] == "ok"
    assert ("storage_state",) not in events
    assert events.count(("new_page",)) == 1
    assert result["video"].exists()


def test_capture_with_playwright_creates_degraded_placeholder_when_recording_is_missing(tmp_path, monkeypatch):
    import playwright.sync_api as sync_api

    events = []

    class FakePage:
        def goto(self, url, wait_until):
            events.append(("goto", url, wait_until))

        def wait_for_load_state(self, state, timeout):
            events.append(("wait_for_load_state", state, timeout))

        def wait_for_function(self, expression, timeout):
            events.append(("wait_for_function", timeout))

        def add_style_tag(self, content):
            events.append(("add_style_tag",))

        def evaluate(self, script, *args):
            events.append(("evaluate", args))

        def wait_for_timeout(self, timeout):
            events.append(("wait_for_timeout", timeout))

        def screenshot(self, path, full_page):
            events.append(("screenshot", Path(path).name, full_page))
            Path(path).write_bytes(b"png")

    class FakeContext:
        def new_page(self):
            return FakePage()

        def close(self):
            events.append(("context_close_without_video",))

    class FakeBrowser:
        def new_context(self, **kwargs):
            events.append(("new_context", bool(kwargs.get("record_video_dir"))))
            return FakeContext()

        def close(self):
            events.append(("browser_close",))

    class FakeChromium:
        def launch(self, **kwargs):
            events.append(("launch", kwargs.get("headless")))
            return FakeBrowser()

    class FakePlaywright:
        chromium = FakeChromium()

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(sync_api, "sync_playwright", lambda: FakePlaywright())

    class Settings:
        playwright_executable_path = ""
        enable_browser_agent = False

        class login:
            mode = "none"
            username_selector = ""
            password_selector = ""
            submit_selector = ""
            success_selector = ""
            username = ""
            password = ""
            manual_timeout_seconds = 120.0
            credentials_timeout_seconds = 30.0

    plan = {
        "steps": [{"id": "step_intro", "title": "홈", "caption": "홈", "narration": "홈"}],
        "actions": [{"id": "a1", "type": "capture_step", "step_id": "step_intro"}],
    }
    dirs = _make_dirs(tmp_path / "package")
    request = PipelineInput(
        request_text="화면 확인",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="홈",
    )

    result = _capture_with_playwright(request, plan, dirs, Settings())

    assert result["video"].exists()
    assert result["status"] == "degraded"
    assert result["degrade_reason"] == "browser_recording_missing"


def test_raise_if_login_failed_aborts_capture_on_failed_login():
    auth_result = {
        "storage_state": None,
        "action_log": [
            {
                "type": "login",
                "mode": "manual",
                "status": "failed",
                "error": "TimeoutError: manual login was not confirmed",
            }
        ],
    }

    with pytest.raises(RuntimeError, match="login did not complete; capture aborted"):
        _raise_if_login_failed(auth_result)
