import assert from "node:assert/strict";
import test from "node:test";

import * as workflow from "../../src/domain/state-machine.js";

const { StudioError, TRANSITIONS, transition } = workflow;

test("manual authentication reaches execution only after plan approval", () => {
  const path = [
    ["created", "START_AUTHENTICATION", "authenticating"],
    ["authenticating", "AUTH_REQUIRED", "awaiting_manual_login"],
    ["awaiting_manual_login", "CONFIRM_LOGIN", "planning"],
    ["awaiting_manual_login", "CONFIRM_REEXECUTION_LOGIN", "needs_review"],
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

test("plan edits are durable plan_review self transitions", () => {
  assert.equal(transition("plan_review", "UPDATE_PLAN"), "plan_review");
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
  assert.equal(transition("executing", "EXECUTION_PROGRESS"), "executing");
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

test("preview edits invalidate approval and return to the minimum required media stage", () => {
  assert.equal(transition("preview_review", "EDIT_NARRATION"), "narrating");
  assert.equal(transition("preview_review", "EDIT_COMPOSITION"), "composing");
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

test("persisted media failures resume only through their dedicated recovery events", () => {
  assert.equal(transition("failed", "RETRY_COMPOSITION"), "composing");
  assert.equal(transition("failed", "RETRY_RENDER"), "rendering");
  assert.throws(() => transition("failed", "APPROVE_PREVIEW"), {
    code: "INVALID_TRANSITION",
  });
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
  assert.throws(
    () =>
      transition(
        { toString: () => "approved" },
        { toString: () => "START_EXECUTION" },
      ),
    { code: "INVALID_TRANSITION", stage: "unknown" },
  );
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

test("every active state has an explicit cancellation event", () => {
  const activeStates = [
    "created",
    "authenticating",
    "awaiting_manual_login",
    "planning",
    "plan_review",
    "approved",
    "executing",
    "needs_review",
    "narrating",
    "composing",
    "preview_review",
    "rendering",
  ];

  for (const state of activeStates) {
    assert.equal(transition(state, "CANCEL_JOB"), "cancelled");
  }
  assert.equal(Object.isFrozen(TRANSITIONS.cancelled), true);
  assert.throws(() => transition("cancelled", "START_EXECUTION"), {
    code: "INVALID_TRANSITION",
  });
});

test("every active state can persist a safe background-operation rejection", () => {
  for (const state of Object.keys(TRANSITIONS)) {
    if (["cancelled", "completed", "failed"].includes(state)) continue;
    assert.equal(transition(state, "OPERATION_REJECTED"), state);
  }
});

test("failed render recovery can persist a rejection without losing failed state", () => {
  assert.equal(transition("failed", "OPERATION_REJECTED"), "failed");
});

test("authentication expiry returns browser-dependent states to authentication", () => {
  const browserDependentStates = [
    "awaiting_manual_login",
    "planning",
    "plan_review",
    "approved",
    "executing",
    "needs_review",
  ];

  for (const state of browserDependentStates) {
    assert.equal(
      transition(state, "AUTHENTICATION_EXPIRED"),
      "authenticating",
    );
  }
  assert.throws(() => transition("narrating", "AUTHENTICATION_EXPIRED"), {
    code: "INVALID_TRANSITION",
  });
});

test("failure descriptors persist exact safe resume provenance", () => {
  const planDigest = "a".repeat(64);
  const resumableFailures = [
    ["authenticating", "AUTHENTICATION_FAILED", "authenticating", null],
    ["planning", "PLANNING_FAILED", "planning", null],
    ["executing", "EXECUTION_FAILED", "approved", planDigest],
    ["narrating", "NARRATION_FAILED", "narrating", planDigest],
    ["composing", "COMPOSITION_FAILED", "composing", planDigest],
    ["rendering", "RENDER_FAILED", "rendering", planDigest],
  ];

  for (const [index, [failedFrom, failedEvent, resumeFrom, digest]] of
    resumableFailures.entries()) {
    const eventSequence = index + 10;
    const descriptor = workflow.createFailureDescriptor({
      jobId: "job-123",
      eventSequence,
      planDigest: digest,
      failedFrom,
      failedEvent,
    });
    assert.equal(Object.isFrozen(descriptor), true);
    assert.deepEqual(descriptor, {
      jobId: "job-123",
      eventSequence,
      planDigest: digest,
      failedFrom,
      failedEvent,
      resumeFrom,
    });

    const persisted = JSON.parse(JSON.stringify(descriptor));
    assert.equal(
      workflow.resumeFailure(persisted, {
        currentState: "failed",
        jobId: "job-123",
        eventSequence,
        planDigest: digest,
        requestedResumeFrom: resumeFrom,
      }),
      resumeFrom,
    );
  }

  const executionFailure = workflow.createFailureDescriptor({
    jobId: "job-123",
    eventSequence: 42,
    planDigest,
    failedFrom: "executing",
    failedEvent: "EXECUTION_FAILED",
  });
  assert.equal(
    workflow.resumeFailure(executionFailure, {
      currentState: "failed",
      jobId: "job-123",
      eventSequence: 42,
      planDigest,
      requestedResumeFrom: "approved",
    }),
    "approved",
  );
  assert.equal(transition("approved", "START_EXECUTION"), "executing");
});

test("failure retry rejects forged provenance and direct execution bypass", () => {
  const planDigest = "a".repeat(64);
  assert.throws(
    () =>
      workflow.createFailureDescriptor({
        jobId: "job-123",
        eventSequence: 4,
        planDigest,
        failedFrom: { toString: () => "executing" },
        failedEvent: "EXECUTION_FAILED",
      }),
    { code: "INVALID_FAILURE_DESCRIPTOR" },
  );

  const selfAttested = {
    failedFrom: "executing",
    failedEvent: "EXECUTION_FAILED",
    resumeFrom: "approved",
  };
  assert.throws(
    () =>
      workflow.resumeFailure(selfAttested, {
        currentState: "failed",
        jobId: "job-123",
        eventSequence: 4,
        planDigest,
        requestedResumeFrom: "approved",
      }),
    { code: "INVALID_FAILURE_DESCRIPTOR" },
  );

  const stored = workflow.createFailureDescriptor({
    jobId: "job-123",
    eventSequence: 4,
    planDigest,
    failedFrom: "executing",
    failedEvent: "EXECUTION_FAILED",
  });
  const validContext = {
    currentState: "failed",
    jobId: "job-123",
    eventSequence: 4,
    planDigest,
    requestedResumeFrom: "approved",
  };
  for (const forgedContext of [
    { ...validContext, currentState: "executing" },
    { ...validContext, jobId: "job-other" },
    { ...validContext, eventSequence: 5 },
    { ...validContext, planDigest: "b".repeat(64) },
    { ...validContext, requestedResumeFrom: "executing" },
  ]) {
    assert.throws(() => workflow.resumeFailure(stored, forgedContext), {
      code: "INVALID_FAILURE_DESCRIPTOR",
    });
  }

  const inherited = Object.create({
    ...stored,
  });
  assert.throws(() => workflow.resumeFailure(inherited, validContext), {
    code: "INVALID_FAILURE_DESCRIPTOR",
  });

  Object.prototype.resumeFrom = "executing";
  try {
    assert.throws(
      () =>
        workflow.resumeFailure(
          {
            jobId: "job-123",
            eventSequence: 4,
            planDigest,
            failedFrom: "executing",
            failedEvent: "EXECUTION_FAILED",
          },
          validContext,
        ),
      { code: "INVALID_FAILURE_DESCRIPTOR" },
    );
  } finally {
    delete Object.prototype.resumeFrom;
  }

  assert.throws(() => transition("failed", "START_EXECUTION"), {
    code: "INVALID_TRANSITION",
  });
  assert.throws(() => transition("failed", "RETRY_EXECUTION"), {
    code: "INVALID_TRANSITION",
  });
});

test("reauthentication provenance restores only a validated safe state", () => {
  const planDigest = "a".repeat(64);
  const resumableStates = [
    ["awaiting_manual_login", "awaiting_manual_login", null],
    ["planning", "planning", null],
    ["plan_review", "plan_review", null],
    ["approved", "approved", planDigest],
    ["executing", "needs_review", planDigest],
    ["needs_review", "needs_review", planDigest],
  ];

  for (const [index, [expiredFrom, resumeFrom, digest]] of
    resumableStates.entries()) {
    const eventSequence = index + 30;
    const descriptor = workflow.createReauthenticationDescriptor({
      jobId: "job-123",
      eventSequence,
      planDigest: digest,
      expiredFrom,
    });
    assert.equal(Object.isFrozen(descriptor), true);
    assert.equal(
      workflow.resumeAfterAuthentication(descriptor, {
        currentState: "authenticating",
        jobId: "job-123",
        eventSequence,
        planDigest: digest,
        requestedResumeFrom: resumeFrom,
      }),
      resumeFrom,
    );
  }

  const executionExpiry = workflow.createReauthenticationDescriptor({
    jobId: "job-123",
    eventSequence: 50,
    planDigest,
    expiredFrom: "executing",
  });
  assert.throws(
    () =>
      workflow.resumeAfterAuthentication(executionExpiry, {
        currentState: "authenticating",
        jobId: "job-123",
        eventSequence: 50,
        planDigest,
        requestedResumeFrom: "executing",
      }),
    { code: "INVALID_REAUTHENTICATION_DESCRIPTOR" },
  );
});

test("cancellation provenance resumes only from the stored safe stage", () => {
  const planDigest = "a".repeat(64);
  const resumableStates = [
    ["created", "created", null],
    ["authenticating", "authenticating", null],
    ["awaiting_manual_login", "authenticating", null],
    ["planning", "planning", null],
    ["plan_review", "plan_review", null],
    ["approved", "approved", planDigest],
    ["executing", "approved", planDigest],
    ["needs_review", "needs_review", planDigest],
    ["narrating", "narrating", planDigest],
    ["composing", "composing", planDigest],
    ["preview_review", "preview_review", planDigest],
    ["rendering", "rendering", planDigest],
  ];

  for (const [index, [cancelledFrom, resumeFrom, digest]] of
    resumableStates.entries()) {
    const eventSequence = index + 60;
    const descriptor = workflow.createCancellationDescriptor({
      jobId: "job-123",
      eventSequence,
      planDigest: digest,
      cancelledFrom,
    });
    assert.equal(Object.isFrozen(descriptor), true);
    assert.equal(
      workflow.resumeCancellation(descriptor, {
        currentState: "cancelled",
        jobId: "job-123",
        eventSequence,
        planDigest: digest,
        requestedResumeFrom: resumeFrom,
      }),
      resumeFrom,
    );
  }

  const executionCancellation = workflow.createCancellationDescriptor({
    jobId: "job-123",
    eventSequence: 80,
    planDigest,
    cancelledFrom: "executing",
  });
  assert.throws(
    () =>
      workflow.resumeCancellation(executionCancellation, {
        currentState: "cancelled",
        jobId: "job-123",
        eventSequence: 80,
        planDigest,
        requestedResumeFrom: "executing",
      }),
    { code: "INVALID_CANCELLATION_DESCRIPTOR" },
  );
});

test("StudioError public serialization never exposes internal messages or detail values", () => {
  const secret = "innocent-key-secret-value";
  const error = new StudioError(`internal diagnostic: ${secret}`, {
    code: `UNSAFE_${secret}`,
    stage: secret,
    retryable: true,
    details: { context: secret },
  });

  const serialized = JSON.stringify(error);
  const payload = JSON.parse(serialized);
  assert.equal(serialized.includes(secret), false);
  assert.equal(Object.hasOwn(payload, "message"), false);
  assert.equal(payload.publicMessage, "The operation could not be completed.");
  assert.equal(payload.code, "STUDIO_ERROR");
  assert.equal(payload.stage, "unknown");
  assert.deepEqual(payload.details, { redacted: true });

  const trusted = new StudioError("internal diagnostic", {
    code: "INVALID_PLAN",
    stage: "planning",
    retryable: false,
  });
  trusted.name = "TOPSECRET123";
  trusted.code = "TOPSECRET123";
  trusted.stage = "topsecret123";
  trusted.retryable = "leaked-secret";
  trusted.details = { context: "TOPSECRET123" };
  const mutatedPayload = JSON.parse(JSON.stringify(trusted));
  assert.deepEqual(mutatedPayload, {
    name: "StudioError",
    publicMessage: "The operation could not be completed.",
    code: "INVALID_PLAN",
    stage: "planning",
    retryable: false,
    details: {},
  });
});
