from pathlib import Path

from backend.app.browser_runner import run_capture, run_demonstration_replay
from backend.app.package_builder import build_media_assets, build_preview_manual_assets
from backend.app.workflow import WorkflowStep
from backend.app.workflow_graph import WORKFLOW_GRAPH, WorkflowGraph, WorkflowNode


def test_workflow_graph_exposes_ordered_nodes_and_edges():
    assert WORKFLOW_GRAPH.ordered_steps()[0] == WorkflowStep.REQUEST_VALIDATION
    assert WORKFLOW_GRAPH.ordered_steps()[-1] == WorkflowStep.COMPLETED
    assert WORKFLOW_GRAPH.next_steps(WorkflowStep.BROWSER_SESSION) == [
        WorkflowStep.OPENCODE_DISCOVERY,
        WorkflowStep.EXECUTION_FAILED,
    ]
    assert WORKFLOW_GRAPH.next_steps(WorkflowStep.OPENCODE_DISCOVERY) == [
        WorkflowStep.TRACE_VALIDATION,
        WorkflowStep.EXECUTION_FAILED,
    ]
    assert WORKFLOW_GRAPH.next_steps(WorkflowStep.TRACE_VALIDATION) == [
        WorkflowStep.TTS,
        WorkflowStep.EXECUTION_FAILED,
    ]
    assert WORKFLOW_GRAPH.node(WorkflowStep.TTS).actor == "tts"
    assert WORKFLOW_GRAPH.transition_allowed(WorkflowStep.RENDER, WorkflowStep.MANIFEST) is True
    assert WORKFLOW_GRAPH.transition_allowed(WorkflowStep.TTS, WorkflowStep.BROWSER_SESSION) is False
    assert WORKFLOW_GRAPH.metadata()["version"] == 2


def test_workflow_graph_excludes_legacy_runtime_steps():
    active_steps = set(WORKFLOW_GRAPH.ordered_steps())

    assert WorkflowStep.CAPTURE not in active_steps
    assert WorkflowStep.MCP_REHEARSAL_AFTER_LOGIN not in active_steps
    assert WorkflowStep.OPENCODE not in active_steps


def test_workflow_graph_rejects_unknown_steps():
    graph = WorkflowGraph(
        [
            WorkflowNode(step="a", actor="a", label="A", next_steps=("b",)),
            WorkflowNode(step="b", actor="b", label="B"),
        ]
    )

    assert graph.has_step("a") is True
    assert graph.has_step("missing") is False
    assert graph.transition_allowed("", "a") is True
    assert graph.transition_allowed("missing", "a") is False


def test_browser_runner_selects_placeholder_when_capture_disabled(tmp_path: Path):
    def placeholder(request, dirs):
        return {"status": "ok", "degrade_reason": "", "captures": [], "masked_names": [], "video": tmp_path / "video.webm"}

    result, status, reason = run_capture(
        capture_browser=False,
        request=object(),
        plan={},
        dirs=object(),
        settings=object(),
        capture_func=lambda *_args: {"status": "ok"},
        placeholder_func=placeholder,
        failure_fallback_func=lambda *_args: {"status": "degraded"},
    )

    assert result["video"] == tmp_path / "video.webm"
    assert status == "degraded"
    assert reason == "browser_capture_disabled"


def test_browser_runner_wraps_replay_failure_as_degraded():
    capture_result = {"action_log": [{"type": "click"}]}

    replay = run_demonstration_replay(
        enabled=True,
        request=object(),
        media_plan={"steps": []},
        capture_result=capture_result,
        dirs=object(),
        settings=object(),
        tts_audio=[],
        run_id="job_test",
        terminal=None,
        replay_func=lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("boom")),
        apply_replay_func=lambda capture, replay_result: capture.update({"replay": replay_result}),
        write_capture_log_func=lambda _capture: None,
    )

    assert replay is not None
    assert replay["status"] == "degraded"
    assert replay["degrade_reason"] == "demonstration_replay_failed"
    assert capture_result["replay"] == replay


def test_package_builder_groups_media_and_preview_assets(tmp_path: Path):
    media = build_media_assets(
        request=object(),
        plan={"steps": []},
        action_log=[],
        package_dir=tmp_path,
        media_plan_func=lambda *_args: {"steps": [{"id": "s1"}]},
        write_media_plan_func=lambda _plan, package_dir: package_dir / "media_plan.json",
        render_subtitles_func=lambda _plan, package_dir: package_dir / "subtitles.vtt",
    )

    preview = build_preview_manual_assets(
        request=object(),
        media_plan=media.media_plan,
        dirs=object(),
        masked_names=[],
        tts_audio=[],
        source_video=tmp_path / "video.webm",
        subtitles_path=media.subtitles_path,
        settings=object(),
        render_preview_func=lambda *_args, **_kwargs: tmp_path / "preview.html",
        render_markdown_func=lambda *_args: tmp_path / "manual.md",
        render_pdf_func=lambda *_args: tmp_path / "manual.pdf",
    )

    assert media.media_plan_path.name == "media_plan.json"
    assert media.subtitles_path.name == "subtitles.vtt"
    assert preview.html_path.name == "preview.html"
    assert preview.markdown_path.name == "manual.md"
    assert preview.pdf_path.name == "manual.pdf"
