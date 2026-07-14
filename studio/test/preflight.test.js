import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildConfig } from "../src/config.js";
import { inspectRuntime, inspectServiceHealth } from "../src/preflight.js";

const root = path.resolve("test-fixtures", "studio-root");

async function temporaryRoot(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-studio-preflight-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writePackageFixture(
  fixtureRoot,
  packageName,
  { version, source = "", manifestText } = {},
) {
  const directory = path.join(fixtureRoot, "node_modules", ...packageName.split("/"));
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    manifestText ?? JSON.stringify({ name: packageName, version, bin: "./cli.js" }),
    "utf8",
  );
  await writeFile(path.join(directory, "cli.js"), source, "utf8");
}

function readyRuntimeOverrides(overrides = {}) {
  const locations = {
    opencode: path.join(root, "tools", "opencode.exe"),
    playwrightMcp: path.join(root, "node_modules", "@playwright", "mcp", "cli.js"),
    python: path.join(root, ".runtime", "python", "python.exe"),
    supertonic: path.join(root, ".runtime", "python", "Scripts", "supertonic.exe"),
    hyperframes: path.join(root, "node_modules", "hyperframes", "dist", "cli.js"),
    ffmpeg: path.join(root, "tools", "ffmpeg.exe"),
    ffprobe: path.join(root, "tools", "ffprobe.exe"),
  };
  const versions = {
    opencode: "1.4.1",
    playwrightMcp: "0.0.78",
    python: "3.13.14",
    supertonic: "1.3.1",
    hyperframes: "0.7.57",
    ffmpeg: "8.1.1",
    ffprobe: "8.1.1",
  };

  return {
    nodeVersion: "v24.13.1",
    locate: async (tool) => locations[tool] ?? null,
    version: async (tool) => versions[tool] ?? null,
    ...overrides,
  };
}

test("buildConfig pins every version-sensitive runtime exactly", () => {
  const config = buildConfig({ root, env: {} });

  assert.deepEqual(config.versions, {
    opencode: "1.4.1",
    playwrightMcp: "0.0.78",
    python: "3.13.14",
    supertonic: "1.3.1",
    hyperframes: "0.7.57",
    ffmpeg: "8.1.1",
    ffprobe: "8.1.1",
  });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.versions), true);
});

test("buildConfig exposes only a frozen loopback service with absolute paths under root", () => {
  const config = buildConfig({
    root: path.join("relative", "studio"),
    env: { MANUAL_STUDIO_PORT: "5432" },
  });

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 5432);
  assert.equal(Object.isFrozen(config.paths), true);

  for (const servicePath of Object.values(config.paths)) {
    assert.equal(path.isAbsolute(servicePath), true);
    assert.equal(path.relative(config.root, servicePath).startsWith(".."), false);
  }
});

test("buildConfig defaults the service port to 4317", () => {
  assert.equal(buildConfig({ root, env: {} }).port, 4317);
});

test("inspectRuntime discovers the project-owned Supertonic sidecar without a global PATH entry", async (t) => {
  const fixtureRoot = await temporaryRoot(t);
  await Promise.all([
    writePackageFixture(fixtureRoot, "@playwright/mcp", { version: "0.0.78" }),
    writePackageFixture(fixtureRoot, "hyperframes", { version: "0.7.57" }),
  ]);
  const localSupertonic = path.join(
    fixtureRoot,
    ".runtime",
    "supertonic",
    "venv",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "supertonic.exe" : "supertonic",
  );
  await mkdir(path.dirname(localSupertonic), { recursive: true });
  await writeFile(localSupertonic, "sidecar", "utf8");
  const seen = [];
  const commands = {
    opencode: path.join(fixtureRoot, "opencode.exe"),
    "py.exe": path.join(fixtureRoot, "py.exe"),
    ffmpeg: path.join(fixtureRoot, "ffmpeg.exe"),
    ffprobe: path.join(fixtureRoot, "ffprobe.exe"),
  };

  const report = await inspectRuntime({
    config: buildConfig({ root: fixtureRoot, env: {} }),
    findExecutable: async (name) => commands[name] ?? null,
    version: async (tool, executable) => {
      seen.push([tool, executable]);
      return ({
        opencode: "1.4.1",
        playwrightMcp: "0.0.78",
        python: "3.13.14",
        supertonic: "1.3.1",
        hyperframes: "0.7.57",
        ffmpeg: "8.1.1",
        ffprobe: "8.1.1",
      })[tool];
    },
  });

  assert.equal(report.checks.supertonic.status, "ready");
  assert.deepEqual(seen.find(([tool]) => tool === "supertonic"), [
    "supertonic",
    localSupertonic,
  ]);
});

test("the production Supertonic probe uses its real version subcommand", async () => {
  const invocations = [];
  const versions = {
    opencode: "1.4.1",
    playwrightMcp: "0.0.78",
    python: "3.13.14",
    supertonic: "1.3.1",
    hyperframes: "0.7.57",
    ffmpeg: "8.1.1",
    ffprobe: "8.1.1",
  };
  const report = await inspectRuntime({
    config: buildConfig({ root, env: {} }),
    nodeVersion: "v24.13.1",
    locate: async (tool, { spec }) => ({
      executable: `C:\\tools\\${tool}.exe`,
      args: [],
      ...(spec.packageName ? { packageVersion: versions[tool] } : {}),
    }),
    runCommand: async (executable, args) => {
      invocations.push({ executable, args: [...args] });
      const target = executable === process.execPath ? args[0] : executable;
      const tool = Object.keys(versions).find((key) => target.includes(key));
      return versions[tool];
    },
  });

  assert.equal(report.checks.supertonic.status, "ready");
  assert.deepEqual(
    invocations.find(({ executable }) => executable.endsWith("supertonic.exe")),
    { executable: "C:\\tools\\supertonic.exe", args: ["version"] },
  );
});

test("inspectRuntime discovers every command and marks a complete Node 22+ runtime ready", async () => {
  const discovered = [];
  const defaults = readyRuntimeOverrides();
  const report = await inspectRuntime({
    config: buildConfig({ root, env: {} }),
    ...defaults,
    locate: async (tool, context) => {
      discovered.push(tool);
      return defaults.locate(tool, context);
    },
  });

  assert.equal(report.ready, true);
  assert.deepEqual(discovered, [
    "opencode",
    "playwrightMcp",
    "python",
    "supertonic",
    "hyperframes",
    "ffmpeg",
    "ffprobe",
  ]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(report.checks).map(([key, check]) => [key, check.status])),
    {
      node: "ready",
      opencode: "ready",
      playwrightMcp: "ready",
      python: "ready",
      supertonic: "ready",
      hyperframes: "ready",
      ffmpeg: "ready",
      ffprobe: "ready",
    },
  );
});

test("inspectRuntime reports missing and mismatched tools independently", async () => {
  const defaults = readyRuntimeOverrides();
  const report = await inspectRuntime({
    config: buildConfig({ root, env: {} }),
    ...defaults,
    nodeVersion: "v21.7.3",
    locate: async (tool, context) =>
      tool === "ffmpeg" ? null : defaults.locate(tool, context),
    version: async (tool, executable, context) => ({
      opencode: "1.4.0",
      playwrightMcp: "0.0.77",
    })[tool] ?? defaults.version(tool, executable, context),
  });

  assert.equal(report.ready, false);
  assert.equal(report.checks.node.status, "mismatch");
  assert.equal(report.checks.opencode.status, "mismatch");
  assert.equal(report.checks.opencode.expected, "1.4.1");
  assert.equal(report.checks.playwrightMcp.status, "mismatch");
  assert.equal(report.checks.ffmpeg.status, "missing");
  assert.equal(report.checks.ffprobe.status, "ready");
});

test("inspectServiceHealth requires the live pinned Supertonic sidecar", async () => {
  const runtimeReport = Object.freeze({
    ready: true,
    checks: Object.freeze({
      node: Object.freeze({ status: "ready", expected: ">=22", actual: "24.13.1" }),
    }),
  });
  const calls = [];
  const report = await inspectServiceHealth({
    config: buildConfig({ root, env: {} }),
    inspect: async ({ config }) => {
      calls.push(["runtime", config.root]);
      return runtimeReport;
    },
    createSupertonicClient: (options) => {
      calls.push(["client", options]);
      return {
        health: async () => ({
          status: "ok",
          model: "supertonic-3",
          version: "1.3.1",
          sampleRate: 44_100,
          voicesLoaded: 10,
        }),
      };
    },
  });

  assert.equal(report.ready, true);
  assert.deepEqual(report.checks.supertonicService, {
    status: "ready",
    expected: "supertonic-3@1.3.1",
    actual: "supertonic-3@1.3.1",
  });
  assert.deepEqual(calls, [
    ["runtime", path.resolve(root)],
    ["client", { baseUrl: "http://127.0.0.1:7788", timeoutMs: 2_000 }],
  ]);
});

test("inspectServiceHealth fails closed without leaking a sidecar error", async () => {
  const secret = "sidecar-secret-must-not-leak";
  const report = await inspectServiceHealth({
    config: buildConfig({ root, env: {} }),
    inspect: async () => ({ ready: true, checks: {} }),
    createSupertonicClient: () => ({
      health: async () => {
        const error = new Error(secret);
        error.code = "SUPERTONIC_UNAVAILABLE";
        throw error;
      },
    }),
  });

  assert.equal(report.ready, false);
  assert.deepEqual(report.checks.supertonicService, {
    status: "mismatch",
    expected: "supertonic-3@1.3.1",
    actual: null,
    reason: "unreachable",
  });
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test("inspectRuntime public status never serializes environment values or thrown secret text", async () => {
  const secret = "never-print-this-password";
  const config = buildConfig({
    root,
    env: {
      MANUAL_STUDIO_PORT: "4318",
      LOGIN_PASSWORD: secret,
      OPENAI_API_KEY: "never-print-this-api-key",
    },
  });
  const defaults = readyRuntimeOverrides();
  const report = await inspectRuntime({
    config,
    ...defaults,
    version: async (tool, executable, context) => {
      if (tool === "opencode") {
        throw new Error(`command failed with ${secret}`);
      }
      return defaults.version(tool, executable, context);
    },
  });
  const serialized = JSON.stringify({ config, report });

  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("never-print-this-api-key"), false);
  assert.equal(serialized.includes("LOGIN_PASSWORD"), false);
  assert.equal(serialized.includes("OPENAI_API_KEY"), false);
  assert.equal(report.checks.opencode.status, "mismatch");
  assert.equal(report.checks.opencode.reason, "probe_failed");
});

test("default package probe executes pinned JS entries and rejects an unlaunchable entry", async (t) => {
  const fixtureRoot = await temporaryRoot(t);
  await writePackageFixture(fixtureRoot, "@playwright/mcp", {
    version: "0.0.78",
    source: "process.exitCode = 23;\n",
  });
  await writePackageFixture(fixtureRoot, "hyperframes", {
    version: "0.7.57",
    source: 'process.stdout.write("0.7.57\\n");\n',
  });

  const report = await inspectRuntime({
    config: buildConfig({ root: fixtureRoot, env: {} }),
    findExecutable: async () => null,
  });

  assert.equal(report.checks.playwrightMcp.status, "mismatch");
  assert.equal(report.checks.playwrightMcp.reason, "probe_failed");
  assert.equal(report.checks.hyperframes.status, "ready");
});

test("default package probe compares CLI output with the pinned manifest version", async (t) => {
  const fixtureRoot = await temporaryRoot(t);
  await writePackageFixture(fixtureRoot, "@playwright/mcp", {
    version: "0.0.78",
    source: 'process.stdout.write("0.0.77\\n");\n',
  });

  const report = await inspectRuntime({
    config: buildConfig({ root: fixtureRoot, env: {} }),
    findExecutable: async () => null,
  });

  assert.equal(report.checks.playwrightMcp.status, "mismatch");
  assert.equal(report.checks.playwrightMcp.reason, "version_mismatch");
  assert.equal(report.checks.playwrightMcp.actual, "0.0.77");
});

test("default package discovery classifies a corrupt located manifest without leaking its text", async (t) => {
  const fixtureRoot = await temporaryRoot(t);
  const secret = "manifest-secret-must-not-leak";
  await writePackageFixture(fixtureRoot, "@playwright/mcp", {
    manifestText: `{not-json:${secret}`,
  });

  const report = await inspectRuntime({
    config: buildConfig({ root: fixtureRoot, env: {} }),
    findExecutable: async () => null,
  });
  const serialized = JSON.stringify(report);

  assert.equal(report.checks.playwrightMcp.status, "mismatch");
  assert.equal(report.checks.playwrightMcp.reason, "manifest_invalid");
  assert.equal(serialized.includes(secret), false);
});

test("default Python discovery continues from a wrong alias to py.exe with argument arrays", async () => {
  const invocations = [];
  const report = await inspectRuntime({
    config: buildConfig({ root, env: {} }),
    nodeVersion: "v24.13.1",
    findExecutable: async (command) => {
      if (command === "python3.13") return "C:\\Python314\\python.exe";
      if (command === "py.exe") return "C:\\Windows\\py.exe";
      return null;
    },
    runCommand: async (executable, args) => {
      invocations.push({ executable, args });
      return executable.endsWith("py.exe") ? "Python 3.13.14" : "Python 3.14.3";
    },
  });

  assert.equal(report.checks.python.status, "ready");
  assert.equal(report.checks.python.actual, "3.13.14");
  assert.deepEqual(invocations, [
    { executable: "C:\\Python314\\python.exe", args: ["--version"] },
    { executable: "C:\\Windows\\py.exe", args: ["-3.13", "--version"] },
  ]);
});

test("default Python discovery reports mismatch when every located candidate has the wrong version", async () => {
  const attemptedArguments = [];
  const report = await inspectRuntime({
    config: buildConfig({ root, env: {} }),
    findExecutable: async (command) =>
      ["python3.13", "py.exe"].includes(command) ? `C:\\wrong\\${command}` : null,
    runCommand: async (_executable, args) => {
      attemptedArguments.push(args);
      return "Python 3.14.3";
    },
  });

  assert.equal(report.checks.python.status, "mismatch");
  assert.equal(report.checks.python.reason, "version_mismatch");
  assert.equal(report.checks.python.expected, "3.13.14");
  assert.deepEqual(attemptedArguments, [["--version"], ["-3.13", "--version"]]);
});

test("production locator treats the standard empty exit 1 as command not found", async () => {
  const secret = "not-found-stderr-must-not-leak";
  const calls = [];
  const report = await inspectRuntime({
    config: buildConfig({ root, env: {} }),
    platform: "win32",
    locatorExec: async (locator, args, options) => {
      calls.push({ locator, args: [...args], shell: options.shell });
      const error = new Error(secret);
      Object.assign(error, { code: 1, stdout: "", stderr: secret });
      throw error;
    },
  });
  const serialized = JSON.stringify(report);

  assert.equal(report.checks.opencode.status, "missing");
  assert.equal(report.checks.opencode.reason, "not_found");
  assert.deepEqual(calls[0], {
    locator: "where.exe",
    args: ["opencode"],
    shell: undefined,
  });
  assert.equal(serialized.includes(secret), false);
});

test("production locator sanitizes timeout, permission, spawn, and abnormal failures", async (t) => {
  const failures = [
    { name: "timeout", properties: { code: "ETIMEDOUT", killed: true } },
    { name: "permission", properties: { code: "EACCES" } },
    { name: "missing locator", properties: { code: "ENOENT" } },
    { name: "abnormal exit", properties: { code: 2 } },
  ];

  for (const failure of failures) {
    await t.test(failure.name, async () => {
      const secret = `secret-${failure.name}`;
      const report = await inspectRuntime({
        config: buildConfig({ root, env: {} }),
        platform: "win32",
        locatorExec: async () => {
          const error = new Error(secret);
          Object.assign(error, {
            ...failure.properties,
            path: `C:\\private\\${secret}\\where.exe`,
            stdout: failure.name === "timeout" ? "C:\\partial\\opencode.exe\r\n" : "",
            stderr: secret,
          });
          throw error;
        },
      });
      const serialized = JSON.stringify(report);

      assert.equal(report.checks.opencode.status, "mismatch");
      assert.equal(report.checks.opencode.reason, "lookup_failed");
      assert.equal(report.checks.opencode.actual, null);
      assert.equal(serialized.includes(secret), false);
      assert.equal(serialized.includes("where.exe"), false);
    });
  }
});
