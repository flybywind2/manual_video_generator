import { StudioError } from "./errors.js";
import { validateExecutionReport } from "./execution-report.js";
import { assertApprovedPlan } from "./plan.js";

const CANDIDATE_FIELDS = Object.freeze([
  "approvedCallId",
  "at",
  "x",
  "y",
  "width",
  "height",
]);

function invalid(reason) {
  throw new StudioError("The execution click highlights are invalid.", {
    code: "INVALID_EXECUTION_HIGHLIGHTS",
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

function denseArray(value, expectedLength) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== expectedLength
  ) {
    invalid("invalid_candidate_count");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)))
  ) {
    invalid("invalid_candidates");
  }
  return value.map((_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      invalid("invalid_candidates");
    }
    return descriptor.value;
  });
}

function exactTimestamp(value) {
  if (typeof value !== "string") invalid("invalid_click_time");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    invalid("invalid_click_time");
  }
  return milliseconds;
}

function safeRectangle(fields, captureSettings) {
  const values = [fields.x, fields.y, fields.width, fields.height];
  if (
    !values.every(Number.isSafeInteger) ||
    fields.x < 0 ||
    fields.y < 0 ||
    fields.width < 1 ||
    fields.height < 1 ||
    !Number.isSafeInteger(fields.x + fields.width) ||
    !Number.isSafeInteger(fields.y + fields.height) ||
    fields.x + fields.width > captureSettings.width ||
    fields.y + fields.height > captureSettings.height
  ) {
    invalid("invalid_click_bounds");
  }
}

function bind(report, candidates, options) {
  const optionFields = exactObject(options, ["plan", "planDigest"], "invalid_options");
  const plan = assertApprovedPlan(optionFields.plan, optionFields.planDigest);
  const reportJobId = Object.getOwnPropertyDescriptor(report ?? {}, "jobId")?.value;
  const validated = validateExecutionReport(report, {
    jobId: reportJobId,
    plan,
    planDigest: optionFields.planDigest,
  });
  if (validated.status !== "completed") invalid("incomplete_report");

  const approvedClicks = plan.steps.flatMap((step) => step.calls
    .filter(({ tool }) => tool === "browser_click")
    .map((call) => Object.freeze({ step, call })));
  const source = denseArray(candidates, approvedClicks.length);
  const reportStart = exactTimestamp(validated.startedAt);
  const reportEnd = exactTimestamp(validated.endedAt);
  const highlights = source.map((candidate, index) => {
    const fields = exactObject(candidate, CANDIDATE_FIELDS, "invalid_candidate");
    const approved = approvedClicks[index];
    if (fields.approvedCallId !== `${approved.call.id}.highlight-bounds`) {
      invalid("click_call_drift");
    }
    const atMs = exactTimestamp(fields.at);
    const owningStep = validated.steps.find(({ id }) => id === approved.step.id);
    if (!owningStep) invalid("click_step_drift");
    const stepStart = exactTimestamp(owningStep.startedAt);
    const stepEnd = exactTimestamp(owningStep.endedAt);
    if (atMs < reportStart || atMs > reportEnd || atMs < stepStart || atMs > stepEnd) {
      invalid("click_time_outside_step");
    }
    safeRectangle(fields, plan.captureSettings);
    return Object.freeze({
      stepId: approved.step.id,
      callId: approved.call.id,
      at: fields.at,
      x: fields.x,
      y: fields.y,
      width: fields.width,
      height: fields.height,
    });
  });

  return Object.freeze({
    ...validated,
    clickHighlights: Object.freeze(highlights),
  });
}

export function bindExecutionHighlights(report, candidates, options) {
  try {
    return bind(report, candidates, options);
  } catch (error) {
    if (error?.code === "INVALID_EXECUTION_HIGHLIGHTS") throw error;
    invalid("binding_invalid");
  }
}
