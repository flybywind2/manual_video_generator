import json
import shutil
import subprocess
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.main import app
import backend.app.pipeline as pipeline_module
from backend.app.config import load_settings
from backend.app.pipeline import (
    PipelineInput,
    _authenticate_before_recording,
    _capture_action_log_status,
    _capture_with_playwright,
    _execute_capture_actions,
    _execute_browser_agent_actions,
    _execute_single_browser_agent_action,
    _media_plan_with_tts_durations,
    _media_plan_for_outputs,
    _handle_login,
    _install_manual_login_signal,
    _install_demonstration_recorder,
    _inject_recording_helpers,
    _make_dirs,
    _mask_captures,
    _playwright_launch_kwargs,
    _prepare_capture_page,
    _requires_login_before_mcp_rehearsal,
    _render_capture_slideshow_video,
    _render_subtitles,
    _raise_if_login_failed,
    _resolve_login_options,
    _step_audio_durations,
    _write_selector_trace,
    rerender_pipeline_package,
    run_pipeline,
)


def test_playwright_launch_kwargs_falls_back_to_installed_chrome(tmp_path, monkeypatch):
    chrome = tmp_path / "chrome.exe"
    chrome.write_text("fake", encoding="utf-8")
    monkeypatch.setenv("CHROME_PATH", str(chrome))

    class Settings:
        playwright_executable_path = ""
        login = type("Login", (), {"browser_channel": ""})()

    kwargs = _playwright_launch_kwargs(Settings(), browser_roots=[])

    assert kwargs["executable_path"] == str(chrome)


def test_execute_capture_actions_supports_scroll_action(tmp_path):
    calls = []

    class FakePage:
        def evaluate(self, script, *args):
            calls.append(("evaluate", args))

        def wait_for_timeout(self, timeout):
            calls.append(("wait_for_timeout", timeout))

        def screenshot(self, path, full_page):
            Path(path).write_bytes(b"png")

    plan = {
        "steps": [{"id": "s1", "title": "스크롤", "caption": "아래 내용을 확인합니다."}],
        "actions": [
            {"id": "a1", "type": "scroll", "step_id": "s1", "direction": "down", "amount": 640},
            {"id": "a2", "type": "capture_step", "step_id": "s1"},
        ],
    }

    result = _execute_capture_actions(FakePage(), plan, tmp_path)

    assert result["status"] == "ok"
    assert any(call[0] == "evaluate" and call[1] == (640,) for call in calls)
    assert result["captures"][0].exists()


def test_browser_agent_executes_click_by_selector_action(tmp_path):
    calls = []

    class FakeLocator:
        def __init__(self, selector):
            self.selector = selector

        def click(self):
            calls.append(("click", self.selector))

    class FakePage:
        def evaluate(self, script, *args):
            calls.append(("evaluate", args))

        def wait_for_timeout(self, timeout):
            calls.append(("wait_for_timeout", timeout))

        def locator(self, selector):
            return FakeLocator(selector)

        def screenshot(self, path, full_page):
            Path(path).write_bytes(b"png")

    request = PipelineInput(
        request_text="텍스트 없는 더하기 아이콘을 누른 뒤 화면 캡처",
        target_url="http://127.0.0.1:8000",
        role="관리자",
        completion_condition="모달 확인",
    )
    settings = load_settings(environ={"MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true", "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS": "2"})
    observations = [
        {
            "url": request.target_url,
            "title": "sample",
            "headings": ["sample"],
            "fields": [],
            "clickables": [{"selector": "i.icon.icon-plus-bold", "class_name": "icon icon-plus-bold"}],
            "body_text": "sample",
        },
        {
            "url": request.target_url,
            "title": "sample",
            "headings": ["modal"],
            "fields": [],
            "clickables": [],
            "body_text": "modal opened",
        },
    ]

    def observe(page):
        return observations[min(len([call for call in calls if call[0] == "observe"]), len(observations) - 1)]

    def decide_next(request, settings, observation, history, *, step_index):
        calls.append(("observe", step_index))
        if step_index == 1:
            return {
                "status": "ok",
                "source": "test",
                "type": "click_by_selector",
                "selector": "i.icon.icon-plus-bold",
                "reason": "더하기 아이콘을 클릭합니다.",
            }
        return {"status": "ok", "source": "test", "type": "finish", "reason": "완료"}

    result = _execute_browser_agent_actions(
        FakePage(),
        request,
        {"steps": [], "actions": []},
        tmp_path,
        settings,
        decide_next=decide_next,
        observe_page=observe,
    )

    assert result["status"] == "ok"
    assert ("click", "i.icon.icon-plus-bold") in calls
    assert result["action_log"][0]["method"] == "locator:i.icon.icon-plus-bold"
    assert result["captures"]


def test_capture_slideshow_video_replaces_invalid_recording(tmp_path):
    pytest.importorskip("PIL")
    from PIL import Image

    capture = tmp_path / "capture.png"
    Image.new("RGB", (320, 180), "white").save(capture)

    video = _render_capture_slideshow_video(tmp_path, [capture])

    assert video.exists()
    assert video.stat().st_size > 1024


def test_capture_slideshow_video_resolves_relative_package_paths(
    tmp_path,
    monkeypatch,
):
    pytest.importorskip("PIL")
    from PIL import Image

    monkeypatch.chdir(tmp_path)
    package_dir = Path("relative-job")
    package_dir.mkdir()
    capture = package_dir / "capture.png"
    Image.new("RGB", (320, 180), "white").save(capture)

    video = _render_capture_slideshow_video(package_dir, [capture])

    assert video.is_absolute()
    assert video.exists()
    assert video.stat().st_size > 1024


def test_capture_slideshow_video_uses_per_frame_timeline_durations(tmp_path):
    pytest.importorskip("PIL")
    from PIL import Image

    first = tmp_path / "01_01_first.png"
    second = tmp_path / "02_01_second.png"
    Image.new("RGB", (320, 180), "white").save(first)
    Image.new("RGB", (320, 180), "black").save(second)

    video = _render_capture_slideshow_video(
        tmp_path,
        [first, second],
        frame_durations_seconds={first.name: 1.25, second.name: 2.5},
    )

    concat = (tmp_path / "capture_slideshow.ffconcat").read_text(encoding="utf-8")
    assert "duration 1.25" in concat
    assert "duration 2.5" in concat
    assert video.exists()
    assert video.stat().st_size > 1024
    ffprobe = shutil.which("ffprobe")
    assert ffprobe
    probe = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(video)],
        check=True,
        capture_output=True,
        text=True,
    )
    assert float(probe.stdout.strip()) == pytest.approx(3.75, abs=0.15)


def test_mask_captures_does_not_add_unrequested_top_right_overlay(tmp_path):
    pytest.importorskip("PIL")
    from PIL import Image, ImageChops

    capture = tmp_path / "capture.png"
    masked_dir = tmp_path / "masked"
    masked_dir.mkdir()
    Image.new("RGB", (1280, 800), (12, 34, 56)).save(capture)

    log_path = _mask_captures([capture], masked_dir, {})

    with Image.open(capture).convert("RGB") as original, Image.open(masked_dir / capture.name).convert("RGB") as masked:
        assert ImageChops.difference(original, masked).getbbox() is None
    log = json.loads(log_path.read_text(encoding="utf-8"))
    assert log["entries"][0]["rules"] == []
    assert "top-right-session-area" not in log_path.read_text(encoding="utf-8")


def _legacy_test_pipeline_passes_tts_audio_to_video_renderer(tmp_path, monkeypatch):
    captured = {}

    class RenderResult:
        def __init__(self, package_dir: Path):
            self.video_path = package_dir / "manual_video_agent_usage.mp4"
            self.video_path.write_bytes(b"video")
            self.composition_dir = package_dir / "hyperframes"
            self.composition_dir.mkdir(exist_ok=True)
            self.composition_dir.joinpath("index.html").write_text("<html></html>", encoding="utf-8")
            self.metadata_path = package_dir / "video_render.json"
            self.metadata_path.write_text("{}", encoding="utf-8")
            self.skills_metadata_path = package_dir / "hyperframes_skills.json"
            self.skills_metadata_path.write_text("{}", encoding="utf-8")
            self.used_fallback = False

    def fake_render_final_video(**kwargs):
        captured["tts_audio"] = kwargs.get("tts_audio")
        return RenderResult(kwargs["package_dir"])

    monkeypatch.setattr(pipeline_module, "render_final_video", fake_render_final_video)

    result = run_pipeline(
        PipelineInput(
            request_text="사내 시스템 사용법",
            target_url="http://127.0.0.1:8000/sample",
            role="사용자",
            completion_condition="완료",
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    assert result.artifacts.tts_audio
    assert captured["tts_audio"] == result.artifacts.tts_audio


def _legacy_test_supertonic_manual_includes_ai_voice_license_notice(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_TTS_PROVIDER", "supertonic")
    monkeypatch.setenv("MANUAL_AGENT_SUPERTONIC_VOICE", "M1")
    monkeypatch.setenv("MANUAL_AGENT_SUPERTONIC_LANG", "ko")
    monkeypatch.setenv("MANUAL_AGENT_SUPERTONIC_AUTO_DOWNLOAD", "false")

    result = run_pipeline(
        PipelineInput(
            request_text="MES에서 LOT 조회 방법 영상 만들기",
            target_url="http://127.0.0.1:8000/sample",
            role="작업자",
            completion_condition="상세 화면이 보이면 완료",
            input_values={"LOT": "LOT-001"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    manual = result.artifacts.markdown_manual.read_text(encoding="utf-8")
    assert "AI 음성 합성" in manual
    assert "Supertone/supertonic-3" in manual
    assert "BigScience Open RAIL-M License" in manual
    assert "preset voice" in manual


def _legacy_test_package_manifest_lists_all_generated_supporting_artifacts(tmp_path):
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
        "support_log",
        "capture_action_log",
        "selector_trace",
        "subtitles",
        "media_plan",
        "hyperframes_composition",
        "hyperframes_manifest",
    }
    assert expected.issubset(supporting)
    for key in expected:
        assert supporting[key], key
        assert Path(supporting[key]).exists(), key
    assert "artifact_dependencies" in manifest
    assert "manual.md" in manifest["artifact_dependencies"]
    assert "subtitles.vtt" in manifest["artifact_dependencies"]


def _legacy_test_run_pipeline_extracts_missing_input_values_before_planning(tmp_path):
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
    assert request_payload["agent_brief"]["task_type"] == "lookup"
    assert "조회" in request_payload["agent_brief"]["safe_click_intents"]
    assert extraction["scenario_brief"]["required_inputs"] == ["LOT", "라인"]
    assert any(action["type"] == "fill_by_label" and action["label"] == "LOT" for action in action_plan["actions"])
    assert any(action["type"] == "fill_by_label" and action["label"] == "라인" for action in action_plan["actions"])
    assert result.artifacts.input_extraction.exists()
    assert (result.package_dir / "selector_trace.json").exists()


def _legacy_test_pipeline_writes_support_log_for_internal_test_feedback(tmp_path):
    result = run_pipeline(
        PipelineInput(
            request_text="사내 시스템 테스트",
            target_url="http://127.0.0.1:8000/sample",
            role="테스터",
            completion_condition="결과 확인",
            input_values={"검색어": "ABC"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    support_log = result.package_dir / "support_log.md"
    content = support_log.read_text(encoding="utf-8")
    manifest = json.loads(result.artifacts.package_manifest.read_text(encoding="utf-8"))

    assert support_log.exists()
    assert "# Manual Video Agent Support Log" in content
    assert result.job_id in content
    assert "## 타이핑용 요약" in content
    assert "short_code:" in content
    assert "상태:" in content
    assert "단계:" in content
    assert "## 사용자 전달 메모" in content
    assert "workflow_state.json" in content
    assert "package_manifest.json" in content
    assert manifest["supporting_artifacts"]["support_log"] == str(support_log)


def _legacy_test_run_pipeline_falls_back_to_placeholder_when_browser_capture_raises(tmp_path, monkeypatch):
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


def _legacy_test_pipeline_api_runs_and_returns_artifact_urls(tmp_path, monkeypatch):
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
    assert body["artifacts"]["video_url"].endswith(("/manual_video_agent_usage.webm", "/manual_video_agent_usage.mp4"))
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
    assert body["artifacts"]["subtitles_url"].endswith("/subtitles.vtt")
    audit_response = client.get(body["supporting_artifacts"]["audit_log"])
    assert audit_response.status_code == 200
    assert "planner" in audit_response.text
    capture_action_log = client.get(body["supporting_artifacts"]["capture_action_log"])
    assert capture_action_log.status_code == 200
    assert capture_action_log.json()["status"] == "skipped"
    assert client.get(body["artifacts"]["input_extraction_url"]).status_code == 200
    assert client.get(body["artifacts"]["subtitles_url"]).status_code == 200


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


def test_pipeline_draft_persists_selected_execution_mode(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_OUTPUT_DIR", str(tmp_path))
    client = TestClient(app)

    response = client.post(
        "/api/pipeline/draft?capture_browser=true",
        json={
            "request_text": "사내 챗봇에 프롬프트를 입력하고 답변 확인",
            "target_url": "http://internal.example.local/chat",
            "role": "사용자",
            "completion_condition": "답변이 보이면 완료",
            "execution_mode": "demonstration",
            "input_values": {"프롬프트": "휴가 신청 절차 알려줘"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["execution_mode"] == "demonstration"
    workflow_state = json.loads((Path(body["package_dir"]) / "workflow_state.json").read_text(encoding="utf-8"))
    assert workflow_state["request"]["execution_mode"] == "demonstration"


def test_pipeline_draft_keeps_opencode_pending_for_manual_login_request(tmp_path, monkeypatch):
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
    assert body["rehearsal"]["status"] == "pending"
    assert body["rehearsal"]["executed"] is False
    assert body["rehearsal"]["adapter"] == "opencode-playwright-mcp"

    package_dir = Path(body["package_dir"])
    mcp_calls = json.loads((package_dir / "playwright_mcp_calls.json").read_text(encoding="utf-8"))
    assert mcp_calls["status"] == "pending"
    assert not (package_dir / "playwright_mcp_execution.json").exists()


def test_sso_profile_does_not_defer_mcp_rehearsal_as_prelogin():
    settings = load_settings(
        environ={
            "MANUAL_AGENT_LOGIN_MODE": "sso_profile",
            "MANUAL_AGENT_USER_DATA_DIR": "C:\\AppBundle\\manualgen\\browser-profile",
            "MANUAL_AGENT_BROWSER_CHANNEL": "msedge",
        }
    )
    request = PipelineInput(
        request_text="모달창을 확인하고 닫기",
        target_url="http://internal.example.local/app",
        role="사용자",
        completion_condition="모달이 닫히면 완료",
        execution_mode="ai",
        login_mode="sso_profile",
    )

    assert _requires_login_before_mcp_rehearsal(request, settings) is False


def test_pipeline_draft_keeps_opencode_pending_for_auth_url(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_OUTPUT_DIR", str(tmp_path))
    monkeypatch.setenv("MANUAL_AGENT_PLAYWRIGHT_MCP_MODE", "live")
    client = TestClient(app)

    response = client.post(
        "/api/pipeline/draft?capture_browser=false",
        json={
            "request_text": "사내 시스템 메뉴얼 작성",
            "target_url": "http://internal.example.local/login",
            "role": "사용자",
            "completion_condition": "홈 화면",
            "login_mode": "none",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["rehearsal"]["status"] == "pending"
    assert body["rehearsal"]["executed"] is False

    package_dir = Path(body["package_dir"])
    mcp_calls = json.loads((package_dir / "playwright_mcp_calls.json").read_text(encoding="utf-8"))
    assert mcp_calls["status"] == "pending"
    assert not (package_dir / "playwright_mcp_execution.json").exists()


def _legacy_test_pipeline_continue_api_runs_after_draft_plan_review(tmp_path, monkeypatch):
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
    assert body["artifacts"]["video_url"].endswith(("/manual_video_agent_usage.webm", "/manual_video_agent_usage.mp4"))
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


def _legacy_test_text_artifact_api_allows_editing_generated_markdown(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_OUTPUT_DIR", str(tmp_path))
    result = run_pipeline(
        PipelineInput(
            request_text="MES에서 LOT 조회 방법 영상 만들기",
            target_url="http://127.0.0.1:8000/sample",
            role="작업자",
            completion_condition="상세 화면이 보이면 완료",
            input_values={"LOT": "LOT-001"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )
    relative_path = result.artifacts.markdown_manual.relative_to(tmp_path).as_posix()
    client = TestClient(app)

    read_response = client.get(f"/api/artifacts/text/{relative_path}")
    save_response = client.put(f"/api/artifacts/text/{relative_path}", json={"content": "# 수정된 매뉴얼\n\n사용자 편집본"})

    assert read_response.status_code == 200
    assert read_response.json()["editable"] is True
    assert "MES에서 LOT 조회" in read_response.json()["content"]
    assert save_response.status_code == 200
    assert save_response.json()["saved"] is True
    assert result.artifacts.markdown_manual.read_text(encoding="utf-8") == "# 수정된 매뉴얼\n\n사용자 편집본"
    edit_log = result.package_dir / "artifact_edit_log.jsonl"
    assert edit_log.exists()
    edit_event = json.loads(edit_log.read_text(encoding="utf-8").splitlines()[-1])
    assert edit_event["artifact"] == "manual.md"
    assert edit_event["before_sha256"] != edit_event["after_sha256"]


def _legacy_test_text_artifact_api_rejects_non_text_and_path_traversal(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_OUTPUT_DIR", str(tmp_path))
    result = run_pipeline(
        PipelineInput(
            request_text="MES에서 LOT 조회 방법 영상 만들기",
            target_url="http://127.0.0.1:8000/sample",
            role="작업자",
            completion_condition="상세 화면이 보이면 완료",
            input_values={"LOT": "LOT-001"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )
    video_path = result.artifacts.video.relative_to(tmp_path).as_posix()
    client = TestClient(app)

    assert client.get(f"/api/artifacts/text/{video_path}").status_code == 415
    assert client.get("/api/artifacts/text/%2e%2e/README.md").status_code == 404


def _legacy_test_rerender_pipeline_package_uses_edited_subtitles_without_recapture(tmp_path):
    result = run_pipeline(
        PipelineInput(
            request_text="사내 챗봇 시연",
            target_url="http://127.0.0.1:8000/sample",
            role="사용자",
            completion_condition="답변",
            input_values={"질문": "원본 질문"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )
    result.artifacts.markdown_manual.write_text("# 사용자가 편집한 매뉴얼\n\n보존되어야 합니다.", encoding="utf-8")
    result.artifacts.subtitles.write_text(
        "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\n편집된 자막 제목\n편집된 자막 캡션\n",
        encoding="utf-8",
    )
    before_capture_events = result.artifacts.audit_log.read_text(encoding="utf-8").count('"actor": "capture"')

    rerendered = rerender_pipeline_package(result.job_id, base_dir=tmp_path)

    tts_metadata = json.loads(rerendered.artifacts.tts_metadata.read_text(encoding="utf-8"))
    preview = rerendered.artifacts.html_preview.read_text(encoding="utf-8")
    audit_text = rerendered.artifacts.audit_log.read_text(encoding="utf-8")

    assert rerendered.job_id == result.job_id
    assert "편집된 자막 제목" in tts_metadata["entries"][0]["text"]
    assert "편집된 자막 캡션" in preview
    assert result.artifacts.markdown_manual.read_text(encoding="utf-8").startswith("# 사용자가 편집한 매뉴얼")
    assert audit_text.count('"actor": "capture"') == before_capture_events
    assert '"actor": "rerender"' in audit_text
    assert (result.package_dir / "media_plan.json").exists()


def _legacy_test_pipeline_rerender_api_returns_updated_artifacts(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_OUTPUT_DIR", str(tmp_path))
    result = run_pipeline(
        PipelineInput(
            request_text="MES에서 LOT 조회 방법 영상 만들기",
            target_url="http://127.0.0.1:8000/sample",
            role="작업자",
            completion_condition="상세 화면이 보이면 완료",
            input_values={"LOT": "LOT-001"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )
    result.artifacts.subtitles.write_text(
        "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\n재렌더 제목\n재렌더 캡션\n",
        encoding="utf-8",
    )
    client = TestClient(app)

    response = client.post(f"/api/pipeline/rerender/{result.job_id}")

    assert response.status_code == 200
    body = response.json()
    assert body["job_id"] == result.job_id
    assert body["status"] == "completed"
    assert body["artifacts"]["video_url"]
    assert client.get(body["artifacts"]["html_preview_url"]).status_code == 200
    assert "재렌더 제목" in result.artifacts.tts_metadata.read_text(encoding="utf-8")


def test_pipeline_rerender_api_rejects_invalid_job_id(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_OUTPUT_DIR", str(tmp_path))
    client = TestClient(app)

    response = client.post("/api/pipeline/rerender/%2e%2e/%2e%2e/outside")

    assert response.status_code == 404


def _legacy_test_package_manifest_records_audit_events_without_tts_fallback(tmp_path, monkeypatch):
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
    assert not any(item["reason"] == "tts_silent_fallback" for item in manifest["degradations"])
    assert not any(item["reason"] == "tts_silent_fallback" for item in manifest["fallback_events"])
    tts_metadata = json.loads(result.artifacts.tts_metadata.read_text(encoding="utf-8"))
    assert tts_metadata["status"] == "completed"
    assert {entry["provider"] for entry in tts_metadata["entries"]} == {"supertonic"}
    assert {entry["speaker"] for entry in tts_metadata["entries"]} == {"M1"}
    assert {entry["language"] for entry in tts_metadata["entries"]} == {"ko"}
    assert manifest["environment"]["python_version"]
    assert "playwright_browsers_path" in manifest["environment"]


def _legacy_test_package_manifest_records_opencode_failure_as_degradation(tmp_path, monkeypatch):
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
    assert any(item["actor"] == "opencode" and item["details"]["enabled"] is True for item in manifest["fallback_events"])


def _legacy_test_strict_mode_raises_instead_of_capture_fallback(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_STRICT_MODE", "true")

    def fail_capture(*_args, **_kwargs):
        raise RuntimeError("browser launch failed")

    monkeypatch.setattr(pipeline_module, "_capture_with_playwright", fail_capture)

    with pytest.raises(RuntimeError, match="browser launch failed"):
        run_pipeline(
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


def _legacy_test_audit_log_records_runtime_tool_usage_events(tmp_path):
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


def _legacy_test_runtime_tool_log_marks_rag_disabled_when_context_toggle_is_false(tmp_path, monkeypatch):
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


def _legacy_test_package_manifest_environment_fingerprint_does_not_include_secret_values(tmp_path, monkeypatch):
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


def _legacy_test_pipeline_terminal_logs_are_disabled_by_default(tmp_path, capsys, monkeypatch):
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


def _legacy_test_pipeline_terminal_logs_all_stages_when_enabled_and_redacts_secrets(tmp_path, capsys, monkeypatch):
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


def _legacy_test_pipeline_terminal_logs_runtime_tool_usage_when_enabled(tmp_path, capsys, monkeypatch):
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


def _legacy_test_generated_request_artifact_redacts_sensitive_input_values(tmp_path):
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


def _legacy_test_redaction_pipeline_scrubs_sensitive_values_from_manual_and_subtitles(tmp_path):
    result = run_pipeline(
        PipelineInput(
            request_text="비밀번호로 로그인 후 조회",
            target_url="http://example.local",
            role="작업자",
            completion_condition="password=super-secret 토큰이 보이지 않음",
            input_values={"password": "super-secret", "LOT": "LOT-001"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    manual = result.artifacts.markdown_manual.read_text(encoding="utf-8")
    subtitles = result.artifacts.subtitles.read_text(encoding="utf-8")
    assert "super-secret" not in manual
    assert "super-secret" not in subtitles
    assert "LOT-001" in manual


def _legacy_test_placeholder_capture_names_are_not_mes_specific(tmp_path):
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


def test_playwright_launch_kwargs_uses_browser_channel_only_when_requested():
    settings = load_settings(
        environ={
            "MANUAL_AGENT_BROWSER_CHANNEL": "msedge",
            "MANUAL_AGENT_AUTH_SERVER_ALLOWLIST": "*.corp.local",
            "MANUAL_AGENT_AUTH_NEGOTIATE_DELEGATE_ALLOWLIST": "*.corp.local",
        }
    )

    normal_kwargs = _playwright_launch_kwargs(settings, browser_roots=[])
    sso_kwargs = _playwright_launch_kwargs(settings, interactive=True, use_browser_channel=True, browser_roots=[])

    assert "channel" not in normal_kwargs
    assert "args" not in normal_kwargs
    assert sso_kwargs["headless"] is False
    assert sso_kwargs["channel"] == "msedge"
    assert sso_kwargs["args"] == [
        "--auth-server-allowlist=*.corp.local",
        "--auth-negotiate-delegate-allowlist=*.corp.local",
    ]


def test_playwright_launch_kwargs_does_not_discover_chromium_when_browser_channel_is_used(tmp_path):
    cached_chromium = tmp_path / "chromium-9999" / "chrome-win" / "chrome.exe"
    cached_chromium.parent.mkdir(parents=True)
    cached_chromium.write_text("", encoding="utf-8")
    settings = load_settings(environ={"MANUAL_AGENT_BROWSER_CHANNEL": "msedge"})

    launch_kwargs = _playwright_launch_kwargs(
        settings,
        interactive=True,
        use_browser_channel=True,
        browser_roots=[tmp_path],
    )

    assert launch_kwargs["channel"] == "msedge"
    assert "executable_path" not in launch_kwargs


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

    assert calls[0] == ("goto", "http://127.0.0.1:8000/sample", "domcontentloaded")
    assert ("wait_for_load_state", "networkidle", 5000) in calls
    assert any(call[0] == "wait_for_function" and "document.readyState" in call[1] for call in calls)
    assert any(call[0] == "wait_for_function" and "interactive" in call[1] for call in calls)
    assert all("data-action" not in str(call) for call in calls)
    assert calls[-2][0] == "add_style_tag"
    assert calls[-1][0] == "evaluate"


def test_prepare_capture_page_does_not_wait_for_full_load_before_demonstration():
    calls = []

    class FakePage:
        def goto(self, url, wait_until):
            calls.append(("goto", url, wait_until))
            if wait_until == "load":
                raise TimeoutError("full load never finished")

        def wait_for_load_state(self, state, timeout):
            calls.append(("wait_for_load_state", state, timeout))

        def wait_for_function(self, expression, timeout):
            calls.append(("wait_for_function", expression, timeout))

        def add_style_tag(self, content):
            calls.append(("add_style_tag", "manual-caption" in content))

        def evaluate(self, script, *args):
            calls.append(("evaluate", script[:40], args))

    _prepare_capture_page(FakePage(), "https://example.test/app")

    assert ("goto", "https://example.test/app", "domcontentloaded") in calls
    assert not any(call == ("goto", "https://example.test/app", "load") for call in calls)
    assert any(call[0] == "wait_for_function" and "interactive" in call[1] for call in calls)


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


def test_write_selector_trace_extracts_selectors_from_action_logs(tmp_path):
    trace_path = _write_selector_trace(
        tmp_path,
        [
            {
                "action_id": "a1",
                "type": "fill",
                "status": "ok",
                "selector": "#user-id",
                "selector_source": "action.selector",
                "step_id": "step_1",
            },
            {
                "type": "click",
                "status": "ok",
                "element": {"selector": "button.primary", "text": "조회"},
                "selector_candidates": ["button.primary", "[data-action='search']"],
            },
            {"type": "wait", "status": "ok"},
        ],
    )

    payload = json.loads(trace_path.read_text(encoding="utf-8"))

    assert payload["status"] == "completed"
    assert payload["selector_count"] == 3
    assert payload["selectors"][0]["selector"] == "#user-id"
    assert payload["selectors"][0]["source"] == "action.selector"
    assert payload["selectors"][1]["selector"] == "button.primary"
    assert payload["selectors"][2]["selector"] == "[data-action='search']"


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


def test_demonstration_recorder_records_dom_selector_metadata():
    scripts = []

    class FakePage:
        def add_init_script(self, script):
            scripts.append(script)

        def evaluate(self, script):
            scripts.append(script)

    _install_demonstration_recorder(FakePage())

    recorder_script = "\n".join(scripts)
    assert "selectorFor" in recorder_script
    assert "selector_candidates" in recorder_script
    assert "selector_source: 'demonstration.dom'" in recorder_script


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


def test_execute_browser_agent_actions_records_observe_act_verify_turns(tmp_path):
    observations = [
        {"url": "http://internal.example.local", "fields": [{"label": "검색어", "value": ""}], "clickables": []},
        {"url": "http://internal.example.local", "fields": [{"label": "검색어", "value": "LOT-001"}], "clickables": []},
    ]
    calls = []

    class FakeLocator:
        def fill(self, value):
            calls.append(("fill", value))

    class FakePage:
        def get_by_label(self, label, exact=False):
            calls.append(("get_by_label", label, exact))
            return FakeLocator()

        def get_by_placeholder(self, label, exact=False):
            raise AssertionError("label should be enough")

        def wait_for_timeout(self, timeout):
            calls.append(("wait_for_timeout", timeout))

        def add_style_tag(self, content):
            calls.append(("add_style_tag",))

        def evaluate(self, script, *args):
            calls.append(("evaluate", args))

        def screenshot(self, path, full_page):
            Path(path).write_bytes(b"png")

    class Settings:
        enable_browser_agent = True
        browser_agent_max_steps = 1

        class llm:
            is_configured = True

    request = PipelineInput(
        request_text="검색어 입력",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="입력 완료",
        input_values={"검색어": "LOT-001"},
    )

    def observe_page(page):
        return observations.pop(0)

    def decide_next(request, settings, observation, history, step_index):
        assert observation["fields"][0]["label"] == "검색어"
        return {
            "status": "ok",
            "source": "browser-agent-llm",
            "type": "fill_by_label",
            "label": "검색어",
            "value": "LOT-001",
            "reason": "검색어를 입력합니다.",
        }

    result = _execute_browser_agent_actions(
        FakePage(),
        request,
        {"steps": [], "actions": []},
        tmp_path,
        Settings(),
        decide_next=decide_next,
        observe_page=observe_page,
    )

    assert result["status"] == "ok"
    assert result["action_log"][0]["phase"] == "act"
    assert result["action_log"][0]["observation"]["fields"][0]["label"] == "검색어"
    assert result["action_log"][0]["verification"]["phase"] == "verify"
    assert result["action_log"][0]["verification"]["status"] == "ok"
    trace = json.loads((tmp_path.parent / "browser_agent_trace.json").read_text(encoding="utf-8"))
    assert trace["contract"] == "observe-act-verify"
    assert trace["turns"][0]["action"]["type"] == "fill_by_label"
    assert trace["turns"][0]["verification"]["status"] == "ok"


def test_execute_browser_agent_actions_can_press_enter_key(tmp_path):
    events = []

    class FakeKeyboard:
        def press(self, key):
            events.append(("press", key))

    class FakePage:
        keyboard = FakeKeyboard()

        def evaluate(self, script, *args):
            return {"url": "https://www.genspark.ai/agents?type=ai_chat", "fields": [], "clickables": []}

        def wait_for_timeout(self, timeout):
            events.append(("wait", timeout))

        def add_style_tag(self, content):
            events.append(("style",))

        def screenshot(self, path, full_page):
            Path(path).write_bytes(b"png")

    request = PipelineInput(
        request_text="Genspark AI Chat에 질문 입력 후 전송",
        target_url="https://www.genspark.ai/agents?type=ai_chat",
        role="사용자",
        completion_condition="답변 확인",
        input_values={"프롬프트": "st.form과 st.input 차이"},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS": "1",
            "MANUAL_AGENT_LOGIN_MODE": "sso_profile",
        }
    )

    def decide_next(request, settings, observation, history, step_index):
        return {"status": "ok", "type": "press_key", "key": "Enter", "reason": "채팅 질문 전송"}

    result = _execute_browser_agent_actions(FakePage(), request, {"actions": []}, tmp_path, settings, decide_next=decide_next)

    assert ("press", "Enter") in events
    assert result["action_log"][0]["type"] == "press_key"
    assert result["action_log"][0]["status"] == "ok"


def test_execute_browser_agent_actions_extends_loop_for_sso_waits(tmp_path):
    events = []

    class FakePage:
        def evaluate(self, script, *args):
            events.append(("evaluate", args))
            return {"body_text": "SAML SSO redirecting", "fields": [], "clickables": []}

        def wait_for_timeout(self, timeout):
            events.append(("wait", timeout))

        def add_style_tag(self, content):
            events.append(("style",))

        def screenshot(self, path, full_page):
            Path(path).write_bytes(b"png")

    request = PipelineInput(
        request_text="SSO 경유 후 챗봇 질문",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변 확인",
        input_values={"프롬프트": "테스트"},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS": "1",
            "MANUAL_AGENT_LOGIN_MODE": "sso_profile",
        }
    )
    decisions = [
        {"status": "ok", "type": "wait", "timeout_ms": 1000, "reason": "sso_auth_redirect_wait"},
        {"status": "ok", "type": "finish", "reason": "SSO 경유 완료"},
    ]

    def decide_next(*_args, **_kwargs):
        return decisions.pop(0)

    result = _execute_browser_agent_actions(FakePage(), request, {"actions": []}, tmp_path, settings, decide_next=decide_next)

    assert [entry["type"] for entry in result["action_log"]] == ["wait", "finish"]
    assert ("wait", 1000) in events
    assert result["status"] == "ok"


def test_capture_action_status_reports_login_required_separately():
    status, reason = _capture_action_log_status(
        [{"type": "finish", "status": "blocked", "reason": "login_required"}],
        failed_reason="browser_agent_action_failed",
    )

    assert status == "degraded"
    assert reason == "login_required"


def test_recording_helpers_include_cursor_click_and_input_focus_overlays():
    calls = {"styles": [], "scripts": [], "init_scripts": []}

    class FakePage:
        def add_init_script(self, script):
            calls["init_scripts"].append(script)

        def add_style_tag(self, content):
            calls["styles"].append(content)

        def evaluate(self, script, *args):
            calls["scripts"].append(script)

    _inject_recording_helpers(FakePage())

    style = "\n".join(calls["styles"])
    script = "\n".join(calls["scripts"])
    assert ".manual-cursor" in style
    assert ".manual-click-ripple" in style
    assert ".manual-input-focus" in style
    assert "__manualMoveCursorToElement" in script
    assert "__manualFocusByLabel" in script
    assert "__manualPulseClick" in script
    assert "focusin" in script
    assert calls["init_scripts"], "recording helpers must survive login/navigation"
    init_script = "\n".join(calls["init_scripts"])
    assert "manual-recording-helper-style" in init_script
    assert ".manual-cursor" in init_script
    assert "__manualInstallRecordingHelpers" in init_script
    assert "MutationObserver" in init_script
    assert "__manualRecordingOverlayInterval" in init_script


def test_execute_browser_agent_actions_uses_local_policy_when_llm_is_not_configured(tmp_path):
    calls = []

    class FakePage:
        def evaluate(self, script, *args):
            calls.append(("evaluate", args))

        def wait_for_timeout(self, timeout):
            calls.append(("wait_for_timeout", timeout))

        def click(self, selector):
            calls.append(("click", selector))

        class keyboard:
            @staticmethod
            def press(key):
                calls.append(("press", key))

        def screenshot(self, path, full_page):
            Path(path).write_bytes(b"png")

    request = PipelineInput(
        request_text="조회",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="조회 결과",
        input_values={"검색어": "LOT-001"},
        agent_brief={"task_type": "lookup", "safe_click_intents": ["조회"]},
    )
    settings = load_settings(environ={"MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true"})
    plan = {
        "steps": [{"id": "step_1", "title": "조회", "caption": "조회", "narration": "조회"}],
        "actions": [
            {"id": "a1", "type": "click", "selector": "button.search", "step_id": "step_1"},
            {"id": "a2", "type": "capture_step", "step_id": "step_1"},
        ],
    }

    observations = [
        {"fields": [{"label": "검색어", "value": ""}], "clickables": [{"text": "조회"}], "body_text": "검색 화면"},
        {"fields": [{"label": "검색어", "value": "LOT-001"}], "clickables": [{"text": "조회"}], "body_text": "검색 화면"},
        {"fields": [{"label": "검색어", "value": "LOT-001"}], "clickables": [], "body_text": "조회 결과 1건"},
    ]

    def observe_page(_page):
        return observations.pop(0) if observations else {"body_text": "조회 결과 1건"}

    class Locator:
        def fill(self, value):
            calls.append(("fill", value))

        def click(self):
            calls.append(("click_text",))

    class SemanticPage(FakePage):
        def get_by_label(self, label, exact=False):
            calls.append(("get_by_label", label, exact))
            return Locator()

        def get_by_role(self, role, name, exact=False):
            calls.append(("get_by_role", role, name, exact))
            return Locator()

    result = _execute_browser_agent_actions(
        SemanticPage(),
        request,
        plan,
        tmp_path,
        settings,
        observe_page=observe_page,
    )

    assert result["status"] == "ok"
    assert result["degrade_reason"] == ""
    assert result["action_log"][0]["source"] == "browser-agent-local"
    assert result["action_log"][0]["type"] == "fill_by_label"
    assert ("fill", "LOT-001") in calls
    assert not any(call == ("click", "button.search") for call in calls)


def test_browser_agent_clicks_observed_selector_instead_of_reselecting_by_text(tmp_path):
    calls = []

    class Locator:
        def __init__(self, selector):
            self.selector = selector

        def click(self):
            calls.append(("locator_click", self.selector))

    class FakePage:
        def evaluate(self, script, *args):
            calls.append(("evaluate", args))

        def wait_for_timeout(self, timeout):
            calls.append(("wait_for_timeout", timeout))

        def locator(self, selector):
            calls.append(("locator", selector))
            return Locator(selector)

        def get_by_role(self, role, name, exact=False):
            raise AssertionError("browser agent must use the observed selector before text lookup")

        def screenshot(self, path, full_page):
            Path(path).write_bytes(b"png")

    request = PipelineInput(
        request_text="모달창 내용을 확인하고 닫기",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="모달이 닫히면 완료",
        agent_brief={"safe_click_intents": ["닫기"]},
    )
    settings = load_settings(environ={"MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true"})
    observations = [
        {
            "fields": [],
            "clickables": [{"text": "닫기", "selector": "#modal-close"}],
            "body_text": "공지 모달 닫기",
        },
        {"fields": [], "clickables": [], "body_text": "메인 화면"},
    ]

    result = _execute_browser_agent_actions(
        FakePage(),
        request,
        {"steps": [], "actions": []},
        tmp_path,
        settings,
        observe_page=lambda _page: observations.pop(0) if observations else {"body_text": "메인 화면"},
    )

    assert result["status"] == "ok"
    assert ("locator_click", "#modal-close") in calls
    assert result["action_log"][0]["selector"] == "#modal-close"
    assert result["action_log"][0]["selector_source"] == "observation.clickables"


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


def test_resolve_login_options_supports_ad_sso_profile_alias():
    settings = load_settings(
        environ={
            "MANUAL_AGENT_LOGIN_MODE": "none",
            "MANUAL_AGENT_BROWSER_USER_DATA_DIR": "C:\\AppBundle\\manualgen\\browser-profile",
        }
    )
    request = PipelineInput(
        request_text="SSO로 접속 후 메뉴얼",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="홈 화면",
        login_mode="ad-sso",
    )

    login = _resolve_login_options(request, settings)

    assert login["mode"] == "sso_profile"
    assert login["sso_profile_dir"] == "C:\\AppBundle\\manualgen\\browser-profile"


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


def test_handle_login_uses_llm_to_find_missing_credential_selectors(tmp_path):
    calls = []
    llm_payloads = []

    class FakePage:
        def evaluate(self, script, *args):
            assert "manualLoginSelectorCandidates" in script
            return [
                {
                    "selector": 'input[name="account"]',
                    "tag": "input",
                    "type": "text",
                    "name": "account",
                    "id": "",
                    "placeholder": "아이디",
                    "label": "사번 또는 ID",
                    "aria_label": "",
                    "text": "",
                    "visible": True,
                },
                {
                    "selector": "#loginPassword",
                    "tag": "input",
                    "type": "password",
                    "name": "",
                    "id": "loginPassword",
                    "placeholder": "비밀번호",
                    "label": "Password",
                    "aria_label": "",
                    "text": "",
                    "visible": True,
                },
                {
                    "selector": 'button[type="submit"]',
                    "tag": "button",
                    "type": "submit",
                    "name": "",
                    "id": "",
                    "placeholder": "",
                    "label": "",
                    "aria_label": "",
                    "text": "로그인",
                    "visible": True,
                },
            ]

        def fill(self, selector, value):
            calls.append(("fill", selector, value))

        def click(self, selector):
            calls.append(("click", selector))

        def wait_for_load_state(self, state, timeout):
            calls.append(("wait_for_load_state", state, timeout))

        def wait_for_function(self, expression, timeout):
            calls.append(("wait_for_function", timeout))

    settings = load_settings(
        environ={
            "MANUAL_AGENT_LLM_PROVIDER": "ollama",
            "MANUAL_AGENT_LLM_BASE_URL": "http://127.0.0.1:11434/v1",
            "MANUAL_AGENT_LLM_MODEL": "qwen3.5",
            "MANUAL_AGENT_ENABLE_TERMINAL_LOGS": "true",
        }
    )
    request = PipelineInput(
        request_text="사내 시스템 로그인 후 조회",
        target_url="http://internal.example.local/login",
        role="사용자",
        completion_condition="홈 화면",
        login_mode="credentials",
    )
    login = {
        "mode": "credentials",
        "username_selector": "",
        "password_selector": "",
        "submit_selector": "",
        "success_selector": "",
        "username": "user01",
        "password": "plain-password",
        "credentials_timeout_ms": 30000,
        "manual_timeout_ms": 120000,
    }

    def fake_post(url, headers, payload, timeout):
        llm_payloads.append(payload)
        serialized_payload = json.dumps(payload, ensure_ascii=False)
        assert "plain-password" not in serialized_payload
        assert "user01" not in serialized_payload
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "username_selector": 'input[name="account"]',
                                "password_selector": "#loginPassword",
                                "submit_selector": 'button[type="submit"]',
                                "confidence": 0.91,
                            },
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }

    log = _handle_login(
        FakePage(),
        login,
        request=request,
        settings=settings,
        package_dir=tmp_path,
        http_post=fake_post,
    )

    assert ("fill", 'input[name="account"]', "user01") in calls
    assert ("fill", "#loginPassword", "plain-password") in calls
    assert ("click", 'button[type="submit"]') in calls
    assert log["status"] == "ok"
    assert log["selector_source"] == "llm"
    assert log["selector_resolution"]["status"] == "ok"
    assert log["selector_resolution"]["confidence"] == 0.91
    assert llm_payloads
    llm_log = (tmp_path / "llm_responses.jsonl").read_text(encoding="utf-8")
    assert "login_selector" in llm_log
    assert "plain-password" not in llm_log
    assert "user01" not in llm_log


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
        def __init__(self, kind="recorded"):
            self.kind = kind

        def goto(self, url, wait_until):
            events.append((self.kind, "goto", url, wait_until))

        def wait_for_load_state(self, state, timeout):
            events.append((self.kind, "wait_for_load_state", state, timeout))

        def wait_for_function(self, expression, *args, **kwargs):
            events.append((self.kind, "wait_for_function", "manualLoginCompleted" in expression, args, kwargs))

        def add_style_tag(self, content):
            events.append((self.kind, "add_style_tag"))

        def add_init_script(self, script):
            events.append((self.kind, "add_init_script", "로그인 완료" in script, "시연 완료" in script))

        def expose_function(self, name, callback):
            events.append((self.kind, "expose_function", name))

        def evaluate(self, script, *args):
            events.append((self.kind, "evaluate", args))
            if "return { completed" in script:
                return {"completed": True, "successSelectorMatched": False}
            return None

        def wait_for_timeout(self, timeout):
            events.append((self.kind, "wait_for_timeout", timeout))

        def screenshot(self, path, full_page):
            events.append((self.kind, "screenshot", Path(path).name, full_page))
            Path(path).write_bytes(b"png")

        def get_by_role(self, *args, **kwargs):
            return FakeLocator()

    class FakeContext:
        def __init__(self, options):
            self.options = options
            self.kind = "recorded" if options.get("record_video_dir") else "control"

        def new_page(self):
            events.append((self.kind, "new_page"))
            return FakePage(self.kind)

        def storage_state(self):
            events.append((self.kind, "storage_state"))
            return {"cookies": [{"name": "sid", "value": "manual"}], "origins": []}

        def close(self):
            events.append((self.kind, "context_close"))
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

    assert len(context_options) == 2
    assert "record_video_dir" not in context_options[0]
    assert "record_video_dir" in context_options[1]
    assert result["action_log"][0]["type"] == "login"
    assert result["action_log"][0]["status"] == "ok"
    assert not any(event[1:] == ("storage_state",) for event in events)
    assert events.count(("recorded", "new_page")) == 1
    assert events.count(("control", "new_page")) == 1
    assert any(event == ("control", "add_init_script", True, False) for event in events)
    assert not any(event == ("recorded", "add_init_script", True, False) for event in events)
    assert result["video"].exists()


def test_demonstration_capture_waits_for_user_signal_instead_of_browser_agent(tmp_path, monkeypatch):
    import playwright.sync_api as sync_api

    events = []

    class FakePage:
        def __init__(self, kind="recorded"):
            self.kind = kind

        def goto(self, url, wait_until):
            events.append((self.kind, "goto", url, wait_until))

        def wait_for_load_state(self, state, timeout):
            events.append((self.kind, "wait_for_load_state", state, timeout))

        def wait_for_function(self, expression, timeout):
            events.append((self.kind, "wait_for_function", expression, timeout))

        def add_style_tag(self, content):
            events.append((self.kind, "add_style_tag"))

        def add_init_script(self, script):
            events.append((self.kind, "add_init_script", "로그인 완료" in script, "시연 완료" in script))

        def expose_function(self, name, callback):
            events.append((self.kind, "expose_function", name))
            callback()

        def evaluate(self, script, *args):
            if "__manualDemonstrationEvents" in script and "slice()" in script:
                events.append((self.kind, "read_demo_events"))
                return [{"type": "click", "label": "전송", "text": "전송"}]
            if "manualDemonstrationCompleted" in script:
                events.append((self.kind, "wait_demo_signal", args))
                return {"completed": True}
            events.append((self.kind, "evaluate", args))
            return None

        def wait_for_timeout(self, timeout):
            events.append((self.kind, "wait_for_timeout", timeout))

        def screenshot(self, path, full_page):
            events.append((self.kind, "screenshot", Path(path).name, full_page))
            Path(path).write_bytes(b"png")

        def click(self, selector):
            events.append((self.kind, "plan_click", selector))

    class FakeContext:
        def __init__(self, options):
            self.options = options
            self.kind = "recorded" if options.get("record_video_dir") else "control"

        def new_page(self):
            events.append((self.kind, "new_page"))
            return FakePage(self.kind)

        def close(self):
            raw_dir = self.options.get("record_video_dir")
            if raw_dir:
                Path(raw_dir).mkdir(parents=True, exist_ok=True)
                Path(raw_dir, "demo.webm").write_bytes(b"webm")

    class FakeBrowser:
        def new_context(self, **kwargs):
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
        enable_browser_agent = True
        demonstration_timeout_seconds = 60.0

        class llm:
            is_configured = True

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
        "steps": [{"id": "step_chat", "title": "챗봇", "caption": "챗봇", "narration": "챗봇"}],
        "actions": [{"id": "a1", "type": "click", "selector": "button.search", "step_id": "step_chat"}],
    }
    dirs = _make_dirs(tmp_path / "package")
    request = PipelineInput(
        request_text="사내 챗봇 시연",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변",
        execution_mode="demonstration",
    )

    result = _capture_with_playwright(request, plan, dirs, Settings())

    assert ("launch", False) in events
    assert any(item == ("control", "expose_function", "__manualDemonstrationSignalFromPage") for item in events)
    assert not any(item == ("recorded", "add_init_script", False, True) for item in events)
    assert any(item == ("control", "add_init_script", False, True) for item in events)
    assert ("recorded", "plan_click", "button.search") not in events
    assert result["action_log"][0]["type"] == "demonstration"
    assert result["action_log"][0]["mode"] == "demonstration"
    assert result["action_log"][0]["event_count"] == 1
    assert any(entry.get("type") == "click" and entry.get("label") == "전송" for entry in result["action_log"])
    assert result["video"].exists()


def test_demonstration_mode_ignores_manual_login_gate_and_uses_only_demo_signal(tmp_path, monkeypatch):
    import playwright.sync_api as sync_api

    events = []

    class FakePage:
        def __init__(self, kind="recorded"):
            self.kind = kind

        def goto(self, url, wait_until):
            events.append((self.kind, "goto", url, wait_until))

        def wait_for_load_state(self, state, timeout):
            events.append((self.kind, "wait_for_load_state", state, timeout))

        def wait_for_function(self, expression, *args, **kwargs):
            events.append((self.kind, "wait_for_function", "manualLoginCompleted" in expression, args, kwargs))
            return True

        def add_style_tag(self, content):
            events.append((self.kind, "add_style_tag"))

        def add_init_script(self, script):
            events.append((self.kind, "add_init_script", "로그인 완료" in script, "시연 완료" in script))

        def expose_function(self, name, callback):
            events.append((self.kind, "expose_function", name))
            if name == "__manualDemonstrationSignalFromPage":
                callback()

        def evaluate(self, script, *args):
            if "__manualDemonstrationEvents" in script and "slice()" in script:
                return [{"type": "click", "label": "로그인 버튼", "text": "로그인"}]
            if "manualDemonstrationCompleted" in script:
                return {"completed": True}
            if "manualLoginCompleted" in script or "manualLoginSignal" in script:
                events.append((self.kind, "unexpected_manual_login_evaluate"))
                return {"completed": True, "successSelectorMatched": False}
            events.append((self.kind, "evaluate", args))
            return None

        def wait_for_timeout(self, timeout):
            events.append((self.kind, "wait_for_timeout", timeout))

        def screenshot(self, path, full_page):
            events.append((self.kind, "screenshot", Path(path).name, full_page))
            Path(path).write_bytes(b"png")

    class FakeContext:
        def __init__(self, options):
            self.options = options
            self.kind = "recorded" if options.get("record_video_dir") else "control"

        def new_page(self):
            events.append((self.kind, "new_page"))
            return FakePage(self.kind)

        def storage_state(self):
            events.append((self.kind, "storage_state"))
            return {"cookies": [{"name": "sid", "value": "should-not-use"}], "origins": []}

        def close(self):
            raw_dir = self.options.get("record_video_dir")
            if raw_dir:
                Path(raw_dir).mkdir(parents=True, exist_ok=True)
                Path(raw_dir, "demo.webm").write_bytes(b"webm")

    class FakeBrowser:
        def new_context(self, **kwargs):
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
        enable_browser_agent = True
        demonstration_timeout_seconds = 60.0

        class llm:
            is_configured = True

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

    request = PipelineInput(
        request_text="로그인부터 직접 시연",
        target_url="http://internal.example.local/login",
        role="사용자",
        completion_condition="홈",
        execution_mode="demonstration",
        login_mode="manual",
    )
    dirs = _make_dirs(tmp_path / "package")

    result = _capture_with_playwright(request, {"steps": [], "actions": []}, dirs, Settings())

    assert not any(event[0] == "control" and event[1] == "add_init_script" and event[2] is True for event in events)
    assert any(event == ("control", "add_init_script", False, True) for event in events)
    assert not any(event == ("control", "expose_function", "__manualLoginSignalFromPage") for event in events)
    assert any(event == ("recorded", "storage_state") for event in events)
    assert not any(entry.get("type") == "login" for entry in result["action_log"])
    assert result["action_log"][0]["type"] == "demonstration"
    assert result["video"].exists()


def test_demonstration_mode_preserves_sso_profile_browser_context(tmp_path, monkeypatch):
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

        def add_init_script(self, script):
            events.append(("add_init_script", "시연 완료" in script, "로그인 완료" in script))

        def expose_function(self, name, callback):
            events.append(("expose_function", name))
            if name == "__manualDemonstrationSignalFromPage":
                callback()

        def evaluate(self, script, *args):
            if "__manualDemonstrationEvents" in script and "slice()" in script:
                return [{"type": "click", "text": "검색"}]
            if "manualDemonstrationCompleted" in script:
                return {"completed": True}
            events.append(("evaluate", args))
            return None

        def wait_for_timeout(self, timeout):
            events.append(("wait_for_timeout", timeout))

        def screenshot(self, path, full_page):
            events.append(("screenshot", Path(path).name, full_page))
            Path(path).write_bytes(b"png")

    class FakePersistentContext:
        pages = [FakePage()]

        def storage_state(self):
            events.append(("storage_state",))
            return {"cookies": [{"name": "sso", "value": "ok"}], "origins": []}

        def close(self):
            events.append(("persistent_close",))

    class FakeChromium:
        def launch_persistent_context(self, user_data_dir, **kwargs):
            events.append(("launch_persistent_context", user_data_dir, kwargs.get("channel"), kwargs.get("headless")))
            raw_dir = Path(kwargs["record_video_dir"])
            raw_dir.mkdir(parents=True, exist_ok=True)
            (raw_dir / "sso-demo.webm").write_bytes(b"webm")
            return FakePersistentContext()

        def launch(self, **kwargs):
            events.append(("launch", kwargs))
            raise AssertionError("sso_profile demonstration must use persistent context")

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
        demonstration_timeout_seconds = 30.0

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
            sso_profile_dir = str(tmp_path / "sso-profile")
            browser_channel = "msedge"
            auth_server_allowlist = "*.corp.local"
            auth_negotiate_delegate_allowlist = "*.corp.local"

    request = PipelineInput(
        request_text="SSO 로그인 상태로 직접 시연",
        target_url="http://internal.example.local/app",
        role="사용자",
        completion_condition="홈",
        execution_mode="demonstration",
        login_mode="sso_profile",
    )
    dirs = _make_dirs(tmp_path / "package")

    result = _capture_with_playwright(request, {"steps": [], "actions": []}, dirs, Settings())

    assert any(event[0] == "launch_persistent_context" for event in events)
    assert not any(event[0] == "launch" for event in events)
    assert any(event == ("storage_state",) for event in events)
    assert result["storage_state"]["cookies"][0]["name"] == "sso"
    assert result["video"].name in {"direct_demonstration_source.webm", "manual_video_agent_usage.webm"}


def test_demonstration_recorder_records_events_without_burned_in_captions():
    calls = []

    class FakePage:
        def add_init_script(self, script):
            calls.append(("add_init_script", script))

        def evaluate(self, script, *args):
            calls.append(("evaluate", script, args))

    _install_demonstration_recorder(FakePage())

    script = "\n".join(call[1] for call in calls if call[0] in {"add_init_script", "evaluate"})
    assert "captionFor" in script
    assert "__manualSetCaption" not in script
    assert "updateCaption" not in script
    assert "클릭:" in script
    assert "입력:" in script
    assert "Enter 입력" in script


def test_demonstration_capture_does_not_set_visible_caption_overlay(tmp_path, monkeypatch):
    calls = []

    class Settings:
        demonstration_timeout_seconds = 10.0

    class FakePage:
        def add_init_script(self, script):
            calls.append(("add_init_script", script))

        def expose_function(self, name, callback):
            calls.append(("expose_function", name, callback))

        def evaluate(self, script, *args):
            calls.append(("evaluate", script, args))

        def screenshot(self, path, full_page):
            Path(path).write_bytes(b"png")

    monkeypatch.setattr(pipeline_module, "_wait_for_demonstration_completion", lambda *_args, **_kwargs: "button")
    monkeypatch.setattr(
        pipeline_module,
        "_read_demonstration_events",
        lambda _page: [{"type": "click", "text": "전송"}],
    )

    result = pipeline_module._execute_demonstration_capture(
        FakePage(),
        PipelineInput(
            request_text="직접 시연",
            target_url="http://internal.example.local",
            role="사용자",
            completion_condition="완료",
            execution_mode="demonstration",
        ),
        {"steps": [{"id": "step_1", "title": "검색", "caption": "검색합니다.", "narration": "검색합니다."}]},
        tmp_path,
        Settings(),
    )

    assert result["status"] == "ok"
    assert not any(call[0] == "evaluate" and call[1] == "window.__manualSetCaption" for call in calls)


def test_demonstration_events_drive_media_plan_and_subtitles(tmp_path):
    request = PipelineInput(
        request_text="사내 챗봇 시연",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변",
        execution_mode="demonstration",
    )
    base_plan = {
        "steps": [{"id": "step_chat", "title": "원래 계획", "caption": "원래 계획", "narration": "원래 계획"}],
        "actions": [],
    }
    action_log = [
        {"type": "demonstration", "status": "ok", "event_count": 3},
        {"type": "input", "label": "질문", "value": "st.form과 st.input 차이"},
        {"type": "key", "key": "Enter", "label": "질문"},
        {"type": "click", "text": "답변 복사"},
    ]

    media_plan = _media_plan_for_outputs(request, base_plan, action_log)
    subtitles = _render_subtitles(media_plan, tmp_path)

    titles = [step["title"] for step in media_plan["steps"]]
    captions = [step["caption"] for step in media_plan["steps"]]
    subtitle_text = subtitles.read_text(encoding="utf-8")

    assert media_plan["source"] == "direct-demonstration-media-plan"
    assert "원래 계획" not in json.dumps(media_plan, ensure_ascii=False)
    assert titles == ["직접 시연 시작", "입력: 질문", "Enter 입력", "클릭: 답변 복사"]
    assert "st.form과 st.input 차이" in captions[1]
    assert "WEBVTT" in subtitle_text
    assert "질문에 st.form과 st.input 차이 값을 입력합니다." in subtitle_text
    assert "답변 복사을 클릭합니다." in subtitle_text


def test_ai_browser_action_log_drives_media_plan_for_tts_sync(tmp_path):
    request = PipelineInput(
        request_text="모달창 내용을 확인하고 닫은 다음 조회",
        target_url="http://internal.example.local/app",
        role="사용자",
        completion_condition="조회 결과",
        execution_mode="ai",
    )
    base_plan = {
        "steps": [{"id": "planned_later", "title": "이후 작업", "caption": "이후 작업", "narration": "이후 작업"}],
        "actions": [],
    }
    action_log = [
        {"type": "click_by_text", "status": "ok", "texts": ["닫기"], "selector": "#modal-close"},
        {"type": "fill_by_label", "status": "ok", "label": "검색어", "value": "LOT-001", "selector": "#search"},
        {"type": "press_key", "status": "ok", "key": "Enter"},
    ]

    media_plan = _media_plan_for_outputs(request, base_plan, action_log)
    subtitles = _render_subtitles(media_plan, tmp_path)
    titles = [step["title"] for step in media_plan["steps"]]

    assert media_plan["source"] == "browser-agent-media-plan"
    assert "이후 작업" not in json.dumps(media_plan, ensure_ascii=False)
    assert titles == ["클릭: 닫기", "입력: 검색어", "Enter 입력"]
    assert "닫기을 클릭합니다." in subtitles.read_text(encoding="utf-8")


def test_ai_browser_media_plan_uses_actual_inputs_and_natural_timing_despite_five_minute_text(tmp_path):
    request = PipelineInput(
        request_text="사내 위키 검색과 질문 입력 흐름을 5분짜리 영상으로 만들어줘",
        target_url="http://internal.example.local/wiki",
        role="관리자",
        completion_condition="질문 결과 확인",
        execution_mode="ai",
        input_values={"검색어": "Company LLM Wiki", "질문": "st.form과 st.input의 입력 차이점"},
    )
    base_plan = {"steps": [{"id": "planned", "title": "기존 계획"}], "actions": []}
    action_log = [
        {"type": "click_by_selector", "status": "ok", "reason": "Search 메뉴로 이동합니다.", "selector": "button[title='Search']"},
        {
            "type": "fill_by_label",
            "status": "ok",
            "label": "Search published Wiki pages",
            "value": "Company LLM Wiki",
            "selector": "#search",
        },
        {"type": "click_by_selector", "status": "ok", "reason": "검색 결과를 확인합니다.", "selector": "#search-button"},
        {
            "type": "fill_by_label",
            "status": "ok",
            "label": "Ask a grounded question about compiled company knowledge.",
            "value": "st.form과 st.input의 입력 차이점",
            "selector": "#ask",
        },
        {"type": "click_by_selector", "status": "ok", "reason": "Ask 버튼으로 질문을 제출합니다.", "selector": "#ask-button"},
        {"type": "wait", "status": "ok", "reason": "답변이 표시될 때까지 기다립니다."},
        {"type": "capture_step", "status": "ok", "reason": "결과 화면을 확인합니다."},
    ]

    media_plan = _media_plan_for_outputs(request, base_plan, action_log)
    subtitles = _render_subtitles(media_plan, tmp_path).read_text(encoding="utf-8")
    serialized = json.dumps(media_plan, ensure_ascii=False)

    assert media_plan["source"] == "browser-agent-media-plan"
    assert "target_duration_seconds" not in media_plan
    assert all("duration_seconds" not in step for step in media_plan["steps"])
    assert "Company LLM Wiki" in serialized
    assert "st.form과 st.input의 입력 차이점" in serialized
    assert "답변이 표시될 때까지 기다립니다." in serialized
    assert "결과 화면을 확인합니다." in serialized
    assert "00:00:28.000" in subtitles


def test_browser_agent_fill_action_log_preserves_entered_value(tmp_path):
    calls = []

    class Locator:
        def fill(self, value):
            calls.append(("fill", value))

    class Page:
        def locator(self, selector):
            calls.append(("locator", selector))
            return Locator()

        def evaluate(self, script, *args):
            calls.append(("evaluate", args))

        def wait_for_timeout(self, timeout):
            calls.append(("wait_for_timeout", timeout))

    log_entry = _execute_single_browser_agent_action(
        Page(),
        {
            "id": "ba2",
            "type": "fill_by_label",
            "label": "Search published Wiki pages",
            "value": "Company LLM Wiki",
            "selector": "#search",
            "reason": "검색어를 입력합니다.",
        },
        tmp_path,
        set(),
    )

    assert log_entry["status"] == "ok"
    assert log_entry["value"] == "Company LLM Wiki"
    assert ("fill", "Company LLM Wiki") in calls


def test_media_plan_uses_explicit_target_duration_only_when_agent_brief_requests_it():
    request = PipelineInput(
        request_text="사내 위키 사용법을 5분 영상으로 만들어줘",
        target_url="http://internal.example.local/wiki",
        role="관리자",
        completion_condition="답변 확인",
        execution_mode="ai",
        agent_brief={"target_video_duration_seconds": 300},
    )
    base_plan = {"steps": [{"id": "planned", "title": "짧은 계획"}], "actions": []}
    action_log = [
        {"type": "click_by_text", "status": "ok", "texts": ["Search"], "selector": "#search-tab"},
        {"type": "fill_by_label", "status": "ok", "label": "검색어", "value": "Company LLM Wiki", "selector": "#search"},
        {"type": "press_key", "status": "ok", "key": "Enter"},
        {"type": "fill_by_label", "status": "ok", "label": "질문", "value": "st.form과 st.input 차이", "selector": "#ask"},
        {"type": "click_by_text", "status": "ok", "texts": ["Ask"], "selector": "#ask-button"},
    ]

    media_plan = _media_plan_for_outputs(request, base_plan, action_log)

    assert media_plan["target_duration_seconds"] == 300.0
    assert media_plan["duration_source"] == "target_video_duration"
    assert round(sum(float(step["duration_seconds"]) for step in media_plan["steps"]), 3) == 300.0

    natural_request = PipelineInput(
        request_text="사내 위키 사용법을 5분 영상으로 만들어줘",
        target_url="http://internal.example.local/wiki",
        role="관리자",
        completion_condition="답변 확인",
        execution_mode="ai",
    )
    natural_plan = _media_plan_for_outputs(natural_request, base_plan, action_log)

    assert "target_duration_seconds" not in natural_plan
    assert all("duration_seconds" not in step for step in natural_plan["steps"])


def test_render_subtitles_uses_media_plan_step_durations(tmp_path):
    plan = {
        "target_duration_seconds": 300.0,
        "steps": [
            {"id": "intro", "title": "소개", "caption": "시작", "duration_seconds": 90.0},
            {"id": "search", "title": "검색", "caption": "검색합니다.", "duration_seconds": 210.0},
        ],
    }

    subtitles = _render_subtitles(plan, tmp_path)
    text = subtitles.read_text(encoding="utf-8")

    assert "00:00:00.000 --> 00:01:30.000" in text
    assert "00:01:30.000 --> 00:05:00.000" in text


def test_render_subtitles_prefers_single_caption_line_without_repeating_title(tmp_path):
    plan = {
        "steps": [
            {
                "id": "search",
                "title": "입력: Search published Wiki pages",
                "caption": "Search published Wiki pages에 Company LLM Wiki 값을 입력합니다.",
            }
        ]
    }

    subtitles = _render_subtitles(plan, tmp_path)
    text = subtitles.read_text(encoding="utf-8")

    assert "입력: Search published Wiki pages\nSearch published Wiki pages에" not in text
    assert text.count("Search published Wiki pages") == 1
    assert "Company LLM Wiki 값을 입력합니다." in text


def test_media_plan_with_tts_durations_keeps_subtitles_until_audio_end(tmp_path):
    def write_wav(path: Path, duration_seconds: float):
        frame_rate = 8000
        frame_count = int(frame_rate * duration_seconds)
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(frame_rate)
            handle.writeframes(b"\x00\x00" * frame_count)

    audio_1 = tmp_path / "tts" / "01.wav"
    audio_2 = tmp_path / "tts" / "02.wav"
    write_wav(audio_1, 2.0)
    write_wav(audio_2, 5.0)
    plan = {
        "source": "browser-agent-media-plan",
        "steps": [
            {"id": "one", "title": "검색", "caption": "검색합니다."},
            {"id": "two", "title": "확인", "caption": "결과를 확인합니다."},
        ],
    }

    timed = _media_plan_with_tts_durations(plan, [audio_1, audio_2])
    subtitles = _render_subtitles(timed, tmp_path).read_text(encoding="utf-8")

    assert timed["duration_source"] == "tts_audio"
    assert timed["target_duration_seconds"] == 7.0
    assert timed["steps"][0]["duration_seconds"] == 2.0
    assert timed["steps"][1]["duration_seconds"] == 5.0
    assert "00:00:02.000 --> 00:00:07.000" in subtitles


def test_replay_durations_prefer_media_plan_timeline_over_short_tts(tmp_path):
    def write_wav(path: Path, duration_seconds: float):
        frame_rate = 8000
        frame_count = int(frame_rate * duration_seconds)
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(frame_rate)
            handle.writeframes(b"\x00\x00" * frame_count)

    audio = tmp_path / "tts" / "01_short.wav"
    write_wav(audio, 1.0)
    media_plan = {
        "steps": [
            {"id": "intro", "title": "소개", "duration_seconds": 75.0},
            {"id": "search", "title": "검색", "duration_seconds": 225.0},
        ]
    }

    assert _step_audio_durations(media_plan, [audio]) == [75.0, 225.0]


def test_media_events_include_click_by_selector_before_fill():
    action_log = [
        {"type": "click_by_selector", "status": "ok", "selector": "button.secondary-action", "reason": "Ask Wiki 열기"},
        {"type": "fill_by_label", "status": "ok", "label": "질문", "value": "테스트", "selector": "textarea"},
    ]

    events = pipeline_module._demonstration_events_for_media(action_log)

    assert [event["type"] for event in events] == ["click", "input"]
    assert events[0]["selector"] == "button.secondary-action"
    assert events[0]["text"] == "Ask Wiki 열기"


def test_browser_agent_replay_uses_event_durations_without_extra_initial_wait(tmp_path, monkeypatch):
    import backend.app.pipeline as pipeline_module
    import playwright.sync_api as sync_api

    waits = []

    class FakePage:
        keyboard = type("Keyboard", (), {"press": lambda self, key: None})()

        def set_default_timeout(self, timeout):
            pass

        def set_default_navigation_timeout(self, timeout):
            pass

        def goto(self, url, wait_until):
            pass

        def wait_for_load_state(self, state, timeout):
            pass

        def wait_for_function(self, expression, timeout):
            return True

        def add_style_tag(self, content):
            pass

        def add_init_script(self, script):
            pass

        def evaluate(self, script, *args):
            pass

        def wait_for_timeout(self, timeout):
            waits.append(timeout)

        def screenshot(self, path, full_page):
            Path(path).write_bytes(b"png")

        def locator(self, selector):
            return type("Locator", (), {"click": lambda self: None, "fill": lambda self, value: None})()

    class FakeContext:
        def __init__(self, options):
            self.options = options

        def new_page(self):
            return FakePage()

        def close(self):
            raw_dir = Path(self.options["record_video_dir"])
            raw_dir.mkdir(parents=True, exist_ok=True)
            (raw_dir / "replay.webm").write_bytes(b"replay-webm")

    class FakeBrowser:
        def new_context(self, **kwargs):
            return FakeContext(kwargs)

        def close(self):
            pass

    class FakeChromium:
        def launch(self, **kwargs):
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
        request_timeout_seconds = 60.0
        login = type("Login", (), {"mode": "none"})()
        browser_runner = "playwright"

    dirs = _make_dirs(tmp_path / "package")
    media_plan = {
        "source": "browser-agent-media-plan",
        "steps": [
            {"id": "open", "title": "열기", "duration_seconds": 30.0},
            {"id": "fill", "title": "입력", "duration_seconds": 60.0},
        ],
    }
    action_log = [
        {"type": "click_by_selector", "status": "ok", "selector": "button.secondary-action", "reason": "Ask Wiki 열기"},
        {"type": "fill_by_label", "status": "ok", "label": "질문", "value": "테스트", "selector": "textarea"},
    ]

    result = pipeline_module._replay_demonstration_with_playwright(
        PipelineInput(
            request_text="질문 입력",
            target_url="http://internal.example.local",
            role="사용자",
            completion_condition="완료",
            execution_mode="ai",
        ),
        media_plan,
        action_log,
        dirs,
        Settings(),
        tts_audio=[],
    )

    assert result["status"] == "ok"
    assert 30000 not in waits
    assert result["action_log"][1]["duration_seconds"] == 30.0
    assert result["action_log"][2]["duration_seconds"] == 60.0


def _legacy_test_demonstration_pipeline_uses_recorded_events_for_outputs(tmp_path, monkeypatch):
    def fake_capture(request, plan, dirs, settings):
        import base64

        capture = dirs.captures / "direct_demo.png"
        capture.write_bytes(
            base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
            )
        )
        video = dirs.package / "manual_video_agent_usage.webm"
        video.write_bytes(b"webm")
        action_log = [
            {"type": "demonstration", "status": "ok", "event_count": 3},
            {"type": "input", "label": "질문", "value": "st.form과 st.input 차이"},
            {"type": "key", "key": "Enter", "label": "질문"},
            {"type": "click", "text": "답변 복사"},
        ]
        action_log_path = dirs.package / "capture_action_log.json"
        action_log_path.write_text(json.dumps({"status": "completed", "entries": action_log}, ensure_ascii=False), encoding="utf-8")
        return {
            "captures": [capture],
            "masked_names": [capture.name],
            "video": video,
            "final_frame": capture,
            "action_log": action_log,
            "action_log_path": action_log_path,
            "status": "ok",
            "degrade_reason": "",
        }

    monkeypatch.setattr(pipeline_module, "_capture_with_playwright", fake_capture)

    result = run_pipeline(
        PipelineInput(
            request_text="사내 챗봇 시연",
            target_url="http://internal.example.local/chat",
            role="사용자",
            completion_condition="답변",
            execution_mode="demonstration",
        ),
        base_dir=tmp_path,
        capture_browser=True,
    )

    manual = result.artifacts.markdown_manual.read_text(encoding="utf-8")
    subtitles = result.artifacts.subtitles.read_text(encoding="utf-8")
    preview = result.artifacts.html_preview.read_text(encoding="utf-8")
    tts_metadata = json.loads(result.artifacts.tts_metadata.read_text(encoding="utf-8"))

    assert "입력: 질문" in manual
    assert "클릭: 답변 복사" in manual
    assert "st.form과 st.input 차이" in subtitles
    assert "subtitles.vtt" in preview
    assert "manual_video_agent_usage.webm" in preview
    assert [entry["step_id"] for entry in tts_metadata["entries"]][:2] == ["demo_start", "demo_01_input"]


def _legacy_test_demonstration_pipeline_replays_events_after_tts_for_final_video(tmp_path, monkeypatch):
    calls = {}

    def fake_capture(request, plan, dirs, settings):
        import base64

        capture = dirs.captures / "direct_demo.png"
        capture.write_bytes(
            base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
            )
        )
        direct_video = dirs.package / "direct_demonstration_source.webm"
        direct_video.write_bytes(b"direct-demo")
        action_log = [
            {"type": "demonstration", "status": "ok", "event_count": 2},
            {"type": "input", "label": "질문", "value": "st.form과 st.input 차이"},
            {"type": "click", "text": "전송"},
        ]
        action_log_path = dirs.package / "capture_action_log.json"
        action_log_path.write_text(json.dumps({"status": "completed", "entries": action_log}, ensure_ascii=False), encoding="utf-8")
        return {
            "captures": [capture],
            "masked_names": [capture.name],
            "video": direct_video,
            "final_frame": capture,
            "action_log": action_log,
            "action_log_path": action_log_path,
            "status": "ok",
            "degrade_reason": "",
            "storage_state": {"cookies": [{"name": "sid", "value": "demo"}], "origins": []},
        }

    def fake_replay(request, media_plan, action_log, dirs, settings, *, tts_audio, storage_state=None, run_id="", terminal=None):
        calls["replay"] = {
            "source": media_plan.get("source"),
            "tts_audio_count": len(tts_audio),
            "storage_state": storage_state,
            "run_id": run_id,
            "terminal": terminal,
        }
        replay_capture = dirs.captures / "playwright_replay.png"
        replay_capture.write_bytes((dirs.captures / "direct_demo.png").read_bytes())
        replay_video = dirs.package / "manual_video_agent_usage.webm"
        replay_video.write_bytes(b"playwright-replay")
        return {
            "status": "ok",
            "degrade_reason": "",
            "video": replay_video,
            "captures": [replay_capture],
            "masked_names": [replay_capture.name],
            "final_frame": replay_capture,
            "action_log": [{"type": "demonstration_replay", "status": "ok", "event_count": 2}],
        }

    class FakeVideoRender:
        def __init__(self, package_dir: Path, fallback_video: Path):
            self.video_path = package_dir / "manual_video_agent_usage.mp4"
            self.video_path.write_bytes(fallback_video.read_bytes())
            self.composition_dir = package_dir / "hyperframes"
            self.composition_dir.mkdir(exist_ok=True)
            self.composition_dir.joinpath("index.html").write_text("<html></html>", encoding="utf-8")
            self.metadata_path = package_dir / "video_render.json"
            self.metadata_path.write_text(
                json.dumps({"fallback_video": str(fallback_video), "used_fallback": True}, ensure_ascii=False),
                encoding="utf-8",
            )
            self.skills_metadata_path = package_dir / "hyperframes_skills.json"
            self.skills_metadata_path.write_text("{}", encoding="utf-8")
            self.used_fallback = True

    def fake_render_final_video(*, plan, package_dir, preview_html, fallback_video, settings, tts_audio):
        calls["render_fallback"] = fallback_video
        return FakeVideoRender(package_dir, fallback_video)

    monkeypatch.setattr(pipeline_module, "_capture_with_playwright", fake_capture)
    monkeypatch.setattr(pipeline_module, "_replay_demonstration_with_playwright", fake_replay, raising=False)
    monkeypatch.setattr(pipeline_module, "render_final_video", fake_render_final_video)

    result = run_pipeline(
        PipelineInput(
            request_text="사내 챗봇 시연",
            target_url="http://internal.example.local/chat",
            role="사용자",
            completion_condition="답변",
            execution_mode="demonstration",
        ),
        base_dir=tmp_path,
        capture_browser=True,
    )

    assert calls["replay"]["source"] == "direct-demonstration-media-plan"
    assert calls["replay"]["tts_audio_count"] > 0
    assert calls["replay"]["storage_state"]["cookies"][0]["name"] == "sid"
    assert calls["replay"]["run_id"].startswith("job_")
    assert calls["replay"]["terminal"] is not None
    assert calls["render_fallback"].name == "manual_video_agent_usage.webm"
    assert calls["render_fallback"].read_bytes() == b"playwright-replay"
    assert result.artifacts.video.read_bytes() == b"playwright-replay"


def _legacy_test_ai_browser_pipeline_replays_action_log_after_tts_for_sync(tmp_path, monkeypatch):
    def fake_capture(request, plan, dirs, settings):
        import base64

        capture = dirs.captures / "ai_capture.png"
        capture.write_bytes(
            base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
            )
        )
        video = dirs.package / "manual_video_agent_usage.webm"
        video.write_bytes(b"webm")
        action_log = [
            {"type": "click_by_text", "status": "ok", "texts": ["닫기"], "selector": "#modal-close"},
            {"type": "capture_step", "status": "ok", "capture": str(capture)},
        ]
        action_log_path = dirs.package / "capture_action_log.json"
        action_log_path.write_text(json.dumps({"status": "completed", "entries": action_log}, ensure_ascii=False), encoding="utf-8")
        return {
            "captures": [capture],
            "masked_names": [capture.name],
            "video": video,
            "final_frame": capture,
            "action_log": action_log,
            "action_log_path": action_log_path,
            "status": "ok",
            "degrade_reason": "",
        }

    calls = {}

    def fake_replay(request, media_plan, action_log, dirs, settings, *, tts_audio, storage_state=None, run_id="", terminal=None):
        calls["replay"] = {
            "source": media_plan.get("source"),
            "audio_count": len(tts_audio),
            "event_count": len(pipeline_module._demonstration_events_for_media(action_log)),
        }
        replay_capture = dirs.captures / "ai_replay.png"
        replay_capture.write_bytes((dirs.captures / "ai_capture.png").read_bytes())
        replay_video = dirs.package / "manual_video_agent_usage.webm"
        replay_video.write_bytes(b"ai-replay")
        return {
            "status": "ok",
            "degrade_reason": "",
            "video": replay_video,
            "captures": [replay_capture],
            "masked_names": [replay_capture.name],
            "final_frame": replay_capture,
            "action_log": [{"type": "demonstration_replay", "status": "ok", "event_count": 1}],
        }

    class FakeVideoRender:
        def __init__(self, package_dir: Path, fallback_video: Path):
            self.video_path = package_dir / "final.mp4"
            self.video_path.write_bytes(fallback_video.read_bytes())
            self.metadata_path = package_dir / "video_render.json"
            self.metadata_path.write_text(json.dumps({"used_fallback": True}), encoding="utf-8")
            self.composition_dir = package_dir / "hyperframes"
            self.composition_dir.mkdir()
            (self.composition_dir / "index.html").write_text("<html></html>", encoding="utf-8")
            self.used_fallback = True
            self.skills_metadata_path = None

    monkeypatch.setattr(pipeline_module, "_capture_with_playwright", fake_capture)
    monkeypatch.setattr(pipeline_module, "_replay_demonstration_with_playwright", fake_replay, raising=False)
    monkeypatch.setattr(
        pipeline_module,
        "render_final_video",
        lambda *, plan, package_dir, preview_html, fallback_video, settings, tts_audio: FakeVideoRender(package_dir, fallback_video),
    )

    result = run_pipeline(
        PipelineInput(
            request_text="모달창을 확인하고 닫기",
            target_url="http://internal.example.local/app",
            role="사용자",
            completion_condition="모달이 닫히면 완료",
            execution_mode="ai",
        ),
        base_dir=tmp_path,
        capture_browser=True,
    )

    assert calls["replay"]["source"] == "browser-agent-media-plan"
    assert calls["replay"]["audio_count"] > 0
    assert calls["replay"]["event_count"] == 2
    assert result.artifacts.video.read_bytes() == b"ai-replay"


def test_demonstration_replay_executes_events_with_audio_timing(tmp_path, monkeypatch):
    import io
    import wave
    import playwright.sync_api as sync_api

    events = []

    def write_wav(path: Path, duration_seconds: float):
        frame_rate = 8000
        frame_count = int(frame_rate * duration_seconds)
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(frame_rate)
            handle.writeframes(b"\x00\x00" * frame_count)

    class FakeLocator:
        def __init__(self, kind, name):
            self.kind = kind
            self.name = name

        def fill(self, value, **kwargs):
            events.append(("fill", self.kind, self.name, value))

        def click(self, **kwargs):
            events.append(("click", self.kind, self.name))

    class FakeKeyboard:
        def press(self, key):
            events.append(("key", key))

    class FakePage:
        keyboard = FakeKeyboard()

        def set_default_timeout(self, timeout):
            events.append(("set_default_timeout", timeout))

        def set_default_navigation_timeout(self, timeout):
            events.append(("set_default_navigation_timeout", timeout))

        def goto(self, url, wait_until):
            events.append(("goto", url, wait_until))

        def wait_for_load_state(self, state, timeout):
            events.append(("wait_for_load_state", state, timeout))

        def wait_for_function(self, expression, timeout):
            events.append(("wait_for_function", timeout))
            return True

        def add_style_tag(self, content):
            events.append(("add_style_tag", "manual-cursor" in content))

        def add_init_script(self, script):
            events.append(("add_init_script", "__manualInstallRecordingHelpers" in script))

        def evaluate(self, script, *args):
            events.append(("evaluate", script if isinstance(script, str) and script.startswith("window.") else "script", args))

        def wait_for_timeout(self, timeout):
            events.append(("wait_for_timeout", timeout))

        def screenshot(self, path, full_page):
            events.append(("screenshot", Path(path).name, full_page))
            Path(path).write_bytes(b"png")

        def get_by_label(self, name, *args, **kwargs):
            return FakeLocator("label", name)

        def get_by_placeholder(self, name, *args, **kwargs):
            return FakeLocator("placeholder", name)

        def get_by_role(self, role, *args, **kwargs):
            return FakeLocator(role, kwargs.get("name") or "")

        def get_by_text(self, text, *args, **kwargs):
            return FakeLocator("text", text)

    class FakeContext:
        def __init__(self, options):
            self.options = options

        def new_page(self):
            events.append(("new_page",))
            return FakePage()

        def close(self):
            raw_dir = Path(self.options["record_video_dir"])
            raw_dir.mkdir(parents=True, exist_ok=True)
            (raw_dir / "replay.webm").write_bytes(b"replay-webm")
            events.append(("context_close",))

    class FakeBrowser:
        def new_context(self, **kwargs):
            events.append(("new_context", kwargs.get("storage_state"), bool(kwargs.get("record_video_dir"))))
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
        request_timeout_seconds = 60.0

    dirs = _make_dirs(tmp_path / "package")
    audio_paths = [dirs.tts / "00.wav", dirs.tts / "01.wav", dirs.tts / "02.wav", dirs.tts / "03.wav"]
    for path, duration in zip(audio_paths, [1.1, 2.0, 1.5, 1.2]):
        write_wav(path, duration)

    media_plan = {
        "source": "direct-demonstration-media-plan",
        "steps": [
            {"id": "demo_start", "title": "시작", "caption": "시작", "narration": "시작"},
            {"id": "demo_01_input", "title": "질문 입력", "caption": "질문 입력", "narration": "질문 입력"},
            {"id": "demo_02_click", "title": "전송 클릭", "caption": "전송 클릭", "narration": "전송 클릭"},
            {"id": "demo_03_key", "title": "Enter", "caption": "Enter", "narration": "Enter"},
        ],
    }
    action_log = [
        {"type": "demonstration", "status": "ok", "event_count": 3},
        {"type": "input", "label": "질문", "value": "st.form과 st.input 차이"},
        {"type": "click", "text": "전송"},
        {"type": "key", "key": "Enter", "label": "질문"},
    ]
    terminal_stream = io.StringIO()
    terminal = pipeline_module.TerminalRunLogger(enabled=True, stream=terminal_stream)

    result = pipeline_module._replay_demonstration_with_playwright(
        PipelineInput(
            request_text="챗봇 질문",
            target_url="http://internal.example.local/chat",
            role="사용자",
            completion_condition="답변",
            execution_mode="demonstration",
        ),
        media_plan,
        action_log,
        dirs,
        Settings(),
        tts_audio=audio_paths,
        storage_state={"cookies": [{"name": "sid", "value": "ok"}], "origins": []},
        run_id="job-test",
        terminal=terminal,
    )

    assert result["status"] == "ok"
    assert result["video"].name == "manual_video_agent_usage.webm"
    assert result["video"].read_bytes() == b"replay-webm"
    assert ("set_default_timeout", 8000) in events
    assert ("set_default_navigation_timeout", 60000) in events
    assert ("new_context", {"cookies": [{"name": "sid", "value": "ok"}], "origins": []}, True) in events
    assert ("fill", "label", "질문", "st.form과 st.input 차이") in events
    assert ("click", "button", "전송") in events
    assert ("key", "Enter") in events
    assert any(item == ("wait_for_timeout", 1100) for item in events)
    assert len(result["captures"]) == 3
    terminal_text = terminal_stream.getvalue()
    assert '"actor": "replay"' in terminal_text
    assert '"status": "navigate-started"' in terminal_text
    assert '"status": "initial-wait"' in terminal_text
    assert '"status": "event-started"' in terminal_text
    assert '"status": "event-ok"' in terminal_text
    assert '"component": "direct-playwright-replay"' in terminal_text


def test_demonstration_replay_click_prefers_recorded_coordinates_over_text():
    events = []

    class Mouse:
        def click(self, x, y):
            events.append(("mouse_click", x, y))

    class FakePage:
        mouse = Mouse()

        def evaluate(self, script, *args):
            events.append(("evaluate", script, args))

        def wait_for_timeout(self, timeout):
            events.append(("wait_for_timeout", timeout))

        def get_by_role(self, role, *args, **kwargs):
            raise AssertionError("coordinate replay must not re-pick a button by text")

        def get_by_text(self, text, *args, **kwargs):
            raise AssertionError("coordinate replay must not re-pick text")

    log = pipeline_module._execute_demonstration_replay_event(
        FakePage(),
        {"type": "click", "text": "전송", "client_x": 321, "client_y": 456},
        {"id": "demo_click"},
        1.0,
    )

    assert log["status"] == "ok"
    assert log["method"] == "mouse.click:321,456"
    assert ("mouse_click", 321, 456) in events


def test_demonstration_replay_uses_recorded_selector_before_text_when_no_coordinates():
    events = []

    class Locator:
        def click(self):
            events.append(("locator_click", "#exact-send"))

    class FakePage:
        def evaluate(self, script, *args):
            events.append(("evaluate", script, args))

        def wait_for_timeout(self, timeout):
            events.append(("wait_for_timeout", timeout))

        def locator(self, selector):
            events.append(("locator", selector))
            if selector != "#exact-send":
                raise AssertionError("must use recorded selector first")
            return Locator()

        def get_by_role(self, role, *args, **kwargs):
            raise AssertionError("recorded selector must be tried before text")

    log = pipeline_module._execute_demonstration_replay_event(
        FakePage(),
        {"type": "click", "text": "전송", "selector": "#exact-send"},
        {"id": "demo_click"},
        1.0,
    )

    assert log["status"] == "ok"
    assert log["method"] == "locator:#exact-send"
    assert ("locator_click", "#exact-send") in events


def test_demonstration_replay_uses_cdp_context_when_configured(tmp_path, monkeypatch):
    import playwright.sync_api as sync_api

    events = []

    class FakeLocator:
        def __init__(self, kind, value):
            self.kind = kind
            self.value = value

        def click(self):
            events.append(("click", self.kind, self.value))

    class FakePage:
        def set_default_timeout(self, timeout):
            events.append(("set_default_timeout", timeout))

        def set_default_navigation_timeout(self, timeout):
            events.append(("set_default_navigation_timeout", timeout))

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
            return None

        def wait_for_timeout(self, timeout):
            events.append(("wait_for_timeout", timeout))

        def screenshot(self, path, full_page):
            events.append(("screenshot", Path(path).name, full_page))
            Path(path).write_bytes(b"png")

        def get_by_role(self, role, *args, **kwargs):
            return FakeLocator(role, kwargs.get("name") or "")

        @property
        def keyboard(self):
            class Keyboard:
                def press(_self, key):
                    events.append(("key", key))
            return Keyboard()

    class FakeContext:
        pages = [FakePage()]

        def new_page(self):
            events.append(("new_page",))
            return FakePage()

        def close(self):
            events.append(("context_close",))

    class FakeBrowser:
        contexts = [FakeContext()]

        def new_context(self, **kwargs):
            events.append(("new_context", kwargs))
            raise AssertionError("CDP replay must use attached context to preserve SSO")

        def close(self):
            events.append(("browser_close",))

    class FakeChromium:
        def connect_over_cdp(self, endpoint):
            events.append(("connect_over_cdp", endpoint))
            return FakeBrowser()

        def launch(self, **kwargs):
            events.append(("launch", kwargs))
            raise AssertionError("CDP replay must not launch a fresh browser")

    class FakePlaywright:
        chromium = FakeChromium()

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(sync_api, "sync_playwright", lambda: FakePlaywright())

    class Settings:
        playwright_executable_path = ""
        browser_runner = "cdp_attach"
        cdp_endpoint = "http://127.0.0.1:9222"
        request_timeout_seconds = 60.0

    dirs = _make_dirs(tmp_path / "package")
    audio = dirs.tts / "00.wav"
    audio.parent.mkdir(parents=True, exist_ok=True)
    audio.write_bytes(b"")
    result = pipeline_module._replay_demonstration_with_playwright(
        PipelineInput(
            request_text="CDP 시연 replay",
            target_url="http://internal.example.local/app",
            role="사용자",
            completion_condition="완료",
            execution_mode="demonstration",
        ),
        {"steps": [{"id": "demo_start", "title": "시작", "caption": "시작"}]},
        [{"type": "demonstration", "status": "ok"}, {"type": "click", "text": "조회"}],
        dirs,
        Settings(),
        tts_audio=[audio],
        storage_state={"cookies": [{"name": "sid", "value": "unused"}]},
    )

    assert ("connect_over_cdp", "http://127.0.0.1:9222") in events
    assert not any(event[0] == "launch" for event in events)
    assert not any(event[0] == "new_context" for event in events)
    assert not any(event[0] == "context_close" for event in events)
    assert result["status"] == "degraded"
    assert result["degrade_reason"] == "demonstration_replay_recording_missing"
    assert any(entry.get("reason") == "cdp_attach_existing_context_no_video_recording" for entry in result["action_log"])


def test_demonstration_replay_uses_sso_profile_edge_channel(tmp_path, monkeypatch):
    import playwright.sync_api as sync_api

    events = []

    class FakePage:
        def set_default_timeout(self, timeout):
            events.append(("set_default_timeout", timeout))

        def set_default_navigation_timeout(self, timeout):
            events.append(("set_default_navigation_timeout", timeout))

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

        def get_by_role(self, role, *args, **kwargs):
            class Locator:
                def click(self):
                    events.append(("click", role, kwargs.get("name") or ""))

            return Locator()

    class FakePersistentContext:
        pages = [FakePage()]

        def close(self):
            raw_dir = Path(self.record_video_dir)
            raw_dir.mkdir(parents=True, exist_ok=True)
            (raw_dir / "edge-replay.webm").write_bytes(b"edge-replay")
            events.append(("persistent_close",))

    class FakeChromium:
        def launch_persistent_context(self, user_data_dir, **kwargs):
            events.append(("launch_persistent_context", user_data_dir, kwargs.get("channel"), kwargs.get("headless")))
            context = FakePersistentContext()
            context.record_video_dir = kwargs["record_video_dir"]
            return context

        def launch(self, **kwargs):
            events.append(("launch", kwargs))
            raise AssertionError("sso_profile replay must not launch bundled Chromium")

    class FakePlaywright:
        chromium = FakeChromium()

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(sync_api, "sync_playwright", lambda: FakePlaywright())

    class Settings:
        playwright_executable_path = ""
        browser_runner = "playwright"
        request_timeout_seconds = 60.0

        class login:
            mode = "sso_profile"
            sso_profile_dir = str(tmp_path / "edge-profile")
            browser_channel = "msedge"
            auth_server_allowlist = "*.corp.local"
            auth_negotiate_delegate_allowlist = "*.corp.local"

    dirs = _make_dirs(tmp_path / "package")
    result = pipeline_module._replay_demonstration_with_playwright(
        PipelineInput(
            request_text="SSO replay",
            target_url="http://internal.example.local/app",
            role="사용자",
            completion_condition="완료",
            execution_mode="demonstration",
            login_mode="sso_profile",
        ),
        {"steps": [{"id": "demo_start", "title": "시작", "caption": "시작"}]},
        [{"type": "demonstration", "status": "ok"}, {"type": "click", "text": "조회"}],
        dirs,
        Settings(),
        tts_audio=[],
        storage_state={"cookies": [{"name": "sid", "value": "unused"}]},
    )

    assert any(event[0] == "launch_persistent_context" and event[2] == "msedge" and event[3] is False for event in events)
    assert not any(event[0] == "launch" for event in events)
    assert result["status"] == "ok"
    assert result["video"].read_bytes() == b"edge-replay"


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
    assert result["degrade_reason"] == "browser_recording_missing_or_invalid"


def test_capture_with_playwright_can_attach_to_cdp_browser_context(tmp_path, monkeypatch):
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
        pages = [FakePage()]

        def new_page(self):
            events.append(("new_page",))
            return FakePage()

        def close(self):
            events.append(("context_close",))

    class FakeBrowser:
        contexts = [FakeContext()]

        def close(self):
            events.append(("browser_close",))

    class FakeChromium:
        def connect_over_cdp(self, endpoint):
            events.append(("connect_over_cdp", endpoint))
            return FakeBrowser()

        def launch(self, **kwargs):
            events.append(("launch", kwargs))
            raise AssertionError("CDP runner must not launch a new browser")

    class FakePlaywright:
        chromium = FakeChromium()

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(sync_api, "sync_playwright", lambda: FakePlaywright())

    class Settings:
        playwright_executable_path = ""
        browser_runner = "cdp_attach"
        cdp_endpoint = "http://127.0.0.1:9222"
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
        request_text="CDP로 열린 브라우저 화면 확인",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="홈",
    )

    result = _capture_with_playwright(request, plan, dirs, Settings())

    assert ("connect_over_cdp", "http://127.0.0.1:9222") in events
    assert not any(event[0] == "launch" for event in events)
    assert result["video"].exists()
    assert result["status"] == "degraded"
    assert result["degrade_reason"] == "browser_recording_missing_or_invalid"


def test_capture_can_use_extension_bridge_observe_act_verify_runner(tmp_path, monkeypatch):
    calls = []

    def fake_post(url, headers, payload, timeout_seconds):
        calls.append({"url": url, "headers": headers, "payload": payload, "timeout": timeout_seconds})
        if url.endswith("/observe"):
            return {
                "status": "ok",
                "observation": {
                    "url": "http://internal.example.local",
                    "fields": [{"label": "질문", "value": ""}],
                    "clickables": [{"text": "전송"}],
                    "body_text": "사내 챗봇",
                },
            }
        if url.endswith("/act"):
            return {"status": "ok", "result": {"status": "ok", "method": "extension.fill"}}
        if url.endswith("/verify"):
            return {"status": "ok", "verification": {"status": "ok", "reason": "extension_verified"}}
        raise AssertionError(url)

    monkeypatch.setattr(pipeline_module, "post_json", fake_post)

    class Settings:
        browser_runner = "extension_bridge"
        extension_bridge_endpoint = "http://127.0.0.1:8765"
        extension_bridge_token = "bridge-token"
        request_timeout_seconds = 5
        enable_browser_agent = True
        browser_agent_max_steps = 1

        class llm:
            is_configured = True

    plan = {"steps": [{"id": "step_intro", "title": "챗봇", "caption": "챗봇"}], "actions": []}
    dirs = _make_dirs(tmp_path / "package")
    request = PipelineInput(
        request_text="질문 입력",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="답변",
        input_values={"질문": "st.form과 st.input 차이"},
    )

    def fake_decide(request, settings, observation, history, step_index):
        return {
            "status": "ok",
            "source": "browser-agent-llm",
            "type": "fill_by_label",
            "label": "질문",
            "value": "st.form과 st.input 차이",
            "reason": "질문 입력",
        }

    result = pipeline_module._capture_with_extension_bridge(request, plan, dirs, Settings(), decide_next=fake_decide)

    assert result["status"] == "degraded"
    assert result["degrade_reason"] == "extension_bridge_video_unavailable"
    assert result["video"].exists()
    assert result["action_log"][0]["source"] == "extension-bridge"
    assert result["action_log"][0]["verification"]["status"] == "ok"
    assert [call["url"] for call in calls][:3] == [
        "http://127.0.0.1:8765/observe",
        "http://127.0.0.1:8765/act",
        "http://127.0.0.1:8765/verify",
    ]
    assert calls[0]["headers"]["Authorization"] == "Bearer bridge-token"


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
