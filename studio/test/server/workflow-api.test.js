import assert from "node:assert/strict";
import test from "node:test";

import { startTestStudio } from "../fixtures/login-site.js";

function request(overrides = {}) {
  return {
    targetUrl: "http://127.0.0.1:4317/fixture/login",
    prompt: "프로젝트 메뉴에서 Manual Video 프로젝트를 여는 방법을 알려 주세요.",
    completionCondition: "Manual Video 완료 문구가 보이면 완료",
    authMode: "manual",
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
    execute: async (id, digest) => calls.push(["execute", id, digest]),
    cancelJob: async (id) => {
      calls.push(["cancel", id]);
      return { id, state: "cancelled" };
    },
    updateMediaPlan: async (id, edit) => {
      calls.push(["update-media", id, edit]);
      return { state: "composing", previewDigest: "c".repeat(64) };
    },
    approvePreview: async (id, digest) => calls.push(["approve-preview", id, digest]),
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
    ["execute", "job-flow", digest],
  ]);
});

test("media edits, digest-bound preview approval, and cancellation are wired", async (t) => {
  const calls = [];
  const pending = [];
  const { baseUrl } = await startTestStudio(t, {
    studioService: fakeService(calls),
    scheduleBackground(operation) {
      pending.push(Promise.resolve().then(operation));
    },
  });

  const edit = await send(baseUrl, "/api/jobs/job-media/media-plan", "PUT", {
    previewDigest: "c".repeat(64),
    sceneId: "step-1",
    captionText: "프로젝트 메뉴를 선택합니다.",
  });
  assert.equal(edit.status, 200);
  assert.equal((await edit.json()).state, "composing");

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
    }],
    ["approve-preview", "job-media", "d".repeat(64)],
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
    username: "demo",
    password,
  });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.deepEqual(saved, [["fixture-login", { username: "demo", password }]]);
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
    ["/api/credentials/id", "PUT", { username: "demo", password: "" }],
  ];
  for (const [path, method, body] of cases) {
    const response = await send(baseUrl, path, method, body);
    assert.equal(response.status, 400, path);
  }
  const method = await send(baseUrl, "/api/jobs/job/execute", "GET");
  assert.equal(method.status, 405);
});
