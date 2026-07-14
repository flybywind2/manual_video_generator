import assert from "node:assert/strict";
import test from "node:test";

import {
  StudioError,
  TRANSITIONS,
  transition,
} from "../../src/domain/state-machine.js";

test("manual authentication reaches execution only after plan approval", () => {
  const path = [
    ["created", "START_AUTHENTICATION", "authenticating"],
    ["authenticating", "AUTH_REQUIRED", "awaiting_manual_login"],
    ["awaiting_manual_login", "CONFIRM_LOGIN", "planning"],
    ["planning", "PLAN_READY", "plan_review"],
    ["plan_review", "APPROVE_PLAN", "approved"],
    ["approved", "START_EXECUTION", "executing"],
  ];

  for (const [from, event, expected] of path) {
    assert.equal(transition(from, event), expected);
  }
});

test("automatic authentication can proceed to planning without bypassing authentication", () => {
  assert.equal(transition("authenticating", "AUTHENTICATED"), "planning");
});

test("plan review cannot start narration or execution before explicit approval", () => {
  assert.throws(() => transition("plan_review", "START_NARRATION"), {
    code: "INVALID_TRANSITION",
  });
  assert.throws(() => transition("plan_review", "START_EXECUTION"), {
    code: "INVALID_TRANSITION",
  });
});

test("invalid transitions expose only safe workflow context", () => {
  assert.throws(
    () => transition("plan_review", "START_NARRATION"),
    (error) => {
      assert.ok(error instanceof StudioError);
      assert.equal(error.code, "INVALID_TRANSITION");
      assert.equal(error.stage, "plan_review");
      assert.equal(error.retryable, false);
      assert.deepEqual(error.details, {
        event: "START_NARRATION",
        from: "plan_review",
      });
      assert.equal(JSON.stringify(error).includes("password"), false);
      return true;
    },
  );
});

test("execution mismatch pauses and explicit reapproval resumes execution", () => {
  assert.equal(transition("executing", "EXECUTION_MISMATCH"), "needs_review");
  assert.equal(transition("needs_review", "REAPPROVE_EXECUTION"), "executing");
});

test("successful production stages follow the approved diagram", () => {
  const path = [
    ["executing", "EXECUTION_COMPLETED", "narrating"],
    ["narrating", "NARRATION_COMPLETED", "composing"],
    ["composing", "COMPOSITION_COMPLETED", "preview_review"],
    ["preview_review", "APPROVE_PREVIEW", "rendering"],
    ["rendering", "RENDER_COMPLETED", "completed"],
  ];

  for (const [from, event, expected] of path) {
    assert.equal(transition(from, event), expected);
  }
});

test("each fallible stage has an explicit named failure event", () => {
  const failures = [
    ["authenticating", "AUTHENTICATION_FAILED"],
    ["planning", "PLANNING_FAILED"],
    ["executing", "EXECUTION_FAILED"],
    ["narrating", "NARRATION_FAILED"],
    ["composing", "COMPOSITION_FAILED"],
    ["rendering", "RENDER_FAILED"],
  ];

  for (const [from, event] of failures) {
    assert.equal(transition(from, event), "failed");
  }
});

test("transition table and every state map are frozen", () => {
  assert.equal(Object.isFrozen(TRANSITIONS), true);
  for (const stateTransitions of Object.values(TRANSITIONS)) {
    assert.equal(Object.isFrozen(stateTransitions), true);
  }
});

test("unknown states and events have no implicit fallback", () => {
  assert.throws(() => transition("not_a_state", "PLAN_READY"), {
    code: "INVALID_TRANSITION",
    stage: "not_a_state",
  });
  assert.throws(() => transition("created", "NOT_AN_EVENT"), {
    code: "INVALID_TRANSITION",
    stage: "created",
  });
});

test("inherited properties cannot act as workflow events", () => {
  assert.throws(() => transition("plan_review", "constructor"), {
    code: "INVALID_TRANSITION",
  });

  Object.prototype.START_EXECUTION = "executing";
  try {
    assert.throws(() => transition("plan_review", "START_EXECUTION"), {
      code: "INVALID_TRANSITION",
    });
  } finally {
    delete Object.prototype.START_EXECUTION;
  }
});
