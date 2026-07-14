import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { SupertonicClient } from "./adapters/supertonic-client.js";

const execFileAsync = promisify(execFile);
const SAFE_REASONS = new Set([
  "not_found",
  "lookup_failed",
  "manifest_invalid",
  "entry_invalid",
  "probe_failed",
  "version_mismatch",
]);

class RuntimeProbeError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const TOOL_SPECS = Object.freeze([
  Object.freeze({ key: "opencode", command: "opencode", expectedVersionKey: "opencode" }),
  Object.freeze({
    key: "playwrightMcp",
    packageName: "@playwright/mcp",
    expectedVersionKey: "playwrightMcp",
  }),
  Object.freeze({
    key: "python",
    expectedVersionKey: "python",
    candidates: Object.freeze([
      Object.freeze({ command: "python3.13", args: Object.freeze([]) }),
      Object.freeze({ command: "py.exe", args: Object.freeze(["-3.13"]) }),
      Object.freeze({ command: "python3", args: Object.freeze([]) }),
      Object.freeze({ command: "python", args: Object.freeze([]) }),
    ]),
  }),
  Object.freeze({ key: "supertonic", command: "supertonic", expectedVersionKey: "supertonic" }),
  Object.freeze({
    key: "hyperframes",
    packageName: "hyperframes",
    expectedVersionKey: "hyperframes",
  }),
  Object.freeze({ key: "ffmpeg", command: "ffmpeg", expectedVersionKey: "ffmpeg" }),
  Object.freeze({ key: "ffprobe", command: "ffprobe", expectedVersionKey: "ffprobe" }),
]);

function freezeCheck(check) {
  return Object.freeze(check);
}

function safeReason(error, fallback) {
  return SAFE_REASONS.has(error?.reason) ? error.reason : fallback;
}

function normalizeVersion(output) {
  const match = String(output ?? "").match(/(?:^|[^\d])(\d+\.\d+(?:\.\d+)?)(?:[^\d]|$)/);
  return match?.[1] ?? null;
}

function packageDirectory(root, packageName) {
  return path.join(root, "node_modules", ...packageName.split("/"));
}

async function readPackageManifest(config, packageName) {
  const manifestPath = path.join(packageDirectory(config.root, packageName), "package.json");
  let source;
  try {
    source = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new RuntimeProbeError("manifest_invalid");
  }

  try {
    const manifest = JSON.parse(source);
    if (typeof manifest.version !== "string") {
      throw new RuntimeProbeError("manifest_invalid");
    }
    return manifest;
  } catch (error) {
    if (error instanceof RuntimeProbeError) {
      throw error;
    }
    throw new RuntimeProbeError("manifest_invalid");
  }
}

async function resolvePackageBin(config, packageName) {
  const directory = packageDirectory(config.root, packageName);
  const manifest = await readPackageManifest(config, packageName);
  if (!manifest) {
    return null;
  }

  const bin = typeof manifest.bin === "string" ? manifest.bin : Object.values(manifest.bin ?? {})[0];
  if (typeof bin !== "string") {
    throw new RuntimeProbeError("entry_invalid");
  }

  const executable = path.resolve(directory, bin);
  const relative = path.relative(directory, executable);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !/\.(?:c|m)?js$/i.test(executable)) {
    throw new RuntimeProbeError("entry_invalid");
  }

  try {
    await access(executable, fsConstants.R_OK);
  } catch {
    throw new RuntimeProbeError("entry_invalid");
  }

  return {
    executable,
    args: [],
    packageVersion: manifest.version,
  };
}

function firstLocatorResult(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

async function locateCommand(
  command,
  { locatorExec = execFileAsync, platform = process.platform } = {},
) {
  const locator = platform === "win32" ? "where.exe" : "which";
  try {
    const { stdout } = await locatorExec(locator, [command], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const result = firstLocatorResult(stdout);
    if (!result) {
      throw new RuntimeProbeError("lookup_failed");
    }
    return result;
  } catch (error) {
    if (error instanceof RuntimeProbeError) {
      throw error;
    }

    if (
      error?.code === 1
      && error?.killed !== true
      && !error?.signal
      && !firstLocatorResult(error?.stdout)
    ) {
      return null;
    }
    throw new RuntimeProbeError("lookup_failed");
  }
}

async function defaultLocate(_tool, { config, spec, candidate, findExecutable }) {
  if (spec.packageName) {
    return resolvePackageBin(config, spec.packageName);
  }

  if (spec.key === "supertonic") {
    const executable = path.join(
      config.root,
      ".runtime",
      "supertonic",
      "venv",
      process.platform === "win32" ? "Scripts" : "bin",
      process.platform === "win32" ? "supertonic.exe" : "supertonic",
    );
    try {
      const entry = await lstat(executable);
      if (entry.isFile() && !entry.isSymbolicLink()) {
        await access(executable, fsConstants.R_OK);
        return { executable, args: [] };
      }
    } catch {
      // A global exact package remains a supported discovery fallback.
    }
  }

  const executable = await findExecutable(candidate.command);
  if (!executable) {
    return null;
  }
  return {
    executable,
    args: [...(candidate.args ?? [])],
  };
}

async function runVersionCommand(executable, args) {
  const { stdout, stderr } = await execFileAsync(executable, args, {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return `${stdout}\n${stderr}`;
}

async function defaultVersion(tool, executable, { config, spec, location, runCommand }) {
  if (spec.packageName) {
    const expected = expectedVersion(spec, config);
    const manifestVersion = normalizeVersion(location.packageVersion);
    if (manifestVersion !== expected) {
      return manifestVersion;
    }
    return runCommand(process.execPath, [executable, "--version"]);
  }

  const probeArgs = tool === "ffmpeg" || tool === "ffprobe"
    ? ["-version"]
    : tool === "supertonic"
      ? ["version"]
      : ["--version"];
  return runCommand(executable, [...location.args, ...probeArgs]);
}

function expectedVersion(spec, config) {
  return spec.expectedVersionKey ? config.versions[spec.expectedVersionKey] : spec.expected;
}

function matchesExpected(actual, expected) {
  if (!actual) {
    return false;
  }
  if (expected === "installed") {
    return true;
  }
  return actual === expected;
}

function candidatesFor(spec) {
  return spec.candidates ?? [
    Object.freeze({
      command: spec.command,
      args: Object.freeze([]),
    }),
  ];
}

function normalizeLocation(result, candidate) {
  if (typeof result === "string" && result) {
    return {
      executable: result,
      args: [...(candidate.args ?? [])],
    };
  }
  if (result && typeof result.executable === "string" && result.executable) {
    return {
      ...result,
      args: [...(result.args ?? candidate.args ?? [])],
    };
  }
  return null;
}

async function inspectTool(spec, config, dependencies) {
  const { findExecutable, locate, runCommand, version } = dependencies;
  const expected = expectedVersion(spec, config);
  let mismatch = null;

  for (const candidate of candidatesFor(spec)) {
    let location;
    try {
      const result = await locate(spec.key, {
        config,
        spec,
        candidate,
        findExecutable,
      });
      location = normalizeLocation(result, candidate);
    } catch (error) {
      mismatch = freezeCheck({
        status: "mismatch",
        expected,
        actual: null,
        reason: safeReason(error, "lookup_failed"),
      });
      continue;
    }

    if (!location) {
      continue;
    }

    try {
      const actual = normalizeVersion(
        await version(spec.key, location.executable, {
          config,
          spec,
          candidate,
          location,
          runCommand,
        }),
      );
      if (matchesExpected(actual, expected)) {
        return freezeCheck({ status: "ready", expected, actual });
      }
      mismatch = freezeCheck({
        status: "mismatch",
        expected,
        actual,
        reason: "version_mismatch",
      });
    } catch (error) {
      mismatch = freezeCheck({
        status: "mismatch",
        expected,
        actual: null,
        reason: safeReason(error, "probe_failed"),
      });
    }
  }

  return mismatch ?? freezeCheck({
    status: "missing",
    expected,
    actual: null,
    reason: "not_found",
  });
}

export async function inspectRuntime({
  config,
  nodeVersion = process.version,
  locatorExec = execFileAsync,
  platform = process.platform,
  findExecutable,
  locate = defaultLocate,
  runCommand = runVersionCommand,
  version = defaultVersion,
} = {}) {
  if (!config?.versions) {
    throw new TypeError("config is required");
  }

  const actualNode = normalizeVersion(nodeVersion);
  const nodeMajor = Number.parseInt(actualNode?.split(".")[0] ?? "", 10);
  const nodeReady = nodeMajor >= 22;
  const commandLocator = findExecutable ?? ((command) =>
    locateCommand(command, { locatorExec, platform }));
  const checks = {
    node: freezeCheck({
      status: nodeReady ? "ready" : "mismatch",
      expected: ">=22",
      actual: actualNode,
      ...(nodeReady ? {} : { reason: "version_mismatch" }),
    }),
  };

  for (const spec of TOOL_SPECS) {
    checks[spec.key] = await inspectTool(spec, config, {
      findExecutable: commandLocator,
      locate,
      runCommand,
      version,
    });
  }

  Object.freeze(checks);
  return Object.freeze({
    ready: Object.values(checks).every((check) => check.status === "ready"),
    checks,
  });
}

export async function inspectServiceHealth({
  config,
  inspect = inspectRuntime,
  createSupertonicClient = (options) => new SupertonicClient(options),
} = {}) {
  if (!config?.versions || typeof inspect !== "function" || typeof createSupertonicClient !== "function") {
    throw new TypeError("service health configuration is required");
  }
  const runtime = await inspect({ config });
  const expected = `supertonic-3@${config.versions.supertonic}`;
  let sidecar;
  try {
    const client = createSupertonicClient({
      baseUrl: "http://127.0.0.1:7788",
      timeoutMs: 2_000,
    });
    if (typeof client?.health !== "function") {
      throw new TypeError("invalid Supertonic health client");
    }
    const health = await client.health();
    if (
      health?.status !== "ok" ||
      health.model !== "supertonic-3" ||
      health.version !== config.versions.supertonic ||
      health.sampleRate !== 44_100 ||
      !Number.isSafeInteger(health.voicesLoaded) ||
      health.voicesLoaded < 10
    ) {
      throw new TypeError("invalid Supertonic health response");
    }
    sidecar = freezeCheck({ status: "ready", expected, actual: expected });
  } catch (error) {
    const unreachable = ["SUPERTONIC_UNAVAILABLE", "SUPERTONIC_TIMEOUT"].includes(error?.code);
    sidecar = freezeCheck({
      status: "mismatch",
      expected,
      actual: null,
      reason: unreachable ? "unreachable" : "invalid_response",
    });
  }
  const checks = Object.freeze({
    ...runtime.checks,
    supertonicService: sidecar,
  });
  return Object.freeze({
    ready: runtime.ready === true && sidecar.status === "ready",
    checks,
  });
}
