import { StudioError } from "./errors.js";

const freeze = (transitions) => Object.freeze(transitions);

export const TRANSITIONS = Object.freeze({
  created: freeze({
    START_AUTHENTICATION: "authenticating",
  }),
  authenticating: freeze({
    AUTHENTICATED: "planning",
    AUTHENTICATION_FAILED: "failed",
    AUTH_REQUIRED: "awaiting_manual_login",
  }),
  awaiting_manual_login: freeze({
    CONFIRM_LOGIN: "planning",
  }),
  planning: freeze({
    PLAN_READY: "plan_review",
    PLANNING_FAILED: "failed",
  }),
  plan_review: freeze({
    APPROVE_PLAN: "approved",
  }),
  approved: freeze({
    START_EXECUTION: "executing",
  }),
  executing: freeze({
    EXECUTION_COMPLETED: "narrating",
    EXECUTION_FAILED: "failed",
    EXECUTION_MISMATCH: "needs_review",
  }),
  needs_review: freeze({
    REAPPROVE_EXECUTION: "executing",
  }),
  narrating: freeze({
    NARRATION_COMPLETED: "composing",
    NARRATION_FAILED: "failed",
  }),
  composing: freeze({
    COMPOSITION_COMPLETED: "preview_review",
    COMPOSITION_FAILED: "failed",
  }),
  preview_review: freeze({
    APPROVE_PREVIEW: "rendering",
  }),
  rendering: freeze({
    RENDER_COMPLETED: "completed",
    RENDER_FAILED: "failed",
  }),
  completed: freeze({}),
  failed: freeze({}),
});

function safeState(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
    ? value
    : "unknown";
}

function safeEvent(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value)
    ? value
    : "UNKNOWN";
}

export function transition(from, event) {
  const stateTransitions = Object.hasOwn(TRANSITIONS, from)
    ? TRANSITIONS[from]
    : undefined;
  const next =
    stateTransitions !== undefined && Object.hasOwn(stateTransitions, event)
      ? stateTransitions[event]
      : undefined;
  if (next === undefined) {
    const stage = safeState(from);
    throw new StudioError("The workflow event is not valid for the current state.", {
      code: "INVALID_TRANSITION",
      stage,
      retryable: false,
      details: {
        event: safeEvent(event),
        from: stage,
      },
    });
  }

  return next;
}

export { StudioError };
