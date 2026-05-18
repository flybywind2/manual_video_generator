from __future__ import annotations

import base64
import json
import os
import re
import shutil
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from backend.app.adapters.browser_agent import decide_browser_agent_action
from backend.app.adapters.input_extractor import extract_input_values
from backend.app.adapters.opencode import run_opencode_agent
from backend.app.adapters.planner import build_plan
from backend.app.adapters.rehearsal import rehearse_plan
from backend.app.adapters.tts import synthesize_tts
from backend.app.adapters.video import render_final_video
from backend.app.audit import AuditLog
from backend.app.config import load_settings
from backend.app.env_bootstrap import apply_runtime_environment, runtime_fingerprint
from backend.app.policies import ApprovalGate
from backend.app.redaction import redact_sensitive
from backend.app.terminal_logging import TerminalRunLogger


class PipelineInput(BaseModel):
    request_text: str
    target_url: str
    role: str
    completion_condition: str
    input_values: dict[str, str] = Field(default_factory=dict)
    login_mode: str = ""
    login_success_selector: str = ""


class ArtifactPaths(BaseModel):
    html_preview: Path
    markdown_manual: Path
    pdf_manual: Path
    video: Path
    action_plan: Path
    approval_log: Path
    masking_log: Path
    package_manifest: Path
    audit_log: Path
    input_extraction: Path
    final_frame: Path | None = None
    capture_action_log: Path | None = None
    tts_audio: list[Path] = Field(default_factory=list)
    tts_metadata: Path | None = None
    video_render_metadata: Path | None = None
    skills_metadata: Path | None = None
    opencode_metadata: Path | None = None

    model_config = {"arbitrary_types_allowed": True}


class PipelineResult(BaseModel):
    job_id: str
    status: str
    package_dir: Path
    plan: dict[str, Any]
    rehearsal: dict[str, Any]
    artifacts: ArtifactPaths

    model_config = {"arbitrary_types_allowed": True}


class PipelineDraftResult(BaseModel):
    job_id: str
    status: str
    current_step: str
    can_continue: bool
    package_dir: Path
    plan: dict[str, Any]
    rehearsal: dict[str, Any]
    approval: dict[str, Any]

    model_config = {"arbitrary_types_allowed": True}


@dataclass(frozen=True)
class PipelineDirs:
    package: Path
    captures: Path
    masked: Path
    tts: Path
    raw_video: Path


def default_output_dir() -> Path:
    return Path(os.environ.get("MANUAL_AGENT_OUTPUT_DIR", "output")).resolve()


def _record_stage(
    audit: AuditLog,
    terminal: TerminalRunLogger,
    *,
    terminal_details: dict[str, Any] | None = None,
    **event: Any,
) -> dict[str, Any]:
    audit_event = audit.record(**event)
    terminal.record_audit_event(audit_event, details=terminal_details)
    return audit_event


def _record_tool(
    audit: AuditLog,
    terminal: TerminalRunLogger,
    *,
    tool: str,
    status: str,
    details: dict[str, Any] | None = None,
    degrade_reason: str = "",
) -> dict[str, Any]:
    event_details = {"component": "runtime", "tool": tool}
    event_details.update(details or {})
    return _record_stage(
        audit,
        terminal,
        actor="tool",
        step_id=tool,
        status=status,
        degrade_reason=degrade_reason,
        details=event_details,
        terminal_details=event_details,
    )


def _enabled_tool_status(enabled: bool, configured: bool) -> str:
    if not enabled:
        return "disabled"
    return "configured" if configured else "missing"


def _record_runtime_tool_inventory(
    audit: AuditLog,
    terminal: TerminalRunLogger,
    *,
    settings: Any,
    environment: dict[str, str],
    capture_browser: bool,
) -> None:
    _record_tool(
        audit,
        terminal,
        tool="llm",
        status="configured" if settings.llm.is_configured else "missing",
        details={
            "model": settings.llm.model,
            "base_url_set": bool(settings.llm.base_url),
            "api_key_set": bool(settings.llm.api_key),
            "input_extractor_enabled": settings.enable_input_extractor,
            "internal_planner_enabled": settings.enable_internal_planner,
            "browser_agent_enabled": settings.enable_browser_agent,
        },
    )
    _record_tool(
        audit,
        terminal,
        tool="rag",
        status=_enabled_tool_status(settings.enable_rag_context, settings.rag.is_configured),
        details={
            "enabled": settings.enable_rag_context,
            "retrieve_url_set": bool(settings.rag.retrieve_url),
            "index_name": settings.rag.index_name,
            "permission_group_count": len(settings.rag.permission_groups),
        },
    )
    _record_tool(
        audit,
        terminal,
        tool="reranker",
        status=_enabled_tool_status(settings.enable_reranker, settings.reranker.is_configured),
        details={
            "enabled": settings.enable_reranker,
            "url_set": bool(settings.reranker.url),
            "model": settings.reranker.model,
        },
    )
    _record_tool(
        audit,
        terminal,
        tool="playwright-python",
        status="enabled" if capture_browser else "skipped",
        details={
            "capture_browser": capture_browser,
            "browser_agent_enabled": settings.enable_browser_agent,
            "executable_path_set": bool(settings.playwright_executable_path),
            "playwright_browsers_path_set": bool(environment.get("playwright_browsers_path")),
        },
    )
    _record_tool(
        audit,
        terminal,
        tool="playwright-mcp",
        status=settings.playwright_mcp_mode.lower(),
        details={
            "mode": settings.playwright_mcp_mode,
            "command_set": bool(settings.playwright_mcp_command),
            "request_timeout_seconds": settings.request_timeout_seconds,
        },
    )
    _record_tool(
        audit,
        terminal,
        tool="ffmpeg",
        status=_tool_status_from_version(environment.get("ffmpeg_version", "")),
        details={"version": environment.get("ffmpeg_version", "")},
    )
    _record_tool(
        audit,
        terminal,
        tool="node",
        status=_tool_status_from_version(environment.get("node_version", "")),
        details={"version": environment.get("node_version", "")},
    )
    _record_tool(
        audit,
        terminal,
        tool="npm",
        status=_tool_status_from_version(environment.get("npm_version", "")),
        details={"version": environment.get("npm_version", "")},
    )
    _record_tool(
        audit,
        terminal,
        tool="tts",
        status=settings.tts_provider.lower(),
        details={
            "provider": settings.tts_provider,
            "device": settings.tts_device,
            "language": settings.tts_language,
            "speaker": settings.tts_speaker,
        },
    )
    _record_tool(
        audit,
        terminal,
        tool="hyperframes",
        status="enabled" if settings.video_renderer.lower() == "hyperframes" else "skipped",
        details={
            "renderer": settings.video_renderer,
            "command_set": bool(settings.hyperframes_command),
            "skills_enabled": settings.enable_hyperframes_skills,
            "skills_command_set": bool(settings.hyperframes_skills_command),
        },
    )
    _record_tool(
        audit,
        terminal,
        tool="opencode",
        status="enabled" if settings.enable_opencode else "disabled",
        details={
            "command_set": bool(settings.opencode_command),
            "agent_set": bool(settings.opencode_agent),
            "model_set": bool(settings.opencode_model),
            "timeout_seconds": settings.opencode_timeout_seconds,
        },
    )


def _tool_status_from_version(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"", "missing", "error", "unknown"}:
        return normalized or "missing"
    return "available"


def _pipeline_start_details(settings: Any, output_root: Path, capture_browser: bool) -> dict[str, Any]:
    return {
        "output_dir": str(output_root),
        "capture_browser": capture_browser,
        "planner": "internal" if settings.enable_internal_planner else "local-deterministic",
        "input_extractor_enabled": settings.enable_input_extractor,
        "rag_context_enabled": settings.enable_rag_context,
        "reranker_enabled": settings.enable_reranker,
        "browser_agent_enabled": settings.enable_browser_agent,
        "browser_agent_max_steps": settings.browser_agent_max_steps,
        "playwright_mcp_mode": settings.playwright_mcp_mode,
        "playwright_mcp_command_set": bool(settings.playwright_mcp_command),
        "playwright_executable_path_set": bool(settings.playwright_executable_path),
        "login_mode": settings.login.mode,
        "tts_provider": settings.tts_provider,
        "tts_device": settings.tts_device,
        "video_renderer": settings.video_renderer,
        "hyperframes_command_set": bool(settings.hyperframes_command),
        "hyperframes_skills_enabled": settings.enable_hyperframes_skills,
        "opencode_enabled": settings.enable_opencode,
        "request_timeout_seconds": settings.request_timeout_seconds,
    }


def _environment_terminal_details(environment: dict[str, str]) -> dict[str, Any]:
    return {
        "python_version": environment.get("python_version", ""),
        "node_version": environment.get("node_version", ""),
        "npm_version": environment.get("npm_version", ""),
        "ffmpeg_version": environment.get("ffmpeg_version", ""),
        "playwright_browsers_path_set": bool(environment.get("playwright_browsers_path")),
        "hf_home_set": bool(environment.get("hf_home")),
        "npm_config_cache_set": bool(environment.get("npm_config_cache")),
        "requests_ca_bundle_set": environment.get("requests_ca_bundle_set", "false"),
        "node_extra_ca_certs_set": environment.get("node_extra_ca_certs_set", "false"),
    }


def run_pipeline(
    request: PipelineInput,
    *,
    base_dir: Path | None = None,
    capture_browser: bool = True,
) -> PipelineResult:
    apply_runtime_environment()
    settings = load_settings()
    output_root = Path(base_dir) if base_dir else Path(settings.output_dir).resolve()
    job_id = f"job_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
    dirs = _make_dirs(output_root / "jobs" / job_id)
    audit = AuditLog(run_id=job_id, path=dirs.package / "audit_log.jsonl")
    terminal = TerminalRunLogger(enabled=settings.enable_terminal_logs)
    terminal.record(
        run_id=job_id,
        actor="pipeline",
        status="started",
        details=_pipeline_start_details(settings, output_root, capture_browser),
    )
    terminal.record(run_id=job_id, actor="environment", status="started")
    environment = runtime_fingerprint()
    _record_stage(
        audit,
        terminal,
        actor="environment",
        status="ok",
        output_data=environment,
        terminal_details=_environment_terminal_details(environment),
    )
    _record_runtime_tool_inventory(audit, terminal, settings=settings, environment=environment, capture_browser=capture_browser)
    original_request_payload = redact_sensitive(request.model_dump())

    terminal.record(
        run_id=job_id,
        actor="input_extractor",
        status="started",
        details={
            "enabled": settings.enable_input_extractor,
            "llm_configured": settings.llm.is_configured,
            "explicit_input_count": len(request.input_values),
        },
    )
    input_extraction = extract_input_values(request, settings, package_dir=dirs.package)
    effective_request = request.model_copy(update={"input_values": input_extraction["effective_input_values"]})
    request_payload = redact_sensitive(effective_request.model_dump())
    _record_stage(
        audit,
        terminal,
        actor="input_extractor",
        status="degraded" if input_extraction.get("status") == "degraded" else str(input_extraction.get("status") or "ok"),
        input_data=original_request_payload,
        output_data=redact_sensitive(input_extraction),
        degrade_reason="input_extractor_fallback" if input_extraction.get("status") == "degraded" else "",
        artifacts=[dirs.package / "input_extraction.json"],
        terminal_details={
            "enabled": settings.enable_input_extractor,
            "source": input_extraction.get("source", ""),
            "extracted_count": input_extraction.get("extracted_count", 0),
            "effective_count": input_extraction.get("effective_count", 0),
        },
    )

    terminal.record(
        run_id=job_id,
        actor="planner",
        status="started",
        details={
            "internal_planner_enabled": settings.enable_internal_planner,
            "rag_context_enabled": settings.enable_rag_context,
            "reranker_enabled": settings.enable_reranker,
        },
    )
    plan = build_plan(effective_request, settings, package_dir=dirs.package)
    artifact_plan = redact_sensitive(plan)
    _record_stage(
        audit,
        terminal,
        actor="planner",
        status=_planner_audit_status(plan),
        input_data=request_payload,
        output_data=artifact_plan,
        degrade_reason=_planner_degrade_reason(plan),
        artifacts=[dirs.package / "planner_trace.json"],
        terminal_details={
            "planner": str(plan.get("planner") or ""),
            "internal_planner_enabled": settings.enable_internal_planner,
            "rag_context_enabled": settings.enable_rag_context,
            "reranker_enabled": settings.enable_reranker,
            "action_count": len(plan.get("actions") or []),
            "step_count": len(plan.get("steps") or []),
        },
    )
    terminal.record(
        run_id=job_id,
        actor="rehearsal",
        status="started",
        details={
            "playwright_mcp_mode": settings.playwright_mcp_mode,
            "playwright_mcp_command_set": bool(settings.playwright_mcp_command),
        },
    )
    rehearsal = rehearse_plan(plan, settings, dirs.package)
    artifact_rehearsal = redact_sensitive(rehearsal)
    _record_stage(
        audit,
        terminal,
        actor="rehearsal",
        status=_rehearsal_audit_status(rehearsal),
        input_data=artifact_plan,
        output_data=artifact_rehearsal,
        degrade_reason=_rehearsal_degrade_reason(rehearsal),
        artifacts=[dirs.package / "playwright_mcp_calls.json"],
        terminal_details={
            "playwright_mcp_mode": settings.playwright_mcp_mode,
            "playwright_mcp_command_set": bool(settings.playwright_mcp_command),
        },
    )
    _write_json(dirs.package / "request.json", request_payload)
    action_plan_path = dirs.package / "action_plan.json"
    approval_log_path = dirs.package / "approval_log.json"
    terminal.record(run_id=job_id, actor="approval", status="started", details={"policy_mode": "sample-mvp"})
    approval = ApprovalGate(mode="sample-mvp").approve(plan)
    _write_json(action_plan_path, artifact_plan)
    _write_json(approval_log_path, approval)
    _record_stage(
        audit,
        terminal,
        actor="approval",
        status="ok",
        input_data=artifact_plan.get("actions", []),
        output_data=approval,
        artifacts=[approval_log_path],
        details={"danger_actions": len(approval["danger_actions"])},
        terminal_details={
            "policy_mode": "sample-mvp",
            "danger_actions": len(approval["danger_actions"]),
        },
    )
    _write_json(dirs.package / "rehearsal_log.json", artifact_rehearsal)

    return _complete_pipeline_execution(
        job_id=job_id,
        effective_request=effective_request,
        plan=plan,
        artifact_plan=artifact_plan,
        artifact_rehearsal=artifact_rehearsal,
        settings=settings,
        dirs=dirs,
        audit=audit,
        terminal=terminal,
        environment=environment,
        capture_browser=capture_browser,
        action_plan_path=action_plan_path,
        approval_log_path=approval_log_path,
    )


def create_pipeline_draft(
    request: PipelineInput,
    *,
    base_dir: Path | None = None,
    capture_browser: bool = True,
) -> PipelineDraftResult:
    apply_runtime_environment()
    settings = load_settings()
    output_root = Path(base_dir) if base_dir else Path(settings.output_dir).resolve()
    job_id = f"job_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
    dirs = _make_dirs(output_root / "jobs" / job_id)
    audit = AuditLog(run_id=job_id, path=dirs.package / "audit_log.jsonl")
    terminal = TerminalRunLogger(enabled=settings.enable_terminal_logs)
    terminal.record(
        run_id=job_id,
        actor="pipeline",
        status="draft-started",
        details=_pipeline_start_details(settings, output_root, capture_browser),
    )
    terminal.record(run_id=job_id, actor="environment", status="started")
    environment = runtime_fingerprint()
    _record_stage(
        audit,
        terminal,
        actor="environment",
        status="ok",
        output_data=environment,
        terminal_details=_environment_terminal_details(environment),
    )
    _record_runtime_tool_inventory(audit, terminal, settings=settings, environment=environment, capture_browser=capture_browser)
    original_request_payload = redact_sensitive(request.model_dump())

    terminal.record(
        run_id=job_id,
        actor="input_extractor",
        status="started",
        details={
            "enabled": settings.enable_input_extractor,
            "llm_configured": settings.llm.is_configured,
            "explicit_input_count": len(request.input_values),
        },
    )
    input_extraction = extract_input_values(request, settings, package_dir=dirs.package)
    effective_request = request.model_copy(update={"input_values": input_extraction["effective_input_values"]})
    request_payload = redact_sensitive(effective_request.model_dump())
    _record_stage(
        audit,
        terminal,
        actor="input_extractor",
        status="degraded" if input_extraction.get("status") == "degraded" else str(input_extraction.get("status") or "ok"),
        input_data=original_request_payload,
        output_data=redact_sensitive(input_extraction),
        degrade_reason="input_extractor_fallback" if input_extraction.get("status") == "degraded" else "",
        artifacts=[dirs.package / "input_extraction.json"],
        terminal_details={
            "enabled": settings.enable_input_extractor,
            "source": input_extraction.get("source", ""),
            "extracted_count": input_extraction.get("extracted_count", 0),
            "effective_count": input_extraction.get("effective_count", 0),
        },
    )

    terminal.record(
        run_id=job_id,
        actor="planner",
        status="started",
        details={
            "internal_planner_enabled": settings.enable_internal_planner,
            "rag_context_enabled": settings.enable_rag_context,
            "reranker_enabled": settings.enable_reranker,
        },
    )
    plan = build_plan(effective_request, settings, package_dir=dirs.package)
    artifact_plan = redact_sensitive(plan)
    _record_stage(
        audit,
        terminal,
        actor="planner",
        status=_planner_audit_status(plan),
        input_data=request_payload,
        output_data=artifact_plan,
        degrade_reason=_planner_degrade_reason(plan),
        artifacts=[dirs.package / "planner_trace.json"],
        terminal_details={
            "planner": str(plan.get("planner") or ""),
            "internal_planner_enabled": settings.enable_internal_planner,
            "rag_context_enabled": settings.enable_rag_context,
            "reranker_enabled": settings.enable_reranker,
            "action_count": len(plan.get("actions") or []),
            "step_count": len(plan.get("steps") or []),
        },
    )
    terminal.record(
        run_id=job_id,
        actor="rehearsal",
        status="started",
        details={
            "playwright_mcp_mode": settings.playwright_mcp_mode,
            "playwright_mcp_command_set": bool(settings.playwright_mcp_command),
        },
    )
    rehearsal = rehearse_plan(plan, settings, dirs.package)
    artifact_rehearsal = redact_sensitive(rehearsal)
    _record_stage(
        audit,
        terminal,
        actor="rehearsal",
        status=_rehearsal_audit_status(rehearsal),
        input_data=artifact_plan,
        output_data=artifact_rehearsal,
        degrade_reason=_rehearsal_degrade_reason(rehearsal),
        artifacts=[dirs.package / "playwright_mcp_calls.json"],
        terminal_details={
            "playwright_mcp_mode": settings.playwright_mcp_mode,
            "playwright_mcp_command_set": bool(settings.playwright_mcp_command),
        },
    )
    _write_json(dirs.package / "request.json", request_payload)
    action_plan_path = dirs.package / "action_plan.json"
    approval_log_path = dirs.package / "approval_log.json"
    terminal.record(run_id=job_id, actor="approval", status="started", details={"policy_mode": "sample-mvp"})
    approval = ApprovalGate(mode="sample-mvp").approve(plan)
    _write_json(action_plan_path, artifact_plan)
    _write_json(approval_log_path, approval)
    _record_stage(
        audit,
        terminal,
        actor="approval",
        status="ok",
        input_data=artifact_plan.get("actions", []),
        output_data=approval,
        artifacts=[approval_log_path],
        details={"danger_actions": len(approval["danger_actions"])},
        terminal_details={
            "policy_mode": "sample-mvp",
            "danger_actions": len(approval["danger_actions"]),
        },
    )
    _write_json(dirs.package / "rehearsal_log.json", artifact_rehearsal)
    _write_json(
        dirs.package / "workflow_state.json",
        {
            "status": "awaiting_plan_review",
            "current_step": "plan_review",
            "can_continue": True,
            "request": request_payload,
            "capture_browser": capture_browser,
            "environment": environment,
        },
    )
    terminal.record(
        run_id=job_id,
        actor="pipeline",
        status="awaiting_plan_review",
        details={"package_dir": str(dirs.package), "action_count": len(artifact_plan.get("actions") or [])},
        artifacts=[action_plan_path, approval_log_path, dirs.package / "rehearsal_log.json"],
    )
    return PipelineDraftResult(
        job_id=job_id,
        status="awaiting_plan_review",
        current_step="plan_review",
        can_continue=True,
        package_dir=dirs.package,
        plan=artifact_plan,
        rehearsal=artifact_rehearsal,
        approval=approval,
    )


def continue_pipeline_draft(
    job_id: str,
    *,
    base_dir: Path | None = None,
    capture_browser: bool | None = None,
) -> PipelineResult:
    apply_runtime_environment()
    settings = load_settings()
    output_root = Path(base_dir) if base_dir else Path(settings.output_dir).resolve()
    package_dir = (output_root / "jobs" / job_id).resolve()
    try:
        package_dir.relative_to((output_root / "jobs").resolve())
    except ValueError as exc:
        raise FileNotFoundError(f"invalid job id: {job_id}") from exc
    state_path = package_dir / "workflow_state.json"
    if not state_path.exists():
        raise FileNotFoundError(f"workflow draft not found: {job_id}")
    state = json.loads(state_path.read_text(encoding="utf-8"))
    if state.get("status") == "completed":
        manifest_path = package_dir / "package_manifest.json"
        if manifest_path.exists():
            return _pipeline_result_from_manifest(manifest_path)
        raise RuntimeError(f"workflow already completed but manifest is missing: {job_id}")
    if not state.get("can_continue"):
        raise RuntimeError(f"workflow cannot continue: {job_id}")

    dirs = _dirs_from_package(package_dir)
    effective_request = PipelineInput(**state["request"])
    plan = json.loads((package_dir / "action_plan.json").read_text(encoding="utf-8"))
    rehearsal = json.loads((package_dir / "rehearsal_log.json").read_text(encoding="utf-8"))
    audit = AuditLog(run_id=job_id, path=package_dir / "audit_log.jsonl", reset=False)
    terminal = TerminalRunLogger(enabled=settings.enable_terminal_logs)
    terminal.record(run_id=job_id, actor="pipeline", status="continue-started", details={"package_dir": str(package_dir)})
    _write_json(
        state_path,
        {
            **state,
            "status": "running",
            "current_step": "capture",
            "can_continue": False,
        },
    )
    return _complete_pipeline_execution(
        job_id=job_id,
        effective_request=effective_request,
        plan=plan,
        artifact_plan=plan,
        artifact_rehearsal=rehearsal,
        settings=settings,
        dirs=dirs,
        audit=audit,
        terminal=terminal,
        environment=state.get("environment") or runtime_fingerprint(),
        capture_browser=bool(state.get("capture_browser", True)) if capture_browser is None else capture_browser,
        action_plan_path=package_dir / "action_plan.json",
        approval_log_path=package_dir / "approval_log.json",
    )


def _complete_pipeline_execution(
    *,
    job_id: str,
    effective_request: PipelineInput,
    plan: dict[str, Any],
    artifact_plan: dict[str, Any],
    artifact_rehearsal: dict[str, Any],
    settings: Any,
    dirs: PipelineDirs,
    audit: AuditLog,
    terminal: TerminalRunLogger,
    environment: dict[str, str],
    capture_browser: bool,
    action_plan_path: Path,
    approval_log_path: Path,
) -> PipelineResult:
    terminal.record(
        run_id=job_id,
        actor="capture",
        status="started",
        details={
            "mode": "browser" if capture_browser else "placeholder",
            "browser_agent_enabled": settings.enable_browser_agent,
        },
    )
    if capture_browser:
        try:
            capture_result = _capture_with_playwright(effective_request, plan, dirs, settings)
        except Exception as exc:  # noqa: BLE001 - keep the package inspectable when browser startup/login fails.
            capture_result = _create_capture_failure_fallback(effective_request, dirs, exc)
        capture_status = str(capture_result.get("status") or "ok")
        capture_degrade_reason = str(capture_result.get("degrade_reason") or "")
    else:
        capture_result = _create_placeholder_captures(effective_request, dirs)
        capture_status = "degraded"
        capture_degrade_reason = "browser_capture_disabled"
    _record_stage(
        audit,
        terminal,
        actor="capture",
        status=capture_status,
        input_data={"capture_browser": capture_browser, "target_url": effective_request.target_url},
        output_data={
            "captures": capture_result["masked_names"],
            "video": str(capture_result["video"]),
            "action_log": redact_sensitive(capture_result.get("action_log", [])),
        },
        degrade_reason=capture_degrade_reason,
        artifacts=[*capture_result["captures"], capture_result["video"], capture_result.get("action_log_path")],
        terminal_details={
            "mode": "browser" if capture_browser else "placeholder",
            "browser_agent_enabled": settings.enable_browser_agent,
            "capture_count": len(capture_result.get("captures") or []),
            "action_count": len(capture_result.get("action_log") or []),
        },
    )

    terminal.record(
        run_id=job_id,
        actor="masking",
        status="started",
        details={"capture_count": len(capture_result["captures"])},
    )
    masking_log_path = _mask_captures(capture_result["captures"], dirs.masked, effective_request.input_values)
    _record_stage(
        audit,
        terminal,
        actor="masking",
        status="ok",
        input_data=capture_result["masked_names"],
        artifacts=[masking_log_path],
        terminal_details={
            "capture_count": len(capture_result.get("captures") or []),
            "input_value_count": len(effective_request.input_values),
        },
    )
    terminal.record(
        run_id=job_id,
        actor="tts",
        status="started",
        details={
            "provider": settings.tts_provider,
            "device": settings.tts_device,
            "language": settings.tts_language,
        },
    )
    tts_result = synthesize_tts(plan, settings, dirs.tts)
    tts_degrade_reason = _tts_degrade_reason(tts_result.entries)
    _record_stage(
        audit,
        terminal,
        actor="tts",
        status="degraded" if tts_degrade_reason else "ok",
        input_data=plan.get("steps", []),
        output_data=tts_result.entries,
        degrade_reason=tts_degrade_reason,
        artifacts=[tts_result.metadata_path, *tts_result.audio_paths],
        terminal_details={
            "provider": settings.tts_provider,
            "device": settings.tts_device,
            "language": settings.tts_language,
            "audio_count": len(tts_result.audio_paths),
        },
    )
    html_path = _render_preview(effective_request, plan, dirs, capture_result["masked_names"], tts_result.audio_paths)
    markdown_path = _render_markdown(effective_request, plan, dirs, capture_result["masked_names"])
    pdf_path = _render_pdf_placeholder(effective_request, dirs)
    video_path = capture_result["video"]
    if not video_path.exists():
        video_path = _render_placeholder_video(dirs.package)
    terminal.record(
        run_id=job_id,
        actor="render",
        status="started",
        details={
            "renderer": settings.video_renderer,
            "hyperframes_command_set": bool(settings.hyperframes_command),
            "hyperframes_skills_enabled": settings.enable_hyperframes_skills,
        },
    )
    video_render = render_final_video(
        plan=plan,
        package_dir=dirs.package,
        preview_html=html_path,
        fallback_video=video_path,
        settings=settings,
    )
    render_degrade_reason = _render_degrade_reason(video_render.used_fallback, settings.video_renderer)
    _record_stage(
        audit,
        terminal,
        actor="render",
        status="degraded" if render_degrade_reason else "ok",
        input_data={"renderer": settings.video_renderer},
        output_data={"video": str(video_render.video_path)},
        degrade_reason=render_degrade_reason,
        artifacts=[video_render.metadata_path, video_render.video_path, video_render.composition_dir / "index.html"],
        terminal_details={
            "renderer": settings.video_renderer,
            "used_fallback": video_render.used_fallback,
            "video_name": video_render.video_path.name,
        },
    )
    terminal.record(
        run_id=job_id,
        actor="opencode",
        status="started",
        details={
            "enabled": settings.enable_opencode,
            "agent_set": bool(settings.opencode_agent),
            "model_set": bool(settings.opencode_model),
        },
    )
    opencode_result = run_opencode_agent(plan=plan, package_dir=dirs.package, settings=settings)
    _record_stage(
        audit,
        terminal,
        actor="opencode",
        status=_opencode_audit_status(opencode_result),
        input_data={"enabled": settings.enable_opencode},
        output_data={"metadata_path": str(opencode_result.metadata_path)},
        degrade_reason=_opencode_degrade_reason(opencode_result),
        artifacts=[opencode_result.prompt_path, opencode_result.metadata_path],
        terminal_details={
            "enabled": settings.enable_opencode,
            "agent_set": bool(settings.opencode_agent),
            "model_set": bool(settings.opencode_model),
        },
    )

    manifest_path = dirs.package / "package_manifest.json"
    artifacts = ArtifactPaths(
        html_preview=html_path,
        markdown_manual=markdown_path,
        pdf_manual=pdf_path,
        video=video_render.video_path,
        action_plan=action_plan_path,
        approval_log=approval_log_path,
        masking_log=masking_log_path,
        package_manifest=manifest_path,
        audit_log=audit.path,
        input_extraction=dirs.package / "input_extraction.json",
        final_frame=capture_result.get("final_frame"),
        capture_action_log=capture_result.get("action_log_path"),
        tts_audio=tts_result.audio_paths,
        tts_metadata=tts_result.metadata_path,
        video_render_metadata=video_render.metadata_path,
        skills_metadata=video_render.skills_metadata_path,
        opencode_metadata=opencode_result.metadata_path,
    )
    result = PipelineResult(
        job_id=job_id,
        status="completed",
        package_dir=dirs.package,
        plan=artifact_plan,
        rehearsal=artifact_rehearsal,
        artifacts=artifacts,
    )
    terminal.record(run_id=job_id, actor="manifest", status="started")
    _record_stage(audit, terminal, actor="manifest", status="ok", artifacts=[manifest_path])
    _write_json(manifest_path, _manifest(result, degradations=audit.degradations(), environment=environment))
    terminal.record(
        run_id=job_id,
        actor="pipeline",
        status="completed",
        details={
            "package_dir": str(dirs.package),
            "degradation_count": len(audit.degradations()),
            "video_name": video_render.video_path.name,
        },
        artifacts=[manifest_path, video_render.video_path],
    )
    _write_json(
        dirs.package / "workflow_state.json",
        {
            "status": "completed",
            "current_step": "completed",
            "can_continue": False,
            "request": redact_sensitive(effective_request.model_dump()),
            "capture_browser": capture_browser,
        },
    )
    return result


def artifact_response(result: PipelineResult) -> dict[str, Any]:
    rel_base = f"/artifacts/jobs/{result.job_id}"
    video_name = result.artifacts.video.name
    mcp_execution = result.package_dir / "playwright_mcp_execution.json"
    return {
        "job_id": result.job_id,
        "status": result.status,
        "package_dir": str(result.package_dir),
        "plan": result.plan,
        "rehearsal": result.rehearsal,
        "degradations": _read_manifest_degradations(result.artifacts.package_manifest),
        "supporting_artifacts": _supporting_artifact_urls(result, rel_base),
        "artifacts": {
            "html_preview_url": f"{rel_base}/preview.html",
            "markdown_manual_url": f"{rel_base}/manual.md",
            "pdf_manual_url": f"{rel_base}/manual.pdf",
            "video_url": f"{rel_base}/{video_name}",
            "action_plan_url": f"{rel_base}/action_plan.json",
            "approval_log_url": f"{rel_base}/approval_log.json",
            "masking_log_url": f"{rel_base}/masking_log.json",
            "package_manifest_url": f"{rel_base}/package_manifest.json",
            "audit_log_url": f"{rel_base}/audit_log.jsonl",
            "capture_action_log_url": f"{rel_base}/capture_action_log.json" if result.artifacts.capture_action_log else None,
            "request_url": f"{rel_base}/request.json",
            "input_extraction_url": f"{rel_base}/input_extraction.json",
            "planner_trace_url": f"{rel_base}/planner_trace.json",
            "rehearsal_log_url": f"{rel_base}/rehearsal_log.json",
            "mcp_calls_url": f"{rel_base}/playwright_mcp_calls.json",
            "mcp_execution_url": f"{rel_base}/playwright_mcp_execution.json" if mcp_execution.exists() else None,
            "final_frame_url": f"{rel_base}/final_frame.png" if result.artifacts.final_frame else None,
            "tts_metadata_url": f"{rel_base}/tts/tts_metadata.json" if result.artifacts.tts_metadata else None,
            "video_render_metadata_url": f"{rel_base}/video_render.json" if result.artifacts.video_render_metadata else None,
            "skills_metadata_url": f"{rel_base}/hyperframes_skills.json" if result.artifacts.skills_metadata else None,
            "opencode_prompt_url": f"{rel_base}/opencode_prompt.md",
            "opencode_metadata_url": f"{rel_base}/opencode_agent.json" if result.artifacts.opencode_metadata else None,
            "hyperframes_composition_url": f"{rel_base}/hyperframes/index.html",
            "hyperframes_manifest_url": f"{rel_base}/hyperframes/hyperframes_manifest.json",
        },
    }


def draft_response(result: PipelineDraftResult) -> dict[str, Any]:
    rel_base = f"/artifacts/jobs/{result.job_id}"
    return {
        "job_id": result.job_id,
        "status": result.status,
        "current_step": result.current_step,
        "can_continue": result.can_continue,
        "package_dir": str(result.package_dir),
        "plan": result.plan,
        "rehearsal": result.rehearsal,
        "approval": result.approval,
        "artifacts": {
            "action_plan_url": f"{rel_base}/action_plan.json",
            "approval_log_url": f"{rel_base}/approval_log.json",
            "rehearsal_log_url": f"{rel_base}/rehearsal_log.json",
            "planner_trace_url": f"{rel_base}/planner_trace.json",
            "mcp_calls_url": f"{rel_base}/playwright_mcp_calls.json",
            "input_extraction_url": f"{rel_base}/input_extraction.json",
            "workflow_state_url": f"{rel_base}/workflow_state.json",
            "html_preview_url": None,
            "video_url": None,
            "markdown_manual_url": None,
            "pdf_manual_url": None,
            "capture_action_log_url": None,
        },
        "supporting_artifacts": {
            "request": f"{rel_base}/request.json",
            "input_extraction": f"{rel_base}/input_extraction.json",
            "planner_trace": f"{rel_base}/planner_trace.json",
            "rehearsal_log": f"{rel_base}/rehearsal_log.json",
            "playwright_mcp_calls": f"{rel_base}/playwright_mcp_calls.json",
            "approval_log": f"{rel_base}/approval_log.json",
            "audit_log": f"{rel_base}/audit_log.jsonl",
            "workflow_state": f"{rel_base}/workflow_state.json",
        },
    }


def _supporting_artifact_urls(result: PipelineResult, rel_base: str) -> dict[str, str | None]:
    mcp_execution = result.package_dir / "playwright_mcp_execution.json"
    return {
        "request": f"{rel_base}/request.json",
        "input_extraction": f"{rel_base}/input_extraction.json",
        "planner_trace": f"{rel_base}/planner_trace.json",
        "rehearsal_log": f"{rel_base}/rehearsal_log.json",
        "playwright_mcp_calls": f"{rel_base}/playwright_mcp_calls.json",
        "playwright_mcp_execution": f"{rel_base}/playwright_mcp_execution.json" if mcp_execution.exists() else None,
        "audit_log": f"{rel_base}/audit_log.jsonl",
        "capture_action_log": f"{rel_base}/capture_action_log.json" if result.artifacts.capture_action_log else None,
        "tts_metadata": f"{rel_base}/tts/tts_metadata.json" if result.artifacts.tts_metadata else None,
        "video_render": f"{rel_base}/video_render.json" if result.artifacts.video_render_metadata else None,
        "skills_metadata": f"{rel_base}/hyperframes_skills.json" if result.artifacts.skills_metadata else None,
        "opencode_prompt": f"{rel_base}/opencode_prompt.md",
        "opencode_metadata": f"{rel_base}/opencode_agent.json" if result.artifacts.opencode_metadata else None,
        "hyperframes_composition": f"{rel_base}/hyperframes/index.html",
        "hyperframes_manifest": f"{rel_base}/hyperframes/hyperframes_manifest.json",
    }


def _make_dirs(package_dir: Path) -> PipelineDirs:
    captures = package_dir / "captures"
    masked = package_dir / "masked"
    tts = package_dir / "tts"
    raw_video = package_dir / "raw_video"
    for path in (package_dir, captures, masked, tts, raw_video):
        path.mkdir(parents=True, exist_ok=True)
    return PipelineDirs(package=package_dir, captures=captures, masked=masked, tts=tts, raw_video=raw_video)


def _dirs_from_package(package_dir: Path) -> PipelineDirs:
    return _make_dirs(package_dir)


def _pipeline_result_from_manifest(manifest_path: Path) -> PipelineResult:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    package_dir = Path(manifest["package_dir"])
    artifacts = manifest["artifacts"]
    return PipelineResult(
        job_id=str(manifest["job_id"]),
        status=str(manifest["status"]),
        package_dir=package_dir,
        plan=json.loads(Path(artifacts["action_plan"]).read_text(encoding="utf-8")),
        rehearsal=json.loads((package_dir / "rehearsal_log.json").read_text(encoding="utf-8")),
        artifacts=ArtifactPaths(
            html_preview=Path(artifacts["html_preview"]),
            markdown_manual=Path(artifacts["markdown_manual"]),
            pdf_manual=Path(artifacts["pdf_manual"]),
            video=Path(artifacts["video"]),
            action_plan=Path(artifacts["action_plan"]),
            approval_log=Path(artifacts["approval_log"]),
            masking_log=Path(artifacts["masking_log"]),
            package_manifest=Path(artifacts["package_manifest"]),
            audit_log=Path(artifacts["audit_log"]),
            input_extraction=Path(artifacts["input_extraction"]),
            final_frame=Path(artifacts["final_frame"]) if artifacts.get("final_frame") else None,
            capture_action_log=Path(artifacts["capture_action_log"]) if artifacts.get("capture_action_log") else None,
            tts_audio=[Path(path) for path in artifacts.get("tts_audio", [])],
            tts_metadata=Path(artifacts["tts_metadata"]) if artifacts.get("tts_metadata") else None,
            video_render_metadata=Path(artifacts["video_render"]) if artifacts.get("video_render") else None,
            skills_metadata=Path(artifacts["skills_metadata"]) if artifacts.get("skills_metadata") else None,
            opencode_metadata=Path(artifacts["opencode_metadata"]) if artifacts.get("opencode_metadata") else None,
        ),
    )


def _capture_with_playwright(request: PipelineInput, plan: dict[str, Any], dirs: PipelineDirs, settings: Any) -> dict[str, Any]:
    from playwright.sync_api import sync_playwright

    login = _resolve_login_options(request, settings)
    launch_kwargs = _playwright_launch_kwargs(settings, interactive=login["mode"] == "manual")
    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_kwargs)
        context_options: dict[str, Any] = {
            "viewport": {"width": 1280, "height": 800},
            "record_video_dir": str(dirs.raw_video),
            "record_video_size": {"width": 1280, "height": 800},
        }
        auth_result = {"storage_state": None, "action_log": []}
        if login["mode"] == "credentials":
            auth_result = _authenticate_before_recording(browser, request, login)
            _raise_if_login_failed(auth_result)
        if auth_result.get("storage_state"):
            context_options["storage_state"] = auth_result["storage_state"]
        context = browser.new_context(**context_options)
        page = context.new_page()
        manual_authenticated = False
        if login["mode"] == "manual":
            auth_result = _authenticate_recording_page(page, request, login)
            _raise_if_login_failed(auth_result)
            manual_authenticated = True
        actions = plan.get("actions", [])
        if getattr(settings, "enable_browser_agent", False):
            if not manual_authenticated:
                _prepare_capture_page(page, request.target_url)
            capture_result = _execute_browser_agent_actions(page, request, plan, dirs.captures, settings)
        else:
            if not manual_authenticated and (not actions or actions[0].get("type") != "navigate"):
                _prepare_capture_page(page, request.target_url)
            capture_result = _execute_capture_actions(page, plan, dirs.captures, skip_initial_navigate=manual_authenticated)
        capture_result["action_log"] = [*auth_result.get("action_log", []), *capture_result.get("action_log", [])]
        captures = capture_result["captures"]
        if not captures:
            first_step = _first_plan_step(plan)
            _apply_step_overlay(page, first_step)
            page.wait_for_timeout(900)
            captures.append(_screenshot(page, dirs.captures, _step_capture_name(first_step, set())))
        final_frame = _screenshot(page, dirs.package, "final_frame.png")
        context.close()
        browser.close()

    videos = sorted(dirs.raw_video.glob("*.webm"), key=lambda path: path.stat().st_mtime, reverse=True)
    video = dirs.package / "manual_video_agent_usage.webm"
    if videos:
        shutil.copy2(videos[0], video)
    else:
        video = _render_placeholder_video(dirs.package)
        capture_result.setdefault("action_log", []).append(
            {
                "type": "record_video",
                "status": "degraded",
                "reason": "browser_recording_missing",
            }
        )
        capture_result["status"] = "degraded"
        capture_result["degrade_reason"] = capture_result.get("degrade_reason") or "browser_recording_missing"
    action_log_path = dirs.package / "capture_action_log.json"
    capture_log_status = "completed" if capture_result.get("status", "ok") == "ok" else str(capture_result.get("status"))
    capture_log_payload: dict[str, Any] = {
        "status": capture_log_status,
        "entries": redact_sensitive(capture_result.get("action_log", [])),
    }
    if capture_result.get("degrade_reason"):
        capture_log_payload["reason"] = str(capture_result.get("degrade_reason"))
    _write_json(action_log_path, capture_log_payload)
    return {
        "captures": captures,
        "masked_names": [path.name for path in captures],
        "video": video,
        "final_frame": final_frame,
        "action_log": capture_result.get("action_log", []),
        "action_log_path": action_log_path,
        "status": capture_result.get("status", "ok"),
        "degrade_reason": capture_result.get("degrade_reason", ""),
    }


def _playwright_launch_kwargs(
    settings: Any,
    browser_roots: list[Path] | None = None,
    *,
    interactive: bool = False,
) -> dict[str, Any]:
    launch_kwargs: dict[str, Any] = {"headless": not interactive}
    executable_path = str(getattr(settings, "playwright_executable_path", "") or "").strip()
    if executable_path:
        launch_kwargs["executable_path"] = executable_path
        return launch_kwargs
    discovered = _discover_playwright_chromium(browser_roots=browser_roots)
    if discovered:
        launch_kwargs["executable_path"] = str(discovered)
    return launch_kwargs


def _discover_playwright_chromium(browser_roots: list[Path] | None = None) -> Path | None:
    roots = browser_roots if browser_roots is not None else _default_playwright_browser_roots()
    candidates: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        candidates.extend(path for path in root.glob("chromium-*/chrome-win/chrome.exe") if path.is_file())
        candidates.extend(path for path in root.glob("chromium-*/chrome-win64/chrome.exe") if path.is_file())
    if not candidates:
        return None
    return sorted(candidates, key=lambda path: path.stat().st_mtime, reverse=True)[0]


def _default_playwright_browser_roots() -> list[Path]:
    roots: list[Path] = []
    configured = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "").strip()
    if configured:
        roots.append(Path(configured))
    roots.append(Path.home() / "AppData" / "Local" / "ms-playwright")
    return roots


def _prepare_capture_page(page: Any, target_url: str) -> None:
    page.goto(target_url, wait_until="load")
    try:
        page.wait_for_load_state("networkidle", timeout=5000)
    except Exception:
        # Some internal systems keep long-polling connections open. Continue after
        # document readiness and a rendered body are available.
        pass
    page.wait_for_function(
        """
        () => document.readyState === 'complete'
          && document.body
          && document.body.children.length > 0
        """,
        timeout=10000,
    )
    _inject_recording_helpers(page)


def _resolve_login_options(request: PipelineInput, settings: Any) -> dict[str, Any]:
    configured = getattr(settings, "login", None)
    requested_mode = str(request.login_mode or "").strip().lower()
    mode = requested_mode if requested_mode in {"none", "manual", "credentials"} else getattr(configured, "mode", "none")
    success_selector = str(request.login_success_selector or getattr(configured, "success_selector", "") or "").strip()
    return {
        "mode": mode,
        "username_selector": str(getattr(configured, "username_selector", "") or ""),
        "password_selector": str(getattr(configured, "password_selector", "") or ""),
        "submit_selector": str(getattr(configured, "submit_selector", "") or ""),
        "success_selector": success_selector,
        "username": str(getattr(configured, "username", "") or ""),
        "password": str(getattr(configured, "password", "") or ""),
        "manual_timeout_ms": int(float(getattr(configured, "manual_timeout_seconds", 120.0) or 120.0) * 1000),
        "credentials_timeout_ms": int(float(getattr(configured, "credentials_timeout_seconds", 30.0) or 30.0) * 1000),
    }


def _authenticate_before_recording(browser: Any, request: PipelineInput, login: dict[str, Any]) -> dict[str, Any]:
    context = browser.new_context(viewport={"width": 1280, "height": 800})
    action_log: list[dict[str, Any]] = []
    storage_state: dict[str, Any] | None = None
    try:
        page = context.new_page()
        _prepare_capture_page(page, request.target_url)
        login_log = _handle_login(page, login)
        action_log.append(login_log)
        if login_log.get("status") == "ok":
            storage_state = context.storage_state()
    except Exception as exc:  # noqa: BLE001 - continue to produce an inspectable capture package.
        action_log.append(
            {
                "type": "login",
                "mode": login.get("mode", "none"),
                "status": "failed",
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
    finally:
        context.close()
    return {"storage_state": storage_state, "action_log": action_log}


def _authenticate_recording_page(page: Any, request: PipelineInput, login: dict[str, Any]) -> dict[str, Any]:
    action_log: list[dict[str, Any]] = []
    try:
        _prepare_capture_page(page, request.target_url)
        action_log.append(_handle_login(page, login))
    except Exception as exc:  # noqa: BLE001 - caller records the failure and aborts capture.
        action_log.append(
            {
                "type": "login",
                "mode": login.get("mode", "none"),
                "status": "failed",
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
    return {"storage_state": None, "action_log": action_log}


def _raise_if_login_failed(auth_result: dict[str, Any]) -> None:
    for entry in auth_result.get("action_log", []):
        if isinstance(entry, dict) and entry.get("type") == "login" and entry.get("status") != "ok":
            reason = entry.get("error") or entry.get("reason") or "login was not confirmed"
            raise RuntimeError(f"login did not complete; capture aborted: {reason}")


def _execute_capture_actions(
    page: Any,
    plan: dict[str, Any],
    capture_dir: Path,
    *,
    skip_initial_navigate: bool = False,
) -> dict[str, Any]:
    steps = {str(step.get("id")): step for step in plan.get("steps", []) if isinstance(step, dict)}
    captures: list[Path] = []
    action_log: list[dict[str, Any]] = []
    used_names: set[str] = set()

    for index, action in enumerate(plan.get("actions", [])):
        if not isinstance(action, dict):
            continue
        action_id = str(action.get("id") or "")
        action_type = str(action.get("type") or "")
        step = steps.get(str(action.get("step_id"))) or _first_plan_step(plan)
        log_entry = {"action_id": action_id, "type": action_type, "step_id": step.get("id"), "status": "ok"}
        try:
            if action_type == "navigate":
                if skip_initial_navigate and index == 0:
                    log_entry["status"] = "skipped"
                    log_entry["reason"] = "manual_login_current_page"
                else:
                    target = str(action.get("target") or "")
                    if not target:
                        log_entry["status"] = "skipped"
                        log_entry["reason"] = "missing_target"
                    else:
                        _prepare_capture_page(page, target)
                        _apply_step_overlay(page, step, action)
                        page.wait_for_timeout(500)
            elif action_type == "fill":
                selector = str(action.get("selector") or "")
                if not selector:
                    log_entry["status"] = "skipped"
                    log_entry["reason"] = "missing_selector"
                else:
                    _apply_step_overlay(page, step, action)
                    page.fill(selector, str(action.get("value") or ""))
                    page.wait_for_timeout(300)
            elif action_type == "fill_by_label":
                label = str(action.get("label") or action.get("name") or "")
                if not label:
                    log_entry["status"] = "skipped"
                    log_entry["reason"] = "missing_label"
                else:
                    _apply_step_overlay(page, step, action)
                    method = _fill_by_label(page, label, str(action.get("value") or ""))
                    log_entry["method"] = method
                    page.wait_for_timeout(300)
            elif action_type == "click":
                selector = str(action.get("selector") or "")
                if not selector:
                    log_entry["status"] = "skipped"
                    log_entry["reason"] = "missing_selector"
                else:
                    _apply_step_overlay(page, step, action)
                    page.click(selector)
                    page.wait_for_timeout(700)
            elif action_type == "click_by_text":
                texts = _action_text_candidates(action)
                if not texts:
                    log_entry["status"] = "skipped"
                    log_entry["reason"] = "missing_text"
                else:
                    _apply_step_overlay(page, step, action)
                    method = _click_by_text(page, texts)
                    log_entry["method"] = method
                    page.wait_for_timeout(700)
            elif action_type == "press":
                selector = str(action.get("selector") or "")
                key = str(action.get("key") or "Enter")
                if not selector:
                    log_entry["status"] = "skipped"
                    log_entry["reason"] = "missing_selector"
                else:
                    _apply_step_overlay(page, step, action)
                    page.press(selector, key)
                    page.wait_for_timeout(500)
            elif action_type == "wait_for_selector":
                selector = str(action.get("selector") or "")
                if not selector:
                    log_entry["status"] = "skipped"
                    log_entry["reason"] = "missing_selector"
                else:
                    page.wait_for_selector(selector, timeout=_action_timeout(action, default=10000))
            elif action_type == "wait":
                page.wait_for_timeout(_action_timeout(action, default=1000))
            elif action_type == "capture_step":
                _apply_step_overlay(page, step, action)
                page.wait_for_timeout(500)
                captures.append(_screenshot(page, capture_dir, _step_capture_name(step, used_names)))
            else:
                log_entry["status"] = "skipped"
                log_entry["reason"] = "unsupported_action_type"
        except Exception as exc:  # noqa: BLE001 - capture should produce an inspectable package when one action fails.
            log_entry["status"] = "failed"
            log_entry["error"] = f"{type(exc).__name__}: {exc}"
        action_log.append(log_entry)

    status, degrade_reason = _capture_action_log_status(action_log, failed_reason="capture_action_failed")
    return {"captures": captures, "action_log": action_log, "status": status, "degrade_reason": degrade_reason}


def _execute_browser_agent_actions(
    page: Any,
    request: PipelineInput,
    plan: dict[str, Any],
    capture_dir: Path,
    settings: Any,
    *,
    decide_next: Any = decide_browser_agent_action,
) -> dict[str, Any]:
    if not getattr(settings, "enable_browser_agent", False):
        return _execute_capture_actions(page, plan, capture_dir)
    if not getattr(getattr(settings, "llm", None), "is_configured", False) and decide_next is decide_browser_agent_action:
        fallback = _execute_capture_actions(page, plan, capture_dir)
        fallback["action_log"] = [
            {
                "type": "browser_agent",
                "source": "browser-agent",
                "status": "degraded",
                "reason": "llm_not_configured",
            },
            *fallback.get("action_log", []),
        ]
        fallback["status"] = "degraded"
        fallback["degrade_reason"] = "browser_agent_llm_not_configured"
        return fallback

    captures: list[Path] = []
    action_log: list[dict[str, Any]] = []
    history: list[dict[str, Any]] = []
    used_names: set[str] = set()
    max_steps = max(int(getattr(settings, "browser_agent_max_steps", 8) or 8), 1)

    for step_index in range(1, max_steps + 1):
        try:
            observation = _observe_browser_for_agent(page)
            action = dict(
                decide_next(
                    request,
                    settings,
                    observation,
                    history,
                    step_index=step_index,
                )
            )
        except Exception as exc:  # noqa: BLE001 - fallback keeps the package inspectable.
            fallback = _execute_capture_actions(page, plan, capture_dir)
            action_log.append(
                {
                    "type": "browser_agent",
                    "source": "browser-agent",
                    "status": "degraded",
                    "reason": "decision_failed",
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
            return {
                "captures": [*captures, *fallback.get("captures", [])],
                "action_log": [*action_log, *fallback.get("action_log", [])],
                "status": "degraded",
                "degrade_reason": "browser_agent_decision_failed",
            }

        action.setdefault("id", f"ba{step_index}")
        action.setdefault("source", "browser-agent-llm")
        action["step_id"] = f"browser_agent_step_{step_index}"
        log_entry = _execute_single_browser_agent_action(page, action, capture_dir, used_names)
        action_log.append(log_entry)
        history.append(
            {
                "step": step_index,
                "type": log_entry.get("type"),
                "status": log_entry.get("status"),
                "reason": log_entry.get("reason") or log_entry.get("error") or action.get("reason", ""),
            }
        )
        if log_entry.get("capture"):
            captures.append(Path(log_entry["capture"]))
        if action.get("type") == "finish":
            break

    if not captures:
        step = {"id": "browser_agent_step_final", "title": "자동 판단 결과", "caption": "브라우저 자동 판단 결과를 확인합니다."}
        _apply_step_overlay(page, step)
        page.wait_for_timeout(500)
        captures.append(_screenshot(page, capture_dir, _step_capture_name(step, used_names)))

    status, degrade_reason = _capture_action_log_status(action_log, failed_reason="browser_agent_action_failed")
    return {"captures": captures, "action_log": action_log, "status": status, "degrade_reason": degrade_reason}


def _capture_action_log_status(action_log: list[dict[str, Any]], *, failed_reason: str) -> tuple[str, str]:
    ignored_skips = {"manual_login_current_page"}
    ignored_types = {"danger_approval"}
    for entry in action_log:
        status = str(entry.get("status") or "")
        action_type = str(entry.get("type") or "")
        reason = str(entry.get("reason") or "")
        if action_type in ignored_types:
            continue
        if status == "failed":
            return "degraded", failed_reason
        if status in {"blocked", "degraded"}:
            return "degraded", failed_reason
        if status == "skipped" and reason not in ignored_skips:
            return "degraded", failed_reason
    return "ok", ""


def _observe_browser_for_agent(page: Any) -> dict[str, Any]:
    return page.evaluate(
        """
        () => {
          const visible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          };
          const textOf = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
          const labelFor = (el) => {
            const labels = Array.from(el.labels || []).map((label) => label.innerText.trim()).filter(Boolean);
            if (labels.length) return labels.join(' ');
            const id = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
            return (id?.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '').trim();
          };
          const fields = Array.from(document.querySelectorAll('input, textarea, select'))
            .filter(visible)
            .slice(0, 40)
            .map((el) => ({
              label: labelFor(el),
              name: el.name || '',
              placeholder: el.getAttribute('placeholder') || '',
              type: el.getAttribute('type') || el.tagName.toLowerCase(),
              value: el.type === 'password' ? '<redacted>' : String(el.value || '').slice(0, 80),
            }));
          const clickables = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a'))
            .filter(visible)
            .slice(0, 60)
            .map((el) => ({
              text: textOf(el).slice(0, 120),
              role: el.getAttribute('role') || el.tagName.toLowerCase(),
              href: el.tagName.toLowerCase() === 'a' ? el.getAttribute('href') || '' : '',
            }))
            .filter((item) => item.text || item.href);
          const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
            .filter(visible)
            .slice(0, 20)
            .map((el) => textOf(el).slice(0, 160))
            .filter(Boolean);
          return {
            url: location.href,
            title: document.title,
            headings,
            fields,
            clickables,
            body_text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 4000),
          };
        }
        """
    )


def _execute_single_browser_agent_action(
    page: Any,
    action: dict[str, Any],
    capture_dir: Path,
    used_names: set[str],
) -> dict[str, Any]:
    action_type = str(action.get("type") or "")
    step = {
        "id": str(action.get("step_id") or "browser_agent_step"),
        "title": "브라우저 자동 판단",
        "caption": str(action.get("reason") or "브라우저 화면을 보고 다음 동작을 수행합니다."),
        "narration": str(action.get("reason") or "브라우저 화면을 보고 다음 동작을 수행합니다."),
    }
    log_entry = {
        "action_id": str(action.get("id") or ""),
        "type": action_type,
        "source": action.get("source", "browser-agent-llm"),
        "step_id": step["id"],
        "status": action.get("status", "ok"),
        "reason": action.get("reason", ""),
    }
    try:
        if action_type == "fill_by_label":
            _apply_step_overlay(page, step, action)
            method = _fill_by_label(page, str(action.get("label") or ""), str(action.get("value") or ""))
            log_entry["method"] = method
            page.wait_for_timeout(300)
        elif action_type == "click_by_text":
            _apply_step_overlay(page, step, action)
            method = _click_by_text(page, _action_text_candidates(action))
            log_entry["method"] = method
            page.wait_for_timeout(700)
        elif action_type == "wait":
            page.wait_for_timeout(_action_timeout(action, default=1000))
        elif action_type in {"capture_step", "finish"}:
            _apply_step_overlay(page, step, action)
            page.wait_for_timeout(500)
            capture = _screenshot(page, capture_dir, _step_capture_name(step, used_names))
            log_entry["capture"] = str(capture)
        else:
            log_entry["status"] = "skipped"
            log_entry["reason"] = "unsupported_action_type"
    except Exception as exc:  # noqa: BLE001 - one dynamic action should not erase prior evidence.
        log_entry["status"] = "failed"
        log_entry["error"] = f"{type(exc).__name__}: {exc}"
    return log_entry


def _fill_by_label(page: Any, label: str, value: str) -> str:
    candidates = _semantic_label_candidates(label)
    errors: list[str] = []
    for candidate in candidates:
        for method_name in ("get_by_label", "get_by_placeholder"):
            method = getattr(page, method_name, None)
            if not callable(method):
                continue
            try:
                method(candidate, exact=False).fill(value)
                return f"{method_name}:{candidate}"
            except TypeError:
                try:
                    method(candidate).fill(value)
                    return f"{method_name}:{candidate}"
                except Exception as exc:  # noqa: BLE001 - try the next semantic locator.
                    errors.append(f"{method_name}:{type(exc).__name__}")
            except Exception as exc:  # noqa: BLE001 - try the next semantic locator.
                errors.append(f"{method_name}:{type(exc).__name__}")
    locator = getattr(page, "locator", None)
    if callable(locator):
        for candidate in candidates:
            selector = _input_selector_for_name(candidate)
            try:
                locator(selector).fill(value)
                return f"locator:{selector}"
            except Exception as exc:  # noqa: BLE001 - collect evidence then fail after all candidates.
                errors.append(f"locator:{type(exc).__name__}")
    raise RuntimeError(f"no editable field found for label {label!r}: {'; '.join(errors)}")


def _click_by_text(page: Any, texts: list[str]) -> str:
    errors: list[str] = []
    for text in texts:
        role = getattr(page, "get_by_role", None)
        if callable(role):
            try:
                role("button", name=text, exact=False).click()
                return f"get_by_role:button:{text}"
            except TypeError:
                try:
                    role("button", name=text).click()
                    return f"get_by_role:button:{text}"
                except Exception as exc:  # noqa: BLE001 - try text locator next.
                    errors.append(f"get_by_role:{type(exc).__name__}")
            except Exception as exc:  # noqa: BLE001 - try text locator next.
                errors.append(f"get_by_role:{type(exc).__name__}")
        by_text = getattr(page, "get_by_text", None)
        if callable(by_text):
            try:
                by_text(text, exact=False).click()
                return f"get_by_text:{text}"
            except TypeError:
                try:
                    by_text(text).click()
                    return f"get_by_text:{text}"
                except Exception as exc:  # noqa: BLE001 - try the next label.
                    errors.append(f"get_by_text:{type(exc).__name__}")
            except Exception as exc:  # noqa: BLE001 - try the next label.
                errors.append(f"get_by_text:{type(exc).__name__}")
    raise RuntimeError(f"no clickable element found for texts {texts!r}: {'; '.join(errors)}")


def _semantic_label_candidates(label: str) -> list[str]:
    candidates = [label.strip()]
    compact = label.replace(" ", "").strip()
    lowered = label.lower().strip()
    for candidate in (compact, lowered, compact.lower()):
        if candidate and candidate not in candidates:
            candidates.append(candidate)
    return [candidate for candidate in candidates if candidate]


def _input_selector_for_name(name: str) -> str:
    escaped = name.replace("\\", "\\\\").replace('"', '\\"')
    return f'input[name="{escaped}"], textarea[name="{escaped}"], select[name="{escaped}"]'


def _action_text_candidates(action: dict[str, Any]) -> list[str]:
    raw = action.get("texts", action.get("text", action.get("label", "")))
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    value = str(raw).strip()
    return [value] if value else []


def _handle_login(page: Any, login: dict[str, Any]) -> dict[str, Any]:
    mode = str(login.get("mode") or "none")
    if mode == "manual":
        return _wait_for_manual_login(page, login)
    if mode == "credentials":
        return _submit_login_credentials(page, login)
    return {"type": "login", "mode": mode, "status": "skipped"}


def _wait_for_manual_login(page: Any, login: dict[str, Any]) -> dict[str, Any]:
    success_selector = str(login.get("success_selector") or "").strip()
    timeout_ms = int(login.get("manual_timeout_ms") or 120000)
    signal_state = _ManualLoginSignalState()
    log = {
        "type": "login",
        "mode": "manual",
        "status": "ok",
        "success_selector_set": bool(success_selector),
        "signal_button_enabled": True,
    }
    try:
        _install_manual_login_signal(page, signal_state=signal_state)
        log["completion_signal"] = _wait_for_manual_login_completion(page, success_selector, timeout_ms, signal_state)
        _remove_manual_login_signal(page)
    except Exception as exc:  # noqa: BLE001 - keep the package inspectable when manual login times out.
        log["status"] = "failed"
        log["error"] = f"{type(exc).__name__}: {exc}"
    return log


class _ManualLoginSignalState:
    def __init__(self) -> None:
        self.completed = False

    def mark_completed(self, *_args: Any) -> bool:
        self.completed = True
        return True


def _install_manual_login_signal(page: Any, signal_state: _ManualLoginSignalState | None = None) -> None:
    signal_state = signal_state or _ManualLoginSignalState()
    try:
        page.expose_function("__manualLoginSignalFromPage", signal_state.mark_completed)
    except Exception:
        pass
    script = """
    (() => {
      const readStoredCompletion = () => {
        try { return window.sessionStorage.getItem('__manualLoginCompleted') === 'true'; } catch { return false; }
      };
      window.__manualLoginCompleted = window.__manualLoginCompleted === true || readStoredCompletion();
      const selector = '[data-manual-login-signal="true"]';
      window.__manualLoginCleanup = () => {
        const button = document.querySelector(selector);
        if (button) button.remove();
        if (window.__manualLoginSignalObserver) {
          window.__manualLoginSignalObserver.disconnect();
          window.__manualLoginSignalObserver = null;
        }
        if (window.__manualLoginSignalInterval) {
          window.clearInterval(window.__manualLoginSignalInterval);
          window.__manualLoginSignalInterval = null;
        }
      };
      const markCompleted = (button) => {
        if (!button) return;
        button.textContent = '완료 신호 전송됨';
        button.setAttribute('aria-label', '로그인 완료 신호 전송됨');
        button.disabled = true;
        button.style.opacity = '0.72';
      };
      window.__manualLoginSignal = () => {
        window.__manualLoginCompleted = true;
        try { window.sessionStorage.setItem('__manualLoginCompleted', 'true'); } catch {}
        try {
          if (typeof window.__manualLoginSignalFromPage === 'function') {
            window.__manualLoginSignalFromPage();
          }
        } catch {}
        markCompleted(document.querySelector(selector));
        window.setTimeout(window.__manualLoginCleanup, 120);
      };
      const install = () => {
        if (!document.body) return false;
        let button = document.querySelector(selector);
        if (!button) {
          button = document.createElement('button');
          button.type = 'button';
          button.textContent = '로그인 완료';
          button.setAttribute('data-manual-login-signal', 'true');
          button.setAttribute('aria-label', '로그인 완료 신호 전송');
          button.style.cssText = [
            'position:fixed',
            'right:24px',
            'bottom:24px',
            'z-index:2147483647',
            'border:0',
            'border-radius:8px',
            'padding:14px 18px',
            'background:#245BFF',
            'color:#fff',
            'font:800 15px/1.2 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
            'box-shadow:0 18px 48px rgba(17,24,39,.24)',
            'cursor:pointer'
          ].join(';');
          button.addEventListener('click', window.__manualLoginSignal);
          document.body.appendChild(button);
        }
        if (window.__manualLoginCompleted === true) {
          markCompleted(button);
        }
        return true;
      };
      const keepInstalled = () => {
        try { install(); } catch {}
      };
      if (!window.__manualLoginSignalObserver && typeof MutationObserver !== 'undefined') {
        window.__manualLoginSignalObserver = new MutationObserver(keepInstalled);
        window.__manualLoginSignalObserver.observe(document.documentElement || document, {
          childList: true,
          subtree: true
        });
      }
      if (!window.__manualLoginSignalInterval) {
        window.__manualLoginSignalInterval = window.setInterval(keepInstalled, 1000);
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', keepInstalled, { once: true });
      } else {
        keepInstalled();
      }
    })();
    """
    page.add_init_script(script)
    page.evaluate(script)


def _wait_for_manual_login_completion(
    page: Any,
    success_selector: str,
    timeout_ms: int,
    signal_state: _ManualLoginSignalState,
) -> str:
    deadline = time.monotonic() + (max(timeout_ms, 1) / 1000)
    last_error = ""
    while time.monotonic() < deadline:
        if signal_state.completed:
            return "button"
        try:
            state = page.evaluate(
                """
                (selector) => {
                  const storedCompleted = (() => {
                    try { return window.sessionStorage.getItem('__manualLoginCompleted') === 'true'; } catch { return false; }
                  })();
                  const completed = window.__manualLoginCompleted === true || storedCompleted;
                  let successSelectorMatched = false;
                  if (selector) {
                    try {
                      const el = document.querySelector(selector);
                      if (el) {
                        const style = window.getComputedStyle(el);
                        successSelectorMatched = style && style.visibility !== 'hidden' && style.display !== 'none';
                      }
                    } catch {
                      successSelectorMatched = false;
                    }
                  }
                  return { completed, successSelectorMatched };
                }
                """,
                success_selector,
            )
            if isinstance(state, dict) and state.get("completed"):
                return "button"
            if isinstance(state, dict) and state.get("successSelectorMatched"):
                return "selector"
        except Exception as exc:  # noqa: BLE001 - navigation can temporarily destroy the execution context.
            last_error = f"{type(exc).__name__}: {exc}"
        _manual_login_wait_tick(page)
    suffix = f" Last page check: {last_error}" if last_error else ""
    raise TimeoutError(f"manual login was not confirmed.{suffix}")


def _manual_login_wait_tick(page: Any) -> None:
    try:
        page.wait_for_timeout(250)
    except Exception:
        time.sleep(0.25)


def _remove_manual_login_signal(page: Any) -> None:
    try:
        page.evaluate(
            """
            () => {
              if (typeof window.__manualLoginCleanup === 'function') {
                window.__manualLoginCleanup();
              }
            }
            """
        )
    except Exception:
        pass


def _submit_login_credentials(page: Any, login: dict[str, Any]) -> dict[str, Any]:
    username_selector = str(login.get("username_selector") or "").strip()
    password_selector = str(login.get("password_selector") or "").strip()
    submit_selector = str(login.get("submit_selector") or "").strip()
    success_selector = str(login.get("success_selector") or "").strip()
    username = str(login.get("username") or "")
    password = str(login.get("password") or "")
    log = {
        "type": "login",
        "mode": "credentials",
        "status": "ok",
        "username_selector_set": bool(username_selector),
        "password_selector_set": bool(password_selector),
        "submit_selector_set": bool(submit_selector),
        "success_selector_set": bool(success_selector),
        "username_set": bool(username),
        "password_set": bool(password),
    }
    if not all([username_selector, password_selector, username, password]):
        log["status"] = "failed"
        log["reason"] = "missing_credentials_or_selectors"
        return log
    try:
        page.fill(username_selector, username)
        page.fill(password_selector, password)
        if submit_selector:
            page.click(submit_selector)
        if success_selector:
            page.wait_for_selector(success_selector, timeout=int(login.get("credentials_timeout_ms") or 30000))
        else:
            try:
                page.wait_for_load_state("networkidle", timeout=5000)
            except Exception:
                pass
            page.wait_for_function("() => document.readyState === 'complete'", timeout=10000)
    except Exception as exc:  # noqa: BLE001 - record credential login failure without exposing credentials.
        log["status"] = "failed"
        log["error"] = f"{type(exc).__name__}: {exc}"
    return log


def _first_plan_step(plan: dict[str, Any]) -> dict[str, Any]:
    steps = plan.get("steps", [])
    if steps and isinstance(steps[0], dict):
        return steps[0]
    return {
        "id": "step_intro",
        "title": "화면 확인",
        "caption": "대상 화면을 확인합니다.",
        "narration": "대상 화면을 확인합니다.",
    }


def _apply_step_overlay(page: Any, step: dict[str, Any], action: dict[str, Any] | None = None) -> None:
    caption = str(step.get("caption") or step.get("title") or "")
    if caption:
        page.evaluate("window.__manualSetCaption", caption)
    selector = ""
    if action:
        selector = str(action.get("highlight_selector") or action.get("selector") or "")
    if selector:
        try:
            page.evaluate("window.__manualHighlight", selector)
        except Exception:
            # Highlighting is presentational. Do not fail a capture action because
            # a target system uses a selector Playwright can execute but querySelector cannot.
            pass


def _step_capture_name(step: dict[str, Any], used_names: set[str]) -> str:
    raw_stem = str(step.get("id") or step.get("title") or "step")
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", raw_stem).strip("._-") or "step"
    name = f"{stem}.png"
    index = 2
    while name in used_names:
        name = f"{stem}_{index}.png"
        index += 1
    used_names.add(name)
    return name


def _action_timeout(action: dict[str, Any], *, default: int) -> int:
    raw_value = action.get("timeout_ms", action.get("timeout", default))
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return default
    return max(value, 0)


def _create_placeholder_captures(request: PipelineInput, dirs: PipelineDirs) -> dict[str, Any]:
    from PIL import Image, ImageDraw, ImageFont

    captures: list[Path] = []
    texts = [
        ("step_intro.png", "요청 확인", request.request_text),
        ("step_inputs.png", "입력 조건 확인", json.dumps(request.input_values, ensure_ascii=False)),
        ("step_completion.png", "완료 조건 확인", request.completion_condition),
    ]
    for name, title, body in texts:
        image = Image.new("RGB", (1280, 800), "#F7F9FC")
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((48, 48, 1232, 752), radius=12, fill="#FFFFFF", outline="#D8E0EC")
        draw.text((96, 96), title, fill="#050816")
        draw.text((96, 150), body, fill="#465161")
        path = dirs.captures / name
        image.save(path)
        captures.append(path)
    video = _render_placeholder_video(dirs.package)
    final_frame = dirs.package / "final_frame.png"
    shutil.copy2(captures[-1], final_frame)
    action_log_path = dirs.package / "capture_action_log.json"
    _write_json(action_log_path, {"status": "skipped", "reason": "browser_capture_disabled", "entries": []})
    return {
        "captures": captures,
        "masked_names": [path.name for path in captures],
        "video": video,
        "final_frame": final_frame,
        "action_log": [],
        "action_log_path": action_log_path,
    }


def _create_capture_failure_fallback(request: PipelineInput, dirs: PipelineDirs, exc: Exception) -> dict[str, Any]:
    result = _create_placeholder_captures(request, dirs)
    error = f"{type(exc).__name__}: {exc}"
    action_log = [
        {
            "type": "capture",
            "status": "failed",
            "reason": "playwright_capture_failed",
            "error": error,
        }
    ]
    result["status"] = "degraded"
    result["degrade_reason"] = "playwright_capture_failed"
    result["action_log"] = action_log
    _write_json(
        result["action_log_path"],
        {
            "status": "failed",
            "reason": "playwright_capture_failed",
            "entries": redact_sensitive(action_log),
        },
    )
    return result


def _mask_captures(captures: list[Path], masked_dir: Path, input_values: dict[str, str]) -> Path:
    from PIL import Image, ImageDraw

    log: list[dict[str, Any]] = []
    for capture in captures:
        image = Image.open(capture).convert("RGBA")
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        # MVP mask: reserve the top-right area for possible user/session identifiers.
        box = (image.width - 360, 24, image.width - 32, 76)
        draw.rounded_rectangle(box, radius=10, fill=(36, 91, 255, 72))
        masked = Image.alpha_composite(image, overlay).convert("RGB")
        masked.save(masked_dir / capture.name)
        log.append(
            {
                "capture": capture.name,
                "masked_output": str(masked_dir / capture.name),
                "rules": ["top-right-session-area", "user-input-values"],
                "input_values": sorted(input_values.keys()),
            }
        )
    log_path = masked_dir.parent / "masking_log.json"
    _write_json(log_path, {"status": "completed", "entries": log})
    return log_path


def _synthesize_tts(plan: dict[str, Any], tts_dir: Path) -> list[Path]:
    audio_paths: list[Path] = []
    for index, step in enumerate(plan["steps"], start=1):
        path = tts_dir / f"{index:02d}_{step['id']}.wav"
        _write_silent_wav(path, duration_seconds=1.2)
        sidecar = path.with_suffix(".txt")
        sidecar.write_text(step["narration"], encoding="utf-8")
        audio_paths.append(path)
    return audio_paths


def _render_preview(
    request: PipelineInput,
    plan: dict[str, Any],
    dirs: PipelineDirs,
    masked_names: list[str],
    tts_audio: list[Path],
) -> Path:
    step_cards = []
    for index, step in enumerate(plan["steps"][: len(masked_names)], start=0):
        image_name = masked_names[index]
        audio = tts_audio[index].relative_to(dirs.package).as_posix() if index < len(tts_audio) else ""
        step_cards.append(
            f"""
            <section class="slide">
              <div class="copy">
                <span>Step {index + 1}</span>
                <h2>{_escape(step['title'])}</h2>
                <p>{_escape(step['caption'])}</p>
                <audio controls src="{audio}"></audio>
              </div>
              <img src="masked/{_escape(image_name)}" alt="{_escape(step['title'])}" />
            </section>
            """
        )
    html = f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{_escape(request.request_text)} Preview</title>
  <style>
    body {{ margin: 0; font-family: SamsungOne, Pretendard, Inter, system-ui, sans-serif; background: #f7f9fc; color: #050816; }}
    header {{ padding: 36px 44px; background: linear-gradient(135deg, #f7f9fc, #eef3ff); border-bottom: 1px solid #d8e0ec; }}
    .dot {{ display:inline-block; width:12px; height:12px; border-radius:50%; background:#21d4fd; box-shadow:0 0 24px rgba(33,212,253,.72); margin-right:10px; }}
    h1 {{ margin: 0; font-size: 40px; line-height: 1.2; }}
    header p {{ margin: 12px 0 0; color: #465161; font-size: 17px; }}
    .slide {{ display:grid; grid-template-columns: 360px 1fr; gap:24px; padding:32px 44px; border-bottom:1px solid #d8e0ec; align-items:center; }}
    .copy {{ background:#fff; border:1px solid #d8e0ec; border-radius:8px; padding:24px; }}
    .copy span {{ color:#245bff; font-weight:800; font-size:13px; text-transform:uppercase; }}
    .copy h2 {{ margin:10px 0; font-size:26px; }}
    .copy p {{ color:#465161; line-height:1.6; }}
    img {{ width:100%; border:1px solid #d8e0ec; border-radius:8px; box-shadow:0 18px 48px rgba(17,24,39,.08); }}
    audio {{ width:100%; margin-top:14px; }}
  </style>
</head>
<body>
  <header><h1><span class="dot"></span>{_escape(request.request_text)}</h1><p>{_escape(request.role)} · {_escape(request.completion_condition)}</p></header>
  {''.join(step_cards)}
</body>
</html>"""
    path = dirs.package / "preview.html"
    path.write_text(html, encoding="utf-8")
    return path


def _render_markdown(request: PipelineInput, plan: dict[str, Any], dirs: PipelineDirs, masked_names: list[str]) -> Path:
    lines = [
        f"# {request.request_text}",
        "",
        f"- 대상 URL: `{request.target_url}`",
        f"- 계정 역할: `{request.role}`",
        f"- 완료 조건: {request.completion_condition}",
        "",
        "## 단계",
        "",
    ]
    for index, step in enumerate(plan["steps"][: len(masked_names)], start=1):
        lines.extend(
            [
                f"### {index}. {step['title']}",
                "",
                step["caption"],
                "",
                f"![{step['title']}](masked/{masked_names[index - 1]})",
                "",
            ]
        )
    lines.extend(["## 위험 액션", "", "- 렌더링 확정 단계는 사용자 승인 후 진행합니다.", ""])
    path = dirs.package / "manual.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def _render_pdf_placeholder(request: PipelineInput, dirs: PipelineDirs) -> Path:
    path = dirs.package / "manual.pdf"
    text = f"Manual Video Agent\n{request.request_text}\n{request.completion_condition}"
    objects = [
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
        "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
        f"4 0 obj << /Length {len(text) + 64} >> stream\nBT /F1 18 Tf 72 720 Td ({_pdf_escape(text)}) Tj ET\nendstream endobj",
        "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    ]
    body = "%PDF-1.4\n" + "\n".join(objects) + "\ntrailer << /Root 1 0 R >>\n%%EOF\n"
    path.write_bytes(body.encode("latin-1", errors="replace"))
    return path


def _render_placeholder_video(package_dir: Path) -> Path:
    path = package_dir / "manual_video_agent_usage.webm"
    # Test-mode placeholder. Browser capture mode overwrites this with a real Playwright webm.
    path.write_bytes(base64.b64decode("GkXfo0AgQoaBAUL3gQFC8oEEQvOB"))
    return path


def _inject_recording_helpers(page: Any) -> None:
    page.add_style_tag(
        content="""
        .manual-caption{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;width:min(860px,calc(100vw - 72px));padding:16px 20px;border:1px solid rgba(36,91,255,.28);border-radius:8px;background:rgba(255,255,255,.96);box-shadow:0 22px 56px rgba(17,24,39,.18);font:800 22px/1.45 SamsungOne,Pretendard,Inter,system-ui,sans-serif;text-align:center;color:#050816}
        .manual-highlight{position:relative!important;z-index:9999!important;box-shadow:0 0 0 5px rgba(33,212,253,.38),0 0 0 10px rgba(36,91,255,.13),0 22px 42px rgba(36,91,255,.22)!important;border-color:#245BFF!important}
        """
    )
    page.evaluate(
        """
        window.__manualSetCaption = (text) => {
          let caption = document.querySelector('.manual-caption');
          if (!caption) {
            caption = document.createElement('div');
            caption.className = 'manual-caption';
            document.body.appendChild(caption);
          }
          caption.textContent = text;
        };
        window.__manualHighlight = (selector) => {
          document.querySelectorAll('.manual-highlight').forEach((el) => el.classList.remove('manual-highlight'));
          const el = document.querySelector(selector);
          if (el) {
            el.classList.add('manual-highlight');
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        };
        """
    )


def _screenshot(page: Any, directory: Path, name: str) -> Path:
    path = directory / name
    page.screenshot(path=str(path), full_page=False)
    return path


def _manifest(
    result: PipelineResult,
    *,
    degradations: list[dict[str, str]] | None = None,
    environment: dict[str, str] | None = None,
) -> dict[str, Any]:
    package_dir = result.package_dir
    supporting_artifacts = {
        "request": str(package_dir / "request.json"),
        "input_extraction": str(result.artifacts.input_extraction),
        "planner_trace": str(package_dir / "planner_trace.json"),
        "rehearsal_log": str(package_dir / "rehearsal_log.json"),
        "playwright_mcp_calls": str(package_dir / "playwright_mcp_calls.json"),
        "playwright_mcp_execution": _optional_path(package_dir / "playwright_mcp_execution.json"),
        "audit_log": str(result.artifacts.audit_log),
        "capture_action_log": _optional_path(result.artifacts.capture_action_log),
        "tts_metadata": _optional_path(result.artifacts.tts_metadata),
        "video_render": _optional_path(result.artifacts.video_render_metadata),
        "skills_metadata": _optional_path(result.artifacts.skills_metadata),
        "opencode_prompt": str(package_dir / "opencode_prompt.md"),
        "opencode_metadata": _optional_path(result.artifacts.opencode_metadata),
        "hyperframes_composition": str(package_dir / "hyperframes" / "index.html"),
        "hyperframes_manifest": str(package_dir / "hyperframes" / "hyperframes_manifest.json"),
    }
    return {
        "job_id": result.job_id,
        "status": result.status,
        "package_dir": str(result.package_dir),
        "environment": environment or {},
        "degradations": degradations or [],
        "artifacts": {
            "html_preview": str(result.artifacts.html_preview),
            "markdown_manual": str(result.artifacts.markdown_manual),
            "pdf_manual": str(result.artifacts.pdf_manual),
            "video": str(result.artifacts.video),
            "action_plan": str(result.artifacts.action_plan),
            "approval_log": str(result.artifacts.approval_log),
            "masking_log": str(result.artifacts.masking_log),
            "package_manifest": str(result.artifacts.package_manifest),
            "audit_log": str(result.artifacts.audit_log),
            "input_extraction": str(result.artifacts.input_extraction),
            "final_frame": str(result.artifacts.final_frame) if result.artifacts.final_frame else None,
            "capture_action_log": str(result.artifacts.capture_action_log) if result.artifacts.capture_action_log else None,
            "tts_audio": [str(path) for path in result.artifacts.tts_audio],
            "tts_metadata": str(result.artifacts.tts_metadata) if result.artifacts.tts_metadata else None,
            "video_render": str(result.artifacts.video_render_metadata) if result.artifacts.video_render_metadata else None,
            "skills_metadata": str(result.artifacts.skills_metadata) if result.artifacts.skills_metadata else None,
            "opencode_metadata": str(result.artifacts.opencode_metadata) if result.artifacts.opencode_metadata else None,
        },
        "supporting_artifacts": supporting_artifacts,
    }


def _planner_audit_status(plan: dict[str, Any]) -> str:
    return "degraded" if plan.get("planner_error") else "ok"


def _planner_degrade_reason(plan: dict[str, Any]) -> str:
    return "planner_fallback" if plan.get("planner_error") else ""


def _rehearsal_audit_status(rehearsal: dict[str, Any]) -> str:
    status = str(rehearsal.get("status", ""))
    if status.endswith("failed"):
        return "degraded"
    if status in {"skipped", "manifest-only"}:
        return "skipped"
    return "ok"


def _rehearsal_degrade_reason(rehearsal: dict[str, Any]) -> str:
    status = str(rehearsal.get("status", ""))
    if status.endswith("failed"):
        return "playwright_mcp_live_failed"
    return ""


def _tts_degrade_reason(entries: list[dict[str, Any]]) -> str:
    if any(entry.get("provider") == "silent-fallback" for entry in entries):
        return "tts_silent_fallback"
    return ""


def _render_degrade_reason(used_fallback: bool, renderer: str) -> str:
    if used_fallback and renderer.lower() == "hyperframes":
        return "hyperframes_fallback_video"
    return ""


def _opencode_audit_status(opencode_result: Any) -> str:
    if getattr(opencode_result, "status", "") == "failed":
        return "degraded"
    return str(getattr(opencode_result, "status", ""))


def _opencode_degrade_reason(opencode_result: Any) -> str:
    if getattr(opencode_result, "status", "") == "failed":
        return "opencode_failed"
    return ""


def _read_manifest_degradations(manifest_path: Path) -> list[dict[str, str]]:
    if not manifest_path.exists():
        return []
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    degradations = data.get("degradations", [])
    return degradations if isinstance(degradations, list) else []


def _optional_path(path: Path | None) -> str | None:
    if path is None or not path.exists():
        return None
    return str(path)


def _write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def _escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _pdf_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)").replace("\n", "\\n")
