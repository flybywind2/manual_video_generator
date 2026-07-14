import { timingSafeEqual } from "node:crypto";
import { extname, posix } from "node:path";

import { StudioError } from "./errors.js";
import { compileExecutionCalls } from "./execution-calls.js";
import { assertApprovedPlan } from "./plan.js";

const REPORT_FIELDS = Object.freeze([
  "schemaVersion",
  "jobId",
  "planDigest",
  "status",
  "startedAt",
  "endedAt",
  "finalOrigin",
  "recordingPath",
  "stoppedStepId",
  "toolCalls",
  "steps",
]);
const STEP_FIELDS = Object.freeze([
  "id",
  "startedAt",
  "endedAt",
  "observedOrigin",
  "elementEvidence",
  "screenshotPath",
  "expectedStatus",
  "expectedEvidence",
  "actionCallIds",
]);
const TOOL_FIELDS = Object.freeze(["id", "tool"]);
const JOB_ID = /^(?:job-[a-z0-9]{16,64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

function invalid(reason) {
  throw new StudioError("The execution report is invalid.", {
    code: "INVALID_EXECUTION_REPORT",
    stage: "executing",
    retryable: false,
    details: { reason },
  });
}

function isPlain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, fields, reason) {
  if (!isPlain(value)) invalid(reason);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) {
    invalid(reason);
  }
  const output = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid(reason);
    output[field] = descriptor.value;
  }
  return output;
}

function denseArray(value, minimum, maximum, reason) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum
  ) {
    invalid(reason);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)))
  ) {
    invalid(reason);
  }
  return value.map((_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid(reason);
    return descriptor.value;
  });
}

function boundedString(value, maximum, reason) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    invalid(reason);
  }
  return value;
}

function timestamp(value, reason) {
  if (typeof value !== "string") invalid(reason);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid(reason);
  return value;
}

function origin(value, reason) {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== value
    ) {
      invalid(reason);
    }
    return url.origin;
  } catch (error) {
    if (error instanceof StudioError) throw error;
    invalid(reason);
  }
}

function artifactPath(value, extensions, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    posix.isAbsolute(value) ||
    !value.startsWith("browser/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !extensions.has(extname(value).toLowerCase())
  ) {
    invalid("unsafe_artifact_path");
  }
  return value;
}

function equalDigest(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    !/^[a-f0-9]{64}$/u.test(left) ||
    !/^[a-f0-9]{64}$/u.test(right)
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function normalizedToolCalls(value, expected, completed) {
  const calls = denseArray(value, 1, expected.length, "invalid_tool_calls").map((candidate, index) => {
    const fields = exactObject(candidate, TOOL_FIELDS, "invalid_tool_call");
    if (
      fields.id !== expected[index]?.id ||
      fields.tool !== expected[index]?.tool
    ) {
      invalid("tool_call_drift");
    }
    return Object.freeze({ id: fields.id, tool: fields.tool });
  });
  if (completed && calls.length !== expected.length) invalid("incomplete_tool_calls");
  return Object.freeze(calls);
}

function normalizedStep(candidate, expected, reportStart, reportEnd, allowMismatch) {
  const fields = exactObject(candidate, STEP_FIELDS, "invalid_step_evidence");
  if (fields.id !== expected.id) invalid("step_id_drift");
  const startedAt = timestamp(fields.startedAt, "invalid_step_start");
  const endedAt = timestamp(fields.endedAt, "invalid_step_end");
  if (startedAt < reportStart || endedAt > reportEnd || startedAt > endedAt) {
    invalid("invalid_step_range");
  }
  const expectedStatus = fields.expectedStatus;
  if (
    expectedStatus !== "passed" &&
    !(allowMismatch && expectedStatus === "mismatch")
  ) {
    invalid("invalid_expected_status");
  }
  const actionCallIds = denseArray(
    fields.actionCallIds,
    expected.calls.length,
    expected.calls.length,
    "invalid_action_call_ids",
  ).map((id, index) => {
    if (id !== expected.calls[index].id) invalid("action_call_drift");
    return id;
  });
  return Object.freeze({
    id: fields.id,
    startedAt,
    endedAt,
    observedOrigin: origin(fields.observedOrigin, "invalid_observed_origin"),
    elementEvidence: boundedString(fields.elementEvidence, 4_000, "invalid_element_evidence"),
    screenshotPath: artifactPath(fields.screenshotPath, new Set([".jpeg", ".jpg", ".png"]), {
      nullable: expectedStatus === "mismatch",
    }),
    expectedStatus,
    expectedEvidence: boundedString(fields.expectedEvidence, 4_000, "invalid_expected_evidence"),
    actionCallIds: Object.freeze(actionCallIds),
  });
}

function inspectOptions(options) {
  const fields = exactObject(options, ["jobId", "plan", "planDigest"], "invalid_options");
  if (typeof fields.jobId !== "string" || !JOB_ID.test(fields.jobId)) invalid("invalid_job_id");
  const plan = assertApprovedPlan(fields.plan, fields.planDigest);
  return { jobId: fields.jobId, plan, planDigest: fields.planDigest };
}

export function validateExecutionReport(candidate, options) {
  const binding = inspectOptions(options);
  const fields = exactObject(candidate, REPORT_FIELDS, "invalid_report_fields");
  if (
    fields.schemaVersion !== "1.0" ||
    fields.jobId !== binding.jobId ||
    !equalDigest(fields.planDigest, binding.planDigest) ||
    !["completed", "mismatch"].includes(fields.status)
  ) {
    invalid("report_binding_mismatch");
  }
  const completed = fields.status === "completed";
  const startedAt = timestamp(fields.startedAt, "invalid_report_start");
  const endedAt = timestamp(fields.endedAt, "invalid_report_end");
  if (startedAt > endedAt) invalid("invalid_report_range");
  const finalOrigin = origin(fields.finalOrigin, "invalid_final_origin");
  if (completed && finalOrigin !== binding.plan.targetOrigin) invalid("final_origin_drift");

  const expectedCalls = compileExecutionCalls(binding.plan);
  const toolCalls = normalizedToolCalls(fields.toolCalls, expectedCalls, completed);
  const sourceSteps = denseArray(
    fields.steps,
    1,
    binding.plan.steps.length,
    "invalid_report_steps",
  );
  if (completed && sourceSteps.length !== binding.plan.steps.length) invalid("missing_steps");
  const steps = sourceSteps.map((step, index) => normalizedStep(
    step,
    binding.plan.steps[index],
    startedAt,
    endedAt,
    !completed && index === sourceSteps.length - 1,
  ));
  for (let index = 1; index < steps.length; index += 1) {
    if (steps[index].startedAt < steps[index - 1].endedAt) invalid("overlapping_steps");
  }
  if (completed) {
    if (fields.stoppedStepId !== null || steps.some((step) => step.expectedStatus !== "passed")) {
      invalid("completed_report_mismatch");
    }
  } else {
    const last = steps.at(-1);
    if (
      typeof fields.stoppedStepId !== "string" ||
      fields.stoppedStepId !== last.id ||
      last.expectedStatus !== "mismatch" ||
      steps.slice(0, -1).some((step) => step.expectedStatus !== "passed")
    ) {
      invalid("invalid_stopped_step");
    }
  }

  return Object.freeze({
    schemaVersion: "1.0",
    jobId: binding.jobId,
    planDigest: binding.planDigest,
    status: fields.status,
    startedAt,
    endedAt,
    finalOrigin,
    recordingPath: artifactPath(fields.recordingPath, new Set([".webm"]), { nullable: !completed }),
    stoppedStepId: completed ? null : fields.stoppedStepId,
    toolCalls,
    steps: Object.freeze(steps),
  });
}
