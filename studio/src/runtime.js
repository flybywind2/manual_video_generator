import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { BrowserRuntime } from "./adapters/browser-runtime.js";
import { FfmpegAdapter } from "./adapters/ffmpeg.js";
import { HyperframesAdapter } from "./adapters/hyperframes.js";
import { OpenCodeServer } from "./adapters/opencode-server.js";
import { ExecutionLock } from "./jobs/execution-lock.js";
import { QualityGate } from "./media/quality-gate.js";
import {
  resolveOpenCodeExecutable,
  supportsOpenCodeVersion,
} from "./runtime/opencode-installation.js";
import { CredentialVault } from "./security/credential-vault.js";

const WHERE_TIMEOUT_MS = 5_000;
const WHERE_MAX_BYTES = 64 * 1024;
const WHERE_MAX_RESULTS = 64;
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const WHERE_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "WINDIR",
]);

export class RuntimeConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RuntimeConfigurationError";
    this.code = code;
  }
}

export class RuntimeCloseError extends AggregateError {
  constructor(failures) {
    const immutableFailures = Object.freeze(
      failures.map(({ component, reason }) => Object.freeze({ component, reason })),
    );
    super(
      immutableFailures.map(({ reason }) => reason),
      "One or more production runtimes could not be stopped safely.",
    );
    this.name = "RuntimeCloseError";
    this.code = "RUNTIME_CLOSE_FAILED";
    this.failures = immutableFailures;
  }
}

function configurationError(code, message) {
  return new RuntimeConfigurationError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalPath(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function containsTraversal(value) {
  return value.split(/[\\/]+/u).includes("..");
}

function isDeviceNamespace(value) {
  return /^(?:\\\\|\/\/)[.?](?:\\|\/)/u.test(value) ||
    /^(?:\\\\|\/\/)globalroot(?:\\|\/)/iu.test(value);
}

async function inspectExecutable(candidate, requireExe) {
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
    throw new Error("unsafe executable path");
  }
  const normalized = path.resolve(candidate);
  if (requireExe && path.extname(normalized).toLowerCase() !== ".exe") {
    throw new Error("unexpected executable extension");
  }
  const entry = await lstat(normalized);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error("executable is not a regular file");
  }
  const actual = await realpath(normalized);
  if (canonicalPath(actual) !== canonicalPath(normalized)) {
    throw new Error("executable path contains a reparse point");
  }
  await access(actual, fsConstants.X_OK);
  return actual;
}

function safeWhereEnvironment(environment) {
  if (environment === null || typeof environment !== "object") {
    return Object.freeze({});
  }
  const safe = {};
  for (const key of Reflect.ownKeys(environment)) {
    if (typeof key !== "string" || !WHERE_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      descriptor.value.includes("\0")
    ) {
      continue;
    }
    safe[key] = descriptor.value;
  }
  return Object.freeze(safe);
}

function defaultRunWhere({ command, env }) {
  return new Promise((resolvePromise) => {
    if (process.platform !== "win32") {
      resolvePromise({
        exitCode: 1,
        outputExceeded: false,
        stderr: "",
        stdout: "",
        timedOut: false,
      });
      return;
    }
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const whereExecutable = path.join(systemRoot, "System32", "where.exe");
    execFile(
      whereExecutable,
      [command],
      {
        encoding: "utf8",
        env,
        maxBuffer: WHERE_MAX_BYTES,
        shell: false,
        timeout: WHERE_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout = "", stderr = "") => {
        resolvePromise({
          exitCode: error === null ? 0 : (Number.isInteger(error?.code) ? error.code : 1),
          outputExceeded: error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          stderr: typeof stderr === "string" ? stderr : "",
          stdout: typeof stdout === "string" ? stdout : "",
          timedOut: error?.killed === true && error?.signal !== null,
        });
      },
    );
  });
}

function validateResolverOptions(options) {
  if (!isPlainObject(options)) {
    throw configurationError("INVALID_EXECUTABLE_REQUEST", "The executable lookup request is invalid.");
  }
  const allowed = new Set(["command", "env", "override", "requireExe", "runWhere"]);
  if (Reflect.ownKeys(options).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw configurationError("INVALID_EXECUTABLE_REQUEST", "The executable lookup request is invalid.");
  }
  const command = options.command;
  const override = options.override;
  const requireExe = options.requireExe ?? false;
  const env = options.env ?? process.env;
  const runWhere = options.runWhere ?? defaultRunWhere;
  if (
    typeof command !== "string" ||
    !COMMAND_NAME.test(command) ||
    (override !== undefined && typeof override !== "string") ||
    typeof requireExe !== "boolean" ||
    (env === null || typeof env !== "object") ||
    typeof runWhere !== "function"
  ) {
    throw configurationError("INVALID_EXECUTABLE_REQUEST", "The executable lookup request is invalid.");
  }
  return { command, env, override, requireExe, runWhere };
}

function validWhereResult(result) {
  return isPlainObject(result) &&
    Number.isInteger(result.exitCode) &&
    typeof result.stdout === "string" &&
    Buffer.byteLength(result.stdout, "utf8") <= WHERE_MAX_BYTES &&
    typeof result.stderr === "string" &&
    result.outputExceeded === false &&
    result.timedOut === false;
}

export async function resolveExecutablePath(options) {
  const { command, env, override, requireExe, runWhere } = validateResolverOptions(options);
  if (override !== undefined) {
    try {
      return await inspectExecutable(override, requireExe);
    } catch {
      throw configurationError("UNSAFE_EXECUTABLE_PATH", "The configured executable path is unsafe.");
    }
  }

  let result;
  try {
    result = await runWhere({
      command,
      env: safeWhereEnvironment(env),
      shell: false,
      timeoutMs: WHERE_TIMEOUT_MS,
    });
  } catch {
    throw configurationError("EXECUTABLE_NOT_FOUND", "The required executable was not found safely.");
  }
  if (!validWhereResult(result) || result.exitCode !== 0) {
    throw configurationError("EXECUTABLE_NOT_FOUND", "The required executable was not found safely.");
  }
  const candidates = result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .slice(0, WHERE_MAX_RESULTS);
  for (const candidate of candidates) {
    try {
      return await inspectExecutable(candidate, requireExe);
    } catch {
      // A PATH lookup may return scripts before the approved executable.
    }
  }
  throw configurationError("EXECUTABLE_NOT_FOUND", "The required executable was not found safely.");
}

function readEnvironmentOverride(environment, name) {
  const matches = [];
  for (const key of Reflect.ownKeys(environment)) {
    if (typeof key !== "string" || key.toUpperCase() !== name) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw configurationError("INVALID_RUNTIME_CONFIG", "The production runtime configuration is invalid.");
    }
    matches.push(descriptor.value);
  }
  if (matches.length > 1 && new Set(matches).size > 1) {
    throw configurationError("INVALID_RUNTIME_CONFIG", "The production runtime configuration is invalid.");
  }
  return matches[0] === "" ? undefined : matches[0];
}

function snapshotEnvironment(environment) {
  const snapshot = {};
  const seen = new Set();
  for (const key of Reflect.ownKeys(environment)) {
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    if (
      typeof key !== "string" ||
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      typeof descriptor.value !== "string" ||
      key.includes("=") ||
      key.includes("\0") ||
      descriptor.value.includes("\0") ||
      seen.has(key.toUpperCase())
    ) {
      throw configurationError("INVALID_RUNTIME_CONFIG", "The production runtime configuration is invalid.");
    }
    seen.add(key.toUpperCase());
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function validateFactoryOptions(options) {
  if (!isPlainObject(options)) {
    throw configurationError("INVALID_RUNTIME_CONFIG", "The production runtime configuration is invalid.");
  }
  const allowed = new Set(["config", "env", "producerFactory"]);
  if (Reflect.ownKeys(options).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw configurationError("INVALID_RUNTIME_CONFIG", "The production runtime configuration is invalid.");
  }
  const config = options.config;
  const env = options.env ?? process.env;
  const producerFactory = options.producerFactory;
  if (
    !isPlainObject(config) ||
    typeof config.root !== "string" ||
    !path.isAbsolute(config.root) ||
    path.resolve(config.root) !== config.root ||
    env === null ||
    typeof env !== "object" ||
    (producerFactory !== undefined && typeof producerFactory !== "function")
  ) {
    throw configurationError("INVALID_RUNTIME_CONFIG", "The production runtime configuration is invalid.");
  }
  return { config, env, producerFactory };
}

function producerStop(producer) {
  if (producer === null) {
    return Promise.resolve();
  }
  if (typeof producer.close === "function") {
    return Promise.resolve().then(() => producer.close());
  }
  if (typeof producer.stop === "function") {
    return Promise.resolve().then(() => producer.stop());
  }
  return Promise.resolve();
}

async function createProductionRuntimeInternal(options, openCodeRunVersion) {
  const { config, env: rawEnvironment, producerFactory } = validateFactoryOptions(options);
  const env = snapshotEnvironment(rawEnvironment);
  const root = config.root;
  const configuredOpenCodePath = readEnvironmentOverride(env, "MANUAL_STUDIO_OPENCODE_PATH");
  const configuredOpenCodeVersion = readEnvironmentOverride(env, "MANUAL_STUDIO_OPENCODE_VERSION");
  if (
    configuredOpenCodePath === undefined ||
    configuredOpenCodeVersion === undefined ||
    !supportsOpenCodeVersion(configuredOpenCodeVersion)
  ) {
    throw configurationError(
      "INVALID_OPENCODE_SELECTION",
      "The selected OpenCode runtime is invalid.",
    );
  }
  if (path.extname(configuredOpenCodePath).toLowerCase() !== ".exe") {
    throw configurationError("UNSAFE_EXECUTABLE_PATH", "The configured executable path is unsafe.");
  }

  const [openCodeSelection, ffmpeg, ffprobe] = await Promise.all([
    resolveOpenCodeExecutable({
      environment: env,
      explicitPath: configuredOpenCodePath,
      ...(openCodeRunVersion === undefined ? {} : { runVersion: openCodeRunVersion }),
    }).catch(() => {
      throw configurationError(
        "INVALID_OPENCODE_SELECTION",
        "The selected OpenCode runtime is invalid.",
      );
    }),
    resolveExecutablePath({
      command: process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
      env,
      override: readEnvironmentOverride(env, "MANUAL_STUDIO_FFMPEG_PATH"),
    }),
    resolveExecutablePath({
      command: process.platform === "win32" ? "ffprobe.exe" : "ffprobe",
      env,
      override: readEnvironmentOverride(env, "MANUAL_STUDIO_FFPROBE_PATH"),
    }),
  ]);
  if (openCodeSelection.version !== configuredOpenCodeVersion) {
    throw configurationError(
      "INVALID_OPENCODE_SELECTION",
      "The selected OpenCode runtime is invalid.",
    );
  }
  const opencode = openCodeSelection.path;
  const paths = Object.freeze({
    credentials: path.join(root, "data", "credentials"),
    ffmpeg,
    ffprobe,
    opencode,
    playwrightMcp: path.join(root, "node_modules", "@playwright", "mcp"),
  });

  const credentialVault = new CredentialVault({ root: paths.credentials });
  const browserRuntime = new BrowserRuntime({
    env,
    mcpPackageDir: paths.playwrightMcp,
    port: 8931,
    studioRoot: root,
  });
  const openCodeServer = new OpenCodeServer({
    env,
    expectedVersion: openCodeSelection.version,
    opencodePath: paths.opencode,
    port: 4096,
    studioRoot: root,
  });
  const executionLock = new ExecutionLock();
  const adapters = Object.freeze({
    ffmpeg: new FfmpegAdapter({
      environment: env,
      executable: paths.ffmpeg,
      probeExecutable: paths.ffprobe,
    }),
    hyperframes: new HyperframesAdapter({
      environment: env,
      nodeExecutable: process.execPath,
      studioRoot: root,
    }),
    qualityGate: new QualityGate({
      environment: env,
      ffprobeExecutable: paths.ffprobe,
    }),
  });
  const runtime = {
    browserRuntime,
    credentialVault,
    executionLock,
    openCodeServer,
    producer: null,
  };
  if (producerFactory !== undefined) {
    const producer = await producerFactory(Object.freeze({ adapters, paths, runtime }));
    if (producer === null || typeof producer !== "object") {
      throw configurationError("INVALID_PRODUCER", "The production media producer is invalid.");
    }
    runtime.producer = producer;
  }
  Object.freeze(runtime);

  const stops = Object.freeze({
    browser: () => browserRuntime.stop(),
    opencode: () => openCodeServer.stop(),
    producer: () => producerStop(runtime.producer),
  });
  let closing;
  const close = () => {
    if (closing !== undefined) {
      return closing;
    }
    const entries = Object.entries(stops);
    closing = Promise.allSettled(
      entries.map(([, stop]) => Promise.resolve().then(stop)),
    ).then((results) => {
      const failures = results.flatMap((result, index) => result.status === "rejected"
        ? [{ component: entries[index][0], reason: result.reason }]
        : []);
      if (failures.length > 0) {
        throw new RuntimeCloseError(failures);
      }
    });
    return closing;
  };

  return Object.freeze({ adapters, close, paths, runtime, stops });
}

function inspectRuntimeFactoryDependencies(dependencies) {
  if (
    !isPlainObject(dependencies) ||
    Reflect.ownKeys(dependencies).some(
      (key) => typeof key !== "string" || key !== "openCodeRunVersion",
    )
  ) {
    throw configurationError("INVALID_RUNTIME_CONFIG", "The production runtime configuration is invalid.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(dependencies, "openCodeRunVersion");
  if (descriptor === undefined) {
    return undefined;
  }
  if (
    !("value" in descriptor) ||
    descriptor.enumerable !== true ||
    typeof descriptor.value !== "function"
  ) {
    throw configurationError("INVALID_RUNTIME_CONFIG", "The production runtime configuration is invalid.");
  }
  return descriptor.value;
}

export function createProductionRuntimeFactory(dependencies = {}) {
  const openCodeRunVersion = inspectRuntimeFactoryDependencies(dependencies);
  return (options) => createProductionRuntimeInternal(options, openCodeRunVersion);
}

export const createProductionRuntime = createProductionRuntimeFactory();
