from __future__ import annotations


class WorkflowStatus:
    AWAITING_PLAN_REVIEW = "awaiting_plan_review"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class WorkflowStep:
    REQUEST_VALIDATION = "request_validation"
    BROWSER_SESSION = "browser_session"
    OPENCODE_DISCOVERY = "opencode_discovery"
    TRACE_VALIDATION = "trace_validation"
    PLAN_REVIEW = "plan_review"
    CAPTURE = "capture"
    MCP_REHEARSAL_AFTER_LOGIN = "mcp_rehearsal_after_login"
    REPLAY = "replay"
    MASKING = "masking"
    TTS = "tts"
    PREVIEW = "preview"
    RENDER = "render"
    OPENCODE = "opencode"
    MANIFEST = "manifest"
    COMPLETED = "completed"
    EXECUTION_FAILED = "execution_failed"


WORKFLOW_STEPS = {
    WorkflowStep.REQUEST_VALIDATION,
    WorkflowStep.BROWSER_SESSION,
    WorkflowStep.OPENCODE_DISCOVERY,
    WorkflowStep.TRACE_VALIDATION,
    WorkflowStep.PLAN_REVIEW,
    WorkflowStep.CAPTURE,
    WorkflowStep.MCP_REHEARSAL_AFTER_LOGIN,
    WorkflowStep.REPLAY,
    WorkflowStep.MASKING,
    WorkflowStep.TTS,
    WorkflowStep.PREVIEW,
    WorkflowStep.RENDER,
    WorkflowStep.OPENCODE,
    WorkflowStep.MANIFEST,
    WorkflowStep.COMPLETED,
    WorkflowStep.EXECUTION_FAILED,
}
