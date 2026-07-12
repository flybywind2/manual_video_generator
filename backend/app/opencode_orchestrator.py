from __future__ import annotations

import json
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

from backend.app.adapters.opencode_browser import OpenCodeBrowserDiscovery
from backend.app.adapters.tts import synthesize_tts
from backend.app.audit import AuditLog
from backend.app.browser_session import BrowserSessionManager
from backend.app.config import AppSettings, load_settings
from backend.app.discovery_evidence import validate_discovery_evidence
from backend.app.execution_trace import ExecutionTrace, ExecutionTracePolicy, validate_execution_trace
from backend.app.redaction import RedactionPipeline, redact_sensitive
from backend.app.terminal_logging import TerminalRunLogger
from backend.app.trace_replay import replay_execution_trace
from backend.app.workflow import WorkflowStatus, WorkflowStep
from backend.app.workflow_graph import WORKFLOW_GRAPH


@dataclass(frozen=True)
class OrchestratorServices:
    environment_fingerprint: Callable[[], dict[str, str]]
    browser_session_factory: Callable[[AppSettings], Any]
    discovery_factory: Callable[[AppSettings], Any]
    trace_validator: Callable[[Any, Any, ExecutionTracePolicy], ExecutionTrace]
    discovery_evidence_validator: Callable[..., Any]
    tts_synthesizer: Callable[..., Any]
    trace_replayer: Callable[..., Any]
    masker: Callable[..., Path]
    source_video_builder: Callable[..., Path]
    subtitle_renderer: Callable[..., Path]
    preview_renderer: Callable[..., Path]
    markdown_renderer: Callable[..., Path]
    pdf_renderer: Callable[..., Path]
    video_renderer: Callable[..., Any]


def production_services() -> OrchestratorServices:
    from backend.app.adapters.video import render_final_video
    from backend.app.env_bootstrap import runtime_fingerprint
    from backend.app.pipeline import (
        _mask_captures,
        _render_capture_slideshow_video,
        _render_markdown,
        _render_pdf_placeholder,
        _render_preview,
        _render_subtitles,
    )

    return OrchestratorServices(
        environment_fingerprint=runtime_fingerprint,
        browser_session_factory=BrowserSessionManager,
        discovery_factory=OpenCodeBrowserDiscovery,
        trace_validator=validate_execution_trace,
        discovery_evidence_validator=validate_discovery_evidence,
        tts_synthesizer=synthesize_tts,
        trace_replayer=replay_execution_trace,
        masker=_mask_captures,
        source_video_builder=_render_capture_slideshow_video,
        subtitle_renderer=_render_subtitles,
        preview_renderer=_render_preview,
        markdown_renderer=_render_markdown,
        pdf_renderer=_render_pdf_placeholder,
        video_renderer=render_final_video,
    )


class OpenCodeVideoOrchestrator:
    def __init__(
        self,
        *,
        settings: AppSettings | None = None,
        services: OrchestratorServices | None = None,
    ) -> None:
        self.settings = settings or load_settings()
        self.services = services or production_services()

    def create_draft(
        self,
        request: Any,
        *,
        base_dir: Path | None = None,
        capture_browser: bool = True,
    ) -> Any:
        from backend.app.pipeline import PipelineDraftResult, _make_dirs

        _validate_request(request)
        output_root = Path(base_dir) if base_dir else Path(self.settings.output_dir).resolve()
        job_id = _new_job_id()
        dirs = _make_dirs(output_root / "jobs" / job_id)
        environment = self.services.environment_fingerprint()
        audit = AuditLog(run_id=job_id, path=dirs.package / "audit_log.jsonl")
        audit.record(actor="environment", status="ok", output_data=environment)
        audit.record(actor="draft", status="ok", output_data={"planner": "opencode-pending"})
        _write_json(dirs.package / "request.json", redact_sensitive(request.model_dump()))
        _write_compatibility_prelude(dirs.package, request)
        plan = {
            "schema_version": "pending/1.0",
            "planner": "opencode-pending",
            "source": "request-review",
            "steps": [
                {
                    "id": "request-review",
                    "title": "요청 검수",
                    "caption": str(request.request_text),
                    "narration": str(request.request_text),
                }
            ],
            "actions": [],
        }
        approval = {
            "status": "awaiting-user-review",
            "gate": "request-review",
            "danger_actions": [],
        }
        rehearsal = {
            "status": "pending",
            "executed": False,
            "adapter": "opencode-playwright-mcp",
            "message": "OpenCode browser discovery starts after continue.",
        }
        _write_json(dirs.package / "action_plan.json", plan)
        _write_json(dirs.package / "approval_log.json", approval)
        _write_json(dirs.package / "rehearsal_log.json", rehearsal)
        _write_json(
            dirs.package / "playwright_mcp_calls.json",
            {"mode": "opencode-managed", "executed": False, "status": "pending"},
        )
        _write_workflow_state(
            dirs.package,
            status=WorkflowStatus.AWAITING_PLAN_REVIEW,
            current_step=WorkflowStep.PLAN_REVIEW,
            can_continue=True,
            request=request,
            environment=environment,
            details={
                "actor": "request_review",
                "message": "요청을 확인한 뒤 실행하세요. 실제 계획은 OpenCode 브라우저 탐색으로 생성됩니다.",
                "requested_capture_browser": capture_browser,
            },
        )
        _write_support_log(dirs.package, job_id=job_id, status=WorkflowStatus.AWAITING_PLAN_REVIEW)
        return PipelineDraftResult(
            job_id=job_id,
            status=WorkflowStatus.AWAITING_PLAN_REVIEW,
            current_step=WorkflowStep.PLAN_REVIEW,
            can_continue=True,
            execution_mode=str(getattr(request, "execution_mode", "ai") or "ai"),
            package_dir=dirs.package,
            plan=plan,
            rehearsal=rehearsal,
            approval=approval,
        )

    def continue_draft(
        self,
        job_id: str,
        *,
        base_dir: Path | None = None,
        capture_browser: bool | None = None,
    ) -> Any:
        from backend.app.pipeline import PipelineInput, _pipeline_result_from_manifest

        output_root = Path(base_dir) if base_dir else Path(self.settings.output_dir).resolve()
        jobs_root = (output_root / "jobs").resolve()
        package_dir = (jobs_root / job_id).resolve()
        try:
            package_dir.relative_to(jobs_root)
        except ValueError as exc:
            raise FileNotFoundError(f"invalid job id: {job_id}") from exc
        state_path = package_dir / "workflow_state.json"
        if not state_path.exists():
            raise FileNotFoundError(f"workflow draft not found: {job_id}")
        state = _read_json(state_path)
        if state.get("status") == WorkflowStatus.COMPLETED:
            manifest_path = package_dir / "package_manifest.json"
            if manifest_path.exists():
                return _pipeline_result_from_manifest(manifest_path)
            raise RuntimeError(f"workflow already completed but manifest is missing: {job_id}")
        if not state.get("can_continue"):
            raise RuntimeError(f"workflow cannot continue: {job_id}")
        request = PipelineInput.model_validate(state.get("request") or {})
        requested_capture = bool(state.get("capture_browser", True)) if capture_browser is None else capture_browser
        return self.run(
            request,
            base_dir=output_root,
            capture_browser=requested_capture,
            job_id=job_id,
            package_dir=package_dir,
            reset_audit=False,
        )

    def run(
        self,
        request: Any,
        *,
        base_dir: Path | None = None,
        capture_browser: bool = True,
        job_id: str | None = None,
        package_dir: Path | None = None,
        reset_audit: bool = True,
    ) -> Any:
        from backend.app.pipeline import ArtifactPaths, PipelineResult, _make_dirs

        _validate_request(request)
        output_root = Path(base_dir) if base_dir else Path(self.settings.output_dir).resolve()
        job_id = job_id or _new_job_id()
        package_dir = package_dir or (output_root / "jobs" / job_id)
        dirs = _make_dirs(Path(package_dir))
        audit = AuditLog(run_id=job_id, path=dirs.package / "audit_log.jsonl", reset=reset_audit)
        terminal = TerminalRunLogger(enabled=self.settings.enable_terminal_logs)
        environment: dict[str, str] = {}
        current_stage = "environment"
        trace: ExecutionTrace | None = None

        try:
            environment = self.services.environment_fingerprint()
            audit.record(actor="environment", status="ok", output_data=environment)
            _write_json(dirs.package / "request.json", redact_sensitive(request.model_dump()))
            _write_compatibility_prelude(dirs.package, request)
            _write_workflow_state(
                dirs.package,
                status=WorkflowStatus.RUNNING,
                current_step=WorkflowStep.BROWSER_SESSION,
                can_continue=False,
                request=request,
                environment=environment,
                details={
                    "actor": "browser_session",
                    "message": "Edge CDP 세션을 준비합니다.",
                    "requested_capture_browser": capture_browser,
                },
            )

            current_stage = "browser_session"
            with self.services.browser_session_factory(self.settings) as session:
                session_status = (
                    session.to_safe_dict() if callable(getattr(session, "to_safe_dict", None)) else {"owned": False}
                )
                audit.record(actor="browser_session", status="ok", output_data=session_status)

                current_stage = "opencode"
                _write_workflow_state(
                    dirs.package,
                    status=WorkflowStatus.RUNNING,
                    current_step=WorkflowStep.OPENCODE_DISCOVERY,
                    can_continue=False,
                    request=request,
                    environment=environment,
                    details={"actor": "opencode", "message": "OpenCode가 Playwright MCP로 화면을 탐색합니다."},
                )
                discovery = self.services.discovery_factory(self.settings).run(
                    request=request,
                    job_dir=dirs.package,
                    cdp_endpoint=session.cdp_endpoint,
                )
                audit.record(
                    actor="opencode",
                    status="ok",
                    output_data={"status": discovery.status},
                    artifacts=[
                        discovery.config_path,
                        discovery.prompt_path,
                        discovery.event_log_path,
                        discovery.trace_path,
                        discovery.metadata_path,
                    ],
                )

                current_stage = "trace_validation"
                _write_workflow_state(
                    dirs.package,
                    status=WorkflowStatus.RUNNING,
                    current_step=WorkflowStep.TRACE_VALIDATION,
                    can_continue=False,
                    request=request,
                    environment=environment,
                    details={"actor": "trace_validation", "message": "실행 trace의 안전성과 재현성을 검증합니다."},
                )
                trace = self.services.trace_validator(
                    discovery.trace,
                    request,
                    ExecutionTracePolicy(),
                )
                current_stage = "discovery_evidence"
                evidence_summary = self.services.discovery_evidence_validator(
                    trace,
                    event_log_path=discovery.event_log_path,
                    job_dir=dirs.package,
                )
                evidence_payload = (
                    evidence_summary.to_safe_dict()
                    if callable(getattr(evidence_summary, "to_safe_dict", None))
                    else dict(evidence_summary)
                )
                discovery_evidence_path = dirs.package / "discovery_evidence.json"
                _write_json(discovery_evidence_path, evidence_payload)
                audit.record(
                    actor="discovery_evidence",
                    status="ok",
                    output_data=evidence_payload,
                    artifacts=[discovery_evidence_path],
                )
                current_stage = "trace_validation"
                artifact_plan = _trace_action_plan(trace)
                action_plan_path = dirs.package / "action_plan.json"
                approval_log_path = dirs.package / "approval_log.json"
                _write_json(action_plan_path, artifact_plan)
                _write_json(
                    approval_log_path,
                    {
                        "status": "approved",
                        "gate": "validated-execution-trace",
                        "schema_version": trace.schema_version,
                        "danger_actions": [],
                    },
                )
                _write_discovery_compatibility_files(dirs.package, discovery)
                audit.record(
                    actor="trace_validation",
                    status="ok",
                    output_data={"steps": len(trace.steps), "evidence": evidence_payload},
                    artifacts=[
                        action_plan_path,
                        approval_log_path,
                        discovery.trace_path,
                        discovery_evidence_path,
                    ],
                )

                current_stage = "tts"
                _write_workflow_state(
                    dirs.package,
                    status=WorkflowStatus.RUNNING,
                    current_step=WorkflowStep.TTS,
                    can_continue=False,
                    request=request,
                    environment=environment,
                    details={"actor": "tts", "message": "Supertonic M1 한국어 내레이션을 생성합니다."},
                )
                discovery_media_plan = _trace_media_plan(trace)
                tts_result = self.services.tts_synthesizer(discovery_media_plan, self.settings, dirs.tts)
                step_durations = {
                    str(entry.get("step_id") or ""): float(entry.get("duration_seconds") or 0.0)
                    for entry in tts_result.entries
                    if entry.get("step_id")
                }
                audit.record(
                    actor="tts",
                    status="ok",
                    output_data=tts_result.entries,
                    artifacts=[tts_result.metadata_path, *tts_result.audio_paths],
                )

                current_stage = "replay"
                _write_workflow_state(
                    dirs.package,
                    status=WorkflowStatus.RUNNING,
                    current_step=WorkflowStep.REPLAY,
                    can_continue=False,
                    request=request,
                    environment=environment,
                    details={"actor": "replay", "message": "검증된 trace를 내레이션 시간에 맞춰 재실행합니다."},
                )
                replay = self.services.trace_replayer(
                    trace=trace,
                    request=request,
                    job_dir=dirs.package,
                    cdp_endpoint=session.cdp_endpoint,
                    settings=self.settings,
                    step_durations_seconds=step_durations,
                )
                capture_action_log = dirs.package / "capture_action_log.json"
                _write_json(capture_action_log, replay.action_log)
                audit.record(
                    actor="replay",
                    status="ok",
                    output_data={"captures": len(replay.captures)},
                    artifacts=[*replay.captures, replay.final_frame, capture_action_log, replay.selector_trace_path],
                )

            media_plan = dict(replay.media_plan)
            media_plan_path = dirs.package / "media_plan.json"
            _write_json(media_plan_path, media_plan)

            current_stage = "masking"
            _write_workflow_state(
                dirs.package,
                status=WorkflowStatus.RUNNING,
                current_step=WorkflowStep.MASKING,
                can_continue=False,
                request=request,
                environment=environment,
                details={"actor": "masking", "message": "캡처 이미지의 민감 영역을 마스킹합니다."},
            )
            masking_log_path = self.services.masker(replay.captures, dirs.masked, request.input_values)
            masked_paths = [dirs.masked / path.name for path in replay.captures]
            audit.record(
                actor="masking",
                status="ok",
                output_data={"captures": len(masked_paths)},
                artifacts=[masking_log_path, *masked_paths],
            )

            frame_durations = _frame_durations_for_media_plan(masked_paths, media_plan)
            source_video = self.services.source_video_builder(
                dirs.package,
                masked_paths,
                frame_durations_seconds=frame_durations,
            )
            redaction = RedactionPipeline(sensitive_values=request.input_values)
            subtitles_path = self.services.subtitle_renderer(media_plan, dirs.package, redaction=redaction)
            preview_path = self.services.preview_renderer(
                request,
                media_plan,
                dirs,
                [path.name for path in masked_paths],
                tts_result.audio_paths,
                source_video=source_video,
                subtitles_path=subtitles_path,
            )
            markdown_path = self.services.markdown_renderer(
                request,
                media_plan,
                dirs,
                [path.name for path in masked_paths],
                self.settings,
            )
            pdf_path = self.services.pdf_renderer(request, dirs)

            current_stage = "render"
            _write_workflow_state(
                dirs.package,
                status=WorkflowStatus.RUNNING,
                current_step=WorkflowStep.RENDER,
                can_continue=False,
                request=request,
                environment=environment,
                details={"actor": "render", "message": "자막과 음성을 포함한 최종 영상을 렌더링합니다."},
            )
            render = self.services.video_renderer(
                plan=media_plan,
                package_dir=dirs.package,
                preview_html=preview_path,
                fallback_video=source_video,
                settings=self.settings,
                tts_audio=tts_result.audio_paths,
            )
            if render.used_fallback and self.settings.video_renderer.lower() == "hyperframes":
                raise RuntimeError("HyperFrames returned a fallback video for a required render")
            audit.record(
                actor="render",
                status="ok",
                output_data={"video": str(render.video_path)},
                artifacts=[render.video_path, render.metadata_path, render.composition_dir / "index.html"],
            )

            support_log_path = _write_support_log(dirs.package, job_id=job_id, status="completed")
            manifest_path = dirs.package / "package_manifest.json"
            opencode_metadata = dirs.package / "opencode_agent.json"
            artifacts = ArtifactPaths(
                html_preview=preview_path,
                markdown_manual=markdown_path,
                pdf_manual=pdf_path,
                video=render.video_path,
                action_plan=dirs.package / "action_plan.json",
                approval_log=dirs.package / "approval_log.json",
                masking_log=masking_log_path,
                package_manifest=manifest_path,
                audit_log=audit.path,
                input_extraction=dirs.package / "input_extraction.json",
                final_frame=replay.final_frame,
                capture_action_log=dirs.package / "capture_action_log.json",
                selector_trace=replay.selector_trace_path,
                support_log=support_log_path,
                subtitles=subtitles_path,
                media_plan=media_plan_path,
                tts_audio=tts_result.audio_paths,
                tts_metadata=tts_result.metadata_path,
                video_render_metadata=render.metadata_path,
                skills_metadata=render.skills_metadata_path,
                opencode_metadata=opencode_metadata,
            )
            result = PipelineResult(
                job_id=job_id,
                status=WorkflowStatus.COMPLETED,
                package_dir=dirs.package,
                plan=_trace_action_plan(trace),
                rehearsal=_read_json(dirs.package / "rehearsal_log.json"),
                artifacts=artifacts,
            )
            current_stage = "manifest"
            audit.record(
                actor="manifest",
                status="ok",
                output_data={"status": WorkflowStatus.COMPLETED},
                artifacts=[manifest_path],
            )
            _write_json(
                manifest_path,
                _package_manifest(
                    result,
                    environment=environment,
                    degradations=audit.degradations(),
                    fallback_events=audit.fallback_events(),
                ),
            )
            _write_workflow_state(
                dirs.package,
                status=WorkflowStatus.COMPLETED,
                current_step=WorkflowStep.COMPLETED,
                can_continue=False,
                request=request,
                environment=environment,
                details={"actor": "pipeline", "message": "영상 매뉴얼 패키지 생성이 완료되었습니다."},
            )
            terminal.record(
                run_id=job_id,
                actor="pipeline",
                status=WorkflowStatus.COMPLETED,
                details={"package_dir": str(dirs.package), "video": str(render.video_path)},
                artifacts=[manifest_path, render.video_path],
            )
            return result
        except Exception as exc:
            try:
                audit.record(
                    actor=current_stage,
                    status="failed",
                    output_data={"error": f"{type(exc).__name__}: {exc}"},
                    details={"degraded": False},
                )
            except Exception:
                pass
            _write_workflow_state(
                dirs.package,
                status=WorkflowStatus.FAILED,
                current_step=WorkflowStep.EXECUTION_FAILED,
                can_continue=True,
                request=request,
                environment=environment,
                details={
                    "actor": current_stage,
                    "message": f"필수 단계 {current_stage} 실행에 실패했습니다.",
                    "degraded": False,
                },
                last_error=f"{type(exc).__name__}: {exc}",
            )
            _write_support_log(
                dirs.package,
                job_id=job_id,
                status="failed",
                stage=current_stage,
                error=f"{type(exc).__name__}: {exc}",
            )
            terminal.record(
                run_id=job_id,
                actor=current_stage,
                status="failed",
                details={"error": f"{type(exc).__name__}: {exc}", "degraded": False},
            )
            raise


def _validate_request(request: Any) -> None:
    for name in ("request_text", "target_url", "role", "completion_condition"):
        if not str(getattr(request, name, "") or "").strip():
            raise ValueError(f"pipeline request field is required: {name}")
    parsed = urlsplit(str(request.target_url))
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("target_url must be an absolute HTTP(S) URL")
    sensitive_markers = (
        "password",
        "passwd",
        "pwd",
        "secret",
        "token",
        "api_key",
        "apikey",
        "otp",
        "credential",
        "비밀번호",
        "암호",
        "인증번호",
    )
    for key in getattr(request, "input_values", {}) or {}:
        normalized = str(key).lower().replace("-", "_")
        if any(marker in normalized for marker in sensitive_markers):
            raise ValueError("credentials and secret values cannot be supplied in the pipeline request")


def _trace_media_plan(trace: ExecutionTrace) -> dict[str, Any]:
    return {
        "source": "opencode-execution-trace",
        "steps": [
            {
                "id": step.id,
                "title": step.title,
                "caption": step.narration,
                "narration": step.narration,
            }
            for step in trace.steps
        ],
        "actions": [
            {**action.model_dump(mode="json"), "step_id": step.id}
            for step in trace.steps
            for action in step.actions
        ],
    }


def _trace_action_plan(trace: ExecutionTrace) -> dict[str, Any]:
    return {
        **trace.model_dump(mode="json"),
        "planner": "opencode",
        "source": "opencode-playwright-mcp",
        "steps": [
            {
                **step.model_dump(mode="json"),
                "caption": step.narration,
            }
            for step in trace.steps
        ],
        "actions": [
            {**action.model_dump(mode="json"), "step_id": step.id}
            for step in trace.steps
            for action in step.actions
        ],
    }


def _frame_durations_for_media_plan(
    captures: list[Path],
    media_plan: Mapping[str, Any],
) -> dict[str, float]:
    durations: dict[str, float] = {}
    steps = media_plan.get("steps")
    if not isinstance(steps, list):
        return durations
    for step_index, step in enumerate(steps, start=1):
        if not isinstance(step, Mapping):
            continue
        step_captures = [
            capture
            for capture in captures
            if capture.name.startswith(f"{step_index:02d}_")
        ]
        if not step_captures:
            continue
        try:
            step_duration = float(step.get("duration_seconds") or 0.0)
        except (TypeError, ValueError):
            step_duration = 0.0
        if step_duration <= 0:
            continue
        frame_duration = step_duration / len(step_captures)
        for capture in step_captures:
            durations[capture.name] = frame_duration
    return durations


def _write_compatibility_prelude(package_dir: Path, request: Any) -> None:
    _write_json(
        package_dir / "input_extraction.json",
        {
            "status": "replaced",
            "source": "explicit-request-values",
            "replaced_by": "opencode-browser-discovery",
            "input_keys": sorted((getattr(request, "input_values", {}) or {}).keys()),
        },
    )
    _write_json(
        package_dir / "planner_trace.json",
        {"status": "replaced", "planner": "opencode", "replaced_by": "opencode-execution-trace"},
    )


def _write_discovery_compatibility_files(package_dir: Path, discovery: Any) -> None:
    shutil.copy2(discovery.prompt_path, package_dir / "opencode_prompt.md")
    shutil.copy2(discovery.metadata_path, package_dir / "opencode_agent.json")
    rehearsal = {
        "status": "executed",
        "executed": True,
        "adapter": "opencode-playwright-mcp",
        "execution_trace": str(discovery.trace_path),
        "event_log": str(discovery.event_log_path),
    }
    _write_json(package_dir / "rehearsal_log.json", rehearsal)
    _write_json(
        package_dir / "playwright_mcp_calls.json",
        {
            "mode": "opencode-managed",
            "executed": True,
            "config": str(discovery.config_path),
            "event_log": str(discovery.event_log_path),
        },
    )


def _package_manifest(
    result: Any,
    *,
    environment: dict[str, str],
    degradations: list[dict[str, str]],
    fallback_events: list[dict[str, Any]],
) -> dict[str, Any]:
    from backend.app.artifact_dependencies import build_artifact_dependencies

    package_dir = result.package_dir
    artifacts = result.artifacts
    render_metadata = _read_json(artifacts.video_render_metadata) if artifacts.video_render_metadata else {}
    return {
        "schema_version": "2.0",
        "pipeline": "opencode-only",
        "job_id": result.job_id,
        "status": result.status,
        "package_dir": str(package_dir),
        "environment": environment,
        "degradations": degradations,
        "fallback_events": fallback_events,
        "render_quality": render_metadata.get("quality") or {},
        "active_components": [
            "opencode",
            "playwright-mcp",
            "edge-cdp",
            "supertonic-m1",
            "trace-replay",
            "redaction",
            "hyperframes",
            "ffmpeg",
        ],
        "artifacts": {
            "html_preview": str(artifacts.html_preview),
            "markdown_manual": str(artifacts.markdown_manual),
            "pdf_manual": str(artifacts.pdf_manual),
            "video": str(artifacts.video),
            "action_plan": str(artifacts.action_plan),
            "approval_log": str(artifacts.approval_log),
            "masking_log": str(artifacts.masking_log),
            "package_manifest": str(artifacts.package_manifest),
            "audit_log": str(artifacts.audit_log),
            "input_extraction": str(artifacts.input_extraction),
            "final_frame": str(artifacts.final_frame) if artifacts.final_frame else None,
            "capture_action_log": str(artifacts.capture_action_log) if artifacts.capture_action_log else None,
            "selector_trace": str(artifacts.selector_trace) if artifacts.selector_trace else None,
            "support_log": str(artifacts.support_log) if artifacts.support_log else None,
            "subtitles": str(artifacts.subtitles) if artifacts.subtitles else None,
            "media_plan": str(artifacts.media_plan) if artifacts.media_plan else None,
            "tts_audio": [str(path) for path in artifacts.tts_audio],
            "tts_metadata": str(artifacts.tts_metadata) if artifacts.tts_metadata else None,
            "video_render": str(artifacts.video_render_metadata) if artifacts.video_render_metadata else None,
            "skills_metadata": str(artifacts.skills_metadata) if artifacts.skills_metadata else None,
            "opencode_metadata": str(artifacts.opencode_metadata) if artifacts.opencode_metadata else None,
        },
        "supporting_artifacts": {
            "request": str(package_dir / "request.json"),
            "input_extraction": str(package_dir / "input_extraction.json"),
            "planner_trace": str(package_dir / "planner_trace.json"),
            "rehearsal_log": str(package_dir / "rehearsal_log.json"),
            "playwright_mcp_calls": str(package_dir / "playwright_mcp_calls.json"),
            "audit_log": str(artifacts.audit_log),
            "capture_action_log": str(artifacts.capture_action_log),
            "selector_trace": str(artifacts.selector_trace),
            "support_log": str(artifacts.support_log),
            "subtitles": str(artifacts.subtitles),
            "media_plan": str(artifacts.media_plan),
            "tts_metadata": str(artifacts.tts_metadata),
            "video_render": str(artifacts.video_render_metadata),
            "skills_metadata": str(artifacts.skills_metadata),
            "opencode_prompt": str(package_dir / "opencode_prompt.md"),
            "opencode_metadata": str(artifacts.opencode_metadata),
            "opencode_config": str(package_dir / "opencode.json"),
            "opencode_browser_prompt": str(package_dir / "opencode_browser_prompt.md"),
            "opencode_events": str(package_dir / "opencode_events.jsonl"),
            "opencode_execution_trace": str(package_dir / "opencode_execution_trace.json"),
            "opencode_browser_metadata": str(package_dir / "opencode_browser_metadata.json"),
            "hyperframes_composition": str(package_dir / "hyperframes" / "index.html"),
            "hyperframes_manifest": str(package_dir / "hyperframes" / "hyperframes_manifest.json"),
        },
        "artifact_dependencies": build_artifact_dependencies(package_dir=package_dir, artifacts=artifacts),
    }


def _write_workflow_state(
    package_dir: Path,
    *,
    status: str,
    current_step: str,
    can_continue: bool,
    request: Any,
    environment: dict[str, str],
    details: dict[str, Any],
    last_error: str = "",
) -> None:
    node = WORKFLOW_GRAPH.node(current_step) if WORKFLOW_GRAPH.has_step(current_step) else None
    payload = {
        "status": status,
        "current_step": current_step,
        "workflow_node": (
            {
                "step": node.step,
                "actor": node.actor,
                "label": node.label,
                "next_steps": list(node.next_steps),
                "optional": node.optional,
            }
            if node
            else {"step": current_step, "actor": details.get("actor", "pipeline"), "label": current_step}
        ),
        "workflow_graph": WORKFLOW_GRAPH.metadata(),
        "can_continue": can_continue,
        "request": redact_sensitive(request.model_dump()),
        "capture_browser": True,
        "environment": environment,
        "updated_at": datetime.now().isoformat(timespec="seconds"),
        "details": details,
        "last_error": last_error,
    }
    _write_json(package_dir / "workflow_state.json", payload)


def _write_support_log(
    package_dir: Path,
    *,
    job_id: str,
    status: str,
    stage: str = "",
    error: str = "",
) -> Path:
    path = package_dir / "support_log.md"
    lines = [
        "# Manual Video Agent Support",
        "",
        f"- Job: `{job_id}`",
        f"- Status: `{status}`",
        f"- Pipeline: `opencode-only`",
    ]
    if stage:
        lines.append(f"- Stage: `{stage}`")
    if error:
        lines.extend([f"- Error: `{error}`", "", "`workflow_state.json`과 `audit_log.jsonl`을 확인하세요."])
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def _new_job_id() -> str:
    return f"job_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"


def _write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def _read_json(path: Path | None) -> dict[str, Any]:
    if path is None or not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}
