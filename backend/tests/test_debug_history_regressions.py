from fastapi.testclient import TestClient

import backend.app.pipeline as pipeline_module
from backend.app.main import app
from backend.app.pipeline import _install_manual_login_signal, _prepare_capture_page


def _static_app_js() -> str:
    response = TestClient(app).get("/static/app.js")
    assert response.status_code == 200
    return response.text


def test_debug_history_ui_input_values_can_be_added_replaced_and_removed():
    body = _static_app_js()

    assert "const sampleInputValues" in body
    assert "renderInputValues(sampleInputValues)" in body
    assert 'inputValueList.innerHTML = "";' in body
    assert 'action === "add-input-value"' in body
    assert 'addInputValueRow("", "")' in body
    assert 'row.querySelector(".input-value-key")?.focus()' in body
    assert 'action === "remove-input-value"' in body
    assert 'event.target.closest(".input-value-row")?.remove()' in body
    assert "readInputValues()" in body
    assert "input_values: readInputValues()" in body


def test_debug_history_capture_waits_for_dom_and_render_frame_before_helper_injection():
    calls = []

    class FakePage:
        def goto(self, url, wait_until):
            calls.append(("goto", url, wait_until))

        def wait_for_load_state(self, state, timeout):
            calls.append(("wait_for_load_state", state, timeout))

        def wait_for_function(self, expression, *, timeout):
            calls.append(("wait_for_function", expression, timeout))

        def wait_for_selector(self, selector, timeout):
            raise AssertionError(f"capture readiness must not depend on sample selector: {selector}")

        def add_style_tag(self, content):
            calls.append(("add_style_tag", "manual-caption" in content))

        def evaluate(self, script, *args):
            calls.append(("evaluate", "manualCursor" in script, args))

    _prepare_capture_page(FakePage(), "http://internal.example.local/chat")

    assert calls[0] == ("goto", "http://internal.example.local/chat", "domcontentloaded")
    assert not any(call[:3] == ("goto", "http://internal.example.local/chat", "load") for call in calls)
    wait_call = next(call for call in calls if call[0] == "wait_for_function")
    assert "readyState === 'interactive' || readyState === 'complete'" in wait_call[1]
    assert "document.body.children.length > 0" in wait_call[1]
    assert "requestAnimationFrame" in wait_call[1]
    assert all("data-action" not in str(call) for call in calls)
    assert calls[-2][0] == "add_style_tag"
    assert calls[-1][0] == "evaluate"


def test_debug_history_manual_login_signal_survives_navigation_and_cleans_up():
    exposed = {}
    scripts = []
    evaluations = []

    class FakePage:
        def expose_function(self, name, callback):
            exposed[name] = callback

        def add_init_script(self, script):
            scripts.append(script)

        def evaluate(self, script, *args):
            evaluations.append((script, args))

    _install_manual_login_signal(FakePage())

    script = scripts[0]
    assert "__manualLoginSignalFromPage" in exposed
    assert "__manualLoginSignalFromPage" in script
    assert "readStoredCompletion" in script
    assert "sessionStorage.getItem('__manualLoginCompleted')" in script
    assert "sessionStorage.setItem('__manualLoginCompleted', 'true')" in script
    assert "MutationObserver" in script
    assert "setInterval(keepInstalled, 1000)" in script
    assert "window.setTimeout(window.__manualLoginCleanup, 120)" in script
    assert "clearInterval" in script
    assert "disconnect()" in script
    assert evaluations and evaluations[0][0] == script


def test_debug_history_manual_login_wait_uses_page_polling_not_wait_for_function():
    calls = []

    class FakePage:
        def __init__(self):
            self.checks = 0

        def evaluate(self, script, *args):
            self.checks += 1
            calls.append(("evaluate", args))
            return {"completed": self.checks >= 2, "successSelectorMatched": False}

        def wait_for_timeout(self, timeout):
            calls.append(("wait_for_timeout", timeout))

        def wait_for_function(self, *args, **kwargs):
            raise AssertionError("manual login completion should not use wait_for_function")

    signal_state = pipeline_module._ManualLoginSignalState()

    result = pipeline_module._wait_for_manual_login_completion(FakePage(), "", 1000, signal_state)

    assert result == "button"
    assert ("wait_for_timeout", 250) in calls


def test_debug_history_demonstration_signal_survives_navigation_and_uses_binding():
    exposed = {}
    scripts = []
    evaluations = []

    class FakePage:
        def expose_function(self, name, callback):
            exposed[name] = callback

        def add_init_script(self, script):
            scripts.append(script)

        def evaluate(self, script, *args):
            evaluations.append((script, args))

    token = pipeline_module._install_demonstration_signal(FakePage(), signal_token="demo-token")

    script = scripts[0]
    assert token == "demo-token"
    assert "__manualDemonstrationSignalFromPage" in exposed
    assert "__manualDemonstrationSignalFromPage" in script
    assert "시연 완료" in script
    assert "readStoredCompletion" in script
    assert "__manualDemonstrationCompletedRunId" in script
    assert "demo-token" in script
    assert "window.__manualDemonstrationCompleted = window.__manualDemonstrationCompleted === true || readStoredCompletion()" not in script
    assert "MutationObserver" in script
    assert "setInterval(keepInstalled, 1000)" in script
    assert "__manualDemonstrationCleanup" in script
    assert "clearInterval" in script
    assert "disconnect()" in script
    assert evaluations and evaluations[0][0] == script


def test_debug_history_demonstration_wait_requires_current_run_token():
    calls = []
    signal_state = pipeline_module._ManualLoginSignalState()

    class FakePage:
        def evaluate(self, script, *args):
            calls.append(("evaluate", args))
            return {"completed": False}

        def wait_for_timeout(self, timeout):
            calls.append(("wait_for_timeout", timeout))
            signal_state.mark_completed()

    result = pipeline_module._wait_for_demonstration_completion(FakePage(), 1000, signal_state, "demo-token")

    assert result == "button"
    assert calls[0] == ("evaluate", ("demo-token",))
