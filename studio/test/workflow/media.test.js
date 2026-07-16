import assert from "node:assert/strict";
import test from "node:test";

import { mediaPlanDigest } from "../../src/media/composition.js";
import { createMediaPlan } from "../../src/media/media-plan.js";
import {
  MediaWorkflow,
  approvePreview,
  renderFinal,
  updateMediaPlan,
} from "../../src/workflow/media.js";

function plan() {
  return createMediaPlan({
    recordingPath: "media/normalized.mp4",
    scenes: [
      {
        id: "step-1",
        sourceStartMs: 0,
        sourceEndMs: 2_000,
        caption: "설정 메뉴를 선택합니다.",
        chapter: "설정 열기",
        highlights: [
          {
            callId: "step-1.click",
            sourceAtMs: 500,
            x: 120,
            y: 160,
            width: 320,
            height: 72,
          },
        ],
      },
      {
        id: "step-2",
        sourceStartMs: 2_100,
        sourceEndMs: 4_100,
        caption: "프로필을 확인합니다.",
        chapter: "프로필 확인",
        highlights: [],
      },
    ],
    narrations: [
      {
        sceneId: "step-1",
        path: "narration/step-1.wav",
        durationMs: 1_900,
        text: "상단에서 설정 메뉴를 선택합니다.",
      },
      {
        sceneId: "step-2",
        path: "narration/step-2.wav",
        durationMs: 1_900,
        text: "프로필 영역에서 현재 정보를 확인합니다.",
      },
    ],
  });
}

function harness(initialState = "preview_review") {
  let state = initialState;
  let mediaPlan = plan();
  let previewArtifact = { mediaPlanDigest: mediaPlanDigest(mediaPlan) };
  const artifacts = new Set([
    "recording",
    "trace",
    "evidence",
    "narration:step-1",
    "narration:step-2",
    "composition",
    "preview",
    "render",
    "quality",
  ]);
  const calls = [];
  const dependencies = {
    loadJob: async (jobId) => ({ id: jobId, state }),
    readMediaPlan: async () => mediaPlan,
    readPreviewArtifact: async () => previewArtifact,
    writeMediaPlan: async (_jobId, next) => {
      calls.push({ operation: "write", plan: next });
      mediaPlan = next;
    },
    invalidateArtifacts: async (_jobId, names) => {
      calls.push({ operation: "invalidate", names: [...names] });
      for (const name of names) {
        artifacts.delete(name);
        if (name === "preview") previewArtifact = null;
      }
    },
    moveToStage: async (_jobId, nextState, data) => {
      calls.push({ operation: "stage", state: nextState, data });
      state = nextState;
      return { id: "job-1", state };
    },
    render: async ({ jobId, mediaPlan: received }) => {
      calls.push({ operation: "render", jobId, plan: received });
      return { outputPath: "renders/final.mp4", bytes: 1234 };
    },
    qualityGate: async ({ expectedDurationMs, render }) => {
      calls.push({ operation: "quality", expectedDurationMs, render });
      return { videoCodec: "h264", audioCodec: "aac", durationMs: expectedDurationMs };
    },
  };
  return {
    dependencies,
    artifacts,
    calls,
    get state() { return state; },
    get mediaPlan() { return mediaPlan; },
    get previewArtifact() { return previewArtifact; },
    setPreviewArtifact(value) { previewArtifact = value; },
  };
}

test("narration edit invalidates only the selected narration and downstream media without recapture", async () => {
  const context = harness();
  const original = context.mediaPlan;

  const result = await updateMediaPlan({
    ...context.dependencies,
    jobId: "job-1",
    sceneId: "step-1",
    narrationText: "설정 아이콘을 선택한 뒤 메뉴를 엽니다.",
  });

  assert.equal(result.state, "narrating");
  assert.deepEqual(result.invalidated, [
    "narration:step-1",
    "composition",
    "preview",
    "render",
    "quality",
  ]);
  assert.deepEqual(result.preserved, ["recording", "trace", "evidence"]);
  assert.equal(result.mediaPlan.scenes[0].narration.text, "설정 아이콘을 선택한 뒤 메뉴를 엽니다.");
  assert.equal(result.mediaPlan.schemaVersion, "1.1");
  assert.deepEqual(result.mediaPlan.scenes[0].highlights, original.scenes[0].highlights);
  assert.equal(original.scenes[0].narration.text, "상단에서 설정 메뉴를 선택합니다.");
  assert.equal(context.state, "narrating");
  assert.equal(context.artifacts.has("recording"), true);
  assert.equal(context.artifacts.has("trace"), true);
  assert.equal(context.artifacts.has("evidence"), true);
  assert.equal(context.artifacts.has("narration:step-1"), false);
  assert.equal(context.artifacts.has("narration:step-2"), true);
  assert.deepEqual(
    context.calls.map(({ operation }) => operation),
    ["stage", "invalidate", "write"],
  );
});

test("caption-only edit keeps all narration and returns directly to composing", async () => {
  const context = harness();
  const originalHighlights = context.mediaPlan.scenes[0].highlights;
  const result = await updateMediaPlan({
    ...context.dependencies,
    jobId: "job-1",
    sceneId: "step-2",
    captionText: "프로필에서 현재 정보를 확인하세요.",
  });

  assert.equal(result.state, "composing");
  assert.deepEqual(result.invalidated, ["composition", "preview", "render", "quality"]);
  assert.equal(result.mediaPlan.scenes[1].caption.text, "프로필에서 현재 정보를 확인하세요.");
  assert.equal(result.mediaPlan.captions[1].text, "프로필에서 현재 정보를 확인하세요.");
  assert.deepEqual(result.mediaPlan.scenes[0].highlights, originalHighlights);
  assert.equal(context.artifacts.has("narration:step-1"), true);
  assert.equal(context.artifacts.has("narration:step-2"), true);
  assert.equal(context.artifacts.has("recording"), true);
});

test("invalid scene ids, empty edits, and edits after cancellation are rejected without side effects", async () => {
  for (const input of [
    { sceneId: "missing", captionText: "수정" },
    { sceneId: "step-1" },
    { sceneId: "step-1", narrationText: "\u0000bad" },
  ]) {
    const context = harness();
    await assert.rejects(
      updateMediaPlan({ ...context.dependencies, jobId: "job-1", ...input }),
      { code: "MEDIA_EDIT_NOT_ALLOWED" },
    );
    assert.deepEqual(context.calls, []);
  }

  const cancelled = harness("cancelled");
  await assert.rejects(
    updateMediaPlan({
      ...cancelled.dependencies,
      jobId: "job-1",
      sceneId: "step-1",
      captionText: "수정",
    }),
    { code: "MEDIA_EDIT_NOT_ALLOWED" },
  );
  assert.deepEqual(cancelled.calls, []);
});

test("preview approval renders and quality-gates without invoking browser capture", async () => {
  const context = harness();
  let recaptures = 0;
  const expectedPreviewDigest = mediaPlanDigest(context.mediaPlan);
  const result = await approvePreview({
    ...context.dependencies,
    jobId: "job-1",
    expectedPreviewDigest,
    captureBrowser: async () => { recaptures += 1; },
  });

  assert.equal(recaptures, 0);
  assert.equal(context.state, "completed");
  assert.deepEqual(
    context.calls.map(({ operation, state }) => state ? `${operation}:${state}` : operation),
    ["stage:rendering", "render", "quality", "stage:completed"],
  );
  assert.equal(result.state, "completed");
  assert.equal(result.render.outputPath, "renders/final.mp4");
  assert.equal(result.quality.videoCodec, "h264");
  assert.equal(result.previewDigest, expectedPreviewDigest);
});

test("renderFinal is limited to rendering state and uses manifest duration as the quality contract", async () => {
  const context = harness("rendering");
  const result = await renderFinal({
    ...context.dependencies,
    jobId: "job-1",
    expectedMediaPlanDigest: mediaPlanDigest(context.mediaPlan),
  });

  assert.equal(result.quality.durationMs, context.mediaPlan.video.durationMs);
  assert.deepEqual(
    context.calls.map(({ operation }) => operation),
    ["render", "quality"],
  );

  const cancelled = harness("cancelled");
  await assert.rejects(
    renderFinal({
      ...cancelled.dependencies,
      jobId: "job-1",
      expectedMediaPlanDigest: mediaPlanDigest(cancelled.mediaPlan),
    }),
    { code: "MEDIA_RENDER_NOT_ALLOWED" },
  );
  assert.deepEqual(cancelled.calls, []);
});

test("preview approval requires the caller, artifact, and current media plan to share one digest", async () => {
  const missingDigest = harness();
  await assert.rejects(
    approvePreview({ ...missingDigest.dependencies, jobId: "job-1" }),
    { code: "MEDIA_PREVIEW_STALE" },
  );
  assert.deepEqual(missingDigest.calls, []);

  const wrongDigest = harness();
  await assert.rejects(
    approvePreview({
      ...wrongDigest.dependencies,
      jobId: "job-1",
      expectedPreviewDigest: "0".repeat(64),
    }),
    { code: "MEDIA_PREVIEW_STALE" },
  );
  assert.deepEqual(wrongDigest.calls, []);

  const missingArtifact = harness();
  missingArtifact.setPreviewArtifact(null);
  await assert.rejects(
    approvePreview({
      ...missingArtifact.dependencies,
      jobId: "job-1",
      expectedPreviewDigest: mediaPlanDigest(missingArtifact.mediaPlan),
    }),
    { code: "MEDIA_PREVIEW_STALE" },
  );
  assert.deepEqual(missingArtifact.calls, []);

  const staleArtifact = harness();
  staleArtifact.setPreviewArtifact({ mediaPlanDigest: "f".repeat(64) });
  await assert.rejects(
    approvePreview({
      ...staleArtifact.dependencies,
      jobId: "job-1",
      expectedPreviewDigest: mediaPlanDigest(staleArtifact.mediaPlan),
    }),
    { code: "MEDIA_PREVIEW_STALE" },
  );
  assert.deepEqual(staleArtifact.calls, []);

  const changedPlan = harness();
  const approvedDigest = mediaPlanDigest(changedPlan.mediaPlan);
  const replacement = structuredClone(changedPlan.mediaPlan);
  replacement.scenes[0].caption.text = "미리보기 생성 후 변경된 자막";
  replacement.captions[0].text = "미리보기 생성 후 변경된 자막";
  changedPlan.dependencies.readMediaPlan = async () => replacement;
  await assert.rejects(
    approvePreview({
      ...changedPlan.dependencies,
      jobId: "job-1",
      expectedPreviewDigest: approvedDigest,
    }),
    { code: "MEDIA_PREVIEW_STALE" },
  );
  assert.deepEqual(changedPlan.calls, []);
});

test("rendering aborts if the bound media plan changes before quality approval", async () => {
  const context = harness("rendering");
  const approvedPlan = context.mediaPlan;
  const expectedMediaPlanDigest = mediaPlanDigest(approvedPlan);
  const changedPlan = structuredClone(approvedPlan);
  changedPlan.scenes[0].caption.text = "렌더 도중 변경됨";
  changedPlan.captions[0].text = "렌더 도중 변경됨";
  let reads = 0;
  context.dependencies.readMediaPlan = async () => {
    reads += 1;
    return reads === 1 ? approvedPlan : changedPlan;
  };

  await assert.rejects(
    renderFinal({
      ...context.dependencies,
      jobId: "job-1",
      expectedMediaPlanDigest,
    }),
    { code: "MEDIA_PREVIEW_STALE" },
  );
  assert.deepEqual(
    context.calls.map(({ operation }) => operation),
    ["render"],
  );
});

test("a failed media edit transition preserves the approved plan and preview", async () => {
  const context = harness();
  const originalPlan = structuredClone(context.mediaPlan);
  const originalPreview = structuredClone(context.previewArtifact);
  context.dependencies.moveToStage = async (_jobId, nextState, data) => {
    context.calls.push({ operation: "stage", state: nextState, data });
    throw new Error("transition failed");
  };

  await assert.rejects(
    updateMediaPlan({
      ...context.dependencies,
      jobId: "job-1",
      sceneId: "step-1",
      captionText: "전이 실패 시 저장되면 안 됩니다.",
    }),
    /transition failed/u,
  );

  assert.equal(context.state, "preview_review");
  assert.deepEqual(context.mediaPlan, originalPlan);
  assert.deepEqual(context.previewArtifact, originalPreview);
  assert.equal(context.artifacts.has("preview"), true);
  assert.deepEqual(
    context.calls.map(({ operation }) => operation),
    ["stage"],
  );
});

test("MediaWorkflow serializes same-job preview edits and rendering", async () => {
  const context = harness();
  const workflow = new MediaWorkflow(context.dependencies);
  const first = workflow.updateMediaPlan({
    jobId: "job-1",
    sceneId: "step-1",
    captionText: "첫 번째 수정",
  });
  const second = workflow.updateMediaPlan({
    jobId: "job-1",
    sceneId: "step-2",
    captionText: "두 번째 수정",
  });

  await first;
  await assert.rejects(second, { code: "MEDIA_EDIT_NOT_ALLOWED" });
  assert.equal(context.mediaPlan.scenes[0].caption.text, "첫 번째 수정");
  assert.equal(context.mediaPlan.scenes[1].caption.text, "프로필을 확인합니다.");
});
