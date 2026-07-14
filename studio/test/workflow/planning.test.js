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
const AUTH_ORIGINS = Object.freeze(["https://login.example.test"]);
const RESOURCE_ORIGINS = Object.freeze(["https://cdn.example.test"]);
const PROJECTS_LINK = 'getByRole("link", { name: "프로젝트 메뉴 열기", exact: true })';
const COMPLETION_CONDITION = "Manual Video 완료 배지가 보이면 끝냅니다.";
const DEFAULT_COMPLETION_CONDITION = "요청한 최종 화면이 보이면 완료";

function validPlan(overrides = {}) {
  return {
    schemaVersion: "1.1",
    targetUrl: TARGET_URL,
    targetOrigin: TARGET_ORIGIN,
    authOrigins: [...AUTH_ORIGINS],
    resourceOrigins: [...RESOURCE_ORIGINS],
    successCriteria: [COMPLETION_CONDITION],
    forbiddenActions: ["사용자 데이터 변경"],
    captureSettings: { width: 1920, height: 1080, fps: 30 },
    steps: [
      {
        id: "step-01",
        action: "프로젝트 메뉴 열기",
        expected: COMPLETION_CONDITION,
        narration: "왼쪽 탐색 영역에서 프로젝트 메뉴를 선택합니다.",
        risk: "safe",
        calls: [
          {
            id: "step-01.click",
            tool: "browser_click",
            arguments: { element: "프로젝트 메뉴 열기", target: PROJECTS_LINK },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function planWithCompletion(completionCondition) {
  return validPlan({
    successCriteria: [completionCondition],
    steps: [{ ...validPlan().steps[0], expected: completionCondition }],
  });
}

async function createPlanningStore(
  t,
  jobId,
  { confirm = true, completionCondition = COMPLETION_CONDITION } = {},
) {
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
    ...(completionCondition === null ? {} : { completionCondition }),
    authMode: "manual",
    authOrigins: [...AUTH_ORIGINS],
    resourceOrigins: [...RESOURCE_ORIGINS],
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

function workflowHarness(store, finalText, { toolEvents } = {}) {
  const calls = { attachAgents: [], runs: [] };
  const outputs = Array.isArray(finalText) ? [...finalText] : [finalText];
  const reports = toolEvents ?? [
    Object.freeze({
      status: "completed",
      tool: "playwright_browser_snapshot",
    }),
  ];
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
    const output = outputs[Math.min(calls.runs.length - 1, outputs.length - 1)];
    return Object.freeze({ finalText: output, toolEvents: reports });
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
  assert.match(calls.runs[0].prompt, /Manual Video 완료 배지/u);
  assert.match(calls.runs[0].prompt, /captureSettings.*1920.*1080.*30/su);
  assert.match(calls.runs[0].prompt, /first action.*playwright_browser_snapshot/iu);
  assert.match(calls.runs[0].prompt, /successCriteria.*JSON array/iu);
  assert.match(calls.runs[0].prompt, /final successCriteria.*completionCondition/iu);
  assert.match(calls.runs[0].prompt, /final step.*expected.*completionCondition/iu);
  assert.match(calls.runs[0].prompt, /risk.*safe.*review.*blocked/iu);
  assert.match(calls.runs[0].prompt, /narration.*60.*code units/iu);
  assert.match(calls.runs[0].prompt, /forbiddenActions.*user-data\.change.*purchase\.create/su);
  assert.match(calls.runs[0].prompt, /browser_click.*target.*element/su);
  assert.match(calls.runs[0].prompt, /getByRole.*exact: true/su);
  const authority = JSON.parse(calls.runs[0].prompt.split("\n").at(-1));
  assert.deepEqual(authority.authOrigins, AUTH_ORIGINS);
  assert.deepEqual(authority.resourceOrigins, RESOURCE_ORIGINS);

  const event = (await store.readEvents(jobId)).at(-1);
  assert.equal(event.event, "PLAN_READY");
  assert.deepEqual(event.data.plan, result.plan);
  assert.equal(event.data.planDigest, result.planDigest);
});

test("planning accepts one otherwise-exact fenced JSON object without commentary", async (t) => {
  const jobId = "job-planfenced00001";
  const { store } = await createPlanningStore(t, jobId);
  const candidate = validPlan({ targetUrl: `${TARGET_ORIGIN}/fixture/login` });
  const { workflow } = workflowHarness(
    store,
    `\`\`\`json\n${JSON.stringify(candidate)}\n\`\`\``,
  );

  const result = await workflow.createPlan(jobId);

  assert.equal(result.job.state, "plan_review");
  assert.equal(result.planDigest, digestPlan(result.plan));
});

test("planning repairs plans that do not preserve the requested completion condition at the final boundary", async (t) => {
  const candidates = [
    validPlan({ successCriteria: ["프로젝트 목록이 표시됨"] }),
    validPlan({
      steps: [{ ...validPlan().steps[0], expected: "프로젝트 목록이 표시됨" }],
    }),
    validPlan({ successCriteria: [COMPLETION_CONDITION, "프로젝트 목록이 표시됨"] }),
  ];

  for (const [index, candidate] of candidates.entries()) {
    await t.test(String(index), async (t) => {
      const jobId = `job-plancomplete${index}01`;
      const { store } = await createPlanningStore(t, jobId);
      const { calls, workflow } = workflowHarness(store, [
        JSON.stringify(candidate),
        JSON.stringify(validPlan()),
      ]);

      const result = await workflow.createPlan(jobId);

      assert.equal(result.job.state, "plan_review");
      assert.equal(calls.runs.length, 2);
      assert.match(calls.runs[1].prompt, /PLANNING_COMPLETION_UNBOUND/u);
    });
  }
});

test("planning binds the durable default completion condition without requiring a literal text probe", async (t) => {
  const jobId = "job-plandefault0001";
  const { store } = await createPlanningStore(t, jobId, {
    completionCondition: null,
  });
  const { calls, workflow } = workflowHarness(store, [
    JSON.stringify(validPlan()),
    JSON.stringify(planWithCompletion(DEFAULT_COMPLETION_CONDITION)),
  ]);

  const result = await workflow.createPlan(jobId);

  assert.equal(result.plan.successCriteria.at(-1), DEFAULT_COMPLETION_CONDITION);
  assert.equal(result.plan.steps.at(-1).expected, DEFAULT_COMPLETION_CONDITION);
  assert.equal(result.plan.steps.at(-1).calls.at(-1).tool, "browser_click");
  assert.equal(calls.runs.length, 2);
});

test("planning repairs ephemeral snapshot refs into digest-bound stable accessibility locators", async (t) => {
  const jobId = "job-planlocator0001";
  const { store } = await createPlanningStore(t, jobId);
  const ephemeral = validPlan({
    steps: [{
      ...validPlan().steps[0],
      calls: [{
        id: "step-01.click",
        tool: "browser_click",
        arguments: { element: "프로젝트 메뉴 열기", target: "e12" },
      }],
    }],
  });
  const { calls, workflow } = workflowHarness(store, [
    JSON.stringify(ephemeral),
    JSON.stringify(validPlan()),
  ]);

  const result = await workflow.createPlan(jobId);

  assert.equal(result.plan.steps[0].calls[0].arguments.target, PROJECTS_LINK);
  assert.equal(calls.runs.length, 2);
  assert.match(calls.runs[1].prompt, /PLANNING_TARGET_UNSTABLE/u);
  assert.equal(calls.runs[1].prompt.includes("e12"), false);
});

test("planning fails closed after two ephemeral snapshot-ref plans", async (t) => {
  const jobId = "job-planrefbounded1";
  const { store } = await createPlanningStore(t, jobId);
  const ephemeral = validPlan({
    steps: [{
      ...validPlan().steps[0],
      calls: [{
        id: "step-01.click",
        tool: "browser_click",
        arguments: { element: "프로젝트 메뉴 열기", target: "f3e6" },
      }],
    }],
  });
  const { calls, workflow } = workflowHarness(store, JSON.stringify(ephemeral));

  await assert.rejects(workflow.createPlan(jobId), { code: "PLANNING_FAILED" });

  assert.equal(calls.runs.length, 2);
  assert.equal((await store.load(jobId)).state, "failed");
  assert.equal((await store.readEvents(jobId)).at(-1).event, "PLANNING_FAILED");
});

test("planning repairs invented exact names after navigation into strict unique partial locators", async (t) => {
  const jobId = "job-planfuture00001";
  const { store } = await createPlanningStore(t, jobId);
  const secondStep = (target) => ({
    id: "step-02",
    action: "Manual Video 프로젝트 열기",
    expected: COMPLETION_CONDITION,
    narration: "Manual Video 프로젝트를 선택합니다.",
    risk: "safe",
    calls: [
      {
        id: "step-02.click",
        tool: "browser_click",
        arguments: { element: "Manual Video 프로젝트", target },
      },
      {
        id: "step-02.completion",
        tool: "browser_wait_for",
        arguments: { text: "Manual Video 완료" },
      },
    ],
  });
  const firstStep = {
    ...validPlan().steps[0],
    navigationTarget: `${TARGET_ORIGIN}/fixture/projects`,
  };
  const exactFuture = validPlan({
    steps: [
      firstStep,
      secondStep('getByRole("link", { name: "Manual Video", exact: true })'),
    ],
  });
  const partialFuture = validPlan({
    steps: [
      firstStep,
      secondStep('getByRole("link", { name: "Manual Video" })'),
    ],
  });
  const { calls, workflow } = workflowHarness(store, [
    JSON.stringify(exactFuture),
    JSON.stringify(partialFuture),
  ]);

  const result = await workflow.createPlan(jobId);

  assert.equal(result.plan.steps[1].calls[0].arguments.target, 'getByRole("link", { name: "Manual Video" })');
  assert.equal(calls.runs.length, 2);
  assert.match(calls.runs[1].prompt, /PLANNING_FUTURE_TARGET_EXACT/u);
});

test("planning makes one evidence-bound repair after a rejected planner object", async (t) => {
  const jobId = "job-planrepair000001";
  const { store } = await createPlanningStore(t, jobId);
  const { calls, workflow } = workflowHarness(store, [
    JSON.stringify({ ...validPlan(), successCriteria: "wrong shape" }),
    JSON.stringify(validPlan()),
  ]);

  const result = await workflow.createPlan(jobId);

  assert.equal(result.job.state, "plan_review");
  assert.equal(calls.runs.length, 2);
  assert.match(calls.runs[1].prompt, /Previous planner object was rejected/iu);
  assert.match(calls.runs[1].prompt, /plan\.successCriteria/iu);
  assert.match(calls.runs[1].prompt, /invalid_array_length/iu);
  assert.equal(calls.runs[1].prompt.includes("wrong shape"), false);
});

test("planning repairs a schema-valid response that was not grounded in a completed snapshot", async (t) => {
  const jobId = "job-plansnapshot0001";
  const { store } = await createPlanningStore(t, jobId);
  const { calls, workflow } = workflowHarness(
    store,
    [JSON.stringify(validPlan()), JSON.stringify(validPlan())],
    { toolEvents: [] },
  );

  await assert.rejects(workflow.createPlan(jobId), { code: "PLANNING_FAILED" });
  assert.equal(calls.runs.length, 2);
  assert.match(calls.runs[1].prompt, /PLANNING_SNAPSHOT_REQUIRED/u);
  assert.equal((await store.load(jobId)).state, "failed");
});

test("planning passes the coordinator shutdown signal to OpenCode", async (t) => {
  const jobId = "job-plansignal0001";
  const { store } = await createPlanningStore(t, jobId);
  const { calls, workflow } = workflowHarness(store, JSON.stringify(validPlan()));
  const controller = new AbortController();

  await workflow.createPlan(jobId, { signal: controller.signal });

  assert.equal(calls.runs.length, 1);
  assert.equal(calls.runs[0].signal, controller.signal);
});

test("malformed planner JSON fails closed after one bounded repair without a reviewable plan", async (t) => {
  const jobId = "job-planbadjson001";
  const { store } = await createPlanningStore(t, jobId);
  const { calls, workflow } = workflowHarness(store, "Commentary before JSON.\n{}");

  await assert.rejects(
    workflow.createPlan(jobId),
    (error) => error.code === "PLANNING_FAILED" && error.retryable === true,
  );

  assert.equal((await store.load(jobId)).state, "failed");
  const events = await store.readEvents(jobId);
  assert.equal(events.at(-1).event, "PLANNING_FAILED");
  assert.deepEqual(events.at(-1).data.outputFailure, {
    code: "PLANNING_OUTPUT_INVALID",
    reason: "json_parse_other_text",
  });
  assert.equal(events.some(({ event }) => event === "PLAN_READY"), false);
  assert.equal(await restoreLatestPlan(store, jobId), null);
  assert.equal(calls.runs.length, 2);
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
          authOrigins: [...AUTH_ORIGINS],
          resourceOrigins: [...RESOURCE_ORIGINS],
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
  const { workflow } = workflowHarness(
    store,
    JSON.stringify(planWithCompletion(DEFAULT_COMPLETION_CONDITION)),
  );

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

test("a planner cannot add, remove, or reclassify approved authentication and resource origins", async (t) => {
  const candidates = [
    validPlan({ authOrigins: ["https://attacker.invalid"] }),
    validPlan({ authOrigins: [] }),
    validPlan({
      authOrigins: [...RESOURCE_ORIGINS],
      resourceOrigins: [...AUTH_ORIGINS],
    }),
  ];

  for (const [index, candidate] of candidates.entries()) {
    await t.test(String(index), async (t) => {
      const jobId = `job-planallow${index}001`;
      const { store } = await createPlanningStore(t, jobId);
      const { workflow } = workflowHarness(store, JSON.stringify(candidate));

      await assert.rejects(workflow.createPlan(jobId), { code: "PLANNING_FAILED" });
      assert.equal((await store.load(jobId)).state, "failed");
    });
  }
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

  await assert.rejects(
    workflow.updatePlan(
      jobId,
      validPlan({ successCriteria: ["프로젝트 목록이 표시됨"] }),
      planned.planDigest,
    ),
    { code: "PLANNING_COMPLETION_UNBOUND" },
  );
  assert.equal((await store.readEvents(jobId)).at(-1).event, "PLAN_READY");

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
    successCriteria: ["Manual Video 프로젝트가 표시됨", COMPLETION_CONDITION],
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

test("restored plans cannot lose the immutable completion binding", async (t) => {
  const jobId = "job-plancompletebad1";
  const { store } = await createPlanningStore(t, jobId);
  const unboundPlan = validatePlan(validPlan({
    successCriteria: ["프로젝트 목록이 표시됨"],
  }));
  const unboundDigest = digestPlan(unboundPlan);
  await store.transition(jobId, "PLAN_READY", {
    plan: unboundPlan,
    planDigest: unboundDigest,
  });

  await assert.rejects(restoreLatestPlan(store, jobId), {
    code: "PLANNING_COMPLETION_UNBOUND",
  });
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
      successCriteria: ["첫 번째 편집", COMPLETION_CONDITION],
    }), planned.planDigest),
    secondService.updatePlan(jobId, validPlan({
      successCriteria: ["두 번째 편집", COMPLETION_CONDITION],
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
