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
const DEFAULT_COMPLETION_CONDITION = "요청한 최종 화면이 보이면 완료";

function approvedPlan() {
  return {
    schemaVersion: "1.1",
    targetUrl: TARGET_URL,
    targetOrigin: TARGET_ORIGIN,
    authOrigins: [],
    resourceOrigins: [],
    successCriteria: [DEFAULT_COMPLETION_CONDITION],
    forbiddenActions: ["사용자 데이터 변경"],
    captureSettings: { width: 1920, height: 1080, fps: 30 },
    steps: [
      {
        id: "step-01",
        action: "프로젝트 메뉴 열기",
        expected: DEFAULT_COMPLETION_CONDITION,
        narration: "왼쪽 탐색 영역에서 프로젝트 메뉴를 선택합니다.",
        risk: "safe",
        calls: [
          {
            id: "step-01.click",
            tool: "browser_click",
            arguments: { element: "프로젝트 메뉴", target: 'getByRole("link", { name: "프로젝트 메뉴", exact: true })' },
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

function measuredTiming(jobId, planDigest, toolCalls) {
  const approved = compileExecutionCalls(approvedPlan());
  const offsets = [
    [-1, 0],
    [0, 500],
    [1_000, 1_100],
    [1_100, 1_200],
    [1_200, 2_000],
    [2_000, 2_500],
    [2_500, 3_000],
    [3_000, 4_000],
    [4_000, 4_500],
    [5_000, 5_001],
  ];
  const origin = Date.parse("2026-07-14T01:00:00.000Z");
  return Object.freeze({
    schemaVersion: "1.0",
    clock: "unix_ms",
    jobId,
    generation: 7,
    planDigest,
    complete: toolCalls.length === approved.length,
    calls: Object.freeze(toolCalls.map((call, index) => Object.freeze({
      id: call.id,
      tool: call.tool,
      startedAtMs: origin + offsets[index][0],
      endedAtMs: origin + offsets[index][1],
    }))),
  });
}

function harness(store, jobId, finalValue, overrides = {}) {
  const calls = {
    approvals: [],
    executions: [],
    attachAgents: [],
    runOptions: [],
    browserStops: 0,
    timingReads: [],
    artifactReads: [],
    evidenceReads: [],
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
    async executeApproval(input, options) {
      calls.executions.push(structuredClone(input));
      if (overrides.executeApproval) {
        return overrides.executeApproval(input, options);
      }
      await options.onCall({
        id: "runtime-call-1",
        tool: "browser_click",
        status: "completed",
      });
      if (overrides.executionResult !== undefined) return overrides.executionResult;
      const report = typeof finalValue === "object" && finalValue !== null
        ? structuredClone(finalValue)
        : null;
      return Object.freeze({
        schemaVersion: "1.0",
        jobId,
        generation: 7,
        planDigest: input.planDigest,
        status: report?.status ?? "completed",
        callCount: report?.toolCalls?.length ?? compileExecutionCalls(approvedPlan()).length,
        ...(report === null ? {} : { report }),
      });
    },
    readExecutionTiming(input) {
      calls.timingReads.push(structuredClone(input));
      const toolCalls = typeof finalValue === "object" && finalValue !== null
        ? finalValue.toolCalls
        : compileExecutionCalls(approvedPlan());
      return overrides.executionTiming ?? measuredTiming(jobId, input.planDigest, toolCalls);
    },
    async readRecordingArtifact(input) {
      calls.artifactReads.push(structuredClone(input));
      return overrides.recordingArtifact ?? Object.freeze({
        schemaVersion: "1.0",
        jobId,
        generation: 7,
        planDigest: input.planDigest,
        approvedCallId: "system.stop-video",
        recordingPath: "browser/manual.webm",
      });
    },
    async readEvidenceArtifacts(input) {
      calls.evidenceReads.push(structuredClone(input));
      return overrides.evidenceArtifacts ?? Object.freeze({
        schemaVersion: "1.0",
        jobId,
        generation: 7,
        planDigest: input.planDigest,
        artifacts: Object.freeze([
          Object.freeze({
            approvedCallId: "step-01.evidence-screenshot",
            screenshotPath: "browser/step-01.png",
          }),
        ]),
      });
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
  assert.deepEqual(calls.executions, [{
    jobId,
    generation: 7,
    planDigest: fixture.planDigest,
  }]);
  assert.deepEqual(calls.attachAgents, []);
  assert.deepEqual(calls.runOptions, []);
  assert.equal(calls.browserStops, 1);
  assert.equal(calls.openCodeStops, 1);
  assert.deepEqual(calls.timingReads, [{
    jobId,
    generation: 7,
    planDigest: fixture.planDigest,
  }]);
  assert.deepEqual(calls.artifactReads, [{
    jobId,
    generation: 7,
    planDigest: fixture.planDigest,
  }]);
  assert.deepEqual(calls.evidenceReads, [{
    jobId,
    generation: 7,
    planDigest: fixture.planDigest,
    expectedCallIds: ["step-01.evidence-screenshot"],
  }]);
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

test("coordinator timing replaces every executor-supplied timestamp before media persistence", async (t) => {
  const jobId = "job-exectiming0000001";
  const fixture = await approvedStore(t, jobId);
  const forged = completedReport(jobId, fixture.plan, fixture.planDigest);
  forged.startedAt = "2026-07-14T10:00:00.000Z";
  forged.endedAt = "2026-07-14T11:00:00.000Z";
  forged.steps[0].startedAt = "2026-07-14T10:10:00.000Z";
  forged.steps[0].endedAt = "2026-07-14T10:50:00.000Z";
  const { workflow } = harness(fixture.store, jobId, forged);

  const result = await workflow.execute(jobId, fixture.planDigest);

  assert.equal(result.report.startedAt, "2026-07-14T01:00:00.000Z");
  assert.equal(result.report.endedAt, "2026-07-14T01:00:05.000Z");
  assert.equal(result.report.steps[0].startedAt, "2026-07-14T01:00:01.000Z");
  assert.equal(result.report.steps[0].endedAt, "2026-07-14T01:00:04.000Z");
  const persisted = (await fixture.store.readEvents(jobId)).at(-1).data.report;
  assert.deepEqual(persisted, result.report);
  assert.notEqual(persisted.startedAt, forged.startedAt);
});

test("coordinator timing replaces malformed executor timestamps before report validation", async (t) => {
  const jobId = "job-exectimingbad0001";
  const fixture = await approvedStore(t, jobId);
  const forged = completedReport(jobId, fixture.plan, fixture.planDigest);
  forged.startedAt = "not-a-timestamp";
  forged.endedAt = "also-not-a-timestamp";
  forged.steps[0].startedAt = "fabricated";
  forged.steps[0].endedAt = "fabricated";
  const { workflow } = harness(fixture.store, jobId, forged);

  const result = await workflow.execute(jobId, fixture.planDigest);

  assert.equal(result.report.startedAt, "2026-07-14T01:00:00.000Z");
  assert.equal(result.report.endedAt, "2026-07-14T01:00:05.000Z");
  assert.equal(result.report.steps[0].startedAt, "2026-07-14T01:00:01.000Z");
  assert.equal(result.report.steps[0].endedAt, "2026-07-14T01:00:04.000Z");
});

test("gateway-owned stop-video artifact replaces an executor-forged recording path before persistence", async (t) => {
  const jobId = "job-execartifact000001";
  const fixture = await approvedStore(t, jobId);
  const forged = completedReport(jobId, fixture.plan, fixture.planDigest);
  forged.recordingPath = "browser/forged-by-executor.webm";
  const recordingPath = "browser/generation-7-a1b2c3d4e5f60718/video-owned.webm";
  const { workflow } = harness(fixture.store, jobId, forged, {
    recordingArtifact: Object.freeze({
      schemaVersion: "1.0",
      jobId,
      generation: 7,
      planDigest: fixture.planDigest,
      approvedCallId: "system.stop-video",
      recordingPath,
    }),
  });

  const result = await workflow.execute(jobId, fixture.planDigest);

  assert.equal(result.report.recordingPath, recordingPath);
  assert.equal((await fixture.store.readEvents(jobId)).at(-1).data.report.recordingPath, recordingPath);
  assert.notEqual(result.report.recordingPath, forged.recordingPath);
});

test("gateway-owned screenshot evidence replaces executor-forged paths before persistence", async (t) => {
  const jobId = "job-execevidence00001";
  const fixture = await approvedStore(t, jobId);
  const forged = completedReport(jobId, fixture.plan, fixture.planDigest);
  forged.steps[0].screenshotPath = "./page-forged.png";
  const screenshotPath = "browser/generation-7-a1b2c3d4e5f60718/page-owned.png";
  const { workflow } = harness(fixture.store, jobId, forged, {
    evidenceArtifacts: Object.freeze({
      schemaVersion: "1.0",
      jobId,
      generation: 7,
      planDigest: fixture.planDigest,
      artifacts: Object.freeze([
        Object.freeze({
          approvedCallId: "step-01.evidence-screenshot",
          screenshotPath,
        }),
      ]),
    }),
  });

  const result = await workflow.execute(jobId, fixture.planDigest);

  assert.equal(result.report.steps[0].screenshotPath, screenshotPath);
  assert.equal(
    (await fixture.store.readEvents(jobId)).at(-1).data.report.steps[0].screenshotPath,
    screenshotPath,
  );
  assert.notEqual(result.report.steps[0].screenshotPath, forged.steps[0].screenshotPath);
});

test("completed execution fails closed when recording artifact provenance does not match the active generation", async (t) => {
  const jobId = "job-execartifactbad001";
  const fixture = await approvedStore(t, jobId);
  const report = completedReport(jobId, fixture.plan, fixture.planDigest);
  const { workflow } = harness(fixture.store, jobId, report, {
    recordingArtifact: Object.freeze({
      schemaVersion: "1.0",
      jobId,
      generation: 6,
      planDigest: fixture.planDigest,
      approvedCallId: "system.stop-video",
      recordingPath: "browser/generation-6-deadbeefdeadbeef/video.webm",
    }),
  });

  await assert.rejects(workflow.execute(jobId, fixture.planDigest), {
    code: "EXECUTION_FAILED",
  });
  const events = await fixture.store.readEvents(jobId);
  assert.equal(events.at(-1).event, "EXECUTION_FAILED");
  assert.equal(events.at(-1).data.reason, "executor_output_rejected");
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

test("reapproval reruns the exact approved queue from a fresh runtime with a digest-bound CAS", async (t) => {
  const jobId = "job-execreapprove0001";
  const fixture = await approvedStore(t, jobId);
  const mismatch = harness(
    fixture.store,
    jobId,
    mismatchReport(jobId, fixture.plan, fixture.planDigest),
  );
  await mismatch.workflow.execute(jobId, fixture.planDigest);

  const completed = completedReport(jobId, fixture.plan, fixture.planDigest);
  const retried = harness(fixture.store, jobId, completed);
  const result = await retried.workflow.reapprove(jobId, fixture.planDigest);

  assert.equal(result.job.state, "narrating");
  assert.equal(result.report.status, "completed");
  assert.equal(retried.calls.approvals.length, 1);
  assert.deepEqual(
    retried.calls.approvals[0].calls,
    compileExecutionCalls(fixture.plan),
  );
  assert.equal(retried.calls.approvals[0].planDigest, fixture.planDigest);
  assert.deepEqual(
    (await fixture.store.readEvents(jobId)).slice(-3).map(({ event }) => event),
    ["REAPPROVE_EXECUTION", "EXECUTION_PROGRESS", "EXECUTION_COMPLETED"],
  );
});

test("reapproval accepts only the original mismatch behind a confirmed manual-login chain", async (t) => {
  const jobId = "job-execmanualreauth1";
  const fixture = await approvedStore(t, jobId);
  const mismatchRun = harness(
    fixture.store,
    jobId,
    mismatchReport(jobId, fixture.plan, fixture.planDigest),
  );
  await mismatchRun.workflow.execute(jobId, fixture.planDigest);
  const mismatch = (await fixture.store.readEvents(jobId)).at(-1);
  const binding = {
    reason: "manual_reexecution",
    planDigest: fixture.planDigest,
    mismatchSequence: mismatch.sequence,
  };
  await fixture.store.transition(jobId, "AUTHENTICATION_EXPIRED", binding);
  await fixture.store.transition(jobId, "AUTH_REQUIRED", binding);
  await fixture.store.transition(jobId, "CONFIRM_REEXECUTION_LOGIN", {
    confirmed: true,
    planDigest: fixture.planDigest,
    mismatchSequence: mismatch.sequence,
  });
  const retried = harness(
    fixture.store,
    jobId,
    completedReport(jobId, fixture.plan, fixture.planDigest),
  );

  const result = await retried.workflow.reapprove(jobId, fixture.planDigest);

  assert.equal(result.job.state, "narrating");
  const reapproval = (await fixture.store.readEvents(jobId)).find(
    ({ event }) => event === "REAPPROVE_EXECUTION",
  );
  assert.equal(reapproval.data.mismatchSequence, mismatch.sequence);
});

test("reapproval rejects a manual-login suffix unrelated to the original mismatch", async (t) => {
  const jobId = "job-execmanualforged1";
  const fixture = await approvedStore(t, jobId);
  const mismatchRun = harness(
    fixture.store,
    jobId,
    mismatchReport(jobId, fixture.plan, fixture.planDigest),
  );
  await mismatchRun.workflow.execute(jobId, fixture.planDigest);
  const mismatch = (await fixture.store.readEvents(jobId)).at(-1);
  const forgedSequence = mismatch.sequence - 1;
  await fixture.store.transition(jobId, "AUTHENTICATION_EXPIRED", {
    reason: "manual_reexecution",
    planDigest: fixture.planDigest,
    mismatchSequence: forgedSequence,
  });
  await fixture.store.transition(jobId, "AUTH_REQUIRED", {
    reason: "manual_reexecution",
    planDigest: fixture.planDigest,
    mismatchSequence: forgedSequence,
  });
  await fixture.store.transition(jobId, "CONFIRM_REEXECUTION_LOGIN", {
    confirmed: true,
    planDigest: fixture.planDigest,
    mismatchSequence: forgedSequence,
  });
  const retried = harness(
    fixture.store,
    jobId,
    completedReport(jobId, fixture.plan, fixture.planDigest),
  );

  await assert.rejects(
    retried.workflow.reapprove(jobId, fixture.planDigest),
    { code: "EXECUTION_REAPPROVAL_INVALID" },
  );
  assert.equal(retried.calls.approvals.length, 0);
});

test("reapproval keeps the original mismatch anchor behind rejection self-events", async (t) => {
  const jobId = "job-execreapproverejected";
  const fixture = await approvedStore(t, jobId);
  const mismatchRun = harness(
    fixture.store,
    jobId,
    mismatchReport(jobId, fixture.plan, fixture.planDigest),
  );
  await mismatchRun.workflow.execute(jobId, fixture.planDigest);
  const mismatch = (await fixture.store.readEvents(jobId)).at(-1);
  await fixture.store.transition(jobId, "OPERATION_REJECTED", {
    code: "EXECUTION_REAPPROVAL_INVALID",
    planDigest: fixture.planDigest,
    retryable: false,
  });
  await fixture.store.transition(jobId, "OPERATION_REJECTED", {
    code: "EXECUTION_REAPPROVAL_INVALID",
    planDigest: fixture.planDigest,
    retryable: false,
  });
  const currentSequence = (await fixture.store.load(jobId)).eventSequence;
  const retried = harness(
    fixture.store,
    jobId,
    completedReport(jobId, fixture.plan, fixture.planDigest),
  );

  const result = await retried.workflow.reapprove(jobId, fixture.planDigest);

  assert.equal(result.job.state, "narrating");
  const reapproval = (await fixture.store.readEvents(jobId)).find(
    ({ event }) => event === "REAPPROVE_EXECUTION",
  );
  assert.equal(reapproval.sequence, currentSequence + 1);
  assert.equal(reapproval.data.mismatchSequence, mismatch.sequence);
});

test("reapproval rejects stale digests and a changed mismatch before installing authority", async (t) => {
  const jobId = "job-execreapprovecas01";
  const fixture = await approvedStore(t, jobId);
  const mismatch = harness(
    fixture.store,
    jobId,
    mismatchReport(jobId, fixture.plan, fixture.planDigest),
  );
  await mismatch.workflow.execute(jobId, fixture.planDigest);

  const stale = harness(
    fixture.store,
    jobId,
    completedReport(jobId, fixture.plan, fixture.planDigest),
  );
  await assert.rejects(stale.workflow.reapprove(jobId, "f".repeat(64)), {
    code: "PLAN_DIGEST_MISMATCH",
  });
  assert.equal(stale.calls.approvals.length, 0);

  const racingStore = {
    load: (...args) => fixture.store.load(...args),
    readEvents: (...args) => fixture.store.readEvents(...args),
    transition: (...args) => fixture.store.transition(...args),
    async compareAndTransition(id, input) {
      await fixture.store.transition(id, "OPERATION_REJECTED", {
        code: "CONCURRENT_REVIEW_UPDATE",
      });
      return fixture.store.compareAndTransition(id, input);
    },
  };
  const raced = harness(
    fixture.store,
    jobId,
    completedReport(jobId, fixture.plan, fixture.planDigest),
    { jobStore: racingStore },
  );
  await assert.rejects(raced.workflow.reapprove(jobId, fixture.planDigest), {
    code: "JOB_COMPARE_FAILED",
  });
  assert.equal(raced.calls.approvals.length, 0);
  assert.equal((await fixture.store.load(jobId)).state, "needs_review");
});

test("invalid coordinator execution results fail closed, clean runtimes, and release the lock", async (t) => {
  const jobId = "job-execfailure00001";
  const fixture = await approvedStore(t, jobId);
  const { calls, executionLock, workflow } = harness(
    fixture.store,
    jobId,
    completedReport(jobId, fixture.plan, fixture.planDigest),
    {
      executionResult: Object.freeze({
        schemaVersion: "1.0",
        jobId,
        generation: 7,
        planDigest: fixture.planDigest,
        status: "completed",
        callCount: 0,
      }),
    },
  );

  await assert.rejects(workflow.execute(jobId, fixture.planDigest), {
    code: "EXECUTION_FAILED",
  });

  assert.equal((await fixture.store.load(jobId)).state, "failed");
  assert.equal(calls.browserStops, 1);
  assert.equal(calls.openCodeStops, 1);
  assert.deepEqual(executionLock.snapshot(), { activeJobId: null, queuedJobId: null });
  const failed = (await fixture.store.readEvents(jobId)).at(-1).data;
  assert.equal(failed.reason, "executor_output_rejected");
  assert.deepEqual(failed.outputFailure, { code: "EXECUTION_RESULT_INVALID" });
});

test("terminal storage failures are not masked as executor failures", async (t) => {
  const jobId = "job-execstorage00001";
  const fixture = await approvedStore(t, jobId);
  const sentinel = Object.assign(new Error("storage write failed"), { code: "STORAGE_WRITE_FAILED" });
  const jobStore = {
    load: (...args) => fixture.store.load(...args),
    readEvents: (...args) => fixture.store.readEvents(...args),
    compareAndTransition: (...args) => fixture.store.compareAndTransition(...args),
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
  const executeApproval = async (_input, options) => {
    started();
    await new Promise((resolvePromise, rejectPromise) => {
      options.signal.addEventListener("abort", () => rejectPromise(options.signal.reason), { once: true });
    });
  };
  const { calls, executionLock, workflow } = harness(
    fixture.store,
    jobId,
    null,
    { executeApproval },
  );

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
