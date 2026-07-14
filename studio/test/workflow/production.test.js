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
    report: { status: "completed" },
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
