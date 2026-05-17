from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.pipeline import PipelineInput, run_pipeline


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
    assert result.artifacts.tts_audio
    assert result.artifacts.package_manifest.exists()
    assert (result.package_dir / "tts" / "tts_metadata.json").exists()
    assert (result.package_dir / "hyperframes" / "index.html").exists()
    assert (result.package_dir / "playwright_mcp_calls.json").exists()
    manifest = result.artifacts.package_manifest.read_text(encoding="utf-8")
    assert '"tts_audio": [' in manifest
    assert '"video_render"' in manifest
    assert "config_status" in result.plan


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
    assert Path(body["package_dir"]).exists()
