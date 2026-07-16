import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { SupertonicClient } from "../adapters/supertonic-client.js";
import { StudioError } from "../domain/errors.js";
import { compileExecutionCalls } from "../domain/execution-calls.js";
import { MAX_STEP_NARRATION_CODE_UNITS } from "../domain/plan.js";
import { mediaPlanDigest as defaultMediaPlanDigest, writeComposition as defaultWriteComposition } from "./composition.js";
import {
  CLICK_HIGHLIGHT_DURATION_MS,
  createMediaPlan as defaultCreateMediaPlan,
  MAX_MEDIA_DRIFT_MS,
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
} from "./media-plan.js";
import { generateNarration as defaultGenerateNarration } from "../workflow/narration.js";
import { restoreLatestPlan as defaultRestoreLatestPlan } from "../workflow/planning.js";

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const PREVIEW_INTEGRITY_FILE = "preview-integrity.json";
const SOURCE_HIGHLIGHTS_FILE = "source-highlights.json";
const CLICK_HIGHLIGHT_PRE_ROLL_MS = 250;
const REPORT_HIGHLIGHT_FIELDS = Object.freeze([
  "stepId",
  "callId",
  "at",
  "x",
  "y",
  "width",
  "height",
]);
const PREVIEW_FILES = Object.freeze([
  "captions.vtt",
  "media-plan.json",
  PREVIEW_INTEGRITY_FILE,
  "preview.json",
  "preview.mp4",
  SOURCE_HIGHLIGHTS_FILE,
]);

function producerError(code, message, reason, retryable = false) {
  return new StudioError(message, {
    code,
    stage: "production",
    retryable,
    details: reason === undefined ? {} : { reason },
  });
}

function invalidPath(reason) {
  return producerError(
    "UNSAFE_MEDIA_PATH",
    "A media production path is unsafe.",
    reason,
  );
}

function validJobId(value) {
  if (typeof value !== "string" || !JOB_ID.test(value)) {
    throw producerError(
      "PRODUCER_JOB_INVALID",
      "The media job identifier is invalid.",
      "invalid_job_id",
    );
  }
  return value;
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
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

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function equalDigest(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    DIGEST.test(left) &&
    DIGEST.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function safeRelative(value, { prefix, extension } = {}) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1_024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
  ) {
    throw invalidPath("invalid_relative_path");
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => !SAFE_SEGMENT.test(segment)) ||
    (prefix !== undefined && segments[0] !== prefix) ||
    (extension !== undefined && extname(value).toLowerCase() !== extension)
  ) {
    throw invalidPath("invalid_relative_path");
  }
  return segments;
}

async function safeRoot(pathValue, reason) {
  if (typeof pathValue !== "string" || !isAbsolute(pathValue) || pathValue.includes("\0")) {
    throw invalidPath(reason);
  }
  const path = resolve(pathValue);
  const entry = await lstat(path).catch(() => null);
  if (!entry?.isDirectory() || entry.isSymbolicLink()) {
    throw invalidPath(reason);
  }
  return Object.freeze({ path: await realpath(path), entry });
}

async function safeDirectory(root, pathValue, { create = false } = {}) {
  const rootPath = resolve(root);
  const target = resolve(pathValue);
  if ((!strictChild(rootPath, target) && !samePath(rootPath, target)) || target.includes("\0")) {
    throw invalidPath("directory_escape");
  }
  const fromRoot = relative(rootPath, target);
  const segments = fromRoot === "" ? [] : fromRoot.split(/[\\/]/u);
  let current = rootPath;
  for (const segment of segments) {
    if (!SAFE_SEGMENT.test(segment)) throw invalidPath("unsafe_directory_segment");
    const parentEntry = await lstat(current).catch(() => null);
    if (!parentEntry?.isDirectory() || parentEntry.isSymbolicLink()) {
      throw invalidPath("unsafe_directory_parent");
    }
    const next = join(current, segment);
    let entry = await lstat(next).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (entry === null && create) {
      await mkdir(next, { recursive: false, mode: 0o700 }).catch(async (error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      entry = await lstat(next).catch(() => null);
    }
    if (!entry?.isDirectory() || entry.isSymbolicLink()) {
      throw invalidPath("unsafe_directory_entry");
    }
    const parentAfter = await lstat(current).catch(() => null);
    if (!parentAfter || !sameIdentity(parentEntry, parentAfter)) {
      throw invalidPath("directory_parent_changed");
    }
    const canonical = await realpath(next);
    if (!strictChild(rootPath, canonical)) {
      throw invalidPath("directory_realpath_escape");
    }
    current = canonical;
  }
  const entry = await lstat(current);
  return Object.freeze({ path: current, entry });
}

async function jobPaths(jobsRoot, jobIdInput) {
  const jobId = validJobId(jobIdInput);
  const jobs = await safeRoot(jobsRoot, "unsafe_jobs_root");
  const jobPath = resolve(jobs.path, jobId);
  if (!strictChild(jobs.path, jobPath)) throw invalidPath("job_root_escape");
  const job = await safeDirectory(jobs.path, jobPath);
  return Object.freeze({ jobId, jobsRoot: jobs.path, jobRoot: job.path });
}

async function inspectRegular(root, pathValue, { minimumBytes = 0 } = {}) {
  const rootPath = resolve(root);
  const target = resolve(pathValue);
  if (!strictChild(rootPath, target)) throw invalidPath("file_escape");
  await safeDirectory(rootPath, dirname(target));
  const first = await lstat(target).catch(() => null);
  if (
    !first?.isFile() ||
    first.isSymbolicLink() ||
    first.nlink !== 1 ||
    first.size < minimumBytes
  ) {
    throw invalidPath("unsafe_regular_file");
  }
  const handle = await open(target, "r").catch(() => null);
  if (handle === null) throw invalidPath("file_open_failed");
  try {
    const opened = await handle.stat();
    const final = await lstat(target).catch(() => null);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !final ||
      !sameIdentity(first, opened) ||
      !sameIdentity(opened, final) ||
      !strictChild(rootPath, await realpath(target))
    ) {
      throw invalidPath("file_identity_changed");
    }
    return Object.freeze({ path: target, entry: opened, handle });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function requireRegular(root, pathValue, options) {
  const inspected = await inspectRegular(root, pathValue, options);
  await inspected.handle.close();
  return Object.freeze({ path: inspected.path, entry: inspected.entry });
}

function sameBigIntSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === 1n &&
    right.nlink === 1n
  );
}

async function fingerprintRegular(root, pathValue, logicalPath) {
  const inspected = await inspectRegular(root, pathValue, { minimumBytes: 1 });
  try {
    const before = await inspected.handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw invalidPath("unsafe_integrity_input");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1_024);
    const size = Number(before.size);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await inspected.handle.read(
        buffer,
        0,
        Math.min(buffer.length, size - position),
        position,
      );
      if (bytesRead < 1) throw invalidPath("integrity_input_truncated");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const [after, named] = await Promise.all([
      inspected.handle.stat({ bigint: true }),
      lstat(inspected.path, { bigint: true }).catch(() => null),
    ]);
    if (
      named === null ||
      !sameBigIntSnapshot(before, after) ||
      !sameBigIntSnapshot(after, named) ||
      !strictChild(root, await realpath(inspected.path))
    ) {
      throw invalidPath("integrity_input_changed");
    }
    return Object.freeze({
      path: logicalPath,
      sha256: hash.digest("hex"),
      bytes: size,
    });
  } finally {
    await inspected.handle.close().catch(() => undefined);
  }
}

async function atomicWrite(root, targetPath, bytes) {
  const target = resolve(targetPath);
  const parent = await safeDirectory(root, dirname(target));
  const parentEntry = parent.entry;
  let existing = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (
    existing !== null &&
    (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
  ) {
    throw invalidPath("unsafe_publish_target");
  }
  const temporary = join(parent.path, `.${basename(target)}.${randomUUID()}.tmp`);
  let handle;
  let published = false;
  let fingerprint;
  try {
    handle = await open(temporary, "wx+", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const staged = await handle.stat({ bigint: true });
    if (
      !staged.isFile() ||
      staged.nlink !== 1n ||
      staged.size !== BigInt(bytes.length)
    ) {
      throw invalidPath("unsafe_staged_file");
    }
    const parentAfter = await lstat(parent.path).catch(() => null);
    if (
      !parentAfter?.isDirectory() ||
      parentAfter.isSymbolicLink() ||
      !sameIdentity(parentEntry, parentAfter) ||
      !samePath(parent.path, await realpath(parent.path))
    ) {
      throw invalidPath("publish_parent_changed");
    }
    existing = await lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (
      existing !== null &&
      (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
    ) {
      throw invalidPath("publish_target_changed");
    }
    await rename(temporary, target);
    const before = await handle.stat({ bigint: true });
    const namedBefore = await lstat(target, { bigint: true }).catch(() => null);
    if (
      namedBefore === null ||
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size !== BigInt(bytes.length) ||
      !sameBigIntSnapshot(before, namedBefore) ||
      !strictChild(root, await realpath(target))
    ) {
      throw invalidPath("unsafe_published_file");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1_024);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, bytes.length - position),
        position,
      );
      if (bytesRead < 1) throw invalidPath("published_file_truncated");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const [after, namedAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(target, { bigint: true }).catch(() => null),
    ]);
    const sha256 = hash.digest("hex");
    if (
      namedAfter === null ||
      !sameBigIntSnapshot(before, after) ||
      !sameBigIntSnapshot(after, namedAfter) ||
      !strictChild(root, await realpath(target)) ||
      !equalDigest(sha256, createHash("sha256").update(bytes).digest("hex"))
    ) {
      throw invalidPath("published_file_changed");
    }
    fingerprint = Object.freeze({ sha256, bytes: bytes.length });
    published = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published) await rm(temporary, { force: true }).catch(() => undefined);
  }
  return fingerprint;
}

function jsonBytes(value) {
  let source;
  try {
    source = `${JSON.stringify(value)}\n`;
  } catch {
    throw producerError(
      "PRODUCER_DATA_INVALID",
      "Media production metadata is invalid.",
      "json_serialization_failed",
    );
  }
  const bytes = Buffer.from(source, "utf8");
  if (bytes.length > MAX_JSON_BYTES) {
    throw producerError(
      "PRODUCER_DATA_INVALID",
      "Media production metadata is invalid.",
      "json_too_large",
    );
  }
  return bytes;
}

async function atomicJson(root, target, value) {
  await atomicWrite(root, target, jsonBytes(value));
}

async function atomicJsonFingerprint(root, target, value, logicalPath) {
  const fingerprint = await atomicWrite(root, target, jsonBytes(value));
  return Object.freeze({ path: logicalPath, ...fingerprint });
}

async function readJson(root, target) {
  const file = await inspectRegular(root, target, { minimumBytes: 2 });
  try {
    if (file.entry.size > MAX_JSON_BYTES) {
      throw producerError(
        "PRODUCER_DATA_INVALID",
        "Media production metadata is invalid.",
        "json_too_large",
      );
    }
    const source = await file.handle.readFile({ encoding: "utf8" });
    const final = await lstat(file.path).catch(() => null);
    if (!final || !sameIdentity(file.entry, final)) throw invalidPath("metadata_changed");
    const value = JSON.parse(source);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("record required");
    }
    return value;
  } catch (error) {
    if (error instanceof StudioError) throw error;
    throw producerError(
      "PRODUCER_DATA_INVALID",
      "Media production metadata is invalid.",
      "invalid_json",
    );
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

async function readJsonFingerprint(root, target, logicalPath) {
  const file = await inspectRegular(root, target, { minimumBytes: 2 });
  try {
    const before = await file.handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 2n ||
      before.size > BigInt(MAX_JSON_BYTES)
    ) {
      throw producerError(
        "PRODUCER_DATA_INVALID",
        "Media production metadata is invalid.",
        "json_too_large",
      );
    }
    const bytes = await file.handle.readFile();
    const [after, named] = await Promise.all([
      file.handle.stat({ bigint: true }),
      lstat(file.path, { bigint: true }).catch(() => null),
    ]);
    if (
      named === null ||
      bytes.length !== Number(before.size) ||
      !sameBigIntSnapshot(before, after) ||
      !sameBigIntSnapshot(after, named) ||
      !strictChild(root, await realpath(file.path))
    ) {
      throw invalidPath("metadata_changed");
    }
    const value = JSON.parse(bytes.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("record required");
    }
    return Object.freeze({
      value,
      fingerprint: Object.freeze({
        path: logicalPath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      }),
    });
  } catch (error) {
    if (error instanceof StudioError) throw error;
    throw producerError(
      "PRODUCER_DATA_INVALID",
      "Media production metadata is invalid.",
      "invalid_json",
    );
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

function safeTimestamp(value, reason) {
  if (typeof value !== "string") {
    throw producerError("PRODUCER_REPORT_INVALID", "The browser report is invalid.", reason);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw producerError("PRODUCER_REPORT_INVALID", "The browser report is invalid.", reason);
  }
  return date.getTime();
}

function invalidHighlight(reason) {
  throw producerError(
    "PRODUCER_HIGHLIGHT_INVALID",
    "The trusted click highlight metadata is invalid.",
    reason,
  );
}

function exactHighlightRecord(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    invalidHighlight("highlight_record");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== REPORT_HIGHLIGHT_FIELDS.length ||
    !keys.every((key) => typeof key === "string" && REPORT_HIGHLIGHT_FIELDS.includes(key))
  ) {
    invalidHighlight("highlight_fields");
  }
  const fields = Object.create(null);
  for (const field of REPORT_HIGHLIGHT_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      invalidHighlight("highlight_properties");
    }
    fields[field] = descriptor.value;
  }
  return fields;
}

function trustedReportHighlights(report, plan, reportStart, reportEnd) {
  try {
    const approvedClicks = plan.steps.flatMap((step) => step.calls
      .filter(({ tool }) => tool === "browser_click")
      .map((call) => Object.freeze({ stepId: step.id, callId: call.id })));
    const descriptor = Object.getOwnPropertyDescriptor(report, "clickHighlights");
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      invalidHighlight("highlights_missing");
    }
    const source = descriptor.value;
    if (
      !Array.isArray(source) ||
      Object.getPrototypeOf(source) !== Array.prototype ||
      source.length !== approvedClicks.length ||
      Reflect.ownKeys(source).length !== source.length + 1
    ) {
      invalidHighlight("highlight_count");
    }
    const stepRanges = new Map(report.steps.map((step) => [
      step.id,
      Object.freeze({
        startMs: safeTimestamp(step.startedAt, "step_start"),
        endMs: safeTimestamp(step.endedAt, "step_end"),
      }),
    ]));
    const normalized = [];
    for (let index = 0; index < source.length; index += 1) {
      const itemDescriptor = Object.getOwnPropertyDescriptor(source, String(index));
      if (!itemDescriptor || !("value" in itemDescriptor) || itemDescriptor.enumerable !== true) {
        invalidHighlight("highlights_sparse");
      }
      const fields = exactHighlightRecord(itemDescriptor.value);
      const approved = approvedClicks[index];
      if (fields.stepId !== approved.stepId || fields.callId !== approved.callId) {
        invalidHighlight("highlight_binding");
      }
      if (typeof fields.at !== "string") invalidHighlight("highlight_time");
      const atMs = Date.parse(fields.at);
      if (!Number.isFinite(atMs) || new Date(atMs).toISOString() !== fields.at) {
        invalidHighlight("highlight_time");
      }
      const stepRange = stepRanges.get(fields.stepId);
      if (
        !stepRange ||
        atMs < reportStart ||
        atMs > reportEnd ||
        atMs < stepRange.startMs ||
        atMs > stepRange.endMs
      ) {
        invalidHighlight("highlight_time_range");
      }
      if (
        ![fields.x, fields.y, fields.width, fields.height].every(Number.isSafeInteger) ||
        fields.x < 0 ||
        fields.y < 0 ||
        fields.width < 1 ||
        fields.height < 1 ||
        !Number.isSafeInteger(fields.x + fields.width) ||
        !Number.isSafeInteger(fields.y + fields.height) ||
        fields.x + fields.width > plan.captureSettings.width ||
        fields.y + fields.height > plan.captureSettings.height
      ) {
        invalidHighlight("highlight_bounds");
      }
      normalized.push(Object.freeze({
        stepId: fields.stepId,
        callId: fields.callId,
        sourceAtMs: atMs - reportStart,
        x: fields.x,
        y: fields.y,
        width: fields.width,
        height: fields.height,
      }));
    }
    return Object.freeze(normalized);
  } catch (error) {
    if (error?.code === "PRODUCER_HIGHLIGHT_INVALID") throw error;
    invalidHighlight("highlight_contract");
  }
}

function reportBinding(report, plan, planDigest) {
  if (
    report === null ||
    typeof report !== "object" ||
    report.status !== "completed" ||
    !equalDigest(report.planDigest, planDigest) ||
    !Array.isArray(report.steps) ||
    report.steps.length !== plan.steps.length
  ) {
    throw producerError(
      "PRODUCER_REPORT_INVALID",
      "The browser report is not bound to the approved plan.",
      "report_binding",
    );
  }
  const reportStart = safeTimestamp(report.startedAt, "report_start");
  const reportEnd = safeTimestamp(report.endedAt, "report_end");
  if (reportEnd < reportStart) {
    throw producerError("PRODUCER_REPORT_INVALID", "The browser report is invalid.", "report_range");
  }
  safeRelative(report.recordingPath, { prefix: "browser", extension: ".webm" });
  let narrationDwell = Object.freeze(plan.steps.map(() => false));
  if (report.toolCalls !== undefined) {
    const expectedCalls = compileExecutionCalls(plan);
    if (
      !Array.isArray(report.toolCalls) ||
      report.toolCalls.length !== expectedCalls.length ||
      report.toolCalls.some(
        (call, index) =>
          call?.id !== expectedCalls[index].id ||
          call?.tool !== expectedCalls[index].tool,
      )
    ) {
      throw producerError(
        "PRODUCER_REPORT_INVALID",
        "The browser report is invalid.",
        "tool_call_binding",
      );
    }
    narrationDwell = Object.freeze(
      plan.steps.map((step) =>
        expectedCalls.some(
          (call) =>
            call.id === `${step.id}.narration-dwell` &&
            call.tool === "browser_wait_for",
        )),
    );
  }
  const scenes = report.steps.map((step, index) => {
    const approved = plan.steps[index];
    const startedAt = safeTimestamp(step?.startedAt, "step_start");
    const endedAt = safeTimestamp(step?.endedAt, "step_end");
    if (
      step?.id !== approved.id ||
      startedAt < reportStart ||
      endedAt > reportEnd ||
      endedAt <= startedAt ||
      (index > 0 && startedAt < safeTimestamp(report.steps[index - 1].endedAt, "step_order"))
    ) {
      throw producerError(
        "PRODUCER_REPORT_INVALID",
        "The browser report is invalid.",
        "step_binding",
      );
    }
    return Object.freeze({
      id: approved.id,
      sourceStartMs: startedAt - reportStart,
      sourceEndMs: endedAt - reportStart,
      caption: approved.narration,
      chapter: approved.action,
    });
  });
  const highlights = trustedReportHighlights(report, plan, reportStart, reportEnd);
  const byStep = new Map(plan.steps.map(({ id }) => [id, []]));
  for (const highlight of highlights) {
    byStep.get(highlight.stepId).push(Object.freeze({
      callId: highlight.callId,
      sourceAtMs: highlight.sourceAtMs,
      x: highlight.x,
      y: highlight.y,
      width: highlight.width,
      height: highlight.height,
    }));
  }
  const boundScenes = scenes.map((scene) => Object.freeze({
    ...scene,
    highlights: Object.freeze(byStep.get(scene.id).sort(
      (left, right) =>
        left.sourceAtMs - right.sourceAtMs || left.callId.localeCompare(right.callId, "en"),
    )),
  }));
  return Object.freeze({
    reportStart,
    reportEnd,
    recordingPath: report.recordingPath,
    narrationDwell,
    scenes: Object.freeze(boundScenes),
  });
}

function validateNarration(manifest, plan, voice) {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    manifest.schemaVersion !== "1.0" ||
    manifest.status !== "ready" ||
    manifest.lang !== "ko" ||
    manifest.voice !== voice ||
    !Array.isArray(manifest.scenes) ||
    manifest.scenes.length !== plan.steps.length
  ) {
    throw producerError(
      "PRODUCER_NARRATION_INVALID",
      "The narration output is invalid.",
      "manifest_contract",
    );
  }
  return Object.freeze(manifest.scenes.map((scene, index) => {
    const step = plan.steps[index];
    if (
      scene?.sceneId !== step.id ||
      scene.order !== index + 1 ||
      scene.status !== "ready" ||
      typeof scene.file !== "string" ||
      basename(scene.file) !== scene.file ||
      extname(scene.file).toLowerCase() !== ".wav" ||
      scene.text !== step.narration ||
      !Number.isFinite(scene.durationSeconds) ||
      scene.durationSeconds <= 0 ||
      scene.durationSeconds > 3_600
    ) {
      throw producerError(
        "PRODUCER_NARRATION_INVALID",
        "The narration output is invalid.",
        "scene_contract",
      );
    }
    return Object.freeze({
      sceneId: scene.sceneId,
      file: scene.file,
      text: scene.text,
      durationMs: Math.max(1, Math.round(scene.durationSeconds * 1_000)),
    });
  }));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function cloneFrozen(value, code = "PRODUCER_DATA_INVALID") {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    throw producerError(code, "Media production metadata is invalid.", "clone_failed");
  }
}

function clickCueRange(scene) {
  if (scene.highlights.length === 0) return null;
  const sourceTimes = scene.highlights.map(({ sourceAtMs }) => sourceAtMs);
  return Object.freeze({
    startMs: Math.min(...sourceTimes) - CLICK_HIGHLIGHT_PRE_ROLL_MS,
    endMs: Math.max(...sourceTimes) + CLICK_HIGHLIGHT_DURATION_MS,
  });
}

function retainedClickWindow(scene, durationMs) {
  const defaultStartMs = scene.sourceEndMs - durationMs;
  const cue = clickCueRange(scene);
  if (cue === null) {
    return Object.freeze({
      sourceStartMs: defaultStartMs,
      sourceEndMs: scene.sourceEndMs,
    });
  }
  if (
    cue.startMs < scene.sourceStartMs ||
    cue.endMs > scene.sourceEndMs ||
    cue.endMs - cue.startMs > durationMs
  ) {
    invalidHighlight("cue_span_unretained");
  }
  const sourceStartMs = Math.max(
    scene.sourceStartMs,
    cue.endMs - durationMs,
    Math.min(defaultStartMs, cue.startMs),
  );
  const sourceEndMs = sourceStartMs + durationMs;
  if (sourceStartMs > cue.startMs || sourceEndMs < cue.endMs) {
    invalidHighlight("cue_window_unretained");
  }
  return Object.freeze({ sourceStartMs, sourceEndMs });
}

function assertRetainedHighlights(scene) {
  if (scene.highlights.length === 0) return;
  if (scene.highlights.some(
    ({ sourceAtMs }) => sourceAtMs < scene.sourceStartMs || sourceAtMs > scene.sourceEndMs,
  )) {
    invalidHighlight("cue_outside_scene");
  }
  const cue = clickCueRange(scene);
  const durationMs = scene.sourceEndMs - scene.sourceStartMs;
  if (
    durationMs >= cue.endMs - cue.startMs &&
    (scene.sourceStartMs > cue.startMs || scene.sourceEndMs < cue.endMs)
  ) {
    invalidHighlight("cue_roll_unretained");
  }
}

function formatVttTime(milliseconds) {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function vttText(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("-->", "→")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
}

function captionsVtt(mediaPlan) {
  const cues = mediaPlan.captions.map((caption, index) => [
    String(index + 1),
    `${formatVttTime(caption.startMs)} --> ${formatVttTime(caption.endMs)}`,
    vttText(caption.text),
  ].join("\n"));
  return Buffer.from(`WEBVTT\n\n${cues.join("\n\n")}\n`, "utf8");
}

function integrityPaths(mediaPlan) {
  if (
    mediaPlan === null ||
    typeof mediaPlan !== "object" ||
    mediaPlan.recordingPath !== "composition/media/normalized.mp4" ||
    !Array.isArray(mediaPlan.scenes) ||
    mediaPlan.scenes.length < 1 ||
    mediaPlan.scenes.length > 100
  ) {
    throw producerError(
      "PRODUCER_PREVIEW_INVALID",
      "The persisted preview is invalid.",
      "integrity_media_plan",
    );
  }
  const paths = [
    "artifacts/captions.vtt",
    "artifacts/preview.mp4",
    `artifacts/${SOURCE_HIGHLIGHTS_FILE}`,
    "composition/index.html",
    mediaPlan.recordingPath,
  ];
  for (const scene of mediaPlan.scenes) {
    const path = scene?.narration?.path;
    const segments = safeRelative(path, {
      prefix: "composition",
      extension: ".wav",
    });
    if (segments.length !== 3 || segments[1] !== "narration") {
      throw producerError(
        "PRODUCER_PREVIEW_INVALID",
        "The persisted preview is invalid.",
        "integrity_narration_path",
      );
    }
    paths.push(path);
  }
  const sorted = [...paths].sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(sorted).size !== sorted.length) {
    throw producerError(
      "PRODUCER_PREVIEW_INVALID",
      "The persisted preview is invalid.",
      "integrity_duplicate_path",
    );
  }
  return Object.freeze(sorted);
}

function exactObjectFields(value, fields) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === fields.length &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && fields.includes(key),
    )
  );
}

function exactDenseArray(value, { minimum = 0, maximum = 100, reason } = {}) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw producerError(
      "PRODUCER_PREVIEW_INVALID",
      "The source highlight binding is invalid.",
      reason,
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw producerError(
        "PRODUCER_PREVIEW_INVALID",
        "The source highlight binding is invalid.",
        reason,
      );
    }
  }
  return value;
}

function validateSourceHighlightBinding(
  candidate,
  mediaPlan,
  { jobId, planDigest, previewDigest },
) {
  const rootFields = [
    "schemaVersion",
    "jobId",
    "planDigest",
    "mediaPlanDigest",
    "previewDigest",
    "scenes",
  ];
  const sceneFields = ["id", "sourceStartMs", "sourceEndMs", "highlights"];
  const highlightFields = ["callId", "sourceAtMs", "x", "y", "width", "height"];
  if (
    !exactObjectFields(candidate, rootFields) ||
    candidate.schemaVersion !== "1.0" ||
    typeof candidate.jobId !== "string" ||
    !JOB_ID.test(candidate.jobId) ||
    !DIGEST.test(candidate.planDigest ?? "") ||
    !DIGEST.test(candidate.mediaPlanDigest ?? "") ||
    !DIGEST.test(candidate.previewDigest ?? "") ||
    !Array.isArray(mediaPlan?.scenes)
  ) {
    throw producerError(
      "PRODUCER_PREVIEW_INVALID",
      "The source highlight binding is invalid.",
      "source_binding_contract",
    );
  }
  if (
    candidate.jobId !== jobId ||
    !equalDigest(candidate.planDigest, planDigest) ||
    !equalDigest(candidate.mediaPlanDigest, previewDigest) ||
    !equalDigest(candidate.previewDigest, previewDigest)
  ) {
    throw producerError(
      "PRODUCER_PREVIEW_STALE",
      "The source highlight binding is stale.",
      "source_binding_digest",
    );
  }
  const scenes = exactDenseArray(candidate.scenes, {
    minimum: 1,
    maximum: 100,
    reason: "source_binding_scenes",
  });
  if (scenes.length !== mediaPlan.scenes.length) {
    throw producerError(
      "PRODUCER_PREVIEW_INVALID",
      "The source highlight binding is invalid.",
      "source_binding_scene_count",
    );
  }
  const normalizedScenes = scenes.map((scene, sceneIndex) => {
    const mediaScene = mediaPlan.scenes[sceneIndex];
    if (
      !exactObjectFields(scene, sceneFields) ||
      scene.id !== mediaScene?.id ||
      !Number.isSafeInteger(scene.sourceStartMs) ||
      !Number.isSafeInteger(scene.sourceEndMs) ||
      scene.sourceStartMs !== mediaScene?.source?.startMs ||
      scene.sourceEndMs !== mediaScene?.source?.endMs ||
      scene.sourceEndMs <= scene.sourceStartMs ||
      !Array.isArray(mediaScene?.highlights)
    ) {
      throw producerError(
        "PRODUCER_PREVIEW_INVALID",
        "The source highlight binding is invalid.",
        "source_binding_scene",
      );
    }
    const highlights = exactDenseArray(scene.highlights, {
      maximum: 100,
      reason: "source_binding_highlights",
    });
    if (highlights.length !== mediaScene.highlights.length) {
      throw producerError(
        "PRODUCER_PREVIEW_INVALID",
        "The source highlight binding is invalid.",
        "source_binding_highlight_count",
      );
    }
    let previous = null;
    const normalizedHighlights = highlights.map((highlight, highlightIndex) => {
      const mediaHighlight = mediaScene.highlights[highlightIndex];
      if (
        !exactObjectFields(highlight, highlightFields) ||
        highlight.callId !== mediaHighlight?.callId ||
        !Number.isSafeInteger(highlight.sourceAtMs) ||
        highlight.sourceAtMs < scene.sourceStartMs ||
        highlight.sourceAtMs > scene.sourceEndMs ||
        ![highlight.x, highlight.y, highlight.width, highlight.height].every(Number.isSafeInteger) ||
        highlight.x !== mediaHighlight?.x ||
        highlight.y !== mediaHighlight?.y ||
        highlight.width !== mediaHighlight?.width ||
        highlight.height !== mediaHighlight?.height ||
        highlight.x < 0 ||
        highlight.y < 0 ||
        highlight.width < 1 ||
        highlight.height < 1 ||
        !Number.isSafeInteger(highlight.x + highlight.width) ||
        !Number.isSafeInteger(highlight.y + highlight.height) ||
        highlight.x + highlight.width > 1_920 ||
        highlight.y + highlight.height > 1_080
      ) {
        throw producerError(
          "PRODUCER_PREVIEW_INVALID",
          "The source highlight binding is invalid.",
          "source_binding_highlight",
        );
      }
      if (
        previous !== null &&
        (highlight.sourceAtMs < previous.sourceAtMs ||
          (highlight.sourceAtMs === previous.sourceAtMs &&
            highlight.callId.localeCompare(previous.callId, "en") < 0))
      ) {
        throw producerError(
          "PRODUCER_PREVIEW_INVALID",
          "The source highlight binding is invalid.",
          "source_binding_order",
        );
      }
      previous = highlight;
      return Object.freeze({
        callId: highlight.callId,
        sourceAtMs: highlight.sourceAtMs,
        x: highlight.x,
        y: highlight.y,
        width: highlight.width,
        height: highlight.height,
      });
    });
    return Object.freeze({
      id: scene.id,
      sourceStartMs: scene.sourceStartMs,
      sourceEndMs: scene.sourceEndMs,
      highlights: Object.freeze(normalizedHighlights),
    });
  });
  return Object.freeze({
    schemaVersion: "1.0",
    jobId: candidate.jobId,
    planDigest: candidate.planDigest,
    mediaPlanDigest: candidate.mediaPlanDigest,
    previewDigest: candidate.previewDigest,
    scenes: Object.freeze(normalizedScenes),
  });
}

function createSourceHighlightBinding(
  sourceScenes,
  mediaPlan,
  { jobId, planDigest, previewDigest },
) {
  if (!Array.isArray(sourceScenes)) {
    throw producerError(
      "PRODUCER_PREVIEW_INVALID",
      "The source highlight binding is invalid.",
      "source_binding_input",
    );
  }
  const candidate = {
    schemaVersion: "1.0",
    jobId,
    planDigest,
    mediaPlanDigest: previewDigest,
    previewDigest,
    scenes: sourceScenes.map((scene) => ({
      id: scene.id,
      sourceStartMs: scene.sourceStartMs,
      sourceEndMs: scene.sourceEndMs,
      highlights: scene.highlights.map((highlight) => ({
        callId: highlight.callId,
        sourceAtMs: highlight.sourceAtMs,
        x: highlight.x,
        y: highlight.y,
        width: highlight.width,
        height: highlight.height,
      })),
    })),
  };
  return validateSourceHighlightBinding(candidate, mediaPlan, {
    jobId,
    planDigest,
    previewDigest,
  });
}

function parsePreviewIntegrity(value, mediaPlan, planDigest, previewDigest) {
  const fields = ["schemaVersion", "planDigest", "previewDigest", "files"];
  const recordFields = ["path", "sha256", "bytes"];
  const expectedPaths = integrityPaths(mediaPlan);
  if (
    !exactObjectFields(value, fields) ||
    value.schemaVersion !== "1.0" ||
    !DIGEST.test(value.planDigest ?? "") ||
    !DIGEST.test(value.previewDigest ?? "") ||
    !Array.isArray(value.files) ||
    Object.getPrototypeOf(value.files) !== Array.prototype ||
    Reflect.ownKeys(value.files).length !== value.files.length + 1 ||
    value.files.length !== expectedPaths.length
  ) {
    throw producerError(
      "PRODUCER_PREVIEW_INVALID",
      "The persisted preview is invalid.",
      "integrity_manifest",
    );
  }
  if (
    !equalDigest(value.planDigest, planDigest) ||
    !equalDigest(value.previewDigest, previewDigest)
  ) {
    throw producerError(
      "PRODUCER_PREVIEW_STALE",
      "The persisted preview inputs changed after review.",
      "integrity_binding",
    );
  }
  const records = value.files.map((record, index) => {
    if (
      !exactObjectFields(record, recordFields) ||
      record.path !== expectedPaths[index] ||
      !DIGEST.test(record.sha256 ?? "") ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 1
    ) {
      throw producerError(
        "PRODUCER_PREVIEW_INVALID",
        "The persisted preview is invalid.",
        "integrity_record",
      );
    }
    safeRelative(record.path);
    return Object.freeze({
      path: record.path,
      sha256: record.sha256,
      bytes: record.bytes,
    });
  });
  return Object.freeze(records);
}

async function fingerprintPaths(layout, mediaPlan, fingerprints = new Map()) {
  const records = [];
  for (const logicalPath of integrityPaths(mediaPlan)) {
    records.push(
      fingerprints.get(logicalPath) ?? await fingerprintRegular(
        layout.jobRoot,
        join(layout.jobRoot, ...logicalPath.split("/")),
        logicalPath,
      ),
    );
  }
  return Object.freeze(records);
}

async function verifyIntegrity(
  layout,
  mediaPlan,
  manifest,
  planDigest,
  previewDigest,
  fingerprints,
) {
  const expected = parsePreviewIntegrity(
    manifest,
    mediaPlan,
    planDigest,
    previewDigest,
  );
  const actual = await fingerprintPaths(layout, mediaPlan, fingerprints);
  for (let index = 0; index < expected.length; index += 1) {
    if (
      expected[index].path !== actual[index].path ||
      expected[index].bytes !== actual[index].bytes ||
      !equalDigest(expected[index].sha256, actual[index].sha256)
    ) {
      throw producerError(
        "PRODUCER_PREVIEW_STALE",
        "The persisted preview inputs changed after review.",
        "integrity_mismatch",
      );
    }
  }
  return Object.freeze(expected);
}

function previewMetadata(planDigest, digest, integrity) {
  return Object.freeze({
    schemaVersion: "1.0",
    planDigest,
    mediaPlanDigest: digest,
    previewIntegritySha256: integrity.sha256,
    previewIntegrityBytes: integrity.bytes,
    previewArtifact: "preview.mp4",
    captionsArtifact: "captions.vtt",
  });
}

function exactPreviewMetadata(value) {
  const fields = [
    "schemaVersion",
    "planDigest",
    "mediaPlanDigest",
    "previewIntegritySha256",
    "previewIntegrityBytes",
    "previewArtifact",
    "captionsArtifact",
  ];
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !fields.includes(key),
    )
  ) {
    throw producerError(
      "PRODUCER_PREVIEW_INVALID",
      "The persisted preview is invalid.",
      "preview_metadata_fields",
    );
  }
  return value;
}

function exactPreview(value) {
  const fields = [
    "planDigest",
    "previewDigest",
    "mediaPlan",
    "previewIntegritySha256",
    "previewIntegrityBytes",
    "previewArtifact",
    "captionsArtifact",
  ];
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !fields.includes(key),
    )
  ) {
    throw producerError(
      "PRODUCER_PREVIEW_INVALID",
      "The persisted preview is invalid.",
      "preview_fields",
    );
  }
  return value;
}

function validText(value, reason, maximum = 4_000) {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw producerError(
      "PRODUCER_EDIT_INVALID",
      "The media edit is invalid.",
      reason,
    );
  }
  return value.trim();
}

function exactEdit(value) {
  const allowed = new Set([
    "previewDigest",
    "sceneId",
    "captionText",
    "narrationText",
  ]);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !allowed.has(key),
    ) ||
    !Object.hasOwn(value, "previewDigest") ||
    !Object.hasOwn(value, "sceneId")
  ) {
    throw producerError(
      "PRODUCER_EDIT_INVALID",
      "The media edit is invalid.",
      "edit_fields",
    );
  }
  return value;
}

function defaultPreviewPort(jobId) {
  let hash = 0;
  for (const char of jobId) hash = ((hash * 31) + char.codePointAt(0)) >>> 0;
  return 49_152 + (hash % 10_000);
}

function loopbackSupertonicOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw producerError(
      "PRODUCER_CONFIGURATION_INVALID",
      "The Supertonic service address is invalid.",
      "supertonic_url",
    );
  }
  if (
    url.protocol !== "http:" ||
    !new Set(["127.0.0.1", "[::1]"]).has(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw producerError(
      "PRODUCER_CONFIGURATION_INVALID",
      "Supertonic must use a plain loopback HTTP origin.",
      "supertonic_not_loopback",
    );
  }
  return url.origin;
}

function requiredMethods(value, methods, name) {
  if (value === null || typeof value !== "object" || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} adapter is required`);
  }
  return value;
}

export class MediaProducer {
  #jobsRoot;
  #templatePath;
  #jobStore;
  #restoreLatestPlan;
  #ffmpeg;
  #hyperframes;
  #qualityGate;
  #supertonicBaseUrl;
  #createSupertonicClient;
  #generateNarration;
  #createMediaPlan;
  #writeComposition;
  #mediaPlanDigest;
  #previewPort;
  #ownedPreviews = new Map();
  #drafts = new Map();

  constructor(options = {}) {
    const jobsRoot = options.jobsRoot ?? options.jobStore?.root;
    const restoreLatestPlan = options.restoreLatestPlan ?? defaultRestoreLatestPlan;
    const ffmpeg = options.ffmpeg ?? options.ffmpegAdapter;
    const hyperframes = options.hyperframes ?? options.hyperframesAdapter;
    if (
      typeof jobsRoot !== "string" ||
      !isAbsolute(jobsRoot) ||
      jobsRoot.includes("\0") ||
      typeof options.templatePath !== "string" ||
      !isAbsolute(options.templatePath) ||
      options.templatePath.includes("\0") ||
      typeof restoreLatestPlan !== "function" ||
      (restoreLatestPlan === defaultRestoreLatestPlan && !options.jobStore) ||
      typeof (options.createSupertonicClient ?? options.supertonicClientFactory ?? ((value) => value)) !== "function" ||
      typeof (options.generateNarration ?? defaultGenerateNarration) !== "function" ||
      typeof (options.createMediaPlan ?? defaultCreateMediaPlan) !== "function" ||
      typeof (options.writeComposition ?? defaultWriteComposition) !== "function" ||
      typeof (options.mediaPlanDigest ?? defaultMediaPlanDigest) !== "function"
    ) {
      throw new TypeError("safe media producer dependencies are required");
    }
    requiredMethods(ffmpeg, ["normalizeRecording"], "FFmpeg");
    requiredMethods(hyperframes, ["lint", "check", "preview", "stopPreview", "render"], "HyperFrames");
    requiredMethods(options.qualityGate, ["probe"], "quality gate");
    const previewPort = options.previewPort ?? defaultPreviewPort;
    if (
      !(
        typeof previewPort === "function" ||
        (Number.isSafeInteger(previewPort) && previewPort >= 1_024 && previewPort <= 65_535)
      )
    ) {
      throw new TypeError("a safe preview port or port factory is required");
    }
    this.#jobsRoot = resolve(jobsRoot);
    this.#templatePath = resolve(options.templatePath);
    this.#jobStore = options.jobStore;
    this.#restoreLatestPlan = restoreLatestPlan;
    this.#ffmpeg = ffmpeg;
    this.#hyperframes = hyperframes;
    this.#qualityGate = options.qualityGate;
    this.#supertonicBaseUrl = loopbackSupertonicOrigin(
      options.supertonicBaseUrl ?? "http://127.0.0.1:7788",
    );
    this.#createSupertonicClient = options.createSupertonicClient ??
      options.supertonicClientFactory ??
      ((clientOptions) => new SupertonicClient(clientOptions));
    this.#generateNarration = options.generateNarration ?? defaultGenerateNarration;
    this.#createMediaPlan = options.createMediaPlan ?? defaultCreateMediaPlan;
    this.#writeComposition = options.writeComposition ?? defaultWriteComposition;
    this.#mediaPlanDigest = options.mediaPlanDigest ?? defaultMediaPlanDigest;
    this.#previewPort = previewPort;
  }

  async #approved(jobId, expectedDigest) {
    const restored = await this.#restoreLatestPlan(this.#jobStore, jobId);
    if (
      restored === null ||
      typeof restored !== "object" ||
      restored.approved !== true ||
      !equalDigest(restored.planDigest, expectedDigest) ||
      !Array.isArray(restored.plan?.steps) ||
      restored.plan.steps.length < 1
    ) {
      throw producerError(
        "PRODUCER_PLAN_MISMATCH",
        "The approved browser plan is no longer current.",
        "plan_binding",
      );
    }
    return Object.freeze({ plan: restored.plan, planDigest: restored.planDigest });
  }

  async #layout(jobId) {
    const paths = await jobPaths(this.#jobsRoot, jobId);
    const composition = await safeDirectory(paths.jobRoot, join(paths.jobRoot, "composition"), { create: true });
    const media = await safeDirectory(paths.jobRoot, join(composition.path, "media"), { create: true });
    const narration = await safeDirectory(paths.jobRoot, join(composition.path, "narration"), { create: true });
    const artifacts = await safeDirectory(paths.jobRoot, join(paths.jobRoot, "artifacts"), { create: true });
    return Object.freeze({
      ...paths,
      compositionPath: composition.path,
      mediaPath: media.path,
      narrationPath: narration.path,
      artifactsPath: artifacts.path,
    });
  }

  async narrate({ jobId, job, report, signal } = {}) {
    const layout = await this.#layout(jobId);
    const approved = await this.#approved(layout.jobId, report?.planDigest);
    reportBinding(report, approved.plan, approved.planDigest);
    const voice = job?.request?.voice;
    if (typeof voice !== "string") {
      throw producerError(
        "PRODUCER_NARRATION_INVALID",
        "The narration voice is invalid.",
        "voice_missing",
      );
    }
    const client = this.#createSupertonicClient({
      baseUrl: this.#supertonicBaseUrl,
      outputRoot: layout.narrationPath,
    });
    if (!samePath(client?.outputRoot, layout.narrationPath)) {
      throw producerError(
        "PRODUCER_NARRATION_INVALID",
        "The narration client is not bound to this job.",
        "client_output_root",
      );
    }
    const manifest = await this.#generateNarration({
      plan: approved.plan,
      outputDirectory: layout.narrationPath,
      client,
      voice,
      signal,
    });
    const scenes = validateNarration(manifest, approved.plan, voice);
    for (const scene of scenes) {
      await requireRegular(layout.jobRoot, join(layout.narrationPath, scene.file), { minimumBytes: 1 });
    }
    await requireRegular(layout.jobRoot, join(layout.narrationPath, "narration.json"), { minimumBytes: 2 });
    return deepFreeze({
      sceneCount: scenes.length,
      planDigest: approved.planDigest,
      manifest: cloneFrozen(manifest),
    });
  }

  #rawPlan(binding, narrationScenes, plan) {
    const waitOnly = plan.steps.map(
      (step) =>
        step.calls.length > 0 &&
        step.calls.every((call) => call.tool === "browser_wait_for"),
    );
    const scenes = binding.scenes.map((scene, index) => {
      const narration = narrationScenes[index];
      if (
        (!waitOnly[index] && !binding.narrationDwell[index]) ||
        plan.steps[index].id !== scene.id ||
        narration.sceneId !== scene.id
      ) {
        return { ...scene };
      }

      const maximumSourceDurationMs = Math.floor(
        (narration.durationMs + MAX_MEDIA_DRIFT_MS) * MAX_PLAYBACK_RATE,
      );
      const sourceDurationMs = scene.sourceEndMs - scene.sourceStartMs;
      if (sourceDurationMs <= maximumSourceDurationMs) return { ...scene };
      const window = retainedClickWindow(scene, maximumSourceDurationMs);
      return {
        ...scene,
        sourceStartMs: window.sourceStartMs,
        sourceEndMs: window.sourceEndMs,
      };
    });

    let actionRunStart = 0;
    for (let waitIndex = 0; waitIndex < scenes.length; waitIndex += 1) {
      if (!waitOnly[waitIndex]) continue;
      if (actionRunStart < waitIndex) {
        const needsRebalance = scenes
          .slice(actionRunStart, waitIndex)
          .some(
            (scene, offset) =>
              scene.sourceEndMs - scene.sourceStartMs <
              Math.ceil(
                narrationScenes[actionRunStart + offset].durationMs * MIN_PLAYBACK_RATE,
              ),
          );
        if (!needsRebalance) {
          actionRunStart = waitIndex + 1;
          continue;
        }
        const rebalanced = [];
        let cursor = scenes[actionRunStart].sourceStartMs;
        let fitsBeforeWait = true;
        for (let index = actionRunStart; index < waitIndex; index += 1) {
          const current = scenes[index];
          const original = binding.scenes[index];
          const sourceStartMs = Math.max(current.sourceStartMs, cursor);
          const requiredSourceDurationMs = Math.ceil(
            narrationScenes[index].durationMs * MIN_PLAYBACK_RATE,
          );
          const sourceEndMs = Math.max(
            current.sourceEndMs,
            sourceStartMs + requiredSourceDurationMs,
          );
          if (
            sourceStartMs >= original.sourceEndMs ||
            sourceEndMs > scenes[waitIndex].sourceStartMs
          ) {
            fitsBeforeWait = false;
            break;
          }
          rebalanced.push({ ...current, sourceStartMs, sourceEndMs });
          cursor = sourceEndMs;
        }
        if (fitsBeforeWait) {
          scenes.splice(actionRunStart, rebalanced.length, ...rebalanced);
        }
      }
      actionRunStart = waitIndex + 1;
    }

    for (const scene of scenes) assertRetainedHighlights(scene);

    return {
      recordingPath: "composition/media/normalized.mp4",
      scenes,
      narrations: narrationScenes.map((scene) => ({
        sceneId: scene.sceneId,
        path: `composition/narration/${scene.file}`,
        durationMs: scene.durationMs,
        text: scene.text,
      })),
    };
  }

  async #stopOwned(jobId) {
    const owned = this.#ownedPreviews.get(jobId);
    if (owned === undefined) return;
    if (owned.stopPromise === undefined) {
      owned.stopPromise = this.#hyperframes.stopPreview({
        jobRoot: owned.jobRoot,
        projectPath: owned.projectPath,
      });
    }
    try {
      await owned.stopPromise;
    } finally {
      if (this.#ownedPreviews.get(jobId) === owned) this.#ownedPreviews.delete(jobId);
    }
  }

  async #renderDraft(layout, signal) {
    await this.#hyperframes.lint({
      jobRoot: layout.jobRoot,
      projectPath: layout.compositionPath,
      signal,
    });
    await this.#hyperframes.check({
      jobRoot: layout.jobRoot,
      projectPath: layout.compositionPath,
      signal,
    });
    const port = typeof this.#previewPort === "function"
      ? await this.#previewPort(layout.jobId)
      : this.#previewPort;
    if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
      throw producerError(
        "PRODUCER_PREVIEW_INVALID",
        "The preview port is invalid.",
        "preview_port",
      );
    }
    await this.#hyperframes.preview({
      jobRoot: layout.jobRoot,
      projectPath: layout.compositionPath,
      port,
      signal,
    });
    this.#ownedPreviews.set(layout.jobId, {
      jobRoot: layout.jobRoot,
      projectPath: layout.compositionPath,
      stopPromise: undefined,
    });
    try {
      const outputPath = join(layout.artifactsPath, "preview.mp4");
      await this.#hyperframes.render({
        jobRoot: layout.jobRoot,
        projectPath: layout.compositionPath,
        outputPath,
        signal,
        quality: "draft",
      });
      return await requireRegular(layout.jobRoot, outputPath, { minimumBytes: 1 });
    } finally {
      await this.#stopOwned(layout.jobId);
    }
  }

  async #publishPreview(layout, planDigest, mediaPlan, sourceScenes, renderedFile) {
    const digest = this.#mediaPlanDigest(mediaPlan);
    if (!DIGEST.test(digest)) {
      throw producerError(
        "PRODUCER_PREVIEW_INVALID",
        "The media plan digest is invalid.",
        "invalid_digest",
      );
    }
    const sourceBinding = createSourceHighlightBinding(sourceScenes, mediaPlan, {
      jobId: layout.jobId,
      planDigest,
      previewDigest: digest,
    });
    const previewPath = join(layout.artifactsPath, "preview.mp4");
    const beforeMetadata = await requireRegular(layout.jobRoot, previewPath, {
      minimumBytes: 1,
    });
    if (!sameIdentity(renderedFile.entry, beforeMetadata.entry)) {
      throw invalidPath("preview_file_changed_before_publication");
    }
    await atomicJson(layout.jobRoot, join(layout.artifactsPath, "media-plan.json"), mediaPlan);
    const sourceFingerprint = await atomicJsonFingerprint(
      layout.jobRoot,
      join(layout.artifactsPath, SOURCE_HIGHLIGHTS_FILE),
      sourceBinding,
      `artifacts/${SOURCE_HIGHLIGHTS_FILE}`,
    );
    await atomicWrite(layout.jobRoot, join(layout.artifactsPath, "captions.vtt"), captionsVtt(mediaPlan));
    const beforeIntegrity = await requireRegular(layout.jobRoot, previewPath, {
      minimumBytes: 1,
    });
    if (!sameIdentity(renderedFile.entry, beforeIntegrity.entry)) {
      throw invalidPath("preview_file_changed_before_integrity_manifest");
    }
    const integrity = Object.freeze({
      schemaVersion: "1.0",
      planDigest,
      previewDigest: digest,
      files: await fingerprintPaths(
        layout,
        mediaPlan,
        new Map([[sourceFingerprint.path, sourceFingerprint]]),
      ),
    });
    const afterFingerprint = await requireRegular(layout.jobRoot, previewPath, {
      minimumBytes: 1,
    });
    if (!sameIdentity(renderedFile.entry, afterFingerprint.entry)) {
      throw invalidPath("preview_file_changed_during_integrity_manifest");
    }
    const integrityPath = join(layout.artifactsPath, PREVIEW_INTEGRITY_FILE);
    await atomicWrite(
      layout.jobRoot,
      integrityPath,
      jsonBytes(integrity),
    );
    const integrityFingerprint = await fingerprintRegular(
      layout.jobRoot,
      integrityPath,
      `artifacts/${PREVIEW_INTEGRITY_FILE}`,
    );
    const metadata = previewMetadata(planDigest, digest, integrityFingerprint);
    await atomicJson(layout.jobRoot, join(layout.artifactsPath, "preview.json"), metadata);
    await atomicJson(layout.jobRoot, join(layout.artifactsPath, "manifest.json"), { files: [...PREVIEW_FILES] });
    return deepFreeze({
      planDigest,
      previewDigest: digest,
      mediaPlan: cloneFrozen(mediaPlan),
      previewIntegritySha256: integrityFingerprint.sha256,
      previewIntegrityBytes: integrityFingerprint.bytes,
      previewArtifact: "preview.mp4",
      captionsArtifact: "captions.vtt",
    });
  }

  async #composePlan(layout, planDigest, mediaPlan, sourceScenes, signal) {
    await this.#writeComposition({
      jobRoot: layout.jobRoot,
      templatePath: this.#templatePath,
      outputPath: join(layout.compositionPath, "index.html"),
      mediaPlan,
    });
    await requireRegular(layout.jobRoot, join(layout.compositionPath, "index.html"), { minimumBytes: 1 });
    const renderedFile = await this.#renderDraft(layout, signal);
    return this.#publishPreview(
      layout,
      planDigest,
      mediaPlan,
      sourceScenes,
      renderedFile,
    );
  }

  async compose({ jobId, job, report, narration, signal } = {}) {
    const layout = await this.#layout(jobId);
    const approved = await this.#approved(layout.jobId, report?.planDigest);
    const binding = reportBinding(report, approved.plan, approved.planDigest);
    if (!equalDigest(narration?.planDigest, approved.planDigest)) {
      throw producerError(
        "PRODUCER_NARRATION_INVALID",
        "The narration is not bound to the approved plan.",
        "narration_digest",
      );
    }
    const voice = job?.request?.voice;
    if (typeof voice !== "string") {
      throw producerError(
        "PRODUCER_NARRATION_INVALID",
        "The narration voice is invalid.",
        "voice_missing",
      );
    }
    const narrationScenes = validateNarration(
      narration.manifest,
      approved.plan,
      voice,
    );
    const sourceSegments = safeRelative(binding.recordingPath, { prefix: "browser", extension: ".webm" });
    const inputPath = join(layout.jobRoot, ...sourceSegments);
    await requireRegular(layout.jobRoot, inputPath, { minimumBytes: 1 });
    const normalizedPath = join(layout.mediaPath, "normalized.mp4");
    await this.#ffmpeg.normalizeRecording({
      jobRoot: layout.jobRoot,
      inputPath,
      outputPath: normalizedPath,
      signal,
    });
    await requireRegular(layout.jobRoot, normalizedPath, { minimumBytes: 1 });
    const rawPlan = this.#rawPlan(binding, narrationScenes, approved.plan);
    const mediaPlan = this.#createMediaPlan(rawPlan);
    return this.#composePlan(
      layout,
      approved.planDigest,
      mediaPlan,
      rawPlan.scenes,
      signal,
    );
  }

  async verifyPreview({ jobId, preview } = {}) {
    exactPreview(preview);
    const layout = await this.#layout(jobId);
    if (
      preview === null ||
      typeof preview !== "object" ||
      preview.previewArtifact !== "preview.mp4" ||
      preview.captionsArtifact !== "captions.vtt" ||
      !DIGEST.test(preview.planDigest ?? "") ||
      !DIGEST.test(preview.previewDigest ?? "") ||
      !DIGEST.test(preview.previewIntegritySha256 ?? "") ||
      !Number.isSafeInteger(preview.previewIntegrityBytes) ||
      preview.previewIntegrityBytes < 1
    ) {
      throw producerError(
        "PRODUCER_PREVIEW_INVALID",
        "The persisted preview is invalid.",
        "preview_contract",
      );
    }
    let eventMediaPlanDigest;
    try {
      eventMediaPlanDigest = this.#mediaPlanDigest(preview.mediaPlan);
    } catch {
      throw producerError(
        "PRODUCER_PREVIEW_INVALID",
        "The persisted preview is invalid.",
        "event_media_plan",
      );
    }
    const [mediaPlan, metadata, sourceBindingRead] = await Promise.all([
      readJson(layout.jobRoot, join(layout.artifactsPath, "media-plan.json")),
      readJson(layout.jobRoot, join(layout.artifactsPath, "preview.json")),
      readJsonFingerprint(
        layout.jobRoot,
        join(layout.artifactsPath, SOURCE_HIGHLIGHTS_FILE),
        `artifacts/${SOURCE_HIGHLIGHTS_FILE}`,
      ),
    ]);
    exactPreviewMetadata(metadata);
    const digest = this.#mediaPlanDigest(mediaPlan);
    if (
      metadata.schemaVersion !== "1.0" ||
      metadata.previewArtifact !== "preview.mp4" ||
      metadata.captionsArtifact !== "captions.vtt" ||
      !equalDigest(metadata.planDigest, preview.planDigest) ||
      !equalDigest(metadata.mediaPlanDigest, digest) ||
      !equalDigest(
        metadata.previewIntegritySha256,
        preview.previewIntegritySha256,
      ) ||
      metadata.previewIntegrityBytes !== preview.previewIntegrityBytes ||
      !equalDigest(preview.previewDigest, digest) ||
      !equalDigest(eventMediaPlanDigest, digest)
    ) {
      throw producerError(
        "PRODUCER_PREVIEW_STALE",
        "The persisted preview no longer matches the media plan.",
        "digest_mismatch",
      );
    }
    const sourceBinding = validateSourceHighlightBinding(
      sourceBindingRead.value,
      mediaPlan,
      {
        jobId: layout.jobId,
        planDigest: preview.planDigest,
        previewDigest: preview.previewDigest,
      },
    );
    const integrityRead = await readJsonFingerprint(
      layout.jobRoot,
      join(layout.artifactsPath, PREVIEW_INTEGRITY_FILE),
      `artifacts/${PREVIEW_INTEGRITY_FILE}`,
    );
    const records = await verifyIntegrity(
      layout,
      mediaPlan,
      integrityRead.value,
      preview.planDigest,
      preview.previewDigest,
      new Map([[sourceBindingRead.fingerprint.path, sourceBindingRead.fingerprint]]),
    );
    if (
      !equalDigest(
        integrityRead.fingerprint.sha256,
        preview.previewIntegritySha256,
      ) ||
      integrityRead.fingerprint.bytes !== preview.previewIntegrityBytes
    ) {
      throw producerError(
        "PRODUCER_PREVIEW_STALE",
        "The persisted preview integrity record changed after review.",
        "integrity_manifest_changed",
      );
    }
    return deepFreeze({
      mediaPlan: cloneFrozen(mediaPlan),
      metadata: cloneFrozen(metadata),
      integrity: cloneFrozen(integrityRead.value),
      sourceBinding: cloneFrozen(sourceBinding),
      records,
    });
  }

  async render({ jobId, preview, signal } = {}) {
    const layout = await this.#layout(jobId);
    const verified = await this.verifyPreview({ jobId: layout.jobId, preview, signal });
    await this.#writeComposition({
      jobRoot: layout.jobRoot,
      templatePath: this.#templatePath,
      outputPath: join(layout.compositionPath, "index.html"),
      mediaPlan: verified.mediaPlan,
    });
    const verifyApprovedInputs = () => verifyIntegrity(
      layout,
      verified.mediaPlan,
      verified.integrity,
      preview.planDigest,
      preview.previewDigest,
    );
    await verifyApprovedInputs();
    await this.#hyperframes.lint({
      jobRoot: layout.jobRoot,
      projectPath: layout.compositionPath,
      signal,
    });
    await this.#hyperframes.check({
      jobRoot: layout.jobRoot,
      projectPath: layout.compositionPath,
      signal,
    });
    const outputPath = join(layout.artifactsPath, "final.mp4");
    await this.#hyperframes.render({
      jobRoot: layout.jobRoot,
      projectPath: layout.compositionPath,
      outputPath,
      signal,
      quality: "high",
    });
    const renderedFile = await requireRegular(layout.jobRoot, outputPath, { minimumBytes: 1 });
    const persisted = await readJson(layout.jobRoot, join(layout.artifactsPath, "media-plan.json"));
    if (!equalDigest(this.#mediaPlanDigest(persisted), preview.previewDigest)) {
      throw producerError(
        "PRODUCER_PREVIEW_STALE",
        "The media plan changed during final rendering.",
        "post_render_digest",
      );
    }
    await verifyApprovedInputs();
    const quality = await this.#qualityGate.probe({
      jobRoot: layout.jobRoot,
      filePath: outputPath,
      expectedDurationMs: verified.mediaPlan.video.durationMs,
      signal,
    });
    const postQualityPlan = await readJson(
      layout.jobRoot,
      join(layout.artifactsPath, "media-plan.json"),
    );
    if (!equalDigest(this.#mediaPlanDigest(postQualityPlan), preview.previewDigest)) {
      throw producerError(
        "PRODUCER_PREVIEW_STALE",
        "The media plan changed during final quality verification.",
        "post_quality_digest",
      );
    }
    await verifyApprovedInputs();
    const verifiedFile = await requireRegular(layout.jobRoot, outputPath, { minimumBytes: 1 });
    if (!sameIdentity(renderedFile.entry, verifiedFile.entry)) {
      throw invalidPath("final_file_changed_during_quality_gate");
    }
    const safeQuality = cloneFrozen(quality, "PRODUCER_QUALITY_INVALID");
    await atomicJson(layout.jobRoot, join(layout.artifactsPath, "quality.json"), safeQuality);
    await atomicJson(layout.jobRoot, join(layout.artifactsPath, "manifest.json"), {
      files: [...PREVIEW_FILES, "final.mp4", "quality.json"].sort(),
    });
    return deepFreeze({ outputArtifact: "final.mp4", quality: safeQuality });
  }

  async edit({ jobId, preview, edit } = {}) {
    const layout = await this.#layout(jobId);
    const verified = await this.verifyPreview({ jobId: layout.jobId, preview });
    const request = exactEdit(edit);
    if (!equalDigest(request.previewDigest, preview.previewDigest) || typeof request.sceneId !== "string") {
      throw producerError(
        "PRODUCER_EDIT_INVALID",
        "The media edit is invalid.",
        "edit_binding",
      );
    }
    const hasCaption = Object.hasOwn(request, "captionText");
    const hasNarration = Object.hasOwn(request, "narrationText");
    if (!hasCaption && !hasNarration) {
      throw producerError("PRODUCER_EDIT_INVALID", "The media edit is invalid.", "empty_edit");
    }
    const mediaPlan = structuredClone(verified.mediaPlan);
    const matches = mediaPlan.scenes.filter((scene) => scene?.id === request.sceneId);
    if (matches.length !== 1) {
      throw producerError("PRODUCER_EDIT_INVALID", "The media edit is invalid.", "scene_missing");
    }
    const scene = matches[0];
    let captionChanged = false;
    let narrationChanged = false;
    if (hasCaption) {
      const text = validText(request.captionText, "caption_text");
      const caption = mediaPlan.captions.find((value) => value?.sceneId === scene.id);
      if (!caption || !scene.caption) {
        throw producerError("PRODUCER_EDIT_INVALID", "The media edit is invalid.", "caption_missing");
      }
      captionChanged = text !== scene.caption.text;
      scene.caption.text = text;
      caption.text = text;
    }
    if (hasNarration) {
      const text = validText(
        request.narrationText,
        "narration_text",
        MAX_STEP_NARRATION_CODE_UNITS,
      );
      if (!scene.narration) {
        throw producerError("PRODUCER_EDIT_INVALID", "The media edit is invalid.", "narration_missing");
      }
      narrationChanged = text !== scene.narration.text;
      scene.narration.text = text;
    }
    if (!captionChanged && !narrationChanged) {
      throw producerError("PRODUCER_EDIT_INVALID", "The media edit is invalid.", "unchanged_edit");
    }
    const stage = narrationChanged ? "narrating" : "composing";
    const edited = deepFreeze({
      stage,
      mediaPlan: deepFreeze(mediaPlan),
      draftDigest: this.#mediaPlanDigest(mediaPlan),
      sceneId: scene.id,
      captionChanged,
      narrationChanged,
      previousPreviewDigest: preview.previewDigest,
    });
    this.#drafts.set(layout.jobId, Object.freeze({
      edited,
      sourceBinding: verified.sourceBinding,
    }));
    return edited;
  }

  async #regenerateNarration(layout, approved, edited, sourceBinding, signal) {
    const byId = new Map(edited.mediaPlan.scenes.map((scene) => [scene.id, scene]));
    const narrationPlan = {
      ...approved.plan,
      steps: approved.plan.steps.map((step) => {
        const scene = byId.get(step.id);
        if (!scene) {
          throw producerError("PRODUCER_EDIT_INVALID", "The media edit is invalid.", "scene_binding");
        }
        return {
          ...step,
          narration: scene.narration.text,
          calls: step.calls.map((call) => ({
            ...call,
            arguments: structuredClone(call.arguments),
          })),
        };
      }),
    };
    const client = this.#createSupertonicClient({
      baseUrl: this.#supertonicBaseUrl,
      outputRoot: layout.narrationPath,
    });
    if (!samePath(client?.outputRoot, layout.narrationPath)) {
      throw producerError(
        "PRODUCER_NARRATION_INVALID",
        "The narration client is not bound to this job.",
        "client_output_root",
      );
    }
    const voice = edited.voice ?? "F1";
    const manifest = await this.#generateNarration({
      plan: narrationPlan,
      outputDirectory: layout.narrationPath,
      client,
      voice,
      signal,
    });
    const scenes = validateNarration(manifest, narrationPlan, voice);
    for (const scene of scenes) {
      await requireRegular(
        layout.jobRoot,
        join(layout.narrationPath, scene.file),
        { minimumBytes: 1 },
      );
    }
    await requireRegular(
      layout.jobRoot,
      join(layout.narrationPath, "narration.json"),
      { minimumBytes: 2 },
    );
    const sourceById = new Map(sourceBinding.scenes.map((scene) => [scene.id, scene]));
    const sourceScenes = edited.mediaPlan.scenes.map((scene) => {
      const source = sourceById.get(scene.id);
      if (
        !source ||
        source.sourceStartMs !== scene.source.startMs ||
        source.sourceEndMs !== scene.source.endMs
      ) {
        throw producerError(
          "PRODUCER_EDIT_INVALID",
          "The media edit source binding is invalid.",
          "source_binding",
        );
      }
      return {
        id: scene.id,
        sourceStartMs: source.sourceStartMs,
        sourceEndMs: source.sourceEndMs,
        caption: scene.caption.text,
        chapter: scene.chapter,
        highlights: source.highlights.map((highlight) => ({
          callId: highlight.callId,
          sourceAtMs: highlight.sourceAtMs,
          x: highlight.x,
          y: highlight.y,
          width: highlight.width,
          height: highlight.height,
        })),
      };
    });
    return this.#createMediaPlan({
      recordingPath: edited.mediaPlan.recordingPath,
      scenes: sourceScenes,
      narrations: scenes.map((scene) => ({
        sceneId: scene.sceneId,
        path: `composition/narration/${scene.file}`,
        durationMs: scene.durationMs,
        text: scene.text,
      })),
    });
  }

  async rebuild({ jobId, preview, edited, stage, signal, job } = {}) {
    const layout = await this.#layout(jobId);
    const ownedDraft = this.#drafts.get(layout.jobId);
    if (
      ownedDraft?.edited !== edited ||
      edited?.stage !== stage ||
      !equalDigest(edited?.previousPreviewDigest, preview?.previewDigest) ||
      !equalDigest(edited?.draftDigest, this.#mediaPlanDigest(edited?.mediaPlan))
    ) {
      throw producerError("PRODUCER_EDIT_INVALID", "The media edit is invalid.", "draft_binding");
    }
    await this.verifyPreview({ jobId: layout.jobId, preview });
    const approved = await this.#approved(layout.jobId, preview.planDigest);
    let mediaPlan = edited.mediaPlan;
    if (stage === "narrating") {
      const withVoice = { ...edited, voice: job?.request?.voice ?? "F1" };
      mediaPlan = await this.#regenerateNarration(
        layout,
        approved,
        withVoice,
        ownedDraft.sourceBinding,
        signal,
      );
    } else if (stage !== "composing") {
      throw producerError("PRODUCER_EDIT_INVALID", "The media edit is invalid.", "edit_stage");
    }
    try {
      return await this.#composePlan(
        layout,
        approved.planDigest,
        mediaPlan,
        ownedDraft.sourceBinding.scenes,
        signal,
      );
    } finally {
      if (this.#drafts.get(layout.jobId) === ownedDraft) this.#drafts.delete(layout.jobId);
    }
  }

  async cancel({ jobId } = {}) {
    const id = validJobId(jobId);
    this.#drafts.delete(id);
    await this.#stopOwned(id);
  }
}

export function createMediaProducer(options) {
  return new MediaProducer(options);
}
