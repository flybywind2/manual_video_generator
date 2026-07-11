from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace

import pytest

from backend.app.execution_trace import (
    ExecutionTrace,
    ExecutionTracePolicy,
    TraceValidationError,
    validate_execution_trace,
)
from backend.app.config import load_settings
from backend.app.adapters.opencode_browser import (
    OpenCodeBrowserDiscovery,
    OpenCodeBrowserDiscoveryError,
)
from backend.app.browser_session import BrowserSessionError, BrowserSessionManager
from backend.app.env_bootstrap import discover_browser_executable


def _request(**overrides: object) -> SimpleNamespace:
    values = {
        "target_url": "https://qsike.com/",
        "input_values": {"search_query": "Playwright"},
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _valid_trace() -> dict[str, object]:
    return {
        "schema_version": "1.0",
        "status": "completed",
        "request_summary": "QSike Tech Notes의 주요 영역과 글 탐색 방법을 설명한다.",
        "input_values": ["search_query"],
        "steps": [
            {
                "id": "step-intro",
                "title": "홈 화면 소개",
                "narration": "QSike Tech Notes 홈 화면에서 주요 기술 주제를 확인합니다.",
                "actions": [
                    {
                        "id": "action-nav",
                        "type": "navigate",
                        "target_url": "https://qsike.com/",
                        "observed_url": "https://qsike.com/",
                    },
                    {
                        "id": "action-capture",
                        "type": "capture",
                        "observed_url": "https://qsike.com/",
                        "evidence": {
                            "screenshot_path": "discovery/step-intro.png",
                            "visible_text": ["QSike Tech Notes"],
                        },
                    },
                ],
            },
            {
                "id": "step-open-note",
                "title": "최근 글 열기",
                "narration": "최근 글 목록에서 하나를 열어 상세 내용을 확인합니다.",
                "actions": [
                    {
                        "id": "action-click-note",
                        "type": "click",
                        "ref": "e42",
                        "label": "최근 글",
                        "observed_url": "https://qsike.com/",
                        "expected_after": "글 상세 화면이 표시된다.",
                    }
                ],
            },
        ],
        "completion_evidence": {
            "final_url": "https://qsike.com/notes/playwright",
            "assertions": ["글 제목과 본문이 표시된다."],
            "screenshot_path": "discovery/completed.png",
        },
    }


def _validate(raw: dict[str, object], *, request: SimpleNamespace | None = None) -> ExecutionTrace:
    return validate_execution_trace(raw, request or _request(), ExecutionTracePolicy())


def test_valid_execution_trace_is_parsed_and_returned() -> None:
    trace = _validate(_valid_trace())

    assert isinstance(trace, ExecutionTrace)
    assert trace.schema_version == "1.0"
    assert [step.id for step in trace.steps] == ["step-intro", "step-open-note"]
    assert trace.completion_evidence.assertions == ["글 제목과 본문이 표시된다."]


@pytest.mark.parametrize(
    ("mutate", "expected_code"),
    [
        (lambda trace: trace.update(schema_version="2.0"), "unsupported_schema_version"),
        (lambda trace: trace.update(steps=[]), "empty_steps"),
        (
            lambda trace: trace["steps"][0]["actions"][0].update(type="evaluate"),
            "unknown_action",
        ),
        (
            lambda trace: trace["steps"][1]["actions"][0].pop("ref"),
            "missing_target",
        ),
        (
            lambda trace: trace["steps"][0]["actions"][0].pop("observed_url"),
            "missing_observed_provenance",
        ),
        (
            lambda trace: trace["steps"][0]["actions"][0].update(
                target_url="https://example.com/escape"
            ),
            "off_origin_url",
        ),
        (
            lambda trace: trace["steps"][1]["actions"][0].update(
                ref="", selector="button", label="글 열기"
            ),
            "ambiguous_target",
        ),
        (
            lambda trace: trace["steps"][1]["actions"][0].update(label="삭제 후 확정"),
            "dangerous_action",
        ),
        (
            lambda trace: trace.pop("completion_evidence"),
            "missing_completion_evidence",
        ),
    ],
)
def test_invalid_execution_trace_is_rejected(mutate, expected_code: str) -> None:
    raw = deepcopy(_valid_trace())
    mutate(raw)

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw)

    assert exc_info.value.code == expected_code


def test_fill_action_requires_value_key_instead_of_a_literal_value() -> None:
    raw = deepcopy(_valid_trace())
    raw["steps"][1]["actions"][0] = {
        "id": "action-fill",
        "type": "fill",
        "ref": "e-input",
        "observed_url": "https://qsike.com/",
        "value": "Playwright",
    }

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw)

    assert exc_info.value.code == "literal_input_value"


def test_trace_rejects_raw_request_secrets_anywhere_in_serialized_output() -> None:
    raw = deepcopy(_valid_trace())
    raw["steps"][0]["narration"] = "비밀번호 plain-password를 입력합니다."
    request = _request(input_values={"password": "plain-password"})

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw, request=request)

    assert exc_info.value.code == "secret_value_exposed"


def test_trace_rejects_raw_secret_containing_json_escape_characters() -> None:
    raw = deepcopy(_valid_trace())
    raw["request_summary"] = '로그인 암호 pa"ss\\word가 노출됐다.'
    request = _request(input_values={"password": 'pa"ss\\word'})

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw, request=request)

    assert exc_info.value.code == "secret_value_exposed"


def test_trace_rejects_sensitive_value_key_references() -> None:
    raw = deepcopy(_valid_trace())
    raw["input_values"] = ["password"]
    raw["steps"][1]["actions"][0] = {
        "id": "action-fill-password",
        "type": "fill",
        "ref": "e-password",
        "observed_url": "https://qsike.com/",
        "value_key": "password",
    }

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw, request=_request(input_values={"password": "plain-password"}))

    assert exc_info.value.code == "sensitive_input_reference"


def test_trace_rejects_sensitive_reference_even_when_request_omits_that_key() -> None:
    raw = deepcopy(_valid_trace())
    raw["input_values"] = ["password"]

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw)

    assert exc_info.value.code == "sensitive_input_reference"


def test_fill_action_value_key_must_exist_in_the_request() -> None:
    raw = deepcopy(_valid_trace())
    raw["steps"][1]["actions"][0] = {
        "id": "action-fill",
        "type": "fill",
        "selector": "#search-query",
        "observed_url": "https://qsike.com/",
        "value_key": "unknown_value",
    }

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw)

    assert exc_info.value.code == "unknown_value_key"


def test_trace_rejects_dangerous_write_synonym() -> None:
    raw = deepcopy(_valid_trace())
    raw["steps"][1]["actions"][0]["label"] = "Remove account"

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw)

    assert exc_info.value.code == "dangerous_action"


def test_completion_word_in_expected_state_is_not_misclassified_as_a_write() -> None:
    raw = deepcopy(_valid_trace())
    raw["steps"][1]["actions"][0]["expected_after"] = "Confirmation page opens"

    trace = _validate(raw)

    assert trace.steps[1].actions[0].expected_after == "Confirmation page opens"


@pytest.mark.parametrize("selector", ["[role=button]", ".btn", "//button"])
def test_trace_rejects_broad_selector_variants(selector: str) -> None:
    raw = deepcopy(_valid_trace())
    action = raw["steps"][1]["actions"][0]
    action["ref"] = ""
    action["selector"] = selector

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw)

    assert exc_info.value.code == "ambiguous_target"


def test_ref_only_click_requires_observed_label_for_risk_classification() -> None:
    raw = deepcopy(_valid_trace())
    raw["steps"][1]["actions"][0]["label"] = ""

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw)

    assert exc_info.value.code == "missing_action_label"


def test_malformed_trace_url_is_reported_as_a_trace_validation_error() -> None:
    raw = deepcopy(_valid_trace())
    raw["steps"][0]["actions"][0]["target_url"] = "https://qsike.com:bad/"

    with pytest.raises(TraceValidationError) as exc_info:
        _validate(raw)

    assert exc_info.value.code == "invalid_url"


def _browser_request(**overrides: object) -> SimpleNamespace:
    values = {
        "request_text": "QSike 서비스를 소개하고 최근 글을 여는 방법을 보여줘",
        "target_url": "https://qsike.com/",
        "role": "방문자",
        "completion_condition": "최근 글 상세 화면 확인",
        "input_values": {"search_query": "Playwright", "password": "plain-password"},
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _opencode_settings(**overrides: str):
    environ = {
        "MANUAL_AGENT_ENABLE_OPENCODE": "true",
        "MANUAL_AGENT_OPENCODE_COMMAND": "opencode run --format json",
        "MANUAL_AGENT_OPENCODE_AGENT": "browser",
        "MANUAL_AGENT_OPENCODE_MODEL": "ignored/model",
        "MANUAL_AGENT_PLAYWRIGHT_MCP_COMMAND": "npx @playwright/mcp@1.2.3 --headless",
        "MANUAL_AGENT_OPENCODE_TIMEOUT_SECONDS": "45",
    }
    environ.update(overrides)
    return load_settings(environ=environ)


def _opencode_stdout(trace: dict[str, object] | None = None) -> str:
    events = [{"type": "step_start", "name": "browser discovery"}]
    if trace is not None:
        events.append({"type": "text", "part": {"text": json.dumps(trace, ensure_ascii=False)}})
    return "\n".join(json.dumps(event, ensure_ascii=False) for event in events)


def test_opencode_browser_discovery_writes_isolated_mcp_config_and_extracts_trace(
    tmp_path: Path,
) -> None:
    settings = _opencode_settings()
    request = _browser_request()
    expected_trace = _valid_trace()
    endpoint = "http://127.0.0.1:43129"

    def fake_runner(args, **kwargs):
        assert kwargs["cwd"] == str(tmp_path)
        assert kwargs["timeout"] == 45.0
        assert args[1:4] == ["run", "--format", "json"]
        assert "--agent" in args
        assert "--model" not in args
        assert "ignored/model" not in args

        config = json.loads((tmp_path / "opencode.json").read_text(encoding="utf-8"))
        assert list(config["mcp"]) == ["playwright"]
        mcp_command = config["mcp"]["playwright"]["command"]
        assert Path(mcp_command[0]).name.lower() in {"npx", "npx.cmd"}
        assert mcp_command[1] == "@playwright/mcp@1.2.3"
        assert mcp_command[-2:] == ["--cdp-endpoint", endpoint]
        assert "--headless" not in mcp_command
        assert config["tools"] == {"*": False, "playwright_*": True}
        assert config["permission"]["*"] == "deny"
        assert config["permission"]["playwright_*"] == "allow"

        prompt = (tmp_path / "opencode_browser_prompt.md").read_text(encoding="utf-8")
        assert "QSike 서비스를 소개" in prompt
        assert "https://qsike.com/" in prompt
        assert "search_query" in prompt
        assert "Playwright" in prompt
        assert "plain-password" not in prompt
        return subprocess.CompletedProcess(
            args=args,
            returncode=0,
            stdout=_opencode_stdout(expected_trace),
            stderr="diagnostic stderr",
        )

    result = OpenCodeBrowserDiscovery(settings, command_runner=fake_runner).run(
        request=request,
        job_dir=tmp_path,
        cdp_endpoint=endpoint,
    )

    assert result.status == "completed"
    assert result.trace == expected_trace
    assert result.config_path == tmp_path / "opencode.json"
    assert result.event_log_path.read_text(encoding="utf-8") == _opencode_stdout(expected_trace)
    assert json.loads(result.trace_path.read_text(encoding="utf-8")) == expected_trace
    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert metadata["returncode"] == 0
    assert metadata["stderr"] == "diagnostic stderr"
    assert metadata["model_source"] == "opencode-default"
    assert result.support_summary_path.read_text(encoding="utf-8").startswith("OPENCODE_BROWSER_OK")


def test_opencode_browser_discovery_fails_when_disabled_and_still_writes_support_files(
    tmp_path: Path,
) -> None:
    settings = _opencode_settings(MANUAL_AGENT_ENABLE_OPENCODE="false")

    with pytest.raises(OpenCodeBrowserDiscoveryError) as exc_info:
        OpenCodeBrowserDiscovery(settings).run(
            request=_browser_request(),
            job_dir=tmp_path,
            cdp_endpoint="http://127.0.0.1:9222",
        )

    assert exc_info.value.code == "opencode_disabled"
    assert (tmp_path / "opencode_browser_metadata.json").exists()
    assert "opencode_disabled" in (tmp_path / "opencode_support_summary.txt").read_text(encoding="utf-8")


def test_opencode_browser_discovery_fails_fast_on_timeout(tmp_path: Path) -> None:
    def fake_runner(args, **kwargs):
        raise subprocess.TimeoutExpired(args, kwargs["timeout"], output="partial", stderr="slow")

    with pytest.raises(OpenCodeBrowserDiscoveryError) as exc_info:
        OpenCodeBrowserDiscovery(_opencode_settings(), command_runner=fake_runner).run(
            request=_browser_request(),
            job_dir=tmp_path,
            cdp_endpoint="http://127.0.0.1:9222",
        )

    assert exc_info.value.code == "opencode_timeout"
    metadata = json.loads((tmp_path / "opencode_browser_metadata.json").read_text(encoding="utf-8"))
    assert metadata["status"] == "failed"
    assert metadata["stderr"] == "slow"


def test_opencode_browser_discovery_fails_fast_on_nonzero_exit(tmp_path: Path) -> None:
    def fake_runner(args, **kwargs):
        return subprocess.CompletedProcess(args, 7, stdout="partial", stderr="command failed")

    with pytest.raises(OpenCodeBrowserDiscoveryError) as exc_info:
        OpenCodeBrowserDiscovery(_opencode_settings(), command_runner=fake_runner).run(
            request=_browser_request(),
            job_dir=tmp_path,
            cdp_endpoint="http://127.0.0.1:9222",
        )

    assert exc_info.value.code == "opencode_nonzero_exit"
    metadata = json.loads((tmp_path / "opencode_browser_metadata.json").read_text(encoding="utf-8"))
    assert metadata["returncode"] == 7
    assert metadata["stderr"] == "command failed"


def test_opencode_browser_discovery_rejects_malformed_jsonl(tmp_path: Path) -> None:
    def fake_runner(args, **kwargs):
        return subprocess.CompletedProcess(args, 0, stdout='{"type":"step"}\nnot-json', stderr="")

    with pytest.raises(OpenCodeBrowserDiscoveryError) as exc_info:
        OpenCodeBrowserDiscovery(_opencode_settings(), command_runner=fake_runner).run(
            request=_browser_request(),
            job_dir=tmp_path,
            cdp_endpoint="http://127.0.0.1:9222",
        )

    assert exc_info.value.code == "opencode_malformed_output"


def test_opencode_browser_discovery_rejects_success_without_final_trace(tmp_path: Path) -> None:
    def fake_runner(args, **kwargs):
        return subprocess.CompletedProcess(args, 0, stdout=_opencode_stdout(), stderr="")

    with pytest.raises(OpenCodeBrowserDiscoveryError) as exc_info:
        OpenCodeBrowserDiscovery(_opencode_settings(), command_runner=fake_runner).run(
            request=_browser_request(),
            job_dir=tmp_path,
            cdp_endpoint="http://127.0.0.1:9222",
        )

    assert exc_info.value.code == "opencode_trace_missing"


def test_opencode_browser_discovery_combines_split_final_text_events(tmp_path: Path) -> None:
    trace_text = json.dumps(_valid_trace(), ensure_ascii=False)
    midpoint = len(trace_text) // 2
    stdout = "\n".join(
        json.dumps({"type": "text", "part": {"text": chunk}}, ensure_ascii=False)
        for chunk in (trace_text[:midpoint], trace_text[midpoint:])
    )

    def fake_runner(args, **kwargs):
        return subprocess.CompletedProcess(args, 0, stdout=stdout, stderr="")

    result = OpenCodeBrowserDiscovery(_opencode_settings(), command_runner=fake_runner).run(
        request=_browser_request(),
        job_dir=tmp_path,
        cdp_endpoint="http://127.0.0.1:9222",
    )

    assert result.trace == _valid_trace()


@pytest.mark.parametrize(
    ("overrides", "expected_code"),
    [
        ({"MANUAL_AGENT_OPENCODE_COMMAND": ""}, "opencode_command_empty"),
        ({"MANUAL_AGENT_PLAYWRIGHT_MCP_COMMAND": ""}, "playwright_mcp_command_invalid"),
    ],
)
def test_opencode_browser_discovery_reports_invalid_required_commands(
    tmp_path: Path,
    overrides: dict[str, str],
    expected_code: str,
) -> None:
    with pytest.raises(OpenCodeBrowserDiscoveryError) as exc_info:
        OpenCodeBrowserDiscovery(_opencode_settings(**overrides)).run(
            request=_browser_request(),
            job_dir=tmp_path,
            cdp_endpoint="http://127.0.0.1:9222",
        )

    assert exc_info.value.code == expected_code
    assert expected_code in (tmp_path / "opencode_support_summary.txt").read_text(encoding="utf-8")


def _session_settings(tmp_path: Path, **overrides: object) -> SimpleNamespace:
    login_values = {
        "sso_profile_dir": str(tmp_path / "edge-profile"),
        "browser_channel": "msedge",
        "auth_server_allowlist": "*.corp.local",
        "auth_negotiate_delegate_allowlist": "*.corp.local",
        "username": "employee-id",
        "password": "plain-password",
    }
    login_overrides = overrides.pop("login", {})
    if isinstance(login_overrides, dict):
        login_values.update(login_overrides)
    values = {
        "browser_runner": "playwright",
        "cdp_endpoint": "",
        "playwright_executable_path": "",
        "request_timeout_seconds": 10.0,
        "login": SimpleNamespace(**login_values),
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class _FakeBrowserProcess:
    def __init__(self, *, pid: int = 4242, poll_result: int | None = None) -> None:
        self.pid = pid
        self.poll_result = poll_result

    def poll(self):
        return self.poll_result


def test_browser_session_launches_edge_on_dynamic_loopback_cdp_and_cleans_process_tree(
    tmp_path: Path,
) -> None:
    settings = _session_settings(tmp_path)
    process = _FakeBrowserProcess()
    launches: list[tuple[list[str], dict[str, object]]] = []
    probes: list[str] = []
    terminated: list[int] = []

    def process_factory(command, **kwargs):
        launches.append((command, kwargs))
        return process

    def readiness_probe(endpoint: str) -> bool:
        probes.append(endpoint)
        return len(probes) >= 2

    manager = BrowserSessionManager(
        settings,
        process_factory=process_factory,
        readiness_probe=readiness_probe,
        port_allocator=lambda: 43129,
        executable_resolver=lambda *_args, **_kwargs: Path("C:/Edge/msedge.exe"),
        process_tree_terminator=lambda item: terminated.append(item.pid),
        sleep=lambda _seconds: None,
    )

    with manager as session:
        assert session.cdp_endpoint == "http://127.0.0.1:43129"
        assert session.owned is True
        assert session.pid == 4242
        assert session.profile_path == (tmp_path / "edge-profile").resolve()
        assert session.browser_channel == "msedge"
        assert session.to_safe_dict()["owned"] is True
        assert "password" not in json.dumps(session.to_safe_dict()).lower()

    assert probes == ["http://127.0.0.1:43129", "http://127.0.0.1:43129"]
    assert terminated == [4242]
    command = launches[0][0]
    assert command[0] == "C:\\Edge\\msedge.exe"
    assert "--remote-debugging-address=127.0.0.1" in command
    assert "--remote-debugging-port=43129" in command
    assert "--edge-skip-compat-layer-relaunch" in command
    assert f"--user-data-dir={(tmp_path / 'edge-profile').resolve()}" in command
    assert "--auth-server-allowlist=*.corp.local" in command
    assert "--auth-negotiate-delegate-allowlist=*.corp.local" in command
    assert "employee-id" not in " ".join(command)
    assert "plain-password" not in " ".join(command)
    assert not (tmp_path / "edge-profile" / ".manual-agent-cdp.lock").exists()


def test_browser_session_reuses_existing_loopback_cdp_without_owning_process(tmp_path: Path) -> None:
    settings = _session_settings(
        tmp_path,
        browser_runner="cdp_attach",
        cdp_endpoint="http://localhost:9333",
    )
    probes: list[str] = []

    def fail_process_factory(*_args, **_kwargs):
        raise AssertionError("existing CDP mode must not launch a browser")

    with BrowserSessionManager(
        settings,
        process_factory=fail_process_factory,
        readiness_probe=lambda endpoint: probes.append(endpoint) or True,
    ) as session:
        assert session.cdp_endpoint == "http://localhost:9333"
        assert session.owned is False
        assert session.pid is None
        assert session.profile_path is None

    assert probes == ["http://localhost:9333"]


@pytest.mark.parametrize(
    "endpoint",
    ["http://10.0.0.5:9222", "https://example.com:9222", "http://127.0.0.1.evil:9222"],
)
def test_browser_session_rejects_non_loopback_cdp_endpoint(tmp_path: Path, endpoint: str) -> None:
    settings = _session_settings(tmp_path, browser_runner="cdp_attach", cdp_endpoint=endpoint)

    with pytest.raises(BrowserSessionError) as exc_info:
        with BrowserSessionManager(settings, readiness_probe=lambda _endpoint: True):
            pass

    assert exc_info.value.code == "non_loopback_cdp_endpoint"


def test_browser_session_reports_profile_lock_without_launching(tmp_path: Path) -> None:
    settings = _session_settings(tmp_path)
    profile = tmp_path / "edge-profile"
    profile.mkdir(parents=True)
    (profile / ".manual-agent-cdp.lock").write_text("existing-owner", encoding="utf-8")

    def fail_process_factory(*_args, **_kwargs):
        raise AssertionError("locked profile must not launch")

    with pytest.raises(BrowserSessionError) as exc_info:
        with BrowserSessionManager(
            settings,
            process_factory=fail_process_factory,
            readiness_probe=lambda _endpoint: True,
            executable_resolver=lambda *_args, **_kwargs: Path("C:/Edge/msedge.exe"),
        ):
            pass

    assert exc_info.value.code == "profile_locked"
    assert "existing-owner" not in str(exc_info.value)


def test_browser_session_timeout_terminates_owned_process_and_releases_profile(tmp_path: Path) -> None:
    settings = _session_settings(tmp_path)
    process = _FakeBrowserProcess()
    terminated: list[int] = []
    clock_values = iter([0.0, 0.0, 1.0])

    manager = BrowserSessionManager(
        settings,
        process_factory=lambda *_args, **_kwargs: process,
        readiness_probe=lambda _endpoint: False,
        port_allocator=lambda: 43129,
        executable_resolver=lambda *_args, **_kwargs: Path("C:/Edge/msedge.exe"),
        process_tree_terminator=lambda item: terminated.append(item.pid),
        sleep=lambda _seconds: None,
        clock=lambda: next(clock_values),
        startup_timeout_seconds=0.5,
    )

    with pytest.raises(BrowserSessionError) as exc_info:
        with manager:
            pass

    assert exc_info.value.code == "cdp_start_timeout"
    assert terminated == [4242]
    assert not (tmp_path / "edge-profile" / ".manual-agent-cdp.lock").exists()


def test_discover_browser_executable_uses_configuration_or_path_without_fixed_driver_location(
    tmp_path: Path,
) -> None:
    configured = tmp_path / "portable" / "msedge.exe"
    configured.parent.mkdir(parents=True)
    configured.write_bytes(b"edge")

    assert discover_browser_executable("msedge", configured_path=str(configured)) == configured.resolve()

    path_edge = tmp_path / "path" / "msedge.exe"
    path_edge.parent.mkdir()
    path_edge.write_bytes(b"edge")
    assert discover_browser_executable(
        "msedge",
        environ={"PATH": str(path_edge.parent)},
        which=lambda _name, **_kwargs: str(path_edge),
    ) == path_edge.resolve()
