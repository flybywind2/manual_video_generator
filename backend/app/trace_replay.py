from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

from backend.app.execution_trace import ExecutionTrace, TraceAction, TraceStep


PlaywrightFactory = Callable[[], Any]


class TraceReplayError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        step_id: str = "",
        action_id: str = "",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.step_id = step_id
        self.action_id = action_id


@dataclass(frozen=True)
class TraceReplayResult:
    status: str
    captures: list[Path]
    final_frame: Path
    action_log: list[dict[str, Any]]
    action_log_path: Path
    selector_trace_path: Path
    media_plan: dict[str, Any]

    def to_capture_contract(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "degrade_reason": "",
            "source": "opencode-trace-replay",
            "captures": self.captures,
            "masked_names": [path.name for path in self.captures],
            "final_frame": self.final_frame,
            "action_log": self.action_log,
            "action_log_path": self.action_log_path,
            "selector_trace_path": self.selector_trace_path,
            "media_plan": self.media_plan,
        }


def replay_execution_trace(
    *,
    trace: ExecutionTrace | Mapping[str, Any],
    request: Any,
    job_dir: Path,
    cdp_endpoint: str,
    settings: Any,
    step_durations_seconds: Mapping[str, float] | None = None,
    playwright_factory: PlaywrightFactory | None = None,
) -> TraceReplayResult:
    parsed_trace = trace if isinstance(trace, ExecutionTrace) else ExecutionTrace.model_validate(trace)
    target_url = str(_request_value(request, "target_url", "") or "")
    allowed_origin = _origin(target_url)
    if not allowed_origin:
        raise TraceReplayError("invalid_target_url", "Replay target URL has no valid HTTP origin")
    input_values = _request_value(request, "input_values", {})
    if not isinstance(input_values, Mapping):
        input_values = {}

    job_dir = Path(job_dir)
    capture_dir = job_dir / "captures" / "replay"
    capture_dir.mkdir(parents=True, exist_ok=True)
    action_log_path = job_dir / "trace_replay_log.json"
    selector_trace_path = job_dir / "selector_trace.json"
    final_frame = job_dir / "final_frame.png"
    captures: list[Path] = []
    action_log: list[dict[str, Any]] = []
    selector_trace: list[dict[str, Any]] = []
    step_last_captures: dict[str, str] = {}
    durations = dict(step_durations_seconds or {})
    timeout_ms = _timeout_ms(settings)

    if playwright_factory is None:
        from playwright.sync_api import sync_playwright

        playwright_factory = sync_playwright

    with playwright_factory() as playwright:
        browser = playwright.chromium.connect_over_cdp(cdp_endpoint)
        contexts = list(getattr(browser, "contexts", []) or [])
        if not contexts:
            raise TraceReplayError("cdp_context_missing", "CDP browser has no reusable context")
        context = contexts[0]
        pages = list(getattr(context, "pages", []) or [])
        if not pages:
            raise TraceReplayError("cdp_page_missing", "CDP browser context has no page")
        page = pages[-1]
        _configure_page(page, timeout_ms)
        _install_visual_helpers(page)

        for step_index, step in enumerate(parsed_trace.steps, start=1):
            step_duration = _step_duration_seconds(step, durations)
            action_duration_ms = max(200, int(step_duration * 1000 / max(1, len(step.actions))))
            for action_index, action in enumerate(step.actions, start=1):
                prefix = _capture_prefix(step_index, action_index, action.id)
                before_path = _capture(page, capture_dir, f"{prefix}_before.png")
                captures.append(before_path)
                before_state = _page_state(page)
                log_entry: dict[str, Any] = {
                    "step_id": step.id,
                    "action_id": action.id,
                    "type": action.type,
                    "status": "started",
                    "before_capture": str(before_path),
                    "duration_ms": action_duration_ms,
                }
                try:
                    if action.type != "navigate":
                        _assert_runtime_origin(
                            page,
                            allowed_origin,
                            step_id=step.id,
                            action_id=action.id,
                        )
                        _assert_observed_location(
                            page,
                            action.observed_url,
                            step_id=step.id,
                            action_id=action.id,
                        )
                    resolved_selector, method = _execute_action(
                        page=page,
                        action=action,
                        input_values=input_values,
                        timeout_ms=timeout_ms,
                        action_duration_ms=action_duration_ms,
                    )
                    if action.type in {"click", "press"}:
                        page = _newest_page(context, page, timeout_ms)
                    after_state = _page_state(page)
                    _verify_action(
                        action,
                        before_state=before_state,
                        after_state=after_state,
                    )
                    _assert_runtime_origin(
                        page,
                        allowed_origin,
                        step_id=step.id,
                        action_id=action.id,
                    )
                    after_path = _capture(page, capture_dir, f"{prefix}_after.png")
                    captures.append(after_path)
                    step_last_captures[step.id] = str(after_path)
                    log_entry.update(
                        {
                            "status": "ok",
                            "method": method,
                            "resolved_selector": resolved_selector,
                            "after_capture": str(after_path),
                            "observed_url": str(getattr(page, "url", "") or ""),
                        }
                    )
                    if resolved_selector:
                        selector_trace.append(
                            {
                                "step_id": step.id,
                                "action_id": action.id,
                                "type": action.type,
                                "ref": action.ref,
                                "selector": action.selector,
                                "resolved_selector": resolved_selector,
                                "label": action.label,
                            }
                        )
                    action_log.append(log_entry)
                except Exception as exc:
                    replay_error = _as_replay_error(exc, step=step, action=action)
                    try:
                        failed_path = _capture(page, capture_dir, f"{prefix}_failed.png")
                        captures.append(failed_path)
                        log_entry["after_capture"] = str(failed_path)
                    except Exception:
                        pass
                    log_entry.update(
                        {
                            "status": "failed",
                            "error_code": replay_error.code,
                            "error": str(replay_error),
                        }
                    )
                    action_log.append(log_entry)
                    _write_json(action_log_path, action_log)
                    _write_json(selector_trace_path, selector_trace)
                    raise replay_error from exc

        try:
            _assert_runtime_origin(page, allowed_origin, step_id="completion", action_id="completion")
            _assert_completion_url(page, parsed_trace.completion_evidence.final_url)
            _capture(page, job_dir, final_frame.name)
        except Exception as exc:
            completion_error = (
                exc
                if isinstance(exc, TraceReplayError)
                else TraceReplayError(
                    "replay_diverged",
                    f"Completion verification failed: {type(exc).__name__}: {exc}",
                    step_id="completion",
                    action_id="completion",
                )
            )
            action_log.append(
                {
                    "step_id": "completion",
                    "action_id": "completion",
                    "type": "verify",
                    "status": "failed",
                    "error_code": completion_error.code,
                    "error": str(completion_error),
                }
            )
            _write_json(action_log_path, action_log)
            _write_json(selector_trace_path, selector_trace)
            raise completion_error from exc

    media_plan = {
        "source": "opencode-trace-replay",
        "steps": [
            {
                "id": step.id,
                "title": step.title,
                "caption": step.title,
                "narration": step.narration,
                "duration_seconds": _step_duration_seconds(step, durations),
                "capture": step_last_captures.get(step.id, ""),
            }
            for step in parsed_trace.steps
        ],
    }
    _write_json(action_log_path, action_log)
    _write_json(selector_trace_path, selector_trace)
    return TraceReplayResult(
        status="ok",
        captures=captures,
        final_frame=final_frame,
        action_log=action_log,
        action_log_path=action_log_path,
        selector_trace_path=selector_trace_path,
        media_plan=media_plan,
    )


def _execute_action(
    *,
    page: Any,
    action: TraceAction,
    input_values: Mapping[str, Any],
    timeout_ms: int,
    action_duration_ms: int,
) -> tuple[str, str]:
    if action.type == "wait":
        wait_ms = max(action_duration_ms, int(action.duration_ms or 0))
        page.wait_for_timeout(wait_ms)
        return "", f"wait:{wait_ms}ms"
    if action.type == "capture":
        _wait_around_action(page, action_duration_ms, execute=None)
        return "", "capture"
    if action.type == "navigate":
        def navigate() -> None:
            page.goto(action.target_url, wait_until="domcontentloaded", timeout=timeout_ms)
            try:
                page.wait_for_load_state("networkidle", timeout=min(timeout_ms, 5000))
            except Exception:
                pass

        _wait_around_action(page, action_duration_ms, execute=navigate)
        return "", f"goto:{action.target_url}"

    locator, resolved_selector = _resolve_locator(page, action, timeout_ms)
    _show_action_visual(page, locator, click=action.type in {"click", "press"})

    if action.type == "fill":
        if action.value_key not in input_values:
            raise TraceReplayError("input_value_missing", "Replay input value is unavailable")
        value = str(input_values[action.value_key])
        _wait_around_action(page, action_duration_ms, execute=lambda: locator.fill(value))
        actual = str(locator.input_value())
        if actual != value:
            raise TraceReplayError("replay_diverged", "Filled input value did not match the request")
        return resolved_selector, f"fill:{resolved_selector}"
    if action.type == "click":
        _wait_around_action(page, action_duration_ms, execute=locator.click)
        return resolved_selector, f"click:{resolved_selector}"
    if action.type == "press":
        _wait_around_action(page, action_duration_ms, execute=lambda: locator.press(action.key))
        return resolved_selector, f"press:{resolved_selector}:{action.key}"
    raise TraceReplayError("unsupported_replay_action", f"Unsupported replay action {action.type}")


def _resolve_locator(page: Any, action: TraceAction, timeout_ms: int) -> tuple[Any, str]:
    candidates: list[tuple[Any, str]] = []
    if action.selector:
        candidates.append((page.locator(action.selector), action.selector))
    if action.ref:
        ref = action.ref if action.ref.startswith("aria-ref=") else f"aria-ref={action.ref}"
        if ref != action.selector:
            candidates.append((page.locator(ref), ref))
    candidates.extend(_semantic_locator_candidates(page, action))
    failures: list[str] = []
    seen_descriptors: set[str] = set()
    for locator, candidate in candidates:
        if candidate in seen_descriptors:
            continue
        seen_descriptors.add(candidate)
        count = int(locator.count()) if callable(getattr(locator, "count", None)) else 1
        if count != 1:
            failures.append(f"{candidate}:{count}")
            continue
        try:
            locator.wait_for(state="visible", timeout=timeout_ms)
        except TypeError:
            locator.wait_for(state="visible")
        return locator, candidate
    detail = ", ".join(failures) or "no locator candidates"
    raise TraceReplayError("replay_diverged", f"Replay target is missing or ambiguous: {detail}")


def _semantic_locator_candidates(page: Any, action: TraceAction) -> list[tuple[Any, str]]:
    label = action.label.strip()
    if not label:
        return []
    candidates: list[tuple[Any, str]] = []
    if action.type == "fill" and callable(getattr(page, "get_by_label", None)):
        candidates.append((page.get_by_label(label, exact=True), f"label={label}"))
    if action.type in {"click", "press"} and callable(getattr(page, "get_by_role", None)):
        for role in ("button", "link", "menuitem", "tab"):
            candidates.append(
                (page.get_by_role(role, name=label, exact=True), f"role={role}[name={label}]")
            )
    if callable(getattr(page, "get_by_text", None)):
        candidates.append((page.get_by_text(label, exact=True), f"text={label}"))
    return candidates


def _verify_action(
    action: TraceAction,
    *,
    before_state: Mapping[str, Any],
    after_state: Mapping[str, Any],
) -> None:
    if action.type in {"click", "press"} and action.expected_after:
        if _state_fingerprint(before_state) == _state_fingerprint(after_state):
            raise TraceReplayError("replay_diverged", "Expected page state change was not observed")
    if action.evidence and action.evidence.visible_text:
        body_text = str(after_state.get("text") or "")
        missing = [text for text in action.evidence.visible_text if text not in body_text]
        if missing:
            raise TraceReplayError(
                "replay_diverged",
                f"Expected evidence text was not visible: {', '.join(missing)}",
            )


def _wait_around_action(page: Any, duration_ms: int, *, execute: Callable[[], None] | None) -> None:
    before_ms = max(100, int(duration_ms * 0.35))
    after_ms = max(100, duration_ms - before_ms)
    page.wait_for_timeout(before_ms)
    if execute is not None:
        execute()
    page.wait_for_timeout(after_ms)


def _configure_page(page: Any, timeout_ms: int) -> None:
    if callable(getattr(page, "set_default_timeout", None)):
        page.set_default_timeout(timeout_ms)
    if callable(getattr(page, "set_default_navigation_timeout", None)):
        page.set_default_navigation_timeout(timeout_ms)


def _install_visual_helpers(page: Any) -> None:
    page.add_style_tag(
        content="""
        .manual-replay-highlight{outline:4px solid #21d4fd!important;outline-offset:3px!important;box-shadow:0 0 0 8px rgba(36,91,255,.24)!important;position:relative!important;z-index:2147483644!important}
        .manual-replay-cursor{position:fixed;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-3px,-3px);transition:left .22s ease,top .22s ease;filter:drop-shadow(0 5px 7px rgba(0,0,0,.35))}
        .manual-replay-cursor:before{content:"";position:absolute;border-left:18px solid #111827;border-top:10px solid transparent;border-bottom:10px solid transparent;transform:rotate(-32deg)}
        .manual-replay-ripple{position:fixed;width:38px;height:38px;margin:-19px;border:3px solid #245bff;border-radius:50%;z-index:2147483646;pointer-events:none;background:rgba(33,212,253,.2)}
        """
    )
    page.evaluate(
        """
        () => {
          window.__manualReplayVisual = ({x, y, click}) => {
            let cursor = document.querySelector('.manual-replay-cursor');
            if (!cursor) {
              cursor = document.createElement('div');
              cursor.className = 'manual-replay-cursor';
              document.documentElement.appendChild(cursor);
            }
            cursor.style.left = `${x}px`;
            cursor.style.top = `${y}px`;
            if (click) {
              const ripple = document.createElement('div');
              ripple.className = 'manual-replay-ripple';
              ripple.style.left = `${x}px`;
              ripple.style.top = `${y}px`;
              document.documentElement.appendChild(ripple);
              setTimeout(() => ripple.remove(), 650);
            }
          };
        }
        """
    )


def _show_action_visual(page: Any, locator: Any, *, click: bool) -> None:
    box = locator.evaluate(
        """
        (element) => {
          document.querySelectorAll('.manual-replay-highlight').forEach(node => node.classList.remove('manual-replay-highlight'));
          element.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
          element.classList.add('manual-replay-highlight');
          const rect = element.getBoundingClientRect();
          return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
        }
        """
    )
    if not isinstance(box, Mapping):
        box = locator.bounding_box() or {}
    x = float(box.get("x", 0)) + float(box.get("width", 0)) / 2
    y = float(box.get("y", 0)) + float(box.get("height", 0)) / 2
    page.evaluate("payload => window.__manualReplayVisual?.(payload)", {"x": x, "y": y, "click": click})


def _newest_page(context: Any, current_page: Any, timeout_ms: int) -> Any:
    pages = list(getattr(context, "pages", []) or [])
    if not pages or pages[-1] is current_page:
        return current_page
    page = pages[-1]
    _configure_page(page, timeout_ms)
    _install_visual_helpers(page)
    try:
        page.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
    except Exception:
        pass
    return page


def _page_state(page: Any) -> dict[str, Any]:
    value = page.evaluate(
        """
        () => ({
          __manualReplayState: true,
          url: location.href,
          title: document.title,
          text: (document.body?.innerText || '').slice(0, 12000),
          htmlLength: document.documentElement?.outerHTML?.length || 0
        })
        """
    )
    if isinstance(value, Mapping):
        return dict(value)
    return {"url": str(getattr(page, "url", "") or ""), "value": str(value)}


def _state_fingerprint(state: Mapping[str, Any]) -> str:
    return json.dumps(state, ensure_ascii=False, sort_keys=True, default=str)


def _assert_runtime_origin(
    page: Any,
    allowed_origin: str,
    *,
    step_id: str,
    action_id: str,
) -> None:
    url = str(getattr(page, "url", "") or "")
    if _origin(url) != allowed_origin:
        raise TraceReplayError(
            "off_origin_during_replay",
            f"Replay left the allowed origin: {url}",
            step_id=step_id,
            action_id=action_id,
        )


def _assert_observed_location(
    page: Any,
    expected_url: str,
    *,
    step_id: str,
    action_id: str,
) -> None:
    actual_url = str(getattr(page, "url", "") or "")
    try:
        actual = urlsplit(actual_url)
        expected = urlsplit(expected_url)
    except ValueError as exc:
        raise TraceReplayError(
            "replay_diverged",
            "Observed replay URL is invalid",
            step_id=step_id,
            action_id=action_id,
        ) from exc
    actual_path = actual.path.rstrip("/") or "/"
    expected_path = expected.path.rstrip("/") or "/"
    query_mismatch = bool(expected.query) and actual.query != expected.query
    fragment_mismatch = bool(expected.fragment) and actual.fragment != expected.fragment
    if actual_path != expected_path or query_mismatch or fragment_mismatch:
        raise TraceReplayError(
            "replay_diverged",
            f"Replay is at {actual_url}, expected observed location {expected_url}",
            step_id=step_id,
            action_id=action_id,
        )


def _assert_completion_url(page: Any, expected_url: str) -> None:
    actual_url = str(getattr(page, "url", "") or "")
    try:
        actual = urlsplit(actual_url)
        expected = urlsplit(expected_url)
    except ValueError as exc:
        raise TraceReplayError(
            "replay_diverged",
            "Completion URL is invalid",
            step_id="completion",
            action_id="completion",
        ) from exc
    actual_path = actual.path.rstrip("/") or "/"
    expected_path = expected.path.rstrip("/") or "/"
    query_mismatch = bool(expected.query) and actual.query != expected.query
    if actual_path != expected_path or query_mismatch:
        raise TraceReplayError(
            "replay_diverged",
            f"Replay completed at {actual_url}, expected {expected_url}",
            step_id="completion",
            action_id="completion",
        )


def _origin(url: str) -> str:
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return ""
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        return ""
    port = port or (443 if parsed.scheme.lower() == "https" else 80)
    return f"{parsed.scheme.lower()}://{parsed.hostname.lower()}:{port}"


def _capture(page: Any, directory: Path, name: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    page.screenshot(path=str(path), full_page=False)
    return path


def _capture_prefix(step_index: int, action_index: int, action_id: str) -> str:
    safe_id = re.sub(r"[^A-Za-z0-9._-]+", "-", action_id).strip("-.") or "action"
    return f"{step_index:02d}_{action_index:02d}_{safe_id}"


def _timeout_ms(settings: Any) -> int:
    try:
        seconds = float(getattr(settings, "request_timeout_seconds", 8.0) or 8.0)
    except (TypeError, ValueError):
        seconds = 8.0
    return int(min(max(seconds, 1.0), 60.0) * 1000)


def _step_duration_seconds(step: TraceStep, durations: Mapping[str, float]) -> float:
    try:
        configured = float(durations.get(step.id, 0.0) or 0.0)
    except (TypeError, ValueError):
        configured = 0.0
    if configured > 0:
        return configured
    narration_length = len(step.narration.strip())
    return min(12.0, max(1.2, narration_length / 7.0))


def _as_replay_error(exc: Exception, *, step: TraceStep, action: TraceAction) -> TraceReplayError:
    if isinstance(exc, TraceReplayError):
        if exc.step_id and exc.action_id:
            return exc
        return TraceReplayError(exc.code, str(exc), step_id=step.id, action_id=action.id)
    return TraceReplayError(
        "replay_action_failed",
        f"{type(exc).__name__}: {exc}",
        step_id=step.id,
        action_id=action.id,
    )


def _request_value(request: Any, name: str, default: Any) -> Any:
    if isinstance(request, Mapping):
        return request.get(name, default)
    return getattr(request, name, default)


def _write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
