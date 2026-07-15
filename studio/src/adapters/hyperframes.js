import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import { StudioError } from "../domain/errors.js";
import { runProcess } from "../process/process-runner.js";

export const HYPERFRAMES_VERSION = "0.7.57";

const ENVIRONMENT_ALLOWLIST = Object.freeze([
  "APPDATA",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
]);

function hyperframesError(code, message, reason, retryable = false) {
  return new StudioError(message, {
    code,
    stage: "composing",
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

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function lexicalChild(jobRoot, candidate) {
  if (
    typeof jobRoot !== "string" ||
    typeof candidate !== "string" ||
    !isAbsolute(jobRoot) ||
    !isAbsolute(candidate) ||
    jobRoot.includes("\0") ||
    candidate.includes("\0") ||
    !strictChild(jobRoot, candidate)
  ) {
    throw hyperframesError(
      "UNSAFE_MEDIA_PATH",
      "A HyperFrames path is outside the active job directory.",
      "job_root_escape",
    );
  }
  return resolve(candidate);
}

async function canonicalJobRoot(jobRoot) {
  let entry;
  try {
    entry = await lstat(jobRoot);
  } catch {
    throw hyperframesError(
      "UNSAFE_MEDIA_PATH",
      "The active job directory is unavailable.",
      "job_root_unavailable",
    );
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw hyperframesError(
      "UNSAFE_MEDIA_PATH",
      "The active job directory is unsafe.",
      "unsafe_job_root",
    );
  }
  return realpath(jobRoot);
}

async function safeProject(jobRoot, projectPath) {
  const realRoot = await canonicalJobRoot(jobRoot);
  const lexical = lexicalChild(realRoot, projectPath);
  const entry = await lstat(lexical).catch(() => null);
  if (!entry?.isDirectory() || entry.isSymbolicLink()) {
    throw hyperframesError(
      "UNSAFE_MEDIA_PATH",
      "The HyperFrames project directory is unsafe.",
      "unsafe_project_directory",
    );
  }
  const canonical = await realpath(lexical);
  if (!strictChild(realRoot, canonical)) {
    throw hyperframesError(
      "UNSAFE_MEDIA_PATH",
      "The HyperFrames project is outside the active job directory.",
      "project_realpath_escape",
    );
  }
  const indexPath = join(canonical, "index.html");
  const indexEntry = await lstat(indexPath).catch(() => null);
  if (!indexEntry?.isFile() || indexEntry.isSymbolicLink()) {
    throw hyperframesError(
      "HYPERFRAMES_PROJECT_INVALID",
      "The HyperFrames project has no safe index composition.",
      "index_missing",
    );
  }
  return { realRoot, projectPath: canonical };
}

async function safeOutput(realRoot, outputPath) {
  const lexical = lexicalChild(realRoot, outputPath);
  if (extname(lexical).toLowerCase() !== ".mp4") {
    throw hyperframesError(
      "UNSAFE_MEDIA_PATH",
      "The HyperFrames render output must be an MP4 inside the job.",
      "output_extension",
    );
  }
  const parent = dirname(lexical);
  const parentEntry = await lstat(parent).catch(() => null);
  if (!parentEntry?.isDirectory() || parentEntry.isSymbolicLink()) {
    throw hyperframesError(
      "UNSAFE_MEDIA_PATH",
      "The HyperFrames render directory is unsafe.",
      "unsafe_output_parent",
    );
  }
  const canonicalParent = await realpath(parent);
  if (!strictChild(realRoot, canonicalParent) && !samePath(realRoot, canonicalParent)) {
    throw hyperframesError(
      "UNSAFE_MEDIA_PATH",
      "The HyperFrames render directory is outside the active job.",
      "output_realpath_escape",
    );
  }
  try {
    const entry = await lstat(lexical);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
      throw hyperframesError(
        "UNSAFE_MEDIA_PATH",
        "The HyperFrames render output path is unsafe.",
        "unsafe_output_entry",
      );
    }
  } catch (error) {
    if (error instanceof StudioError) {
      throw error;
    }
    if (error?.code !== "ENOENT") {
      throw hyperframesError(
        "UNSAFE_MEDIA_PATH",
        "The HyperFrames render output path could not be inspected.",
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
    throw hyperframesError(
      "UNSAFE_MEDIA_PATH",
      "A HyperFrames directory changed during rendering.",
      "directory_identity_changed",
    );
  }
  const canonical = await realpath(path);
  if (!strictChild(realRoot, canonical) && !samePath(realRoot, canonical)) {
    throw hyperframesError(
      "UNSAFE_MEDIA_PATH",
      "A HyperFrames directory escaped the active job.",
      "directory_realpath_escape",
    );
  }
  return entry;
}

async function createStagingOutput(realRoot) {
  // Keep this segment deliberately short. HyperFrames creates nested FFmpeg
  // work directories beside the output and legacy Windows path limits still
  // apply inside that dependency.
  const directory = await mkdtemp(join(realRoot, ".hf-"));
  const entry = await lstat(directory);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    !strictChild(realRoot, await realpath(directory))
  ) {
    throw hyperframesError(
      "UNSAFE_MEDIA_PATH",
      "The HyperFrames staging directory is unsafe.",
      "unsafe_staging_directory",
    );
  }
  return Object.freeze({
    directory,
    entry,
    outputPath: join(directory, "render.mp4"),
  });
}

async function verifyFinalOutput(realRoot, output) {
  await verifyDirectory(output.parent, output.parentEntry, realRoot);
  if (!samePath(await realpath(output.parent), output.canonicalParent)) {
    throw hyperframesError(
      "UNSAFE_MEDIA_PATH",
      "The HyperFrames output directory changed before publication.",
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
    throw hyperframesError(
      "UNSAFE_MEDIA_PATH",
      "The HyperFrames output entry changed before publication.",
      "unsafe_output_entry",
    );
  }
}

async function stagedOutput(realRoot, staging) {
  await verifyDirectory(staging.directory, staging.entry, realRoot);
  const entry = await lstat(staging.outputPath).catch(() => null);
  if (
    !entry?.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1 ||
    entry.size < 1
  ) {
    throw hyperframesError(
      "HYPERFRAMES_OUTPUT_MISSING",
      "HyperFrames did not produce a safe staged render.",
      "unsafe_staged_output",
      true,
    );
  }
  if (!strictChild(staging.directory, await realpath(staging.outputPath))) {
    throw hyperframesError(
      "UNSAFE_MEDIA_PATH",
      "The staged HyperFrames render escaped its exclusive directory.",
      "staging_output_escape",
    );
  }
  return entry;
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
    !strictChild(realRoot, await realpath(output.path))
  ) {
    throw hyperframesError(
      "UNSAFE_MEDIA_PATH",
      "The HyperFrames render was not published safely.",
      "unsafe_published_output",
    );
  }
  return published;
}

async function cleanupStaging(realRoot, staging) {
  const entry = await lstat(staging.directory).catch(() => null);
  if (
    !entry?.isDirectory() ||
    entry.isSymbolicLink() ||
    !sameIdentity(entry, staging.entry)
  ) {
    return;
  }
  const canonical = await realpath(staging.directory).catch(() => null);
  if (canonical === null || !strictChild(realRoot, canonical)) {
    return;
  }
  await rm(staging.directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  }).catch(() => undefined);
}

function childEnvironment(source) {
  const environment = Object.create(null);
  const normalized = new Set();
  for (const key of ENVIRONMENT_ALLOWLIST) {
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
  environment.HYPERFRAMES_SKIP_SKILLS = "1";
  return environment;
}

function successfulResult(result) {
  return result?.exitCode === 0 && result?.signal === null;
}

function parseGateJson(stdout, mode) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw hyperframesError(
      "HYPERFRAMES_INVALID_OUTPUT",
      "HyperFrames returned invalid validation output.",
      "invalid_json",
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw hyperframesError(
      "HYPERFRAMES_VALIDATION_FAILED",
      "The HyperFrames composition did not pass validation.",
      "validation_findings",
      true,
    );
  }
  if (mode === "check") {
    const sectionNames = ["lint", "runtime", "layout", "motion", "contrast"];
    const sections = sectionNames.map((name) => value[name]);
    if (
      value.ok !== true ||
      value.strict !== true ||
      sections.some(
        (section) =>
          section === null ||
          typeof section !== "object" ||
          Array.isArray(section) ||
          !Number.isSafeInteger(section.errorCount) ||
          section.errorCount !== 0 ||
          !Number.isSafeInteger(section.warningCount) ||
          section.warningCount !== 0 ||
          !Array.isArray(section.findings),
      )
    ) {
      throw hyperframesError(
        "HYPERFRAMES_VALIDATION_FAILED",
        "The HyperFrames composition did not pass validation.",
        "validation_findings",
        true,
      );
    }
    return Object.freeze({
      errorCount: 0,
      warningCount: 0,
      findings: Object.freeze(sections.flatMap((section) => [...section.findings])),
    });
  }
  if (
    mode !== "lint" ||
    value.ok !== true ||
    !Number.isSafeInteger(value.errorCount) ||
    value.errorCount !== 0 ||
    !Number.isSafeInteger(value.warningCount) ||
    value.warningCount !== 0 ||
    !Array.isArray(value.findings)
  ) {
    throw hyperframesError(
      "HYPERFRAMES_VALIDATION_FAILED",
      "The HyperFrames composition did not pass validation.",
      "validation_findings",
      true,
    );
  }
  return Object.freeze({
    errorCount: value.errorCount,
    warningCount: value.warningCount,
    findings: Object.freeze([...value.findings]),
  });
}

export class HyperframesAdapter {
  #studioRoot;
  #nodeExecutable;
  #run;
  #environment;

  constructor({
    studioRoot,
    nodeExecutable = process.execPath,
    run = runProcess,
    environment = process.env,
  } = {}) {
    if (
      typeof studioRoot !== "string" ||
      !isAbsolute(studioRoot) ||
      studioRoot.includes("\0") ||
      typeof nodeExecutable !== "string" ||
      !isAbsolute(nodeExecutable) ||
      nodeExecutable.includes("\0") ||
      typeof run !== "function"
    ) {
      throw new TypeError("an absolute studio root and Node executable are required");
    }
    this.#studioRoot = resolve(studioRoot);
    this.#nodeExecutable = resolve(nodeExecutable);
    this.#run = run;
    this.#environment = childEnvironment(environment);
  }

  async verifyInstallation() {
    const packageRoot = join(this.#studioRoot, "node_modules", "hyperframes");
    const manifestPath = join(packageRoot, "package.json");
    const [packageEntry, manifestEntry] = await Promise.all([
      lstat(packageRoot).catch(() => null),
      lstat(manifestPath).catch(() => null),
    ]);
    if (
      !packageEntry?.isDirectory() ||
      packageEntry.isSymbolicLink() ||
      !manifestEntry?.isFile() ||
      manifestEntry.isSymbolicLink()
    ) {
      throw hyperframesError(
        "HYPERFRAMES_NOT_INSTALLED",
        "The pinned HyperFrames package is unavailable.",
        "package_missing",
      );
    }
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      throw hyperframesError(
        "HYPERFRAMES_NOT_INSTALLED",
        "The HyperFrames package manifest is invalid.",
        "manifest_invalid",
      );
    }
    if (manifest?.version !== HYPERFRAMES_VERSION) {
      throw hyperframesError(
        "HYPERFRAMES_VERSION_MISMATCH",
        "The installed HyperFrames version does not match the approved version.",
        "version_mismatch",
      );
    }
    const bin = typeof manifest.bin === "string"
      ? manifest.bin
      : manifest?.bin?.hyperframes;
    if (typeof bin !== "string" || bin.includes("\0")) {
      throw hyperframesError(
        "HYPERFRAMES_NOT_INSTALLED",
        "The HyperFrames command entry is invalid.",
        "bin_invalid",
      );
    }
    const cliPath = resolve(packageRoot, bin);
    if (
      !strictChild(packageRoot, cliPath) ||
      ![".js", ".mjs", ".cjs"].includes(extname(cliPath).toLowerCase())
    ) {
      throw hyperframesError(
        "HYPERFRAMES_NOT_INSTALLED",
        "The HyperFrames command entry is unsafe.",
        "bin_escape",
      );
    }
    const cliEntry = await lstat(cliPath).catch(() => null);
    if (!cliEntry?.isFile() || cliEntry.isSymbolicLink()) {
      throw hyperframesError(
        "HYPERFRAMES_NOT_INSTALLED",
        "The HyperFrames command entry is unavailable.",
        "bin_missing",
      );
    }
    return Object.freeze({
      version: HYPERFRAMES_VERSION,
      nodeExecutable: this.#nodeExecutable,
      cliPath,
    });
  }

  async #invoke({ projectPath, args, timeoutMs, signal }) {
    const installation = await this.verifyInstallation();
    const result = await this.#run({
      command: installation.nodeExecutable,
      args: Object.freeze([installation.cliPath, ...args]),
      cwd: projectPath,
      env: this.#environment,
      signal,
      timeoutMs,
    });
    if (!successfulResult(result)) {
      throw hyperframesError(
        "HYPERFRAMES_COMMAND_FAILED",
        "HyperFrames could not complete the media command.",
        "nonzero_exit",
        true,
      );
    }
    return result;
  }

  async lint({ jobRoot, projectPath, signal }) {
    const project = await safeProject(jobRoot, projectPath);
    const result = await this.#invoke({
      projectPath: project.projectPath,
      args: ["lint", project.projectPath, "--json"],
      timeoutMs: 2 * 60 * 1_000,
      signal,
    });
    return parseGateJson(result.stdout, "lint");
  }

  async check({ jobRoot, projectPath, signal }) {
    const project = await safeProject(jobRoot, projectPath);
    const result = await this.#invoke({
      projectPath: project.projectPath,
      args: [
        "check",
        project.projectPath,
        "--json",
        "--strict",
        "--at-transitions",
        "--max-transition-samples",
        "200",
        "--frame-check",
        "severity=error;seek=.25,.5,.75;tol=2",
      ],
      timeoutMs: 10 * 60 * 1_000,
      signal,
    });
    return parseGateJson(result.stdout, "check");
  }

  async preview({ jobRoot, projectPath, port, signal }) {
    if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
      throw new TypeError("preview port must be between 1024 and 65535");
    }
    const project = await safeProject(jobRoot, projectPath);
    await this.#invoke({
      projectPath: project.projectPath,
      args: [
        "preview",
        project.projectPath,
        "--port",
        String(port),
        "--background",
        "--no-open",
        "--force-new",
      ],
      timeoutMs: 2 * 60 * 1_000,
      signal,
    });
    return Object.freeze({ url: `http://127.0.0.1:${port}`, port });
  }

  async stopPreview({ jobRoot, projectPath, signal }) {
    const project = await safeProject(jobRoot, projectPath);
    await this.#invoke({
      projectPath: project.projectPath,
      args: ["preview", project.projectPath, "--stop", "--no-open"],
      timeoutMs: 30_000,
      signal,
    });
  }

  async render({ jobRoot, projectPath, outputPath, signal, quality = "high" }) {
    if (!new Set(["draft", "standard", "high"]).has(quality)) {
      throw new TypeError("unsupported HyperFrames render quality");
    }
    const project = await safeProject(jobRoot, projectPath);
    const output = await safeOutput(project.realRoot, outputPath);
    const staging = await createStagingOutput(project.realRoot);
    try {
      await this.#invoke({
        projectPath: project.projectPath,
        args: [
          "render",
          project.projectPath,
          "--quiet",
          "--composition",
          "index.html",
          "--output",
          staging.outputPath,
          "--format",
          "mp4",
          "--fps",
          "30",
          "--quality",
          quality,
          "--crf",
          "18",
          "--video-frame-format",
          "png",
          "--workers",
          "1",
          "--no-best-effort",
          "--strict-all",
          "--strict-variables",
          "--resolution",
          "landscape",
          "--no-page-side-compositing",
        ],
        timeoutMs: 60 * 60 * 1_000,
        signal,
      });
      await verifyFinalOutput(project.realRoot, output);
      const stagedEntry = await stagedOutput(project.realRoot, staging);
      const published = await publishStagedOutput(
        project.realRoot,
        staging,
        stagedEntry,
        output,
      );
      return Object.freeze({
        outputPath: await realpath(output.path),
        bytes: published.size,
      });
    } finally {
      await cleanupStaging(project.realRoot, staging);
    }
  }
}
