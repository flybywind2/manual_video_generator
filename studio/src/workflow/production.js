import { timingSafeEqual } from "node:crypto";

import { StudioError } from "../domain/errors.js";
import { findRecoveryAnchor } from "../domain/recovery-provenance.js";
import {
  createFailureDescriptor,
  resumeFailure,
} from "../domain/state-machine.js";

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const PRODUCER_METHODS = Object.freeze([
  "narrate",
  "compose",
  "verifyPreview",
  "render",
  "edit",
  "rebuild",
  "cancel",
]);

function productionError(code, message, retryable = false) {
  return new StudioError(message, {
    code,
    stage: "production",
    retryable,
  });
}

function validJobId(value) {
  if (typeof value !== "string" || !JOB_ID.test(value)) {
    throw productionError("PRODUCTION_JOB_INVALID", "The media job identifier is invalid.");
  }
  return value;
}

function validDigest(value, code = "PREVIEW_DIGEST_MISMATCH") {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw productionError(code, "The reviewed preview is no longer current.");
  }
  return value;
}

function sameDigest(left, right) {
  return DIGEST.test(left ?? "") && DIGEST.test(right ?? "") &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function signalOption(options) {
  const signal = options?.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw productionError("PRODUCTION_OPTIONS_INVALID", "The media workflow options are invalid.");
  }
  return signal;
}

function validatePreview(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.mediaPlan !== "object" ||
    !DIGEST.test(value.planDigest ?? "") ||
    !DIGEST.test(value.previewDigest ?? "") ||
    typeof value.previewArtifact !== "string" ||
    value.previewArtifact.length === 0 ||
    typeof value.captionsArtifact !== "string" ||
    value.captionsArtifact.length === 0
  ) {
    throw productionError("PRODUCTION_PREVIEW_INVALID", "The media preview contract is invalid.");
  }
  return value;
}

function compositionRecoveryBinding(events, failure) {
  if (
    !Array.isArray(events) ||
    failure?.event !== "COMPOSITION_FAILED" ||
    !new Set([
      "production_failed",
      "composition_retry_failed",
      "interrupted_composition",
    ]).has(
      failure?.data?.reason,
    )
  ) {
    throw productionError(
      "PRODUCTION_RECOVERY_INVALID",
      "The composition recovery request is invalid.",
    );
  }
  let narration = null;
  let execution = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!Number.isSafeInteger(event?.sequence) || event.sequence >= failure.sequence) {
      continue;
    }
    if (narration === null && event.event === "NARRATION_COMPLETED") {
      narration = event;
    }
    if (event.event === "EXECUTION_COMPLETED") {
      execution = event;
      break;
    }
  }
  const failureHasDigest = DIGEST.test(failure?.data?.planDigest ?? "");
  const anchoredPlanDigest = failureHasDigest
    ? failure.data.planDigest
    : narration?.data?.planDigest;
  const planDigestSequence = failureHasDigest
    ? failure.sequence
    : narration?.sequence;
  const report = execution?.data?.report;
  if (
    !DIGEST.test(anchoredPlanDigest ?? "") ||
    !Number.isSafeInteger(planDigestSequence) ||
    !sameDigest(narration?.data?.planDigest, anchoredPlanDigest) ||
    !sameDigest(execution?.data?.planDigest, anchoredPlanDigest) ||
    report?.status !== "completed" ||
    !sameDigest(report?.planDigest, anchoredPlanDigest) ||
    events.some((event) =>
      event.sequence > execution.sequence &&
      event.sequence < failure.sequence &&
      new Set(["EDIT_COMPOSITION", "EDIT_NARRATION", "COMPOSITION_COMPLETED"])
        .has(event.event))
  ) {
    throw productionError(
      "PRODUCTION_RECOVERY_INVALID",
      "The composition recovery request is invalid.",
    );
  }
  return Object.freeze({
    planDigest: anchoredPlanDigest,
    planDigestSequence,
    report,
  });
}

async function latestPreview(jobStore, jobId) {
  const events = await jobStore.readEvents(jobId, 0);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].event === "COMPOSITION_COMPLETED") {
      return validatePreview(events[index].data.preview);
    }
  }
  throw productionError("PRODUCTION_PREVIEW_MISSING", "The media preview is missing.");
}

function validateDependencies({ jobStore, producer } = {}) {
  if (
    typeof jobStore?.load !== "function" ||
    typeof jobStore?.readEvents !== "function" ||
    typeof jobStore?.transition !== "function" ||
    typeof jobStore?.compareAndTransition !== "function" ||
    producer === null ||
    typeof producer !== "object" ||
    PRODUCER_METHODS.some((method) => typeof producer[method] !== "function")
  ) {
    throw productionError(
      "PRODUCTION_CONFIGURATION_INVALID",
      "The media production workflow is not configured safely.",
    );
  }
  return { jobStore, producer };
}

export class ProductionWorkflow {
  #jobStore;
  #producer;
  #active = new Map();

  constructor(options) {
    const settings = validateDependencies(options);
    this.#jobStore = settings.jobStore;
    this.#producer = settings.producer;
  }

  async #run(jobId, externalSignal, operation) {
    if (this.#active.has(jobId)) {
      throw productionError("PRODUCTION_ALREADY_RUNNING", "Media production is already active.", true);
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(externalSignal.reason);
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    if (externalSignal?.aborted) onAbort();
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    this.#active.set(jobId, { controller, settled });
    try {
      return await operation(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw productionError("PRODUCTION_CANCELLED", "Media production was cancelled.", true);
      }
      throw error;
    } finally {
      externalSignal?.removeEventListener("abort", onAbort);
      this.#active.delete(jobId);
      settle();
    }
  }

  async preparePreview(jobIdInput, options = {}) {
    const jobId = validJobId(jobIdInput);
    const externalSignal = signalOption(options);
    if (options?.report?.status !== "completed" || !DIGEST.test(options.report.planDigest ?? "")) {
      throw productionError("PRODUCTION_REPORT_INVALID", "The completed browser report is invalid.");
    }
    const current = await this.#jobStore.load(jobId);
    if (current.state !== "narrating") {
      throw productionError("PRODUCTION_STATE_INVALID", "Narration cannot start from the current state.");
    }

    return this.#run(jobId, externalSignal, async (signal) => {
      let stage = "narrating";
      try {
        const narration = await this.#producer.narrate({
          jobId,
          job: current,
          report: options.report,
          signal,
        });
        await this.#jobStore.transition(jobId, "NARRATION_COMPLETED", {
          planDigest: options.report.planDigest,
          sceneCount: narration?.sceneCount ?? 0,
        });
        stage = "composing";
        const preview = validatePreview(await this.#producer.compose({
          jobId,
          job: current,
          report: options.report,
          narration,
          signal,
        }));
        if (!sameDigest(preview.planDigest, options.report.planDigest)) {
          throw productionError("PRODUCTION_PLAN_MISMATCH", "The media plan is not bound to the execution report.");
        }
        const job = await this.#jobStore.transition(jobId, "COMPOSITION_COMPLETED", {
          planDigest: preview.planDigest,
          preview,
          previewDigest: preview.previewDigest,
        });
        return Object.freeze({ state: job.state, ...preview });
      } catch (error) {
        if (signal.aborted) throw error;
        const latest = await this.#jobStore.load(jobId).catch(() => null);
        if (latest?.state === stage) {
          await this.#jobStore.transition(
            jobId,
            stage === "narrating" ? "NARRATION_FAILED" : "COMPOSITION_FAILED",
            {
              reason: "production_failed",
              planDigest: options.report.planDigest,
            },
          ).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async retryComposition(jobIdInput, expectedPlanDigest, options = {}) {
    const jobId = validJobId(jobIdInput);
    const planDigest = validDigest(expectedPlanDigest, "PLAN_DIGEST_MISMATCH");
    const externalSignal = signalOption(options);
    const [current, events] = await Promise.all([
      this.#jobStore.load(jobId),
      this.#jobStore.readEvents(jobId, 0),
    ]);
    const failure = findRecoveryAnchor(events, {
      anchorEvent: "COMPOSITION_FAILED",
      currentEventSequence: current.eventSequence,
      currentState: "failed",
    });
    const binding = compositionRecoveryBinding(events, failure);
    const descriptor = createFailureDescriptor({
      jobId,
      eventSequence: failure?.sequence,
      planDigest: binding.planDigest,
      failedFrom: "composing",
      failedEvent: failure?.event,
    });
    const resumeFrom = resumeFailure(descriptor, {
      currentState: current.state,
      jobId,
      eventSequence: failure?.sequence,
      planDigest,
      requestedResumeFrom: "composing",
    });
    if (resumeFrom !== "composing" || !sameDigest(binding.planDigest, planDigest)) {
      throw productionError(
        "PRODUCTION_RECOVERY_INVALID",
        "The composition recovery request is invalid.",
      );
    }

    return this.#run(jobId, externalSignal, async (signal) => {
      await this.#jobStore.compareAndTransition(jobId, {
        expectedState: "failed",
        expectedEventSequence: current.eventSequence,
        expectedPlanDigest: planDigest,
        expectedPlanDigestSequence: binding.planDigestSequence,
        eventName: "RETRY_COMPOSITION",
        data: {
          planDigest,
          retryOfSequence: failure.sequence,
        },
      });
      try {
        const narration = await this.#producer.narrate({
          jobId,
          job: current,
          report: binding.report,
          signal,
        });
        const preview = validatePreview(await this.#producer.compose({
          jobId,
          job: current,
          report: binding.report,
          narration,
          signal,
        }));
        if (!sameDigest(preview.planDigest, planDigest)) {
          throw productionError(
            "PRODUCTION_PLAN_MISMATCH",
            "The media plan is not bound to the execution report.",
          );
        }
        const job = await this.#jobStore.transition(jobId, "COMPOSITION_COMPLETED", {
          planDigest: preview.planDigest,
          preview,
          previewDigest: preview.previewDigest,
        });
        return Object.freeze({ state: job.state, ...preview });
      } catch (error) {
        if (signal.aborted) throw error;
        const latest = await this.#jobStore.load(jobId).catch(() => null);
        if (latest?.state === "composing") {
          await this.#jobStore.transition(jobId, "COMPOSITION_FAILED", {
            reason: "composition_retry_failed",
            planDigest,
          }).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async approvePreview(jobIdInput, expectedPreviewDigest, options = {}) {
    const jobId = validJobId(jobIdInput);
    const expected = validDigest(expectedPreviewDigest);
    const externalSignal = signalOption(options);
    const current = await this.#jobStore.load(jobId);
    if (current.state !== "preview_review") {
      throw productionError("PRODUCTION_STATE_INVALID", "Only a pending preview can be approved.");
    }
    const preview = await latestPreview(this.#jobStore, jobId);
    if (!sameDigest(preview.previewDigest, expected)) {
      throw productionError("PREVIEW_DIGEST_MISMATCH", "The reviewed preview is no longer current.");
    }

    return this.#run(jobId, externalSignal, async (signal) => {
      await this.#producer.verifyPreview({ jobId, job: current, preview, signal });
      await this.#jobStore.transition(jobId, "APPROVE_PREVIEW", {
        planDigest: preview.planDigest,
        previewDigest: preview.previewDigest,
      });
      try {
        const rendered = await this.#producer.render({
          jobId,
          job: current,
          preview,
          signal,
        });
        if (
          rendered === null ||
          typeof rendered !== "object" ||
          typeof rendered.outputArtifact !== "string" ||
          rendered.outputArtifact.length === 0
        ) {
          throw productionError("PRODUCTION_RENDER_INVALID", "The final render contract is invalid.");
        }
        const job = await this.#jobStore.transition(jobId, "RENDER_COMPLETED", {
          outputArtifact: rendered.outputArtifact,
          planDigest: preview.planDigest,
          previewDigest: preview.previewDigest,
          quality: rendered.quality ?? {},
        });
        return Object.freeze({ state: job.state, ...rendered });
      } catch (error) {
        if (signal.aborted) throw error;
        const latest = await this.#jobStore.load(jobId).catch(() => null);
        if (latest?.state === "rendering") {
          await this.#jobStore.transition(jobId, "RENDER_FAILED", {
            reason: "render_failed",
            planDigest: preview.planDigest,
            previewDigest: preview.previewDigest,
          }).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async retryRender(
    jobIdInput,
    expectedPlanDigest,
    expectedPreviewDigest,
    options = {},
  ) {
    const jobId = validJobId(jobIdInput);
    const planDigest = validDigest(expectedPlanDigest, "PLAN_DIGEST_MISMATCH");
    const previewDigest = validDigest(expectedPreviewDigest);
    const externalSignal = signalOption(options);
    const [current, events] = await Promise.all([
      this.#jobStore.load(jobId),
      this.#jobStore.readEvents(jobId, 0),
    ]);
    const failure = findRecoveryAnchor(events, {
      anchorEvent: "RENDER_FAILED",
      currentEventSequence: current.eventSequence,
      currentState: "failed",
    });
    const descriptor = createFailureDescriptor({
      jobId,
      eventSequence: failure?.sequence,
      planDigest: failure?.data?.planDigest,
      failedFrom: "rendering",
      failedEvent: failure?.event,
    });
    const resumeFrom = resumeFailure(descriptor, {
      currentState: current.state,
      jobId,
      eventSequence: failure?.sequence,
      planDigest,
      requestedResumeFrom: "rendering",
    });
    if (resumeFrom !== "rendering") {
      throw productionError("PRODUCTION_RECOVERY_INVALID", "The render recovery request is invalid.");
    }
    const preview = await latestPreview(this.#jobStore, jobId);
    if (
      !sameDigest(preview.planDigest, planDigest) ||
      !sameDigest(preview.previewDigest, previewDigest) ||
      !sameDigest(failure?.data?.previewDigest, previewDigest)
    ) {
      throw productionError(
        sameDigest(preview.planDigest, planDigest)
          ? "PREVIEW_DIGEST_MISMATCH"
          : "PLAN_DIGEST_MISMATCH",
        "The approved render artifacts are no longer current.",
      );
    }

    return this.#run(jobId, externalSignal, async (signal) => {
      await this.#producer.verifyPreview({ jobId, job: current, preview, signal });
      await this.#jobStore.compareAndTransition(jobId, {
        expectedState: "failed",
        expectedEventSequence: current.eventSequence,
        expectedPlanDigest: planDigest,
        eventName: "RETRY_RENDER",
        data: {
          planDigest,
          previewDigest,
          retryOfSequence: failure.sequence,
        },
      });
      try {
        const rendered = await this.#producer.render({
          jobId,
          job: current,
          preview,
          signal,
        });
        if (
          rendered === null ||
          typeof rendered !== "object" ||
          typeof rendered.outputArtifact !== "string" ||
          rendered.outputArtifact.length === 0
        ) {
          throw productionError("PRODUCTION_RENDER_INVALID", "The final render contract is invalid.");
        }
        const job = await this.#jobStore.transition(jobId, "RENDER_COMPLETED", {
          outputArtifact: rendered.outputArtifact,
          planDigest,
          previewDigest,
          quality: rendered.quality ?? {},
        });
        return Object.freeze({ state: job.state, ...rendered });
      } catch (error) {
        if (signal.aborted) throw error;
        const latest = await this.#jobStore.load(jobId).catch(() => null);
        if (latest?.state === "rendering") {
          await this.#jobStore.transition(jobId, "RENDER_FAILED", {
            reason: "render_failed",
            planDigest,
            previewDigest,
          }).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async updateMediaPlan(jobIdInput, edit, options = {}) {
    const jobId = validJobId(jobIdInput);
    const externalSignal = signalOption(options);
    const current = await this.#jobStore.load(jobId);
    if (current.state !== "preview_review") {
      throw productionError("PRODUCTION_STATE_INVALID", "Media can only be edited during preview review.");
    }
    const preview = await latestPreview(this.#jobStore, jobId);
    if (!sameDigest(preview.previewDigest, edit?.previewDigest)) {
      throw productionError("PREVIEW_DIGEST_MISMATCH", "The reviewed preview is no longer current.");
    }

    return this.#run(jobId, externalSignal, async (signal) => {
      const edited = await this.#producer.edit({ jobId, job: current, preview, edit, signal });
      if (!new Set(["narrating", "composing"]).has(edited?.stage) || typeof edited.mediaPlan !== "object") {
        throw productionError("PRODUCTION_EDIT_INVALID", "The media edit contract is invalid.");
      }
      const event = edited.stage === "narrating" ? "EDIT_NARRATION" : "EDIT_COMPOSITION";
      await this.#jobStore.transition(jobId, event, {
        planDigest: preview.planDigest,
        previousPreviewDigest: preview.previewDigest,
        sceneId: edit.sceneId,
      });
      let stage = edited.stage;
      try {
        const nextPreview = validatePreview(await this.#producer.rebuild({
          jobId,
          job: current,
          preview,
          edited,
          stage,
          signal,
        }));
        if (stage === "narrating") {
          await this.#jobStore.transition(jobId, "NARRATION_COMPLETED", {
            planDigest: preview.planDigest,
            sceneCount: nextPreview.mediaPlan?.scenes?.length ?? 0,
          });
          stage = "composing";
        }
        if (!sameDigest(nextPreview.planDigest, preview.planDigest)) {
          throw productionError("PRODUCTION_PLAN_MISMATCH", "The edited media is not bound to the approved plan.");
        }
        const job = await this.#jobStore.transition(jobId, "COMPOSITION_COMPLETED", {
          planDigest: nextPreview.planDigest,
          preview: nextPreview,
          previewDigest: nextPreview.previewDigest,
        });
        return Object.freeze({ state: job.state, ...nextPreview });
      } catch (error) {
        if (signal.aborted) throw error;
        const latest = await this.#jobStore.load(jobId).catch(() => null);
        if (latest?.state === stage) {
          await this.#jobStore.transition(
            jobId,
            stage === "narrating" ? "NARRATION_FAILED" : "COMPOSITION_FAILED",
            { reason: "media_rebuild_failed" },
          ).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async cancel(jobIdInput) {
    const jobId = validJobId(jobIdInput);
    const running = this.#active.get(jobId);
    running?.controller.abort(productionError("PRODUCTION_CANCELLED", "Media production was cancelled.", true));
    await this.#producer.cancel({ jobId }).catch(() => undefined);
    const current = await this.#jobStore.load(jobId);
    const cancelled = current.state === "cancelled"
      ? current
      : await this.#jobStore.transition(jobId, "CANCEL_JOB", { reason: "user_cancelled" });
    if (running) await running.settled;
    return cancelled;
  }
}
