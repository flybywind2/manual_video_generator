import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

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
  Object.freeze({ key: "opencode", command: "opencode", expected: "installed" }),
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
  Object.freeze({ key: "ffmpeg", command: "ffmpeg", expected: "installed" }),
  Object.freeze({ key: "ffprobe", command: "ffprobe", expected: "installed" }),
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

async function locateCommand(command) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  try {
    const { stdout } = await execFileAsync(locator, [command], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null;
  } catch {
    return null;
  }
}

async function defaultLocate(_tool, { config, spec, candidate, findExecutable }) {
  if (spec.packageName) {
    return resolvePackageBin(config, spec.packageName);
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

  const probeArgs = tool === "ffmpeg" || tool === "ffprobe" ? ["-version"] : ["--version"];
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
  findExecutable = locateCommand,
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
      findExecutable,
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
