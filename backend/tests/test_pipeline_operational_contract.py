import json
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
