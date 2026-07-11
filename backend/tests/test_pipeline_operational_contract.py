from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path
import shutil
from types import SimpleNamespace

import pytest

import backend.app.opencode_orchestrator as orchestrator_module
import backend.app.pipeline as pipeline_module
from backend.app.execution_trace import validate_execution_trace
from backend.app.opencode_orchestrator import OrchestratorServices
from backend.app.pipeline import PipelineInput, _execute_capture_actions, continue_pipeline_draft, create_pipeline_draft


def _request() -> PipelineInput:
    return PipelineInput(
        request_text="사내 챗봇에 프롬프트를 입력하고 응답 결과를 확인",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변이 보이면 완료",
        execution_mode="ai",
        input_values={"프롬프트": "st.form과 st.input 차이"},
    )


def _trace() -> dict[str, object]:
    return {
        "schema_version": "1.0",
        "status": "completed",
        "request_summary": "챗봇에 질문하고 답변을 확인한다.",
        "input_values": ["프롬프트"],
        "steps": [
            {
                "id": "step-chat",
                "title": "질문 입력",
                "narration": "대화 입력창에 질문을 입력하고 답변을 확인합니다.",
                "actions": [
                    {
                        "id": "navigate-chat",
                        "type": "navigate",
                        "target_url": "http://internal.example.local/chat",
                        "observed_url": "http://internal.example.local/chat",
                    },
                    {
                        "id": "fill-chat",
                        "type": "fill",
                        "ref": "e-input",
                        "label": "대화 입력창",
                        "value_key": "프롬프트",
                        "observed_url": "http://internal.example.local/chat",
                        "expected_after": "입력창에 요청 내용이 표시된다.",
                    },
                ],
            }
        ],
        "completion_evidence": {
            "final_url": "http://internal.example.local/chat",
            "assertions": ["답변이 표시된다."],
            "screenshot_path": "discovery/completed.png",
        },
    }


def _fake_services(calls: list[str], *, fail_stage: str = "") -> OrchestratorServices:
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
            paths = {
                "config_path": job_dir / "opencode.json",
                "prompt_path": job_dir / "opencode_browser_prompt.md",
                "event_log_path": job_dir / "opencode_events.jsonl",
                "trace_path": job_dir / "opencode_execution_trace.json",
                "metadata_path": job_dir / "opencode_browser_metadata.json",
                "support_summary_path": job_dir / "opencode_support_summary.txt",
            }
            paths["config_path"].write_text("{}", encoding="utf-8")
            paths["prompt_path"].write_text("prompt", encoding="utf-8")
            paths["event_log_path"].write_text("{}\n", encoding="utf-8")
            paths["trace_path"].write_text(json.dumps(_trace(), ensure_ascii=False), encoding="utf-8")
            paths["metadata_path"].write_text('{"status":"completed"}', encoding="utf-8")
            paths["support_summary_path"].write_text("OPENCODE_BROWSER_OK\n", encoding="utf-8")
            if fail_stage == "opencode":
                raise RuntimeError("opencode failed")
            return SimpleNamespace(status="completed", trace=_trace(), **paths)

    def tts_synthesizer(_plan, _settings, tts_dir):
        calls.append("tts")
        tts_dir.mkdir(parents=True, exist_ok=True)
        audio = tts_dir / "01_step-chat.wav"
        audio.write_bytes(b"RIFF" + b"\x00" * 128)
        entries = [{"step_id": "step-chat", "duration_seconds": 1.0, "provider": "supertonic", "speaker": "M1"}]
        metadata = tts_dir / "tts_metadata.json"
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
        selector_trace = job_dir / "selector_trace.json"
        selector_trace.write_text("[]", encoding="utf-8")
        action_log = [{"action_id": "navigate-chat", "status": "ok"}]
        action_log_path = job_dir / "trace_replay_log.json"
        action_log_path.write_text(json.dumps(action_log), encoding="utf-8")
        return SimpleNamespace(
            status="ok",
            captures=[capture],
            final_frame=final_frame,
            action_log=action_log,
            action_log_path=action_log_path,
            selector_trace_path=selector_trace,
            media_plan={
                "source": "opencode-trace-replay",
                "steps": [
                    {
                        "id": "step-chat",
                        "title": "질문 입력",
                        "caption": "대화 입력창에 질문을 입력하고 답변을 확인합니다.",
                        "narration": "대화 입력창에 질문을 입력하고 답변을 확인합니다.",
                        "duration_seconds": 1.0,
                    }
                ],
            },
        )

    def masker(captures, masked_dir, _input_values):
        calls.append("masking")
        masked_dir.mkdir(parents=True, exist_ok=True)
        for capture in captures:
            shutil.copy2(capture, masked_dir / capture.name)
        path = masked_dir.parent / "masking_log.json"
        path.write_text('{"status":"completed","entries":[]}', encoding="utf-8")
        return path

    def source_video_builder(package_dir, _captures):
        calls.append("source_video")
        path = package_dir / "manual_video_agent_usage.webm"
        path.write_bytes(b"webm")
        return path

    def subtitle_renderer(_plan, package_dir, redaction=None):
        calls.append("subtitles")
        path = package_dir / "subtitles.vtt"
        path.write_text("WEBVTT\n", encoding="utf-8")
        return path

    def preview_renderer(_request, _plan, dirs, _masked_names, _tts_audio, **_kwargs):
        calls.append("preview")
        path = dirs.package / "preview.html"
        path.write_text("<html>preview</html>", encoding="utf-8")
        return path

    def markdown_renderer(_request, _plan, dirs, _masked_names, _settings):
        calls.append("manual")
        path = dirs.package / "manual.md"
        path.write_text("# manual", encoding="utf-8")
        return path

    def pdf_renderer(_request, dirs):
        calls.append("pdf")
        path = dirs.package / "manual.pdf"
        path.write_bytes(b"%PDF")
        return path

    def video_renderer(**kwargs):
        calls.append("render")
        if fail_stage == "render":
            raise RuntimeError("render failed")
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
            used_fallback=False,
        )

    return OrchestratorServices(
        environment_fingerprint=lambda: calls.append("environment") or {"python_version": "3.13.14"},
        browser_session_factory=browser_session_factory,
        discovery_factory=lambda _settings: Discovery(),
        trace_validator=lambda trace, request, policy: calls.append("trace_validation")
        or validate_execution_trace(trace, request, policy),
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


def _install_fake_services(monkeypatch: pytest.MonkeyPatch, calls: list[str], *, fail_stage: str = "") -> None:
    monkeypatch.setattr(orchestrator_module, "production_services", lambda: _fake_services(calls, fail_stage=fail_stage))


def test_continue_restores_retryable_workflow_state_when_required_stage_fails(tmp_path: Path, monkeypatch):
    calls: list[str] = []
    _install_fake_services(monkeypatch, calls, fail_stage="render")
    draft = create_pipeline_draft(_request(), base_dir=tmp_path)
    state_path = draft.package_dir / "workflow_state.json"

    with pytest.raises(RuntimeError, match="render failed"):
        continue_pipeline_draft(draft.job_id, base_dir=tmp_path)

    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["status"] == "failed"
    assert state["current_step"] == "execution_failed"
    assert state["can_continue"] is True
    assert state["details"]["degraded"] is False
    assert "RuntimeError: render failed" in state["last_error"]
    support_text = (draft.package_dir / "support_log.md").read_text(encoding="utf-8")
    assert "RuntimeError: render failed" in support_text
    assert "workflow_state.json" in support_text


def test_continue_is_idempotent_after_workflow_completed(tmp_path: Path, monkeypatch):
    calls: list[str] = []
    _install_fake_services(monkeypatch, calls)
    draft = create_pipeline_draft(_request(), base_dir=tmp_path)
    first_result = continue_pipeline_draft(draft.job_id, base_dir=tmp_path)
    calls_after_first = list(calls)

    second_result = continue_pipeline_draft(draft.job_id, base_dir=tmp_path)

    assert second_result.job_id == first_result.job_id
    assert second_result.artifacts.package_manifest == first_result.artifacts.package_manifest
    assert calls == calls_after_first


def test_continue_updates_workflow_to_new_opencode_only_graph(tmp_path: Path, monkeypatch):
    calls: list[str] = []
    _install_fake_services(monkeypatch, calls)
    draft = create_pipeline_draft(_request(), base_dir=tmp_path)

    result = continue_pipeline_draft(draft.job_id, base_dir=tmp_path)

    state = json.loads((result.package_dir / "workflow_state.json").read_text(encoding="utf-8"))
    assert state["status"] == "completed"
    assert state["current_step"] == "completed"
    assert state["workflow_graph"]["version"] == 2
    graph_steps = [node["step"] for node in state["workflow_graph"]["nodes"]]
    assert graph_steps == [
        "request_validation",
        "plan_review",
        "browser_session",
        "opencode_discovery",
        "trace_validation",
        "tts",
        "replay",
        "masking",
        "preview",
        "render",
        "manifest",
        "execution_failed",
        "completed",
    ]
    assert "capture" not in graph_steps
    assert "mcp_rehearsal_after_login" not in graph_steps
    assert "opencode" not in graph_steps


def test_public_pipeline_never_calls_legacy_rehearsal_or_postpass(tmp_path: Path, monkeypatch):
    calls: list[str] = []
    _install_fake_services(monkeypatch, calls)

    def forbidden(*_args, **_kwargs):
        raise AssertionError("legacy runtime path was called")

    for name in (
        "build_plan",
        "extract_input_values",
        "rehearse_plan",
        "run_opencode_agent",
        "decide_browser_agent_action",
        "enrich_page_agent_observation",
    ):
        monkeypatch.setattr(pipeline_module, name, forbidden)

    draft = create_pipeline_draft(_request(), base_dir=tmp_path)
    result = continue_pipeline_draft(draft.job_id, base_dir=tmp_path)

    rehearsal = json.loads((result.package_dir / "rehearsal_log.json").read_text(encoding="utf-8"))
    assert rehearsal["adapter"] == "opencode-playwright-mcp"
    assert rehearsal["executed"] is True
    assert calls.count("opencode_discovery") == 1


def test_opencode_failure_is_fatal_and_not_a_login_or_capture_fallback(tmp_path: Path, monkeypatch):
    calls: list[str] = []
    _install_fake_services(monkeypatch, calls, fail_stage="opencode")
    draft = create_pipeline_draft(_request(), base_dir=tmp_path)

    with pytest.raises(RuntimeError, match="opencode failed"):
        continue_pipeline_draft(draft.job_id, base_dir=tmp_path)

    state = json.loads((draft.package_dir / "workflow_state.json").read_text(encoding="utf-8"))
    assert state["status"] == "failed"
    assert state["details"]["actor"] == "opencode"
    assert state["details"]["degraded"] is False
    assert "trace_replay" not in calls
    assert "source_video" not in calls


def test_workflow_package_contract_shape_is_stable_for_sample_continue(tmp_path: Path, monkeypatch):
    calls: list[str] = []
    _install_fake_services(monkeypatch, calls)
    draft = create_pipeline_draft(_request(), base_dir=tmp_path)
    result = continue_pipeline_draft(draft.job_id, base_dir=tmp_path)

    state = json.loads((result.package_dir / "workflow_state.json").read_text(encoding="utf-8"))
    manifest = json.loads(result.artifacts.package_manifest.read_text(encoding="utf-8"))
    events = [json.loads(line) for line in result.artifacts.audit_log.read_text(encoding="utf-8").splitlines()]

    assert set(state).issuperset(
        {
            "status",
            "current_step",
            "workflow_node",
            "workflow_graph",
            "can_continue",
            "request",
            "capture_browser",
            "environment",
            "updated_at",
            "details",
        }
    )
    assert state["status"] == "completed"
    assert manifest["pipeline"] == "opencode-only"
    assert manifest["active_components"] == [
        "opencode",
        "playwright-mcp",
        "edge-cdp",
        "supertonic-m1",
        "trace-replay",
        "redaction",
        "hyperframes",
        "ffmpeg",
    ]
    assert Path(manifest["supporting_artifacts"]["support_log"]).exists()
    assert {"browser_session", "opencode", "trace_validation", "tts", "replay", "masking", "render", "manifest"}.issubset(
        {event["actor"] for event in events}
    )


def test_continue_rejects_job_id_path_traversal(tmp_path: Path):
    with pytest.raises(FileNotFoundError, match="invalid job id"):
        continue_pipeline_draft("..\\..\\outside", base_dir=tmp_path, capture_browser=False)


def test_fill_by_label_does_not_degrade_when_value_is_already_visible(tmp_path: Path):
    class MissingField:
        def fill(self, _value):
            raise TimeoutError("editable field missing")

    class VisibleText:
        first = None

        def __init__(self):
            self.first = self

        def wait_for(self, state, timeout):
            assert state == "visible"
            assert timeout == 1000

    class FakePage:
        def get_by_label(self, *_args, **_kwargs):
            return MissingField()

        def get_by_placeholder(self, *_args, **_kwargs):
            return MissingField()

        def locator(self, _selector):
            return MissingField()

        def get_by_text(self, text, **kwargs):
            assert text == "A3"
            assert kwargs == {"exact": True}
            return VisibleText()

        def wait_for_timeout(self, _timeout):
            pass

        def add_style_tag(self, content):
            assert "manual-caption" in content

        def evaluate(self, _script, *_args):
            pass

    result = _execute_capture_actions(
        FakePage(),
        {
            "steps": [{"id": "step_inputs", "title": "입력 확인"}],
            "actions": [
                {"id": "a1", "type": "fill_by_label", "label": "라인", "value": "A3", "step_id": "step_inputs"}
            ],
        },
        tmp_path,
    )

    assert result["status"] == "ok"
    assert result["degrade_reason"] == ""
    assert result["action_log"][0]["method"] == "value_visible:A3"
