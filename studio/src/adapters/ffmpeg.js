import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { StudioError } from "../domain/errors.js";
import { runProcess } from "../process/process-runner.js";

const NORMALIZE_FILTER = [
  "scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos",
  "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black",
  "fps=30",
].join(",");

function mediaError(code, message, reason, retryable = false) {
  return new StudioError(message, {
    code,
    stage: "media",
    retryable,
    details: { reason },
  });
}

function pathKey(value) {
  const canonical = resolve(value);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function isStrictChild(root, candidate) {
  const child = resolve(candidate);
  const fromRoot = relative(resolve(root), child);
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(fromRoot)
  );
}

function lexicalJobPath(jobRoot, candidate) {
  if (
    typeof jobRoot !== "string" ||
    typeof candidate !== "string" ||
    !isAbsolute(jobRoot) ||
    !isAbsolute(candidate) ||
    jobRoot.includes("\0") ||
    candidate.includes("\0") ||
    !isStrictChild(jobRoot, candidate)
  ) {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "A media path is outside the active job directory.",
      "job_root_escape",
    );
  }
  return resolve(candidate);
}

async function safeRoot(jobRoot) {
  if (typeof jobRoot !== "string" || !isAbsolute(jobRoot) || jobRoot.includes("\0")) {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "The active job directory is invalid.",
      "invalid_job_root",
    );
  }
  let rootEntry;
  try {
    rootEntry = await lstat(jobRoot);
  } catch {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "The active job directory is unavailable.",
      "job_root_unavailable",
    );
  }
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "The active job directory is unsafe.",
      "job_root_not_directory",
    );
  }
  return realpath(jobRoot);
}

async function existingJobFile(realRoot, candidate) {
  const lexical = lexicalJobPath(realRoot, candidate);
  let entry;
  try {
    entry = await lstat(lexical);
  } catch {
    throw mediaError(
      "MEDIA_INPUT_MISSING",
      "The source recording is unavailable.",
      "input_missing",
      true,
    );
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "The source recording is not a safe regular file.",
      "unsafe_input_entry",
    );
  }
  const canonical = await realpath(lexical);
  if (!isStrictChild(realRoot, canonical)) {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "The source recording is outside the active job directory.",
      "input_realpath_escape",
    );
  }
  return canonical;
}

async function safeJobOutput(realRoot, candidate) {
  const lexical = lexicalJobPath(realRoot, candidate);
  const parent = dirname(lexical);
  let parentEntry;
  try {
    parentEntry = await lstat(parent);
  } catch {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "The media output directory is unavailable.",
      "output_parent_missing",
    );
  }
  if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "The media output directory is unsafe.",
      "unsafe_output_parent",
    );
  }
  const canonicalParent = await realpath(parent);
  if (!isStrictChild(realRoot, canonicalParent) && pathKey(canonicalParent) !== pathKey(realRoot)) {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "The media output directory is outside the active job directory.",
      "output_realpath_escape",
    );
  }
  try {
    const outputEntry = await lstat(lexical);
    if (
      !outputEntry.isFile() ||
      outputEntry.isSymbolicLink() ||
      outputEntry.nlink !== 1
    ) {
      throw mediaError(
        "UNSAFE_MEDIA_PATH",
        "The media output path is unsafe.",
        "unsafe_output_entry",
      );
    }
  } catch (error) {
    if (error instanceof StudioError) {
      throw error;
    }
    if (error?.code !== "ENOENT") {
      throw mediaError(
        "UNSAFE_MEDIA_PATH",
        "The media output path could not be inspected.",
        "output_inspection_failed",
      );
    }
  }
  return Object.freeze({
    path: lexical,
    parent,
    parentEntry,
    canonicalParent,
  });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function verifyDirectory(path, expected, realRoot) {
  const entry = await lstat(path).catch(() => null);
  if (
    !entry?.isDirectory() ||
    entry.isSymbolicLink() ||
    !sameIdentity(entry, expected)
  ) {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "A media directory changed while FFmpeg was running.",
      "directory_identity_changed",
    );
  }
  const canonical = await realpath(path);
  if (
    !isStrictChild(realRoot, canonical) &&
    pathKey(canonical) !== pathKey(realRoot)
  ) {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "A media directory escaped the active job.",
      "directory_realpath_escape",
    );
  }
  return entry;
}

async function createStagingOutput(realRoot) {
  const directory = join(realRoot, `.ffmpeg-stage-${randomUUID()}`);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const entry = await lstat(directory);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    !isStrictChild(realRoot, await realpath(directory))
  ) {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "The FFmpeg staging directory is unsafe.",
      "unsafe_staging_directory",
    );
  }
  return Object.freeze({
    directory,
    entry,
    outputPath: join(directory, "normalized.mp4"),
  });
}

async function stagedFile(realRoot, staging) {
  await verifyDirectory(staging.directory, staging.entry, realRoot);
  const entry = await lstat(staging.outputPath).catch(() => null);
  if (
    !entry?.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1 ||
    entry.size < 1
  ) {
    throw mediaError(
      "FFMPEG_OUTPUT_INVALID",
      "FFmpeg did not produce a safe staged recording.",
      "unsafe_staged_output",
      true,
    );
  }
  const canonical = await realpath(staging.outputPath);
  if (!isStrictChild(staging.directory, canonical)) {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "The staged FFmpeg recording escaped its exclusive directory.",
      "staging_output_escape",
    );
  }
  return entry;
}

async function verifyFinalOutput(realRoot, output) {
  const parentEntry = await verifyDirectory(
    output.parent,
    output.parentEntry,
    realRoot,
  );
  if (!sameIdentity(parentEntry, output.parentEntry)) {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "The media output directory changed before publication.",
      "output_parent_changed",
    );
  }
  if (pathKey(await realpath(output.parent)) !== pathKey(output.canonicalParent)) {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "The media output directory changed before publication.",
      "output_parent_realpath_changed",
    );
  }
  let entry;
  try {
    entry = await lstat(output.path);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (
    entry !== undefined &&
    (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
  ) {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "The media output entry changed before publication.",
      "unsafe_output_entry",
    );
  }
}

async function publishStagedOutput(realRoot, staging, stagedEntry, output) {
  await verifyDirectory(staging.directory, staging.entry, realRoot);
  await verifyFinalOutput(realRoot, output);
  await rename(staging.outputPath, output.path);
  await verifyFinalOutput(realRoot, output);
  const published = await lstat(output.path);
  if (
    !published.isFile() ||
    published.isSymbolicLink() ||
    published.nlink !== 1 ||
    !sameIdentity(published, stagedEntry) ||
    !isStrictChild(realRoot, await realpath(output.path))
  ) {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "The normalized recording was not published safely.",
      "unsafe_published_output",
    );
  }
  return published;
}

async function cleanupStaging(staging) {
  const entry = await lstat(staging.directory).catch(() => null);
  if (
    !entry?.isDirectory() ||
    entry.isSymbolicLink() ||
    !sameIdentity(entry, staging.entry)
  ) {
    return;
  }
  await rm(staging.outputPath, { force: true }).catch(() => undefined);
  await rmdir(staging.directory).catch(() => undefined);
}

function minimalEnvironment(source = process.env) {
  const environment = Object.create(null);
  const normalizedKeys = new Set();
  for (const key of ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP"]) {
    const normalizedKey = key.toUpperCase();
    if (
      !normalizedKeys.has(normalizedKey) &&
      typeof source[key] === "string" &&
      source[key] !== "" &&
      !source[key].includes("\0")
    ) {
      environment[key] = source[key];
      normalizedKeys.add(normalizedKey);
    }
  }
  return environment;
}

export function buildNormalizeArgs({ jobRoot, inputPath, outputPath }) {
  const input = lexicalJobPath(jobRoot, inputPath);
  const output = lexicalJobPath(jobRoot, outputPath);
  if (pathKey(input) === pathKey(output)) {
    throw mediaError(
      "UNSAFE_MEDIA_PATH",
      "The normalized media output must be distinct from its input.",
      "input_output_collision",
    );
  }

  return Object.freeze([
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    input,
    "-map_metadata",
    "-1",
    "-vf",
    NORMALIZE_FILTER,
    "-fps_mode",
    "cfr",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
    output,
  ]);
}

export class FfmpegAdapter {
  #executable;
  #probeExecutable;
  #run;
  #environment;

  constructor({
    executable,
    probeExecutable,
    run = runProcess,
    environment = process.env,
  } = {}) {
    if (
      typeof executable !== "string" ||
      !isAbsolute(executable) ||
      executable.includes("\0") ||
      typeof probeExecutable !== "string" ||
      !isAbsolute(probeExecutable) ||
      probeExecutable.includes("\0") ||
      typeof run !== "function"
    ) {
      throw new TypeError("absolute FFmpeg and FFprobe executables are required");
    }
    this.#executable = executable;
    this.#probeExecutable = probeExecutable;
    this.#run = run;
    this.#environment = minimalEnvironment(environment);
  }

  get probeExecutable() {
    return this.#probeExecutable;
  }

  async normalizeRecording({
    jobRoot,
    inputPath,
    outputPath,
    signal,
    timeoutMs = 15 * 60 * 1_000,
  }) {
    const realRoot = await safeRoot(jobRoot);
    const input = await existingJobFile(realRoot, inputPath);
    const output = await safeJobOutput(realRoot, outputPath);
    const staging = await createStagingOutput(realRoot);
    try {
      const args = buildNormalizeArgs({
        jobRoot: realRoot,
        inputPath: input,
        outputPath: staging.outputPath,
      });
      const result = await this.#run({
        command: this.#executable,
        args,
        cwd: realRoot,
        env: this.#environment,
        signal,
        timeoutMs,
      });
      if (result?.exitCode !== 0 || result?.signal !== null) {
        throw mediaError(
          "FFMPEG_NORMALIZATION_FAILED",
          "FFmpeg could not normalize the browser recording.",
          "nonzero_exit",
          true,
        );
      }

      await verifyFinalOutput(realRoot, output);
      const stagedEntry = await stagedFile(realRoot, staging);
      const published = await publishStagedOutput(
        realRoot,
        staging,
        stagedEntry,
        output,
      );
      return Object.freeze({
        inputPath: input,
        outputPath: await realpath(output.path),
        bytes: published.size,
      });
    } finally {
      await cleanupStaging(staging);
    }
  }
}
