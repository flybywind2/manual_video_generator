import assert from "node:assert/strict";
import test from "node:test";

import { StudioService } from "../../src/workflow/studio-service.js";

function workflow(overrides = {}) {
  return {
    authentication: {
      startAuthentication: async () => ({ state: "planning" }),
      confirmManualLogin: async () => ({ state: "planning" }),
      cancelAuthentication: async () => ({ state: "cancelled" }),
      releaseAuthentication: () => undefined,
      ...overrides.authentication,
    },
    planning: {
      createPlan: async () => ({ job: { state: "plan_review" } }),
      updatePlan: async () => ({}),
      approvePlan: async () => ({}),
      restoreLatestPlan: async () => null,
      ...overrides.planning,
    },
    execution: {
      execute: async () => ({ job: { state: "narrating" }, report: { status: "completed" } }),
      cancel: async () => ({ state: "cancelled" }),
      ...overrides.execution,
    },
    production: {
      preparePreview: async () => ({ state: "preview_review" }),
      updateMediaPlan: async () => ({}),
      approvePreview: async () => ({ state: "completed" }),
      cancel: async () => ({ state: "cancelled" }),
      ...overrides.production,
    },
  };
}

function service(overrides = {}) {
  const parts = workflow(overrides);
  return new StudioService({
    authenticationWorkflow: parts.authentication,
    planningWorkflow: parts.planning,
    executionWorkflow: parts.execution,
    productionWorkflow: parts.production,
    jobStore: overrides.jobStore ?? { load: async () => ({ state: "created" }) },
  });
}

test("authenticateAndPlan keeps authentication and planning in one serialized job operation", async () => {
  const calls = [];
  const studio = service({
    authentication: {
      startAuthentication: async () => {
        calls.push("authenticate");
        return { state: "planning" };
      },
    },
    planning: {
      createPlan: async () => {
        calls.push("plan");
        return { job: { state: "plan_review" } };
      },
    },
  });

  const result = await studio.authenticateAndPlan("job-service-1");

  assert.deepEqual(calls, ["authenticate", "plan"]);
  assert.equal(result.job.state, "plan_review");
});

test("manual confirmation is followed by planning without allowing an interleaved plan mutation", async () => {
  const calls = [];
  const studio = service({
    authentication: {
      confirmManualLogin: async () => {
        calls.push("confirm");
        return { state: "planning" };
      },
    },
    planning: {
      createPlan: async () => {
        calls.push("plan");
        return { job: { state: "plan_review" } };
      },
    },
  });

  await studio.confirmManualLoginAndPlan("job-service-2");
  assert.deepEqual(calls, ["confirm", "plan"]);
});

test("successful execution prepares a preview and releases retained authentication ownership", async () => {
  const calls = [];
  const report = { status: "completed", recordingPath: "browser/recording.webm" };
  const studio = service({
    execution: {
      execute: async (_jobId, digest) => {
        calls.push(["execute", digest]);
        return { job: { state: "narrating" }, report };
      },
    },
    production: {
      preparePreview: async (jobId, options) => {
        calls.push(["preview", jobId, options.report]);
        return { state: "preview_review" };
      },
    },
    authentication: {
      releaseAuthentication: (jobId) => calls.push(["release", jobId]),
    },
  });

  const result = await studio.execute("job-service-3", "a".repeat(64));

  assert.deepEqual(calls, [
    ["execute", "a".repeat(64)],
    ["release", "job-service-3"],
    ["preview", "job-service-3", report],
  ]);
  assert.equal(result.state, "preview_review");
});

test("execution mismatch releases retained authentication ownership without composing media", async () => {
  const calls = [];
  const studio = service({
    execution: {
      execute: async () => ({ job: { state: "needs_review" }, report: { status: "mismatch" } }),
    },
    production: {
      preparePreview: async () => calls.push("unexpected"),
    },
    authentication: {
      releaseAuthentication: (jobId) => calls.push(["release", jobId]),
    },
  });

  const result = await studio.execute("job-service-4", "b".repeat(64));
  assert.equal(result.job.state, "needs_review");
  assert.deepEqual(calls, [["release", "job-service-4"]]);
});

test("cancelJob routes cancellation to the workflow that owns the current stage", async () => {
  for (const [state, expected] of [
    ["plan_review", "authentication"],
    ["executing", "execution"],
    ["rendering", "production"],
  ]) {
    const calls = [];
    const studio = service({
      jobStore: { load: async () => ({ state }) },
      authentication: { cancelAuthentication: async () => { calls.push("authentication"); return { state: "cancelled" }; } },
      execution: { cancel: async () => { calls.push("execution"); return { state: "cancelled" }; } },
      production: { cancel: async () => { calls.push("production"); return { state: "cancelled" }; } },
    });

    const result = await studio.cancelJob("job-service-5");
    assert.equal(result.state, "cancelled");
    assert.deepEqual(calls, [expected]);
  }
});

