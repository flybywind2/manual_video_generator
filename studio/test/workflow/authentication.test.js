import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAuthenticationWorkflow } from "../../src/workflow/authentication.js";
import { JobStore } from "../../src/jobs/job-store.js";

const TARGET_URL = "http://127.0.0.1:4317/fixture/login";
const CAPABILITY = Buffer.alloc(32, 7).toString("base64url");

async function createStore(t, request, jobId) {
  const root = join(
    tmpdir(),
    `manual-video-auth-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(root, { recursive: true });
  const store = new JobStore({ root, randomId: () => jobId });
  t.after(async () => {
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const job = await store.create(request);
  return { job, store };
}

function request(overrides = {}) {
  return {
    targetUrl: TARGET_URL,
    prompt: "프로젝트 메뉴를 여는 방법을 안내해 주세요.",
    authMode: "manual",
    ...overrides,
  };
}

function harness(store, overrides = {}) {
  const calls = {
    order: [],
    browserStarts: [],
    browserStops: 0,
    openCodeStarts: [],
    openCodeStops: 0,
    vaultLoads: [],
    randomBytes: 0,
  };
  const browserRuntime = {
    async start(job, options) {
      calls.order.push("browser");
      calls.browserStarts.push({ job: structuredClone(job), options: structuredClone(options) });
      if (overrides.browserStartError) throw overrides.browserStartError;
      return Object.freeze({ endpoint: "http://127.0.0.1:8931/mcp", phase: "planning" });
    },
    async stop() {
      calls.browserStops += 1;
    },
  };
  const openCodeServer = {
    async startJob(options) {
      calls.order.push("opencode");
      calls.openCodeStarts.push(structuredClone(options));
      if (overrides.openCodeStartError) throw overrides.openCodeStartError;
      return Object.freeze({ baseUrl: "http://127.0.0.1:4096", jobId: options.jobId });
    },
    async stop() {
      calls.openCodeStops += 1;
    },
  };
  const credentialVault = {
    async load(credentialId) {
      calls.vaultLoads.push(credentialId);
      return Object.freeze({ username: "fixture-user", password: "fixture-password" });
    },
  };
  const workflow = createAuthenticationWorkflow({
    browserRuntime,
    credentialVault,
    jobStore: store,
    openCodeServer,
    randomBytes(size) {
      calls.randomBytes += 1;
      assert.equal(size, 32);
      return Buffer.alloc(32, 7);
    },
  });
  return { calls, workflow };
}

test("manual authentication keeps the browser and OpenCode alive until explicit confirmation", async (t) => {
  const jobId = "job-manualauth0001";
  const { store } = await createStore(t, request(), jobId);
  const { calls, workflow } = harness(store);

  const awaiting = await workflow.startAuthentication(jobId);

  assert.equal(awaiting.state, "awaiting_manual_login");
  assert.deepEqual(calls.order, ["browser", "opencode"]);
  assert.equal(calls.randomBytes, 1);
  assert.equal(calls.browserStarts[0].options.mcpCapabilityToken, CAPABILITY);
  assert.equal(calls.openCodeStarts[0].mcpCapabilityToken, CAPABILITY);
  assert.equal(calls.browserStarts[0].job.auth.mode, "manual");
  assert.equal(calls.browserStops, 0);
  assert.equal(calls.openCodeStops, 0);
  assert.equal(JSON.stringify(awaiting).includes(CAPABILITY), false);

  const eventsBeforeConfirm = await store.readEvents(jobId);
  assert.deepEqual(eventsBeforeConfirm.map((event) => event.event), [
    "JOB_CREATED",
    "START_AUTHENTICATION",
    "AUTH_REQUIRED",
  ]);
  assert.equal(JSON.stringify(eventsBeforeConfirm).includes(CAPABILITY), false);

  const confirmed = await workflow.confirmManualLogin(jobId);
  assert.equal(confirmed.state, "planning");
  assert.equal((await store.readEvents(jobId)).at(-1).event, "CONFIRM_LOGIN");
});

test("automatic authentication exposes decrypted credentials only to BrowserRuntime.start", async (t) => {
  const jobId = "job-automatcauth01";
  const { store } = await createStore(
    t,
    request({ authMode: "automatic", credentialId: "fixture-login" }),
    jobId,
  );
  const { calls, workflow } = harness(store);

  const authenticated = await workflow.startAuthentication(jobId);

  assert.equal(authenticated.state, "planning");
  assert.deepEqual(calls.vaultLoads, ["fixture-login"]);
  assert.equal(calls.browserStarts[0].job.auth.mode, "automatic");
  assert.equal(calls.browserStarts[0].job.auth.username, "fixture-user");
  assert.equal(calls.browserStarts[0].job.auth.password, "fixture-password");
  assert.deepEqual(calls.openCodeStarts[0], {
    jobId,
    mcpCapabilityToken: CAPABILITY,
  });
  assert.doesNotMatch(
    JSON.stringify(calls.openCodeStarts),
    /fixture-user|fixture-password|fixture-login|\.dpapi|secrets/i,
  );
  const publicData = JSON.stringify({
    authenticated,
    events: await store.readEvents(jobId),
  });
  assert.doesNotMatch(publicData, /fixture-user|fixture-password/);
  assert.equal(publicData.includes(CAPABILITY), false);
});

test("authentication fails closed and stops every runtime that may have started", async (t) => {
  const jobId = "job-authfailure0001";
  const { store } = await createStore(t, request(), jobId);
  const { calls, workflow } = harness(store, {
    openCodeStartError: new Error("unsafe detail fixture-password"),
  });

  await assert.rejects(
    workflow.startAuthentication(jobId),
    (error) =>
      error.code === "AUTHENTICATION_FAILED" &&
      !String(error).includes("fixture-password"),
  );

  assert.equal(calls.browserStops, 1);
  assert.equal(calls.openCodeStops, 1);
  assert.equal((await store.load(jobId)).state, "failed");
  const events = await store.readEvents(jobId);
  assert.equal(events.at(-1).event, "AUTHENTICATION_FAILED");
  assert.doesNotMatch(JSON.stringify(events), /fixture-password/);
});

test("manual login confirmation is rejected before the awaiting state", async (t) => {
  const jobId = "job-manualguard0001";
  const { store } = await createStore(t, request(), jobId);
  const { workflow } = harness(store);

  await assert.rejects(
    workflow.confirmManualLogin(jobId),
    (error) => error.code === "AUTHENTICATION_STATE_INVALID",
  );
  assert.equal((await store.load(jobId)).state, "created");
});
