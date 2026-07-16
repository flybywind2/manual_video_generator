import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FfmpegAdapter } from "../src/adapters/ffmpeg.js";
import { HyperframesAdapter } from "../src/adapters/hyperframes.js";
import { BrowserRuntime } from "../src/adapters/browser-runtime.js";
import { OpenCodeServer } from "../src/adapters/opencode-server.js";
import { buildConfig } from "../src/config.js";
import { ExecutionLock } from "../src/jobs/execution-lock.js";
import { QualityGate } from "../src/media/quality-gate.js";
import { CredentialVault } from "../src/security/credential-vault.js";
import * as runtimeModule from "../src/runtime.js";
import {
  RuntimeCloseError,
  RuntimeConfigurationError,
  createProductionRuntime,
  resolveExecutablePath,
} from "../src/runtime.js";

async function makeExecutable(directory, name) {
  const file = path.join(directory, name);
  await writeFile(file, "runtime-test", { flag: "wx" });
  if (process.platform !== "win32") {
    await chmod(file, 0o700);
  }
  return file;
}

async function runtimeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "manual-studio-runtime-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { force: true, recursive: true }));
  });
  const opencode = await makeExecutable(root, "opencode.exe");
  const ffmpeg = await makeExecutable(root, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const ffprobe = await makeExecutable(root, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  const config = buildConfig({ root });
  const env = {
    ...process.env,
    MANUAL_STUDIO_OPENCODE_PATH: opencode,
    MANUAL_STUDIO_OPENCODE_VERSION: "1.18.2",
    MANUAL_STUDIO_FFMPEG_PATH: ffmpeg,
    MANUAL_STUDIO_FFPROBE_PATH: ffprobe,
  };
  return {
    config,
    env,
    ffmpeg,
    ffprobe,
    opencode,
    root,
  };
}

test("the production runtime module exposes no OpenCode version-runner injection factory", () => {
  assert.equal(Object.hasOwn(runtimeModule, "createProductionRuntimeFactory"), false);
});

test("resolveExecutablePath returns a canonical absolute regular executable override", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manual-studio-executable-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { force: true, recursive: true }));
  });
  const executable = await makeExecutable(root, "opencode.exe");

  const resolved = await resolveExecutablePath({
    command: "opencode.exe",
    override: executable,
    requireExe: true,
  });

  assert.equal(resolved, await realpath(executable));
  assert.equal(path.isAbsolute(resolved), true);
});

test("resolveExecutablePath rejects relative, traversing, directory, symlink, and non-exe OpenCode paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manual-studio-unsafe-executable-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { force: true, recursive: true }));
  });
  const executable = await makeExecutable(root, "tool.exe");
  const commandFile = await makeExecutable(root, "opencode.cmd");
  const nested = path.join(root, "nested");
  await mkdir(nested);
  const traversing = `${nested}${path.sep}..${path.sep}tool.exe`;

  const device = process.platform === "win32" ? "\\\\.\\NUL" : "/dev/null";
  for (const candidate of ["tool.exe", traversing, root, device]) {
    await assert.rejects(
      resolveExecutablePath({ command: "tool", override: candidate }),
      (error) => error instanceof RuntimeConfigurationError && error.code === "UNSAFE_EXECUTABLE_PATH",
    );
  }
  await assert.rejects(
    resolveExecutablePath({ command: "opencode.exe", override: commandFile, requireExe: true }),
    (error) => error instanceof RuntimeConfigurationError && error.code === "UNSAFE_EXECUTABLE_PATH",
  );

  const link = path.join(root, "linked.exe");
  try {
    await symlink(executable, link, "file");
  } catch (error) {
    if (process.platform === "win32" && error?.code === "EPERM") {
      return;
    }
    throw error;
  }
  await assert.rejects(
    resolveExecutablePath({ command: "tool", override: link }),
    (error) => error instanceof RuntimeConfigurationError && error.code === "UNSAFE_EXECUTABLE_PATH",
  );
});

test("resolveExecutablePath checks every bounded where.exe result and selects the first safe candidate", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manual-studio-where-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { force: true, recursive: true }));
  });
  const executable = await makeExecutable(root, "ffmpeg.exe");
  let request;

  const resolved = await resolveExecutablePath({
    command: "ffmpeg.exe",
    env: { PATH: root, SECRET_ACCESS_KEY: "must-not-reach-where" },
    runWhere: async (input) => {
      request = input;
      return {
        exitCode: 0,
        outputExceeded: false,
        stderr: "",
        stdout: `relative.exe\r\n${executable}\r\n`,
        timedOut: false,
      };
    },
  });

  assert.equal(resolved, await realpath(executable));
  assert.equal(request.command, "ffmpeg.exe");
  assert.equal(request.env.SECRET_ACCESS_KEY, undefined);
  assert.equal(request.env.PATH, root);
  assert.equal(request.shell, false);
});

test("resolveExecutablePath fails closed when where.exe fails or returns only unsafe paths", async () => {
  const failed = {
    exitCode: 1,
    outputExceeded: false,
    stderr: "not found",
    stdout: "",
    timedOut: false,
  };
  await assert.rejects(
    resolveExecutablePath({ command: "missing.exe", runWhere: async () => failed }),
    (error) => error instanceof RuntimeConfigurationError && error.code === "EXECUTABLE_NOT_FOUND",
  );
  await assert.rejects(
    resolveExecutablePath({
      command: "missing.exe",
      runWhere: async () => ({ ...failed, exitCode: 0, stdout: "relative.exe\r\n" }),
    }),
    (error) => error instanceof RuntimeConfigurationError && error.code === "EXECUTABLE_NOT_FOUND",
  );
});

test("the Windows where.exe implementation resolves its own regular executable", {
  skip: process.platform !== "win32",
}, async () => {
  const resolved = await resolveExecutablePath({
    command: "where.exe",
    env: process.env,
    requireExe: true,
  });
  assert.equal(path.isAbsolute(resolved), true);
  assert.equal(path.extname(resolved).toLowerCase(), ".exe");
});

test("createProductionRuntime constructs the real production dependency graph", async (t) => {
  const fixture = await runtimeFixture(t);
  let producerInput;
  const producer = { close: async () => undefined };

  const bundle = await createProductionRuntime({
    config: fixture.config,
    env: fixture.env,
    producerFactory: async (input) => {
      producerInput = input;
      return producer;
    },
  });
  t.after(() => bundle.close().catch(() => undefined));

  assert.deepEqual(bundle.paths, {
    credentials: path.join(fixture.root, "data", "credentials"),
    ffmpeg: await realpath(fixture.ffmpeg),
    ffprobe: await realpath(fixture.ffprobe),
    opencode: await realpath(fixture.opencode),
    playwrightMcp: path.join(fixture.root, "node_modules", "@playwright", "mcp"),
  });
  assert.equal(Object.isFrozen(bundle.paths), true);
  assert.ok(bundle.runtime.credentialVault instanceof CredentialVault);
  assert.ok(bundle.runtime.browserRuntime instanceof BrowserRuntime);
  assert.ok(bundle.runtime.openCodeServer instanceof OpenCodeServer);
  assert.ok(bundle.runtime.executionLock instanceof ExecutionLock);
  assert.equal(bundle.runtime.producer, producer);
  assert.ok(bundle.adapters.ffmpeg instanceof FfmpegAdapter);
  assert.ok(bundle.adapters.hyperframes instanceof HyperframesAdapter);
  assert.ok(bundle.adapters.qualityGate instanceof QualityGate);
  assert.equal(producerInput.paths, bundle.paths);
  assert.equal(producerInput.adapters, bundle.adapters);
  assert.equal(producerInput.runtime.credentialVault, bundle.runtime.credentialVault);
  assert.deepEqual(Object.keys(bundle.stops).sort(), ["browser", "opencode", "producer"]);
});

test("createProductionRuntime accepts the process.env object shape before adapters sanitize it", async (t) => {
  const fixture = await runtimeFixture(t);
  const processEnvironmentShape = Object.assign(Object.create({}), fixture.env);

  const bundle = await createProductionRuntime({
    config: fixture.config,
    env: processEnvironmentShape,
  });
  t.after(() => bundle.close().catch(() => undefined));

  assert.ok(bundle.runtime.browserRuntime instanceof BrowserRuntime);
  assert.ok(bundle.runtime.openCodeServer instanceof OpenCodeServer);
});

test("createProductionRuntime resolves the three executable overrides before building dependencies", async (t) => {
  const fixture = await runtimeFixture(t);
  const commandFile = await makeExecutable(fixture.root, "opencode.cmd");
  await assert.rejects(
    createProductionRuntime({
      config: fixture.config,
      env: { ...fixture.env, MANUAL_STUDIO_OPENCODE_PATH: commandFile },
    }),
    (error) => error instanceof RuntimeConfigurationError && error.code === "UNSAFE_EXECUTABLE_PATH",
  );
  const unsafeDirectory = path.join(fixture.root, "unsafe-opencode.exe");
  const nested = path.join(fixture.root, "nested");
  await mkdir(unsafeDirectory);
  await mkdir(nested);
  for (const candidate of [
    unsafeDirectory,
    `${nested}${path.sep}..${path.sep}opencode.exe`,
  ]) {
    await assert.rejects(
      createProductionRuntime({
        config: fixture.config,
        env: { ...fixture.env, MANUAL_STUDIO_OPENCODE_PATH: candidate },
      }),
      (error) =>
        error instanceof RuntimeConfigurationError && error.code === "UNSAFE_EXECUTABLE_PATH",
    );
  }
  await assert.rejects(
    createProductionRuntime({ config: { root: "relative" }, env: fixture.env }),
    (error) => error instanceof RuntimeConfigurationError && error.code === "INVALID_RUNTIME_CONFIG",
  );
});

test("createProductionRuntime binds a supported exact OpenCode selection without PATH rediscovery", async (t) => {
  const fixture = await runtimeFixture(t);

  for (const version of ["1.17.19", "1.18.2"]) {
    const isolatedEnvironment = { ...fixture.env };
    const pathKey = Object.keys(isolatedEnvironment).find((key) => key.toUpperCase() === "PATH");
    if (pathKey !== undefined) {
      isolatedEnvironment[pathKey] = path.join(fixture.root, "path-must-not-be-searched");
    }
    const bundle = await createProductionRuntime({
      config: fixture.config,
      env: {
        ...isolatedEnvironment,
        MANUAL_STUDIO_OPENCODE_VERSION: version,
      },
    });
    t.after(() => bundle.close().catch(() => undefined));

    assert.equal(bundle.paths.opencode, await realpath(fixture.opencode));
    assert.ok(bundle.runtime.openCodeServer instanceof OpenCodeServer);
  }
});

test("createProductionRuntime rejects incomplete and unsupported OpenCode selections", async (t) => {
  const fixture = await runtimeFixture(t);
  const cases = [
    {
      name: "missing path",
      environment() {
        const env = { ...fixture.env };
        delete env.MANUAL_STUDIO_OPENCODE_PATH;
        return env;
      },
    },
    {
      name: "missing version",
      environment() {
        const env = { ...fixture.env };
        delete env.MANUAL_STUDIO_OPENCODE_VERSION;
        return env;
      },
    },
    {
      name: "missing pair",
      environment() {
        const env = { ...fixture.env };
        delete env.MANUAL_STUDIO_OPENCODE_PATH;
        delete env.MANUAL_STUDIO_OPENCODE_VERSION;
        return env;
      },
    },
    {
      name: "below minimum",
      environment: () => ({ ...fixture.env, MANUAL_STUDIO_OPENCODE_VERSION: "1.17.18" }),
    },
    {
      name: "prerelease",
      environment: () => ({ ...fixture.env, MANUAL_STUDIO_OPENCODE_VERSION: "1.18.2-beta.1" }),
    },
    {
      name: "malformed",
      environment: () => ({ ...fixture.env, MANUAL_STUDIO_OPENCODE_VERSION: "1.18" }),
    },
  ];

  for (const sample of cases) {
    await assert.rejects(
      createProductionRuntime({
        config: fixture.config,
        env: sample.environment(),
      }),
      (error) => error instanceof RuntimeConfigurationError,
      sample.name,
    );
  }
});

test("createProductionRuntime rejects an OpenCode version-runner injection hook", async (t) => {
  const fixture = await runtimeFixture(t);
  await assert.rejects(
    createProductionRuntime({
      config: fixture.config,
      env: fixture.env,
      openCodeRunVersion: async () => ({ exitCode: 0, stdout: "1.18.2\n" }),
    }),
    (error) =>
      error instanceof RuntimeConfigurationError && error.code === "INVALID_RUNTIME_CONFIG",
  );
});

test("close is idempotent, settles OpenCode, browser, and producer, then reports every failure", async (t) => {
  const fixture = await runtimeFixture(t);
  const calls = [];
  const producer = {
    async close() {
      calls.push("producer");
      throw new Error("producer failed");
    },
  };
  const bundle = await createProductionRuntime({
    config: fixture.config,
    env: fixture.env,
    producerFactory: () => producer,
  });
  bundle.runtime.openCodeServer.stop = async () => {
    calls.push("opencode");
    throw new Error("opencode failed");
  };
  bundle.runtime.browserRuntime.stop = async () => {
    calls.push("browser");
  };

  const first = bundle.close();
  const second = bundle.close();
  assert.equal(first, second);
  await assert.rejects(first, (error) => {
    assert.ok(error instanceof RuntimeCloseError);
    assert.deepEqual(error.failures.map(({ component }) => component).sort(), ["opencode", "producer"]);
    return true;
  });
  assert.deepEqual(calls.sort(), ["browser", "opencode", "producer"]);
  await assert.rejects(bundle.close(), RuntimeCloseError);
  assert.equal(calls.length, 3);
});
