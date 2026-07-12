import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

from backend.app.pipeline import PipelineInput


def run_pipeline(_request, *, base_dir: Path, capture_browser: bool):
    assert capture_browser is False
    package_dir = base_dir / "jobs" / "fixture-job"
    package_dir.mkdir(parents=True, exist_ok=True)

    def write_text(name: str, content: str = "{}") -> Path:
        path = package_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def write_bytes(name: str, content: bytes) -> Path:
        path = package_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    preview = write_text("preview.html", "<html>preview</html>")
    manual = write_text("manual.md", "# Manual")
    video = write_bytes("manual_video_agent_usage.mp4", b"video")
    action_plan = write_text("action_plan.json")
    approval_log = write_text("approval_log.json")
    masking_log = write_text("masking_log.json")
    subtitles = write_text("subtitles.vtt", "WEBVTT\n")
    audit_log = write_text(
        "audit_log.jsonl",
        json.dumps(
            {
                "timestamp": "2026-07-12T00:00:00+09:00",
                "run_id": "fixture-job",
                "actor": "manifest",
                "status": "ok",
            }
        )
        + "\n",
    )
    audio = write_bytes("tts/01_step.wav", b"RIFFaudio")
    tts_metadata = write_text(
        "tts/tts_metadata.json",
        json.dumps({"entries": [{"step_id": "step", "audio": str(audio)}]}),
    )
    video_render = write_text("video_render.json", json.dumps({"quality": {"status": "passed"}}))
    supporting = {
        "request": write_text("request.json"),
        "planner_trace": write_text("planner_trace.json"),
        "rehearsal_log": write_text("rehearsal_log.json"),
        "playwright_mcp_calls": write_text("playwright_mcp_calls.json"),
        "audit_log": audit_log,
        "subtitles": subtitles,
        "media_plan": write_text("media_plan.json"),
        "tts_metadata": tts_metadata,
        "video_render": video_render,
        "opencode_prompt": write_text("opencode_prompt.md", "prompt"),
        "opencode_metadata": write_text("opencode_agent.json"),
        "hyperframes_composition": write_text("hyperframes/index.html", "<html></html>"),
        "hyperframes_manifest": write_text("hyperframes/hyperframes_manifest.json"),
    }
    manifest_path = package_dir / "package_manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "job_id": "fixture-job",
                "status": "completed",
                "artifacts": {
                    "html_preview": str(preview),
                    "markdown_manual": str(manual),
                    "video": str(video),
                    "action_plan": str(action_plan),
                    "approval_log": str(approval_log),
                    "masking_log": str(masking_log),
                    "subtitles": str(subtitles),
                    "audit_log": str(audit_log),
                    "tts_audio": [str(audio)],
                    "tts_metadata": str(tts_metadata),
                },
                "supporting_artifacts": {key: str(value) for key, value in supporting.items()},
                "degradations": [],
            }
        ),
        encoding="utf-8",
    )
    artifacts = SimpleNamespace(
        package_manifest=manifest_path,
        planner_trace=supporting["planner_trace"],
        video=video,
        audit_log=audit_log,
        tts_audio=[audio],
        tts_metadata=tts_metadata,
    )
    return SimpleNamespace(package_dir=package_dir, artifacts=artifacts)


def _load_verify_module():
    path = Path("tools/verify_package.py").resolve()
    spec = importlib.util.spec_from_file_location("verify_package", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_verify_package_accepts_pipeline_manifest(tmp_path: Path):
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

    verify_package = _load_verify_module()

    assert verify_package.verify_manifest(result.artifacts.package_manifest) == []


def test_verify_package_rejects_missing_manifest(tmp_path: Path):
    verify_package = _load_verify_module()

    errors = verify_package.verify_manifest(tmp_path / "missing.json")

    assert errors == [f"manifest missing: {tmp_path / 'missing.json'}"]


def test_verify_package_rejects_missing_supporting_artifact(tmp_path: Path):
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
    manifest_path = result.artifacts.package_manifest
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    planner_trace = Path(manifest["supporting_artifacts"]["planner_trace"])
    planner_trace.unlink()

    verify_package = _load_verify_module()
    errors = verify_package.verify_manifest(manifest_path)

    assert f"supporting artifact path does not exist: planner_trace={planner_trace}" in errors


def test_verify_package_rejects_enforced_render_quality_failure(tmp_path: Path):
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
    manifest = json.loads(result.artifacts.package_manifest.read_text(encoding="utf-8"))
    render_path = Path(manifest["supporting_artifacts"]["video_render"])
    render = json.loads(render_path.read_text(encoding="utf-8"))
    render["quality"] = {
        "status": "failed",
        "enforced": True,
        "issues": [{"code": "audio_mux_failed", "message": "TTS audio mux failed"}],
    }
    render_path.write_text(json.dumps(render, ensure_ascii=False), encoding="utf-8")

    verify_package = _load_verify_module()
    errors = verify_package.verify_manifest(result.artifacts.package_manifest)

    assert "render quality failed: audio_mux_failed" in errors


def test_verify_package_rejects_audit_log_run_id_mismatch(tmp_path: Path):
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
    audit_lines = result.artifacts.audit_log.read_text(encoding="utf-8").splitlines()
    first_event = json.loads(audit_lines[0])
    first_event["run_id"] = "wrong-run-id"
    audit_lines[0] = json.dumps(first_event, ensure_ascii=False)
    result.artifacts.audit_log.write_text("\n".join(audit_lines) + "\n", encoding="utf-8")

    verify_package = _load_verify_module()
    errors = verify_package.verify_manifest(result.artifacts.package_manifest)

    assert "audit line 1 run_id mismatch" in errors


def test_verify_package_rejects_missing_required_supporting_key(tmp_path: Path):
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
    manifest_path = result.artifacts.package_manifest
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["supporting_artifacts"].pop("hyperframes_manifest")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

    verify_package = _load_verify_module()
    errors = verify_package.verify_manifest(manifest_path)

    assert "supporting artifact missing from manifest: hyperframes_manifest" in errors


def test_verify_package_rejects_invalid_degradation_entries(tmp_path: Path):
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
    manifest_path = result.artifacts.package_manifest
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["degradations"] = [{"actor": "tts"}]
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

    verify_package = _load_verify_module()
    errors = verify_package.verify_manifest(manifest_path)

    assert "invalid degradation entry at index 0" in errors


def test_verify_package_rejects_missing_tts_audio_file(tmp_path: Path):
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
    audio_path = result.artifacts.tts_audio[0]
    audio_path.unlink()

    verify_package = _load_verify_module()
    errors = verify_package.verify_manifest(result.artifacts.package_manifest)

    assert f"tts audio path does not exist: {audio_path}" in errors


def test_verify_package_rejects_tts_metadata_audio_mismatch(tmp_path: Path):
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
    metadata = json.loads(result.artifacts.tts_metadata.read_text(encoding="utf-8"))
    metadata["entries"][0]["audio"] = str(tmp_path / "missing.wav")
    result.artifacts.tts_metadata.write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")

    verify_package = _load_verify_module()
    errors = verify_package.verify_manifest(result.artifacts.package_manifest)

    assert f"tts metadata audio path does not exist: {tmp_path / 'missing.wav'}" in errors


def test_verify_package_rejects_empty_video_file(tmp_path: Path):
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
    result.artifacts.video.write_bytes(b"")

    verify_package = _load_verify_module()
    errors = verify_package.verify_manifest(result.artifacts.package_manifest)

    assert f"artifact path is empty: video={result.artifacts.video}" in errors


def test_verify_package_rejects_empty_tts_audio_file(tmp_path: Path):
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
    audio_path = result.artifacts.tts_audio[0]
    audio_path.write_bytes(b"")

    verify_package = _load_verify_module()
    errors = verify_package.verify_manifest(result.artifacts.package_manifest)

    assert f"tts audio path is empty: {audio_path}" in errors
