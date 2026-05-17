import importlib.util
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
