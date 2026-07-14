import { spawn } from "node:child_process";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateFinalMedia } from "../src/media/quality-gate.js";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const defaultStudioRoot = resolve(scriptRoot, "..");
const MAX_JSON_BYTES = 1024 * 1024;
const PLACEHOLDER_RATIO = 0.9;
const SILENCE_DB = -60;

export class VerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VerificationError";
    this.code = code;
  }
}

function verificationError(code, message) {
  throw new VerificationError(code, message);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateCaptions(mediaPlan, expectedDurationMs) {
  if (
    mediaPlan === null ||
    typeof mediaPlan !== "object" ||
    Array.isArray(mediaPlan) ||
    mediaPlan.schemaVersion !== "1.0" ||
    mediaPlan.video?.durationMs !== expectedDurationMs ||
    !Array.isArray(mediaPlan.captions) ||
    mediaPlan.captions.length < 1 ||
    mediaPlan.captions.length > 100
  ) {
    verificationError("VERIFY_MISSING_CAPTIONS", "The selected final artifact has no valid caption plan.");
  }

  for (const caption of mediaPlan.captions) {
    if (
      caption === null ||
      typeof caption !== "object" ||
      typeof caption.text !== "string" ||
      caption.text.trim().length < 1 ||
      !Number.isSafeInteger(caption.startMs) ||
      !Number.isSafeInteger(caption.endMs) ||
      caption.startMs < 0 ||
      caption.endMs <= caption.startMs ||
      caption.endMs > expectedDurationMs
    ) {
      verificationError("VERIFY_MISSING_CAPTIONS", "The selected final artifact has no valid caption plan.");
    }
  }
  return mediaPlan.captions.length;
}

export function validateArtifactEvidence({ probe, analysis, mediaPlan } = {}) {
  const expectedDurationMs = mediaPlan?.video?.durationMs;
  const captionCount = validateCaptions(mediaPlan, expectedDurationMs);
  let quality;
  try {
    quality = validateFinalMedia(probe, { expectedDurationMs });
  } catch {
    verificationError("VERIFY_MEDIA_QUALITY", "The selected final artifact failed the required media contract.");
  }

  if (
    analysis === null ||
    typeof analysis !== "object" ||
    !finiteNumber(analysis.meanVolumeDb) ||
    !finiteNumber(analysis.maxVolumeDb) ||
    !finiteNumber(analysis.frozenMs) ||
    !finiteNumber(analysis.blackMs) ||
    analysis.frozenMs < 0 ||
    analysis.blackMs < 0
  ) {
    verificationError("VERIFY_MEDIA_ANALYSIS", "FFmpeg did not produce complete final-artifact evidence.");
  }
  if (analysis.maxVolumeDb <= SILENCE_DB || analysis.meanVolumeDb <= SILENCE_DB) {
    verificationError("VERIFY_SILENT_AUDIO", "The selected final artifact contains silent narration.");
  }
  if (
    analysis.frozenMs / quality.durationMs >= PLACEHOLDER_RATIO ||
    analysis.blackMs / quality.durationMs >= PLACEHOLDER_RATIO
  ) {
    verificationError("VERIFY_PLACEHOLDER_VIDEO", "The selected final artifact appears to be a placeholder.");
  }

  return Object.freeze({
    ...quality,
    captionCount,
    meanVolumeDb: analysis.meanVolumeDb,
    maxVolumeDb: analysis.maxVolumeDb,
    frozenMs: analysis.frozenMs,
    blackMs: analysis.blackMs,
  });
}

function lastNumber(source, pattern) {
  let match;
  let value = Number.NaN;
  while ((match = pattern.exec(source)) !== null) {
    value = Number(match[1]);
  }
  return value;
}

function sumSeconds(source, pattern) {
  let match;
  let seconds = 0;
  while ((match = pattern.exec(source)) !== null) {
    seconds += Number(match[1]);
  }
  return Math.round(seconds * 1_000);
}

export function parseFfmpegAnalysis(source) {
  const text = typeof source === "string" ? source : "";
  return Object.freeze({
    meanVolumeDb: lastNumber(text, /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/giu),
    maxVolumeDb: lastNumber(text, /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/giu),
    frozenMs: sumSeconds(text, /freeze_duration:\s*(\d+(?:\.\d+)?)/giu),
    blackMs: sumSeconds(text, /black_duration:\s*(\d+(?:\.\d+)?)/giu),
  });
}

function childOf(root, candidate) {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

async function safeRegularFile(root, candidate, code) {
  const path = resolve(candidate);
  if (!childOf(root, path)) verificationError(code, "The selected verification path is outside the jobs directory.");
  const [rootEntry, fileEntry] = await Promise.all([lstat(root), lstat(path)]).catch(() => []);
  if (!rootEntry?.isDirectory() || rootEntry.isSymbolicLink() || !fileEntry?.isFile() || fileEntry.isSymbolicLink() || fileEntry.nlink !== 1) {
    verificationError(code, "The selected verification file is unsafe or missing.");
  }
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(path)]);
  if (!childOf(realRoot, realFile)) verificationError(code, "The selected verification file escaped the jobs directory.");
  return realFile;
}

async function candidateArtifacts(jobsRoot) {
  const entries = await readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(entry.name)) continue;
    const jobRoot = join(jobsRoot, entry.name);
    for (const suffix of [
      join("artifacts", "video", "final.mp4"),
      join("artifacts", "final.mp4"),
      join("renders", "final.mp4"),
    ]) {
      const path = join(jobRoot, suffix);
      try {
        const metadata = await lstat(path);
        if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1) {
          candidates.push({ path, mtimeMs: metadata.mtimeMs });
        }
      } catch {
        // A job without a final artifact is not a verification candidate.
      }
    }
  }
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path, "en"));
}

export async function selectFinalArtifact({ studioRoot = defaultStudioRoot, artifactPath } = {}) {
  const jobsRoot = join(resolve(studioRoot), "data", "jobs");
  const selected = artifactPath
    ? resolve(studioRoot, artifactPath)
    : (await candidateArtifacts(jobsRoot))[0]?.path;
  if (!selected || basename(selected).toLowerCase() !== "final.mp4") {
    verificationError("VERIFY_ARTIFACT_NOT_FOUND", "No generated final.mp4 artifact was selected.");
  }
  return safeRegularFile(jobsRoot, selected, "VERIFY_ARTIFACT_NOT_FOUND");
}

function jobRootFor(jobsRoot, artifactPath) {
  const fromJobs = relative(jobsRoot, artifactPath).split(sep);
  if (fromJobs.length < 2 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(fromJobs[0])) {
    verificationError("VERIFY_ARTIFACT_NOT_FOUND", "The final artifact does not belong to a valid job.");
  }
  return join(jobsRoot, fromJobs[0]);
}

async function readBoundedJson(root, path, code) {
  const safePath = await safeRegularFile(root, path, code);
  const metadata = await stat(safePath);
  if (metadata.size < 2 || metadata.size > MAX_JSON_BYTES) verificationError(code, "The verification manifest has an invalid size.");
  try {
    return JSON.parse(await readFile(safePath, "utf8"));
  } catch {
    verificationError(code, "The verification manifest is invalid JSON.");
  }
}

export async function loadMediaPlan({ studioRoot = defaultStudioRoot, artifactPath, planPath } = {}) {
  const jobsRoot = join(resolve(studioRoot), "data", "jobs");
  const jobRoot = jobRootFor(jobsRoot, artifactPath);
  if (planPath) {
    return readBoundedJson(jobRoot, resolve(studioRoot, planPath), "VERIFY_MEDIA_PLAN_NOT_FOUND");
  }
  for (const suffix of [
    join("artifacts", "media-plan.json"),
    join("artifacts", "video", "media-plan.json"),
    join("composition", "media-plan.json"),
    "media-plan.json",
  ]) {
    try {
      return await readBoundedJson(jobRoot, join(jobRoot, suffix), "VERIFY_MEDIA_PLAN_NOT_FOUND");
    } catch (error) {
      if (error?.code !== "VERIFY_MEDIA_PLAN_NOT_FOUND") throw error;
    }
  }
  verificationError("VERIFY_MEDIA_PLAN_NOT_FOUND", "The selected final artifact has no media plan.");
}

function run(file, args, { cwd = defaultStudioRoot, capture = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    if (capture) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal) {
        reject(new VerificationError("VERIFY_COMMAND_FAILED", "A verification command failed."));
        return;
      }
      resolveRun({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

async function locate(name) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = await run(locator, [name], { capture: true });
  const path = result.stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  if (!path || !isAbsolute(path)) verificationError("VERIFY_TOOL_NOT_FOUND", "A required verification tool is missing.");
  return path;
}

async function inspectArtifact(artifactPath) {
  const [ffprobe, ffmpeg] = await Promise.all([locate("ffprobe"), locate("ffmpeg")]);
  const probeResult = await run(ffprobe, [
    "-v", "error", "-show_streams", "-show_format", "-of", "json", artifactPath,
  ], { capture: true });
  let probe;
  try {
    probe = JSON.parse(probeResult.stdout);
  } catch {
    verificationError("VERIFY_MEDIA_QUALITY", "FFprobe did not return a valid final-artifact report.");
  }
  const sink = process.platform === "win32" ? "NUL" : "/dev/null";
  const analysisResult = await run(ffmpeg, [
    "-hide_banner", "-nostats", "-i", artifactPath,
    "-map", "0:v:0", "-map", "0:a:0",
    "-vf", "freezedetect=n=-60dB:d=0.5,blackdetect=d=0.5:pix_th=0.10",
    "-af", "volumedetect", "-f", "null", sink,
  ], { capture: true });
  return { probe, analysis: parseFfmpegAnalysis(analysisResult.stderr) };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!["--artifact", "--plan"].includes(name) || index + 1 >= argv.length) {
      verificationError("VERIFY_ARGUMENT_INVALID", "Usage: node scripts/verify.mjs [--artifact path] [--plan path]");
    }
    options[name === "--artifact" ? "artifactPath" : "planPath"] = argv[++index];
  }
  return options;
}

export async function runVerification({ studioRoot = defaultStudioRoot, artifactPath, planPath } = {}) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await run(npm, ["test"], { cwd: studioRoot });
  await run(process.execPath, ["scripts/doctor.mjs"], { cwd: studioRoot });
  const artifact = await selectFinalArtifact({ studioRoot, artifactPath });
  const mediaPlan = await loadMediaPlan({ studioRoot, artifactPath: artifact, planPath });
  const evidence = await inspectArtifact(artifact);
  const quality = validateArtifactEvidence({ ...evidence, mediaPlan });
  return Object.freeze({
    ready: true,
    artifact: relative(studioRoot, artifact).split(sep).join("/"),
    quality,
  });
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = await runVerification({
      ...options,
      artifactPath: options.artifactPath ?? process.env.MANUAL_STUDIO_VERIFY_ARTIFACT,
      planPath: options.planPath ?? process.env.MANUAL_STUDIO_VERIFY_PLAN,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const code = typeof error?.code === "string" && /^VERIFY_[A-Z_]+$/u.test(error.code)
      ? error.code
      : "VERIFY_FAILED";
    process.stderr.write(`Manual Video Studio verification failed: ${code}\n`);
    process.exitCode = 1;
  }
}
