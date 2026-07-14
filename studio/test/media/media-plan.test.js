import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MEDIA_DRIFT_MS,
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  createMediaPlan,
} from "../../src/media/media-plan.js";

function scene(overrides = {}) {
  return {
    id: "step-1",
    sourceStartMs: 1_000,
    sourceEndMs: 3_000,
    caption: "프로젝트 메뉴를 선택합니다.",
    chapter: "프로젝트 열기",
    highlight: { x: 120, y: 160, width: 320, height: 72 },
    ...overrides,
  };
}

function narration(overrides = {}) {
  return {
    sceneId: "step-1",
    path: "narration/step-1.wav",
    durationMs: 1_900,
    text: "프로젝트 메뉴를 선택합니다.",
    ...overrides,
  };
}

test("media plan deterministically aligns sorted scenes, narration, captions, chapters, and highlights", () => {
  const laterScene = scene({
    id: "step-2",
    sourceStartMs: 4_000,
    sourceEndMs: 6_000,
    caption: "새 프로젝트 버튼을 누릅니다.",
    chapter: "새 프로젝트",
    highlight: null,
  });
  const laterNarration = narration({
    sceneId: "step-2",
    path: "narration/step-2.wav",
    durationMs: 2_300,
    text: "새 프로젝트 버튼을 누릅니다.",
  });
  const first = createMediaPlan({
    recordingPath: "media/normalized.mp4",
    scenes: [laterScene, scene()],
    narrations: [laterNarration, narration()],
  });
  const second = createMediaPlan({
    recordingPath: "media/normalized.mp4",
    scenes: [scene(), laterScene],
    narrations: [narration(), laterNarration],
  });

  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(first, {
    schemaVersion: "1.0",
    video: {
      width: 1920,
      height: 1080,
      fps: 30,
      durationMs: 4_200,
    },
    recordingPath: "media/normalized.mp4",
    scenes: [
      {
        id: "step-1",
        source: {
          startMs: 1_000,
          endMs: 3_000,
          durationMs: 2_000,
          playbackRate: 1.052632,
        },
        output: { startMs: 0, endMs: 1_900, durationMs: 1_900 },
        narration: {
          path: "narration/step-1.wav",
          durationMs: 1_900,
          text: "프로젝트 메뉴를 선택합니다.",
        },
        caption: {
          text: "프로젝트 메뉴를 선택합니다.",
          startMs: 0,
          endMs: 1_900,
        },
        chapter: "프로젝트 열기",
        highlight: { x: 120, y: 160, width: 320, height: 72 },
        driftMs: 0,
      },
      {
        id: "step-2",
        source: {
          startMs: 4_000,
          endMs: 6_000,
          durationMs: 2_000,
          playbackRate: 0.9,
        },
        output: { startMs: 1_900, endMs: 4_200, durationMs: 2_300 },
        narration: {
          path: "narration/step-2.wav",
          durationMs: 2_300,
          text: "새 프로젝트 버튼을 누릅니다.",
        },
        caption: {
          text: "새 프로젝트 버튼을 누릅니다.",
          startMs: 1_900,
          endMs: 4_200,
        },
        chapter: "새 프로젝트",
        highlight: null,
        driftMs: 78,
      },
    ],
    captions: [
      { sceneId: "step-1", startMs: 0, endMs: 1_900, text: "프로젝트 메뉴를 선택합니다." },
      { sceneId: "step-2", startMs: 1_900, endMs: 4_200, text: "새 프로젝트 버튼을 누릅니다." },
    ],
    chapters: [
      { sceneId: "step-1", startMs: 0, label: "프로젝트 열기" },
      { sceneId: "step-2", startMs: 1_900, label: "새 프로젝트" },
    ],
  });
});

test("documented playback and unexplained drift limits are enforced", () => {
  assert.equal(MIN_PLAYBACK_RATE, 0.9);
  assert.equal(MAX_PLAYBACK_RATE, 1.1);
  assert.equal(MAX_MEDIA_DRIFT_MS, 500);

  assert.throws(
    () => createMediaPlan({
      recordingPath: "media/normalized.mp4",
      scenes: [scene({ sourceStartMs: 0, sourceEndMs: 1_000 })],
      narrations: [narration({ durationMs: 2_000 })],
    }),
    { code: "MEDIA_DRIFT_EXCEEDED" },
  );
});

test("missing, duplicate, and overlapping scene material is rejected", () => {
  assert.throws(
    () => createMediaPlan({ recordingPath: "media/normalized.mp4", scenes: [], narrations: [] }),
    { code: "INVALID_MEDIA_PLAN" },
  );
  assert.throws(
    () => createMediaPlan({
      recordingPath: "media/normalized.mp4",
      scenes: [scene()],
      narrations: [],
    }),
    { code: "INVALID_MEDIA_PLAN" },
  );
  assert.throws(
    () => createMediaPlan({
      recordingPath: "media/normalized.mp4",
      scenes: [scene(), scene({ id: "step-2", sourceStartMs: 2_999, sourceEndMs: 4_000 })],
      narrations: [narration(), narration({ sceneId: "step-2", path: "narration/step-2.wav" })],
    }),
    { code: "INVALID_MEDIA_PLAN" },
  );
  assert.throws(
    () => createMediaPlan({
      recordingPath: "media/normalized.mp4",
      scenes: [scene()],
      narrations: [narration(), narration()],
    }),
    { code: "INVALID_MEDIA_PLAN" },
  );
});

test("manifest paths must be portable job-relative asset paths", () => {
  for (const path of [
    "../escape.mp4",
    "/absolute.mp4",
    "https://example.test/video.mp4",
    "media\\windows.mp4",
    "media/video.mp4?token=secret",
  ]) {
    assert.throws(
      () => createMediaPlan({ recordingPath: path, scenes: [scene()], narrations: [narration()] }),
      { code: "INVALID_MEDIA_PLAN" },
    );
  }
  assert.throws(
    () => createMediaPlan({
      recordingPath: "media/normalized.mp4",
      scenes: [scene()],
      narrations: [narration({ path: "../secret.wav" })],
    }),
    { code: "INVALID_MEDIA_PLAN" },
  );
});

test("unsafe text, invalid coordinates, and unknown fields never enter the manifest", () => {
  assert.throws(
    () => createMediaPlan({
      recordingPath: "media/normalized.mp4",
      scenes: [scene({ caption: "bad\u0000caption" })],
      narrations: [narration()],
    }),
    { code: "INVALID_MEDIA_PLAN" },
  );
  assert.throws(
    () => createMediaPlan({
      recordingPath: "media/normalized.mp4",
      scenes: [scene({ highlight: { x: -1, y: 0, width: 10, height: 10 } })],
      narrations: [narration()],
    }),
    { code: "INVALID_MEDIA_PLAN" },
  );
  assert.throws(
    () => createMediaPlan({
      recordingPath: "media/normalized.mp4",
      scenes: [scene({ arbitraryHtml: "<script>alert(1)</script>" })],
      narrations: [narration()],
    }),
    { code: "INVALID_MEDIA_PLAN" },
  );
});
