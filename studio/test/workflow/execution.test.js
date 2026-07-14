import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileExecutionCalls } from "../../src/domain/execution-calls.js";
import { digestPlan } from "../../src/domain/plan.js";
import { ExecutionLock } from "../../src/jobs/execution-lock.js";
import { JobStore } from "../../src/jobs/job-store.js";
import { createExecutionWorkflow } from "../../src/workflow/execution.js";

const TARGET_URL = "http://127.0.0.1:4317/fixture/dashboard";
const TARGET_ORIGIN = "http://127.0.0.1:4317";

function approvedPlan() {
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
  };
}

async function approvedStore(t, jobId) {
  const root = join(
    tmpdir(),
    `manual-video-execution-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(root, { recursive: true });
  const store = new JobStore({ root, randomId: () => jobId });
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const plan = approvedPlan();
  const planDigest = digestPlan(plan);
  await store.create({
    targetUrl: TARGET_URL,
    prompt: "프로젝트 메뉴를 여는 방법을 안내해 주세요.",
    authMode: "manual",
  });
  await store.transition(jobId, "START_AUTHENTICATION", { authMode: "manual" });
  await store.transition(jobId, "AUTH_REQUIRED", { reason: "manual_login" });
  await store.transition(jobId, "CONFIRM_LOGIN", { confirmed: true });
  await store.transition(jobId, "PLAN_READY", { plan, planDigest });
  await store.transition(jobId, "APPROVE_PLAN", { plan, planDigest });
  return { plan, planDigest, root, store };
}

function completedReport(jobId, plan, planDigest) {
  const calls = compileExecutionCalls(plan);
  return {
    schemaVersion: "1.0",
    jobId,
    planDigest,
    status: "completed",
    startedAt: "2026-07-14T01:00:00.000Z",
    endedAt: "2026-07-14T01:00:05.000Z",
    finalOrigin: TARGET_ORIGIN,
    recordingPath: "browser/manual.webm",
    stoppedStepId: null,
    toolCalls: calls.map(({ id, tool }) => ({ id, tool })),
    steps: [
      {
        id: "step-01",
        startedAt: "2026-07-14T01:00:01.000Z",
        endedAt: "2026-07-14T01:00:04.000Z",
        observedOrigin: TARGET_ORIGIN,
        elementEvidence: "프로젝트 메뉴 링크와 프로젝트 목록 제목을 확인함",
        screenshotPath: "browser/step-01.png",
        expectedStatus: "passed",
        expectedEvidence: "프로젝트 목록이 표시됨",
        actionCallIds: ["step-01.click"],
      },
    ],
  };
}

function mismatchReport(jobId, plan, planDigest) {
  const calls = compileExecutionCalls(plan);
  return {
    ...completedReport(jobId, plan, planDigest),
    status: "mismatch",
    recordingPath: null,
    stoppedStepId: "step-01",
    toolCalls: calls.slice(0, 4).map(({ id, tool }) => ({ id, tool })),
    steps: [
      {
        ...completedReport(jobId, plan, planDigest).steps[0],
        screenshotPath: null,
        expectedStatus: "mismatch",
        expectedEvidence: "승인된 프로젝트 목록 대신 오류 대화상자가 표시됨",
      },
    ],
  };
}

function harness(store, jobId, finalValue, overrides = {}) {
  const calls = {
    approvals: [],
    attachAgents: [],
    runOptions: [],
    browserStops: 0,
    openCodeStops: 0,
  };
  const browserRuntime = {
    active: { jobId: overrides.runtimeJobId ?? jobId, generation: 7, phase: "planning" },
    installApproval(input) {
      calls.approvals.push(structuredClone(input));
      this.active = { jobId, generation: 7, phase: "execution" };
      return {
        jobId,
        generation: 7,
        planDigest: input.planDigest,
        callCount: input.calls.length,
      };
    },
    async stop() {
      calls.browserStops += 1;
    },
  };
  const openCodeServer = {
    activeJobId: overrides.runtimeJobId ?? jobId,
    async withAttachOptions(agent, callback) {
      calls.attachAgents.push(agent);
      return callback({
        baseUrl: "http://127.0.0.1:4096",
        studioRoot: "C:\\studio",
        env: Object.freeze({ PATH: "C:\\Windows" }),
        validateServerContract: async () => ({ valid: true }),
      });
    },
    async stop() {
      calls.openCodeStops += 1;
    },
  };
  const runOpenCode = overrides.runOpenCode ?? (async (options) => {
    calls.runOptions.push(options);
    await options.onEvent({
      kind: "event",
      event: {
        type: "tool_use",
        part: {
          callID: "runtime-call-1",
          tool: "playwright_browser_click",
          state: { status: "completed", input: { target: "e12" } },
        },
      },
    });
    return { finalText: typeof finalValue === "string" ? finalValue : JSON.stringify(finalValue) };
  });
  const executionLock = new ExecutionLock();
  const workflow = createExecutionWorkflow({
    browserRuntime,
    executionLock,
    jobStore: overrides.jobStore ?? store,
    openCodeServer,
    opencodePath: "C:\\tools\\opencode.exe",
    runOpenCode,
  });
  return { calls, executionLock, workflow };
}

test("execution installs the exact approved queue, persists progress, and reaches narration", async (t) => {
  const jobId = "job-execsuccess000001";
  const fixture = await approvedStore(t, jobId);
  const report = completedReport(jobId, fixture.plan, fixture.planDigest);
  const { calls, executionLock, workflow } = harness(fixture.store, jobId, report);

  const result = await workflow.execute(jobId, fixture.planDigest);

  assert.equal(result.job.state, "narrating");
  assert.deepEqual(result.report, report);
  assert.equal(calls.approvals.length, 1);
  assert.deepEqual(calls.approvals[0].calls, compileExecutionCalls(fixture.plan));
  assert.equal(calls.approvals[0].planDigest, fixture.planDigest);
  assert.deepEqual(calls.attachAgents, ["manual-video-executor"]);
  assert.equal(calls.runOptions[0].agent, "manual-video-executor");
  assert.match(calls.runOptions[0].prompt, /exact supplied call queue/iu);
  assert.match(calls.runOptions[0].prompt, new RegExp(fixture.planDigest, "u"));
  assert.equal(calls.runOptions[0].prompt.length < 11_000, true);
  assert.equal(calls.browserStops, 1);
  assert.equal(calls.openCodeStops, 1);
  assert.deepEqual(executionLock.snapshot(), { activeJobId: null, queuedJobId: null });

  const events = await fixture.store.readEvents(jobId);
  assert.deepEqual(events.slice(-3).map(({ event }) => event), [
    "START_EXECUTION",
    "EXECUTION_PROGRESS",
    "EXECUTION_COMPLETED",
  ]);
  assert.deepEqual(events.at(-2).data, {
    type: "tool_use",
    callId: "runtime-call-1",
    tool: "playwright_browser_click",
    status: "completed",
  });
});

test("execution rejects stale approval before installing gateway authority", async (t) => {
  const jobId = "job-execstale00000001";
  const fixture = await approvedStore(t, jobId);
  const { calls, executionLock, workflow } = harness(
    fixture.store,
    jobId,
    completedReport(jobId, fixture.plan, fixture.planDigest),
  );

  await assert.rejects(workflow.execute(jobId, "0".repeat(64)), {
    code: "PLAN_DIGEST_MISMATCH",
  });
  assert.equal((await fixture.store.load(jobId)).state, "approved");
  assert.equal(calls.approvals.length, 0);
  assert.deepEqual(executionLock.snapshot(), { activeJobId: null, queuedJobId: null });
});

test("a validated mismatch stops all runtimes and enters needs_review", async (t) => {
  const jobId = "job-execmismatch00001";
  const fixture = await approvedStore(t, jobId);
  const report = mismatchReport(jobId, fixture.plan, fixture.planDigest);
  const { calls, workflow } = harness(fixture.store, jobId, report);

  const result = await workflow.execute(jobId, fixture.planDigest);

  assert.equal(result.job.state, "needs_review");
  assert.equal(result.report.status, "mismatch");
  assert.equal(calls.browserStops, 1);
  assert.equal(calls.openCodeStops, 1);
  assert.equal((await fixture.store.readEvents(jobId)).at(-1).event, "EXECUTION_MISMATCH");
});

test("malformed executor output fails closed, cleans runtimes, and releases the lock", async (t) => {
  const jobId = "job-execfailure00001";
  const fixture = await approvedStore(t, jobId);
  const { calls, executionLock, workflow } = harness(fixture.store, jobId, "```json\n{}\n```");

  await assert.rejects(workflow.execute(jobId, fixture.planDigest), {
    code: "EXECUTION_FAILED",
  });

  assert.equal((await fixture.store.load(jobId)).state, "failed");
  assert.equal(calls.browserStops, 1);
  assert.equal(calls.openCodeStops, 1);
  assert.deepEqual(executionLock.snapshot(), { activeJobId: null, queuedJobId: null });
  assert.equal((await fixture.store.readEvents(jobId)).at(-1).data.reason, "executor_output_rejected");
});

test("terminal storage failures are not masked as executor failures", async (t) => {
  const jobId = "job-execstorage00001";
  const fixture = await approvedStore(t, jobId);
  const sentinel = Object.assign(new Error("storage write failed"), { code: "STORAGE_WRITE_FAILED" });
  const jobStore = {
    load: (...args) => fixture.store.load(...args),
    readEvents: (...args) => fixture.store.readEvents(...args),
    transition: (id, event, data) => {
      if (event === "EXECUTION_COMPLETED") throw sentinel;
      return fixture.store.transition(id, event, data);
    },
  };
  const { workflow } = harness(
    fixture.store,
    jobId,
    completedReport(jobId, fixture.plan, fixture.planDigest),
    { jobStore },
  );

  await assert.rejects(workflow.execute(jobId, fixture.planDigest), (error) => error === sentinel);
  assert.equal((await fixture.store.load(jobId)).state, "executing");
  assert.equal(
    (await fixture.store.readEvents(jobId)).some(({ event }) => event === "EXECUTION_FAILED"),
    false,
  );
});

test("cancelling another job never stops the active job runtimes", async (t) => {
  const jobId = "job-execother0000001";
  const fixture = await approvedStore(t, jobId);
  const { calls, workflow } = harness(
    fixture.store,
    jobId,
    completedReport(jobId, fixture.plan, fixture.planDigest),
    { runtimeJobId: "job-activeother00001" },
  );

  const cancelled = await workflow.cancel(jobId);

  assert.equal(cancelled.state, "cancelled");
  assert.equal(calls.browserStops, 0);
  assert.equal(calls.openCodeStops, 0);
});

test("cancel aborts an in-flight executor and durably cancels the job", async (t) => {
  const jobId = "job-execcancel000001";
  const fixture = await approvedStore(t, jobId);
  let started;
  const startedPromise = new Promise((resolvePromise) => { started = resolvePromise; });
  const runOpenCode = async (options) => {
    started();
    await new Promise((resolvePromise, rejectPromise) => {
      options.signal.addEventListener("abort", () => rejectPromise(options.signal.reason), { once: true });
    });
  };
  const { calls, executionLock, workflow } = harness(fixture.store, jobId, null, { runOpenCode });

  const executing = workflow.execute(jobId, fixture.planDigest);
  await startedPromise;
  const cancelled = await workflow.cancel(jobId);
  await assert.rejects(executing, { code: "EXECUTION_CANCELLED" });

  assert.equal(cancelled.state, "cancelled");
  assert.equal((await fixture.store.load(jobId)).state, "cancelled");
  assert.equal(calls.browserStops >= 1, true);
  assert.equal(calls.openCodeStops >= 1, true);
  assert.deepEqual(executionLock.snapshot(), { activeJobId: null, queuedJobId: null });
});
