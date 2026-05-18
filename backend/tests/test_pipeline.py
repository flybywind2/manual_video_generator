import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.config import load_settings
from backend.app.pipeline import PipelineInput, _playwright_launch_kwargs, _prepare_capture_page, run_pipeline


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
    assert (result.package_dir / "hyperframes_skills.json").exists()
    assert (result.package_dir / "opencode_agent.json").exists()
    manifest = result.artifacts.package_manifest.read_text(encoding="utf-8")
    assert '"tts_audio": [' in manifest
    assert '"video_render"' in manifest
    assert '"skills_metadata"' in manifest
    assert '"opencode_metadata"' in manifest
    assert "config_status" in result.plan


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
        "planner_trace",
        "rehearsal_log",
        "playwright_mcp_calls",
        "tts_metadata",
        "video_render",
        "skills_metadata",
        "opencode_prompt",
        "opencode_metadata",
        "audit_log",
        "hyperframes_composition",
        "hyperframes_manifest",
    }
    assert expected.issubset(supporting)
    for key in expected:
        assert supporting[key], key
        assert Path(supporting[key]).exists(), key


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
    audit_response = client.get(body["supporting_artifacts"]["audit_log"])
    assert audit_response.status_code == 200
    assert "planner" in audit_response.text


def test_artifact_route_rejects_path_traversal(tmp_path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_OUTPUT_DIR", str(tmp_path))
    client = TestClient(app)

    response = client.get("/artifacts/%2e%2e/README.md")

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
        {"planner", "rehearsal", "approval", "capture", "masking", "tts", "render", "opencode", "manifest"}
    )
    assert all(event["run_id"] == result.job_id for event in events)
    assert all("status" in event for event in events)
    assert manifest["degradations"]
    assert any(item["reason"] == "tts_silent_fallback" for item in manifest["degradations"])
    assert manifest["environment"]["python_version"]
    assert "playwright_browsers_path" in manifest["environment"]


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


def test_playwright_launch_kwargs_do_not_hardcode_user_chrome_path():
    settings = load_settings(environ={})

    launch_kwargs = _playwright_launch_kwargs(settings, browser_roots=[])

    rendered = json.dumps(launch_kwargs, ensure_ascii=False)
    assert "xiro1" not in rendered.lower()
    assert "chromium-1187" not in rendered
    assert launch_kwargs == {"headless": True}


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


def test_prepare_capture_page_waits_for_js_ready_before_injecting_helpers():
    calls = []

    class FakePage:
        def goto(self, url, wait_until):
            calls.append(("goto", url, wait_until))

        def wait_for_load_state(self, state, timeout):
            calls.append(("wait_for_load_state", state, timeout))

        def wait_for_function(self, expression, timeout):
            calls.append(("wait_for_function", expression, timeout))

        def wait_for_selector(self, selector, timeout):
            calls.append(("wait_for_selector", selector, timeout))

        def add_style_tag(self, content):
            calls.append(("add_style_tag", "manual-caption" in content))

        def evaluate(self, script, *args):
            calls.append(("evaluate", script[:40], args))

    page = FakePage()

    _prepare_capture_page(page, "http://127.0.0.1:8000/sample")

    assert calls[0] == ("goto", "http://127.0.0.1:8000/sample", "load")
    assert ("wait_for_load_state", "networkidle", 5000) in calls
    assert any(call[0] == "wait_for_function" and "document.readyState" in call[1] for call in calls)
    assert ("wait_for_selector", "[data-action='search']", 10000) in calls
    assert ("wait_for_selector", "[data-action='detail']", 10000) in calls
    assert calls[-2][0] == "add_style_tag"
    assert calls[-1][0] == "evaluate"
