from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.app.discovery_evidence import DiscoveryEvidenceError, validate_discovery_evidence
from backend.app.execution_trace import ExecutionTrace


HOME_URL = "https://qsike.com/"
ARTICLE_URL = "https://qsike.com/posts/latest-note/"


def _trace() -> ExecutionTrace:
    return ExecutionTrace.model_validate(
        {
            "schema_version": "1.0",
            "status": "completed",
            "request_summary": "QSike 최신 글을 여는 방법을 설명한다.",
            "input_values": [],
            "steps": [
                {
                    "id": "step-home",
                    "title": "홈 화면 열기",
                    "narration": "QSike Tech Notes 홈 화면을 엽니다.",
                    "actions": [
                        {
                            "id": "navigate-home",
                            "type": "navigate",
                            "target_url": HOME_URL,
                            "observed_url": HOME_URL,
                        },
                        {
                            "id": "capture-home",
                            "type": "capture",
                            "observed_url": HOME_URL,
                            "evidence": {
                                "screenshot_path": ".playwright-mcp/home.png",
                                "visible_text": ["QSike Tech Notes"],
                            },
                        },
                    ],
                },
                {
                    "id": "step-article",
                    "title": "최신 글 열기",
                    "narration": "최근 기술 노트에서 최신 글을 엽니다.",
                    "actions": [
                        {
                            "id": "click-latest",
                            "type": "click",
                            "ref": "e42",
                            "label": "최신 기술 노트",
                            "observed_url": HOME_URL,
                            "expected_after": "최신 글 상세 화면이 표시된다.",
                        },
                        {
                            "id": "capture-article",
                            "type": "capture",
                            "observed_url": ARTICLE_URL,
                            "evidence": {
                                "screenshot_path": ".playwright-mcp/final.png",
                                "visible_text": ["메타와 마이크론"],
                            },
                        },
                    ],
                },
            ],
            "completion_evidence": {
                "final_url": ARTICLE_URL,
                "assertions": ["최신 글 제목과 본문이 보인다."],
                "screenshot_path": ".playwright-mcp/final.png",
            },
        }
    )


def _tool_event(tool: str, output: str, *, input_payload: dict[str, object] | None = None) -> dict:
    return {
        "type": "tool_use",
        "part": {
            "tool": tool,
            "state": {
                "status": "completed",
                "input": input_payload or {},
                "output": output,
            },
        },
    }


def _write_events(path: Path, events: list[dict]) -> None:
    path.write_text(
        "\n".join(json.dumps(event, ensure_ascii=False) for event in events) + "\n",
        encoding="utf-8",
    )


def _valid_events() -> list[dict]:
    return [
        _tool_event(
            "playwright_browser_navigate",
            f"### Page\n- Page URL: {HOME_URL}\n### Snapshot\n- link \"최신 기술 노트\" [ref=e42]\n- text: QSike Tech Notes",
            input_payload={"url": HOME_URL},
        ),
        _tool_event(
            "playwright_browser_take_screenshot",
            "### Result\n- [Screenshot of viewport](.playwright-mcp/home.png)",
        ),
        _tool_event(
            "playwright_browser_navigate",
            f"### Page\n- Page URL: {ARTICLE_URL}\n### Snapshot\n- heading \"메타와 마이크론\"",
            input_payload={"url": ARTICLE_URL},
        ),
        _tool_event(
            "playwright_browser_take_screenshot",
            "### Result\n- [Screenshot of viewport](.playwright-mcp/final.png)",
        ),
    ]


def test_discovery_evidence_accepts_observed_urls_targets_and_real_screenshots(tmp_path: Path) -> None:
    evidence_dir = tmp_path / ".playwright-mcp"
    evidence_dir.mkdir()
    (evidence_dir / "home.png").write_bytes(b"home-png")
    (evidence_dir / "final.png").write_bytes(b"final-png")
    event_log = tmp_path / "opencode_events.jsonl"
    _write_events(event_log, _valid_events())

    summary = validate_discovery_evidence(_trace(), event_log_path=event_log, job_dir=tmp_path)

    assert summary.status == "verified"
    assert summary.final_url == ARTICLE_URL
    assert summary.observed_urls == [HOME_URL, ARTICLE_URL]
    assert {path.name for path in summary.screenshot_paths} == {"home.png", "final.png"}


def test_discovery_evidence_rejects_completion_url_after_failed_click(tmp_path: Path) -> None:
    evidence_dir = tmp_path / ".playwright-mcp"
    evidence_dir.mkdir()
    (evidence_dir / "home.png").write_bytes(b"home-png")
    (evidence_dir / "final.png").write_bytes(b"fabricated")
    events = _valid_events()[:2]
    events.append(
        _tool_event(
            "playwright_browser_click",
            "### Error\nTimeoutError: locator did not become stable",
            input_payload={"target": "e42"},
        )
    )
    event_log = tmp_path / "opencode_events.jsonl"
    _write_events(event_log, events)

    with pytest.raises(DiscoveryEvidenceError) as exc_info:
        validate_discovery_evidence(_trace(), event_log_path=event_log, job_dir=tmp_path)

    assert exc_info.value.code == "completion_url_unverified"


def test_discovery_evidence_rejects_missing_screenshot_file(tmp_path: Path) -> None:
    evidence_dir = tmp_path / ".playwright-mcp"
    evidence_dir.mkdir()
    (evidence_dir / "home.png").write_bytes(b"home-png")
    event_log = tmp_path / "opencode_events.jsonl"
    _write_events(event_log, _valid_events())

    with pytest.raises(DiscoveryEvidenceError) as exc_info:
        validate_discovery_evidence(_trace(), event_log_path=event_log, job_dir=tmp_path)

    assert exc_info.value.code == "screenshot_missing"
