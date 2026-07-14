import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildConfig } from "../src/config.js";
import { inspectRuntime } from "../src/preflight.js";

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
    playwrightMcp: "0.0.78",
    python: "3.13.14",
    supertonic: "1.3.1",
    hyperframes: "0.7.57",
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
    version: async (tool, executable, context) =>
      tool === "playwrightMcp"
        ? "0.0.77"
        : defaults.version(tool, executable, context),
  });

  assert.equal(report.ready, false);
  assert.equal(report.checks.node.status, "mismatch");
  assert.equal(report.checks.playwrightMcp.status, "mismatch");
  assert.equal(report.checks.ffmpeg.status, "missing");
  assert.equal(report.checks.ffprobe.status, "ready");
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
