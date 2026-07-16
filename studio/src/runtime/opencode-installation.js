import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

const WHERE_TIMEOUT_MS = 5_000;
const VERSION_TIMEOUT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 120_000;
const WHERE_MAX_BYTES = 64 * 1024;
const VERSION_MAX_BYTES = 4 * 1024;
const INSTALL_MAX_BYTES = 64 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024;
const STAGING_PREFIX = ".opencode-staging-";
const RESOLUTION_ERROR_MESSAGE = "No safe compatible OpenCode executable is available.";

export const OPEN_CODE_MINIMUM_VERSION = "1.17.19";
export const OPEN_CODE_FALLBACK_VERSION = "1.18.2";

export class OpenCodeResolutionError extends Error {
  constructor() {
    super(RESOLUTION_ERROR_MESSAGE);
    this.name = "OpenCodeResolutionError";
    this.code = "OPENCODE_UNAVAILABLE";
  }
}

export function parseStableOpenCodeVersion(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match = STABLE_VERSION_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const components = match.slice(1).map(Number);
  if (!components.every(Number.isSafeInteger)) {
    return null;
  }

  return Object.freeze(components);
}

const MINIMUM_COMPONENTS = parseStableOpenCodeVersion(OPEN_CODE_MINIMUM_VERSION);

export function supportsOpenCodeVersion(value) {
  const components = parseStableOpenCodeVersion(value);
  if (!components) {
    return false;
  }

  for (let index = 0; index < MINIMUM_COMPONENTS.length; index += 1) {
    if (components[index] > MINIMUM_COMPONENTS[index]) {
      return true;
    }
    if (components[index] < MINIMUM_COMPONENTS[index]) {
      return false;
    }
  }

  return true;
}

function sanitizedResolutionError() {
  return new OpenCodeResolutionError();
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsTraversal(value) {
  return value.split(/[\\/]+/u).some((part) => part === "." || part === "..");
}

function isDeviceNamespace(value) {
  return /^(?:\\\\|\/\/)[.?](?:\\|\/)/u.test(value) ||
    /^(?:\\\\|\/\/)globalroot(?:\\|\/)/iu.test(value);
}

function canonicalPath(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function lexicalExecutable(candidate) {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > 32_767 ||
    candidate.includes("\0") ||
    candidate.trim() !== candidate ||
    !path.isAbsolute(candidate) ||
    containsTraversal(candidate) ||
    isDeviceNamespace(candidate)
  ) {
    return null;
  }

  const normalized = path.resolve(candidate);
  if (path.extname(normalized).toLowerCase() !== ".exe") {
    return null;
  }
  return normalized;
}

function lexicalCommandShim(candidate) {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > 32_767 ||
    candidate.includes("\0") ||
    candidate.trim() !== candidate ||
    !path.isAbsolute(candidate) ||
    containsTraversal(candidate) ||
    isDeviceNamespace(candidate)
  ) {
    return null;
  }

  const normalized = path.resolve(candidate);
  return path.extname(normalized).toLowerCase() === ".cmd" ? normalized : null;
}

function lexicalManifest(candidate) {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > 32_767 ||
    candidate.includes("\0") ||
    candidate.trim() !== candidate ||
    !path.isAbsolute(candidate) ||
    containsTraversal(candidate) ||
    isDeviceNamespace(candidate)
  ) {
    return null;
  }

  const normalized = path.resolve(candidate);
  return path.basename(normalized).toLowerCase() === "package.json" ? normalized : null;
}

function lexicalNpmCli(candidate) {
  const normalized = boundedRoot(candidate);
  return normalized !== null && path.basename(normalized).toLowerCase() === "npm-cli.js"
    ? normalized
    : null;
}

async function inspectExecutable(candidate) {
  const entry = await lstat(candidate);
  const canonical = await realpath(candidate);
  return Object.freeze({
    canonicalPath: canonical,
    isRegularFile: entry.isFile(),
    isReparsePoint: entry.isSymbolicLink() || canonicalPath(canonical) !== canonicalPath(candidate),
  });
}

async function inspectManifestFile(candidate) {
  const entry = await lstat(candidate);
  const canonical = await realpath(candidate);
  return Object.freeze({
    canonicalPath: canonical,
    isRegularFile: entry.isFile(),
    isReparsePoint: entry.isSymbolicLink() || canonicalPath(canonical) !== canonicalPath(candidate),
    size: entry.size,
  });
}

async function inspectDirectory(candidate) {
  const entry = await lstat(candidate);
  const canonical = await realpath(candidate);
  return Object.freeze({
    canonicalPath: canonical,
    isDirectory: entry.isDirectory(),
    isReparsePoint: entry.isSymbolicLink() || canonicalPath(canonical) !== canonicalPath(candidate),
  });
}

async function inspectRegularFile(candidate) {
  const entry = await lstat(candidate);
  const canonical = await realpath(candidate);
  return Object.freeze({
    canonicalPath: canonical,
    isRegularFile: entry.isFile(),
    isReparsePoint: entry.isSymbolicLink() || canonicalPath(canonical) !== canonicalPath(candidate),
  });
}

async function readBoundedManifest(candidate) {
  const handle = await open(candidate, "r");
  try {
    const buffer = Buffer.alloc(MANIFEST_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > MANIFEST_MAX_BYTES
      ? null
      : buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function safeCandidate(candidate, inspectCandidate) {
  const normalized = lexicalExecutable(candidate);
  if (normalized === null) {
    return null;
  }

  let inspection;
  try {
    inspection = await inspectCandidate(normalized);
  } catch {
    return null;
  }

  if (
    !isPlainObject(inspection) ||
    inspection.isRegularFile !== true ||
    inspection.isReparsePoint !== false ||
    typeof inspection.canonicalPath !== "string"
  ) {
    return null;
  }

  const canonical = lexicalExecutable(inspection.canonicalPath);
  if (canonical === null || canonicalPath(canonical) !== canonicalPath(normalized)) {
    return null;
  }
  return canonical;
}

function environmentValue(environment, upperName, fallback) {
  if (environment === null || typeof environment !== "object") {
    return fallback;
  }
  for (const key of Reflect.ownKeys(environment)) {
    if (typeof key !== "string" || key.toUpperCase() !== upperName) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    if (
      descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string" &&
      !descriptor.value.includes("\0")
    ) {
      return descriptor.value;
    }
  }
  return fallback;
}

function safeProbeEnvironment(environment) {
  const systemRoot = environmentValue(environment, "SYSTEMROOT", "C:\\Windows");
  return Object.freeze({
    PATH: environmentValue(environment, "PATH", `${systemRoot}\\System32`),
    PATHEXT: environmentValue(environment, "PATHEXT", ".COM;.EXE;.BAT;.CMD"),
    SystemRoot: systemRoot,
    WINDIR: environmentValue(environment, "WINDIR", systemRoot),
  });
}

function executionOptions(environment, maxBuffer, timeout) {
  return Object.freeze({
    encoding: "utf8",
    env: environment,
    maxBuffer,
    shell: false,
    timeout,
    windowsHide: true,
  });
}

function defaultRun(file, argv, options) {
  return new Promise((resolvePromise) => {
    execFile(file, argv, options, (error, stdout = "", stderr = "") => {
      resolvePromise({
        exitCode: error === null ? 0 : (Number.isInteger(error?.code) ? error.code : 1),
        outputExceeded: error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        stderr: typeof stderr === "string" ? stderr : "",
        stdout: typeof stdout === "string" ? stdout : "",
        timedOut: error?.killed === true,
      });
    });
  });
}

function successfulOutput(result, maximumBytes) {
  if (
    !isPlainObject(result) ||
    typeof result.stdout !== "string" ||
    (result.stderr !== undefined && result.stderr !== "") ||
    (result.exitCode !== undefined && result.exitCode !== 0) ||
    result.outputExceeded === true ||
    result.timedOut === true ||
    Buffer.byteLength(result.stdout, "utf8") > maximumBytes
  ) {
    return null;
  }
  return result.stdout;
}

function classifiedWhereOutput(result) {
  if (
    !isPlainObject(result) ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    result.outputExceeded === true ||
    result.timedOut === true ||
    Buffer.byteLength(result.stdout, "utf8") > WHERE_MAX_BYTES ||
    Buffer.byteLength(result.stderr, "utf8") > WHERE_MAX_BYTES
  ) {
    return Object.freeze({ kind: "invalid" });
  }
  if (result.exitCode === 1 && result.stdout.length === 0) {
    return Object.freeze({ kind: "none" });
  }
  if (
    (result.exitCode === undefined || result.exitCode === 0) &&
    result.stderr.length === 0 &&
    result.stdout.length > 0
  ) {
    const lines = result.stdout.split(/\r?\n/u).filter((line) => line.length > 0);
    return lines.length > 0
      ? Object.freeze({ kind: "matches", lines: Object.freeze(lines) })
      : Object.freeze({ kind: "invalid" });
  }
  return Object.freeze({ kind: "invalid" });
}

async function lookupWhere(runWhere, whereExecutable, lookupName, whereOptions) {
  let result;
  try {
    result = await runWhere(whereExecutable, [lookupName], whereOptions);
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
  return classifiedWhereOutput(result);
}

function exactStableVersion(output) {
  let value;
  if (output.endsWith("\r\n")) {
    value = output.slice(0, -2);
  } else if (output.endsWith("\n")) {
    value = output.slice(0, -1);
  } else {
    return null;
  }
  if (value.includes("\r") || value.includes("\n") || parseStableOpenCodeVersion(value) === null) {
    return null;
  }
  return value;
}

async function probeCandidate(candidate, runVersion, options) {
  let result;
  try {
    result = await runVersion(candidate, ["--version"], options);
  } catch {
    return null;
  }
  const output = successfulOutput(result, VERSION_MAX_BYTES);
  if (output === null) {
    return null;
  }
  const version = exactStableVersion(output);
  return version !== null && supportsOpenCodeVersion(version) ? version : null;
}

function declaredNativeTarget(packageRoot, manifest) {
  if (
    !isPlainObject(manifest.bin) ||
    typeof manifest.bin.opencode !== "string" ||
    manifest.bin.opencode.length === 0 ||
    manifest.bin.opencode.length > 32_767 ||
    manifest.bin.opencode.includes("\0") ||
    manifest.bin.opencode.trim() !== manifest.bin.opencode ||
    path.isAbsolute(manifest.bin.opencode) ||
    isDeviceNamespace(manifest.bin.opencode) ||
    manifest.bin.opencode.split(/[\\/]+/u).some((part) => part === "..")
  ) {
    return null;
  }

  const expected = path.join(packageRoot, "bin", "opencode.exe");
  const declared = path.resolve(packageRoot, manifest.bin.opencode);
  return canonicalPath(declared) === canonicalPath(expected) ? expected : null;
}

async function resolveManifestCandidate({
  inspectCandidate,
  inspectManifest,
  manifestPath,
  readManifest,
  requiredVersion,
  runVersion,
  source,
  versionOptions,
}) {
  const normalizedManifest = lexicalManifest(manifestPath);
  if (normalizedManifest === null) {
    return null;
  }

  let inspection;
  try {
    inspection = await inspectManifest(normalizedManifest);
  } catch {
    return null;
  }
  if (
    !isPlainObject(inspection) ||
    inspection.isRegularFile !== true ||
    inspection.isReparsePoint !== false ||
    !Number.isSafeInteger(inspection.size) ||
    inspection.size < 0 ||
    inspection.size > MANIFEST_MAX_BYTES ||
    typeof inspection.canonicalPath !== "string"
  ) {
    return null;
  }

  const canonicalManifest = lexicalManifest(inspection.canonicalPath);
  if (
    canonicalManifest === null ||
    canonicalPath(canonicalManifest) !== canonicalPath(normalizedManifest)
  ) {
    return null;
  }

  let contents;
  try {
    contents = await readManifest(canonicalManifest, MANIFEST_MAX_BYTES);
  } catch {
    return null;
  }
  if (
    typeof contents !== "string" ||
    Buffer.byteLength(contents, "utf8") > MANIFEST_MAX_BYTES
  ) {
    return null;
  }

  let manifest;
  try {
    manifest = JSON.parse(contents);
  } catch {
    return null;
  }
  if (
    !isPlainObject(manifest) ||
    manifest.name !== "opencode-ai" ||
    typeof manifest.version !== "string" ||
    !supportsOpenCodeVersion(manifest.version) ||
    (requiredVersion !== null && manifest.version !== requiredVersion)
  ) {
    return null;
  }

  const executable = declaredNativeTarget(path.dirname(canonicalManifest), manifest);
  if (executable === null) {
    return null;
  }
  const candidate = await safeCandidate(executable, inspectCandidate);
  if (candidate === null) {
    return null;
  }
  const probedVersion = await probeCandidate(candidate, runVersion, versionOptions);
  if (probedVersion !== manifest.version) {
    return null;
  }
  return immutableResolution(candidate, source, probedVersion);
}

function immutableResolution(candidate, source, version) {
  return Object.freeze({ path: candidate, source, version });
}

export async function resolveOpenCodeExecutable(options = {}) {
  if (!isPlainObject(options)) {
    throw sanitizedResolutionError();
  }

  const runWhere = options.runWhere ?? defaultRun;
  const runVersion = options.runVersion ?? defaultRun;
  const inspectCandidate = options.inspectCandidate ?? inspectExecutable;
  if (
    typeof runWhere !== "function" ||
    typeof runVersion !== "function" ||
    typeof inspectCandidate !== "function"
  ) {
    throw sanitizedResolutionError();
  }

  const environment = safeProbeEnvironment(options.environment ?? process.env);
  const whereOptions = executionOptions(environment, WHERE_MAX_BYTES, WHERE_TIMEOUT_MS);
  const versionOptions = executionOptions(environment, VERSION_MAX_BYTES, VERSION_TIMEOUT_MS);

  if (options.explicitPath !== undefined) {
    const candidate = await safeCandidate(options.explicitPath, inspectCandidate);
    if (candidate !== null) {
      const version = await probeCandidate(candidate, runVersion, versionOptions);
      if (version !== null) {
        return immutableResolution(candidate, "explicit", version);
      }
    }
    throw sanitizedResolutionError();
  }

  let whereResult;
  try {
    const whereExecutable = path.join(environment.SystemRoot, "System32", "where.exe");
    whereResult = await runWhere(whereExecutable, ["opencode.exe"], whereOptions);
  } catch {
    throw sanitizedResolutionError();
  }
  const whereOutput = successfulOutput(whereResult, WHERE_MAX_BYTES);
  if (whereOutput === null) {
    throw sanitizedResolutionError();
  }

  const seen = new Set();
  for (const outputLine of whereOutput.split(/\r?\n/u)) {
    if (outputLine.length === 0) {
      continue;
    }
    const candidate = await safeCandidate(outputLine, inspectCandidate);
    if (candidate === null) {
      continue;
    }
    const identity = canonicalPath(candidate);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    const version = await probeCandidate(candidate, runVersion, versionOptions);
    if (version !== null) {
      return immutableResolution(candidate, "path", version);
    }
  }

  throw sanitizedResolutionError();
}

function boundedRoot(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_767 ||
    value.includes("\0") ||
    value.trim() !== value ||
    !path.isAbsolute(value) ||
    containsTraversal(value) ||
    isDeviceNamespace(value)
  ) {
    return null;
  }
  return path.resolve(value);
}

async function safeDirectory(candidate, inspectDirectoryPath) {
  const normalized = boundedRoot(candidate);
  if (normalized === null) {
    return null;
  }
  let inspection;
  try {
    inspection = await inspectDirectoryPath(normalized);
  } catch {
    return null;
  }
  if (
    !isPlainObject(inspection) ||
    inspection.isDirectory !== true ||
    inspection.isReparsePoint !== false ||
    typeof inspection.canonicalPath !== "string"
  ) {
    return null;
  }
  const canonical = boundedRoot(inspection.canonicalPath);
  return canonical !== null && canonicalPath(canonical) === canonicalPath(normalized)
    ? canonical
    : null;
}

async function safeNpmCli(candidate, expected, inspectNpmCli) {
  const normalized = lexicalNpmCli(candidate);
  if (
    normalized === null ||
    canonicalPath(normalized) !== canonicalPath(expected)
  ) {
    return null;
  }
  let inspection;
  try {
    inspection = await inspectNpmCli(normalized);
  } catch {
    return null;
  }
  if (
    !isPlainObject(inspection) ||
    inspection.isRegularFile !== true ||
    inspection.isReparsePoint !== false ||
    typeof inspection.canonicalPath !== "string"
  ) {
    return null;
  }
  const canonical = lexicalNpmCli(inspection.canonicalPath);
  return canonical !== null && canonicalPath(canonical) === canonicalPath(normalized)
    ? canonical
    : null;
}

async function pathEntryExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isOwnedStagePath(candidate, runtimeParent) {
  const normalized = boundedRoot(candidate);
  if (normalized === null) {
    return false;
  }
  const parentMatches = canonicalPath(path.dirname(normalized)) === canonicalPath(runtimeParent);
  const name = path.basename(normalized);
  return parentMatches && name.startsWith(STAGING_PREFIX) && name.length > STAGING_PREFIX.length;
}

function cleanInstallResult(result) {
  return isPlainObject(result) &&
    typeof result.stdout === "string" &&
    typeof result.stderr === "string" &&
    result.exitCode === 0 &&
    result.outputExceeded !== true &&
    result.timedOut !== true &&
    Buffer.byteLength(result.stdout, "utf8") <= INSTALL_MAX_BYTES &&
    Buffer.byteLength(result.stderr, "utf8") <= INSTALL_MAX_BYTES;
}

async function cleanupOwnedStage(stagePath, runtimeParent, inspectDirectoryPath, removeStage) {
  if (!isOwnedStagePath(stagePath, runtimeParent)) {
    return;
  }
  const canonicalStage = await safeDirectory(stagePath, inspectDirectoryPath);
  if (canonicalStage === null || canonicalPath(canonicalStage) !== canonicalPath(stagePath)) {
    return;
  }
  await removeStage(stagePath);
}

function defaultCreateDirectory(candidate) {
  return mkdir(candidate);
}

function defaultMakeStage(prefix) {
  return mkdtemp(prefix);
}

function defaultPublishStage(stagePath, destination) {
  return rename(stagePath, destination);
}

function defaultRemoveStage(stagePath) {
  return rm(stagePath, { recursive: true, force: true });
}

function manifestFromCommandShim(commandShim) {
  const shimDirectory = path.dirname(commandShim);
  if (
    path.basename(shimDirectory).toLowerCase() === ".bin" &&
    path.basename(path.dirname(shimDirectory)).toLowerCase() === "node_modules"
  ) {
    return path.join(path.dirname(shimDirectory), "opencode-ai", "package.json");
  }
  return path.join(shimDirectory, "node_modules", "opencode-ai", "package.json");
}

async function prepareProjectFallback({
  createDirectory,
  environment,
  inspectCandidate,
  inspectDirectoryPath,
  inspectManifest,
  inspectNpmCli,
  makeStage,
  nodeExecutable,
  npmCliPath,
  publishStage,
  readManifest,
  removeStage,
  runInstall,
  runVersion,
  runtimeRoot,
  studioRoot,
  versionOptions,
}) {
  let stagePath = null;
  let published = false;
  const runtimeParent = path.dirname(runtimeRoot);

  try {
    const canonicalStudio = await safeDirectory(studioRoot, inspectDirectoryPath);
    if (canonicalStudio === null || canonicalPath(canonicalStudio) !== canonicalPath(studioRoot)) {
      throw sanitizedResolutionError();
    }
    if (await pathEntryExists(runtimeRoot)) {
      throw sanitizedResolutionError();
    }

    const canonicalNode = await safeCandidate(nodeExecutable, inspectCandidate);
    if (canonicalNode === null) {
      throw sanitizedResolutionError();
    }
    const expectedNpmCli = path.join(
      path.dirname(canonicalNode),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    const canonicalNpmCli = await safeNpmCli(npmCliPath, expectedNpmCli, inspectNpmCli);
    if (canonicalNpmCli === null) {
      throw sanitizedResolutionError();
    }

    let canonicalRuntimeParent = await safeDirectory(runtimeParent, inspectDirectoryPath);
    if (canonicalRuntimeParent === null) {
      if (await pathEntryExists(runtimeParent)) {
        throw sanitizedResolutionError();
      }
      try {
        await createDirectory(runtimeParent);
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
      }
      canonicalRuntimeParent = await safeDirectory(runtimeParent, inspectDirectoryPath);
    }
    if (
      canonicalRuntimeParent === null ||
      canonicalPath(canonicalRuntimeParent) !== canonicalPath(runtimeParent)
    ) {
      throw sanitizedResolutionError();
    }

    stagePath = await makeStage(path.join(runtimeParent, STAGING_PREFIX));
    if (!isOwnedStagePath(stagePath, runtimeParent)) {
      throw sanitizedResolutionError();
    }
    const canonicalStage = await safeDirectory(stagePath, inspectDirectoryPath);
    if (canonicalStage === null || canonicalPath(canonicalStage) !== canonicalPath(stagePath)) {
      throw sanitizedResolutionError();
    }

    const installArgv = Object.freeze([
      canonicalNpmCli,
      "install",
      "--prefix",
      canonicalStage,
      "--no-save",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
      "--no-progress",
      "--loglevel=error",
      `opencode-ai@${OPEN_CODE_FALLBACK_VERSION}`,
    ]);
    const installOptions = executionOptions(environment, INSTALL_MAX_BYTES, INSTALL_TIMEOUT_MS);
    const installResult = await runInstall(canonicalNode, installArgv, installOptions);
    if (!cleanInstallResult(installResult)) {
      throw sanitizedResolutionError();
    }

    const stagedResolution = await resolveManifestCandidate({
      inspectCandidate,
      inspectManifest,
      manifestPath: path.join(canonicalStage, "node_modules", "opencode-ai", "package.json"),
      readManifest,
      requiredVersion: OPEN_CODE_FALLBACK_VERSION,
      runVersion,
      source: "project",
      versionOptions,
    });
    if (stagedResolution === null) {
      throw sanitizedResolutionError();
    }

    try {
      await publishStage(canonicalStage, runtimeRoot);
      published = true;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) {
        throw error;
      }
      const winnerResolution = await resolveManifestCandidate({
        inspectCandidate,
        inspectManifest,
        manifestPath: path.join(runtimeRoot, "node_modules", "opencode-ai", "package.json"),
        readManifest,
        requiredVersion: OPEN_CODE_FALLBACK_VERSION,
        runVersion,
        source: "project",
        versionOptions,
      });
      if (winnerResolution === null) {
        throw sanitizedResolutionError();
      }
      return winnerResolution;
    }
    const publishedResolution = await resolveManifestCandidate({
      inspectCandidate,
      inspectManifest,
      manifestPath: path.join(runtimeRoot, "node_modules", "opencode-ai", "package.json"),
      readManifest,
      requiredVersion: OPEN_CODE_FALLBACK_VERSION,
      runVersion,
      source: "project",
      versionOptions,
    });
    if (publishedResolution === null) {
      throw sanitizedResolutionError();
    }
    return publishedResolution;
  } catch {
    throw sanitizedResolutionError();
  } finally {
    if (stagePath !== null && !published) {
      try {
        await cleanupOwnedStage(stagePath, runtimeParent, inspectDirectoryPath, removeStage);
      } catch {
        // Preserve the sanitized preparation failure.
      }
    }
  }
}

export async function resolveOpenCodeInstallation(options = {}) {
  if (
    !isPlainObject(options) ||
    (options.mode !== "check" && options.mode !== "prepare")
  ) {
    throw sanitizedResolutionError();
  }

  const studioRoot = boundedRoot(options.studioRoot);
  const runtimeRoot = boundedRoot(options.runtimeRoot);
  if (
    studioRoot === null ||
    runtimeRoot === null ||
    canonicalPath(runtimeRoot) !== canonicalPath(path.join(studioRoot, ".runtime", "opencode"))
  ) {
    throw sanitizedResolutionError();
  }

  const runWhere = options.runWhere ?? defaultRun;
  const runVersion = options.runVersion ?? defaultRun;
  const inspectCandidate = options.inspectCandidate ?? inspectExecutable;
  const inspectManifest = options.inspectManifest ?? inspectManifestFile;
  const readManifest = options.readManifest ?? readBoundedManifest;
  if (
    typeof runWhere !== "function" ||
    typeof runVersion !== "function" ||
    typeof inspectCandidate !== "function" ||
    typeof inspectManifest !== "function" ||
    typeof readManifest !== "function"
  ) {
    throw sanitizedResolutionError();
  }

  const environment = safeProbeEnvironment(options.environment ?? process.env);
  const whereOptions = executionOptions(environment, WHERE_MAX_BYTES, WHERE_TIMEOUT_MS);
  const versionOptions = executionOptions(environment, VERSION_MAX_BYTES, VERSION_TIMEOUT_MS);

  if (options.explicitPath !== undefined) {
    const candidate = await safeCandidate(options.explicitPath, inspectCandidate);
    if (candidate !== null) {
      const version = await probeCandidate(candidate, runVersion, versionOptions);
      if (version !== null) {
        return immutableResolution(candidate, "explicit", version);
      }
    }
    throw sanitizedResolutionError();
  }

  const projectPackage = path.join(runtimeRoot, "node_modules", "opencode-ai");
  const projectResolution = await resolveManifestCandidate({
    inspectCandidate,
    inspectManifest,
    manifestPath: path.join(projectPackage, "package.json"),
    readManifest,
    requiredVersion: OPEN_CODE_FALLBACK_VERSION,
    runVersion,
    source: "project",
    versionOptions,
  });
  if (projectResolution !== null) {
    return projectResolution;
  }

  const whereExecutable = path.join(environment.SystemRoot, "System32", "where.exe");
  const nativeLookup = await lookupWhere(runWhere, whereExecutable, "opencode.exe", whereOptions);
  if (nativeLookup.kind === "invalid") {
    throw sanitizedResolutionError();
  }

  const seenExecutables = new Set([
    canonicalPath(path.join(projectPackage, "bin", "opencode.exe")),
  ]);
  if (nativeLookup.kind === "matches") {
    for (const outputLine of nativeLookup.lines) {
      const candidate = await safeCandidate(outputLine, inspectCandidate);
      if (candidate === null) {
        continue;
      }
      const identity = canonicalPath(candidate);
      if (seenExecutables.has(identity)) {
        continue;
      }
      seenExecutables.add(identity);
      const version = await probeCandidate(candidate, runVersion, versionOptions);
      if (version !== null) {
        return immutableResolution(candidate, "path", version);
      }
    }
  }

  const commandLookup = await lookupWhere(runWhere, whereExecutable, "opencode.cmd", whereOptions);
  if (commandLookup.kind === "invalid") {
    throw sanitizedResolutionError();
  }
  if (commandLookup.kind === "matches") {
    const seenManifests = new Set();
    for (const outputLine of commandLookup.lines) {
      const commandShim = lexicalCommandShim(outputLine);
      if (commandShim === null) {
        continue;
      }
      const manifestPath = manifestFromCommandShim(commandShim);
      const manifestIdentity = canonicalPath(manifestPath);
      if (seenManifests.has(manifestIdentity)) {
        continue;
      }
      seenManifests.add(manifestIdentity);
      const resolution = await resolveManifestCandidate({
        inspectCandidate,
        inspectManifest,
        manifestPath,
        readManifest,
        requiredVersion: null,
        runVersion,
        source: "npm-global",
        versionOptions,
      });
      if (resolution === null) {
        continue;
      }
      const identity = canonicalPath(resolution.path);
      if (seenExecutables.has(identity)) {
        continue;
      }
      seenExecutables.add(identity);
      return resolution;
    }
  }

  if (options.mode === "check") {
    throw sanitizedResolutionError();
  }

  const createDirectory = options.createDirectory ?? defaultCreateDirectory;
  const inspectDirectoryPath = options.inspectDirectory ?? inspectDirectory;
  const inspectNpmCli = options.inspectNpmCli ?? inspectRegularFile;
  const makeStage = options.makeStage ?? defaultMakeStage;
  const publishStage = options.publishStage ?? defaultPublishStage;
  const removeStage = options.removeStage ?? defaultRemoveStage;
  const runInstall = options.runInstall ?? defaultRun;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  if (typeof nodeExecutable !== "string") {
    throw sanitizedResolutionError();
  }
  const npmCliPath = options.npmCliPath ?? path.join(
    path.dirname(nodeExecutable),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (
    typeof createDirectory !== "function" ||
    typeof inspectDirectoryPath !== "function" ||
    typeof inspectNpmCli !== "function" ||
    typeof makeStage !== "function" ||
    typeof publishStage !== "function" ||
    typeof removeStage !== "function" ||
    typeof runInstall !== "function"
  ) {
    throw sanitizedResolutionError();
  }

  return prepareProjectFallback({
    createDirectory,
    environment,
    inspectCandidate,
    inspectDirectoryPath,
    inspectManifest,
    inspectNpmCli,
    makeStage,
    nodeExecutable,
    npmCliPath,
    publishStage,
    readManifest,
    removeStage,
    runInstall,
    runVersion,
    runtimeRoot,
    studioRoot,
    versionOptions,
  });
}
