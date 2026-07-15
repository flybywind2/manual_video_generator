import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JobStore } from "../../src/jobs/job-store.js";
import { ProductionWorkflow } from "../../src/workflow/production.js";

const DIGEST = "a".repeat(64);
const PREVIEW_DIGEST = "b".repeat(64);

async function setup(t, jobId) {
  const root = join(tmpdir(), `manual-production-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(root, { recursive: true });
  const store = new JobStore({ root, randomId: () => jobId });
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.create({
    targetUrl: "http://127.0.0.1:4317/fixture/dashboard",
    prompt: "프로젝트를 엽니다.",
    completionCondition: "완료 문구가 보임",
    authMode: "manual",
    voice: "F1",
  });
  await store.transition(jobId, "START_AUTHENTICATION", {});
  await store.transition(jobId, "AUTHENTICATED", {});
  await store.transition(jobId, "PLAN_READY", { planDigest: DIGEST });
  await store.transition(jobId, "APPROVE_PLAN", { planDigest: DIGEST });
  await store.transition(jobId, "START_EXECUTION", { planDigest: DIGEST });
  await store.transition(jobId, "EXECUTION_COMPLETED", {
    planDigest: DIGEST,
    report: { status: "completed", planDigest: DIGEST },
  });
  return store;
}

function preview() {
  return {
    planDigest: DIGEST,
    previewDigest: PREVIEW_DIGEST,
    mediaPlan: { schemaVersion: "1.0" },
    previewArtifact: "preview.mp4",
    captionsArtifact: "captions.vtt",
  };
}

function producer(overrides = {}) {
  return {
    async narrate() { return { sceneCount: 1 }; },
    async compose() { return preview(); },
    async verifyPreview() {},
    async render() { return { outputArtifact: "final.mp4", quality: { fps: 30 } }; },
    async edit() { return { stage: "composing", mediaPlan: { schemaVersion: "1.0" } }; },
    async rebuild() { return preview(); },
    async cancel() {},
    ...overrides,
  };
}

test("preparePreview durably advances narration and composition before review", async (t) => {
  const jobId = "job-production-1";
  const store = await setup(t, jobId);
  const calls = [];
  const workflow = new ProductionWorkflow({
    jobStore: store,
    producer: producer({
      async narrate(options) {
        calls.push(["narrate", options.report.status]);
        return { sceneCount: 2 };
      },
      async compose(options) {
        calls.push(["compose", options.narration.sceneCount]);
        return preview();
      },
    }),
  });

  const result = await workflow.preparePreview(jobId, {
    report: { status: "completed", planDigest: DIGEST },
  });

  assert.equal(result.state, "preview_review");
  assert.equal(result.previewDigest, PREVIEW_DIGEST);
  assert.deepEqual(calls, [["narrate", "completed"], ["compose", 2]]);
  assert.deepEqual(
    (await store.readEvents(jobId)).slice(-2).map(({ event }) => event),
    ["NARRATION_COMPLETED", "COMPOSITION_COMPLETED"],
  );
});

test("preview approval requires the exact current digest and verifies the artifact before render", async (t) => {
  const jobId = "job-production-2";
  const store = await setup(t, jobId);
  const calls = [];
  const workflow = new ProductionWorkflow({
    jobStore: store,
    producer: producer({
      async verifyPreview(value) { calls.push(["verify", value.preview.previewDigest]); },
      async render(value) {
        calls.push(["render", value.preview.previewDigest]);
        return { outputArtifact: "final.mp4", quality: { fps: 30 } };
      },
    }),
  });
  await workflow.preparePreview(jobId, { report: { status: "completed", planDigest: DIGEST } });

  await assert.rejects(
    workflow.approvePreview(jobId, "c".repeat(64)),
    { code: "PREVIEW_DIGEST_MISMATCH" },
  );
  assert.deepEqual(calls, []);

  const result = await workflow.approvePreview(jobId, PREVIEW_DIGEST);
  assert.equal(result.state, "completed");
  assert.equal(result.outputArtifact, "final.mp4");
  assert.deepEqual(calls, [
    ["verify", PREVIEW_DIGEST],
    ["render", PREVIEW_DIGEST],
  ]);
});

test("render retry after restart uses the persisted approved preview without browser recapture", async (t) => {
  const jobId = "job-production-retry-render";
  const store = await setup(t, jobId);
  const calls = [];
  let renderAttempts = 0;
  const durableProducer = producer({
    async narrate() {
      calls.push("narrate");
      return { sceneCount: 1 };
    },
    async compose() {
      calls.push("compose");
      return preview();
    },
    async verifyPreview({ preview: value }) {
      calls.push(["verify", value.previewDigest]);
    },
    async render({ preview: value }) {
      renderAttempts += 1;
      calls.push(["render", value.previewDigest]);
      if (renderAttempts === 1) throw new Error("render process killed");
      return { outputArtifact: "final.mp4", quality: { fps: 30 } };
    },
  });
  const firstProcess = new ProductionWorkflow({ jobStore: store, producer: durableProducer });
  await firstProcess.preparePreview(jobId, {
    report: { status: "completed", planDigest: DIGEST },
  });
  await assert.rejects(firstProcess.approvePreview(jobId, PREVIEW_DIGEST), /killed/u);

  const failure = (await store.readEvents(jobId)).at(-1);
  assert.equal((await store.load(jobId)).state, "failed");
  assert.equal(failure.event, "RENDER_FAILED");
  assert.deepEqual(failure.data, {
    reason: "render_failed",
    planDigest: DIGEST,
    previewDigest: PREVIEW_DIGEST,
  });

  const restartedProcess = new ProductionWorkflow({ jobStore: store, producer: durableProducer });
  await assert.rejects(
    restartedProcess.retryRender(jobId, DIGEST, "c".repeat(64)),
    { code: "PREVIEW_DIGEST_MISMATCH" },
  );
  assert.equal(renderAttempts, 1);

  const result = await restartedProcess.retryRender(jobId, DIGEST, PREVIEW_DIGEST);
  assert.equal(result.state, "completed");
  assert.equal(result.outputArtifact, "final.mp4");
  assert.deepEqual(calls, [
    "narrate",
    "compose",
    ["verify", PREVIEW_DIGEST],
    ["render", PREVIEW_DIGEST],
    ["verify", PREVIEW_DIGEST],
    ["render", PREVIEW_DIGEST],
  ]);
  assert.deepEqual(
    (await store.readEvents(jobId)).slice(-2).map(({ event }) => event),
    ["RETRY_RENDER", "RENDER_COMPLETED"],
  );
});

test("render retry keeps the original failure anchor behind rejection self-events", async (t) => {
  const jobId = "job-production-retry-rejected";
  const store = await setup(t, jobId);
  let renderAttempts = 0;
  const workflow = new ProductionWorkflow({
    jobStore: store,
    producer: producer({
      async render() {
        renderAttempts += 1;
        if (renderAttempts === 1) throw new Error("render process killed");
        return { outputArtifact: "final.mp4", quality: { fps: 30 } };
      },
    }),
  });
  await workflow.preparePreview(jobId, {
    report: { status: "completed", planDigest: DIGEST },
  });
  await assert.rejects(workflow.approvePreview(jobId, PREVIEW_DIGEST), /killed/u);
  const failure = (await store.readEvents(jobId)).at(-1);
  await store.transition(jobId, "OPERATION_REJECTED", {
    code: "PRODUCTION_RECOVERY_INVALID",
    planDigest: DIGEST,
    retryable: false,
  });
  await store.transition(jobId, "OPERATION_REJECTED", {
    code: "PRODUCTION_RECOVERY_INVALID",
    planDigest: DIGEST,
    retryable: false,
  });
  const currentSequence = (await store.load(jobId)).eventSequence;

  const result = await workflow.retryRender(jobId, DIGEST, PREVIEW_DIGEST);

  assert.equal(result.state, "completed");
  const retry = (await store.readEvents(jobId)).find(({ event }) => event === "RETRY_RENDER");
  assert.equal(retry.sequence, currentSequence + 1);
  assert.equal(retry.data.retryOfSequence, failure.sequence);
});

test("composition retry reuses the persisted execution report without browser recapture", async (t) => {
  const jobId = "job-production-retry-composition";
  const store = await setup(t, jobId);
  const calls = [];
  let composeAttempts = 0;
  const durableProducer = producer({
    async narrate({ report }) {
      calls.push(["narrate", report.planDigest]);
      return { sceneCount: 1, planDigest: report.planDigest };
    },
    async compose({ report, narration }) {
      composeAttempts += 1;
      calls.push(["compose", report.planDigest, narration.sceneCount]);
      if (composeAttempts === 1) throw new Error("strict lint warning");
      return preview();
    },
  });
  const firstProcess = new ProductionWorkflow({ jobStore: store, producer: durableProducer });
  await assert.rejects(
    firstProcess.preparePreview(jobId, {
      report: { status: "completed", planDigest: DIGEST },
    }),
    /strict lint warning/u,
  );

  const failure = (await store.readEvents(jobId)).at(-1);
  assert.equal(failure.event, "COMPOSITION_FAILED");
  assert.equal(failure.data.planDigest, DIGEST);

  const restartedProcess = new ProductionWorkflow({ jobStore: store, producer: durableProducer });
  const result = await restartedProcess.retryComposition(jobId, DIGEST);

  assert.equal(result.state, "preview_review");
  assert.equal(result.previewDigest, PREVIEW_DIGEST);
  assert.deepEqual(calls, [
    ["narrate", DIGEST],
    ["compose", DIGEST, 1],
    ["narrate", DIGEST],
    ["compose", DIGEST, 1],
  ]);
  assert.deepEqual(
    (await store.readEvents(jobId)).slice(-2).map(({ event }) => event),
    ["RETRY_COMPOSITION", "COMPOSITION_COMPLETED"],
  );
});

test("composition retry recovers a legacy latest failure bound by the preceding narration event", async (t) => {
  const jobId = "job-production-retry-legacy-composition";
  const store = await setup(t, jobId);
  await store.transition(jobId, "NARRATION_COMPLETED", {
    planDigest: DIGEST,
    sceneCount: 1,
  });
  await store.transition(jobId, "COMPOSITION_FAILED", {
    reason: "production_failed",
  });
  const workflow = new ProductionWorkflow({ jobStore: store, producer: producer() });

  const result = await workflow.retryComposition(jobId, DIGEST);

  assert.equal(result.state, "preview_review");
  const retry = (await store.readEvents(jobId)).find(
    ({ event }) => event === "RETRY_COMPOSITION",
  );
  assert.equal(retry.data.retryOfSequence, 9);
  assert.equal(retry.data.planDigest, DIGEST);
});

test("composition retry recovers an initial composition interrupted by restart", async (t) => {
  const jobId = "job-production-retry-interrupted-composition";
  const store = await setup(t, jobId);
  await store.transition(jobId, "NARRATION_COMPLETED", {
    planDigest: DIGEST,
    sceneCount: 1,
  });
  await store.transition(jobId, "COMPOSITION_FAILED", {
    reason: "interrupted_composition",
    planDigest: DIGEST,
  });
  const workflow = new ProductionWorkflow({ jobStore: store, producer: producer() });

  const result = await workflow.retryComposition(jobId, DIGEST);

  assert.equal(result.state, "preview_review");
  assert.deepEqual(
    (await store.readEvents(jobId)).slice(-2).map(({ event }) => event),
    ["RETRY_COMPOSITION", "COMPOSITION_COMPLETED"],
  );
});

test("composition retry rejects an interrupted preview edit instead of discarding the edit", async (t) => {
  const jobId = "job-production-retry-interrupted-edit";
  const store = await setup(t, jobId);
  const initial = new ProductionWorkflow({ jobStore: store, producer: producer() });
  await initial.preparePreview(jobId, {
    report: { status: "completed", planDigest: DIGEST },
  });
  await store.transition(jobId, "EDIT_COMPOSITION", {
    planDigest: DIGEST,
    previewDigest: PREVIEW_DIGEST,
  });
  await store.transition(jobId, "COMPOSITION_FAILED", {
    reason: "interrupted_composition",
    planDigest: DIGEST,
  });
  const calls = [];
  const workflow = new ProductionWorkflow({
    jobStore: store,
    producer: producer({
      async narrate() { calls.push("narrate"); },
      async compose() { calls.push("compose"); return preview(); },
    }),
  });

  await assert.rejects(
    workflow.retryComposition(jobId, DIGEST),
    { code: "PRODUCTION_RECOVERY_INVALID" },
  );
  assert.deepEqual(calls, []);
});

test("caption edits invalidate review first, rebuild without recapture, and bind a new preview", async (t) => {
  const jobId = "job-production-3";
  const store = await setup(t, jobId);
  const nextPreview = { ...preview(), previewDigest: "d".repeat(64) };
  const calls = [];
  const workflow = new ProductionWorkflow({
    jobStore: store,
    producer: producer({
      async edit({ edit }) {
        calls.push(["edit", edit.sceneId]);
        return { stage: "composing", mediaPlan: { schemaVersion: "1.0", edited: true } };
      },
      async rebuild({ stage }) {
        calls.push(["rebuild", stage]);
        return nextPreview;
      },
    }),
  });
  await workflow.preparePreview(jobId, { report: { status: "completed", planDigest: DIGEST } });

  const result = await workflow.updateMediaPlan(jobId, {
    previewDigest: PREVIEW_DIGEST,
    sceneId: "step-1",
    captionText: "새 자막",
  });

  assert.equal(result.state, "preview_review");
  assert.equal(result.previewDigest, nextPreview.previewDigest);
  assert.deepEqual(calls, [["edit", "step-1"], ["rebuild", "composing"]]);
  assert.deepEqual(
    (await store.readEvents(jobId)).slice(-2).map(({ event }) => event),
    ["EDIT_COMPOSITION", "COMPOSITION_COMPLETED"],
  );
});

test("cancel aborts an active media producer and leaves a durable cancelled state", async (t) => {
  const jobId = "job-production-4";
  const store = await setup(t, jobId);
  let started;
  const begun = new Promise((resolve) => { started = resolve; });
  const workflow = new ProductionWorkflow({
    jobStore: store,
    producer: producer({
      async narrate({ signal }) {
        started();
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    }),
  });
  const running = workflow.preparePreview(jobId, {
    report: { status: "completed", planDigest: DIGEST },
  });
  await begun;

  const rejected = assert.rejects(running, { code: "PRODUCTION_CANCELLED" });
  const cancelled = await workflow.cancel(jobId);
  await rejected;
  assert.equal(cancelled.state, "cancelled");
  assert.equal((await store.load(jobId)).state, "cancelled");
});
