from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.app.browser_runner import run_trace_replay
from backend.app.execution_trace import ExecutionTrace
from backend.app.trace_replay import TraceReplayError, replay_execution_trace


def _trace() -> ExecutionTrace:
    return ExecutionTrace.model_validate(
        {
            "schema_version": "1.0",
            "status": "completed",
            "request_summary": "검색어를 입력하고 최근 글을 연다.",
            "input_values": ["search_query"],
            "steps": [
                {
                    "id": "step-open",
                    "title": "서비스 열기",
                    "narration": "QSike Tech Notes 홈 화면을 엽니다.",
                    "actions": [
                        {
                            "id": "navigate-home",
                            "type": "navigate",
                            "target_url": "https://qsike.com/",
                            "observed_url": "https://qsike.com/",
                        }
                    ],
                },
                {
                    "id": "step-search",
                    "title": "글 찾기",
                    "narration": "검색어를 입력하고 검색 버튼을 눌러 글을 찾습니다.",
                    "actions": [
                        {
                            "id": "fill-search",
                            "type": "fill",
                            "selector": "#search-query",
                            "label": "검색어",
                            "value_key": "search_query",
                            "observed_url": "https://qsike.com/",
                            "expected_after": "검색어가 입력된다.",
                        },
                        {
                            "id": "click-search",
                            "type": "click",
                            "ref": "e-search",
                            "label": "검색",
                            "observed_url": "https://qsike.com/",
                            "expected_after": "검색 결과가 표시된다.",
                        },
                    ],
                },
                {
                    "id": "step-finish",
                    "title": "결과 확인",
                    "narration": "검색 결과 화면을 확인합니다.",
                    "actions": [
                        {
                            "id": "wait-results",
                            "type": "wait",
                            "duration_ms": 600,
                            "observed_url": "https://qsike.com/",
                        },
                        {
                            "id": "capture-results",
                            "type": "capture",
                            "observed_url": "https://qsike.com/",
                            "evidence": {
                                "screenshot_path": "discovery/results.png",
                                "visible_text": ["Playwright"],
                            },
                        },
                    ],
                },
            ],
            "completion_evidence": {
                "final_url": "https://qsike.com/",
                "assertions": ["검색 결과가 표시된다."],
                "screenshot_path": "discovery/completed.png",
            },
        }
    )


class _FakeLocator:
    def __init__(self, page: "_FakePage", selector: str) -> None:
        self.page = page
        self.selector = selector

    def count(self) -> int:
        return 1 if self.selector in self.page.targets else 0

    def wait_for(self, **kwargs) -> None:
        self.page.events.append(("locator.wait_for", self.selector, kwargs))

    def bounding_box(self):
        return {"x": 100, "y": 120, "width": 240, "height": 44}

    def evaluate(self, script, *args):
        self.page.events.append(("locator.evaluate", self.selector, script, args))
        return {"x": 100, "y": 120, "width": 240, "height": 44}

    def fill(self, value: str) -> None:
        self.page.events.append(("fill", self.selector, value))
        self.page.values[self.selector] = value
        self.page.state_version += 1

    def input_value(self) -> str:
        if self.page.force_bad_input_value:
            return "different"
        return self.page.values.get(self.selector, "")

    def click(self) -> None:
        self.page.events.append(("click", self.selector))
        self.page.state_version += 1
        if self.page.off_origin_after_click:
            self.page.url = "https://example.com/escaped"

    def press(self, key: str) -> None:
        self.page.events.append(("press", self.selector, key))
        self.page.state_version += 1


class _FakePage:
    def __init__(self) -> None:
        self.url = "about:blank"
        self.targets = {"#search-query", "aria-ref=e-search"}
        self.values: dict[str, str] = {}
        self.events: list[tuple] = []
        self.waits: list[int] = []
        self.state_version = 0
        self.force_bad_input_value = False
        self.off_origin_after_click = False
        self.semantic_targets: set[str] = set()

    def set_default_timeout(self, timeout: int) -> None:
        self.events.append(("default_timeout", timeout))

    def set_default_navigation_timeout(self, timeout: int) -> None:
        self.events.append(("navigation_timeout", timeout))

    def add_style_tag(self, *, content: str) -> None:
        self.events.append(("style", "manual-replay-highlight" in content))

    def evaluate(self, script, *args):
        if "__manualReplayState" in script:
            return {
                "url": self.url,
                "title": "QSike Tech Notes",
                "text": f"Playwright result state {self.state_version}",
                "stateVersion": self.state_version,
            }
        self.events.append(("evaluate", script, args))
        return None

    def goto(self, url: str, **kwargs) -> None:
        self.events.append(("goto", url, kwargs))
        self.url = url
        self.state_version += 1

    def wait_for_load_state(self, state: str, **kwargs) -> None:
        self.events.append(("load_state", state, kwargs))

    def wait_for_timeout(self, timeout: int) -> None:
        self.waits.append(timeout)

    def locator(self, selector: str) -> _FakeLocator:
        self.events.append(("locator", selector))
        return _FakeLocator(self, selector)

    def get_by_role(self, role: str, *, name: str, exact: bool = True) -> _FakeLocator:
        selector = f"role={role}[name={name}]"
        if selector in self.semantic_targets:
            self.targets.add(selector)
        self.events.append(("get_by_role", role, name, exact))
        return _FakeLocator(self, selector)

    def get_by_label(self, label: str, *, exact: bool = True) -> _FakeLocator:
        selector = f"label={label}"
        if selector in self.semantic_targets:
            self.targets.add(selector)
        self.events.append(("get_by_label", label, exact))
        return _FakeLocator(self, selector)

    def screenshot(self, *, path: str, full_page: bool) -> None:
        self.events.append(("screenshot", Path(path).name, full_page))
        Path(path).write_bytes(b"png")


class _FakePlaywrightContext:
    def __init__(self, page: _FakePage, events: list[tuple]) -> None:
        self.page = page
        self.events = events

    def __enter__(self):
        page = self.page
        events = self.events

        class Browser:
            contexts = [SimpleNamespace(pages=[page])]

        class Chromium:
            def connect_over_cdp(self, endpoint: str):
                events.append(("connect_over_cdp", endpoint))
                return Browser()

        return SimpleNamespace(chromium=Chromium())

    def __exit__(self, exc_type, exc, tb):
        return False


def _run(tmp_path: Path, page: _FakePage, trace: ExecutionTrace | None = None):
    events: list[tuple] = []
    result = replay_execution_trace(
        trace=trace or _trace(),
        request=SimpleNamespace(
            target_url="https://qsike.com/",
            input_values={"search_query": "Playwright"},
        ),
        job_dir=tmp_path,
        cdp_endpoint="http://127.0.0.1:43129",
        settings=SimpleNamespace(request_timeout_seconds=5.0),
        step_durations_seconds={"step-open": 1.0, "step-search": 4.0, "step-finish": 1.2},
        playwright_factory=lambda: _FakePlaywrightContext(page, events),
    )
    return result, events


def test_trace_replay_executes_semantic_actions_with_visuals_timing_and_captures(
    tmp_path: Path,
) -> None:
    page = _FakePage()

    result, events = _run(tmp_path, page)

    assert result.status == "ok"
    assert events == [("connect_over_cdp", "http://127.0.0.1:43129")]
    assert ("fill", "#search-query", "Playwright") in page.events
    assert ("click", "aria-ref=e-search") in page.events
    assert any(event[0] == "style" and event[1] is True for event in page.events)
    assert any(event[0] == "locator.evaluate" for event in page.events)
    assert sum(page.waits) >= 6000
    assert len(result.captures) == 10
    assert all(path.exists() for path in result.captures)
    assert result.final_frame.exists()
    assert result.action_log_path.exists()
    assert result.selector_trace_path.exists()
    assert result.media_plan["source"] == "opencode-trace-replay"
    assert [step["id"] for step in result.media_plan["steps"]] == [
        "step-open",
        "step-search",
        "step-finish",
    ]
    contract = result.to_capture_contract()
    assert contract["status"] == "ok"
    assert contract["degrade_reason"] == ""
    assert contract["source"] == "opencode-trace-replay"
    assert contract["action_log_path"] == result.action_log_path

    action_log = json.loads(result.action_log_path.read_text(encoding="utf-8"))
    assert all(entry["status"] == "ok" for entry in action_log)
    selectors = json.loads(result.selector_trace_path.read_text(encoding="utf-8"))
    assert {entry["resolved_selector"] for entry in selectors} == {
        "#search-query",
        "aria-ref=e-search",
    }


def test_trace_replay_fails_when_exact_target_is_missing(tmp_path: Path) -> None:
    page = _FakePage()
    page.targets.remove("aria-ref=e-search")

    with pytest.raises(TraceReplayError) as exc_info:
        _run(tmp_path, page)

    assert exc_info.value.code == "replay_diverged"
    log = json.loads((tmp_path / "trace_replay_log.json").read_text(encoding="utf-8"))
    assert log[-1]["action_id"] == "click-search"
    assert log[-1]["status"] == "failed"


def test_trace_replay_verifies_filled_value(tmp_path: Path) -> None:
    page = _FakePage()
    page.force_bad_input_value = True

    with pytest.raises(TraceReplayError) as exc_info:
        _run(tmp_path, page)

    assert exc_info.value.code == "replay_diverged"
    assert exc_info.value.action_id == "fill-search"


def test_trace_replay_stops_when_page_leaves_allowed_origin(tmp_path: Path) -> None:
    page = _FakePage()
    page.off_origin_after_click = True

    with pytest.raises(TraceReplayError) as exc_info:
        _run(tmp_path, page)

    assert exc_info.value.code == "off_origin_during_replay"
    assert exc_info.value.action_id == "click-search"


def test_browser_runner_trace_replay_is_fail_fast_without_degraded_fallback(tmp_path: Path) -> None:
    expected = TraceReplayError("forced_failure", "boom", action_id="a1")

    def fail_replay(**_kwargs):
        raise expected

    with pytest.raises(TraceReplayError) as exc_info:
        run_trace_replay(
            trace=_trace(),
            request=SimpleNamespace(target_url="https://qsike.com/", input_values={}),
            job_dir=tmp_path,
            cdp_endpoint="http://127.0.0.1:43129",
            settings=SimpleNamespace(),
            replay_func=fail_replay,
        )

    assert exc_info.value is expected


def test_trace_replay_allows_first_navigation_from_temporary_sso_origin(tmp_path: Path) -> None:
    page = _FakePage()
    page.url = "https://login.corp.local/adfs/saml"

    result, _events = _run(tmp_path, page)

    assert result.status == "ok"
    assert page.url == "https://qsike.com/"


def test_trace_replay_requires_expected_completion_path(tmp_path: Path) -> None:
    trace = _trace()
    trace.completion_evidence.final_url = "https://qsike.com/notes/expected"

    with pytest.raises(TraceReplayError) as exc_info:
        _run(tmp_path, _FakePage(), trace=trace)

    assert exc_info.value.code == "replay_diverged"
    assert exc_info.value.action_id == "completion"


def test_trace_replay_supports_press_and_selector_fallback_for_stale_ref(tmp_path: Path) -> None:
    trace = _trace()
    click = trace.steps[1].actions[1]
    click.ref = "stale-ref"
    click.selector = "#search-query"
    trace.steps[1].actions.append(
        type(click).model_validate(
            {
                "id": "press-enter",
                "type": "press",
                "selector": "#search-query",
                "label": "검색어",
                "key": "Enter",
                "observed_url": "https://qsike.com/",
                "expected_after": "검색 결과가 갱신된다.",
            }
        )
    )
    page = _FakePage()

    result, _events = _run(tmp_path, page, trace=trace)

    assert result.status == "ok"
    assert ("click", "#search-query") in page.events
    assert ("press", "#search-query", "Enter") in page.events
    selectors = json.loads(result.selector_trace_path.read_text(encoding="utf-8"))
    resolved = {entry["action_id"]: entry["resolved_selector"] for entry in selectors}
    assert resolved["click-search"] == "#search-query"
    assert resolved["press-enter"] == "#search-query"


def test_trace_replay_never_invokes_opencode_or_llm(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def forbidden(*_args, **_kwargs):
        raise AssertionError("agent intelligence must not run during deterministic replay")

    monkeypatch.setattr("backend.app.adapters.opencode.run_opencode_agent", forbidden)
    monkeypatch.setattr("backend.app.adapters.planner.post_json", forbidden)

    result, _events = _run(tmp_path, _FakePage())

    assert result.status == "ok"


def test_trace_replay_falls_back_from_stale_ref_to_unique_semantic_label(tmp_path: Path) -> None:
    trace = _trace()
    click = trace.steps[1].actions[1]
    click.ref = "stale-ref"
    click.selector = ""
    page = _FakePage()
    page.semantic_targets.add("role=button[name=검색]")

    result, _events = _run(tmp_path, page, trace=trace)

    assert result.status == "ok"
    assert ("click", "role=button[name=검색]") in page.events
    selectors = json.loads(result.selector_trace_path.read_text(encoding="utf-8"))
    click_selector = next(item for item in selectors if item["action_id"] == "click-search")
    assert click_selector["resolved_selector"] == "role=button[name=검색]"


def test_trace_replay_rejects_same_origin_but_wrong_observed_path_before_action(
    tmp_path: Path,
) -> None:
    trace = _trace()
    trace.steps[0].actions[0].target_url = "https://qsike.com/unexpected"
    page = _FakePage()

    with pytest.raises(TraceReplayError) as exc_info:
        _run(tmp_path, page, trace=trace)

    assert exc_info.value.code == "replay_diverged"
    assert exc_info.value.action_id == "fill-search"
