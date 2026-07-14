import { isAbsolute } from "node:path";

import { runOpenCode as defaultRunOpenCode } from "../adapters/opencode-client.js";
import { StudioError } from "../domain/errors.js";
import { compileExecutionCalls } from "../domain/execution-calls.js";
import { validateExecutionReport } from "../domain/execution-report.js";
import { assertApprovedPlan } from "../domain/plan.js";
import { restoreLatestPlan } from "./planning.js";

const MAX_EXECUTOR_TEXT_BYTES = 512 * 1024;
const MAX_EXECUTOR_PROMPT_CODE_UNITS = 11_000;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAFE_PROGRESS_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const SAFE_PROGRESS_TOOL = /^playwright_browser_[a-z0-9_]{1,128}$/u;
const SAFE_PROGRESS_STATUS = /^[a-z][a-z0-9_-]{0,63}$/u;

function executionError(code, message, retryable = false) {
  return new StudioError(message, {
    code,
    stage: "executing",
    retryable,
  });
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
    typeof browserRuntime?.stop !== "function" ||
    typeof executionLock?.acquire !== "function" ||
    typeof executionLock?.release !== "function" ||
    typeof executionLock?.cancel !== "function" ||
    typeof jobStore?.load !== "function" ||
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

function parseFinalReport(finalText, binding) {
  if (
    typeof finalText !== "string" ||
    finalText.length === 0 ||
    Buffer.byteLength(finalText, "utf8") > MAX_EXECUTOR_TEXT_BYTES
  ) {
    throw executionError("EXECUTOR_OUTPUT_INVALID", "The executor output is invalid.");
  }
  let candidate;
  try {
    candidate = JSON.parse(finalText);
  } catch {
    throw executionError("EXECUTOR_OUTPUT_INVALID", "The executor output is invalid.");
  }
  return validateExecutionReport(candidate, binding);
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

  const execute = async (jobIdInput, expectedPlanDigest, optionsValue = {}) => {
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
    if (current.state !== "approved") {
      throw executionError("EXECUTION_STATE_INVALID", "Execution cannot start from the current job state.");
    }
    const restored = await restoreLatestPlan(settings.jobStore, jobId);
    if (restored === null || !restored.approved) {
      throw executionError("EXECUTION_PLAN_MISSING", "The approved plan is missing.");
    }
    const plan = assertApprovedPlan(restored.plan, expectedPlanDigest);
    const calls = compileExecutionCalls(plan);
    const prompt = executorPrompt(jobId, plan, restored.planDigest, calls);

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
    let terminalPersistence = false;
    try {
      await settings.jobStore.transition(jobId, "START_EXECUTION", {
        planDigest: restored.planDigest,
      });
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

      const openCodeResult = await settings.openCodeServer.withAttachOptions(
        "manual-video-executor",
        (attachOptions) => settings.runOpenCode({
          ...attachOptions,
          opencodePath: settings.opencodePath,
          agent: "manual-video-executor",
          prompt,
          signal: controller.signal,
          onEvent: async (event) => {
            const progress = progressEvent(event);
            if (progress !== null) {
              await settings.jobStore.transition(jobId, "EXECUTION_PROGRESS", progress);
            }
          },
        }),
      );

      let report;
      try {
        report = parseFinalReport(openCodeResult?.finalText, {
          jobId,
          plan,
          planDigest: restored.planDigest,
        });
      } catch {
        outputRejected = true;
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
        await settings.jobStore.transition(jobId, "EXECUTION_FAILED", {
          reason: !stopped
            ? "cleanup_failed"
            : outputRejected
              ? "executor_output_rejected"
              : "execution_failed",
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

  return Object.freeze({ cancel, execute });
}
