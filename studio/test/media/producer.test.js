import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { digestPlan } from "../../src/domain/plan.js";
import { compileExecutionCalls } from "../../src/domain/execution-calls.js";
import { JobStore } from "../../src/jobs/job-store.js";
import { mediaPlanDigest, writeComposition } from "../../src/media/composition.js";
import { createMediaPlan } from "../../src/media/media-plan.js";
import { createMediaProducer } from "../../src/media/producer.js";
import { ProductionWorkflow } from "../../src/workflow/production.js";

function approvedPlan() {
  return {
    schemaVersion: "1.1",
    targetUrl: "https://example.test/dashboard",
    targetOrigin: "https://example.test",
    authOrigins: [],
    resourceOrigins: [],
    successCriteria: ["프로필 화면이 표시됨"],
    forbiddenActions: ["user-data.change"],
    captureSettings: { width: 1920, height: 1080, fps: 30 },
    steps: [
      {
        id: "open-menu",
        action: "프로필 메뉴 열기",
        expected: "프로필 메뉴가 표시됨",
        narration: "상단의 프로필 메뉴를 엽니다.",
        risk: "safe",
        calls: [
          {
            id: "open-menu.click",
            tool: "browser_click",
            arguments: { element: "프로필 메뉴", target: "e11" },
          },
        ],
      },
      {
        id: "review-profile",
        action: "프로필 정보 확인",
        expected: "프로필 정보가 표시됨",
        narration: "표시된 프로필 정보를 확인합니다.",
        risk: "safe",
        calls: [
          {
            id: "review-profile.wait",
            tool: "browser_wait_for",
            arguments: { text: "프로필 정보" },
          },
        ],
      },
    ],
  };
}

function executionReport(planDigest) {
  return {
    status: "completed",
    planDigest,
    startedAt: "2026-07-15T00:00:00.000Z",
    endedAt: "2026-07-15T00:00:02.200Z",
    recordingPath: "browser/session.webm",
    clickHighlights: [
      {
        stepId: "open-menu",
        callId: "open-menu.click",
        at: "2026-07-15T00:00:00.500Z",
        x: 120,
        y: 160,
        width: 320,
        height: 72,
      },
    ],
    steps: [
      {
        id: "open-menu",
        startedAt: "2026-07-15T00:00:00.100Z",
        endedAt: "2026-07-15T00:00:01.100Z",
      },
      {
        id: "review-profile",
        startedAt: "2026-07-15T00:00:01.200Z",
        endedAt: "2026-07-15T00:00:02.200Z",
      },
    ],
  };
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "manual-producer-"));
  const jobsRoot = join(root, "jobs");
  const jobId = "job-media-1";
  const jobRoot = join(jobsRoot, jobId);
  const templatePath = join(root, "template.html");
  await mkdir(join(jobRoot, "browser"), { recursive: true });
  await writeFile(join(jobRoot, "browser", "session.webm"), "recording");
  await writeFile(
    templatePath,
    '<main data-id="@@COMPOSITION_ID@@" data-duration="@@DURATION_SECONDS@@">@@CLIPS@@</main>',
    "utf8",
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const plan = overrides.plan ?? approvedPlan();
  const planDigest = digestPlan(plan);
  const calls = [];
  const ffmpeg = {
    async normalizeRecording(options) {
      calls.push(["normalize", options]);
      await writeFile(options.outputPath, "normalized");
      return { outputPath: options.outputPath, bytes: 10 };
    },
  };
  const hyperframes = {
    async lint(options) { calls.push(["lint", options]); return { findings: [] }; },
    async check(options) { calls.push(["check", options]); return { findings: [] }; },
    async preview(options) { calls.push(["preview", options]); return { port: options.port }; },
    async stopPreview(options) {
      calls.push(["stopPreview", options]);
      return overrides.stopPreview?.(options);
    },
    async render(options) {
      calls.push([`render:${options.quality}`, options]);
      if (overrides.render) return overrides.render(options);
      await writeFile(options.outputPath, `render-${options.quality}`);
      return { outputPath: options.outputPath, bytes: 12 };
    },
  };
  const narrationCalls = [];
  const generateNarration = async ({ plan: narrationPlan, outputDirectory, client, voice }) => {
    narrationCalls.push({ plan: narrationPlan, outputDirectory, client, voice });
    const scenes = [];
    for (let index = 0; index < narrationPlan.steps.length; index += 1) {
      const step = narrationPlan.steps[index];
      const file = `scene-${String(index + 1).padStart(3, "0")}.wav`;
      await writeFile(join(outputDirectory, file), `wav-${index + 1}`);
      scenes.push({
        sceneId: step.id,
        order: index + 1,
        text: step.narration,
        status: "ready",
        file,
        durationSeconds: 1,
        sampleRate: 44_100,
        bytes: 5,
        attempts: 1,
      });
    }
    const manifest = { schemaVersion: "1.0", status: "ready", lang: "ko", voice, scenes };
    await writeFile(join(outputDirectory, "narration.json"), JSON.stringify(manifest));
    await overrides.afterNarration?.({
      callIndex: narrationCalls.length,
      outputDirectory,
      manifest,
    });
    return manifest;
  };
  const clientFactoryCalls = [];
  const compositionWrites = [];
  const mediaPlanInputs = [];
  const createSupertonicClient = (options) => {
    clientFactoryCalls.push(options);
    return { outputRoot: options.outputRoot, health() {}, synthesize() {} };
  };
  const producerOptions = {
    jobsRoot,
    templatePath,
    restoreLatestPlan: async (_jobStore, restoredJobId) => {
      assert.equal(restoredJobId, jobId);
      return { plan, planDigest, approved: true };
    },
    jobStore: { root: jobsRoot },
    ffmpeg,
    hyperframes,
    qualityGate: overrides.qualityGate ?? { async probe() { throw new Error("not expected"); } },
    supertonicBaseUrl: overrides.supertonicBaseUrl ?? "http://127.0.0.1:7788",
    createSupertonicClient,
    generateNarration,
    createMediaPlan(input) {
      mediaPlanInputs.push(structuredClone(input));
      return createMediaPlan(input);
    },
    writeComposition: async (options) => {
      compositionWrites.push(options);
      return (overrides.writeComposition ?? writeComposition)(options);
    },
    mediaPlanDigest: overrides.mediaPlanDigest,
    previewPort: 49_317,
  };
  const createProducer = (producerOverrides = {}) => createMediaProducer({
    ...producerOptions,
    ...producerOverrides,
  });
  const producer = createProducer();

  return {
    producer,
    createProducer,
    jobId,
    jobRoot,
    plan,
    planDigest,
    calls,
    narrationCalls,
    clientFactoryCalls,
    compositionWrites,
    mediaPlanInputs,
  };
}

async function preparedPreview(context) {
  const report = executionReport(context.planDigest);
  const job = { request: { voice: "F2" } };
  const narration = await context.producer.narrate({
    jobId: context.jobId,
    job,
    report,
  });
  const preview = await context.producer.compose({
    jobId: context.jobId,
    job,
    report,
    narration,
  });
  return { job, report, narration, preview };
}

async function previewReviewStore(t, jobId, planDigest, preview) {
  const root = await mkdtemp(join(tmpdir(), "manual-producer-state-"));
  const store = new JobStore({ root, randomId: () => jobId });
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.create({
    targetUrl: "https://example.test/dashboard",
    prompt: "프로필 정보를 확인합니다.",
    completionCondition: "프로필 화면이 표시됨",
    authMode: "manual",
    voice: "F2",
  });
  await store.transition(jobId, "START_AUTHENTICATION", {});
  await store.transition(jobId, "AUTHENTICATED", {});
  await store.transition(jobId, "PLAN_READY", { planDigest });
  await store.transition(jobId, "APPROVE_PLAN", { planDigest });
  await store.transition(jobId, "START_EXECUTION", { planDigest });
  await store.transition(jobId, "EXECUTION_COMPLETED", {
    planDigest,
    report: { status: "completed" },
  });
  await store.transition(jobId, "NARRATION_COMPLETED", {
    planDigest,
    sceneCount: preview.mediaPlan.scenes.length,
  });
  await store.transition(jobId, "COMPOSITION_COMPLETED", {
    planDigest,
    preview,
    previewDigest: preview.previewDigest,
  });
  return store;
}

test("transforms approved browser evidence into a bound draft preview and safe artifact manifest", async (t) => {
  const context = await fixture(t);
  const { narration, preview } = await preparedPreview(context);

  assert.equal(narration.sceneCount, 2);
  assert.equal(preview.planDigest, context.planDigest);
  assert.equal(preview.previewDigest, mediaPlanDigest(preview.mediaPlan));
  assert.equal(preview.previewArtifact, "preview.mp4");
  assert.equal(preview.captionsArtifact, "captions.vtt");
  assert.match(preview.previewIntegritySha256, /^[a-f0-9]{64}$/u);
  assert.equal(Number.isSafeInteger(preview.previewIntegrityBytes), true);
  assert.equal(preview.previewIntegrityBytes > 0, true);
  assert.deepEqual(
    preview.mediaPlan.scenes.map((scene) => ({
      id: scene.id,
      start: scene.source.startMs,
      end: scene.source.endMs,
      caption: scene.caption.text,
      chapter: scene.chapter,
      highlights: scene.highlights,
    })),
    [
      {
        id: "open-menu",
        start: 100,
        end: 1_100,
        caption: "상단의 프로필 메뉴를 엽니다.",
        chapter: "프로필 메뉴 열기",
        highlights: [
          {
            callId: "open-menu.click",
            x: 120,
            y: 160,
            width: 320,
            height: 72,
            startMs: 100,
            durationMs: 900,
          },
        ],
      },
      {
        id: "review-profile",
        start: 1_200,
        end: 2_200,
        caption: "표시된 프로필 정보를 확인합니다.",
        chapter: "프로필 정보 확인",
        highlights: [],
      },
    ],
  );
  assert.deepEqual(context.clientFactoryCalls, [
    {
      baseUrl: "http://127.0.0.1:7788",
      outputRoot: join(context.jobRoot, "composition", "narration"),
    },
  ]);
  assert.equal(context.narrationCalls[0].voice, "F2");
  assert.deepEqual(
    context.calls.map(([name]) => name),
    ["normalize", "lint", "check", "preview", "render:draft", "stopPreview"],
  );

  const artifacts = join(context.jobRoot, "artifacts");
  assert.deepEqual(
    JSON.parse(await readFile(join(artifacts, "manifest.json"), "utf8")),
    {
      files: [
        "captions.vtt",
        "media-plan.json",
        "preview-integrity.json",
        "preview.json",
        "preview.mp4",
        "source-highlights.json",
      ],
    },
  );
  const integrity = JSON.parse(
    await readFile(join(artifacts, "preview-integrity.json"), "utf8"),
  );
  assert.equal(integrity.schemaVersion, "1.0");
  assert.equal(integrity.planDigest, context.planDigest);
  assert.equal(integrity.previewDigest, preview.previewDigest);
  assert.deepEqual(
    integrity.files.map(({ path }) => path),
    [
      "artifacts/captions.vtt",
      "artifacts/preview.mp4",
      "artifacts/source-highlights.json",
      "composition/index.html",
      "composition/media/normalized.mp4",
      "composition/narration/scene-001.wav",
      "composition/narration/scene-002.wav",
    ],
  );
  for (const record of integrity.files) {
    const bytes = await readFile(join(context.jobRoot, ...record.path.split("/")));
    assert.deepEqual(Reflect.ownKeys(record), ["path", "sha256", "bytes"]);
    assert.equal(record.bytes, bytes.length);
    assert.equal(
      record.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
  }
  assert.match(await readFile(join(artifacts, "captions.vtt"), "utf8"), /WEBVTT[\s\S]*상단의 프로필 메뉴/u);
  assert.equal((await lstat(join(artifacts, "preview.mp4"))).nlink, 1);
  assert.equal(
    JSON.parse(await readFile(join(artifacts, "preview.json"), "utf8")).mediaPlanDigest,
    preview.previewDigest,
  );
});

test("trims only the leading idle portion of a long wait-only scene", async (t) => {
  const context = await fixture(t);
  const report = {
    ...executionReport(context.planDigest),
    endedAt: "2026-07-15T00:00:07.200Z",
    steps: [
      {
        id: "open-menu",
        startedAt: "2026-07-15T00:00:00.100Z",
        endedAt: "2026-07-15T00:00:01.100Z",
      },
      {
        id: "review-profile",
        startedAt: "2026-07-15T00:00:01.200Z",
        endedAt: "2026-07-15T00:00:07.200Z",
      },
    ],
  };
  const job = { request: { voice: "F2" } };
  const narration = await context.producer.narrate({
    jobId: context.jobId,
    job,
    report,
  });
  const preview = await context.producer.compose({
    jobId: context.jobId,
    job,
    report,
    narration,
  });

  assert.deepEqual(
    preview.mediaPlan.scenes.map((scene) => ({
      id: scene.id,
      start: scene.source.startMs,
      end: scene.source.endMs,
      duration: scene.source.durationMs,
      playbackRate: scene.source.playbackRate,
    })),
    [
      {
        id: "open-menu",
        start: 100,
        end: 1_100,
        duration: 1_000,
        playbackRate: 1,
      },
      {
        id: "review-profile",
        start: 5_550,
        end: 7_200,
        duration: 1_650,
        playbackRate: 1.1,
      },
    ],
  );
});

test("uses leading idle from the following wait-only scene for longer action narration", async (t) => {
  const context = await fixture(t, {
    async afterNarration({ manifest }) {
      manifest.scenes[0].durationSeconds = 3.483;
    },
  });
  const report = {
    ...executionReport(context.planDigest),
    endedAt: "2026-07-15T00:00:13.866Z",
    steps: [
      {
        id: "open-menu",
        startedAt: "2026-07-15T00:00:00.100Z",
        endedAt: "2026-07-15T00:00:02.603Z",
      },
      {
        id: "review-profile",
        startedAt: "2026-07-15T00:00:02.617Z",
        endedAt: "2026-07-15T00:00:13.866Z",
      },
    ],
  };
  const job = { request: { voice: "F2" } };
  const narration = await context.producer.narrate({
    jobId: context.jobId,
    job,
    report,
  });
  const preview = await context.producer.compose({
    jobId: context.jobId,
    job,
    report,
    narration,
  });

  assert.deepEqual(
    preview.mediaPlan.scenes.map((scene) => ({
      id: scene.id,
      start: scene.source.startMs,
      end: scene.source.endMs,
      duration: scene.source.durationMs,
      playbackRate: scene.source.playbackRate,
      drift: scene.driftMs,
    })),
    [
      {
        id: "open-menu",
        start: 100,
        end: 3_235,
        duration: 3_135,
        playbackRate: 0.900086,
        drift: 0,
      },
      {
        id: "review-profile",
        start: 12_216,
        end: 13_866,
        duration: 1_650,
        playbackRate: 1.1,
        drift: 500,
      },
    ],
  );
});

test("rebalances consecutive actions into the leading idle of the next wait scene", async (t) => {
  const plan = approvedPlan();
  plan.steps = [
    plan.steps[0],
    {
      ...plan.steps[0],
      id: "select-project",
      action: "Manual Video 프로젝트 선택",
      expected: "Manual Video 프로젝트가 선택됨",
      narration: "목록에서 Manual Video 프로젝트를 찾아서 클릭합니다.",
      calls: [
        {
          id: "select-project.click",
          tool: "browser_click",
          arguments: { target: "e23" },
        },
      ],
    },
    {
      ...plan.steps[1],
      id: "confirm-complete",
      action: "완료 화면 확인",
      expected: "완료 화면이 표시됨",
      narration: "프로젝트 완료 처리가 완료될 때까지 기다립니다.",
      calls: [
        {
          id: "confirm-complete.wait",
          tool: "browser_wait_for",
          arguments: { time: 10, text: "완료" },
        },
      ],
    },
  ];
  const context = await fixture(t, {
    plan,
    async afterNarration({ manifest }) {
      manifest.scenes[0].durationSeconds = 3.762;
      manifest.scenes[1].durationSeconds = 4.11;
      manifest.scenes[2].durationSeconds = 3.971;
    },
  });
  const report = {
    ...executionReport(context.planDigest),
    endedAt: "2026-07-15T00:00:16.447Z",
    steps: [
      {
        id: "open-menu",
        startedAt: "2026-07-15T00:00:00.032Z",
        endedAt: "2026-07-15T00:00:02.595Z",
      },
      {
        id: "select-project",
        startedAt: "2026-07-15T00:00:02.610Z",
        endedAt: "2026-07-15T00:00:05.150Z",
      },
      {
        id: "confirm-complete",
        startedAt: "2026-07-15T00:00:05.164Z",
        endedAt: "2026-07-15T00:00:16.412Z",
      },
    ],
    clickHighlights: [
      {
        stepId: "open-menu",
        callId: "open-menu.click",
        at: "2026-07-15T00:00:00.500Z",
        x: 120,
        y: 160,
        width: 320,
        height: 72,
      },
      {
        stepId: "select-project",
        callId: "select-project.click",
        at: "2026-07-15T00:00:04.000Z",
        x: 480,
        y: 320,
        width: 240,
        height: 64,
      },
    ],
  };
  const job = { request: { voice: "F2" } };
  const narration = await context.producer.narrate({
    jobId: context.jobId,
    job,
    report,
  });
  const preview = await context.producer.compose({
    jobId: context.jobId,
    job,
    report,
    narration,
  });

  assert.deepEqual(
    preview.mediaPlan.scenes.map((scene) => ({
      id: scene.id,
      start: scene.source.startMs,
      end: scene.source.endMs,
      playbackRate: scene.source.playbackRate,
      drift: scene.driftMs,
    })),
    [
      {
        id: "open-menu",
        start: 32,
        end: 3_418,
        playbackRate: 0.900053,
        drift: 0,
      },
      {
        id: "select-project",
        start: 3_418,
        end: 7_117,
        playbackRate: 0.9,
        drift: 0,
      },
      {
        id: "confirm-complete",
        start: 11_494,
        end: 16_412,
        playbackRate: 1.1,
        drift: 500,
      },
    ],
  );
});

test("trims the leading coordinator dwell while retaining the completed action tail", async (t) => {
  const context = await fixture(t);
  const report = {
    ...executionReport(context.planDigest),
    endedAt: "2026-07-15T00:00:09.200Z",
    toolCalls: compileExecutionCalls(context.plan).map(({ id, tool }) => ({ id, tool })),
    steps: [
      {
        id: "open-menu",
        startedAt: "2026-07-15T00:00:00.100Z",
        endedAt: "2026-07-15T00:00:08.100Z",
      },
      {
        id: "review-profile",
        startedAt: "2026-07-15T00:00:08.200Z",
        endedAt: "2026-07-15T00:00:09.200Z",
      },
    ],
    clickHighlights: [
      {
        stepId: "open-menu",
        callId: "open-menu.click",
        at: "2026-07-15T00:00:06.600Z",
        x: 120,
        y: 160,
        width: 320,
        height: 72,
      },
    ],
  };
  const job = { request: { voice: "F2" } };
  const narration = await context.producer.narrate({
    jobId: context.jobId,
    job,
    report,
  });
  const preview = await context.producer.compose({
    jobId: context.jobId,
    job,
    report,
    narration,
  });

  assert.deepEqual(
    preview.mediaPlan.scenes.map((scene) => ({
      id: scene.id,
      start: scene.source.startMs,
      end: scene.source.endMs,
      playbackRate: scene.source.playbackRate,
      drift: scene.driftMs,
    })),
    [
      {
        id: "open-menu",
        start: 6_350,
        end: 8_000,
        playbackRate: 1.1,
        drift: 500,
      },
      {
        id: "review-profile",
        start: 8_200,
        end: 9_200,
        playbackRate: 1,
        drift: 0,
      },
    ],
  );
  assert.deepEqual(preview.mediaPlan.scenes[0].highlights, [
    {
      callId: "open-menu.click",
      x: 120,
      y: 160,
      width: 320,
      height: 72,
      startMs: 227,
      durationMs: 900,
    },
  ]);
});

test("preserves multiple trusted clicks in deterministic order and rejects an impossible cue span", async (t) => {
  const plan = approvedPlan();
  plan.steps[0].calls.push({
    id: "open-menu.select",
    tool: "browser_click",
    arguments: { element: "프로필 항목", target: "e12" },
  });
  const context = await fixture(t, {
    plan,
    async afterNarration({ manifest }) {
      manifest.scenes[0].durationSeconds = 2;
    },
  });
  const base = executionReport(context.planDigest);
  const report = {
    ...base,
    endedAt: "2026-07-15T00:00:03.500Z",
    steps: [
      {
        id: "open-menu",
        startedAt: "2026-07-15T00:00:00.100Z",
        endedAt: "2026-07-15T00:00:02.400Z",
      },
      {
        id: "review-profile",
        startedAt: "2026-07-15T00:00:02.500Z",
        endedAt: "2026-07-15T00:00:03.500Z",
      },
    ],
    clickHighlights: [
      { ...base.clickHighlights[0], at: "2026-07-15T00:00:00.500Z" },
      {
        stepId: "open-menu",
        callId: "open-menu.select",
        at: "2026-07-15T00:00:01.400Z",
        x: 480,
        y: 320,
        width: 240,
        height: 64,
      },
    ],
  };
  const job = { request: { voice: "F2" } };
  const narration = await context.producer.narrate({
    jobId: context.jobId,
    job,
    report,
  });
  const preview = await context.producer.compose({
    jobId: context.jobId,
    job,
    report,
    narration,
  });

  assert.deepEqual(
    preview.mediaPlan.scenes[0].highlights.map(({ callId }) => callId),
    ["open-menu.click", "open-menu.select"],
  );
  assert.deepEqual(preview.mediaPlan.scenes[1].highlights, []);
  const sourceBinding = JSON.parse(
    await readFile(
      join(context.jobRoot, "artifacts", "source-highlights.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    sourceBinding.scenes[0].highlights.map(({ callId }) => callId),
    ["open-menu.click", "open-menu.select"],
  );
  assert.deepEqual(sourceBinding.scenes[1].highlights, []);

  const impossible = {
    ...report,
    endedAt: "2026-07-15T00:00:09.200Z",
    toolCalls: compileExecutionCalls(plan).map(({ id, tool }) => ({ id, tool })),
    steps: [
      {
        id: "open-menu",
        startedAt: "2026-07-15T00:00:00.100Z",
        endedAt: "2026-07-15T00:00:08.100Z",
      },
      {
        id: "review-profile",
        startedAt: "2026-07-15T00:00:08.200Z",
        endedAt: "2026-07-15T00:00:09.200Z",
      },
    ],
    clickHighlights: [
      { ...report.clickHighlights[0], at: "2026-07-15T00:00:01.000Z" },
      { ...report.clickHighlights[1], at: "2026-07-15T00:00:07.000Z" },
    ],
  };
  const impossibleNarration = await context.producer.narrate({
    jobId: context.jobId,
    job,
    report: impossible,
  });
  await assert.rejects(
    context.producer.compose({
      jobId: context.jobId,
      job,
      report: impossible,
      narration: impossibleNarration,
    }),
    (error) =>
      error?.code === "PRODUCER_HIGHLIGHT_INVALID" &&
      typeof error?.details?.reason === "string" &&
      error.details.reason.length <= 64,
  );
});

test("completed reports require exactly one trusted highlight for every approved click", async (t) => {
  const context = await fixture(t);
  const job = { request: { voice: "F2" } };
  const valid = executionReport(context.planDigest);
  for (const clickHighlights of [
    [],
    [{ ...valid.clickHighlights[0], x: 120.5 }],
    [{ ...valid.clickHighlights[0], untrusted: true }],
    [...valid.clickHighlights, {
      stepId: "review-profile",
      callId: "review-profile.wait",
      at: "2026-07-15T00:00:01.500Z",
      x: 1,
      y: 1,
      width: 10,
      height: 10,
    }],
  ]) {
    await assert.rejects(
      context.producer.narrate({
        jobId: context.jobId,
        job,
        report: { ...valid, clickHighlights },
      }),
      { code: "PRODUCER_HIGHLIGHT_INVALID" },
    );
  }
});

test("does not hide unexplained drift in a long action scene", async (t) => {
  const context = await fixture(t);
  const report = {
    ...executionReport(context.planDigest),
    endedAt: "2026-07-15T00:00:07.200Z",
    steps: [
      {
        id: "open-menu",
        startedAt: "2026-07-15T00:00:00.100Z",
        endedAt: "2026-07-15T00:00:06.100Z",
      },
      {
        id: "review-profile",
        startedAt: "2026-07-15T00:00:06.200Z",
        endedAt: "2026-07-15T00:00:07.200Z",
      },
    ],
  };
  const job = { request: { voice: "F2" } };
  const narration = await context.producer.narrate({
    jobId: context.jobId,
    job,
    report,
  });

  await assert.rejects(
    context.producer.compose({
      jobId: context.jobId,
      job,
      report,
      narration,
    }),
    (error) => error?.code === "MEDIA_DRIFT_EXCEEDED",
  );
});

test("edit rejects fields outside the digest-bound caption and narration contract", async (t) => {
  const context = await fixture(t);
  const { preview } = await preparedPreview(context);

  await assert.rejects(
    context.producer.edit({
      jobId: context.jobId,
      preview,
      edit: {
        previewDigest: preview.previewDigest,
        sceneId: "open-menu",
        captionText: "새 자막",
        actionCalls: [{ tool: "browser_click", arguments: { target: "other" } }],
      },
    }),
    { code: "PRODUCER_EDIT_INVALID" },
  );
  await assert.rejects(
    context.producer.edit({
      jobId: context.jobId,
      preview,
      edit: {
        previewDigest: preview.previewDigest,
        sceneId: "open-menu",
        narrationText: "변경 문장",
        sourceHighlights: [],
      },
    }),
    { code: "PRODUCER_EDIT_INVALID" },
  );
});

test("verifyPreview rejects a preview object whose media plan differs from the persisted digest", async (t) => {
  const context = await fixture(t);
  const { preview } = await preparedPreview(context);
  const changed = structuredClone(preview);
  changed.mediaPlan.scenes[0].caption.text = "이벤트 객체만 바꾼 자막";

  await assert.rejects(
    context.producer.verifyPreview({
      jobId: context.jobId,
      preview: changed,
    }),
    { code: "PRODUCER_PREVIEW_STALE" },
  );
});

test("verifyPreview rejects preview metadata with fields outside the exact persisted contract", async (t) => {
  const context = await fixture(t);
  const { preview } = await preparedPreview(context);
  const metadataPath = join(context.jobRoot, "artifacts", "preview.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  await writeFile(metadataPath, JSON.stringify({ ...metadata, sourcePath: "browser/session.webm" }));

  await assert.rejects(
    context.producer.verifyPreview({ jobId: context.jobId, preview }),
    { code: "PRODUCER_PREVIEW_INVALID" },
  );
});

test("verifyPreview rejects fields outside the exact integrity-bound preview object", async (t) => {
  const context = await fixture(t);
  const { preview } = await preparedPreview(context);

  await assert.rejects(
    context.producer.verifyPreview({
      jobId: context.jobId,
      preview: { ...preview, recordingPath: "browser/session.webm" },
    }),
    { code: "PRODUCER_PREVIEW_INVALID" },
  );
});

test("verifyPreview rejects a rewritten integrity manifest even when its forged hashes match", async (t) => {
  const context = await fixture(t);
  const { preview } = await preparedPreview(context);
  const target = join(context.jobRoot, "artifacts", "preview.mp4");
  const changed = Buffer.from(await readFile(target));
  changed[0] ^= 0xff;
  await writeFile(target, changed);
  const integrityPath = join(context.jobRoot, "artifacts", "preview-integrity.json");
  const integrity = JSON.parse(await readFile(integrityPath, "utf8"));
  const record = integrity.files.find(({ path }) => path === "artifacts/preview.mp4");
  record.sha256 = createHash("sha256").update(changed).digest("hex");
  record.bytes = changed.length;
  await writeFile(integrityPath, `${JSON.stringify(integrity)}\n`, "utf8");

  await assert.rejects(
    context.producer.verifyPreview({ jobId: context.jobId, preview }),
    { code: "PRODUCER_PREVIEW_STALE" },
  );
});

test("verifyPreview rejects mutation of every HyperFrames input and reviewed artifact", async (t) => {
  const protectedPaths = [
    "artifacts/preview.mp4",
    "artifacts/captions.vtt",
    "artifacts/source-highlights.json",
    "composition/index.html",
    "composition/media/normalized.mp4",
    "composition/narration/scene-001.wav",
    "composition/narration/scene-002.wav",
  ];

  for (const relativePath of protectedPaths) {
    await t.test(relativePath, async (subtest) => {
      const context = await fixture(subtest);
      const { preview } = await preparedPreview(context);
      const target = join(context.jobRoot, ...relativePath.split("/"));
      const bytes = await readFile(target);
      const changed = Buffer.from(bytes);
      changed[0] ^= 0xff;
      await writeFile(target, changed);

      await assert.rejects(
        context.producer.verifyPreview({ jobId: context.jobId, preview }),
        {
          code: relativePath === "artifacts/source-highlights.json"
            ? "PRODUCER_DATA_INVALID"
            : "PRODUCER_PREVIEW_STALE",
        },
      );
    });
  }
});

test("verifyPreview requires the exact immutable preview integrity manifest", async (t) => {
  const context = await fixture(t);
  const { preview } = await preparedPreview(context);
  const manifestPath = join(context.jobRoot, "artifacts", "preview-integrity.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(
    manifestPath,
    JSON.stringify({ ...manifest, unreviewedArtifact: "unreviewed.mp4" }),
  );

  await assert.rejects(
    context.producer.verifyPreview({ jobId: context.jobId, preview }),
    { code: "PRODUCER_PREVIEW_INVALID" },
  );
});

test("verifyPreview rejects missing, stale, and swapped source highlight bindings", async (t) => {
  await t.test("missing", async (subtest) => {
    const context = await fixture(subtest);
    const { preview } = await preparedPreview(context);
    await rm(join(context.jobRoot, "artifacts", "source-highlights.json"));

    await assert.rejects(
      context.producer.verifyPreview({ jobId: context.jobId, preview }),
      { code: "UNSAFE_MEDIA_PATH" },
    );
  });

  await t.test("stale digest", async (subtest) => {
    const context = await fixture(subtest);
    const { preview } = await preparedPreview(context);
    const sourcePath = join(context.jobRoot, "artifacts", "source-highlights.json");
    const binding = JSON.parse(await readFile(sourcePath, "utf8"));
    binding.previewDigest = binding.previewDigest === "0".repeat(64)
      ? "f".repeat(64)
      : "0".repeat(64);
    await writeFile(sourcePath, `${JSON.stringify(binding)}\n`, "utf8");

    await assert.rejects(
      context.producer.verifyPreview({ jobId: context.jobId, preview }),
      { code: "PRODUCER_PREVIEW_STALE" },
    );
  });

  await t.test("swapped job", async (subtest) => {
    const context = await fixture(subtest);
    const { preview } = await preparedPreview(context);
    const sourcePath = join(context.jobRoot, "artifacts", "source-highlights.json");
    const binding = JSON.parse(await readFile(sourcePath, "utf8"));
    binding.jobId = "job-media-2";
    await writeFile(sourcePath, `${JSON.stringify(binding)}\n`, "utf8");

    await assert.rejects(
      context.producer.verifyPreview({ jobId: context.jobId, preview }),
      { code: "PRODUCER_PREVIEW_STALE" },
    );
  });

  await t.test("fractional source cue", async (subtest) => {
    const context = await fixture(subtest);
    const { preview } = await preparedPreview(context);
    const sourcePath = join(context.jobRoot, "artifacts", "source-highlights.json");
    const binding = JSON.parse(await readFile(sourcePath, "utf8"));
    binding.scenes[0].highlights[0].sourceAtMs += 0.5;
    await writeFile(sourcePath, `${JSON.stringify(binding)}\n`, "utf8");

    await assert.rejects(
      context.producer.verifyPreview({ jobId: context.jobId, preview }),
      { code: "PRODUCER_PREVIEW_INVALID" },
    );
  });
});

test("verifyPreview fingerprints the same source highlight bytes it validates", async (t) => {
  const context = await fixture(t);
  const { preview } = await preparedPreview(context);
  const sourcePath = join(context.jobRoot, "artifacts", "source-highlights.json");
  const approvedBytes = await readFile(sourcePath);
  const forgedBinding = JSON.parse(approvedBytes.toString("utf8"));
  forgedBinding.scenes[0].highlights[0].sourceAtMs += 1;
  await writeFile(sourcePath, `${JSON.stringify(forgedBinding)}\n`, "utf8");

  let digestCalls = 0;
  const verifier = context.createProducer({
    mediaPlanDigest(value) {
      digestCalls += 1;
      if (digestCalls === 2) writeFileSync(sourcePath, approvedBytes);
      return mediaPlanDigest(value);
    },
  });

  await assert.rejects(
    verifier.verifyPreview({ jobId: context.jobId, preview }),
    { code: "PRODUCER_PREVIEW_STALE" },
  );
});

test("preview publication binds integrity to the exact source highlight bytes atomically written", async (t) => {
  const context = await fixture(t);
  const report = executionReport(context.planDigest);
  const job = { request: { voice: "F2" } };
  const narration = await context.producer.narrate({
    jobId: context.jobId,
    job,
    report,
  });
  const artifactsPath = join(context.jobRoot, "artifacts");
  const sourcePath = join(artifactsPath, "source-highlights.json");

  let sourceWatcher;
  const swapped = new Promise((resolve, reject) => {
    sourceWatcher = watch(artifactsPath, (_event, fileName) => {
      if (fileName?.toString() !== "source-highlights.json") return;
      sourceWatcher.close();
      try {
        const forgedBinding = JSON.parse(readFileSync(sourcePath, "utf8"));
        forgedBinding.scenes[0].highlights[0].sourceAtMs += 1;
        writeFileSync(sourcePath, `${JSON.stringify(forgedBinding)}\n`, "utf8");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  t.after(() => sourceWatcher?.close());

  await Promise.all([
    assert.rejects(
      context.producer.compose({
        jobId: context.jobId,
        job,
        report,
        narration,
      }),
      { code: "UNSAFE_MEDIA_PATH" },
    ),
    swapped,
  ]);
});

test("final rendering regenerates and checks the approved composition before HyperFrames", async (t) => {
  const context = await fixture(t, {
    qualityGate: {
      async probe({ expectedDurationMs }) {
        return { fps: 30, durationMs: expectedDurationMs };
      },
    },
  });
  const { preview } = await preparedPreview(context);
  assert.equal(context.compositionWrites.length, 1);

  await context.producer.render({ jobId: context.jobId, preview });

  assert.equal(context.compositionWrites.length, 2);
  assert.deepEqual(
    context.calls.map(([name]) => name),
    [
      "normalize",
      "lint",
      "check",
      "preview",
      "render:draft",
      "stopPreview",
      "lint",
      "check",
      "render:high",
    ],
  );
});

test("final artifact publication never replaces the immutable preview manifest", async (t) => {
  const context = await fixture(t, {
    qualityGate: {
      async probe({ expectedDurationMs }) {
        return { fps: 30, durationMs: expectedDurationMs };
      },
    },
  });
  const { preview } = await preparedPreview(context);
  const integrityPath = join(context.jobRoot, "artifacts", "preview-integrity.json");
  const before = await readFile(integrityPath, "utf8");

  await context.producer.render({ jobId: context.jobId, preview });

  assert.equal(await readFile(integrityPath, "utf8"), before);
  assert.deepEqual(
    JSON.parse(await readFile(join(context.jobRoot, "artifacts", "manifest.json"), "utf8")),
    {
      files: [
        "captions.vtt",
        "final.mp4",
        "media-plan.json",
        "preview-integrity.json",
        "preview.json",
        "preview.mp4",
        "quality.json",
        "source-highlights.json",
      ],
    },
  );
  await context.producer.verifyPreview({ jobId: context.jobId, preview });
});

test("a persisted preview retries after RENDER_COMPLETED storage failure without recapture or media stages", async (t) => {
  const context = await fixture(t, {
    qualityGate: {
      async probe({ expectedDurationMs }) {
        return { fps: 30, durationMs: expectedDurationMs };
      },
    },
  });
  const { preview } = await preparedPreview(context);
  const store = await previewReviewStore(
    t,
    context.jobId,
    context.planDigest,
    preview,
  );
  let completionWrites = 0;
  const persistenceBoundary = {
    load: (...args) => store.load(...args),
    readEvents: (...args) => store.readEvents(...args),
    compareAndTransition: (...args) => store.compareAndTransition(...args),
    transition: async (jobId, eventName, data) => {
      if (eventName === "RENDER_COMPLETED") {
        completionWrites += 1;
        if (completionWrites === 1) {
          throw new Error("simulated RENDER_COMPLETED persistence failure");
        }
      }
      return store.transition(jobId, eventName, data);
    },
  };
  const workflow = new ProductionWorkflow({
    jobStore: persistenceBoundary,
    producer: context.producer,
  });

  await assert.rejects(
    workflow.approvePreview(context.jobId, preview.previewDigest),
    /RENDER_COMPLETED persistence failure/u,
  );
  assert.equal((await store.load(context.jobId)).state, "failed");
  assert.equal(
    JSON.parse(
      await readFile(join(context.jobRoot, "artifacts", "manifest.json"), "utf8"),
    ).files.includes("final.mp4"),
    true,
  );

  const result = await workflow.retryRender(
    context.jobId,
    context.planDigest,
    preview.previewDigest,
  );

  assert.equal(result.state, "completed");
  assert.equal(completionWrites, 2);
  assert.equal(context.narrationCalls.length, 1);
  assert.equal(context.calls.filter(([name]) => name === "normalize").length, 1);
  assert.equal(context.calls.filter(([name]) => name === "render:draft").length, 1);
  assert.equal(context.calls.filter(([name]) => name === "render:high").length, 2);
});

test("caption editing is a pure draft and rebuild reuses the recording and narration", async (t) => {
  const context = await fixture(t);
  const { job, preview } = await preparedPreview(context);
  const persistedPath = join(context.jobRoot, "artifacts", "media-plan.json");
  const persistedBefore = await readFile(persistedPath, "utf8");
  const narrationCount = context.narrationCalls.length;
  const normalizeCount = context.calls.filter(([name]) => name === "normalize").length;

  const edited = await context.producer.edit({
    jobId: context.jobId,
    preview,
    edit: {
      previewDigest: preview.previewDigest,
      sceneId: "open-menu",
      captionText: "프로필 메뉴를 선택하세요.",
    },
  });

  assert.equal(edited.stage, "composing");
  assert.equal(await readFile(persistedPath, "utf8"), persistedBefore);
  assert.equal(context.narrationCalls.length, narrationCount);
  assert.equal(
    context.calls.filter(([name]) => name === "normalize").length,
    normalizeCount,
  );

  const rebuilt = await context.producer.rebuild({
    jobId: context.jobId,
    job,
    preview,
    edited,
    stage: edited.stage,
  });

  assert.notEqual(rebuilt.previewDigest, preview.previewDigest);
  assert.equal(rebuilt.mediaPlan.scenes[0].caption.text, "프로필 메뉴를 선택하세요.");
  assert.equal(rebuilt.mediaPlan.scenes[0].narration.text, "상단의 프로필 메뉴를 엽니다.");
  assert.deepEqual(rebuilt.mediaPlan.scenes[0].highlights, preview.mediaPlan.scenes[0].highlights);
  assert.equal(context.narrationCalls.length, narrationCount);
  assert.equal(
    context.calls.filter(([name]) => name === "normalize").length,
    normalizeCount,
  );
});

test("an unchanged narration field does not turn a caption-only edit into resynthesis", async (t) => {
  const context = await fixture(t);
  const { preview } = await preparedPreview(context);

  const edited = await context.producer.edit({
    jobId: context.jobId,
    preview,
    edit: {
      previewDigest: preview.previewDigest,
      sceneId: "open-menu",
      captionText: "자막만 바꿉니다.",
      narrationText: preview.mediaPlan.scenes[0].narration.text,
    },
  });

  assert.equal(edited.stage, "composing");
  assert.equal(edited.captionChanged, true);
  assert.equal(edited.narrationChanged, false);
});

test("narration editing resynthesizes real clips while preserving every approved action call", async (t) => {
  const context = await fixture(t);
  const { job, preview } = await preparedPreview(context);
  const normalizeCount = context.calls.filter(([name]) => name === "normalize").length;

  const edited = await context.producer.edit({
    jobId: context.jobId,
    preview,
    edit: {
      previewDigest: preview.previewDigest,
      sceneId: "open-menu",
      narrationText: "프로필 메뉴를 한 번 선택합니다.",
    },
  });
  const rebuilt = await context.producer.rebuild({
    jobId: context.jobId,
    job,
    preview,
    edited,
    stage: edited.stage,
  });

  assert.equal(edited.stage, "narrating");
  assert.equal(context.narrationCalls.length, 2);
  assert.equal(context.narrationCalls[1].voice, "F2");
  assert.equal(
    context.narrationCalls[1].plan.steps[0].narration,
    "프로필 메뉴를 한 번 선택합니다.",
  );
  assert.deepEqual(
    context.narrationCalls[1].plan.steps.map((step) => step.calls),
    context.plan.steps.map((step) => step.calls),
  );
  assert.equal(rebuilt.mediaPlan.scenes[0].narration.text, "프로필 메뉴를 한 번 선택합니다.");
  assert.deepEqual(rebuilt.mediaPlan.scenes[0].highlights, preview.mediaPlan.scenes[0].highlights);
  assert.equal(
    context.calls.filter(([name]) => name === "normalize").length,
    normalizeCount,
  );
});

test("narration rebuild preserves the trusted source time of a late boundary click", async (t) => {
  const context = await fixture(t);
  const base = executionReport(context.planDigest);
  const report = {
    ...base,
    clickHighlights: [
      {
        ...base.clickHighlights[0],
        at: "2026-07-15T00:00:01.000Z",
      },
    ],
  };
  const job = { request: { voice: "F2" } };
  const narration = await context.producer.narrate({
    jobId: context.jobId,
    job,
    report,
  });
  const preview = await context.producer.compose({
    jobId: context.jobId,
    job,
    report,
    narration,
  });
  assert.equal(preview.mediaPlan.scenes[0].highlights[0].startMs, 100);
  assert.equal(context.mediaPlanInputs[0].scenes[0].highlights[0].sourceAtMs, 1_000);

  const restartedProducer = context.createProducer();
  const edited = await restartedProducer.edit({
    jobId: context.jobId,
    preview,
    edit: {
      previewDigest: preview.previewDigest,
      sceneId: "open-menu",
      narrationText: "프로필 메뉴를 선택한 뒤 내용을 확인합니다.",
    },
  });
  const rebuilt = await restartedProducer.rebuild({
    jobId: context.jobId,
    job,
    preview,
    edited,
    stage: edited.stage,
  });

  assert.equal(rebuilt.mediaPlan.scenes[0].highlights[0].startMs, 100);
  assert.equal(context.mediaPlanInputs[1].scenes[0].highlights[0].sourceAtMs, 1_000);
});

test("render refuses to publish final artifacts when the media plan changes during quality probing", async (t) => {
  let mediaPlanPath;
  const context = await fixture(t, {
    qualityGate: {
      async probe() {
        const changed = JSON.parse(await readFile(mediaPlanPath, "utf8"));
        changed.scenes[0].caption.text = "품질 검사 중 바뀐 계획";
        await writeFile(mediaPlanPath, JSON.stringify(changed));
        return { fps: 30, durationMs: 2_000 };
      },
    },
  });
  mediaPlanPath = join(context.jobRoot, "artifacts", "media-plan.json");
  const { preview } = await preparedPreview(context);

  await assert.rejects(
    context.producer.render({ jobId: context.jobId, preview }),
    { code: "PRODUCER_PREVIEW_STALE" },
  );
  const manifest = JSON.parse(
    await readFile(join(context.jobRoot, "artifacts", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.files.includes("final.mp4"), false);
});

test("render rejects a regular final file that is replaced during quality probing", async (t) => {
  const context = await fixture(t, {
    qualityGate: {
      async probe({ filePath }) {
        await rm(filePath);
        await writeFile(filePath, "replacement-after-probe");
        return { fps: 30, durationMs: 2_000 };
      },
    },
  });
  const { preview } = await preparedPreview(context);

  await assert.rejects(
    context.producer.render({ jobId: context.jobId, preview }),
    { code: "UNSAFE_MEDIA_PATH" },
  );
  const manifest = JSON.parse(
    await readFile(join(context.jobRoot, "artifacts", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.files.includes("final.mp4"), false);
});

test("high render passes the media duration to QualityGate and publishes the final manifest last", async (t) => {
  const probes = [];
  const context = await fixture(t, {
    qualityGate: {
      async probe(options) {
        probes.push(options);
        return { fps: 30, durationMs: options.expectedDurationMs, videoCodec: "h264" };
      },
    },
  });
  const { preview } = await preparedPreview(context);

  const rendered = await context.producer.render({
    jobId: context.jobId,
    preview,
  });

  assert.deepEqual(rendered, {
    outputArtifact: "final.mp4",
    quality: { fps: 30, durationMs: 2_000, videoCodec: "h264" },
  });
  assert.equal(probes.length, 1);
  assert.equal(probes[0].expectedDurationMs, 2_000);
  assert.equal(probes[0].filePath, join(context.jobRoot, "artifacts", "final.mp4"));
  assert.deepEqual(
    JSON.parse(await readFile(join(context.jobRoot, "artifacts", "manifest.json"), "utf8")),
    {
      files: [
        "captions.vtt",
        "final.mp4",
        "media-plan.json",
        "preview-integrity.json",
        "preview.json",
        "preview.mp4",
        "quality.json",
        "source-highlights.json",
      ],
    },
  );
});

test("verifyPreview rejects a hard-linked preview artifact without reading outside content", async (t) => {
  const context = await fixture(t);
  const { preview } = await preparedPreview(context);
  const previewPath = join(context.jobRoot, "artifacts", "preview.mp4");
  const outsidePath = join(dirname(dirname(context.jobRoot)), "outside-preview.mp4");
  await writeFile(outsidePath, "outside-must-not-be-trusted");
  await rm(previewPath);
  await link(outsidePath, previewPath);

  await assert.rejects(
    context.producer.verifyPreview({ jobId: context.jobId, preview }),
    { code: "UNSAFE_MEDIA_PATH" },
  );
  assert.equal(await readFile(outsidePath, "utf8"), "outside-must-not-be-trusted");
});

test("compose rejects a regular preview file replaced between draft render and manifest publication", async (t) => {
  let previewPath;
  let digestCalls = 0;
  const context = await fixture(t, {
    mediaPlanDigest(value) {
      digestCalls += 1;
      if (digestCalls === 1) {
        rmSync(previewPath);
        writeFileSync(previewPath, "replacement-before-publication");
      }
      return mediaPlanDigest(value);
    },
  });
  previewPath = join(context.jobRoot, "artifacts", "preview.mp4");
  const report = executionReport(context.planDigest);
  const job = { request: { voice: "F2" } };
  const narration = await context.producer.narrate({
    jobId: context.jobId,
    job,
    report,
  });

  await assert.rejects(
    context.producer.compose({
      jobId: context.jobId,
      job,
      report,
      narration,
    }),
    { code: "UNSAFE_MEDIA_PATH" },
  );
  await assert.rejects(
    readFile(join(context.jobRoot, "artifacts", "manifest.json")),
    { code: "ENOENT" },
  );
});

test("cancel stops exactly the HyperFrames preview owned by the active job", async (t) => {
  let announceRender;
  const rendering = new Promise((resolve) => { announceRender = resolve; });
  const context = await fixture(t, {
    async render(options) {
      if (options.quality !== "draft") throw new Error("unexpected quality");
      announceRender();
      await new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    },
  });
  const report = executionReport(context.planDigest);
  const job = { request: { voice: "F2" } };
  const narration = await context.producer.narrate({
    jobId: context.jobId,
    job,
    report,
  });
  const controller = new AbortController();
  const composing = context.producer.compose({
    jobId: context.jobId,
    job,
    report,
    narration,
    signal: controller.signal,
  });
  await rendering;

  controller.abort(new Error("cancelled"));
  await context.producer.cancel({ jobId: context.jobId });
  await assert.rejects(composing);

  assert.equal(
    context.calls.filter(([name]) => name === "stopPreview").length,
    1,
  );
});

test("narration rebuild rejects a hard-linked synthesized clip before recomposition", async (t) => {
  let outsidePath;
  const context = await fixture(t, {
    async afterNarration({ callIndex, outputDirectory }) {
      if (callIndex !== 2) return;
      outsidePath = join(dirname(dirname(outputDirectory)), "outside-narration.wav");
      await writeFile(outsidePath, "outside-narration-must-survive");
      const clipPath = join(outputDirectory, "scene-001.wav");
      await rm(clipPath);
      await link(outsidePath, clipPath);
    },
  });
  const { job, preview } = await preparedPreview(context);
  const edited = await context.producer.edit({
    jobId: context.jobId,
    preview,
    edit: {
      previewDigest: preview.previewDigest,
      sceneId: "open-menu",
      narrationText: "안전하게 다시 합성하는 문장입니다.",
    },
  });

  await assert.rejects(
    context.producer.rebuild({
      jobId: context.jobId,
      job,
      preview,
      edited,
      stage: edited.stage,
    }),
    { code: "UNSAFE_MEDIA_PATH" },
  );
  assert.equal(await readFile(outsidePath, "utf8"), "outside-narration-must-survive");
});

test("narrate rejects a manifest that is not bound to the requested Korean voice", async (t) => {
  const context = await fixture(t, {
    async afterNarration({ manifest }) {
      manifest.voice = "M5";
    },
  });

  await assert.rejects(
    context.producer.narrate({
      jobId: context.jobId,
      job: { request: { voice: "F2" } },
      report: executionReport(context.planDigest),
    }),
    { code: "PRODUCER_NARRATION_INVALID" },
  );
});

test("custom Supertonic factories cannot bypass the loopback-only service boundary", async (t) => {
  await assert.rejects(
    fixture(t, { supertonicBaseUrl: "https://tts.example.test" }),
    { code: "PRODUCER_CONFIGURATION_INVALID" },
  );
});
