import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digestPlan, validatePlan } from "../../src/domain/plan.js";
import { JobStore } from "../../src/jobs/job-store.js";
import {
  createPlanningWorkflow,
  restoreLatestPlan,
} from "../../src/workflow/planning.js";
import { createStudioService } from "../../src/workflow/studio-service.js";

const TARGET_URL = "http://127.0.0.1:4317/fixture/login";
const TARGET_ORIGIN = "http://127.0.0.1:4317";

function validPlan(overrides = {}) {
  return {
    schemaVersion: "1.1",
    targetUrl: TARGET_URL,
    targetOrigin: TARGET_ORIGIN,
    successCriteria: ["프로젝트 목록이 표시됨"],
    forbiddenActions: ["사용자 데이터 변경"],
    captureSettings: { width: 1920, height: 1080, fps: 30 },
    steps: [
      {
        id: "step-01",
        action: "프로젝트 메뉴 열기",
        expected: "프로젝트 목록이 표시됨",
        narration: "왼쪽 탐색 영역에서 프로젝트 메뉴를 선택합니다.",
        risk: "safe",
        calls: [
          {
            id: "step-01.click",
            tool: "browser_click",
            arguments: { element: "프로젝트 메뉴", target: "e12" },
          },
        ],
      },
    ],
    ...overrides,
  };
}

async function createPlanningStore(t, jobId, { confirm = true } = {}) {
  const root = join(
    tmpdir(),
    `manual-video-planning-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(root, { recursive: true });
  const store = new JobStore({ root, randomId: () => jobId });
  let closed = false;
  t.after(async () => {
    if (!closed) await store.close();
    await rm(root, { force: true, recursive: true });
  });
  await store.create({
    targetUrl: TARGET_URL,
    prompt: "프로젝트 메뉴를 여는 방법을 안내해 주세요.",
    authMode: "manual",
  });
  await store.transition(jobId, "START_AUTHENTICATION", { authMode: "manual" });
  await store.transition(jobId, "AUTH_REQUIRED", { reason: "manual_login" });
  if (confirm) {
    await store.transition(jobId, "CONFIRM_LOGIN", { confirmed: true });
  }
  return {
    root,
    store,
    async close() {
      if (!closed) {
        closed = true;
        await store.close();
      }
    },
  };
}

function workflowHarness(store, finalText) {
  const calls = { attachAgents: [], runs: [] };
  const openCodeServer = {
    async withAttachOptions(agent, callback) {
      calls.attachAgents.push(agent);
      return callback(Object.freeze({
        baseUrl: "http://127.0.0.1:4096",
        studioRoot: "C:\\studio",
        env: Object.freeze({ PATH: "C:\\Windows" }),
        validateServerContract: async () => Object.freeze({ valid: true }),
      }));
    },
  };
  const runOpenCode = async (options) => {
    calls.runs.push(options);
    return Object.freeze({ finalText });
  };
  const workflow = createPlanningWorkflow({
    jobStore: store,
    opencodePath: "C:\\tools\\opencode.exe",
    openCodeServer,
    runOpenCode,
  });
  return { calls, workflow };
}

test("planning uses the attached planner and durably stores the canonical plan and digest", async (t) => {
  const jobId = "job-planvalid00001";
  const { store } = await createPlanningStore(t, jobId);
  const { calls, workflow } = workflowHarness(
    store,
    JSON.stringify(validPlan({ targetUrl: `${TARGET_ORIGIN}/fixture/login` })),
  );

  const result = await workflow.createPlan(jobId);

  assert.equal(result.job.state, "plan_review");
  assert.equal(result.plan.targetUrl, TARGET_URL);
  assert.equal(result.plan.schemaVersion, "1.1");
  assert.equal(result.planDigest, digestPlan(result.plan));
  assert.deepEqual(calls.attachAgents, ["manual-video-planner"]);
  assert.equal(calls.runs.length, 1);
  assert.equal(calls.runs[0].agent, "manual-video-planner");
  assert.equal(calls.runs[0].opencodePath, "C:\\tools\\opencode.exe");
  assert.match(calls.runs[0].prompt, /schemaVersion.*1\.1/su);
  assert.match(calls.runs[0].prompt, /프로젝트 메뉴를 여는 방법/u);

  const event = (await store.readEvents(jobId)).at(-1);
  assert.equal(event.event, "PLAN_READY");
  assert.deepEqual(event.data.plan, result.plan);
  assert.equal(event.data.planDigest, result.planDigest);
});

test("malformed planner JSON fails closed without a reviewable plan", async (t) => {
  const jobId = "job-planbadjson001";
  const { store } = await createPlanningStore(t, jobId);
  const { workflow } = workflowHarness(store, "```json\n{}\n```");

  await assert.rejects(
    workflow.createPlan(jobId),
    (error) => error.code === "PLANNING_FAILED" && error.retryable === true,
  );

  assert.equal((await store.load(jobId)).state, "failed");
  const events = await store.readEvents(jobId);
  assert.equal(events.at(-1).event, "PLANNING_FAILED");
  assert.equal(events.some(({ event }) => event === "PLAN_READY"), false);
  assert.equal(await restoreLatestPlan(store, jobId), null);
});

test("PLAN_READY persistence failures are not masked as planner-output failures", async () => {
  const persistenceError = Object.assign(new Error("disk unavailable"), {
    code: "STORAGE_WRITE_FAILED",
  });
  const transitions = [];
  const store = {
    async load(jobId) {
      return Object.freeze({
        id: jobId,
        state: "planning",
        request: Object.freeze({
          targetUrl: TARGET_URL,
          prompt: "프로젝트 메뉴를 여는 방법을 안내해 주세요.",
          authMode: "manual",
        }),
      });
    },
    async readEvents() {
      return Object.freeze([]);
    },
    async transition(_jobId, event) {
      transitions.push(event);
      throw persistenceError;
    },
    async compareAndTransition() {},
  };
  const { workflow } = workflowHarness(store, JSON.stringify(validPlan()));

  await assert.rejects(workflow.createPlan("job-planpersist001"), (error) =>
    error === persistenceError,
  );
  assert.deepEqual(transitions, ["PLAN_READY"]);
});

test("a planner cannot expand authority to a different target origin", async (t) => {
  const jobId = "job-planorigin0001";
  const { store } = await createPlanningStore(t, jobId);
  const { workflow } = workflowHarness(
    store,
    JSON.stringify(validPlan({
      targetUrl: "https://attacker.invalid/dashboard",
      targetOrigin: "https://attacker.invalid",
    })),
  );

  await assert.rejects(workflow.createPlan(jobId), {
    code: "PLANNING_FAILED",
  });
  assert.equal((await store.load(jobId)).state, "failed");
  assert.equal(await restoreLatestPlan(store, jobId), null);
});

test("a planner cannot replace the approved top-level URL with another same-origin route", async (t) => {
  const jobId = "job-planurlchange01";
  const { store } = await createPlanningStore(t, jobId);
  const { workflow } = workflowHarness(
    store,
    JSON.stringify(validPlan({ targetUrl: `${TARGET_ORIGIN}/fixture/dashboard` })),
  );

  await assert.rejects(workflow.createPlan(jobId), {
    code: "PLANNING_FAILED",
  });
  assert.equal((await store.load(jobId)).state, "failed");
  assert.equal(await restoreLatestPlan(store, jobId), null);
});

test("blocked plans remain reviewable but cannot be approved", async (t) => {
  const jobId = "job-planblocked001";
  const { store } = await createPlanningStore(t, jobId);
  const blocked = validPlan({
    steps: [
      {
        ...validPlan().steps[0],
        action: "Submit the form",
      },
    ],
  });
  const { workflow } = workflowHarness(store, JSON.stringify(blocked));

  const planned = await workflow.createPlan(jobId);
  assert.equal(planned.plan.steps[0].risk, "blocked");
  await assert.rejects(workflow.approvePlan(jobId, planned.planDigest), { code: "BLOCKED_PLAN" });
  assert.equal((await store.load(jobId)).state, "plan_review");
  assert.equal(
    (await store.readEvents(jobId)).some(({ event }) => event === "APPROVE_PLAN"),
    false,
  );
});

test("plan edits replace the durable latest plan and approval stops at approved", async (t) => {
  const jobId = "job-planedit000001";
  const { store } = await createPlanningStore(t, jobId);
  const { calls, workflow } = workflowHarness(store, JSON.stringify(validPlan()));
  const planned = await workflow.createPlan(jobId);

  const editedCandidate = validPlan({
    steps: [
      {
        ...validPlan().steps[0],
        narration: "왼쪽 메뉴에서 프로젝트를 선택합니다.",
      },
    ],
  });
  const edited = await workflow.updatePlan(jobId, editedCandidate, planned.planDigest);
  assert.equal(edited.job.state, "plan_review");
  assert.equal(edited.plan.steps[0].narration, "왼쪽 메뉴에서 프로젝트를 선택합니다.");
  assert.notEqual(edited.planDigest, digestPlan(validPlan()));

  await assert.rejects(
    workflow.updatePlan(jobId, validPlan(), planned.planDigest),
    { code: "PLAN_DIGEST_MISMATCH" },
  );
  assert.equal((await store.readEvents(jobId)).at(-1).event, "UPDATE_PLAN");

  await assert.rejects(
    workflow.approvePlan(jobId, digestPlan(validPlan())),
    { code: "PLAN_DIGEST_MISMATCH" },
  );
  assert.equal((await store.load(jobId)).state, "plan_review");

  const approved = await workflow.approvePlan(jobId, edited.planDigest);
  assert.equal(approved.job.state, "approved");
  assert.deepEqual(approved.plan, edited.plan);
  assert.equal(approved.planDigest, edited.planDigest);
  assert.equal(calls.runs.length, 1);
  assert.deepEqual(
    (await store.readEvents(jobId)).slice(-2).map(({ event }) => event),
    ["UPDATE_PLAN", "APPROVE_PLAN"],
  );
});

test("latest canonical plan is recoverable from durable events after restart", async (t) => {
  const jobId = "job-planrestart001";
  const fixture = await createPlanningStore(t, jobId);
  const { workflow } = workflowHarness(fixture.store, JSON.stringify(validPlan()));
  const planned = await workflow.createPlan(jobId);
  const edited = await workflow.updatePlan(jobId, validPlan({
    successCriteria: ["Manual Video 프로젝트가 표시됨"],
  }), planned.planDigest);
  await fixture.close();

  const restarted = new JobStore({ root: fixture.root });
  const restored = await restoreLatestPlan(restarted, jobId);

  assert.deepEqual(restored.plan, edited.plan);
  assert.equal(restored.planDigest, edited.planDigest);
  assert.equal(restored.event, "UPDATE_PLAN");
  assert.equal(restored.approved, false);
  await restarted.close();
});

test("restored plans are rebound to the immutable job target before approval", async (t) => {
  const jobId = "job-planrestorebad1";
  const { store } = await createPlanningStore(t, jobId);
  const foreignPlan = validatePlan(validPlan({
    targetUrl: "https://attacker.invalid/dashboard",
    targetOrigin: "https://attacker.invalid",
  }));
  const foreignDigest = digestPlan(foreignPlan);
  await store.transition(jobId, "PLAN_READY", {
    plan: foreignPlan,
    planDigest: foreignDigest,
  });
  const { workflow } = workflowHarness(store, JSON.stringify(validPlan()));

  await assert.rejects(restoreLatestPlan(store, jobId), {
    code: "PLANNING_AUTHORITY_MISMATCH",
  });
  await assert.rejects(workflow.approvePlan(jobId, foreignDigest), {
    code: "PLANNING_AUTHORITY_MISMATCH",
  });
  assert.equal((await store.load(jobId)).state, "plan_review");
  assert.equal(
    (await store.readEvents(jobId)).some(({ event }) => event === "APPROVE_PLAN"),
    false,
  );
});

test("cross-instance plan edits use durable CAS so only one stale digest can commit", async (t) => {
  const jobId = "job-plancrosscas01";
  const { store } = await createPlanningStore(t, jobId);
  const base = workflowHarness(store, JSON.stringify(validPlan()));
  const planned = await base.workflow.createPlan(jobId);
  let readCount = 0;
  let releaseReads;
  const readGate = new Promise((resolvePromise) => {
    releaseReads = resolvePromise;
  });
  const sharedStore = {
    load: (...args) => store.load(...args),
    transition: (...args) => store.transition(...args),
    compareAndTransition: (...args) => store.compareAndTransition(...args),
    async readEvents(...args) {
      const snapshot = await store.readEvents(...args);
      readCount += 1;
      if (readCount <= 2) {
        if (readCount === 2) releaseReads();
        await readGate;
      }
      return snapshot;
    },
  };
  const firstWorkflow = workflowHarness(sharedStore, JSON.stringify(validPlan())).workflow;
  const secondWorkflow = workflowHarness(sharedStore, JSON.stringify(validPlan())).workflow;
  const auth = {
    async startAuthentication() {},
    async confirmManualLogin() {},
    async cancelAuthentication() {},
  };
  const firstService = createStudioService({
    authenticationWorkflow: auth,
    planningWorkflow: firstWorkflow,
  });
  const secondService = createStudioService({
    authenticationWorkflow: auth,
    planningWorkflow: secondWorkflow,
  });
  const edits = await Promise.allSettled([
    firstService.updatePlan(jobId, validPlan({
      successCriteria: ["첫 번째 편집"],
    }), planned.planDigest),
    secondService.updatePlan(jobId, validPlan({
      successCriteria: ["두 번째 편집"],
    }), planned.planDigest),
  ]);

  assert.equal(edits.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = edits.find(({ status }) => status === "rejected");
  assert.equal(rejected.reason.code, "PLAN_DIGEST_MISMATCH");
  assert.equal(
    (await store.readEvents(jobId)).filter(({ event }) => event === "UPDATE_PLAN").length,
    1,
  );
});

test("planning is forbidden while manual login is still awaiting confirmation", async (t) => {
  const jobId = "job-planguarded001";
  const fixture = await createPlanningStore(t, jobId, { confirm: false });
  const { workflow } = workflowHarness(fixture.store, JSON.stringify(validPlan()));

  await assert.rejects(workflow.createPlan(jobId), {
    code: "PLANNING_STATE_INVALID",
  });
  assert.equal((await fixture.store.load(jobId)).state, "awaiting_manual_login");
});

test("StudioService is dependency-injected and serializes plan mutation with approval", async () => {
  let releaseUpdate;
  const updateGate = new Promise((resolvePromise) => {
    releaseUpdate = resolvePromise;
  });
  const calls = [];
  const authenticationWorkflow = {
    async startAuthentication(jobId) {
      calls.push(["startAuthentication", jobId]);
      return "started";
    },
    async confirmManualLogin(jobId) {
      calls.push(["confirmManualLogin", jobId]);
      return "confirmed";
    },
    async cancelAuthentication(jobId) {
      calls.push(["cancelAuthentication", jobId]);
      return "cancelled";
    },
  };
  const planningWorkflow = {
    async createPlan(jobId) {
      calls.push(["createPlan", jobId]);
      return "planned";
    },
    async updatePlan(jobId, plan, expectedCurrentDigest) {
      calls.push(["updatePlan", jobId, plan, expectedCurrentDigest]);
      await updateGate;
      return "updated";
    },
    async approvePlan(jobId, expectedPlanDigest) {
      calls.push(["approvePlan", jobId, expectedPlanDigest]);
      return "approved";
    },
    async restoreLatestPlan(jobId) {
      calls.push(["restoreLatestPlan", jobId]);
      return "restored";
    },
  };
  const service = createStudioService({ authenticationWorkflow, planningWorkflow });

  assert.equal(await service.startAuthentication("job-service0000001"), "started");
  assert.equal(await service.confirmManualLogin("job-service0000001"), "confirmed");
  assert.equal(await service.createPlan("job-service0000001"), "planned");
  const updating = service.updatePlan(
    "job-service0000001",
    { revision: 2 },
    "b".repeat(64),
  );
  const approving = service.approvePlan("job-service0000001", "a".repeat(64));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(calls.some(([name]) => name === "approvePlan"), false);
  releaseUpdate();
  assert.equal(await updating, "updated");
  assert.equal(await approving, "approved");
  assert.equal(await service.restoreLatestPlan("job-service0000001"), "restored");
  assert.deepEqual(calls.map(([name]) => name), [
    "startAuthentication",
    "confirmManualLogin",
    "createPlan",
    "updatePlan",
    "approvePlan",
    "restoreLatestPlan",
  ]);
  assert.equal(calls.find(([name]) => name === "updatePlan")[3], "b".repeat(64));
  assert.equal(calls.find(([name]) => name === "approvePlan")[2], "a".repeat(64));
});
