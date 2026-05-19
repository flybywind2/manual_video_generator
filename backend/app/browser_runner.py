from __future__ import annotations

from typing import Any, Callable


CaptureFunc = Callable[[Any, dict[str, Any], Any, Any], dict[str, Any]]
ReplayFunc = Callable[..., dict[str, Any]]


def run_capture(
    *,
    capture_browser: bool,
    request: Any,
    plan: dict[str, Any],
    dirs: Any,
    settings: Any,
    capture_func: CaptureFunc,
    placeholder_func: Callable[[Any, Any], dict[str, Any]],
    failure_fallback_func: Callable[[Any, Any, Exception], dict[str, Any]],
) -> tuple[dict[str, Any], str, str]:
    if capture_browser:
        try:
            capture_result = capture_func(request, plan, dirs, settings)
        except Exception as exc:  # noqa: BLE001 - browser startup/login failures should stay inspectable.
            capture_result = failure_fallback_func(request, dirs, exc)
        capture_status = str(capture_result.get("status") or "ok")
        capture_degrade_reason = str(capture_result.get("degrade_reason") or "")
        return capture_result, capture_status, capture_degrade_reason

    capture_result = placeholder_func(request, dirs)
    return capture_result, "degraded", "browser_capture_disabled"


def run_demonstration_replay(
    *,
    enabled: bool,
    request: Any,
    media_plan: dict[str, Any],
    capture_result: dict[str, Any],
    dirs: Any,
    settings: Any,
    tts_audio: list[Any],
    run_id: str,
    terminal: Any,
    replay_func: ReplayFunc,
    apply_replay_func: Callable[[dict[str, Any], dict[str, Any]], None],
    write_capture_log_func: Callable[[dict[str, Any]], None],
) -> dict[str, Any] | None:
    if not enabled:
        return None

    try:
        replay_result = replay_func(
            request,
            media_plan,
            capture_result.get("action_log", []),
            dirs,
            settings,
            tts_audio=tts_audio,
            storage_state=capture_result.get("storage_state"),
            run_id=run_id,
            terminal=terminal,
        )
    except Exception as exc:  # noqa: BLE001 - keep original demonstration package inspectable.
        replay_result = {
            "status": "degraded",
            "degrade_reason": "demonstration_replay_failed",
            "action_log": [
                {
                    "type": "demonstration_replay",
                    "status": "failed",
                    "error": f"{type(exc).__name__}: {exc}",
                }
            ],
        }

    apply_replay_func(capture_result, replay_result)
    write_capture_log_func(capture_result)
    return replay_result
