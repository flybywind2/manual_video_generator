import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileExecutionCalls } from "../../src/domain/execution-calls.js";
import { ExecutionLock } from "../../src/jobs/execution-lock.js";
import { JobStore } from "../../src/jobs/job-store.js";
import { ProductionWorkflow } from "../../src/workflow/production.js";
import { createStudioService } from "../../src/workflow/studio-service.js";

const JOB_ID = "job-fullworkflow0001";
const TARGET_URL = "http://127.0.0.1:4317/fixture/dashboard";
const TARGET_ORIGIN = "http://127.0.0.1:4317";
const COMPLETION_CONDITION = "프로젝트 목록이 보이면 완료";

function plan() {
  return {
    schemaVersion: "1.1",
    targetUrl: TARGET_URL,
    targetOrigin: TARGET_ORIGIN,
    authOrigins: [],
    resourceOrigins: [],
    successCriteria: [COMPLETION_CONDITION],
    forbiddenActions: ["사용자 데이터 변경"],
    captureSettings: { width: 1920, height: 1080, fps: 30 },
    steps: [{
      id: "step-01",
      action: "프로젝트 메뉴 열기",
      expected: COMPLETION_CONDITION,
      narration: "프로젝트 메뉴를 선택합니다.",
      risk: "safe",
      calls: [{
        id: "step-01.click",
        tool: "browser_click",
        arguments: {
          element: "프로젝트 메뉴",
          target: 'getByRole("link", { name: "프로젝트 메뉴", exact: true })',
        },
      }],
    }],
  };
}

function executionReport(jobId, approvedPlan, planDigest) {
  const startedAt = "2026-07-14T10:00:00.000Z";
  const endedAt = "2026-07-14T11:00:00.000Z";
  return {
    schemaVersion: "1.0",
    jobId,
    planDigest,
    status: "completed",
    startedAt,
    endedAt,
    finalOrigin: TARGET_ORIGIN,
    recordingPath: "browser/recording.webm",
    stoppedStepId: null,
    toolCalls: compileExecutionCalls(approvedPlan).map(({ id, tool }) => ({ id, tool })),
    steps: [{
      id: "step-01",
      startedAt: "2026-07-14T10:10:00.000Z",
      endedAt: "2026-07-14T10:50:00.000Z",
      observedOrigin: TARGET_ORIGIN,
      elementEvidence: "프로젝트 메뉴 링크",
      screenshotPath: "browser/step-01.png",
      expectedStatus: "passed",
      expectedEvidence: "프로젝트 목록 제목",
      actionCallIds: ["step-01.click"],
    }],
  };
}

test("real coordinator workflows reach completed across all approval gates", async (t) => {
  const root = join(tmpdir(), `manual-full-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(root, { recursive: true });
  const store = new JobStore({ root, randomId: () => JOB_ID });
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  let installedCalls = [];
  const browserRuntime = {
    active: null,
    async start(job) {
      this.active = { jobId: job.id, generation: 1, phase: "planning" };
      return this.active;
    },
    async sealAuthentication() {},
    installApproval({ jobId, generation, planDigest, calls }) {
      installedCalls = calls;
      return { jobId, generation, planDigest, callCount: calls.length };
    },
    async executeApproval({ jobId, generation, planDigest }, { onCall }) {
      await onCall({ id: installedCalls[0].id, tool: installedCalls[0].tool, status: "completed" });
      return {
        schemaVersion: "1.0",
        jobId,
        generation,
        planDigest,
        status: "completed",
        callCount: installedCalls.length,
        report: executionReport(jobId, approvedPlan, planDigest),
      };
    },
    readExecutionTiming({ jobId, generation, planDigest }) {
      const origin = Date.parse("2026-07-14T00:00:00.000Z");
      const offsets = [
        [-1, 0],
        [0, 250],
        [500, 600],
        [600, 1_000],
        [1_000, 1_050],
        [1_250, 1_350],
        [1_350, 2_000],
        [2_000, 2_250],
        [2_250, 2_750],
        [2_750, 3_000],
        [3_000, 3_001],
      ];
      return {
        schemaVersion: "1.0",
        clock: "unix_ms",
        jobId,
        generation,
        planDigest,
        complete: true,
        calls: installedCalls.map((call, index) => ({
          id: call.id,
          tool: call.tool,
          startedAtMs: origin + offsets[index][0],
          endedAtMs: origin + offsets[index][1],
        })),
      };
    },
    readExecutionHighlights({ expectedCallIds }) {
      assert.deepEqual(expectedCallIds, ["step-01.click.highlight-bounds"]);
      return [{
        approvedCallId: expectedCallIds[0],
        x: 8,
        y: 121,
        width: 127,
        height: 24,
      }];
    },
    async readRecordingArtifact({ jobId, generation, planDigest }) {
      return {
        schemaVersion: "1.0",
        jobId,
        generation,
        planDigest,
        approvedCallId: "system.stop-video",
        recordingPath: "browser/generation-1-fixture/video-owned.webm",
      };
    },
    async readEvidenceArtifacts({ jobId, generation, planDigest, expectedCallIds }) {
      return {
        schemaVersion: "1.0",
        jobId,
        generation,
        planDigest,
        artifacts: expectedCallIds.map((approvedCallId) => ({
          approvedCallId,
          screenshotPath: "browser/step-01.png",
        })),
      };
    },
    async stop() { this.active = null; },
  };
  const openCodeServer = {
    active: null,
    activeJobId: null,
    async startJob({ jobId }) {
      this.activeJobId = jobId;
      this.active = { jobId };
      return this.active;
    },
    async withAttachOptions(agent, callback) {
      return callback({
        baseUrl: "http://127.0.0.1:4096",
        studioRoot: "C:\\studio",
        env: {},
        validateServerContract: async () => ({ valid: true }),
      });
    },
    async stop() {
      this.active = null;
      this.activeJobId = null;
    },
  };
  let approvedPlan;
  let approvedDigest;
  const runOpenCode = async ({ agent }) => {
    if (agent === "manual-video-planner") {
      return {
        finalText: JSON.stringify(plan()),
        sessionId: "ses_fullworkflow001",
        toolEvents: [{
          tool: "playwright_browser_snapshot",
          status: "completed",
        }],
      };
    }
    return {
      finalText: JSON.stringify(executionReport(JOB_ID, approvedPlan, approvedDigest)),
    };
  };
  const previewDigest = "e".repeat(64);
  const production = new ProductionWorkflow({
    jobStore: store,
    producer: {
      async narrate() { return { sceneCount: 1 }; },
      async compose({ report }) {
        assert.equal(report.startedAt, "2026-07-14T00:00:00.000Z");
        assert.equal(report.endedAt, "2026-07-14T00:00:03.000Z");
        assert.equal(report.steps[0].startedAt, "2026-07-14T00:00:00.500Z");
        assert.equal(report.steps[0].endedAt, "2026-07-14T00:00:02.750Z");
        assert.deepEqual(report.clickHighlights, [{
          stepId: "step-01",
          callId: "step-01.click",
          at: "2026-07-14T00:00:01.250Z",
          x: 8,
          y: 121,
          width: 127,
          height: 24,
        }]);
        return {
          planDigest: report.planDigest,
          previewDigest,
          mediaPlan: { schemaVersion: "1.0", scenes: [{}] },
          previewArtifact: "preview.mp4",
          captionsArtifact: "captions.vtt",
        };
      },
      async verifyPreview() {},
      async render() {
        return { outputArtifact: "final.mp4", quality: { width: 1920, height: 1080, fps: 30 } };
      },
      async edit() {},
      async rebuild() {},
      async cancel() {},
    },
  });
  const service = createStudioService({
    browserRuntime,
    credentialVault: { load: async () => { throw new Error("manual mode"); } },
    executionLock: new ExecutionLock(),
    jobStore: store,
    openCodeServer,
    opencodePath: "C:\\tools\\opencode.exe",
    productionWorkflow: production,
    runOpenCode,
  });

  await store.create({
    targetUrl: TARGET_URL,
    prompt: "프로젝트 메뉴를 여는 방법을 안내해 주세요.",
    completionCondition: COMPLETION_CONDITION,
    authMode: "manual",
    voice: "F1",
  });
  const awaiting = await service.authenticateAndPlan(JOB_ID);
  assert.equal(awaiting.state, "awaiting_manual_login");

  const planned = await service.confirmManualLoginAndPlan(JOB_ID);
  assert.equal(planned.job.state, "plan_review");
  approvedPlan = planned.plan;
  approvedDigest = planned.planDigest;

  const approved = await service.approvePlan(JOB_ID, approvedDigest);
  assert.equal(approved.job.state, "approved");

  const preview = await service.execute(JOB_ID, approvedDigest);
  assert.equal(preview.state, "preview_review");
  assert.equal(preview.previewDigest, previewDigest);

  const completed = await service.approvePreview(JOB_ID, previewDigest);
  assert.equal(completed.state, "completed");
  assert.equal(completed.outputArtifact, "final.mp4");

  assert.deepEqual(
    (await store.readEvents(JOB_ID)).map(({ event }) => event),
    [
      "JOB_CREATED",
      "START_AUTHENTICATION",
      "AUTH_REQUIRED",
      "CONFIRM_LOGIN",
      "PLAN_READY",
      "APPROVE_PLAN",
      "START_EXECUTION",
      "EXECUTION_PROGRESS",
      "EXECUTION_COMPLETED",
      "NARRATION_COMPLETED",
      "COMPOSITION_COMPLETED",
      "APPROVE_PREVIEW",
      "RENDER_COMPLETED",
    ],
  );
});
