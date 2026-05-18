import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.config import load_settings
from backend.app.pipeline import (
    PipelineInput,
    _authenticate_before_recording,
    _execute_capture_actions,
    _handle_login,
    _install_manual_login_signal,
    _playwright_launch_kwargs,
    _prepare_capture_page,
    _resolve_login_options,
    run_pipeline,
)


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
    assert result.artifacts.capture_action_log
    assert result.artifacts.capture_action_log.exists()
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
        "capture_action_log",
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
    assert body["artifacts"]["capture_action_log_url"].endswith("/capture_action_log.json")
    audit_response = client.get(body["supporting_artifacts"]["audit_log"])
    assert audit_response.status_code == 200
    assert "planner" in audit_response.text
    capture_action_log = client.get(body["supporting_artifacts"]["capture_action_log"])
    assert capture_action_log.status_code == 200
    assert capture_action_log.json()["status"] == "skipped"


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


def test_placeholder_capture_names_are_not_mes_specific(tmp_path):
    result = run_pipeline(
        PipelineInput(
            request_text="사내 포털 권한 신청 방법 영상 만들기",
            target_url="http://internal.example.local/portal",
            role="신청자",
            completion_condition="신청 완료 화면이 보이면 완료",
            input_values={"사용자ID": "U100", "부서": "AI센터"},
        ),
        base_dir=tmp_path,
        capture_browser=False,
    )

    masking_log = json.loads(result.artifacts.masking_log.read_text(encoding="utf-8"))

    assert [item["capture"] for item in masking_log["entries"]] == ["step_intro.png", "step_inputs.png", "step_completion.png"]
    assert not (result.package_dir / "masked" / "step_search.png").exists()


def test_playwright_launch_kwargs_do_not_hardcode_user_chrome_path():
    settings = load_settings(environ={})

    launch_kwargs = _playwright_launch_kwargs(settings, browser_roots=[])

    rendered = json.dumps(launch_kwargs, ensure_ascii=False)
    assert "xiro1" not in rendered.lower()
    assert "chromium-1187" not in rendered
    assert launch_kwargs == {"headless": True}


def test_playwright_launch_kwargs_disables_headless_for_manual_login():
    settings = load_settings(environ={})

    launch_kwargs = _playwright_launch_kwargs(settings, interactive=True, browser_roots=[])

    assert launch_kwargs == {"headless": False}


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


def test_prepare_capture_page_waits_for_generic_js_ready_before_injecting_helpers():
    calls = []

    class FakePage:
        def goto(self, url, wait_until):
            calls.append(("goto", url, wait_until))

        def wait_for_load_state(self, state, timeout):
            calls.append(("wait_for_load_state", state, timeout))

        def wait_for_function(self, expression, timeout):
            calls.append(("wait_for_function", expression, timeout))

        def wait_for_selector(self, selector, timeout):
            raise AssertionError(f"sample-specific selector wait leaked into generic capture: {selector}")

        def add_style_tag(self, content):
            calls.append(("add_style_tag", "manual-caption" in content))

        def evaluate(self, script, *args):
            calls.append(("evaluate", script[:40], args))

    page = FakePage()

    _prepare_capture_page(page, "http://127.0.0.1:8000/sample")

    assert calls[0] == ("goto", "http://127.0.0.1:8000/sample", "load")
    assert ("wait_for_load_state", "networkidle", 5000) in calls
    assert any(call[0] == "wait_for_function" and "document.readyState" in call[1] for call in calls)
    assert all("data-action" not in str(call) for call in calls)
    assert calls[-2][0] == "add_style_tag"
    assert calls[-1][0] == "evaluate"


def test_execute_capture_actions_uses_plan_selectors_without_mes_defaults(tmp_path):
    calls = []

    class FakePage:
        def evaluate(self, script, *args):
            calls.append(("evaluate", script, args))

        def wait_for_timeout(self, timeout):
            calls.append(("wait_for_timeout", timeout))

        def fill(self, selector, value):
            calls.append(("fill", selector, value))

        def click(self, selector):
            calls.append(("click", selector))

        def screenshot(self, path, full_page):
            calls.append(("screenshot", Path(path).name, full_page))
            Path(path).write_bytes(b"png")

    plan = {
        "steps": [{"id": "step_1", "title": "사용자 검색", "caption": "사용자를 검색합니다.", "narration": "사용자를 검색합니다."}],
        "actions": [
            {"id": "a1", "type": "fill", "selector": "#user-id", "value": "U100", "step_id": "step_1"},
            {"id": "a2", "type": "click", "selector": "button.search", "step_id": "step_1"},
            {"id": "a3", "type": "capture_step", "step_id": "step_1"},
        ],
    }

    result = _execute_capture_actions(FakePage(), plan, tmp_path)

    assert [path.name for path in result["captures"]] == ["step_1.png"]
    assert ("fill", "#user-id", "U100") in calls
    assert ("click", "button.search") in calls
    rendered_calls = json.dumps(calls, ensure_ascii=False)
    assert "[name='lot']" not in rendered_calls
    assert "[data-action='search']" not in rendered_calls
    assert "[data-action='detail']" not in rendered_calls


def test_execute_capture_actions_runs_semantic_fill_and_text_clicks(tmp_path):
    calls = []

    class FakeLocator:
        def __init__(self, kind, value):
            self.kind = kind
            self.value = value

        def fill(self, value):
            calls.append(("fill", self.kind, self.value, value))

        def click(self):
            calls.append(("click", self.kind, self.value))

    class FakePage:
        def evaluate(self, script, *args):
            calls.append(("evaluate", args))

        def wait_for_timeout(self, timeout):
            calls.append(("wait_for_timeout", timeout))

        def get_by_label(self, text, **kwargs):
            calls.append(("get_by_label", text, kwargs))
            return FakeLocator("label", text)

        def get_by_role(self, role, **kwargs):
            calls.append(("get_by_role", role, kwargs))
            return FakeLocator(role, kwargs.get("name"))

        def screenshot(self, path, full_page):
            calls.append(("screenshot", Path(path).name, full_page))
            Path(path).write_bytes(b"png")

    plan = {
        "steps": [{"id": "step_search", "title": "조회", "caption": "조회합니다.", "narration": "조회합니다."}],
        "actions": [
            {"id": "a1", "type": "fill_by_label", "label": "LOT", "value": "LOT-001", "step_id": "step_search"},
            {"id": "a2", "type": "click_by_text", "texts": ["조회", "검색"], "step_id": "step_search"},
            {"id": "a3", "type": "capture_step", "step_id": "step_search"},
        ],
    }

    result = _execute_capture_actions(FakePage(), plan, tmp_path)

    assert ("fill", "label", "LOT", "LOT-001") in calls
    assert ("click", "button", "조회") in calls
    assert [entry["status"] for entry in result["action_log"][:2]] == ["ok", "ok"]
    assert [path.name for path in result["captures"]] == ["step_search.png"]


def test_execute_capture_actions_records_selector_failures_without_aborting(tmp_path):
    class FakePage:
        def evaluate(self, script, *args):
            pass

        def wait_for_timeout(self, timeout):
            pass

        def click(self, selector):
            raise TimeoutError(f"waiting for locator({selector!r}) to be visible")

        def screenshot(self, path, full_page):
            Path(path).write_bytes(b"png")

    plan = {
        "steps": [{"id": "step_1", "title": "대상 화면", "caption": "대상 화면", "narration": "대상 화면"}],
        "actions": [
            {"id": "a1", "type": "click", "selector": "[dataction='search']", "step_id": "step_1"},
            {"id": "a2", "type": "capture_step", "step_id": "step_1"},
        ],
    }

    result = _execute_capture_actions(FakePage(), plan, tmp_path)

    assert result["action_log"][0]["status"] == "failed"
    assert "TimeoutError" in result["action_log"][0]["error"]
    assert [path.name for path in result["captures"]] == ["step_1.png"]


def test_resolve_login_options_prefers_request_mode_and_env_credentials():
    settings = load_settings(
        environ={
            "MANUAL_AGENT_LOGIN_MODE": "none",
            "MANUAL_AGENT_LOGIN_USERNAME_SELECTOR": "#uid",
            "MANUAL_AGENT_LOGIN_PASSWORD_SELECTOR": "#pwd",
            "MANUAL_AGENT_LOGIN_SUBMIT_SELECTOR": "button.login",
            "MANUAL_AGENT_LOGIN_SUCCESS_SELECTOR": ".home",
            "MANUAL_AGENT_LOGIN_USERNAME": "user01",
            "MANUAL_AGENT_LOGIN_PASSWORD": "plain-password",
        }
    )
    request = PipelineInput(
        request_text="로그인 후 메뉴얼",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="홈 화면",
        login_mode="credentials",
        login_success_selector=".dashboard",
    )

    login = _resolve_login_options(request, settings)

    assert login["mode"] == "credentials"
    assert login["username"] == "user01"
    assert login["password"] == "plain-password"
    assert login["success_selector"] == ".dashboard"


def test_handle_login_uses_env_credentials_and_redacts_action_log():
    calls = []

    class FakePage:
        def fill(self, selector, value):
            calls.append(("fill", selector, value))

        def click(self, selector):
            calls.append(("click", selector))

        def wait_for_selector(self, selector, timeout):
            calls.append(("wait_for_selector", selector, timeout))

    login = {
        "mode": "credentials",
        "username_selector": "#uid",
        "password_selector": "#pwd",
        "submit_selector": "button.login",
        "success_selector": ".home",
        "username": "user01",
        "password": "plain-password",
        "credentials_timeout_ms": 30000,
        "manual_timeout_ms": 120000,
    }

    log = _handle_login(FakePage(), login)

    assert ("fill", "#uid", "user01") in calls
    assert ("fill", "#pwd", "plain-password") in calls
    assert ("click", "button.login") in calls
    assert ("wait_for_selector", ".home", 30000) in calls
    assert log["status"] == "ok"
    rendered_log = json.dumps(log, ensure_ascii=False)
    assert "plain-password" not in rendered_log
    assert "user01" not in rendered_log


def test_manual_login_waits_for_success_selector_without_credentials():
    calls = []

    class FakePage:
        def add_init_script(self, script):
            calls.append(("add_init_script", "로그인 완료" in script))

        def evaluate(self, script, *args):
            calls.append(("evaluate", "manualLoginSignal" in script, args))
            return {"completed": False, "successSelectorMatched": True}

        def wait_for_function(self, expression, selector, timeout):
            calls.append(("wait_for_function", "manualLoginCompleted" in expression, selector, timeout))

    login = {
        "mode": "manual",
        "success_selector": ".dashboard",
        "manual_timeout_ms": 90000,
        "credentials_timeout_ms": 30000,
    }

    log = _handle_login(FakePage(), login)

    assert calls[0] == ("add_init_script", True)
    assert calls[2] == ("wait_for_function", True, ".dashboard", 90000)
    assert log == {
        "type": "login",
        "mode": "manual",
        "status": "ok",
        "success_selector_set": True,
        "signal_button_enabled": True,
        "completion_signal": "selector",
    }


def test_manual_login_installs_completion_button_and_waits_for_signal():
    calls = []

    class FakePage:
        def add_init_script(self, script):
            calls.append(("add_init_script", "manualLoginCompleted" in script and "로그인 완료" in script))

        def evaluate(self, script, *args):
            calls.append(("evaluate", "manualLoginSignal" in script, args))
            return {"completed": True, "successSelectorMatched": False}

        def wait_for_function(self, expression, selector, timeout):
            calls.append(("wait_for_function", "manualLoginCompleted" in expression, selector, timeout))

    login = {
        "mode": "manual",
        "success_selector": "",
        "manual_timeout_ms": 90000,
        "credentials_timeout_ms": 30000,
    }

    log = _handle_login(FakePage(), login)

    assert calls[0] == ("add_init_script", True)
    assert calls[1][0] == "evaluate"
    assert calls[2] == ("wait_for_function", True, "", 90000)
    assert log == {
        "type": "login",
        "mode": "manual",
        "status": "ok",
        "success_selector_set": False,
        "signal_button_enabled": True,
        "completion_signal": "button",
    }


def test_install_manual_login_signal_adds_persistent_button_script():
    calls = []

    class FakePage:
        def add_init_script(self, script):
            calls.append(("add_init_script", script))

        def evaluate(self, script, *args):
            calls.append(("evaluate", script, args))

    _install_manual_login_signal(FakePage())

    assert calls[0][0] == "add_init_script"
    assert "manual-login-signal" in calls[0][1]
    assert "로그인 완료" in calls[0][1]
    assert calls[1][0] == "evaluate"


def test_authenticate_before_recording_does_not_start_video_capture():
    context_options = []
    calls = []

    class FakePage:
        def goto(self, url, wait_until):
            calls.append(("goto", url, wait_until))

        def wait_for_load_state(self, state, timeout):
            calls.append(("wait_for_load_state", state, timeout))

        def wait_for_function(self, expression, timeout):
            calls.append(("wait_for_function", timeout))

        def add_style_tag(self, content):
            calls.append(("add_style_tag", "manual-caption" in content))

        def evaluate(self, script, *args):
            calls.append(("evaluate", args))

        def fill(self, selector, value):
            calls.append(("fill", selector, value))

        def click(self, selector):
            calls.append(("click", selector))

        def wait_for_selector(self, selector, timeout):
            calls.append(("wait_for_selector", selector, timeout))

    class FakeContext:
        def new_page(self):
            return FakePage()

        def storage_state(self):
            return {"cookies": [{"name": "sid", "value": "ok"}], "origins": []}

        def close(self):
            calls.append(("auth_context_close",))

    class FakeBrowser:
        def new_context(self, **kwargs):
            context_options.append(kwargs)
            return FakeContext()

    request = PipelineInput(
        request_text="로그인 후 매뉴얼",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="홈 화면",
        login_mode="credentials",
    )
    login = {
        "mode": "credentials",
        "username_selector": "#uid",
        "password_selector": "#pwd",
        "submit_selector": "#login",
        "success_selector": ".home",
        "username": "user01",
        "password": "plain-password",
        "credentials_timeout_ms": 30000,
        "manual_timeout_ms": 120000,
    }

    auth = _authenticate_before_recording(FakeBrowser(), request, login)

    assert context_options == [{"viewport": {"width": 1280, "height": 800}}]
    assert "record_video_dir" not in context_options[0]
    assert auth["storage_state"]["cookies"][0]["name"] == "sid"
    assert auth["action_log"][0]["status"] == "ok"
    assert ("fill", "#pwd", "plain-password") in calls
