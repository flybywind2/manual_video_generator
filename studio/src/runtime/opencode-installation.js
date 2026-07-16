import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

const WHERE_TIMEOUT_MS = 5_000;
const VERSION_TIMEOUT_MS = 5_000;
const WHERE_MAX_BYTES = 64 * 1024;
const VERSION_MAX_BYTES = 4 * 1024;
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

async function inspectExecutable(candidate) {
  const entry = await lstat(candidate);
  const canonical = await realpath(candidate);
  return Object.freeze({
    canonicalPath: canonical,
    isRegularFile: entry.isFile(),
    isReparsePoint: entry.isSymbolicLink() || canonicalPath(canonical) !== canonicalPath(candidate),
  });
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
