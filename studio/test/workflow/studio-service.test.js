import assert from "node:assert/strict";
import test from "node:test";

import { StudioService } from "../../src/workflow/studio-service.js";

function workflow(overrides = {}) {
  return {
    authentication: {
      startAuthentication: async () => ({ state: "planning" }),
      confirmManualLogin: async () => ({ state: "planning" }),
      cancelAuthentication: async () => ({ state: "cancelled" }),
      cleanupAuthentication: async () => undefined,
      close: async () => undefined,
      prepareReexecution: async () => ({ state: "needs_review" }),
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
      reapprove: async () => ({ job: { state: "narrating" }, report: { status: "completed" } }),
      cancel: async () => ({ state: "cancelled" }),
      ...overrides.execution,
    },
    production: {
      preparePreview: async () => ({ state: "preview_review" }),
      updateMediaPlan: async () => ({}),
      approvePreview: async () => ({ state: "completed" }),
      retryComposition: async () => ({ state: "preview_review" }),
      retryRender: async () => ({ state: "completed" }),
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

test("authentication and manual confirmation pass shutdown options through planning", async () => {
  const observed = [];
  const studio = service({
    planning: {
      createPlan: async (_jobId, options) => {
        observed.push(options);
        return { job: { state: "plan_review" } };
      },
    },
  });
  const controller = new AbortController();
  const options = { signal: controller.signal };

  await studio.authenticateAndPlan("job-service-signal-1", options);
  await studio.confirmManualLoginAndPlan("job-service-signal-2", options);

  assert.deepEqual(observed, [options, options]);
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

test("planning failure cleans up retained authentication ownership without masking the failure", async () => {
  const calls = [];
  const failure = Object.assign(new Error("planner rejected"), { code: "PLANNING_FAILED" });
  const studio = service({
    planning: { createPlan: async () => { throw failure; } },
    authentication: {
      cleanupAuthentication: async (jobId) => calls.push(["cleanup", jobId]),
    },
  });

  await assert.rejects(studio.authenticateAndPlan("job-service-plan-fail"), (error) => error === failure);
  assert.deepEqual(calls, [["cleanup", "job-service-plan-fail"]]);
});

test("execution preflight failure stops retained runtimes before releasing ownership", async () => {
  const calls = [];
  const failure = Object.assign(new Error("stale digest"), { code: "PLAN_DIGEST_MISMATCH" });
  const studio = service({
    execution: { execute: async () => { throw failure; } },
    authentication: {
      cleanupAuthentication: async (jobId) => calls.push(["cleanup", jobId]),
      releaseAuthentication: (jobId) => calls.push(["release", jobId]),
    },
  });

  await assert.rejects(
    studio.execute("job-service-execution-fail", "a".repeat(64)),
    (error) => error === failure,
  );
  assert.deepEqual(calls, [["cleanup", "job-service-execution-fail"]]);
});

test("retryJob resumes a render from its bound persisted media without executing the browser", async () => {
  const calls = [];
  const studio = service({
    jobStore: { load: async () => ({ state: "failed" }) },
    execution: {
      execute: async () => calls.push("unexpected-browser-execution"),
    },
    production: {
      retryRender: async (jobId, planDigest, previewDigest, options) => {
        calls.push(["retry-render", jobId, planDigest, previewDigest, options]);
        return { state: "completed", outputArtifact: "final.mp4" };
      },
    },
  });
  const options = { signal: new AbortController().signal };

  const result = await studio.retryJob(
    "job-service-render-retry",
    { planDigest: "a".repeat(64), previewDigest: "b".repeat(64) },
    options,
  );

  assert.equal(result.state, "completed");
  assert.deepEqual(calls, [[
    "retry-render",
    "job-service-render-retry",
    "a".repeat(64),
    "b".repeat(64),
    options,
  ]]);
});

test("retryComposition resumes persisted media without executing the browser", async () => {
  const calls = [];
  const studio = service({
    execution: {
      execute: async () => calls.push("unexpected-browser-execution"),
    },
    production: {
      retryComposition: async (jobId, planDigest, options) => {
        calls.push(["retry-composition", jobId, planDigest, options]);
        return { state: "preview_review", previewArtifact: "preview.mp4" };
      },
    },
  });
  const options = { signal: new AbortController().signal };

  const result = await studio.retryComposition(
    "job-service-composition-retry",
    "a".repeat(64),
    options,
  );

  assert.equal(result.state, "preview_review");
  assert.deepEqual(calls, [[
    "retry-composition",
    "job-service-composition-retry",
    "a".repeat(64),
    options,
  ]]);
});

test("reapproveExecution prepares fresh authentication then reruns and produces media", async () => {
  const calls = [];
  const report = {
    status: "completed",
    planDigest: "a".repeat(64),
    recordingPath: "browser/reapproved.webm",
  };
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const studio = service({
    authentication: {
      prepareReexecution: async (jobId, binding) => {
        calls.push(["prepare", jobId, binding]);
        return { state: "needs_review" };
      },
      releaseAuthentication: (jobId) => calls.push(["release", jobId]),
    },
    execution: {
      reapprove: async (jobId, planDigest, receivedOptions) => {
        calls.push(["reapprove", jobId, planDigest, receivedOptions]);
        return { job: { state: "narrating" }, report };
      },
    },
    production: {
      preparePreview: async (jobId, receivedOptions) => {
        calls.push(["preview", jobId, receivedOptions]);
        return { state: "preview_review" };
      },
    },
  });

  const result = await studio.reapproveExecution(
    "job-service-reapprove",
    { planDigest: "a".repeat(64), mismatchSequence: 17 },
    options,
  );

  assert.equal(result.state, "preview_review");
  assert.deepEqual(calls, [
    ["prepare", "job-service-reapprove", {
      planDigest: "a".repeat(64),
      mismatchSequence: 17,
      signal: controller.signal,
    }],
    ["reapprove", "job-service-reapprove", "a".repeat(64), options],
    ["release", "job-service-reapprove"],
    ["preview", "job-service-reapprove", {
      report,
      signal: controller.signal,
    }],
  ]);
});

test("reapproveExecution cleans prepared ownership when authentication or CAS fails", async () => {
  for (const stage of ["authentication", "execution"]) {
    const calls = [];
    const failure = Object.assign(new Error(`${stage} failed`), {
      code: stage === "authentication"
        ? "REAUTHENTICATION_REQUIRED"
        : "JOB_COMPARE_FAILED",
    });
    const studio = service({
      authentication: {
        prepareReexecution: async () => {
          calls.push("prepare");
          if (stage === "authentication") throw failure;
        },
        cleanupAuthentication: async (jobId) => calls.push(["cleanup", jobId]),
        releaseAuthentication: () => calls.push("unexpected-release"),
      },
      execution: {
        reapprove: async () => {
          calls.push("reapprove");
          throw failure;
        },
      },
    });

    await assert.rejects(
      studio.reapproveExecution("job-service-reapprove-fail", {
        planDigest: "a".repeat(64),
        mismatchSequence: 23,
      }),
      (error) => error === failure,
    );
    assert.deepEqual(
      calls,
      stage === "authentication"
        ? ["prepare", ["cleanup", "job-service-reapprove-fail"]]
        : ["prepare", "reapprove", ["cleanup", "job-service-reapprove-fail"]],
    );
  }
});

test("manual mismatch reapproval pauses at fresh login without executing or replanning", async () => {
  const calls = [];
  const studio = service({
    authentication: {
      prepareReexecution: async (jobId, binding) => {
        calls.push(["prepare", jobId, binding]);
        return { state: "awaiting_manual_login" };
      },
      releaseAuthentication: () => calls.push("unexpected-release"),
    },
    execution: {
      reapprove: async () => calls.push("unexpected-execution"),
    },
    planning: {
      createPlan: async () => calls.push("unexpected-plan"),
    },
  });
  const recovery = { planDigest: "a".repeat(64), mismatchSequence: 29 };

  const result = await studio.reapproveExecution(
    "job-service-manual-reapprove",
    recovery,
  );

  assert.equal(result.state, "awaiting_manual_login");
  assert.deepEqual(calls, [["prepare", "job-service-manual-reapprove", {
    ...recovery,
    signal: undefined,
  }]]);
});

test("manual reexecution confirmation resumes the original approved plan without planning", async () => {
  const calls = [];
  const planDigest = "a".repeat(64);
  const mismatchSequence = 31;
  const report = { status: "completed", planDigest };
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const studio = service({
    jobStore: {
      load: async () => ({ state: "needs_review" }),
      readEvents: async () => [{
        sequence: 34,
        event: "CONFIRM_REEXECUTION_LOGIN",
        state: "needs_review",
        data: { confirmed: true, planDigest, mismatchSequence },
      }],
    },
    authentication: {
      confirmManualLogin: async () => {
        calls.push("confirm");
        return { state: "needs_review" };
      },
      releaseAuthentication: (jobId) => calls.push(["release", jobId]),
    },
    execution: {
      reapprove: async (jobId, digest, receivedOptions) => {
        calls.push(["reapprove", jobId, digest, receivedOptions]);
        return { job: { state: "narrating" }, report };
      },
    },
    planning: {
      createPlan: async () => calls.push("unexpected-plan"),
    },
    production: {
      preparePreview: async (jobId, receivedOptions) => {
        calls.push(["preview", jobId, receivedOptions]);
        return { state: "preview_review" };
      },
    },
  });

  const result = await studio.confirmManualLoginAndPlan(
    "job-service-manual-confirm",
    options,
  );

  assert.equal(result.state, "preview_review");
  assert.deepEqual(calls, [
    "confirm",
    ["reapprove", "job-service-manual-confirm", planDigest, options],
    ["release", "job-service-manual-confirm"],
    ["preview", "job-service-manual-confirm", { report, signal: controller.signal }],
  ]);
});

test("media edits preserve the shutdown signal and close drains the active edit", async () => {
  let releaseEdit;
  const editGate = new Promise((resolve) => { releaseEdit = resolve; });
  const controller = new AbortController();
  const edit = {
    previewDigest: "b".repeat(64),
    sceneId: "scene-1",
    narration: "수정된 내레이션",
  };
  let observed;
  const studio = service({
    production: {
      updateMediaPlan: async (jobId, receivedEdit, options) => {
        observed = { jobId, edit: receivedEdit, signal: options?.signal };
        await editGate;
        return { state: "preview_review" };
      },
    },
  });

  const running = studio.updateMediaPlan(
    "job-service-edit-close",
    edit,
    { signal: controller.signal },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, {
    jobId: "job-service-edit-close",
    edit,
    signal: controller.signal,
  });

  const closing = studio.close();
  let settled = false;
  closing.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  releaseEdit();
  const [result] = await Promise.all([running, closing]);
  assert.equal(result.state, "preview_review");
});

test("close drains authentication and in-flight serialized work and rejects new work", async () => {
  let releasePlan;
  const planGate = new Promise((resolve) => { releasePlan = resolve; });
  const calls = [];
  const studio = service({
    planning: {
      createPlan: async () => {
        calls.push("plan-start");
        await planGate;
        calls.push("plan-end");
        return { job: { state: "plan_review" } };
      },
    },
    authentication: {
      close: async () => calls.push("auth-close"),
    },
  });
  const running = studio.authenticateAndPlan("job-service-close");
  await new Promise((resolve) => setImmediate(resolve));
  const closing = studio.close();
  assert.equal(studio.close(), closing);
  let settled = false;
  closing.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  releasePlan();
  await Promise.all([running, closing]);
  assert.deepEqual(calls, ["plan-start", "auth-close", "plan-end"]);
  await assert.rejects(studio.createPlan("job-service-after-close"), {
    code: "STUDIO_SERVICE_CLOSED",
  });
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
