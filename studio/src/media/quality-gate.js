import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { StudioError } from "../domain/errors.js";
import { runProcess } from "../process/process-runner.js";

const DEFAULT_TOLERANCE_MS = 500;

function gateError(code, message, reason, retryable = false) {
  return new StudioError(message, {
    code,
    stage: "rendering",
    retryable,
    details: { reason },
  });
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

function lexicalFile(jobRoot, filePath) {
  if (
    typeof jobRoot !== "string" ||
    typeof filePath !== "string" ||
    !isAbsolute(jobRoot) ||
    !isAbsolute(filePath) ||
    jobRoot.includes("\0") ||
    filePath.includes("\0") ||
    !strictChild(jobRoot, filePath)
  ) {
    throw gateError(
      "UNSAFE_MEDIA_PATH",
      "The final media path is outside the active job directory.",
      "job_root_escape",
    );
  }
  return resolve(filePath);
}

async function safeExistingFile(jobRoot, filePath) {
  const lexical = lexicalFile(jobRoot, filePath);
  const [rootEntry, fileEntry] = await Promise.all([
    lstat(jobRoot).catch(() => null),
    lstat(lexical).catch(() => null),
  ]);
  if (!rootEntry?.isDirectory() || rootEntry.isSymbolicLink()) {
    throw gateError("UNSAFE_MEDIA_PATH", "The active job directory is unsafe.", "unsafe_job_root");
  }
  if (!fileEntry?.isFile() || fileEntry.isSymbolicLink()) {
    throw gateError("UNSAFE_MEDIA_PATH", "The final media file is unsafe.", "unsafe_media_file");
  }
  const [realRoot, canonical] = await Promise.all([realpath(jobRoot), realpath(lexical)]);
  if (!strictChild(realRoot, canonical)) {
    throw gateError("UNSAFE_MEDIA_PATH", "The final media file escaped the active job.", "realpath_escape");
  }
  return { realRoot, filePath: canonical };
}

function minimalEnvironment(source) {
  const environment = Object.create(null);
  const normalized = new Set();
  for (const key of ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP"]) {
    const normalizedKey = key.toUpperCase();
    if (
      normalized.has(normalizedKey) ||
      typeof source?.[key] !== "string" ||
      source[key] === "" ||
      source[key].includes("\0")
    ) {
      continue;
    }
    environment[key] = source[key];
    normalized.add(normalizedKey);
  }
  return environment;
}

export function buildProbeArgs({ jobRoot, filePath }) {
  const file = lexicalFile(jobRoot, filePath);
  return Object.freeze([
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    file,
  ]);
}

function rational(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/u.test(value)) {
    return Number.NaN;
  }
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return Number.NaN;
  }
  return numerator / denominator;
}

function positiveDuration(value) {
  const seconds = typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value)
    ? Number(value)
    : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : Number.NaN;
}

function supportedAudioSampleRate(value) {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    return false;
  }
  const sampleRate = Number(value);
  return sampleRate === 44_100 || sampleRate === 48_000;
}

function isMp4Format(value) {
  return (
    typeof value === "string" &&
    value.split(",").map((name) => name.trim()).includes("mp4")
  );
}

export function validateFinalMedia(report, {
  expectedDurationMs,
  toleranceMs = DEFAULT_TOLERANCE_MS,
} = {}) {
  if (
    report === null ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    Object.getPrototypeOf(report) !== Object.prototype ||
    !Number.isSafeInteger(expectedDurationMs) ||
    expectedDurationMs < 1 ||
    !Number.isSafeInteger(toleranceMs) ||
    toleranceMs < 0 ||
    toleranceMs > DEFAULT_TOLERANCE_MS ||
    !Array.isArray(report.streams) ||
    report.streams.length < 2 ||
    report.format === null ||
    typeof report.format !== "object" ||
    Array.isArray(report.format)
  ) {
    throw gateError("MEDIA_QUALITY_FAILED", "The final media report is invalid.", "invalid_probe_report");
  }
  const videos = report.streams.filter((stream) => stream?.codec_type === "video");
  const audios = report.streams.filter((stream) => stream?.codec_type === "audio");
  if (videos.length !== 1 || audios.length !== 1) {
    throw gateError("MEDIA_QUALITY_FAILED", "The final media stream layout is invalid.", "stream_count");
  }
  const [video] = videos;
  const [audio] = audios;
  const fps = rational(video.avg_frame_rate);
  const durationSeconds = positiveDuration(report.format.duration);
  const videoDurationSeconds = positiveDuration(video.duration);
  const audioDurationSeconds = positiveDuration(audio.duration);
  const durationMs = Math.round(durationSeconds * 1_000);
  const durationDriftMs = Math.abs(durationMs - expectedDurationMs);
  const videoDurationDriftMs = Math.abs(
    Math.round(videoDurationSeconds * 1_000) - expectedDurationMs,
  );
  const audioDurationDriftMs = Math.abs(
    Math.round(audioDurationSeconds * 1_000) - expectedDurationMs,
  );
  if (
    !isMp4Format(report.format.format_name) ||
    video.codec_name !== "h264" ||
    video.pix_fmt !== "yuv420p" ||
    audio.codec_name !== "aac" ||
    !supportedAudioSampleRate(audio.sample_rate) ||
    !Number.isSafeInteger(audio.channels) ||
    audio.channels < 1 ||
    video.width !== 1_920 ||
    video.height !== 1_080 ||
    !Number.isFinite(fps) ||
    Math.abs(fps - 30) > 0.000_001 ||
    !Number.isFinite(durationSeconds) ||
    !Number.isFinite(videoDurationSeconds) ||
    !Number.isFinite(audioDurationSeconds) ||
    durationDriftMs > toleranceMs ||
    videoDurationDriftMs > toleranceMs ||
    audioDurationDriftMs > toleranceMs
  ) {
    throw gateError("MEDIA_QUALITY_FAILED", "The final media did not pass the required quality gate.", "contract_mismatch", true);
  }
  return Object.freeze({
    videoCodec: "h264",
    audioCodec: "aac",
    width: 1_920,
    height: 1_080,
    fps: 30,
    durationMs,
    durationDriftMs,
  });
}

export class QualityGate {
  #ffprobeExecutable;
  #run;
  #environment;

  constructor({ ffprobeExecutable, run = runProcess, environment = process.env } = {}) {
    if (
      typeof ffprobeExecutable !== "string" ||
      !isAbsolute(ffprobeExecutable) ||
      ffprobeExecutable.includes("\0") ||
      typeof run !== "function"
    ) {
      throw new TypeError("an absolute FFprobe executable is required");
    }
    this.#ffprobeExecutable = ffprobeExecutable;
    this.#run = run;
    this.#environment = minimalEnvironment(environment);
  }

  async probe({
    jobRoot,
    filePath,
    expectedDurationMs,
    toleranceMs = DEFAULT_TOLERANCE_MS,
    signal,
  }) {
    const safe = await safeExistingFile(jobRoot, filePath);
    const result = await this.#run({
      command: this.#ffprobeExecutable,
      args: buildProbeArgs({ jobRoot: safe.realRoot, filePath: safe.filePath }),
      cwd: safe.realRoot,
      env: this.#environment,
      signal,
      timeoutMs: 60_000,
    });
    if (result?.exitCode !== 0 || result?.signal !== null) {
      throw gateError("FFPROBE_FAILED", "FFprobe could not inspect the final media.", "nonzero_exit", true);
    }
    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      throw gateError("FFPROBE_INVALID_OUTPUT", "FFprobe returned invalid JSON.", "invalid_json", true);
    }
    return validateFinalMedia(report, { expectedDurationMs, toleranceMs });
  }
}
