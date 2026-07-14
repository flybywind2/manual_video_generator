import { StudioError } from "./errors.js";

const freeze = (transitions) => Object.freeze(transitions);

export const TRANSITIONS = Object.freeze({
  created: freeze({
    CANCEL_JOB: "cancelled",
    START_AUTHENTICATION: "authenticating",
  }),
  authenticating: freeze({
    AUTHENTICATED: "planning",
    AUTHENTICATION_FAILED: "failed",
    AUTH_REQUIRED: "awaiting_manual_login",
    CANCEL_JOB: "cancelled",
  }),
  awaiting_manual_login: freeze({
    AUTHENTICATION_EXPIRED: "authenticating",
    CANCEL_JOB: "cancelled",
    CONFIRM_LOGIN: "planning",
  }),
  planning: freeze({
    AUTHENTICATION_EXPIRED: "authenticating",
    CANCEL_JOB: "cancelled",
    PLAN_READY: "plan_review",
    PLANNING_FAILED: "failed",
  }),
  plan_review: freeze({
    APPROVE_PLAN: "approved",
    AUTHENTICATION_EXPIRED: "authenticating",
    CANCEL_JOB: "cancelled",
    UPDATE_PLAN: "plan_review",
  }),
  approved: freeze({
    AUTHENTICATION_EXPIRED: "authenticating",
    CANCEL_JOB: "cancelled",
    START_EXECUTION: "executing",
  }),
  executing: freeze({
    AUTHENTICATION_EXPIRED: "authenticating",
    CANCEL_JOB: "cancelled",
    EXECUTION_COMPLETED: "narrating",
    EXECUTION_FAILED: "failed",
    EXECUTION_MISMATCH: "needs_review",
    EXECUTION_PROGRESS: "executing",
  }),
  needs_review: freeze({
    AUTHENTICATION_EXPIRED: "authenticating",
    CANCEL_JOB: "cancelled",
    REAPPROVE_EXECUTION: "executing",
  }),
  narrating: freeze({
    CANCEL_JOB: "cancelled",
    NARRATION_COMPLETED: "composing",
    NARRATION_FAILED: "failed",
  }),
  composing: freeze({
    CANCEL_JOB: "cancelled",
    COMPOSITION_COMPLETED: "preview_review",
    COMPOSITION_FAILED: "failed",
  }),
  preview_review: freeze({
    APPROVE_PREVIEW: "rendering",
    CANCEL_JOB: "cancelled",
    EDIT_COMPOSITION: "composing",
    EDIT_NARRATION: "narrating",
  }),
  rendering: freeze({
    CANCEL_JOB: "cancelled",
    RENDER_COMPLETED: "completed",
    RENDER_FAILED: "failed",
  }),
  cancelled: freeze({}),
  completed: freeze({}),
  failed: freeze({}),
});

const resumeSpec = (resumeFrom, planRequired) =>
  Object.freeze({ resumeFrom, planRequired });

const FAILURE_RESUME = Object.freeze({
  authenticating: freeze({
    AUTHENTICATION_FAILED: resumeSpec("authenticating", false),
  }),
  planning: freeze({
    PLANNING_FAILED: resumeSpec("planning", false),
  }),
  executing: freeze({
    EXECUTION_FAILED: resumeSpec("approved", true),
  }),
  narrating: freeze({
    NARRATION_FAILED: resumeSpec("narrating", true),
  }),
  composing: freeze({
    COMPOSITION_FAILED: resumeSpec("composing", true),
  }),
  rendering: freeze({
    RENDER_FAILED: resumeSpec("rendering", true),
  }),
});

const REAUTHENTICATION_RESUME = Object.freeze({
  awaiting_manual_login: resumeSpec("awaiting_manual_login", false),
  planning: resumeSpec("planning", false),
  plan_review: resumeSpec("plan_review", false),
  approved: resumeSpec("approved", true),
  executing: resumeSpec("needs_review", true),
  needs_review: resumeSpec("needs_review", true),
});

const CANCELLATION_RESUME = Object.freeze({
  created: resumeSpec("created", false),
  authenticating: resumeSpec("authenticating", false),
  awaiting_manual_login: resumeSpec("authenticating", false),
  planning: resumeSpec("planning", false),
  plan_review: resumeSpec("plan_review", false),
  approved: resumeSpec("approved", true),
  executing: resumeSpec("approved", true),
  needs_review: resumeSpec("needs_review", true),
  narrating: resumeSpec("narrating", true),
  composing: resumeSpec("composing", true),
  preview_review: resumeSpec("preview_review", true),
  rendering: resumeSpec("rendering", true),
});

const CREATE_FAILURE_FIELDS = Object.freeze([
  "jobId",
  "eventSequence",
  "planDigest",
  "failedFrom",
  "failedEvent",
]);
const FAILURE_DESCRIPTOR_FIELDS = Object.freeze([
  ...CREATE_FAILURE_FIELDS,
  "resumeFrom",
]);
const CREATE_REAUTHENTICATION_FIELDS = Object.freeze([
  "jobId",
  "eventSequence",
  "planDigest",
  "expiredFrom",
]);
const REAUTHENTICATION_DESCRIPTOR_FIELDS = Object.freeze([
  ...CREATE_REAUTHENTICATION_FIELDS,
  "resumeFrom",
]);
const CREATE_CANCELLATION_FIELDS = Object.freeze([
  "jobId",
  "eventSequence",
  "planDigest",
  "cancelledFrom",
]);
const CANCELLATION_DESCRIPTOR_FIELDS = Object.freeze([
  ...CREATE_CANCELLATION_FIELDS,
  "resumeFrom",
]);
const RESUME_CONTEXT_FIELDS = Object.freeze([
  "currentState",
  "jobId",
  "eventSequence",
  "planDigest",
  "requestedResumeFrom",
]);
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const PLAN_DIGEST = /^[a-f0-9]{64}$/u;

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
  const stateTransitions =
    typeof from === "string" && Object.hasOwn(TRANSITIONS, from)
    ? TRANSITIONS[from]
    : undefined;
  const next =
    typeof event === "string" &&
    stateTransitions !== undefined &&
    Object.hasOwn(stateTransitions, event)
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

const DESCRIPTOR_ERRORS = Object.freeze({
  cancellation: Object.freeze({
    code: "INVALID_CANCELLATION_DESCRIPTOR",
    message: "The cancellation resume descriptor is invalid.",
    stage: "cancelled",
  }),
  failure: Object.freeze({
    code: "INVALID_FAILURE_DESCRIPTOR",
    message: "The failure retry descriptor is invalid.",
    stage: "failed",
  }),
  reauthentication: Object.freeze({
    code: "INVALID_REAUTHENTICATION_DESCRIPTOR",
    message: "The reauthentication resume descriptor is invalid.",
    stage: "authenticating",
  }),
});

function invalidDescriptor(kind, reason) {
  const metadata = DESCRIPTOR_ERRORS[kind];
  throw new StudioError(metadata.message, {
    code: metadata.code,
    stage: metadata.stage,
    retryable: false,
    details: { reason },
  });
}

function exactOwnValues(value, fields, kind) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      invalidDescriptor(kind, "plain_object_required");
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalidDescriptor(kind, "plain_object_required");
    }

    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== fields.length ||
      !ownKeys.every(
        (key) => typeof key === "string" && fields.includes(key),
      )
    ) {
      invalidDescriptor(kind, "fields_mismatch");
    }

    const values = Object.create(null);
    for (const field of fields) {
      const property = Object.getOwnPropertyDescriptor(value, field);
      if (property === undefined || !("value" in property)) {
        invalidDescriptor(kind, "data_properties_required");
      }
      values[field] = property.value;
    }
    return values;
  } catch (error) {
    if (error instanceof StudioError) {
      throw error;
    }
    invalidDescriptor(kind, "inspection_failed");
  }
}

function validateBinding(values, planRequired, kind) {
  if (typeof values.jobId !== "string" || !JOB_ID.test(values.jobId)) {
    invalidDescriptor(kind, "invalid_job_id");
  }
  if (
    !Number.isSafeInteger(values.eventSequence) ||
    values.eventSequence < 0
  ) {
    invalidDescriptor(kind, "invalid_event_sequence");
  }
  if (
    (planRequired &&
      (typeof values.planDigest !== "string" ||
        !PLAN_DIGEST.test(values.planDigest))) ||
    (!planRequired && values.planDigest !== null)
  ) {
    invalidDescriptor(kind, "invalid_plan_digest");
  }
}

function failureResumeSpec(failedFrom, failedEvent) {
  if (
    typeof failedFrom !== "string" ||
    typeof failedEvent !== "string" ||
    !Object.hasOwn(FAILURE_RESUME, failedFrom)
  ) {
    return undefined;
  }
  const stageFailures = FAILURE_RESUME[failedFrom];
  return Object.hasOwn(stageFailures, failedEvent)
    ? stageFailures[failedEvent]
    : undefined;
}

function stateResumeSpec(mapping, from) {
  return typeof from === "string" && Object.hasOwn(mapping, from)
    ? mapping[from]
    : undefined;
}

function validateResumeContext(
  context,
  descriptor,
  spec,
  terminalState,
  kind,
) {
  const values = exactOwnValues(context, RESUME_CONTEXT_FIELDS, kind);
  validateBinding(values, spec.planRequired, kind);

  if (
    values.currentState !== terminalState ||
    values.jobId !== descriptor.jobId ||
    values.eventSequence !== descriptor.eventSequence ||
    values.planDigest !== descriptor.planDigest ||
    values.requestedResumeFrom !== spec.resumeFrom
  ) {
    invalidDescriptor(kind, "current_job_binding_mismatch");
  }

  return spec.resumeFrom;
}

export function createFailureDescriptor(input) {
  const values = exactOwnValues(input, CREATE_FAILURE_FIELDS, "failure");
  const spec = failureResumeSpec(values.failedFrom, values.failedEvent);
  if (spec === undefined) {
    invalidDescriptor("failure", "unsupported_failure_provenance");
  }
  validateBinding(values, spec.planRequired, "failure");

  return Object.freeze({
    jobId: values.jobId,
    eventSequence: values.eventSequence,
    planDigest: values.planDigest,
    failedFrom: values.failedFrom,
    failedEvent: values.failedEvent,
    resumeFrom: spec.resumeFrom,
  });
}

export function resumeFailure(descriptor, context) {
  const values = exactOwnValues(
    descriptor,
    FAILURE_DESCRIPTOR_FIELDS,
    "failure",
  );
  const spec = failureResumeSpec(values.failedFrom, values.failedEvent);
  if (spec === undefined || values.resumeFrom !== spec.resumeFrom) {
    invalidDescriptor("failure", "resume_target_mismatch");
  }
  validateBinding(values, spec.planRequired, "failure");
  return validateResumeContext(context, values, spec, "failed", "failure");
}

export function createReauthenticationDescriptor(input) {
  const values = exactOwnValues(
    input,
    CREATE_REAUTHENTICATION_FIELDS,
    "reauthentication",
  );
  const spec = stateResumeSpec(REAUTHENTICATION_RESUME, values.expiredFrom);
  if (spec === undefined) {
    invalidDescriptor("reauthentication", "unsupported_expiry_provenance");
  }
  validateBinding(values, spec.planRequired, "reauthentication");

  return Object.freeze({
    jobId: values.jobId,
    eventSequence: values.eventSequence,
    planDigest: values.planDigest,
    expiredFrom: values.expiredFrom,
    resumeFrom: spec.resumeFrom,
  });
}

export function resumeAfterAuthentication(descriptor, context) {
  const values = exactOwnValues(
    descriptor,
    REAUTHENTICATION_DESCRIPTOR_FIELDS,
    "reauthentication",
  );
  const spec = stateResumeSpec(REAUTHENTICATION_RESUME, values.expiredFrom);
  if (spec === undefined || values.resumeFrom !== spec.resumeFrom) {
    invalidDescriptor("reauthentication", "resume_target_mismatch");
  }
  validateBinding(values, spec.planRequired, "reauthentication");
  return validateResumeContext(
    context,
    values,
    spec,
    "authenticating",
    "reauthentication",
  );
}

export function createCancellationDescriptor(input) {
  const values = exactOwnValues(
    input,
    CREATE_CANCELLATION_FIELDS,
    "cancellation",
  );
  const spec = stateResumeSpec(CANCELLATION_RESUME, values.cancelledFrom);
  if (spec === undefined) {
    invalidDescriptor("cancellation", "unsupported_cancellation_provenance");
  }
  validateBinding(values, spec.planRequired, "cancellation");

  return Object.freeze({
    jobId: values.jobId,
    eventSequence: values.eventSequence,
    planDigest: values.planDigest,
    cancelledFrom: values.cancelledFrom,
    resumeFrom: spec.resumeFrom,
  });
}

export function resumeCancellation(descriptor, context) {
  const values = exactOwnValues(
    descriptor,
    CANCELLATION_DESCRIPTOR_FIELDS,
    "cancellation",
  );
  const spec = stateResumeSpec(CANCELLATION_RESUME, values.cancelledFrom);
  if (spec === undefined || values.resumeFrom !== spec.resumeFrom) {
    invalidDescriptor("cancellation", "resume_target_mismatch");
  }
  validateBinding(values, spec.planRequired, "cancellation");
  return validateResumeContext(
    context,
    values,
    spec,
    "cancelled",
    "cancellation",
  );
}

export { StudioError };
