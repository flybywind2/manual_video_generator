import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { digestPlan } from "../../src/domain/plan.js";
import { mediaPlanDigest } from "../../src/media/composition.js";
import { createMediaProducer } from "../../src/media/producer.js";

function approvedPlan() {
  return {
    schemaVersion: "1.1",
    targetUrl: "https://example.test/dashboard",
    targetOrigin: "https://example.test",
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

  const plan = approvedPlan();
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
  const createSupertonicClient = (options) => {
    clientFactoryCalls.push(options);
    return { outputRoot: options.outputRoot, health() {}, synthesize() {} };
  };
  const producer = createMediaProducer({
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
    mediaPlanDigest: overrides.mediaPlanDigest,
    previewPort: 49_317,
  });

  return {
    producer,
    jobId,
    jobRoot,
    plan,
    planDigest,
    calls,
    narrationCalls,
    clientFactoryCalls,
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

test("transforms approved browser evidence into a bound draft preview and safe artifact manifest", async (t) => {
  const context = await fixture(t);
  const { narration, preview } = await preparedPreview(context);

  assert.equal(narration.sceneCount, 2);
  assert.equal(preview.planDigest, context.planDigest);
  assert.equal(preview.previewDigest, mediaPlanDigest(preview.mediaPlan));
  assert.equal(preview.previewArtifact, "preview.mp4");
  assert.equal(preview.captionsArtifact, "captions.vtt");
  assert.deepEqual(
    preview.mediaPlan.scenes.map((scene) => ({
      id: scene.id,
      start: scene.source.startMs,
      end: scene.source.endMs,
      caption: scene.caption.text,
      chapter: scene.chapter,
    })),
    [
      {
        id: "open-menu",
        start: 100,
        end: 1_100,
        caption: "상단의 프로필 메뉴를 엽니다.",
        chapter: "프로필 메뉴 열기",
      },
      {
        id: "review-profile",
        start: 1_200,
        end: 2_200,
        caption: "표시된 프로필 정보를 확인합니다.",
        chapter: "프로필 정보 확인",
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
    { files: ["captions.vtt", "media-plan.json", "preview.json", "preview.mp4"] },
  );
  assert.match(await readFile(join(artifacts, "captions.vtt"), "utf8"), /WEBVTT[\s\S]*상단의 프로필 메뉴/u);
  assert.equal((await lstat(join(artifacts, "preview.mp4"))).nlink, 1);
  assert.equal(
    JSON.parse(await readFile(join(artifacts, "preview.json"), "utf8")).mediaPlanDigest,
    preview.previewDigest,
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

test("verifyPreview rejects fields outside the exact five-field preview object", async (t) => {
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

test("verifyPreview requires the exact preview-stage artifact manifest", async (t) => {
  const context = await fixture(t);
  const { preview } = await preparedPreview(context);
  const manifestPath = join(context.jobRoot, "artifacts", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(
    manifestPath,
    JSON.stringify({ files: [...manifest.files, "unreviewed.mp4"] }),
  );

  await assert.rejects(
    context.producer.verifyPreview({ jobId: context.jobId, preview }),
    { code: "PRODUCER_PREVIEW_INVALID" },
  );
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
  assert.equal(
    context.calls.filter(([name]) => name === "normalize").length,
    normalizeCount,
  );
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
        "preview.json",
        "preview.mp4",
        "quality.json",
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
