import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JobStore } from "../../src/jobs/job-store.js";
import { ProductionWorkflow } from "../../src/workflow/production.js";
import { reconcileInterruptedJobs } from "../../src/workflow/restart-recovery.js";

const PLAN_DIGEST = "a".repeat(64);
const PREVIEW_DIGEST = "b".repeat(64);

async function advanceToPreviewReview(store, jobId) {
  await store.create({
    targetUrl: "http://127.0.0.1:4317/fixture/dashboard",
    prompt: "프로젝트 화면을 엽니다.",
    completionCondition: "프로젝트 화면이 보이면 완료",
    authMode: "manual",
    authOrigins: [],
    resourceOrigins: [],
    voice: "F1",
  });
  await store.transition(jobId, "START_AUTHENTICATION", {});
  await store.transition(jobId, "AUTHENTICATED", {});
  await store.transition(jobId, "PLAN_READY", { planDigest: PLAN_DIGEST });
  await store.transition(jobId, "APPROVE_PLAN", { planDigest: PLAN_DIGEST });
  await store.transition(jobId, "START_EXECUTION", { planDigest: PLAN_DIGEST });
  await store.transition(jobId, "EXECUTION_COMPLETED", {
    planDigest: PLAN_DIGEST,
    report: { status: "completed" },
  });
  await store.transition(jobId, "NARRATION_COMPLETED", {
    planDigest: PLAN_DIGEST,
    narration: { sceneCount: 1 },
  });
  await store.transition(jobId, "COMPOSITION_COMPLETED", {
    planDigest: PLAN_DIGEST,
    previewDigest: PREVIEW_DIGEST,
    preview: {
      planDigest: PLAN_DIGEST,
      previewDigest: PREVIEW_DIGEST,
      mediaPlan: { schemaVersion: "1.0" },
      previewArtifact: "preview.mp4",
      captionsArtifact: "captions.vtt",
    },
  });
}

async function advanceToRendering(store, jobId) {
  await advanceToPreviewReview(store, jobId);
  await store.transition(jobId, "APPROVE_PREVIEW", {
    planDigest: PLAN_DIGEST,
    previewDigest: PREVIEW_DIGEST,
  });
}

test("startup terminally cancels restart-stranded states and preserves durable reviews", async (t) => {
  const root = join(
    tmpdir(),
    `manual-restart-stranded-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  await mkdir(root, { recursive: true });
  const stranded = [
    ["created", "interrupted_before_authentication", false],
    ["awaiting_manual_login", "interrupted_manual_login", false],
    ["plan_review", "interrupted_plan_review", false],
    ["approved", "interrupted_approved_plan", true],
  ];
  const durable = ["needs_review", "preview_review"];
  const jobIds = [
    ...stranded.map(([state]) => `job-stranded-${state}`),
    ...durable.map((state) => `job-durable-${state}`),
  ];
  const first = new JobStore({ root, randomId: () => jobIds.shift() });
  let restarted;
  t.after(async () => {
    await restarted?.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  });

  await first.create({ prompt: "created" });

  await first.create({ prompt: "manual login" });
  await first.transition("job-stranded-awaiting_manual_login", "START_AUTHENTICATION", {});
  await first.transition("job-stranded-awaiting_manual_login", "AUTH_REQUIRED", {});

  for (const state of ["plan_review", "approved"]) {
    const jobId = `job-stranded-${state}`;
    await first.create({ prompt: state });
    await first.transition(jobId, "START_AUTHENTICATION", {});
    await first.transition(jobId, "AUTHENTICATED", {});
    await first.transition(jobId, "PLAN_READY", { planDigest: PLAN_DIGEST });
    if (state === "approved") {
      await first.transition(jobId, "APPROVE_PLAN", { planDigest: PLAN_DIGEST });
    }
  }

  await first.create({ prompt: "needs review" });
  const needsReviewId = "job-durable-needs_review";
  await first.transition(needsReviewId, "START_AUTHENTICATION", {});
  await first.transition(needsReviewId, "AUTHENTICATED", {});
  await first.transition(needsReviewId, "PLAN_READY", { planDigest: PLAN_DIGEST });
  await first.transition(needsReviewId, "APPROVE_PLAN", { planDigest: PLAN_DIGEST });
  await first.transition(needsReviewId, "START_EXECUTION", { planDigest: PLAN_DIGEST });
  await first.transition(needsReviewId, "EXECUTION_MISMATCH", { planDigest: PLAN_DIGEST });

  await advanceToPreviewReview(first, "job-durable-preview_review");
  const durableSequences = new Map(
    (await first.list())
      .filter(({ id }) => id.startsWith("job-durable-"))
      .map(({ id, eventSequence }) => [id, eventSequence]),
  );
  await first.close();

  restarted = new JobStore({ root });
  const recovered = await reconcileInterruptedJobs(restarted);

  assert.deepEqual(
    [...recovered].sort((left, right) => left.jobId.localeCompare(right.jobId)),
    stranded.map(([state, reason]) => ({
      jobId: `job-stranded-${state}`,
      from: state,
      to: "cancelled",
      reason,
    })).sort((left, right) => left.jobId.localeCompare(right.jobId)),
  );
  for (const [state, reason, planBound] of stranded) {
    const jobId = `job-stranded-${state}`;
    const job = await restarted.load(jobId);
    const cancellation = (await restarted.readEvents(jobId)).at(-1);
    assert.equal(job.state, "cancelled", `${state} must not remain stranded`);
    assert.equal(cancellation.event, "CANCEL_JOB");
    assert.equal(cancellation.data.reason, reason);
    assert.equal(
      Object.hasOwn(cancellation.data, "planDigest"),
      planBound,
    );
    if (planBound) assert.equal(cancellation.data.planDigest, PLAN_DIGEST);
  }
  for (const state of durable) {
    const jobId = `job-durable-${state}`;
    const job = await restarted.load(jobId);
    assert.equal(job.state, state);
    assert.equal(job.eventSequence, durableSequences.get(jobId));
  }

  const sequences = new Map(
    (await restarted.list()).map(({ id, eventSequence }) => [id, eventSequence]),
  );
  assert.deepEqual(await reconcileInterruptedJobs(restarted), []);
  assert.deepEqual(
    new Map((await restarted.list()).map(({ id, eventSequence }) => [id, eventSequence])),
    sequences,
  );
});

async function advanceToStage(store, jobId, stage) {
  await store.create({
    targetUrl: "http://127.0.0.1:4317/fixture/dashboard",
    prompt: "프로젝트 화면을 엽니다.",
    completionCondition: "프로젝트 화면이 보이면 완료",
    authMode: "manual",
    authOrigins: [],
    resourceOrigins: [],
    voice: "F1",
  });
  await store.transition(jobId, "START_AUTHENTICATION", {});
  if (stage === "authenticating") return;
  await store.transition(jobId, "AUTHENTICATED", {});
  if (stage === "planning") return;
  await store.transition(jobId, "PLAN_READY", { planDigest: PLAN_DIGEST });
  await store.transition(jobId, "APPROVE_PLAN", { planDigest: PLAN_DIGEST });
  await store.transition(jobId, "START_EXECUTION", { planDigest: PLAN_DIGEST });
  if (stage === "executing") return;
  await store.transition(jobId, "EXECUTION_COMPLETED", {
    planDigest: PLAN_DIGEST,
    report: { status: "completed" },
  });
  if (stage === "narrating") return;
  await store.transition(jobId, "NARRATION_COMPLETED", {
    planDigest: PLAN_DIGEST,
    narration: { sceneCount: 1 },
  });
  if (stage === "composing") return;
  await store.transition(jobId, "COMPOSITION_COMPLETED", {
    planDigest: PLAN_DIGEST,
    previewDigest: PREVIEW_DIGEST,
    preview: {
      planDigest: PLAN_DIGEST,
      previewDigest: PREVIEW_DIGEST,
      mediaPlan: { schemaVersion: "1.0" },
      previewArtifact: "preview.mp4",
      captionsArtifact: "captions.vtt",
    },
  });
  await store.transition(jobId, "APPROVE_PREVIEW", {
    planDigest: PLAN_DIGEST,
    previewDigest: PREVIEW_DIGEST,
  });
}

test("startup durably fails every interrupted non-idle stage after reopening", async (t) => {
  const root = join(
    tmpdir(),
    `manual-restart-all-active-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  await mkdir(root, { recursive: true });
  const stages = [
    ["authenticating", "AUTHENTICATION_FAILED", "interrupted_authentication"],
    ["planning", "PLANNING_FAILED", "interrupted_planning"],
    ["executing", "EXECUTION_FAILED", "interrupted_execution"],
    ["narrating", "NARRATION_FAILED", "interrupted_narration"],
    ["composing", "COMPOSITION_FAILED", "interrupted_composition"],
    ["rendering", "RENDER_FAILED", "interrupted_render"],
  ];
  const jobIds = stages.map(([stage]) => `job-interrupted-${stage}`);
  const first = new JobStore({ root, randomId: () => jobIds.shift() });
  let restarted;
  t.after(async () => {
    await restarted?.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  });
  for (const [stage] of stages) {
    await advanceToStage(first, `job-interrupted-${stage}`, stage);
  }
  await first.close();

  restarted = new JobStore({ root });
  const recovered = await reconcileInterruptedJobs(restarted);

  assert.equal(recovered.length, stages.length);
  for (const [stage, failureEvent, reason] of stages) {
    const jobId = `job-interrupted-${stage}`;
    const job = await restarted.load(jobId);
    const failure = (await restarted.readEvents(jobId)).at(-1);
    assert.equal(job.state, "failed", `${stage} must not remain active`);
    assert.equal(failure.event, failureEvent);
    assert.equal(failure.data.reason, reason);
    if (["executing", "narrating", "composing", "rendering"].includes(stage)) {
      assert.equal(failure.data.planDigest, PLAN_DIGEST);
    } else {
      assert.equal(Object.hasOwn(failure.data, "planDigest"), false);
    }
    if (stage === "rendering") {
      assert.equal(failure.data.previewDigest, PREVIEW_DIGEST);
    }
  }
  assert.deepEqual(
    (await restarted.list()).filter(({ state }) => state !== "failed"),
    [],
  );

  const sequences = new Map(
    (await restarted.list()).map(({ id, eventSequence }) => [id, eventSequence]),
  );
  assert.deepEqual(await reconcileInterruptedJobs(restarted), []);
  assert.deepEqual(
    new Map((await restarted.list()).map(({ id, eventSequence }) => [id, eventSequence])),
    sequences,
  );
});

test("startup converts an interrupted render into a durable retryable failure", async (t) => {
  const root = join(
    tmpdir(),
    `manual-restart-recovery-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  await mkdir(root, { recursive: true });
  let restarted;

  const jobId = "job-interrupted-render";
  const first = new JobStore({ root, randomId: () => jobId });
  t.after(async () => {
    await restarted?.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  });
  await advanceToRendering(first, jobId);
  assert.equal((await first.load(jobId)).state, "rendering");
  await first.close();

  restarted = new JobStore({ root });
  const recovered = await reconcileInterruptedJobs(restarted);

  assert.deepEqual(recovered, [{
    jobId,
    from: "rendering",
    to: "failed",
    reason: "interrupted_render",
  }]);
  assert.equal((await restarted.load(jobId)).state, "failed");
  const failure = (await restarted.readEvents(jobId)).at(-1);
  assert.equal(typeof failure.timestamp, "string");
  assert.deepEqual(failure, {
    jobId,
    sequence: 11,
    timestamp: failure.timestamp,
    event: "RENDER_FAILED",
    state: "failed",
    data: {
      reason: "interrupted_render",
      planDigest: PLAN_DIGEST,
      previewDigest: PREVIEW_DIGEST,
    },
  });

  assert.deepEqual(await reconcileInterruptedJobs(restarted), []);
  assert.equal((await restarted.load(jobId)).eventSequence, 11);

  const calls = [];
  const workflow = new ProductionWorkflow({
    jobStore: restarted,
    producer: {
      narrate: async () => { throw new Error("narration must not rerun"); },
      compose: async () => { throw new Error("composition must not rerun"); },
      verifyPreview: async ({ preview }) => calls.push(["verify", preview.previewDigest]),
      render: async ({ preview }) => {
        calls.push(["render", preview.previewDigest]);
        return { outputArtifact: "video/final.mp4", quality: { fps: 30 } };
      },
      edit: async () => { throw new Error("edit must not run"); },
      rebuild: async () => { throw new Error("rebuild must not run"); },
      cancel: async () => {},
    },
  });
  const completed = await workflow.retryRender(
    jobId,
    PLAN_DIGEST,
    PREVIEW_DIGEST,
  );
  assert.equal(completed.state, "completed");
  assert.deepEqual(calls, [
    ["verify", PREVIEW_DIGEST],
    ["render", PREVIEW_DIGEST],
  ]);
  assert.deepEqual(
    (await restarted.readEvents(jobId)).slice(-2).map(({ event }) => event),
    ["RETRY_RENDER", "RENDER_COMPLETED"],
  );
});

test("startup fails an interrupted render closed when its approval binding is missing", async (t) => {
  const root = join(
    tmpdir(),
    `manual-restart-corrupt-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { force: true, recursive: true }));

  const jobId = "job-interrupted-unbound";
  const first = new JobStore({ root, randomId: () => jobId });
  await advanceToRendering(first, jobId);
  const events = await first.readEvents(jobId);
  assert.equal(events.at(-1).event, "APPROVE_PREVIEW");
  await first.close();

  // The recovery routine must never invent a digest. This assertion exercises
  // its defensive branch through a deliberately narrow store facade.
  const facade = {
    list: async () => [{ id: jobId, state: "rendering", eventSequence: 10 }],
    readEvents: async () => events.map((event) => event.event === "APPROVE_PREVIEW"
      ? { ...event, data: {} }
      : event),
    transition: async (id, event, data) => {
      assert.equal(id, jobId);
      assert.equal(event, "RENDER_FAILED");
      assert.deepEqual(data, {
        reason: "interrupted_render_unrecoverable",
        planDigest: PLAN_DIGEST,
      });
      return { id, state: "failed" };
    },
  };

  assert.deepEqual(await reconcileInterruptedJobs(facade), [{
    jobId,
    from: "rendering",
    to: "failed",
    reason: "interrupted_render_unrecoverable",
  }]);
});
