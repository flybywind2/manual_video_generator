import importlib.util
import json
from pathlib import Path

from backend.app.pipeline import PipelineInput, run_pipeline


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
