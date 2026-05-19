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
    _capture_action_log_status,
    _capture_with_playwright,
    _execute_capture_actions,
    _execute_browser_agent_actions,
    _media_plan_for_outputs,
    _handle_login,
    _install_manual_login_signal,
    _install_demonstration_recorder,
    _inject_recording_helpers,
    _make_dirs,
    _playwright_launch_kwargs,
    _prepare_capture_page,
    _render_subtitles,
    _raise_if_login_failed,
    _resolve_login_options,
    rerender_pipeline_package,
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


def test_pipeline_passes_tts_audio_to_video_renderer(tmp_path, monkeypatch):
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


def test_supertonic_manual_includes_ai_voice_license_notice(tmp_path, monkeypatch):
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
        "subtitles",
        "media_plan",
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


def test_text_artifact_api_allows_editing_generated_markdown(tmp_path, monkeypatch):
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
    assert result.artifacts.markdown_manual.read_text(encoding="utf-8") == "# 수정된 매뉴얼\n\n사용자 편집본"


def test_text_artifact_api_rejects_non_text_and_path_traversal(tmp_path, monkeypatch):
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


def test_rerender_pipeline_package_uses_edited_subtitles_without_recapture(tmp_path):
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


def test_pipeline_rerender_api_returns_updated_artifacts(tmp_path, monkeypatch):
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
    settings = load_settings(environ={"MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true", "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS": "1"})

    def decide_next(request, settings, observation, history, step_index):
        return {"status": "ok", "type": "press_key", "key": "Enter", "reason": "채팅 질문 전송"}

    result = _execute_browser_agent_actions(FakePage(), request, {"actions": []}, tmp_path, settings, decide_next=decide_next)

    assert ("press", "Enter") in events
    assert result["action_log"][0]["type"] == "press_key"
    assert result["action_log"][0]["status"] == "ok"


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
    assert "입력: 질문" in subtitle_text
    assert "클릭: 답변 복사" in subtitle_text


def test_demonstration_pipeline_uses_recorded_events_for_outputs(tmp_path, monkeypatch):
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


def test_demonstration_pipeline_replays_events_after_tts_for_final_video(tmp_path, monkeypatch):
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

        def fill(self, value):
            events.append(("fill", self.kind, self.name, value))

        def click(self):
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
    assert ("set_default_navigation_timeout", 15000) in events
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
