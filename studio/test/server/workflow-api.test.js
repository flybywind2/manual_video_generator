import assert from "node:assert/strict";
import test from "node:test";

import { startTestStudio } from "../fixtures/login-site.js";

function request(overrides = {}) {
  return {
    targetUrl: "http://127.0.0.1:4317/fixture/login",
    prompt: "프로젝트 메뉴에서 Manual Video 프로젝트를 여는 방법을 알려 주세요.",
    completionCondition: "Manual Video 완료 문구가 보이면 완료",
    authMode: "manual",
    authOrigins: [],
    resourceOrigins: [],
    voice: "F1",
    ...overrides,
  };
}

async function send(baseUrl, path, method, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

function fakeService(calls) {
  return {
    authenticateAndPlan: async (id) => calls.push(["authenticate", id]),
    confirmManualLoginAndPlan: async (id) => calls.push(["confirm", id]),
    updatePlan: async (id, plan, digest) => {
      calls.push(["update-plan", id, plan, digest]);
      return { job: { id, state: "plan_review" }, plan, planDigest: "b".repeat(64) };
    },
    approvePlan: async (id, digest) => {
      calls.push(["approve-plan", id, digest]);
      return { job: { id, state: "approved" }, planDigest: digest };
    },
    execute: async (id, digest, options) => calls.push(["execute", id, digest, options?.signal]),
    reapproveExecution: async (id, recovery, options) =>
      calls.push(["reapprove", id, recovery, options?.signal]),
    retryJob: async (id, recovery, options) =>
      calls.push(["retry", id, recovery, options?.signal]),
    cancelJob: async (id) => {
      calls.push(["cancel", id]);
      return { id, state: "cancelled" };
    },
    updateMediaPlan: async (id, edit, options) => {
      calls.push(["update-media", id, edit, options?.signal]);
      return { state: "composing", previewDigest: "c".repeat(64) };
    },
    approvePreview: async (id, digest, options) =>
      calls.push(["approve-preview", id, digest, options?.signal]),
  };
}

test("job creation accepts the complete product request and schedules authentication", async (t) => {
  const calls = [];
  const pending = [];
  const { baseUrl, store } = await startTestStudio(t, {
    randomId: () => "job-api-flow",
    studioService: fakeService(calls),
    scheduleBackground(operation) {
      pending.push(Promise.resolve().then(operation));
    },
  });

  const response = await send(baseUrl, "/api/jobs", "POST", request());
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.deepEqual(body.request, request());
  await Promise.all(pending);
  assert.deepEqual(calls, [["authenticate", "job-api-flow"]]);
  assert.deepEqual((await store.load("job-api-flow")).request, request());
});

test("blank completion condition receives the durable default", async (t) => {
  const { baseUrl } = await startTestStudio(t, { randomId: () => "job-default-done" });
  const response = await send(baseUrl, "/api/jobs", "POST", request({
    completionCondition: "   ",
  }));
  assert.equal(response.status, 201);
  assert.equal(
    (await response.json()).request.completionCondition,
    "요청한 최종 화면이 보이면 완료",
  );
});

test("manual login confirmation passes the supervisor shutdown signal into planning", async (t) => {
  const calls = [];
  const pending = [];
  const controller = new AbortController();
  const studioService = fakeService(calls);
  studioService.confirmManualLoginAndPlan = async (id, options) => {
    calls.push(["confirm-signal", id, options?.signal]);
  };
  const { baseUrl } = await startTestStudio(t, {
    studioService,
    scheduleBackground(operation) {
      pending.push(Promise.resolve().then(() => operation(controller.signal)));
    },
  });

  const response = await send(baseUrl, "/api/jobs/job-confirm-signal/login/manual/confirm", "POST");
  assert.equal(response.status, 202);
  await Promise.all(pending);
  assert.deepEqual(calls, [["confirm-signal", "job-confirm-signal", controller.signal]]);
});

test("a rejected background mutation becomes a durable safe SSE event", async (t) => {
  const pending = [];
  const studioService = fakeService([]);
  studioService.execute = async () => {
    throw Object.assign(new Error("must not be persisted"), {
      code: "PLAN_DIGEST_MISMATCH",
      retryable: false,
    });
  };
  const { baseUrl, store } = await startTestStudio(t, {
    randomId: () => "job-background-reject",
    studioService,
    scheduleBackground(operation) {
      const tracked = Promise.resolve().then(operation);
      tracked.catch(() => undefined);
      pending.push(tracked);
    },
  });
  await send(baseUrl, "/api/jobs", "POST", request());
  await Promise.allSettled(pending.splice(0));
  await store.transition("job-background-reject", "START_AUTHENTICATION", { authMode: "manual" });
  await store.transition("job-background-reject", "AUTHENTICATED", {});
  await store.transition("job-background-reject", "PLAN_READY", {
    plan: { schemaVersion: "1.1" },
    planDigest: "a".repeat(64),
  });
  await store.transition("job-background-reject", "APPROVE_PLAN", {
    plan: { schemaVersion: "1.1" },
    planDigest: "a".repeat(64),
  });

  const response = await send(
    baseUrl,
    "/api/jobs/job-background-reject/execute",
    "POST",
    { planDigest: "b".repeat(64) },
  );
  assert.equal(response.status, 202);
  await Promise.allSettled(pending);

  const job = await store.load("job-background-reject");
  const event = (await store.readEvents("job-background-reject")).at(-1);
  assert.equal(job.state, "approved");
  assert.equal(event.event, "OPERATION_REJECTED");
  assert.deepEqual(event.data, {
    code: "PLAN_DIGEST_MISMATCH",
    planDigest: "a".repeat(64),
    retryable: false,
  });
  assert.doesNotMatch(JSON.stringify(event), /must not be persisted/u);
});

test("workflow mutation routes preserve digest-bound review boundaries", async (t) => {
  const calls = [];
  const pending = [];
  const { baseUrl } = await startTestStudio(t, {
    studioService: fakeService(calls),
    scheduleBackground(operation) {
      pending.push(Promise.resolve().then(operation));
    },
  });
  const digest = "a".repeat(64);
  const plan = { schemaVersion: "1.1" };

  const confirm = await send(baseUrl, "/api/jobs/job-flow/login/manual/confirm", "POST");
  assert.equal(confirm.status, 202);

  const update = await send(baseUrl, "/api/jobs/job-flow/plan", "PUT", {
    plan,
    planDigest: digest,
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).planDigest, "b".repeat(64));

  const approve = await send(baseUrl, "/api/jobs/job-flow/plan/approve", "POST", {
    planDigest: digest,
  });
  assert.equal(approve.status, 200);

  const execute = await send(baseUrl, "/api/jobs/job-flow/execute", "POST", {
    planDigest: digest,
  });
  assert.equal(execute.status, 202);
  await Promise.all(pending);

  assert.deepEqual(calls, [
    ["confirm", "job-flow"],
    ["update-plan", "job-flow", plan, digest],
    ["approve-plan", "job-flow", digest],
    ["execute", "job-flow", digest, undefined],
  ]);
});

test("mismatch reapproval and render retry are digest-bound supervised operations", async (t) => {
  const calls = [];
  const pending = [];
  const controller = new AbortController();
  const { baseUrl } = await startTestStudio(t, {
    studioService: fakeService(calls),
    scheduleBackground(operation) {
      const tracked = Promise.resolve().then(() => operation(controller.signal));
      pending.push(tracked);
      return tracked;
    },
  });
  const planDigest = "a".repeat(64);
  const previewDigest = "b".repeat(64);
  const mismatchSequence = 17;

  const reapprove = await send(
    baseUrl,
    "/api/jobs/job-recover/execution/reapprove",
    "POST",
    { planDigest, mismatchSequence },
  );
  assert.equal(reapprove.status, 202);
  assert.deepEqual(await reapprove.json(), {
    accepted: true,
    jobId: "job-recover",
    operation: "reapprove_execution",
  });

  const retry = await send(baseUrl, "/api/jobs/job-recover/retry", "POST", {
    planDigest,
    previewDigest,
  });
  assert.equal(retry.status, 202);
  assert.deepEqual(await retry.json(), {
    accepted: true,
    jobId: "job-recover",
    operation: "retry_render",
  });
  await Promise.all(pending);

  assert.deepEqual(calls, [
    ["reapprove", "job-recover", { planDigest, mismatchSequence }, controller.signal],
    ["retry", "job-recover", { planDigest, previewDigest }, controller.signal],
  ]);
});

test("mismatch reapproval requires an exact digest and positive safe mismatch sequence", async (t) => {
  const calls = [];
  const { baseUrl } = await startTestStudio(t, {
    studioService: fakeService(calls),
  });
  const path = "/api/jobs/job/execution/reapprove";
  const planDigest = "a".repeat(64);
  const invalidBodies = [
    { planDigest },
    { planDigest, mismatchSequence: 0 },
    { planDigest, mismatchSequence: -1 },
    { planDigest, mismatchSequence: 1.5 },
    { planDigest, mismatchSequence: Number.MAX_SAFE_INTEGER + 1 },
    { planDigest, mismatchSequence: 1, extra: true },
    { planDigest: "A".repeat(64), mismatchSequence: 1 },
  ];

  for (const body of invalidBodies) {
    const response = await send(baseUrl, path, "POST", body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(calls, []);
});

test("media edits, digest-bound preview approval, and cancellation are wired", async (t) => {
  const calls = [];
  const pending = [];
  const controller = new AbortController();
  const { baseUrl } = await startTestStudio(t, {
    studioService: fakeService(calls),
    scheduleBackground(operation) {
      const tracked = Promise.resolve().then(() => operation(controller.signal));
      pending.push(tracked);
      return tracked;
    },
  });

  const edit = await send(baseUrl, "/api/jobs/job-media/media-plan", "PUT", {
    previewDigest: "c".repeat(64),
    sceneId: "step-1",
    captionText: "프로젝트 메뉴를 선택합니다.",
  });
  assert.equal(edit.status, 202);
  assert.deepEqual(await edit.json(), {
    accepted: true,
    jobId: "job-media",
    operation: "edit_media",
  });

  const approve = await send(baseUrl, "/api/jobs/job-media/preview/approve", "POST", {
    previewDigest: "d".repeat(64),
  });
  assert.equal(approve.status, 202);

  const cancel = await send(baseUrl, "/api/jobs/job-media/cancel", "POST");
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).state, "cancelled");
  await Promise.all(pending);

  assert.deepEqual(calls, [
    ["update-media", "job-media", {
      previewDigest: "c".repeat(64),
      sceneId: "step-1",
      captionText: "프로젝트 메뉴를 선택합니다.",
    }, controller.signal],
    ["approve-preview", "job-media", "d".repeat(64), controller.signal],
    ["cancel", "job-media"],
  ]);
});

test("credential endpoint stores secrets only in the injected vault and never echoes them", async (t) => {
  const saved = [];
  const { baseUrl } = await startTestStudio(t, {
    credentialVault: {
      async save(id, credentials) {
        saved.push([id, credentials]);
      },
    },
  });
  const password = "manual-video-demo";
  const response = await send(baseUrl, "/api/credentials/fixture-login", "PUT", {
    origin: "HTTPS://LOGIN.example.test:443/",
    username: "demo",
    password,
  });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.deepEqual(saved, [["fixture-login", {
    origin: "https://login.example.test",
    username: "demo",
    password,
  }]]);
});

test("workflow endpoints reject malformed digests, edits, secret bodies, and methods", async (t) => {
  const { baseUrl } = await startTestStudio(t, {
    credentialVault: { save: async () => undefined },
    studioService: fakeService([]),
  });
  const cases = [
    ["/api/jobs/job/plan/approve", "POST", { planDigest: "stale" }],
    ["/api/jobs/job/execute", "POST", { planDigest: "a".repeat(64), extra: true }],
    ["/api/jobs/job/media-plan", "PUT", { previewDigest: "a".repeat(64), sceneId: "../bad", captionText: "x" }],
    ["/api/jobs/job/preview/approve", "POST", { previewDigest: "x" }],
    ["/api/jobs/job/execution/reapprove", "POST", { planDigest: "x", mismatchSequence: 1 }],
    ["/api/jobs/job/retry", "POST", { planDigest: "a".repeat(64) }],
    ["/api/jobs/job/retry", "POST", {
      planDigest: "a".repeat(64),
      previewDigest: "b".repeat(64),
      extra: true,
    }],
    ["/api/credentials/id", "PUT", { username: "demo", password: "secret" }],
    ["/api/credentials/id", "PUT", {
      origin: "https://login.example.test",
      username: "demo",
      password: "",
    }],
    ["/api/credentials/id", "PUT", {
      origin: "https://login.example.test/path",
      username: "demo",
      password: "secret",
    }],
    ["/api/credentials/id", "PUT", {
      origin: "ftp://login.example.test",
      username: "demo",
      password: "secret",
    }],
    ["/api/credentials/id", "PUT", {
      origin: "https://user@login.example.test",
      username: "demo",
      password: "secret",
    }],
    ["/api/credentials/id", "PUT", {
      origin: "https://login.example.test",
      username: "demo",
      password: "secret",
      extra: true,
    }],
  ];
  for (const [path, method, body] of cases) {
    const response = await send(baseUrl, path, method, body);
    assert.equal(response.status, 400, path);
  }
  const method = await send(baseUrl, "/api/jobs/job/execute", "GET");
  assert.equal(method.status, 405);
});
