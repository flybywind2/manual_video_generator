import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { runOpenCode as defaultRunOpenCode } from "../adapters/opencode-client.js";
import { StudioError } from "../domain/errors.js";
import { compileExecutionCalls } from "../domain/execution-calls.js";
import { bindExecutionHighlights } from "../domain/execution-highlights.js";
import { validateExecutionReport } from "../domain/execution-report.js";
import { unwrapExactJsonFence } from "../domain/json-output.js";
import { assertApprovedPlan } from "../domain/plan.js";
import { findRecoveryAnchor } from "../domain/recovery-provenance.js";
import { restoreLatestPlan } from "./planning.js";

const MAX_EXECUTOR_TEXT_BYTES = 512 * 1024;
const MAX_EXECUTOR_PROMPT_CODE_UNITS = 11_000;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAFE_PROGRESS_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const SAFE_PROGRESS_TOOL = /^playwright_browser_[a-z0-9_]{1,128}$/u;
const SAFE_PROGRESS_STATUS = /^[a-z][a-z0-9_-]{0,63}$/u;
const SAFE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;
const SAFE_FAILURE_REASON = /^[a-z][a-z0-9_]{2,63}$/u;

function executionError(code, message, retryable = false, details = {}) {
  return new StudioError(message, {
    code,
    stage: "executing",
    retryable,
    details,
  });
}

function safeOutputFailure(error) {
  const code = typeof error?.code === "string" && SAFE_FAILURE_CODE.test(error.code)
    ? error.code
    : "EXECUTOR_OUTPUT_REJECTED";
  const reason = typeof error?.details?.reason === "string" &&
    SAFE_FAILURE_REASON.test(error.details.reason)
    ? error.details.reason
    : null;
  return Object.freeze(reason === null ? { code } : { code, reason });
}

function safeToolFailure(report, expectedCalls) {
  if (!Array.isArray(report?.toolEvents) || !Array.isArray(expectedCalls)) return null;
  const completedCallIds = new Set();
  for (const event of report.toolEvents) {
    if (event?.status === "completed" && typeof event?.callId === "string") {
      completedCallIds.add(event.callId);
      continue;
    }
    if (event?.status !== "error") continue;
    const expected = expectedCalls[completedCallIds.size];
    const actualTool = typeof event.tool === "string"
      ? event.tool.replace(/^playwright_/u, "")
      : "";
    const reason = actualTool !== expected?.tool
      ? "tool_drift"
      : !isDeepStrictEqual(event.input, expected.arguments)
        ? "argument_drift"
        : "approved_tool_failed";
    return Object.freeze({ code: "EXECUTOR_TOOL_CALL_FAILED", reason });
  }
  return null;
}

function validateDependencies(options) {
  const {
    browserRuntime,
    executionLock,
    jobStore,
    openCodeServer,
    opencodePath,
    runOpenCode = defaultRunOpenCode,
  } = options ?? {};
  if (
    typeof browserRuntime?.installApproval !== "function" ||
    typeof browserRuntime?.executeApproval !== "function" ||
    typeof browserRuntime?.readExecutionHighlights !== "function" ||
    typeof browserRuntime?.readExecutionTiming !== "function" ||
    typeof browserRuntime?.readEvidenceArtifacts !== "function" ||
    typeof browserRuntime?.readRecordingArtifact !== "function" ||
    typeof browserRuntime?.stop !== "function" ||
    typeof executionLock?.acquire !== "function" ||
    typeof executionLock?.release !== "function" ||
    typeof executionLock?.cancel !== "function" ||
    typeof jobStore?.load !== "function" ||
    typeof jobStore?.compareAndTransition !== "function" ||
    typeof jobStore?.transition !== "function" ||
    typeof jobStore?.readEvents !== "function" ||
    typeof openCodeServer?.withAttachOptions !== "function" ||
    typeof openCodeServer?.stop !== "function" ||
    typeof opencodePath !== "string" ||
    !isAbsolute(opencodePath) ||
    typeof runOpenCode !== "function"
  ) {
    throw executionError(
      "EXECUTION_CONFIGURATION_INVALID",
      "The execution workflow is not configured safely.",
    );
  }
  return {
    browserRuntime,
    executionLock,
    jobStore,
    openCodeServer,
    opencodePath,
    runOpenCode,
  };
}

function validateJobId(jobId) {
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) {
    throw executionError("EXECUTION_JOB_INVALID", "The execution job identifier is invalid.");
  }
  return jobId;
}

function eventsBefore(events, anchor) {
  const index = events.findIndex(({ sequence }) => sequence === anchor?.sequence);
  return index < 0 ? null : events.slice(0, index);
}

function confirmedManualReexecutionMismatch(events, current, planDigest) {
  const confirmation = findRecoveryAnchor(events, {
    anchorEvent: "CONFIRM_REEXECUTION_LOGIN",
    currentEventSequence: current?.eventSequence,
    currentState: "needs_review",
  });
  const mismatchSequence = confirmation?.data?.mismatchSequence;
  if (
    confirmation?.data?.confirmed !== true ||
    confirmation?.data?.planDigest !== planDigest ||
    !Number.isSafeInteger(mismatchSequence) ||
    mismatchSequence < 1
  ) {
    return null;
  }

  const beforeConfirmation = eventsBefore(events, confirmation);
  const awaiting = beforeConfirmation?.at(-1);
  const authRequired = findRecoveryAnchor(beforeConfirmation, {
    anchorEvent: "AUTH_REQUIRED",
    currentEventSequence: awaiting?.sequence,
    currentState: "awaiting_manual_login",
  });
  if (
    authRequired?.data?.reason !== "manual_reexecution" ||
    authRequired?.data?.planDigest !== planDigest ||
    authRequired?.data?.mismatchSequence !== mismatchSequence
  ) {
    return null;
  }

  const beforeRequired = eventsBefore(beforeConfirmation, authRequired);
  const authenticating = beforeRequired?.at(-1);
  const authExpired = findRecoveryAnchor(beforeRequired, {
    anchorEvent: "AUTHENTICATION_EXPIRED",
    currentEventSequence: authenticating?.sequence,
    currentState: "authenticating",
  });
  if (
    authExpired?.data?.reason !== "manual_reexecution" ||
    authExpired?.data?.planDigest !== planDigest ||
    authExpired?.data?.mismatchSequence !== mismatchSequence
  ) {
    return null;
  }

  const beforeExpired = eventsBefore(beforeRequired, authExpired);
  const review = beforeExpired?.at(-1);
  const mismatch = findRecoveryAnchor(beforeExpired, {
    anchorEvent: "EXECUTION_MISMATCH",
    currentEventSequence: review?.sequence,
    currentState: "needs_review",
  });
  if (
    mismatch?.sequence !== mismatchSequence ||
    mismatch?.data?.planDigest !== planDigest ||
    mismatch?.data?.report?.status !== "mismatch"
  ) {
    return null;
  }
  return mismatch;
}

function executorPrompt(jobId, plan, planDigest, calls) {
  const bundle = {
    schemaVersion: "1.0",
    jobId,
    planDigest,
    targetUrl: plan.targetUrl,
    targetOrigin: plan.targetOrigin,
    evidenceSteps: plan.steps.map((step) => ({
      id: step.id,
      action: step.action,
      expected: step.expected,
      actionCallIds: step.calls.map((call) => call.id),
    })),
    callQueue: calls,
  };
  const prompt = [
    "Execute the exact supplied call queue in order; do not skip, repeat, alter, or append a call.",
    "Stop at the first page, origin, element, dialog, or expected-result mismatch.",
    "Return exactly one schemaVersion 1.0 JSON execution report matching the configured agent contract.",
    "The exact supplied call queue and approved evidence binding follow:",
    JSON.stringify(bundle),
  ].join("\n");
  if (prompt.length > MAX_EXECUTOR_PROMPT_CODE_UNITS) {
    throw executionError(
      "EXECUTION_PROMPT_TOO_LARGE",
      "The approved plan is too large to execute safely.",
    );
  }
  return prompt;
}

function parseFinalCandidate(finalText) {
  if (
    typeof finalText !== "string" ||
    finalText.length === 0 ||
    Buffer.byteLength(finalText, "utf8") > MAX_EXECUTOR_TEXT_BYTES
  ) {
    throw executionError("EXECUTOR_OUTPUT_INVALID", "The executor output is invalid.");
  }
  let candidate;
  try {
    candidate = JSON.parse(unwrapExactJsonFence(finalText));
  } catch {
    const trimmed = typeof finalText === "string" ? finalText.trim() : "";
    const reason = /^```(?:json)?\s*\{[\s\S]*\}\s*```$/iu.test(trimmed)
      ? "json_parse_fenced_object"
      : trimmed.startsWith("{") && trimmed.endsWith("}")
        ? "json_parse_object_like"
        : "json_parse_other_text";
    throw executionError(
      "EXECUTOR_OUTPUT_INVALID",
      "The executor output is invalid.",
      false,
      { reason },
    );
  }
  return candidate;
}

function coordinatorExecutionCandidate(jobId, plan, planDigest, calls) {
  const placeholder = "1970-01-01T00:00:00.000Z";
  return {
    schemaVersion: "1.0",
    jobId,
    planDigest,
    status: "completed",
    startedAt: placeholder,
    endedAt: placeholder,
    finalOrigin: plan.targetOrigin,
    recordingPath: "browser/pending.webm",
    stoppedStepId: null,
    toolCalls: calls.map(({ id, tool }) => ({ id, tool })),
    steps: plan.steps.map((step) => ({
      id: step.id,
      startedAt: placeholder,
      endedAt: placeholder,
      observedOrigin: plan.targetOrigin,
      elementEvidence: `Coordinator completed the approved action and accessibility snapshot for ${step.action}.`,
      screenshotPath: "browser/pending.png",
      expectedStatus: "passed",
      expectedEvidence: step.expected,
      actionCallIds: step.calls.map(({ id }) => id),
    })),
  };
}

function candidateFromExecutionResult(value, binding, calls) {
  const baseFields = [
    "schemaVersion",
    "jobId",
    "generation",
    "planDigest",
    "status",
    "callCount",
  ];
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some((key) =>
      typeof key !== "string" || ![...baseFields, "report"].includes(key)) ||
    !baseFields.every((field) => Object.hasOwn(value, field)) ||
    value.schemaVersion !== "1.0" ||
    value.jobId !== binding.jobId ||
    value.generation !== binding.generation ||
    value.planDigest !== binding.planDigest ||
    !["completed", "mismatch"].includes(value.status) ||
    !Number.isSafeInteger(value.callCount) ||
    value.callCount < 1 ||
    value.callCount > calls.length ||
    (value.status === "completed" && value.callCount !== calls.length)
  ) {
    throw executionError("EXECUTION_RESULT_INVALID", "The coordinator execution result is invalid.");
  }
  if (Object.hasOwn(value, "report")) return value.report;
  if (value.status !== "completed") {
    throw executionError("EXECUTION_RESULT_INVALID", "The coordinator execution result is invalid.");
  }
  return coordinatorExecutionCandidate(binding.jobId, binding.plan, binding.planDigest, calls);
}

function bindRecordingArtifact(candidate, binding, artifactValue) {
  const fields = [
    "schemaVersion",
    "jobId",
    "generation",
    "planDigest",
    "approvedCallId",
    "recordingPath",
  ];
  if (
    artifactValue === null ||
    typeof artifactValue !== "object" ||
    Array.isArray(artifactValue) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(artifactValue)) ||
    Reflect.ownKeys(artifactValue).length !== fields.length ||
    Reflect.ownKeys(artifactValue).some((key) => !fields.includes(key)) ||
    artifactValue.schemaVersion !== "1.0" ||
    artifactValue.jobId !== binding.jobId ||
    artifactValue.generation !== binding.generation ||
    artifactValue.planDigest !== binding.planDigest ||
    artifactValue.approvedCallId !== "system.stop-video"
  ) {
    throw executionError("EXECUTION_ARTIFACT_INVALID", "The browser recording artifact is invalid.");
  }
  return artifactValue.recordingPath;
}

function bindEvidenceArtifacts(binding, artifactValue) {
  const fields = ["schemaVersion", "jobId", "generation", "planDigest", "artifacts"];
  const artifactFields = ["approvedCallId", "screenshotPath"];
  const expectedCallIds = binding.plan.steps.map(({ id }) => `${id}.evidence-screenshot`);
  if (
    artifactValue === null ||
    typeof artifactValue !== "object" ||
    Array.isArray(artifactValue) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(artifactValue)) ||
    Reflect.ownKeys(artifactValue).length !== fields.length ||
    Reflect.ownKeys(artifactValue).some((key) => typeof key !== "string" || !fields.includes(key)) ||
    artifactValue.schemaVersion !== "1.0" ||
    artifactValue.jobId !== binding.jobId ||
    artifactValue.generation !== binding.generation ||
    artifactValue.planDigest !== binding.planDigest ||
    !Array.isArray(artifactValue.artifacts) ||
    Object.getPrototypeOf(artifactValue.artifacts) !== Array.prototype ||
    artifactValue.artifacts.length !== expectedCallIds.length ||
    Reflect.ownKeys(artifactValue.artifacts).length !== expectedCallIds.length + 1
  ) {
    throw executionError("EXECUTION_ARTIFACT_INVALID", "The browser evidence artifacts are invalid.");
  }
  return Object.freeze(artifactValue.artifacts.map((artifact, index) => {
    if (
      artifact === null ||
      typeof artifact !== "object" ||
      Array.isArray(artifact) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(artifact)) ||
      Reflect.ownKeys(artifact).length !== artifactFields.length ||
      Reflect.ownKeys(artifact).some((key) => typeof key !== "string" || !artifactFields.includes(key)) ||
      artifact.approvedCallId !== expectedCallIds[index] ||
      typeof artifact.screenshotPath !== "string"
    ) {
      throw executionError("EXECUTION_ARTIFACT_INVALID", "The browser evidence artifacts are invalid.");
    }
    return Object.freeze({
      approvedCallId: artifact.approvedCallId,
      screenshotPath: artifact.screenshotPath,
    });
  }));
}

function timingData(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    throw executionError("EXECUTION_TIMING_INVALID", "The browser execution timing is invalid.");
  }
  return descriptor.value;
}

function exactTimingObject(value, fields) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  ) {
    throw executionError("EXECUTION_TIMING_INVALID", "The browser execution timing is invalid.");
  }
  return Object.fromEntries(fields.map((field) => [field, timingData(value, field)]));
}

function denseTimingCalls(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw executionError("EXECUTION_TIMING_INVALID", "The browser execution timing is invalid.");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)))
  ) {
    throw executionError("EXECUTION_TIMING_INVALID", "The browser execution timing is invalid.");
  }
  return value.map((_, index) => timingData(value, String(index)));
}

function isoTime(milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw executionError("EXECUTION_TIMING_INVALID", "The browser execution timing is invalid.");
  }
  return new Date(milliseconds).toISOString();
}

function bindMeasuredTiming(report, binding, expectedCalls, timingValue, ownedArtifacts = null) {
  const timing = exactTimingObject(timingValue, [
    "schemaVersion",
    "clock",
    "jobId",
    "generation",
    "planDigest",
    "complete",
    "calls",
  ]);
  if (
    timing.schemaVersion !== "1.0" ||
    timing.clock !== "unix_ms" ||
    timing.jobId !== binding.jobId ||
    timing.generation !== binding.generation ||
    timing.planDigest !== binding.planDigest ||
    typeof timing.complete !== "boolean" ||
    (report?.status === "completed" && timing.complete !== true)
  ) {
    throw executionError("EXECUTION_TIMING_INVALID", "The browser execution timing is invalid.");
  }
  const sourceCalls = denseTimingCalls(timing.calls);
  if (
    !Array.isArray(report?.toolCalls) ||
    sourceCalls.length !== report.toolCalls.length ||
    sourceCalls.length > expectedCalls.length
  ) {
    throw executionError("EXECUTION_TIMING_INVALID", "The browser execution timing is invalid.");
  }
  let previousEnd = 0;
  const measuredCalls = sourceCalls.map((candidate, index) => {
    const measured = exactTimingObject(candidate, ["id", "tool", "startedAtMs", "endedAtMs"]);
    const expected = expectedCalls[index];
    const reported = report.toolCalls[index];
    if (
      measured.id !== expected?.id ||
      measured.tool !== expected?.tool ||
      measured.id !== reported?.id ||
      measured.tool !== reported?.tool ||
      !Number.isSafeInteger(measured.startedAtMs) ||
      !Number.isSafeInteger(measured.endedAtMs) ||
      measured.startedAtMs < previousEnd ||
      measured.endedAtMs <= measured.startedAtMs
    ) {
      throw executionError("EXECUTION_TIMING_INVALID", "The browser execution timing is invalid.");
    }
    previousEnd = measured.endedAtMs;
    return measured;
  });
  if (
    measuredCalls[0]?.id !== "system.start-video" ||
    measuredCalls[0]?.tool !== "browser_start_video"
  ) {
    throw executionError("EXECUTION_TIMING_INVALID", "The browser execution timing is invalid.");
  }
  const recordingStartMs = measuredCalls[0].endedAtMs;
  const finalCall = measuredCalls.at(-1);
  const completed = report.status === "completed";
  const recordingEndMs = completed
    ? finalCall?.startedAtMs
    : finalCall?.endedAtMs;
  if (
    !finalCall ||
    recordingEndMs < recordingStartMs ||
    (completed &&
      (finalCall.id !== "system.stop-video" || finalCall.tool !== "browser_stop_video"))
  ) {
    throw executionError("EXECUTION_TIMING_INVALID", "The browser execution timing is invalid.");
  }

  if (!Array.isArray(report?.steps)) {
    throw executionError("EXECUTION_TIMING_INVALID", "The browser execution timing is invalid.");
  }
  const reboundSteps = report.steps.map((step, index) => {
    const expectedStep = binding.plan.steps[index];
    if (!expectedStep || step?.id !== expectedStep.id) {
      throw executionError("EXECUTION_TIMING_INVALID", "The browser execution timing is invalid.");
    }
    const evidenceCallId = `${expectedStep.id}.evidence-screenshot`;
    const firstIndex = expectedCalls.findIndex(({ id }) => id === `${expectedStep.id}.chapter`);
    const finalIndex = expectedCalls.findIndex(({ id }) => id === evidenceCallId);
    if (firstIndex < 0 || finalIndex < firstIndex || firstIndex >= measuredCalls.length) {
      throw executionError("EXECUTION_TIMING_INVALID", "The browser execution timing is invalid.");
    }
    const measuredEnd = measuredCalls[Math.min(finalIndex, measuredCalls.length - 1)];
    if (measuredEnd.endedAtMs > recordingEndMs) {
      throw executionError("EXECUTION_TIMING_INVALID", "The browser execution timing is invalid.");
    }
    const ownedEvidence = completed
      ? ownedArtifacts?.evidence?.find(({ approvedCallId }) => approvedCallId === evidenceCallId)
      : null;
    if (completed && !ownedEvidence) {
      throw executionError("EXECUTION_ARTIFACT_INVALID", "The browser evidence artifacts are invalid.");
    }
    return {
      ...step,
      startedAt: isoTime(measuredCalls[firstIndex].startedAtMs),
      endedAt: isoTime(measuredEnd.endedAtMs),
      ...(completed ? { screenshotPath: ownedEvidence.screenshotPath } : {}),
    };
  });
  const validated = validateExecutionReport({
    ...report,
    startedAt: isoTime(recordingStartMs),
    endedAt: isoTime(recordingEndMs),
    ...(completed ? { recordingPath: ownedArtifacts?.recordingPath } : {}),
    steps: reboundSteps,
  }, {
    jobId: binding.jobId,
    plan: binding.plan,
    planDigest: binding.planDigest,
  });
  return Object.freeze({
    report: validated,
    measuredCalls: Object.freeze(measuredCalls.map((call) => Object.freeze({ ...call }))),
  });
}

function approvedClickPairs(expectedCalls) {
  const pairs = [];
  for (let index = 0; index < expectedCalls.length; index += 1) {
    const click = expectedCalls[index];
    if (click.tool !== "browser_click") continue;
    const probe = expectedCalls[index - 1];
    if (
      !probe ||
      probe.tool !== "browser_evaluate" ||
      probe.id !== `${click.id}.highlight-bounds`
    ) {
      throw executionError("EXECUTION_HIGHLIGHTS_INVALID", "The browser execution highlights are invalid.");
    }
    pairs.push(Object.freeze({ clickIndex: index, click, probe }));
  }
  return Object.freeze(pairs);
}

function denseHighlightRecords(value, expectedLength) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== expectedLength
  ) {
    throw executionError("EXECUTION_HIGHLIGHTS_INVALID", "The browser execution highlights are invalid.");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)))
  ) {
    throw executionError("EXECUTION_HIGHLIGHTS_INVALID", "The browser execution highlights are invalid.");
  }
  return value.map((_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw executionError("EXECUTION_HIGHLIGHTS_INVALID", "The browser execution highlights are invalid.");
    }
    return descriptor.value;
  });
}

function exactHighlightObject(value, fields) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  ) {
    throw executionError("EXECUTION_HIGHLIGHTS_INVALID", "The browser execution highlights are invalid.");
  }
  const output = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw executionError("EXECUTION_HIGHLIGHTS_INVALID", "The browser execution highlights are invalid.");
    }
    output[field] = descriptor.value;
  }
  return output;
}

function measuredHighlightCandidates(expectedCalls, measuredCalls, geometryValue) {
  const pairs = approvedClickPairs(expectedCalls);
  if (measuredCalls.length !== expectedCalls.length) {
    throw executionError("EXECUTION_HIGHLIGHTS_INVALID", "The browser execution highlights are invalid.");
  }
  const geometryRecords = denseHighlightRecords(geometryValue, pairs.length);
  const geometryFields = ["approvedCallId", "x", "y", "width", "height"];
  return Object.freeze(geometryRecords.map((candidate, index) => {
    const fields = exactHighlightObject(candidate, geometryFields);
    const pair = pairs[index];
    const measuredClick = measuredCalls[pair.clickIndex];
    if (
      fields.approvedCallId !== pair.probe.id ||
      measuredClick?.id !== pair.click.id ||
      measuredClick?.tool !== "browser_click"
    ) {
      throw executionError("EXECUTION_HIGHLIGHTS_INVALID", "The browser execution highlights are invalid.");
    }
    return Object.freeze({
      approvedCallId: fields.approvedCallId,
      at: isoTime(measuredClick.startedAtMs),
      x: fields.x,
      y: fields.y,
      width: fields.width,
      height: fields.height,
    });
  }));
}

function progressEvent(value) {
  if (
    value?.kind !== "event" ||
    value.event === null ||
    typeof value.event !== "object"
  ) {
    return null;
  }
  const type = value.event.type;
  if (type === "step_start" || type === "step_finish") {
    return Object.freeze({ type });
  }
  if (type !== "tool_use") return null;
  const part = value.event.part;
  const state = part?.state;
  const callId = part?.callID ?? part?.callId;
  const tool = part?.tool;
  const status = state?.status;
  if (
    typeof callId !== "string" ||
    !SAFE_PROGRESS_ID.test(callId) ||
    typeof tool !== "string" ||
    !SAFE_PROGRESS_TOOL.test(tool) ||
    typeof status !== "string" ||
    !SAFE_PROGRESS_STATUS.test(status)
  ) {
    throw executionError("EXECUTION_PROGRESS_INVALID", "The executor progress is invalid.");
  }
  return Object.freeze({ type, callId, tool, status });
}

function inspectRuntime(browserRuntime, jobId) {
  const active = browserRuntime.active;
  if (
    active === null ||
    typeof active !== "object" ||
    active.jobId !== jobId ||
    !Number.isSafeInteger(active.generation) ||
    active.generation < 1 ||
    active.phase !== "planning"
  ) {
    throw executionError(
      "EXECUTION_BROWSER_INACTIVE",
      "The approved browser session is not ready for execution.",
      true,
    );
  }
  return active;
}

async function stopRuntimes(settings, jobId, { force = false } = {}) {
  const browserOwned = force || settings.browserRuntime.active?.jobId === jobId;
  const openCodeOwned =
    force ||
    settings.openCodeServer.activeJobId === jobId ||
    settings.openCodeServer.active?.jobId === jobId;
  const stopped = await Promise.allSettled([
    ...(openCodeOwned
      ? [Promise.resolve().then(() => settings.openCodeServer.stop())]
      : []),
    ...(browserOwned
      ? [Promise.resolve().then(() => settings.browserRuntime.stop())]
      : []),
  ]);
  return stopped.every(({ status }) => status === "fulfilled");
}

async function transitionCancellation(settings, jobId) {
  const current = await settings.jobStore.load(jobId);
  if (current.state === "cancelled") return current;
  try {
    return await settings.jobStore.transition(jobId, "CANCEL_JOB", {
      reason: "user_cancelled",
    });
  } catch {
    const latest = await settings.jobStore.load(jobId);
    if (latest.state === "cancelled") return latest;
    throw executionError("EXECUTION_CANCEL_INVALID", "The job cannot be cancelled now.");
  }
}

export function createExecutionWorkflow(options) {
  const settings = validateDependencies(options);
  const activeRuns = new Map();

  const run = async (
    jobIdInput,
    expectedPlanDigest,
    optionsValue = {},
    reapproval = false,
  ) => {
    const jobId = validateJobId(jobIdInput);
    if (
      optionsValue === null ||
      typeof optionsValue !== "object" ||
      Array.isArray(optionsValue) ||
      Reflect.ownKeys(optionsValue).some((key) => key !== "signal") ||
      (optionsValue.signal !== undefined &&
        (typeof optionsValue.signal !== "object" ||
          Object.getPrototypeOf(optionsValue.signal) !== AbortSignal.prototype))
    ) {
      throw executionError("EXECUTION_OPTIONS_INVALID", "The execution options are invalid.");
    }
    if (activeRuns.has(jobId)) {
      throw executionError("EXECUTION_ALREADY_RUNNING", "This job is already executing.", true);
    }

    const current = await settings.jobStore.load(jobId);
    const requiredState = reapproval ? "needs_review" : "approved";
    if (current.state !== requiredState) {
      throw executionError(
        reapproval ? "EXECUTION_REAPPROVAL_STATE_INVALID" : "EXECUTION_STATE_INVALID",
        reapproval
          ? "Execution cannot be reapproved from the current job state."
          : "Execution cannot start from the current job state.",
      );
    }
    const restored = await restoreLatestPlan(settings.jobStore, jobId);
    if (restored === null || !restored.approved) {
      throw executionError("EXECUTION_PLAN_MISSING", "The approved plan is missing.");
    }
    const plan = assertApprovedPlan(restored.plan, expectedPlanDigest);
    const calls = compileExecutionCalls(plan);
    let mismatch = null;
    if (reapproval) {
      const events = await settings.jobStore.readEvents(jobId, 0);
      const latest = events.at(-1);
      mismatch = findRecoveryAnchor(events, {
        anchorEvent: "EXECUTION_MISMATCH",
        currentEventSequence: current.eventSequence,
        currentState: "needs_review",
      });
      mismatch ??= confirmedManualReexecutionMismatch(
        events,
        current,
        restored.planDigest,
      );
      if (
        mismatch === null ||
        mismatch?.data?.planDigest !== restored.planDigest ||
        mismatch?.data?.report?.status !== "mismatch" ||
        latest?.data?.planDigest !== restored.planDigest
      ) {
        throw executionError(
          "EXECUTION_REAPPROVAL_INVALID",
          "The execution reapproval is not bound to the current mismatch.",
        );
      }
    }

    const lockState = settings.executionLock.acquire(jobId);
    if (lockState !== "active") {
      settings.executionLock.cancel(jobId);
      throw executionError("EXECUTION_BUSY", "Another browser job is executing.", true);
    }

    const controller = new AbortController();
    let settleRun;
    const settled = new Promise((resolvePromise) => { settleRun = resolvePromise; });
    activeRuns.set(jobId, { controller, settled });
    const externalSignal = optionsValue.signal;
    const abortFromExternal = () => controller.abort(externalSignal.reason);
    if (externalSignal) {
      externalSignal.addEventListener("abort", abortFromExternal, { once: true });
      if (externalSignal.aborted) abortFromExternal();
    }

    let started = false;
    let outputRejected = false;
    let outputFailure = null;
    let terminalPersistence = false;
    try {
      if (reapproval) {
        await settings.jobStore.compareAndTransition(jobId, {
          expectedState: "needs_review",
          expectedEventSequence: current.eventSequence,
          expectedPlanDigest: restored.planDigest,
          eventName: "REAPPROVE_EXECUTION",
          data: {
            planDigest: restored.planDigest,
            mismatchSequence: mismatch.sequence,
          },
        });
      } else {
        await settings.jobStore.transition(jobId, "START_EXECUTION", {
          planDigest: restored.planDigest,
        });
      }
      started = true;
      if (controller.signal.aborted) throw controller.signal.reason;

      const active = inspectRuntime(settings.browserRuntime, jobId);
      const installed = settings.browserRuntime.installApproval({
        jobId,
        generation: active.generation,
        planDigest: restored.planDigest,
        calls,
      });
      if (
        installed?.jobId !== jobId ||
        installed?.generation !== active.generation ||
        installed?.planDigest !== restored.planDigest ||
        installed?.callCount !== calls.length
      ) {
        throw executionError("EXECUTION_APPROVAL_FAILED", "The browser approval was not installed safely.");
      }

      let report;
      try {
        const binding = {
          jobId,
          plan,
          planDigest: restored.planDigest,
        };
        const timingBinding = {
          jobId,
          generation: active.generation,
          planDigest: restored.planDigest,
        };
        const executionResult = await settings.browserRuntime.executeApproval(
          timingBinding,
          {
            signal: controller.signal,
            onCall: async (call) => {
              await settings.jobStore.transition(jobId, "EXECUTION_PROGRESS", {
                type: "tool_use",
                callId: call.id,
                tool: `playwright_${call.tool}`,
                status: call.status,
              });
            },
          },
        );
        const candidate = candidateFromExecutionResult(
          executionResult,
          { ...timingBinding, plan },
          calls,
        );
        let ownedArtifacts = null;
        if (candidate?.status === "completed") {
          const evidenceCallIds = plan.steps.map(({ id }) => `${id}.evidence-screenshot`);
          ownedArtifacts = Object.freeze({
            recordingPath: bindRecordingArtifact(
              candidate,
              { ...timingBinding, plan },
              await settings.browserRuntime.readRecordingArtifact(timingBinding),
            ),
            evidence: bindEvidenceArtifacts(
              { ...timingBinding, plan },
              await settings.browserRuntime.readEvidenceArtifacts({
                ...timingBinding,
                expectedCallIds: evidenceCallIds,
              }),
            ),
          });
          report = candidate;
        } else {
          report = validateExecutionReport({ ...candidate, recordingPath: null }, binding);
        }
        const timingValue = settings.browserRuntime.readExecutionTiming(timingBinding);
        const measured = bindMeasuredTiming(
          report,
          { ...timingBinding, plan },
          calls,
          timingValue,
          ownedArtifacts,
        );
        report = measured.report;
        if (report.status === "completed") {
          const clickPairs = approvedClickPairs(calls);
          const expectedCallIds = Object.freeze(clickPairs.map(({ probe }) => probe.id));
          const geometry = settings.browserRuntime.readExecutionHighlights({
            ...timingBinding,
            expectedCallIds,
          });
          report = bindExecutionHighlights(
            report,
            measuredHighlightCandidates(calls, measured.measuredCalls, geometry),
            { plan, planDigest: restored.planDigest },
          );
        }
      } catch (error) {
        outputRejected = true;
        outputFailure = safeOutputFailure(error);
        throw executionError("EXECUTOR_OUTPUT_INVALID", "The executor output is invalid.");
      }
      if (!(await stopRuntimes(settings, jobId, { force: true }))) {
        throw executionError("EXECUTION_CLEANUP_FAILED", "The browser processes could not be stopped safely.");
      }
      const event = report.status === "completed"
        ? "EXECUTION_COMPLETED"
        : "EXECUTION_MISMATCH";
      terminalPersistence = true;
      const job = await settings.jobStore.transition(jobId, event, {
        planDigest: restored.planDigest,
        report,
      });
      return Object.freeze({ job, report });
    } catch (error) {
      const stopped = await stopRuntimes(settings, jobId, { force: true });
      if (terminalPersistence || !started) {
        throw error;
      }
      if (controller.signal.aborted) {
        await transitionCancellation(settings, jobId);
        throw executionError("EXECUTION_CANCELLED", "Execution was cancelled.");
      }
      try {
        const failure = safeOutputFailure(error);
        await settings.jobStore.transition(jobId, "EXECUTION_FAILED", {
          planDigest: restored.planDigest,
          reason: !stopped
            ? "cleanup_failed"
            : outputRejected
              ? "executor_output_rejected"
              : "execution_failed",
          ...(outputFailure === null ? {} : { outputFailure }),
          ...(outputRejected ? {} : { failure }),
        });
      } catch {
        // A concurrent terminal transition remains authoritative.
      }
      throw executionError("EXECUTION_FAILED", "The approved browser execution failed.", true);
    } finally {
      externalSignal?.removeEventListener("abort", abortFromExternal);
      settings.executionLock.release(jobId);
      activeRuns.delete(jobId);
      settleRun();
    }
  };

  const execute = (jobId, expectedPlanDigest, optionsValue) =>
    run(jobId, expectedPlanDigest, optionsValue, false);

  const reapprove = (jobId, expectedPlanDigest, optionsValue) =>
    run(jobId, expectedPlanDigest, optionsValue, true);

  const cancel = async (jobIdInput) => {
    const jobId = validateJobId(jobIdInput);
    const running = activeRuns.get(jobId);
    running?.controller.abort(executionError("EXECUTION_CANCELLED", "Execution was cancelled."));
    settings.executionLock.cancel(jobId);
    await stopRuntimes(settings, jobId, { force: running !== undefined });
    const cancelled = await transitionCancellation(settings, jobId);
    if (running) await running.settled;
    return cancelled;
  };

  return Object.freeze({ cancel, execute, reapprove });
}
