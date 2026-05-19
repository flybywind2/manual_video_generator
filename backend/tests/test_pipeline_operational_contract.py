import json
from types import SimpleNamespace
from pathlib import Path

import pytest

import backend.app.pipeline as pipeline_module
from backend.app.pipeline import PipelineInput, _execute_capture_actions, continue_pipeline_draft, create_pipeline_draft


def _request() -> PipelineInput:
    return PipelineInput(
        request_text="사내 챗봇에 프롬프트를 입력하고 응답 결과를 확인",
        target_url="http://internal.example.local/chat",
        role="사용자",
        completion_condition="답변이 보이면 완료",
        execution_mode="demonstration",
        input_values={"프롬프트": "st.form과 st.input 차이"},
    )


def test_continue_restores_retryable_workflow_state_when_execution_fails(tmp_path: Path, monkeypatch):
    draft = create_pipeline_draft(_request(), base_dir=tmp_path, capture_browser=False)
    state_path = draft.package_dir / "workflow_state.json"

    def fail_execution(**_kwargs):
        raise RuntimeError("render failed")

    monkeypatch.setattr(pipeline_module, "_complete_pipeline_execution", fail_execution)

    with pytest.raises(RuntimeError, match="render failed"):
        continue_pipeline_draft(draft.job_id, base_dir=tmp_path, capture_browser=False)

    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["status"] == "failed"
    assert state["current_step"] == "execution_failed"
    assert state["can_continue"] is True
    assert "RuntimeError: render failed" in state["last_error"]


def test_continue_is_idempotent_after_workflow_completed(tmp_path: Path, monkeypatch):
    draft = create_pipeline_draft(_request(), base_dir=tmp_path, capture_browser=False)
    first_result = continue_pipeline_draft(draft.job_id, base_dir=tmp_path, capture_browser=False)

    def fail_if_rerun(**_kwargs):
        raise AssertionError("completed workflow must be loaded from manifest instead of rerun")

    monkeypatch.setattr(pipeline_module, "_complete_pipeline_execution", fail_if_rerun)

    second_result = continue_pipeline_draft(draft.job_id, base_dir=tmp_path, capture_browser=False)

    assert second_result.job_id == first_result.job_id
    assert second_result.artifacts.package_manifest == first_result.artifacts.package_manifest


def test_continue_updates_workflow_state_between_execution_stages(tmp_path: Path, monkeypatch):
    draft = create_pipeline_draft(_request(), base_dir=tmp_path, capture_browser=False)
    state_path = draft.package_dir / "workflow_state.json"
    observed_steps: list[str] = []

    original_synthesize_tts = pipeline_module.synthesize_tts

    def read_current_step() -> str:
        state = json.loads(state_path.read_text(encoding="utf-8"))
        return str(state["current_step"])

    def checking_synthesize_tts(*args, **kwargs):
        observed_steps.append(read_current_step())
        return original_synthesize_tts(*args, **kwargs)

    def checking_render_final_video(*, fallback_video, package_dir, **_kwargs):
        observed_steps.append(read_current_step())
        composition_dir = package_dir / "hyperframes"
        composition_dir.mkdir(parents=True, exist_ok=True)
        (composition_dir / "index.html").write_text("<html></html>", encoding="utf-8")
        metadata_path = package_dir / "video_render.json"
        metadata_path.write_text(
            json.dumps({"status": "skipped", "used_fallback": True, "video": str(fallback_video)}),
            encoding="utf-8",
        )
        skills_metadata_path = package_dir / "hyperframes_skills.json"
        skills_metadata_path.write_text(json.dumps({"status": "skipped"}), encoding="utf-8")
        return SimpleNamespace(
            video_path=fallback_video,
            composition_dir=composition_dir,
            metadata_path=metadata_path,
            skills_metadata_path=skills_metadata_path,
            used_fallback=True,
        )

    def checking_run_opencode_agent(*, package_dir, **_kwargs):
        observed_steps.append(read_current_step())
        metadata_path = package_dir / "opencode_agent.json"
        prompt_path = package_dir / "opencode_prompt.md"
        metadata_path.write_text(json.dumps({"status": "skipped"}), encoding="utf-8")
        prompt_path.write_text("skipped", encoding="utf-8")
        return SimpleNamespace(status="skipped", metadata_path=metadata_path, prompt_path=prompt_path, enabled=False)

    monkeypatch.setattr(pipeline_module, "synthesize_tts", checking_synthesize_tts)
    monkeypatch.setattr(pipeline_module, "render_final_video", checking_render_final_video)
    monkeypatch.setattr(pipeline_module, "run_opencode_agent", checking_run_opencode_agent)

    continue_pipeline_draft(draft.job_id, base_dir=tmp_path, capture_browser=False)

    assert observed_steps == ["tts", "render", "opencode"]
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["status"] == "completed"
    assert state["current_step"] == "completed"
    assert state["can_continue"] is False
    assert "updated_at" in state


def test_deferred_live_mcp_rehearsal_runs_after_continue_login_window(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_PLAYWRIGHT_MCP_MODE", "live")
    monkeypatch.setenv("MANUAL_AGENT_PLAYWRIGHT_MCP_COMMAND", "fake-mcp")
    request = _request().model_copy(update={"execution_mode": "ai", "login_mode": "manual"})
    calls: list[bool] = []

    def fake_rehearse_plan(_plan, _settings, package_dir, *, allow_live=True, deferred_reason="", **_kwargs):
        calls.append(allow_live)
        if not allow_live:
            return {
                "status": "deferred-until-authenticated",
                "adapter": "playwright-mcp-live-deferred",
                "mode": "live",
                "executed": False,
                "requires_live_mode": True,
                "deferred_reason": deferred_reason,
                "candidate_calls": [],
            }
        execution_path = package_dir / "playwright_mcp_execution.json"
        execution_path.write_text(json.dumps({"status": "live-completed"}), encoding="utf-8")
        return {
            "status": "live-completed",
            "adapter": "playwright-mcp-live",
            "mode": "live",
            "executed": True,
            "requires_live_mode": False,
            "execution_path": str(execution_path),
            "candidate_calls": [],
        }

    monkeypatch.setattr(pipeline_module, "rehearse_plan", fake_rehearse_plan)

    draft = create_pipeline_draft(request, base_dir=tmp_path, capture_browser=False)
    result = continue_pipeline_draft(draft.job_id, base_dir=tmp_path, capture_browser=False)

    assert calls == [False, True]
    rehearsal = json.loads((result.package_dir / "rehearsal_log.json").read_text(encoding="utf-8"))
    assert rehearsal["status"] == "deferred-until-authenticated"
    assert rehearsal["post_login_status"] == "live-completed"
    events = [json.loads(line) for line in result.artifacts.audit_log.read_text(encoding="utf-8").splitlines()]
    assert any(event["step_id"] == "mcp_rehearsal_after_login" and event["status"] == "ok" for event in events)


def test_continue_stops_when_browser_capture_reports_login_required(tmp_path: Path, monkeypatch):
    draft = create_pipeline_draft(
        _request().model_copy(update={"execution_mode": "ai", "login_mode": "none"}),
        base_dir=tmp_path,
        capture_browser=True,
    )
    state_path = draft.package_dir / "workflow_state.json"

    def login_required_capture(_request, _plan, dirs, _settings):
        video = dirs.package / "manual_video_agent_usage.webm"
        video.write_bytes(b"webm")
        return {
            "status": "degraded",
            "degrade_reason": "login_required",
            "captures": [],
            "masked_names": [],
            "video": video,
            "action_log": [{"status": "blocked", "reason": "login_required"}],
            "action_log_path": dirs.package / "capture_action_log.json",
            "final_frame": None,
        }

    monkeypatch.setattr(pipeline_module, "_capture_with_playwright", login_required_capture)

    with pytest.raises(RuntimeError, match="login required"):
        continue_pipeline_draft(draft.job_id, base_dir=tmp_path, capture_browser=True)

    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["status"] == "failed"
    assert state["current_step"] == "execution_failed"
    assert state["can_continue"] is True
    assert state["details"]["degrade_reason"] == "login_required"


def test_workflow_package_contract_shape_is_stable_for_sample_continue(tmp_path: Path):
    draft = create_pipeline_draft(_request(), base_dir=tmp_path, capture_browser=False)
    result = continue_pipeline_draft(draft.job_id, base_dir=tmp_path, capture_browser=False)

    state = json.loads((result.package_dir / "workflow_state.json").read_text(encoding="utf-8"))
    manifest = json.loads(result.artifacts.package_manifest.read_text(encoding="utf-8"))
    events = [json.loads(line) for line in result.artifacts.audit_log.read_text(encoding="utf-8").splitlines()]

    assert set(state).issuperset({"status", "current_step", "can_continue", "request", "capture_browser", "environment", "updated_at", "details"})
    assert state["status"] == "completed"
    assert state["current_step"] == "completed"
    assert set(manifest).issuperset({"job_id", "status", "environment", "degradations", "artifacts", "supporting_artifacts", "artifact_dependencies"})
    assert {"capture", "tts", "masking", "render", "manifest"}.issubset({event["actor"] for event in events})


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
            "actions": [{"id": "a1", "type": "fill_by_label", "label": "라인", "value": "A3", "step_id": "step_inputs"}],
        },
        tmp_path,
    )

    assert result["status"] == "ok"
    assert result["degrade_reason"] == ""
    assert result["action_log"][0]["method"] == "value_visible:A3"
