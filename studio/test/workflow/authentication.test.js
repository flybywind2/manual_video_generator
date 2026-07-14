import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAuthenticationWorkflow } from "../../src/workflow/authentication.js";
import { JobStore } from "../../src/jobs/job-store.js";
import { createStudioService } from "../../src/workflow/studio-service.js";

const TARGET_URL = "http://127.0.0.1:4317/fixture/login";
const CAPABILITY = Buffer.alloc(32, 7).toString("base64url");
const PLAN_DIGEST = "a".repeat(64);

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
    authOrigins: [],
    resourceOrigins: [],
    ...overrides,
  };
}

async function advanceToMismatch(store, jobId) {
  await store.transition(jobId, "START_AUTHENTICATION", { authMode: "automatic" });
  await store.transition(jobId, "AUTHENTICATED", {});
  await store.transition(jobId, "PLAN_READY", { planDigest: PLAN_DIGEST });
  await store.transition(jobId, "APPROVE_PLAN", { planDigest: PLAN_DIGEST });
  await store.transition(jobId, "START_EXECUTION", { planDigest: PLAN_DIGEST });
  return store.transition(jobId, "EXECUTION_MISMATCH", {
    planDigest: PLAN_DIGEST,
    report: { status: "mismatch" },
  });
}

function harness(store, overrides = {}) {
  const calls = {
    order: [],
    browserStarts: [],
    browserSeals: [],
    browserSignals: [],
    browserStops: 0,
    openCodeStarts: [],
    openCodeSignals: [],
    openCodeStops: 0,
    vaultLoads: [],
    randomBytes: 0,
  };
  const browserRuntime = {
    async start(job, options) {
      calls.order.push("browser");
      const { signal, ...publicOptions } = options;
      calls.browserSignals.push(signal);
      calls.browserStarts.push({ job: structuredClone(job), options: structuredClone(publicOptions) });
      if (overrides.browserStartError) throw overrides.browserStartError;
      return Object.freeze({ endpoint: "http://127.0.0.1:8931/mcp", phase: "planning" });
    },
    async sealAuthentication(jobId) {
      calls.order.push("seal");
      calls.browserSeals.push(jobId);
      if (overrides.browserSealError) throw overrides.browserSealError;
    },
    async stop() {
      calls.browserStops += 1;
    },
  };
  const openCodeServer = {
    async startJob(options) {
      calls.order.push("opencode");
      const { signal, ...publicOptions } = options;
      calls.openCodeSignals.push(signal);
      calls.openCodeStarts.push(structuredClone(publicOptions));
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
      return Object.freeze(
        overrides.credentials ?? {
          origin: new URL(TARGET_URL).origin,
          username: "fixture-user",
          password: "fixture-password",
        },
      );
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
  assert.deepEqual(calls.order, ["browser", "opencode", "seal"]);
  assert.deepEqual(calls.browserSeals, [jobId]);
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
  assert.deepEqual(calls.order, ["browser", "seal", "opencode"]);
  assert.deepEqual(calls.browserSeals, [jobId]);
  assert.deepEqual(calls.vaultLoads, ["fixture-login"]);
  assert.equal(calls.browserStarts[0].job.auth.mode, "automatic");
  assert.equal(calls.browserStarts[0].job.auth.username, "fixture-user");
  assert.equal(calls.browserStarts[0].job.auth.password, "fixture-password");
  assert.equal(calls.browserStarts[0].job.auth.loginOrigin, "http://127.0.0.1:4317");
  assert.deepEqual(calls.browserStarts[0].job.originPolicy.authOrigins, []);
  assert.deepEqual(calls.browserStarts[0].job.originPolicy.resourceOrigins, []);
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

test("automatic authentication binds its one approved credential origin", async (t) => {
  const jobId = "job-auto-sso-origin";
  const { store } = await createStore(
    t,
    request({
      authMode: "automatic",
      credentialId: "fixture-login",
      authOrigins: ["https://login.example.test"],
      resourceOrigins: ["https://cdn.example.test"],
    }),
    jobId,
  );
  const { calls, workflow } = harness(store, {
    credentials: {
      origin: "https://login.example.test",
      username: "fixture-user",
      password: "fixture-password",
    },
  });

  await workflow.startAuthentication(jobId);

  const runtimeJob = calls.browserStarts[0].job;
  assert.equal(runtimeJob.auth.loginOrigin, "https://login.example.test");
  assert.deepEqual(runtimeJob.originPolicy.authOrigins, ["https://login.example.test"]);
  assert.deepEqual(runtimeJob.originPolicy.resourceOrigins, ["https://cdn.example.test"]);
});

test("automatic authentication rejects a credential bound to another origin before browser startup", async (t) => {
  const jobId = "job-auto-origin-mismatch";
  const { store } = await createStore(
    t,
    request({
      authMode: "automatic",
      credentialId: "fixture-login",
      authOrigins: ["https://login.example.test"],
    }),
    jobId,
  );
  const { calls, workflow } = harness(store, {
    credentials: {
      origin: "https://other.example.test",
      username: "fixture-user",
      password: "fixture-password",
    },
  });

  await assert.rejects(workflow.startAuthentication(jobId), {
    code: "AUTHENTICATION_FAILED",
  });

  assert.deepEqual(calls.vaultLoads, ["fixture-login"]);
  assert.equal(calls.browserStarts.length, 0);
  assert.equal(calls.openCodeStarts.length, 0);
  assert.equal((await store.load(jobId)).state, "failed");
  assert.doesNotMatch(
    JSON.stringify(await store.readEvents(jobId)),
    /fixture-user|fixture-password|other\.example\.test/u,
  );
});

test("automatic authentication rejects ambiguous credential origins before browser startup", async (t) => {
  const jobId = "job-auto-sso-ambiguous";
  const { store } = await createStore(
    t,
    request({
      authMode: "automatic",
      credentialId: "fixture-login",
      authOrigins: ["https://login.example.test", "https://login-b.example.test"],
    }),
    jobId,
  );
  const { calls, workflow } = harness(store);

  await assert.rejects(workflow.startAuthentication(jobId), {
    code: "AUTHENTICATION_FAILED",
  });
  assert.equal(calls.browserStarts.length, 0);
  assert.equal(calls.openCodeStarts.length, 0);
  assert.equal((await store.load(jobId)).state, "failed");
});

test("automatic mismatch recovery prepares a fresh owned runtime without changing durable state", async (t) => {
  const jobId = "job-auth-reexecute-auto";
  const { store } = await createStore(
    t,
    request({ authMode: "automatic", credentialId: "fixture-login" }),
    jobId,
  );
  const mismatched = await advanceToMismatch(store, jobId);
  const before = await store.readEvents(jobId);
  const { calls, workflow } = harness(store);

  const prepared = await workflow.prepareReexecution(jobId, {
    planDigest: PLAN_DIGEST,
    mismatchSequence: mismatched.eventSequence,
  });

  assert.deepEqual(prepared, {
    state: "needs_review",
    planDigest: PLAN_DIGEST,
    mismatchSequence: mismatched.eventSequence,
  });
  assert.deepEqual(calls.order, ["browser", "seal", "opencode"]);
  assert.deepEqual(calls.vaultLoads, ["fixture-login"]);
  assert.equal(calls.browserStarts[0].job.auth.mode, "automatic");
  assert.equal(calls.browserStarts[0].job.auth.username, "fixture-user");
  assert.equal(calls.browserStarts[0].job.auth.password, "fixture-password");
  assert.deepEqual(await store.readEvents(jobId), before);

  await workflow.cleanupAuthentication(jobId);
  assert.equal(calls.browserStops, 1);
  assert.equal(calls.openCodeStops, 1);
  assert.equal((await store.load(jobId)).state, "needs_review");
});

test("automatic mismatch recovery rejects a credential bound to another origin before browser startup", async (t) => {
  const jobId = "job-auth-reexecute-origin";
  const { store } = await createStore(
    t,
    request({ authMode: "automatic", credentialId: "fixture-login" }),
    jobId,
  );
  const mismatched = await advanceToMismatch(store, jobId);
  const before = await store.readEvents(jobId);
  const { calls, workflow } = harness(store, {
    credentials: {
      origin: "https://other.example.test",
      username: "fixture-user",
      password: "fixture-password",
    },
  });

  await assert.rejects(
    workflow.prepareReexecution(jobId, {
      planDigest: PLAN_DIGEST,
      mismatchSequence: mismatched.eventSequence,
    }),
    { code: "REEXECUTION_AUTHENTICATION_FAILED" },
  );

  assert.deepEqual(calls.vaultLoads, ["fixture-login"]);
  assert.equal(calls.browserStarts.length, 0);
  assert.equal(calls.openCodeStarts.length, 0);
  assert.equal((await store.load(jobId)).state, "needs_review");
  assert.deepEqual(await store.readEvents(jobId), before);
});

test("automatic mismatch recovery keeps the original anchor behind rejection self-events", async (t) => {
  const jobId = "job-auth-reexecute-rejected";
  const { store } = await createStore(
    t,
    request({ authMode: "automatic", credentialId: "fixture-login" }),
    jobId,
  );
  const mismatched = await advanceToMismatch(store, jobId);
  await store.transition(jobId, "OPERATION_REJECTED", {
    code: "REEXECUTION_BINDING_INVALID",
    planDigest: PLAN_DIGEST,
    retryable: false,
  });
  await store.transition(jobId, "OPERATION_REJECTED", {
    code: "REEXECUTION_BINDING_INVALID",
    planDigest: PLAN_DIGEST,
    retryable: false,
  });
  const before = await store.readEvents(jobId);
  const { calls, workflow } = harness(store);

  const prepared = await workflow.prepareReexecution(jobId, {
    planDigest: PLAN_DIGEST,
    mismatchSequence: mismatched.eventSequence,
  });

  assert.deepEqual(prepared, {
    state: "needs_review",
    planDigest: PLAN_DIGEST,
    mismatchSequence: mismatched.eventSequence,
  });
  assert.deepEqual(calls.order, ["browser", "seal", "opencode"]);
  assert.deepEqual(await store.readEvents(jobId), before);
});

test("stale reexecution cleanup never stops runtimes now owned by another job", async (t) => {
  const jobId = "job-auth-reexecute-owner-a";
  const { store } = await createStore(
    t,
    request({ authMode: "automatic", credentialId: "fixture-login" }),
    jobId,
  );
  const mismatched = await advanceToMismatch(store, jobId);
  let browserOwner = null;
  let openCodeOwner = null;
  let browserStops = 0;
  let openCodeStops = 0;
  const workflow = createAuthenticationWorkflow({
    browserRuntime: {
      get active() {
        return browserOwner === null ? null : { jobId: browserOwner };
      },
      async start(job) { browserOwner = job.id; },
      async sealAuthentication() {},
      async stop() { browserStops += 1; browserOwner = null; },
    },
    credentialVault: {
      async load() {
        return {
          origin: new URL(TARGET_URL).origin,
          username: "fixture-user",
          password: "fixture-password",
        };
      },
    },
    jobStore: store,
    openCodeServer: {
      get activeJobId() { return openCodeOwner; },
      async startJob({ jobId: owner }) { openCodeOwner = owner; },
      async stop() { openCodeStops += 1; openCodeOwner = null; },
    },
    randomBytes: () => Buffer.alloc(32, 7),
  });
  await workflow.prepareReexecution(jobId, {
    planDigest: PLAN_DIGEST,
    mismatchSequence: mismatched.eventSequence,
  });

  // Execution already stopped A; B acquired the singletons before A released its auth record.
  browserOwner = "job-auth-reexecute-owner-b";
  openCodeOwner = "job-auth-reexecute-owner-b";
  await workflow.cleanupAuthentication(jobId);

  assert.equal(browserOwner, "job-auth-reexecute-owner-b");
  assert.equal(openCodeOwner, "job-auth-reexecute-owner-b");
  assert.equal(browserStops, 0);
  assert.equal(openCodeStops, 0);
});

test("cleanup idempotently stops owned runtimes when current ownership is null", async (t) => {
  const jobId = "job-auth-cleanup-null-owner";
  const { store } = await createStore(t, request(), jobId);
  let browserStops = 0;
  let openCodeStops = 0;
  const workflow = createAuthenticationWorkflow({
    browserRuntime: {
      get active() { return null; },
      async start() {},
      async sealAuthentication() {},
      async stop() { browserStops += 1; },
    },
    credentialVault: { async load() {} },
    jobStore: store,
    openCodeServer: {
      get activeJobId() { return null; },
      async startJob() {},
      async stop() { openCodeStops += 1; },
    },
    randomBytes: () => Buffer.alloc(32, 7),
  });
  await workflow.startAuthentication(jobId);

  await workflow.cleanupAuthentication(jobId);

  assert.equal(browserStops, 1);
  assert.equal(openCodeStops, 1);
});

test("cleanup idempotently stops owned runtimes when ownership inspection fails", async (t) => {
  const jobId = "job-auth-cleanup-owner-getter";
  const { store } = await createStore(t, request(), jobId);
  let browserStops = 0;
  let openCodeStops = 0;
  const workflow = createAuthenticationWorkflow({
    browserRuntime: {
      get active() { throw new Error("browser owner unavailable"); },
      async start() {},
      async sealAuthentication() {},
      async stop() { browserStops += 1; },
    },
    credentialVault: { async load() {} },
    jobStore: store,
    openCodeServer: {
      get activeJobId() { throw new Error("OpenCode owner unavailable"); },
      async startJob() {},
      async stop() { openCodeStops += 1; },
    },
    randomBytes: () => Buffer.alloc(32, 7),
  });
  await workflow.startAuthentication(jobId);

  await workflow.cleanupAuthentication(jobId);

  assert.equal(browserStops, 1);
  assert.equal(openCodeStops, 1);
});

test("mismatch recovery rejects stale provenance and starts a bound manual login", async (t) => {
  const automaticId = "job-auth-reexecute-stale";
  const automatic = await createStore(
    t,
    request({ authMode: "automatic", credentialId: "fixture-login" }),
    automaticId,
  );
  const automaticMismatch = await advanceToMismatch(automatic.store, automaticId);
  const automaticHarness = harness(automatic.store);
  await assert.rejects(
    automaticHarness.workflow.prepareReexecution(automaticId, {
      planDigest: "b".repeat(64),
      mismatchSequence: automaticMismatch.eventSequence,
    }),
    { code: "REEXECUTION_BINDING_INVALID" },
  );
  await assert.rejects(
    automaticHarness.workflow.prepareReexecution(automaticId, {
      planDigest: PLAN_DIGEST,
      mismatchSequence: automaticMismatch.eventSequence - 1,
    }),
    { code: "REEXECUTION_BINDING_INVALID" },
  );
  assert.deepEqual(automaticHarness.calls.order, []);
  assert.deepEqual(automaticHarness.calls.vaultLoads, []);

  const manualId = "job-auth-reexecute-manual";
  const manual = await createStore(t, request({ authMode: "manual" }), manualId);
  const manualMismatch = await advanceToMismatch(manual.store, manualId);
  const manualHarness = harness(manual.store);
  const awaiting = await manualHarness.workflow.prepareReexecution(manualId, {
    planDigest: PLAN_DIGEST,
    mismatchSequence: manualMismatch.eventSequence,
  });
  assert.equal(awaiting.state, "awaiting_manual_login");
  assert.deepEqual(manualHarness.calls.order, ["browser", "opencode"]);
  assert.deepEqual((await manual.store.readEvents(manualId)).slice(-2).map(({ event, data }) => ({ event, data })), [
    {
      event: "AUTHENTICATION_EXPIRED",
      data: {
        reason: "manual_reexecution",
        planDigest: PLAN_DIGEST,
        mismatchSequence: manualMismatch.eventSequence,
      },
    },
    {
      event: "AUTH_REQUIRED",
      data: {
        reason: "manual_reexecution",
        planDigest: PLAN_DIGEST,
        mismatchSequence: manualMismatch.eventSequence,
      },
    },
  ]);

  const confirmed = await manualHarness.workflow.confirmManualLogin(manualId);
  assert.equal(confirmed.state, "needs_review");
  assert.deepEqual(manualHarness.calls.order, ["browser", "opencode", "seal"]);
  const confirmation = (await manual.store.readEvents(manualId)).at(-1);
  assert.equal(confirmation.event, "CONFIRM_REEXECUTION_LOGIN");
  assert.deepEqual(confirmation.data, {
    confirmed: true,
    planDigest: PLAN_DIGEST,
    mismatchSequence: manualMismatch.eventSequence,
  });
});

test("authentication failure stops only the runtime proven started by the job", async (t) => {
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
  assert.equal(calls.openCodeStops, 0);
  assert.equal((await store.load(jobId)).state, "failed");
  const events = await store.readEvents(jobId);
  assert.equal(events.at(-1).event, "AUTHENTICATION_FAILED");
  assert.doesNotMatch(JSON.stringify(events), /fixture-password/);
});

test("a busy authentication attempt never stops runtimes owned by another job", async (t) => {
  const root = join(
    tmpdir(),
    `manual-video-auth-ownership-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(root, { recursive: true });
  const jobIds = ["job-auth-owner-a", "job-auth-owner-b"];
  const store = new JobStore({ root, randomId: () => jobIds.shift() });
  t.after(async () => {
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const ownerA = await store.create(request());
  const ownerB = await store.create(request());
  let browserOwner = null;
  let openCodeOwner = null;
  let browserStops = 0;
  let openCodeStops = 0;
  const workflow = createAuthenticationWorkflow({
    browserRuntime: {
      async start(job) {
        if (browserOwner !== null) {
          throw Object.assign(new Error("busy"), { code: "BROWSER_RUNTIME_BUSY" });
        }
        browserOwner = job.id;
        return Object.freeze({ jobId: job.id });
      },
      async sealAuthentication() {},
      async stop() {
        browserStops += 1;
        browserOwner = null;
      },
    },
    credentialVault: { async load() {} },
    jobStore: store,
    openCodeServer: {
      async startJob({ jobId }) {
        if (openCodeOwner !== null) {
          throw Object.assign(new Error("busy"), { code: "OPENCODE_SERVER_BUSY" });
        }
        openCodeOwner = jobId;
        return Object.freeze({ jobId });
      },
      async stop() {
        openCodeStops += 1;
        openCodeOwner = null;
      },
    },
    randomBytes: () => Buffer.alloc(32, 7),
  });

  await workflow.startAuthentication(ownerA.id);
  await assert.rejects(workflow.startAuthentication(ownerB.id), {
    code: "AUTHENTICATION_FAILED",
  });

  assert.equal(browserOwner, ownerA.id);
  assert.equal(openCodeOwner, ownerA.id);
  assert.equal(browserStops, 0);
  assert.equal(openCodeStops, 0);
  assert.equal((await store.load(ownerA.id)).state, "awaiting_manual_login");
  assert.equal((await store.load(ownerB.id)).state, "failed");
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

test("manual login confirmation remains fail-closed when the browser policy cannot be sealed", async (t) => {
  const jobId = "job-manualseal0001";
  const { store } = await createStore(t, request(), jobId);
  const sealError = Object.assign(new Error("seal failed"), {
    code: "BROWSER_RUNTIME_AUTH_SEAL_FAILED",
  });
  const { calls, workflow } = harness(store, { browserSealError: sealError });
  await workflow.startAuthentication(jobId);

  await assert.rejects(workflow.confirmManualLogin(jobId), (error) => error === sealError);
  assert.deepEqual(calls.browserSeals, [jobId]);
  assert.equal((await store.load(jobId)).state, "awaiting_manual_login");
  assert.equal((await store.readEvents(jobId)).at(-1).event, "AUTH_REQUIRED");
});

test("StudioService cancellation aborts startup without stopping unowned runtimes", async (t) => {
  const jobId = "job-authcancel00001";
  const { store } = await createStore(
    t,
    request({ authMode: "automatic", credentialId: "fixture-login" }),
    jobId,
  );
  let browserEntered;
  const entered = new Promise((resolvePromise) => {
    browserEntered = resolvePromise;
  });
  const calls = { browserStops: 0, openCodeStops: 0, signals: [] };
  const browserRuntime = {
    async start(_job, options) {
      calls.signals.push(options.signal);
      browserEntered();
      await new Promise((resolvePromise, rejectPromise) => {
        options.signal.addEventListener(
          "abort",
          () => rejectPromise(options.signal.reason),
          { once: true },
        );
      });
    },
    async sealAuthentication() {},
    async stop() {
      calls.browserStops += 1;
    },
  };
  const openCodeServer = {
    async startJob(options) {
      calls.signals.push(options.signal);
    },
    async stop() {
      calls.openCodeStops += 1;
    },
  };
  const authenticationWorkflow = createAuthenticationWorkflow({
    browserRuntime,
    credentialVault: {
      async load() {
        return Object.freeze({
          origin: new URL(TARGET_URL).origin,
          username: "fixture-user",
          password: "fixture-password",
        });
      },
    },
    jobStore: store,
    openCodeServer,
    randomBytes: () => Buffer.alloc(32, 7),
  });
  const service = createStudioService({
    authenticationWorkflow,
    planningWorkflow: {
      async createPlan() {},
      async updatePlan() {},
      async approvePlan() {},
      async restoreLatestPlan() {},
    },
  });

  const starting = service.startAuthentication(jobId);
  await entered;
  const cancelled = await service.cancelAuthentication(jobId);

  assert.equal(cancelled.state, "cancelled");
  await assert.rejects(starting, { code: "AUTHENTICATION_CANCELLED" });
  assert.equal(calls.signals.length, 1);
  assert.equal(calls.signals[0] instanceof AbortSignal, true);
  assert.equal(calls.signals[0].aborted, true);
  assert.equal(calls.browserStops, 0);
  assert.equal(calls.openCodeStops, 0);
  const events = await store.readEvents(jobId);
  assert.equal(events.at(-1).event, "CANCEL_JOB");
  assert.equal(events.some(({ event }) => event === "AUTHENTICATION_FAILED"), false);
  assert.doesNotMatch(JSON.stringify(events), /fixture-user|fixture-password/);
});

test("final authentication persistence errors stop runtimes and propagate unchanged", async () => {
  const persistenceError = Object.assign(new Error("disk unavailable"), {
    code: "STORAGE_WRITE_FAILED",
  });
  const transitions = [];
  const store = {
    async load(jobId) {
      return Object.freeze({
        id: jobId,
        state: "created",
        request: Object.freeze({
          targetUrl: TARGET_URL,
          prompt: "프로젝트 메뉴를 여는 방법을 안내해 주세요.",
          authMode: "manual",
        }),
      });
    },
    async transition(_jobId, event) {
      transitions.push(event);
      if (event === "AUTH_REQUIRED") throw persistenceError;
      return Object.freeze({ state: "authenticating" });
    },
  };
  const calls = { browserStops: 0, openCodeStops: 0 };
  const workflow = createAuthenticationWorkflow({
    browserRuntime: {
      async start() {},
      async sealAuthentication() {},
      async stop() { calls.browserStops += 1; },
    },
    credentialVault: { async load() {} },
    jobStore: store,
    openCodeServer: {
      async startJob() {},
      async stop() { calls.openCodeStops += 1; },
    },
    randomBytes: () => Buffer.alloc(32, 7),
  });

  await assert.rejects(workflow.startAuthentication("job-authpersist001"), (error) =>
    error === persistenceError,
  );
  assert.deepEqual(transitions, ["START_AUTHENTICATION", "AUTH_REQUIRED"]);
  assert.equal(calls.browserStops, 1);
  assert.equal(calls.openCodeStops, 1);
});

test("cancelling an unstarted job never stops singleton runtimes owned elsewhere", async () => {
  let state = "created";
  const calls = { browserStops: 0, openCodeStops: 0 };
  const workflow = createAuthenticationWorkflow({
    browserRuntime: {
      async start() {},
      async sealAuthentication() {},
      async stop() { calls.browserStops += 1; },
    },
    credentialVault: { async load() {} },
    jobStore: {
      async load(jobId) {
        return Object.freeze({ id: jobId, state, request: request() });
      },
      async transition(_jobId, event) {
        if (event === "CANCEL_JOB") state = "cancelled";
        return Object.freeze({ state });
      },
    },
    openCodeServer: {
      async startJob() {},
      async stop() { calls.openCodeStops += 1; },
    },
    randomBytes: () => Buffer.alloc(32, 7),
  });

  const cancelled = await workflow.cancelAuthentication("job-notstarted0001");

  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(calls, { browserStops: 0, openCodeStops: 0 });
});

test("released authentication ownership cannot stop runtimes later owned by another stage", async (t) => {
  const { store } = await createStore(
    t,
    request({ authMode: "manual" }),
    "job-release-auth",
  );
  let browserStops = 0;
  let serverStops = 0;
  const workflow = createAuthenticationWorkflow({
    browserRuntime: {
      start: async () => ({}),
      sealAuthentication: async () => {},
      stop: async () => { browserStops += 1; },
    },
    credentialVault: { load: async () => ({ username: "demo", password: "secret" }) },
    jobStore: store,
    openCodeServer: {
      startJob: async () => ({}),
      stop: async () => { serverStops += 1; },
    },
  });

  await workflow.startAuthentication("job-release-auth");
  assert.equal(workflow.releaseAuthentication("job-release-auth"), true);
  assert.equal(workflow.releaseAuthentication("job-release-auth"), false);
  await workflow.cancelAuthentication("job-release-auth");

  assert.equal(browserStops, 0);
  assert.equal(serverStops, 0);
  assert.equal((await store.load("job-release-auth")).state, "cancelled");
});

test("cancellation winning the final auth persistence race is reported as cancellation", async (t) => {
  const jobId = "job-authfinalrace1";
  const { store } = await createStore(t, request(), jobId);
  let finalEntered;
  let releaseFinal;
  const entered = new Promise((resolvePromise) => { finalEntered = resolvePromise; });
  const gate = new Promise((resolvePromise) => { releaseFinal = resolvePromise; });
  const guardedStore = {
    load: (...args) => store.load(...args),
    async transition(id, event, data) {
      if (event === "AUTH_REQUIRED") {
        finalEntered();
        await gate;
      }
      return store.transition(id, event, data);
    },
  };
  const authenticationWorkflow = createAuthenticationWorkflow({
    browserRuntime: { async start() {}, async sealAuthentication() {}, async stop() {} },
    credentialVault: { async load() {} },
    jobStore: guardedStore,
    openCodeServer: { async startJob() {}, async stop() {} },
    randomBytes: () => Buffer.alloc(32, 7),
  });
  const service = createStudioService({
    authenticationWorkflow,
    planningWorkflow: {
      async createPlan() {},
      async updatePlan() {},
      async approvePlan() {},
      async restoreLatestPlan() {},
    },
  });

  const starting = service.startAuthentication(jobId);
  await entered;
  const cancelled = await service.cancelAuthentication(jobId);
  releaseFinal();

  assert.equal(cancelled.state, "cancelled");
  await assert.rejects(starting, { code: "AUTHENTICATION_CANCELLED" });
  assert.equal((await store.load(jobId)).state, "cancelled");
});

test("close drains retained manual authentication through cleanup and durable cancellation", async (t) => {
  const jobId = "job-auth-close-drain";
  const { store } = await createStore(t, request(), jobId);
  let releaseBrowserStop;
  const browserStopGate = new Promise((resolvePromise) => {
    releaseBrowserStop = resolvePromise;
  });
  let browserStopEntered;
  const browserStopStarted = new Promise((resolvePromise) => {
    browserStopEntered = resolvePromise;
  });
  const signals = [];
  let browserStops = 0;
  let openCodeStops = 0;
  const workflow = createAuthenticationWorkflow({
    browserRuntime: {
      async start(_job, { signal }) {
        signals.push(signal);
        return Object.freeze({ jobId });
      },
      async sealAuthentication() {},
      async stop() {
        browserStops += 1;
        browserStopEntered();
        await browserStopGate;
      },
    },
    credentialVault: { async load() {} },
    jobStore: store,
    openCodeServer: {
      async startJob({ signal }) {
        signals.push(signal);
        return Object.freeze({ jobId });
      },
      async stop() {
        openCodeStops += 1;
      },
    },
    randomBytes: () => Buffer.alloc(32, 7),
  });
  const awaiting = await workflow.startAuthentication(jobId);
  assert.equal(awaiting.state, "awaiting_manual_login");

  const closing = workflow.close();
  assert.equal(workflow.close(), closing);
  let closeResolved = false;
  closing.then(() => { closeResolved = true; });
  await browserStopStarted;
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(closeResolved, false);
  assert.equal(signals.every((signal) => signal.aborted), true);
  assert.equal((await store.load(jobId)).state, "awaiting_manual_login");
  releaseBrowserStop();
  await closing;

  assert.equal(browserStops, 1);
  assert.equal(openCodeStops, 1);
  assert.equal((await store.load(jobId)).state, "cancelled");
  assert.equal((await store.readEvents(jobId)).at(-1).event, "CANCEL_JOB");
  await assert.rejects(workflow.startAuthentication(jobId), {
    code: "AUTHENTICATION_CLOSED",
  });
});

test("cleanupAuthentication stops owned runtimes without changing the durable job state", async (t) => {
  const jobId = "job-auth-cleanup-only";
  const { store } = await createStore(t, request(), jobId);
  const { calls, workflow } = harness(store);

  const awaiting = await workflow.startAuthentication(jobId);
  assert.equal(awaiting.state, "awaiting_manual_login");
  await workflow.cleanupAuthentication(jobId);

  assert.equal(calls.browserStops, 1);
  assert.equal(calls.openCodeStops, 1);
  assert.equal((await store.load(jobId)).state, "awaiting_manual_login");
  assert.equal((await store.readEvents(jobId)).at(-1).event, "AUTH_REQUIRED");
});
