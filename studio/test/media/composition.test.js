import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createMediaPlan } from "../../src/media/media-plan.js";
import {
  compileComposition,
  compositionId,
  writeComposition,
} from "../../src/media/composition.js";

const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const templatePath = join(studioRoot, "templates", "hyperframes", "index.html");

function manifest(
  caption = "프로젝트 <메뉴> & 설정을 선택합니다.",
  {
    highlights = [
      {
        callId: "step-1.click",
        sourceAtMs: 1_200,
        x: 120,
        y: 160,
        width: 320,
        height: 72,
      },
    ],
  } = {},
) {
  return createMediaPlan({
    recordingPath: "composition/media/normalized.mp4",
    scenes: [
      {
        id: "step-1",
        sourceStartMs: 1_000,
        sourceEndMs: 3_000,
        caption,
        chapter: "프로젝트 & 설정",
        highlights,
      },
    ],
    narrations: [
      {
        sceneId: "step-1",
        path: "composition/narration/step-1.wav",
        durationMs: 1_900,
        text: "프로젝트 메뉴를 선택합니다.",
      },
    ],
  });
}

test("fixed template compilation is deterministic and assigns a stable composition id", async () => {
  const template = await readFile(templatePath, "utf8");
  const mediaPlan = manifest();

  const first = compileComposition({ template, mediaPlan, projectPath: "composition" });
  const second = compileComposition({ template, mediaPlan, projectPath: "composition" });

  assert.equal(first, second);
  assert.match(compositionId(mediaPlan), /^manual-[a-f0-9]{24}$/u);
  assert.match(first, new RegExp(`data-composition-id="${compositionId(mediaPlan)}"`, "u"));
  assert.match(first, /data-width="1920" data-height="1080" data-fps="30"/u);
  assert.match(first, /data-duration="1\.900"/u);
  assert.match(first, /data-start="0" data-no-timeline/u);
  assert.doesNotMatch(first, /@@[A-Z_]+@@/u);
});

test("media plan digest is a stable full SHA-256 binding for preview approval", async () => {
  const module = await import("../../src/media/composition.js");
  assert.equal(typeof module.mediaPlanDigest, "function");
  const first = module.mediaPlanDigest(manifest());
  const second = module.mediaPlanDigest(manifest());
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(first, second);
  assert.equal(compositionId(manifest()), `manual-${first.slice(0, 24)}`);
});

test("compiled clips use escaped text, relative in-job media, and separate muted video and narration", async () => {
  const html = compileComposition({
    template: await readFile(templatePath, "utf8"),
    mediaPlan: manifest("<script>alert('x')</script> & 계속"),
    projectPath: "composition",
  });

  assert.doesNotMatch(html, /<script>alert/u);
  assert.match(html, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt; &amp; 계속/u);
  assert.match(html, /프로젝트 &amp; 설정/u);
  assert.match(
    html,
    /<video id="video-step-1" class="browser-video clip"[^>]*src="media\/normalized\.mp4"[^>]*muted/u,
  );
  assert.match(html, /data-media-start="1\.000"/u);
  assert.match(html, /data-playback-rate="1\.052632"/u);
  assert.match(html, /data-volume="0"/u);
  assert.match(
    html,
    /<audio id="narration-step-1" class="narration-audio clip"[^>]*src="narration\/step-1\.wav"[^>]*data-volume="1"/u,
  );
  assert.match(html, /class="caption clip"[^>]*data-start="0\.000"[^>]*data-duration="1\.900"/u);
  assert.match(
    html,
    /<div id="highlight-step-1-0" class="click-highlight clip" data-start="0\.190" data-duration="0\.9" data-track-index="20" style="--target-x:108px;--target-y:148px;--target-width:344px;--target-height:96px;--click-x:280px;--click-y:196px;--pulse-delay:0\.190s">/u,
  );
  assert.match(html, /<span class="click-target"><\/span>/u);
  assert.equal((html.match(/<span class="click-ripple click-ripple-(?:primary|secondary)"><\/span>/gu) ?? []).length, 2);
  assert.doesNotMatch(html, /step-1\.click/u);
  assert.doesNotMatch(html, /action-highlight/u);
  assert.doesNotMatch(html, /(?:src|href)="\.\.\//u);
});

test("click pulses pad and clamp target rectangles while keeping the original click center", async () => {
  const html = compileComposition({
    template: await readFile(templatePath, "utf8"),
    mediaPlan: manifest("가장자리 클릭", {
      highlights: [
        {
          callId: "step-1.top-left",
          sourceAtMs: 1_000,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        },
        {
          callId: "step-1.bottom-right",
          sourceAtMs: 2_000,
          x: 1_910,
          y: 1_070,
          width: 10,
          height: 10,
        },
      ],
    }),
    projectPath: "composition",
  });

  assert.match(
    html,
    /id="highlight-step-1-0"[^>]*style="--target-x:0px;--target-y:0px;--target-width:22px;--target-height:22px;--click-x:5px;--click-y:5px;--pulse-delay:0\.000s"/u,
  );
  assert.match(
    html,
    /id="highlight-step-1-1"[^>]*style="--target-x:1898px;--target-y:1058px;--target-width:22px;--target-height:22px;--click-x:1915px;--click-y:1075px;--pulse-delay:0\.950s"/u,
  );
});

test("multi-scene overlays use distinct tracks so strict HyperFrames lint stays warning-free", async () => {
  const scenes = Array.from({ length: 5 }, (_, index) => ({
    id: `step-${index + 1}`,
    sourceStartMs: index * 2_000,
    sourceEndMs: (index + 1) * 2_000,
    caption: `장면 ${index + 1} 안내`,
    chapter: `장면 ${index + 1}`,
    highlights: [
      {
        callId: `step-${index + 1}.first-click`,
        sourceAtMs: index * 2_000 + 200,
        x: 100,
        y: 120,
        width: 300,
        height: 80,
      },
      {
        callId: `step-${index + 1}.second-click`,
        sourceAtMs: index * 2_000 + 1_100,
        x: 520,
        y: 360,
        width: 200,
        height: 60,
      },
    ],
  }));
  const mediaPlan = createMediaPlan({
    recordingPath: "composition/media/normalized.mp4",
    scenes,
    narrations: scenes.map((scene) => ({
      sceneId: scene.id,
      path: `composition/narration/${scene.id}.wav`,
      durationMs: 1_900,
      text: scene.caption,
    })),
  });
  const html = compileComposition({
    template: await readFile(templatePath, "utf8"),
    mediaPlan,
    projectPath: "composition",
  });
  const tracks = (className) => [...html.matchAll(
    new RegExp(`class="${className} clip"[^>]*data-track-index="(\\d+)"`, "gu"),
  )].map((match) => match[1]);

  assert.deepEqual(tracks("click-highlight"), ["20", "21", "22", "23", "24", "25", "26", "27", "28", "29"]);
  assert.deepEqual(tracks("chapter-card"), ["30", "31", "32", "33", "34"]);
  assert.deepEqual(tracks("caption"), ["35", "36", "37", "38", "39"]);
  const allOverlayTracks = [
    ...tracks("click-highlight"),
    ...tracks("chapter-card"),
    ...tracks("caption"),
  ];
  assert.equal(new Set(allOverlayTracks).size, allOverlayTracks.length);
});

test("schema 1.1 timed click cues are independently exact, dense, unique, sorted, and scene-bound", async () => {
  const template = await readFile(templatePath, "utf8");
  const compile = (mediaPlan) => compileComposition({ template, mediaPlan, projectPath: "composition" });
  assert.doesNotThrow(() => compile(manifest("클릭 없음", { highlights: [] })));

  const invalidPlans = [];
  const schema = structuredClone(manifest());
  schema.schemaVersion = "1.0";
  invalidPlans.push(schema);

  const extra = structuredClone(manifest());
  extra.scenes[0].highlights[0].extra = true;
  invalidPlans.push(extra);

  const sparse = structuredClone(manifest());
  sparse.scenes[0].highlights = new Array(1);
  invalidPlans.push(sparse);

  for (const [field, value] of [
    ["startMs", -1],
    ["startMs", 1.5],
    ["durationMs", 899],
    ["x", -1],
    ["x", 1.5],
    ["width", 0],
  ]) {
    const candidate = structuredClone(manifest());
    candidate.scenes[0].highlights[0][field] = value;
    invalidPlans.push(candidate);
  }

  const outside = structuredClone(manifest());
  outside.scenes[0].highlights[0].startMs = outside.scenes[0].output.endMs - 899;
  invalidPlans.push(outside);

  const bounds = structuredClone(manifest());
  bounds.scenes[0].highlights[0].x = 1_700;
  invalidPlans.push(bounds);

  const duplicate = structuredClone(manifest());
  duplicate.scenes[0].highlights.push({ ...duplicate.scenes[0].highlights[0] });
  invalidPlans.push(duplicate);

  const unsorted = structuredClone(manifest());
  unsorted.scenes[0].highlights = [
    { ...unsorted.scenes[0].highlights[0], callId: "step-1.later", startMs: 800 },
    { ...unsorted.scenes[0].highlights[0], callId: "step-1.earlier", startMs: 100 },
  ];
  invalidPlans.push(unsorted);

  const unsafeId = structuredClone(manifest());
  unsafeId.scenes[0].highlights[0].callId = '<img src=x onerror="alert(1)">';
  invalidPlans.push(unsafeId);

  for (const candidate of invalidPlans) {
    assert.throws(() => compile(candidate), { code: "INVALID_MEDIA_PLAN" });
  }
});

test("the fixed template renders full-frame finite 900 ms purple-blue target and ripple animations", async () => {
  const html = compileComposition({
    template: await readFile(templatePath, "utf8"),
    mediaPlan: manifest(),
    projectPath: "composition",
  });

  assert.match(html, /\.click-highlight\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*width:\s*1920px;[^}]*height:\s*1080px;/u);
  assert.match(html, /\.click-target\s*\{[^}]*var\(--target-x\)[^}]*var\(--target-y\)[^}]*var\(--target-width\)[^}]*var\(--target-height\)[^}]*#8f7cff/u);
  assert.match(html, /\.click-ripple\s*\{[^}]*var\(--click-x\)[^}]*var\(--click-y\)[^}]*900ms[^}]*1\s+both/u);
  assert.match(html, /animation-delay:\s*var\(--pulse-delay\)/u);
  assert.match(html, /\.click-ripple-primary/u);
  assert.match(html, /\.click-ripple-secondary/u);
  assert.match(html, /@keyframes click-target-pulse/u);
  assert.match(html, /@keyframes click-ripple-pulse/u);
  assert.doesNotMatch(html, /animation[^;]*\binfinite\b/iu);
});

test("fixed template applies the validated playback rate before HyperFrames discovers media", async () => {
  const html = compileComposition({
    template: await readFile(templatePath, "utf8"),
    mediaPlan: manifest(),
    projectPath: "composition",
  });

  assert.match(html, /querySelectorAll\("video\[data-playback-rate\]"\)/u);
  assert.match(html, /element\.defaultPlaybackRate = rate/u);
  assert.match(html, /element\.playbackRate = rate/u);
  assert.match(html, /rate < 0\.9 \|\| rate > 1\.1/u);
});

test("composition contains only finite deterministic timing and no runtime network or randomness", async () => {
  const html = compileComposition({
    template: await readFile(templatePath, "utf8"),
    mediaPlan: manifest(),
    projectPath: "composition",
  });

  for (const forbidden of [
    /\bfetch\s*\(/iu,
    /XMLHttpRequest/iu,
    /WebSocket/iu,
    /Math\.random/iu,
    /Date\.now/iu,
    /animation-iteration-count\s*:\s*infinite/iu,
    /animation\s*:[^;]*\binfinite\b/iu,
    /https?:\/\//iu,
  ]) {
    assert.doesNotMatch(html, forbidden);
  }
  const clips = [...html.matchAll(/class="[^"]*\bclip\b[^"]*"[^>]*data-start="([0-9.]+)"[^>]*data-duration="([0-9.]+)"/gu)];
  assert.equal(clips.length >= 4, true);
  for (const [, start, duration] of clips) {
    assert.equal(Number.isFinite(Number(start)), true);
    assert.equal(Number(duration) > 0, true);
  }
});

test("writing a composition is atomic and cannot escape or traverse a linked project directory", async (t) => {
  const jobRoot = await mkdtemp(join(tmpdir(), "manual-studio-composition-"));
  t.after(() => rm(jobRoot, { recursive: true, force: true }));
  const projectRoot = join(jobRoot, "composition");
  await mkdir(projectRoot);
  const outputPath = join(projectRoot, "index.html");

  const written = await writeComposition({
    jobRoot,
    templatePath,
    outputPath,
    mediaPlan: manifest(),
  });
  assert.equal(written.outputPath, outputPath);
  assert.equal(written.compositionId, compositionId(manifest()));
  assert.equal((await readFile(outputPath, "utf8")).includes("data-composition-id"), true);

  await assert.rejects(
    writeComposition({
      jobRoot,
      templatePath,
      outputPath: join(jobRoot, "..", "escape.html"),
      mediaPlan: manifest(),
    }),
    { code: "UNSAFE_COMPOSITION_PATH" },
  );

  const outside = await mkdtemp(join(tmpdir(), "manual-studio-composition-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const linked = join(jobRoot, "linked-project");
  try {
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
      return;
    }
    throw error;
  }
  await assert.rejects(
    writeComposition({
      jobRoot,
      templatePath,
      outputPath: join(linked, "index.html"),
      mediaPlan: manifest(),
    }),
    { code: "UNSAFE_COMPOSITION_PATH" },
  );
});

test("composition publication rejects an existing hard-linked final path", async (t) => {
  const jobRoot = await mkdtemp(join(tmpdir(), "manual-studio-composition-hardlink-"));
  const outside = await mkdtemp(join(tmpdir(), "manual-studio-composition-outside-"));
  t.after(() => rm(jobRoot, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const projectRoot = join(jobRoot, "composition");
  await mkdir(projectRoot);
  const outputPath = join(projectRoot, "index.html");
  const outsidePath = join(outside, "outside.html");
  await writeFile(outsidePath, "outside-original");
  await link(outsidePath, outputPath);

  await assert.rejects(
    writeComposition({
      jobRoot,
      templatePath,
      outputPath,
      mediaPlan: manifest(),
    }),
    { code: "UNSAFE_COMPOSITION_PATH" },
  );
  assert.equal(await readFile(outsidePath, "utf8"), "outside-original");
});

test("unapproved templates and unsafe project paths are rejected", async () => {
  const template = await readFile(templatePath, "utf8");
  assert.throws(
    () => compileComposition({
      template: template.replace("@@CLIPS@@", "@@CLIPS@@\n@@CLIPS@@"),
      mediaPlan: manifest(),
      projectPath: "composition",
    }),
    { code: "INVALID_COMPOSITION_TEMPLATE" },
  );
  for (const projectPath of ["../outside", "/absolute", "https://example.test/project", "bad\\path"] ) {
    assert.throws(
      () => compileComposition({ template, mediaPlan: manifest(), projectPath }),
      { code: "UNSAFE_COMPOSITION_PATH" },
    );
  }

  const outsideAssetPlan = createMediaPlan({
    recordingPath: "media/normalized.mp4",
    scenes: [
      {
        id: "step-1",
        sourceStartMs: 0,
        sourceEndMs: 1_000,
        caption: "설정을 엽니다.",
        chapter: "설정",
        highlights: [],
      },
    ],
    narrations: [
      {
        sceneId: "step-1",
        path: "narration/step-1.wav",
        durationMs: 1_000,
        text: "설정을 엽니다.",
      },
    ],
  });
  assert.throws(
    () => compileComposition({ template, mediaPlan: outsideAssetPlan, projectPath: "composition" }),
    { code: "UNSAFE_COMPOSITION_PATH" },
  );
});

test("non-JSON manifest fields fail closed with a public media-plan error", async () => {
  const hostile = structuredClone(manifest());
  hostile.captions[0][Symbol("hidden")] = "not-json";

  assert.throws(
    () => compositionId(hostile),
    { code: "INVALID_MEDIA_PLAN" },
  );
});
