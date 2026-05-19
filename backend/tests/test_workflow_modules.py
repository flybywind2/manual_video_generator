from pathlib import Path

from backend.app.browser_runner import run_capture, run_demonstration_replay
from backend.app.package_builder import build_media_assets, build_preview_manual_assets


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
