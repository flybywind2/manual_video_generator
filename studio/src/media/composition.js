import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import path from "node:path/posix";

import { StudioError } from "../domain/errors.js";

const TEMPLATE_SLOTS = Object.freeze([
  "@@COMPOSITION_ID@@",
  "@@DURATION_SECONDS@@",
  "@@CLIPS@@",
]);
const PROJECT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SAFE_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const HIGHLIGHT_DURATION_MS = 900;
const MAX_CANONICAL_NODES = 20_000;

function compositionError(code, reason) {
  throw new StudioError("The HyperFrames composition is invalid.", {
    code,
    stage: "composing",
    retryable: false,
    details: { reason },
  });
}

function countOccurrences(text, marker) {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(marker, offset);
    if (found === -1) {
      return count;
    }
    count += 1;
    offset = found + marker.length;
  }
}

function validateTemplate(template) {
  if (
    typeof template !== "string" ||
    template.length < 1 ||
    template.length > 512 * 1_024 ||
    TEMPLATE_SLOTS.some((slot) => countOccurrences(template, slot) !== 1) ||
    /@@[A-Z_]+@@/u.test(
      TEMPLATE_SLOTS.reduce((source, slot) => source.replace(slot, ""), template),
    )
  ) {
    compositionError("INVALID_COMPOSITION_TEMPLATE", "template_slots");
  }
  return template;
}

function relativeProjectPath(value, reason) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("?") ||
    value.includes("#") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
  ) {
    compositionError("UNSAFE_COMPOSITION_PATH", reason);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        !PROJECT_SEGMENT.test(segment),
    )
  ) {
    compositionError("UNSAFE_COMPOSITION_PATH", reason);
  }
  return segments.join("/");
}

function assetPath(value, extension) {
  const safe = relativeProjectPath(value, "unsafe_asset_path");
  if (path.extname(safe).toLowerCase() !== extension) {
    compositionError("INVALID_MEDIA_PLAN", "unexpected_asset_extension");
  }
  return safe;
}

function exactObject(value, fields, reason) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    compositionError("INVALID_MEDIA_PLAN", reason);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    !keys.every((key) => typeof key === "string" && fields.includes(key))
  ) {
    compositionError("INVALID_MEDIA_PLAN", `${reason}_fields`);
  }
  const result = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      compositionError("INVALID_MEDIA_PLAN", `${reason}_data_property`);
    }
    result[field] = descriptor.value;
  }
  return result;
}

function denseArray(value, reason, { minimum = 1, maximum = 100 } = {}) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    compositionError("INVALID_MEDIA_PLAN", reason);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      compositionError("INVALID_MEDIA_PLAN", `${reason}_sparse`);
    }
  }
  return value;
}

function safeText(value, reason, maximum = 4_000) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    compositionError("INVALID_MEDIA_PLAN", reason);
  }
  return value;
}

function integer(value, reason, { minimum = 0, maximum = 86_400_000 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    compositionError("INVALID_MEDIA_PLAN", reason);
  }
  return value;
}

function canonicalValue(value, state = { nodes: 0 }) {
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES) {
    compositionError("INVALID_MEDIA_PLAN", "manifest_too_large");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      compositionError("INVALID_MEDIA_PLAN", "non_finite_number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      compositionError("INVALID_MEDIA_PLAN", "plain_array_required");
    }
    const array = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        compositionError("INVALID_MEDIA_PLAN", "dense_array_required");
      }
      array.push(canonicalValue(descriptor.value, state));
    }
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      compositionError("INVALID_MEDIA_PLAN", "array_fields");
    }
    return array;
  }
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    compositionError("INVALID_MEDIA_PLAN", "plain_object_required");
  }
  const result = {};
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        ["__proto__", "constructor", "prototype"].includes(key),
    )
  ) {
    compositionError("INVALID_MEDIA_PLAN", "unsafe_object_key");
  }
  for (const key of keys.sort()) {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      compositionError("INVALID_MEDIA_PLAN", "unsafe_object_key");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      compositionError("INVALID_MEDIA_PLAN", "data_properties_required");
    }
    result[key] = canonicalValue(descriptor.value, state);
  }
  return result;
}

export function validateCompositionMediaPlan(mediaPlan) {
  const root = exactObject(
    mediaPlan,
    ["schemaVersion", "video", "recordingPath", "scenes", "captions", "chapters"],
    "manifest",
  );
  if (root.schemaVersion !== "1.1") {
    compositionError("INVALID_MEDIA_PLAN", "schema_version");
  }
  const video = exactObject(root.video, ["width", "height", "fps", "durationMs"], "video");
  if (
    video.width !== 1_920 ||
    video.height !== 1_080 ||
    video.fps !== 30 ||
    !Number.isSafeInteger(video.durationMs) ||
    video.durationMs < 1 ||
    video.durationMs > 86_400_000
  ) {
    compositionError("INVALID_MEDIA_PLAN", "video_contract");
  }
  const recordingPath = assetPath(root.recordingPath, ".mp4");
  const sceneIds = new Set();
  const highlightCallIds = new Set();
  const scenes = denseArray(root.scenes, "scenes").map((candidate) => {
    const scene = exactObject(
      candidate,
      ["id", "source", "output", "narration", "caption", "chapter", "highlights", "driftMs"],
      "scene",
    );
    if (typeof scene.id !== "string" || !SAFE_ID.test(scene.id)) {
      compositionError("INVALID_MEDIA_PLAN", "scene_id");
    }
    if (sceneIds.has(scene.id)) {
      compositionError("INVALID_MEDIA_PLAN", "duplicate_scene_id");
    }
    sceneIds.add(scene.id);
    const source = exactObject(
      scene.source,
      ["startMs", "endMs", "durationMs", "playbackRate"],
      "source",
    );
    const output = exactObject(scene.output, ["startMs", "endMs", "durationMs"], "output");
    const narration = exactObject(
      scene.narration,
      ["path", "durationMs", "text"],
      "narration",
    );
    const caption = exactObject(scene.caption, ["text", "startMs", "endMs"], "caption");
    for (const [name, value] of [
      ["source_start", source.startMs],
      ["source_end", source.endMs],
      ["source_duration", source.durationMs],
      ["output_start", output.startMs],
      ["output_end", output.endMs],
      ["output_duration", output.durationMs],
      ["narration_duration", narration.durationMs],
      ["caption_start", caption.startMs],
      ["caption_end", caption.endMs],
      ["drift", scene.driftMs],
    ]) {
      integer(value, name);
    }
    if (
      source.endMs <= source.startMs ||
      source.endMs - source.startMs !== source.durationMs ||
      output.endMs <= output.startMs ||
      output.endMs - output.startMs !== output.durationMs ||
      caption.endMs <= caption.startMs ||
      caption.startMs !== output.startMs ||
      caption.endMs > output.endMs ||
      narration.durationMs !== caption.endMs - caption.startMs ||
      typeof source.playbackRate !== "number" ||
      !Number.isFinite(source.playbackRate) ||
      source.playbackRate < 0.9 ||
      source.playbackRate > 1.1
    ) {
      compositionError("INVALID_MEDIA_PLAN", "scene_timing");
    }
    const highlights = denseArray(scene.highlights, "highlights", {
      minimum: 0,
      maximum: 100,
    }).map((candidateHighlight, highlightIndex) => {
      const highlight = exactObject(
        candidateHighlight,
        ["callId", "startMs", "durationMs", "x", "y", "width", "height"],
        "highlight",
      );
      if (typeof highlight.callId !== "string" || !SAFE_CALL_ID.test(highlight.callId)) {
        compositionError("INVALID_MEDIA_PLAN", "highlight_call_id");
      }
      for (const [name, value, options] of [
        ["startMs", highlight.startMs, {}],
        ["durationMs", highlight.durationMs, {}],
        ["x", highlight.x, { maximum: 1_919 }],
        ["y", highlight.y, { maximum: 1_079 }],
        ["width", highlight.width, { minimum: 1, maximum: 1_920 }],
        ["height", highlight.height, { minimum: 1, maximum: 1_080 }],
      ]) {
        integer(value, `highlight_${name}`, options);
      }
      if (
        highlight.durationMs !== HIGHLIGHT_DURATION_MS ||
        highlight.startMs < output.startMs ||
        highlight.startMs + HIGHLIGHT_DURATION_MS > output.endMs
      ) {
        compositionError("INVALID_MEDIA_PLAN", "highlight_timing");
      }
      if (highlight.x + highlight.width > 1_920 || highlight.y + highlight.height > 1_080) {
        compositionError("INVALID_MEDIA_PLAN", "highlight_bounds");
      }
      if (highlightCallIds.has(highlight.callId)) {
        compositionError("INVALID_MEDIA_PLAN", "duplicate_highlight_call_id");
      }
      highlightCallIds.add(highlight.callId);
      if (highlightIndex > 0) {
        const previous = scene.highlights[highlightIndex - 1];
        if (
          previous.startMs > highlight.startMs ||
          (previous.startMs === highlight.startMs &&
            previous.callId.localeCompare(highlight.callId, "en") >= 0)
        ) {
          compositionError("INVALID_MEDIA_PLAN", "highlight_order");
        }
      }
      return highlight;
    });
    return {
      id: scene.id,
      source,
      output,
      narration: {
        path: assetPath(narration.path, ".wav"),
        durationMs: narration.durationMs,
        text: safeText(narration.text, "narration_text"),
      },
      caption: {
        text: safeText(caption.text, "caption_text"),
        startMs: caption.startMs,
        endMs: caption.endMs,
      },
      chapter: safeText(scene.chapter, "chapter", 200),
      highlights,
      driftMs: scene.driftMs,
    };
  });
  if (
    scenes[0].output.startMs !== 0 ||
    scenes.at(-1).output.endMs !== video.durationMs ||
    scenes.some(
      (scene, index) => index > 0 && scene.output.startMs !== scenes[index - 1].output.endMs,
    )
  ) {
    compositionError("INVALID_MEDIA_PLAN", "output_timeline");
  }
  denseArray(root.captions, "captions");
  denseArray(root.chapters, "chapters");
  canonicalValue(root.captions);
  canonicalValue(root.chapters);
  return { original: mediaPlan, video, recordingPath, scenes };
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replace(/\r\n?|\n/gu, "&#10;");
}

function seconds(milliseconds) {
  return (milliseconds / 1_000).toFixed(3);
}

function playbackRate(value) {
  return value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

function projectAssetUrl(projectPath, targetPath) {
  const fromProject = path.relative(projectPath, targetPath);
  if (
    fromProject === "" ||
    fromProject === ".." ||
    fromProject.startsWith("../") ||
    path.isAbsolute(fromProject)
  ) {
    compositionError("UNSAFE_COMPOSITION_PATH", "asset_relative_path");
  }
  return fromProject
    .split("/")
    .map((segment) => (segment === ".." ? segment : encodeURIComponent(segment)))
    .join("/");
}

function highlightClip(sceneId, highlight, highlightIndex, trackIndex) {
  const targetLeft = Math.max(0, highlight.x - 12);
  const targetTop = Math.max(0, highlight.y - 12);
  const targetRight = Math.min(1_920, highlight.x + highlight.width + 12);
  const targetBottom = Math.min(1_080, highlight.y + highlight.height + 12);
  const clickX = highlight.x + highlight.width / 2;
  const clickY = highlight.y + highlight.height / 2;
  const style = [
    `--target-x:${targetLeft}px`,
    `--target-y:${targetTop}px`,
    `--target-width:${targetRight - targetLeft}px`,
    `--target-height:${targetBottom - targetTop}px`,
    `--click-x:${clickX}px`,
    `--click-y:${clickY}px`,
    `--pulse-delay:${seconds(highlight.startMs)}s`,
  ].join(";");
  return `<div id="highlight-${sceneId}-${highlightIndex}" class="click-highlight clip" data-start="${seconds(highlight.startMs)}" data-duration="0.9" data-track-index="${trackIndex}" style="${style}"><span class="click-target"></span><span class="click-ripple click-ripple-primary"></span><span class="click-ripple click-ripple-secondary"></span></div>`;
}

function sceneClips(
  scene,
  recordingUrl,
  narrationUrl,
  sceneIndex,
  { highlightTrackStart, chapterTrackStart, captionTrackStart },
) {
  const outputStart = seconds(scene.output.startMs);
  const outputDuration = seconds(scene.output.durationMs);
  const narrationStart = seconds(scene.caption.startMs);
  const narrationDuration = seconds(scene.narration.durationMs);
  const chapterDuration = seconds(Math.min(1_200, scene.output.durationMs));
  const lines = [
    `      <video id="video-${scene.id}" class="browser-video clip" src="${recordingUrl}" playsinline preload="auto" muted data-start="${outputStart}" data-duration="${outputDuration}" data-media-start="${seconds(scene.source.startMs)}" data-playback-rate="${playbackRate(scene.source.playbackRate)}" data-volume="0" data-track-index="0"></video>`,
    `      <audio id="narration-${scene.id}" class="narration-audio clip" src="${narrationUrl}" preload="auto" data-start="${narrationStart}" data-duration="${narrationDuration}" data-volume="1" data-track-index="10"></audio>`,
  ];
  for (const [highlightIndex, highlight] of scene.highlights.entries()) {
    lines.push(
      highlightClip(
        scene.id,
        highlight,
        highlightIndex,
        highlightTrackStart + highlightIndex,
      ),
    );
  }
  lines.push(
    `      <div id="chapter-${scene.id}" class="chapter-card clip" data-start="${outputStart}" data-duration="${chapterDuration}" data-track-index="${chapterTrackStart + sceneIndex}">${escapeHtml(scene.chapter)}</div>`,
    `      <div id="caption-${scene.id}" class="caption clip" data-start="${narrationStart}" data-duration="${narrationDuration}" data-track-index="${captionTrackStart + sceneIndex}">${escapeHtml(scene.caption.text)}</div>`,
  );
  return lines.join("");
}

export function mediaPlanDigest(mediaPlan) {
  validateCompositionMediaPlan(mediaPlan);
  const canonical = JSON.stringify(canonicalValue(mediaPlan));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function compositionId(mediaPlan) {
  return `manual-${mediaPlanDigest(mediaPlan).slice(0, 24)}`;
}

export function compileComposition({ template, mediaPlan, projectPath }) {
  const approvedTemplate = validateTemplate(template);
  const project = relativeProjectPath(projectPath, "unsafe_project_path");
  const manifest = validateCompositionMediaPlan(mediaPlan);
  const recordingUrl = projectAssetUrl(project, manifest.recordingPath);
  const highlightCount = manifest.scenes.reduce(
    (count, scene) => count + scene.highlights.length,
    0,
  );
  const chapterTrackStart = 20 + highlightCount;
  const captionTrackStart = chapterTrackStart + manifest.scenes.length;
  let highlightTrackStart = 20;
  const clips = manifest.scenes
    .map((scene, sceneIndex) => {
      const sceneHtml = sceneClips(
        scene,
        recordingUrl,
        projectAssetUrl(project, scene.narration.path),
        sceneIndex,
        { highlightTrackStart, chapterTrackStart, captionTrackStart },
      );
      highlightTrackStart += scene.highlights.length;
      return sceneHtml;
    })
    .join("\n");

  return approvedTemplate
    .replace("@@COMPOSITION_ID@@", compositionId(mediaPlan))
    .replace("@@DURATION_SECONDS@@", seconds(manifest.video.durationMs))
    .replace("@@CLIPS@@", clips);
}

function strictChild(root, candidate) {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(fromRoot)
  );
}

async function safeOutput(jobRoot, outputPath) {
  if (
    typeof jobRoot !== "string" ||
    typeof outputPath !== "string" ||
    !isAbsolute(jobRoot) ||
    !isAbsolute(outputPath) ||
    jobRoot.includes("\0") ||
    outputPath.includes("\0") ||
    !strictChild(jobRoot, outputPath)
  ) {
    compositionError("UNSAFE_COMPOSITION_PATH", "job_root_escape");
  }
  const rootEntry = await lstat(jobRoot).catch(() => null);
  if (!rootEntry?.isDirectory() || rootEntry.isSymbolicLink()) {
    compositionError("UNSAFE_COMPOSITION_PATH", "unsafe_job_root");
  }
  const [realRoot, parentEntry] = await Promise.all([
    realpath(jobRoot),
    lstat(dirname(outputPath)).catch(() => null),
  ]);
  if (!parentEntry?.isDirectory() || parentEntry.isSymbolicLink()) {
    compositionError("UNSAFE_COMPOSITION_PATH", "unsafe_output_parent");
  }
  const realParent = await realpath(dirname(outputPath));
  if (!strictChild(realRoot, realParent) && resolve(realParent) !== resolve(realRoot)) {
    compositionError("UNSAFE_COMPOSITION_PATH", "output_realpath_escape");
  }
  try {
    const outputEntry = await lstat(outputPath);
    if (
      !outputEntry.isFile() ||
      outputEntry.isSymbolicLink() ||
      outputEntry.nlink !== 1
    ) {
      compositionError("UNSAFE_COMPOSITION_PATH", "unsafe_output_entry");
    }
  } catch (error) {
    if (error instanceof StudioError) {
      throw error;
    }
    if (error?.code !== "ENOENT") {
      compositionError("UNSAFE_COMPOSITION_PATH", "output_inspection_failed");
    }
  }
  return {
    realRoot,
    output: resolve(outputPath),
    parent: dirname(resolve(outputPath)),
    parentEntry,
    realParent,
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

async function verifyCompositionDirectory(pathValue, expected, realRoot) {
  const entry = await lstat(pathValue).catch(() => null);
  if (
    !entry?.isDirectory() ||
    entry.isSymbolicLink() ||
    !sameIdentity(entry, expected)
  ) {
    compositionError("UNSAFE_COMPOSITION_PATH", "directory_identity_changed");
  }
  const canonical = await realpath(pathValue);
  if (!strictChild(realRoot, canonical) && !samePath(realRoot, canonical)) {
    compositionError("UNSAFE_COMPOSITION_PATH", "directory_realpath_escape");
  }
  return entry;
}

async function verifyCompositionTarget(target) {
  await verifyCompositionDirectory(
    target.parent,
    target.parentEntry,
    target.realRoot,
  );
  if (!samePath(await realpath(target.parent), target.realParent)) {
    compositionError("UNSAFE_COMPOSITION_PATH", "output_parent_changed");
  }
  let entry;
  try {
    entry = await lstat(target.output);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (
    entry !== undefined &&
    (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
  ) {
    compositionError("UNSAFE_COMPOSITION_PATH", "unsafe_output_entry");
  }
}

async function createCompositionStaging(realRoot, outputName) {
  const directory = join(realRoot, `.composition-stage-${randomUUID()}`);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const entry = await lstat(directory);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    !strictChild(realRoot, await realpath(directory))
  ) {
    compositionError("UNSAFE_COMPOSITION_PATH", "unsafe_staging_directory");
  }
  return {
    directory,
    entry,
    output: join(directory, outputName),
  };
}

async function cleanupCompositionStaging(staging) {
  const entry = await lstat(staging.directory).catch(() => null);
  if (
    !entry?.isDirectory() ||
    entry.isSymbolicLink() ||
    !sameIdentity(entry, staging.entry)
  ) {
    return;
  }
  await rm(staging.output, { force: true }).catch(() => undefined);
  await rmdir(staging.directory).catch(() => undefined);
}

export async function writeComposition({ jobRoot, templatePath, outputPath, mediaPlan }) {
  if (typeof templatePath !== "string" || !isAbsolute(templatePath) || templatePath.includes("\0")) {
    compositionError("INVALID_COMPOSITION_TEMPLATE", "template_path");
  }
  const templateEntry = await lstat(templatePath).catch(() => null);
  if (!templateEntry?.isFile() || templateEntry.isSymbolicLink()) {
    compositionError("INVALID_COMPOSITION_TEMPLATE", "template_entry");
  }
  const [target, template] = await Promise.all([
    safeOutput(jobRoot, outputPath),
    readFile(templatePath, "utf8"),
  ]);
  const projectPath = relative(target.realRoot, target.parent).split("\\").join("/");
  const html = compileComposition({ template, mediaPlan, projectPath });
  const staging = await createCompositionStaging(
    target.realRoot,
    basename(target.output),
  );
  let handle;
  try {
    handle = await open(staging.output, "wx", 0o600);
    await handle.writeFile(html, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await verifyCompositionDirectory(
      staging.directory,
      staging.entry,
      target.realRoot,
    );
    const stagedEntry = await lstat(staging.output);
    if (
      !stagedEntry.isFile() ||
      stagedEntry.isSymbolicLink() ||
      stagedEntry.nlink !== 1
    ) {
      compositionError("UNSAFE_COMPOSITION_PATH", "unsafe_staged_output");
    }
    await verifyCompositionTarget(target);
    await rename(staging.output, target.output);
    await verifyCompositionTarget(target);
    const published = await lstat(target.output);
    if (
      !published.isFile() ||
      published.isSymbolicLink() ||
      published.nlink !== 1 ||
      !sameIdentity(published, stagedEntry) ||
      !strictChild(target.realRoot, await realpath(target.output))
    ) {
      compositionError("UNSAFE_COMPOSITION_PATH", "unsafe_published_output");
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof StudioError) {
      throw error;
    }
    throw new StudioError("The HyperFrames composition could not be written.", {
      code: "COMPOSITION_WRITE_FAILED",
      stage: "composing",
      retryable: true,
      details: { reason: "atomic_write_failed" },
    });
  } finally {
    await cleanupCompositionStaging(staging);
  }
  return Object.freeze({
    compositionId: compositionId(mediaPlan),
    outputPath: target.output,
    bytes: Buffer.byteLength(html),
  });
}
