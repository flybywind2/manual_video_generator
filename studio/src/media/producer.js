import { randomUUID, timingSafeEqual } from "node:crypto";
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
import { mediaPlanDigest as defaultMediaPlanDigest, writeComposition as defaultWriteComposition } from "./composition.js";
import { createMediaPlan as defaultCreateMediaPlan } from "./media-plan.js";
import { generateNarration as defaultGenerateNarration } from "../workflow/narration.js";
import { restoreLatestPlan as defaultRestoreLatestPlan } from "../workflow/planning.js";

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const PREVIEW_FILES = Object.freeze([
  "captions.vtt",
  "media-plan.json",
  "preview.json",
  "preview.mp4",
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
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const staged = await handle.stat();
    await handle.close();
    handle = undefined;
    if (!staged.isFile() || staged.nlink !== 1) throw invalidPath("unsafe_staged_file");
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
    const final = await lstat(target);
    if (
      !final.isFile() ||
      final.isSymbolicLink() ||
      final.nlink !== 1 ||
      !sameIdentity(staged, final) ||
      !strictChild(root, await realpath(target))
    ) {
      throw invalidPath("unsafe_published_file");
    }
    published = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published) await rm(temporary, { force: true }).catch(() => undefined);
  }
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
      highlight: null,
    });
  });
  return Object.freeze({ reportStart, reportEnd, recordingPath: report.recordingPath, scenes });
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

function manifestFiles(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 1 ||
    !Array.isArray(value.files) ||
    value.files.length > 100
  ) {
    throw producerError(
      "PRODUCER_PREVIEW_INVALID",
      "The persisted preview is invalid.",
      "artifact_manifest",
    );
  }
  const files = new Set();
  for (const file of value.files) {
    safeRelative(file);
    if (files.has(file)) {
      throw producerError(
        "PRODUCER_PREVIEW_INVALID",
        "The persisted preview is invalid.",
        "duplicate_artifact",
      );
    }
    files.add(file);
  }
  return files;
}

function previewMetadata(planDigest, digest) {
  return Object.freeze({
    schemaVersion: "1.0",
    planDigest,
    mediaPlanDigest: digest,
    previewArtifact: "preview.mp4",
    captionsArtifact: "captions.vtt",
  });
}

function exactPreviewMetadata(value) {
  const fields = [
    "schemaVersion",
    "planDigest",
    "mediaPlanDigest",
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

function validText(value, reason) {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > 4_000 ||
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

  #rawPlan(binding, narrationScenes) {
    return {
      recordingPath: "composition/media/normalized.mp4",
      scenes: binding.scenes.map((scene) => ({ ...scene })),
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

  async #publishPreview(layout, planDigest, mediaPlan, renderedFile) {
    const digest = this.#mediaPlanDigest(mediaPlan);
    if (!DIGEST.test(digest)) {
      throw producerError(
        "PRODUCER_PREVIEW_INVALID",
        "The media plan digest is invalid.",
        "invalid_digest",
      );
    }
    const previewPath = join(layout.artifactsPath, "preview.mp4");
    const beforeMetadata = await requireRegular(layout.jobRoot, previewPath, {
      minimumBytes: 1,
    });
    if (!sameIdentity(renderedFile.entry, beforeMetadata.entry)) {
      throw invalidPath("preview_file_changed_before_publication");
    }
    const metadata = previewMetadata(planDigest, digest);
    await atomicJson(layout.jobRoot, join(layout.artifactsPath, "media-plan.json"), mediaPlan);
    await atomicWrite(layout.jobRoot, join(layout.artifactsPath, "captions.vtt"), captionsVtt(mediaPlan));
    await atomicJson(layout.jobRoot, join(layout.artifactsPath, "preview.json"), metadata);
    const beforeManifest = await requireRegular(layout.jobRoot, previewPath, {
      minimumBytes: 1,
    });
    if (!sameIdentity(renderedFile.entry, beforeManifest.entry)) {
      throw invalidPath("preview_file_changed_before_manifest");
    }
    await atomicJson(layout.jobRoot, join(layout.artifactsPath, "manifest.json"), { files: [...PREVIEW_FILES] });
    return deepFreeze({
      planDigest,
      previewDigest: digest,
      mediaPlan: cloneFrozen(mediaPlan),
      previewArtifact: "preview.mp4",
      captionsArtifact: "captions.vtt",
    });
  }

  async #composePlan(layout, planDigest, mediaPlan, signal) {
    await this.#writeComposition({
      jobRoot: layout.jobRoot,
      templatePath: this.#templatePath,
      outputPath: join(layout.compositionPath, "index.html"),
      mediaPlan,
    });
    await requireRegular(layout.jobRoot, join(layout.compositionPath, "index.html"), { minimumBytes: 1 });
    const renderedFile = await this.#renderDraft(layout, signal);
    return this.#publishPreview(layout, planDigest, mediaPlan, renderedFile);
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
    const mediaPlan = this.#createMediaPlan(this.#rawPlan(binding, narrationScenes));
    return this.#composePlan(layout, approved.planDigest, mediaPlan, signal);
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
      !DIGEST.test(preview.previewDigest ?? "")
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
    const [mediaPlan, metadata, manifest] = await Promise.all([
      readJson(layout.jobRoot, join(layout.artifactsPath, "media-plan.json")),
      readJson(layout.jobRoot, join(layout.artifactsPath, "preview.json")),
      readJson(layout.jobRoot, join(layout.artifactsPath, "manifest.json")),
    ]);
    exactPreviewMetadata(metadata);
    const files = manifestFiles(manifest);
    if (
      files.size !== PREVIEW_FILES.length ||
      PREVIEW_FILES.some((file) => !files.has(file))
    ) {
      throw producerError(
        "PRODUCER_PREVIEW_INVALID",
        "The persisted preview is invalid.",
        "missing_artifact",
      );
    }
    const digest = this.#mediaPlanDigest(mediaPlan);
    if (
      metadata.schemaVersion !== "1.0" ||
      metadata.previewArtifact !== "preview.mp4" ||
      metadata.captionsArtifact !== "captions.vtt" ||
      !equalDigest(metadata.planDigest, preview.planDigest) ||
      !equalDigest(metadata.mediaPlanDigest, digest) ||
      !equalDigest(preview.previewDigest, digest) ||
      !equalDigest(eventMediaPlanDigest, digest)
    ) {
      throw producerError(
        "PRODUCER_PREVIEW_STALE",
        "The persisted preview no longer matches the media plan.",
        "digest_mismatch",
      );
    }
    await Promise.all([
      requireRegular(layout.jobRoot, join(layout.artifactsPath, "preview.mp4"), { minimumBytes: 1 }),
      requireRegular(layout.jobRoot, join(layout.artifactsPath, "captions.vtt"), { minimumBytes: 1 }),
    ]);
    return deepFreeze({ mediaPlan: cloneFrozen(mediaPlan), metadata: cloneFrozen(metadata) });
  }

  async render({ jobId, preview, signal } = {}) {
    const layout = await this.#layout(jobId);
    const verified = await this.verifyPreview({ jobId: layout.jobId, preview, signal });
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
      const text = validText(request.narrationText, "narration_text");
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
    this.#drafts.set(layout.jobId, edited);
    return edited;
  }

  async #regenerateNarration(layout, approved, edited, signal) {
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
    const sourceScenes = edited.mediaPlan.scenes.map((scene) => ({
      id: scene.id,
      sourceStartMs: scene.source.startMs,
      sourceEndMs: scene.source.endMs,
      caption: scene.caption.text,
      chapter: scene.chapter,
      highlight: scene.highlight,
    }));
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
      ownedDraft !== edited ||
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
      mediaPlan = await this.#regenerateNarration(layout, approved, withVoice, signal);
    } else if (stage !== "composing") {
      throw producerError("PRODUCER_EDIT_INVALID", "The media edit is invalid.", "edit_stage");
    }
    try {
      return await this.#composePlan(layout, approved.planDigest, mediaPlan, signal);
    } finally {
      if (this.#drafts.get(layout.jobId) === edited) this.#drafts.delete(layout.jobId);
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
