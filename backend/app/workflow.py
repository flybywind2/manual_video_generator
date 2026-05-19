from __future__ import annotations


class WorkflowStatus:
    AWAITING_PLAN_REVIEW = "awaiting_plan_review"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class WorkflowStep:
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
