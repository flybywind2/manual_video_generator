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

function manifest(caption = "프로젝트 <메뉴> & 설정을 선택합니다.") {
  return createMediaPlan({
    recordingPath: "composition/media/normalized.mp4",
    scenes: [
      {
        id: "step-1",
        sourceStartMs: 1_000,
        sourceEndMs: 3_000,
        caption,
        chapter: "프로젝트 & 설정",
        highlight: { x: 120, y: 160, width: 320, height: 72 },
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
  assert.match(html, /class="action-highlight clip"/u);
  assert.doesNotMatch(html, /(?:src|href)="\.\.\//u);
});

test("multi-scene overlays use distinct tracks so strict HyperFrames lint stays warning-free", async () => {
  const scenes = Array.from({ length: 5 }, (_, index) => ({
    id: `step-${index + 1}`,
    sourceStartMs: index * 2_000,
    sourceEndMs: (index + 1) * 2_000,
    caption: `장면 ${index + 1} 안내`,
    chapter: `장면 ${index + 1}`,
    highlight: { x: 100, y: 120, width: 300, height: 80 },
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

  assert.deepEqual(tracks("action-highlight"), ["20", "21", "22", "23", "24"]);
  assert.deepEqual(tracks("chapter-card"), ["40", "41", "42", "43", "44"]);
  assert.deepEqual(tracks("caption"), ["60", "61", "62", "63", "64"]);
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
        highlight: null,
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
