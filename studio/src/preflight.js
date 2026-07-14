import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TOOL_SPECS = Object.freeze([
  Object.freeze({ key: "opencode", command: "opencode", expected: "installed" }),
  Object.freeze({
    key: "playwrightMcp",
    packageName: "@playwright/mcp",
    expectedVersionKey: "playwrightMcp",
  }),
  Object.freeze({ key: "python", commands: ["python3.13", "python3", "python"], expected: "3.13.x" }),
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

function normalizeVersion(output) {
  const match = String(output ?? "").match(/(?:^|[^\d])(\d+\.\d+(?:\.\d+)?)(?:[^\d]|$)/);
  return match?.[1] ?? null;
}

function packageDirectory(root, packageName) {
  return path.join(root, "node_modules", ...packageName.split("/"));
}

async function readPackageManifest(config, packageName) {
  const manifestPath = path.join(packageDirectory(config.root, packageName), "package.json");
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function resolvePackageBin(config, packageName) {
  try {
    const directory = packageDirectory(config.root, packageName);
    const manifest = await readPackageManifest(config, packageName);
    const bin = typeof manifest.bin === "string" ? manifest.bin : Object.values(manifest.bin ?? {})[0];
    if (typeof bin !== "string") {
      return null;
    }

    const executable = path.resolve(directory, bin);
    const relative = path.relative(directory, executable);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }
    if (!/\.(?:c|m)?js$/i.test(executable)) {
      return null;
    }
    await access(executable, fsConstants.R_OK);
    return executable;
  } catch {
    return null;
  }
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

async function defaultLocate(_tool, { config, spec }) {
  if (spec.packageName) {
    return resolvePackageBin(config, spec.packageName);
  }

  for (const command of spec.commands ?? [spec.command]) {
    const executable = await locateCommand(command);
    if (executable) {
      return executable;
    }
  }
  return null;
}

async function runVersionCommand(executable, args) {
  const { stdout, stderr } = await execFileAsync(executable, args, {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return `${stdout}\n${stderr}`;
}

async function defaultVersion(tool, executable, { config, spec }) {
  if (spec.packageName) {
    return (await readPackageManifest(config, spec.packageName)).version;
  }

  const args = tool === "ffmpeg" || tool === "ffprobe" ? ["-version"] : ["--version"];
  return runVersionCommand(executable, args);
}

function expectedVersion(spec, config) {
  return spec.expectedVersionKey ? config.versions[spec.expectedVersionKey] : spec.expected;
}

function matchesExpected(tool, actual, expected) {
  if (!actual) {
    return false;
  }
  if (tool === "python") {
    return actual === "3.13" || actual.startsWith("3.13.");
  }
  if (expected === "installed") {
    return true;
  }
  return actual === expected;
}

async function inspectTool(spec, config, locate, version) {
  const expected = expectedVersion(spec, config);
  let executable;
  try {
    executable = await locate(spec.key, { config, spec });
  } catch {
    executable = null;
  }

  if (!executable) {
    return freezeCheck({ status: "missing", expected, actual: null });
  }

  try {
    const actual = normalizeVersion(await version(spec.key, executable, { config, spec }));
    return freezeCheck({
      status: matchesExpected(spec.key, actual, expected) ? "ready" : "mismatch",
      expected,
      actual,
    });
  } catch {
    return freezeCheck({ status: "missing", expected, actual: null });
  }
}

export async function inspectRuntime({
  config,
  nodeVersion = process.version,
  locate = defaultLocate,
  version = defaultVersion,
} = {}) {
  if (!config?.versions) {
    throw new TypeError("config is required");
  }

  const actualNode = normalizeVersion(nodeVersion);
  const nodeMajor = Number.parseInt(actualNode?.split(".")[0] ?? "", 10);
  const checks = {
    node: freezeCheck({
      status: nodeMajor >= 22 ? "ready" : "mismatch",
      expected: ">=22",
      actual: actualNode,
    }),
  };

  for (const spec of TOOL_SPECS) {
    checks[spec.key] = await inspectTool(spec, config, locate, version);
  }

  Object.freeze(checks);
  return Object.freeze({
    ready: Object.values(checks).every((check) => check.status === "ready"),
    checks,
  });
}
