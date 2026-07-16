import assert from "node:assert/strict";
import test from "node:test";

import { compileExecutionCalls } from "../../src/domain/execution-calls.js";
import { bindExecutionHighlights } from "../../src/domain/execution-highlights.js";
import { validateExecutionReport } from "../../src/domain/execution-report.js";
import { digestPlan } from "../../src/domain/plan.js";

const JOB_ID = "job-0123456789abcdef";

function plan() {
  return {
    schemaVersion: "1.1",
    targetUrl: "https://example.test/dashboard",
    targetOrigin: "https://example.test",
    authOrigins: [],
    resourceOrigins: [],
    successCriteria: ["프로젝트 목록이 표시됨"],
    forbiddenActions: ["사용자 데이터 변경"],
    captureSettings: { width: 1920, height: 1080, fps: 30 },
    steps: [
      {
        id: "step-01",
        action: "프로젝트 메뉴 열기",
        expected: "프로젝트 목록이 표시됨",
        narration: "프로젝트 메뉴를 선택합니다.",
        risk: "safe",
        calls: [
          { id: "step-01.click", tool: "browser_click", arguments: { element: "프로젝트 메뉴", target: "e11" } },
        ],
      },
    ],
  };
}

function completedReport(overrides = {}) {
  const approvedPlan = plan();
  return {
    schemaVersion: "1.0",
    jobId: JOB_ID,
    planDigest: digestPlan(approvedPlan),
    status: "completed",
    startedAt: "2026-07-14T01:00:00.000Z",
    endedAt: "2026-07-14T01:00:05.000Z",
    finalOrigin: "https://example.test",
    recordingPath: "browser/video-001.webm",
    stoppedStepId: null,
    toolCalls: compileExecutionCalls(approvedPlan).map(({ id, tool }) => ({ id, tool })),
    steps: [
      {
        id: "step-01",
        startedAt: "2026-07-14T01:00:01.000Z",
        endedAt: "2026-07-14T01:00:04.000Z",
        observedOrigin: "https://example.test",
        elementEvidence: "link 프로젝트 메뉴 ref=e11",
        screenshotPath: "browser/page-001.png",
        expectedStatus: "passed",
        expectedEvidence: "프로젝트 목록 제목이 표시됨",
        actionCallIds: ["step-01.click"],
      },
    ],
    ...overrides,
  };
}

function binding() {
  const approvedPlan = plan();
  return { plan: approvedPlan, planDigest: digestPlan(approvedPlan) };
}

function highlightCandidate(overrides = {}) {
  return {
    approvedCallId: "step-01.click.highlight-bounds",
    at: "2026-07-14T01:00:01.500Z",
    x: 8,
    y: 121,
    width: 127,
    height: 24,
    ...overrides,
  };
}

test("completed reports bind exact plan, calls, time ranges, recording, and evidence", () => {
  const approvedPlan = plan();
  const report = validateExecutionReport(completedReport(), {
    jobId: JOB_ID,
    plan: approvedPlan,
    planDigest: digestPlan(approvedPlan),
  });

  assert.deepEqual(report, completedReport());
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.steps[0]), true);
  assert.equal(Object.isFrozen(report.toolCalls), true);
});

test("reports reject missing evidence, path escape, extra steps, and tool-call drift", () => {
  const approvedPlan = plan();
  const options = { jobId: JOB_ID, plan: approvedPlan, planDigest: digestPlan(approvedPlan) };
  const cases = [
    completedReport({ recordingPath: null }),
    completedReport({ recordingPath: "../outside.webm" }),
    completedReport({ steps: [{ ...completedReport().steps[0], screenshotPath: null }] }),
    completedReport({ steps: [...completedReport().steps, { ...completedReport().steps[0], id: "extra" }] }),
    completedReport({ toolCalls: completedReport().toolCalls.slice(0, -1) }),
    completedReport({ planDigest: "0".repeat(64) }),
  ];
  for (const candidate of cases) {
    assert.throws(() => validateExecutionReport(candidate, options), {
      code: "INVALID_EXECUTION_REPORT",
    });
  }
});

test("mismatch reports are a bounded approved prefix and identify the stopped step", () => {
  const approvedPlan = plan();
  const digest = digestPlan(approvedPlan);
  const expectedCalls = compileExecutionCalls(approvedPlan);
  const mismatch = completedReport({
    status: "mismatch",
    endedAt: "2026-07-14T01:00:03.000Z",
    recordingPath: null,
    stoppedStepId: "step-01",
    toolCalls: expectedCalls.slice(0, 4).map(({ id, tool }) => ({ id, tool })),
    steps: [
      {
        ...completedReport().steps[0],
        endedAt: "2026-07-14T01:00:03.000Z",
        screenshotPath: null,
        expectedStatus: "mismatch",
        expectedEvidence: "승인된 프로젝트 메뉴를 찾지 못함",
      },
    ],
  });

  assert.equal(validateExecutionReport(mismatch, {
    jobId: JOB_ID,
    plan: approvedPlan,
    planDigest: digest,
  }).status, "mismatch");

  assert.throws(
    () => validateExecutionReport({ ...mismatch, stoppedStepId: "step-99" }, {
      jobId: JOB_ID,
      plan: approvedPlan,
      planDigest: digest,
    }),
    { code: "INVALID_EXECUTION_REPORT" },
  );
});

test("coordinator binds every approved click to its owning step without changing validated fields", () => {
  const options = binding();
  const validated = validateExecutionReport(completedReport(), {
    jobId: JOB_ID,
    ...options,
  });

  const bound = bindExecutionHighlights(validated, [highlightCandidate()], options);

  assert.deepEqual(bound.clickHighlights, [{
    stepId: "step-01",
    callId: "step-01.click",
    at: "2026-07-14T01:00:01.500Z",
    x: 8,
    y: 121,
    width: 127,
    height: 24,
  }]);
  const { clickHighlights, ...executorFields } = bound;
  assert.deepEqual(executorFields, validated);
  assert.equal(Object.isFrozen(bound), true);
  assert.equal(Object.isFrozen(clickHighlights), true);
  assert.equal(clickHighlights.every(Object.isFrozen), true);
});

test("coordinator click binding rejects missing, duplicate, reordered, unknown, and non-click candidates", () => {
  const options = binding();
  const validated = validateExecutionReport(completedReport(), {
    jobId: JOB_ID,
    ...options,
  });
  const cases = [
    [],
    [highlightCandidate(), highlightCandidate()],
    [highlightCandidate({ approvedCallId: "step-99.click.highlight-bounds" })],
    [highlightCandidate({ approvedCallId: "step-01.other.highlight-bounds" })],
    [highlightCandidate({ approvedCallId: "step-01.narration-dwell.highlight-bounds" })],
  ];

  for (const candidates of cases) {
    assert.throws(
      () => bindExecutionHighlights(validated, candidates, options),
      { code: "INVALID_EXECUTION_HIGHLIGHTS" },
    );
  }
});

test("coordinator click binding rejects timestamps outside the report or owning step", () => {
  const options = binding();
  const validated = validateExecutionReport(completedReport(), {
    jobId: JOB_ID,
    ...options,
  });
  for (const at of [
    "2026-07-14T00:59:59.999Z",
    "2026-07-14T01:00:00.500Z",
    "2026-07-14T01:00:04.500Z",
    "2026-07-14T01:00:05.001Z",
    "not-a-timestamp",
  ]) {
    assert.throws(
      () => bindExecutionHighlights(validated, [highlightCandidate({ at })], options),
      { code: "INVALID_EXECUTION_HIGHLIGHTS" },
    );
  }
});

test("coordinator click binding rejects extra fields, unsafe prototypes, sparse arrays, and invalid bounds", () => {
  const options = binding();
  const validated = validateExecutionReport(completedReport(), {
    jobId: JOB_ID,
    ...options,
  });
  const sparse = Array(1);
  const inherited = Object.assign(Object.create({ forged: true }), highlightCandidate());
  const cases = [
    [highlightCandidate({ extra: true })],
    [inherited],
    sparse,
    [highlightCandidate({ x: -1 })],
    [highlightCandidate({ y: 1_080 })],
    [highlightCandidate({ width: 0 })],
    [highlightCandidate({ height: 0 })],
    [highlightCandidate({ x: 1_900, width: 21 })],
    [highlightCandidate({ y: 1_070, height: 11 })],
    [highlightCandidate({ x: 8.5 })],
    [highlightCandidate({ width: Number.MAX_SAFE_INTEGER })],
  ];

  for (const candidates of cases) {
    assert.throws(
      () => bindExecutionHighlights(validated, candidates, options),
      { code: "INVALID_EXECUTION_HIGHLIGHTS" },
    );
  }
});

test("coordinator click binding is owned by the exact canonical plan digest", () => {
  const options = binding();
  const validated = validateExecutionReport(completedReport(), {
    jobId: JOB_ID,
    ...options,
  });
  for (const invalidOptions of [
    { ...options, planDigest: "0".repeat(64) },
    { ...options, unexpected: true },
  ]) {
    assert.throws(
      () => bindExecutionHighlights(validated, [highlightCandidate()], invalidOptions),
      { code: "INVALID_EXECUTION_HIGHLIGHTS" },
    );
  }
});

test("executor-authored click highlights remain an invalid report field", () => {
  const approvedPlan = plan();
  assert.throws(
    () => validateExecutionReport({
      ...completedReport(),
      clickHighlights: [highlightCandidate()],
    }, {
      jobId: JOB_ID,
      plan: approvedPlan,
      planDigest: digestPlan(approvedPlan),
    }),
    { code: "INVALID_EXECUTION_REPORT" },
  );
});
