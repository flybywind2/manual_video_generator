import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

import { runOpenCode } from "../../src/adapters/opencode-client.js";
import { OpenCodeServer } from "../../src/adapters/opencode-server.js";
import { killProcessTree } from "../../src/process/process-runner.js";

const sourceStudioRoot = path.resolve(".");
const execFileAsync = promisify(execFile);
const MAX_ACTUAL_SERVE_RESPONSE_BYTES = 2 * 1024 * 1024;
const MCP_CAPABILITY_TOKEN = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const OTHER_MCP_CAPABILITY_TOKEN = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk";
const ACTUAL_OPENCODE_ENV = Object.freeze({
  "1.17.19": "MANUAL_STUDIO_TEST_OPENCODE_1_17_19_PATH",
  "1.18.2": "MANUAL_STUDIO_TEST_OPENCODE_1_18_2_PATH",
});

function jobOptions(jobId, additional = {}) {
  return { jobId, mcpCapabilityToken: MCP_CAPABILITY_TOKEN, ...additional };
}

async function supportedOpenCode(expectedVersion) {
  const variable = ACTUAL_OPENCODE_ENV[expectedVersion];
  const configured = variable === undefined ? undefined : process.env[variable];
  assert.ok(variable);
  assert.equal(typeof configured, "string", `${variable} must be configured`);
  assert.equal(configured.trim(), configured, `${variable} must be canonical`);
  assert.equal(path.isAbsolute(configured), true, `${variable} must be absolute`);
  assert.equal(path.extname(configured).toLowerCase(), ".exe", `${variable} must select a native .exe`);
  const stat = await lstat(configured);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  const executable = await realpath(configured);
  assert.equal(executable.toLowerCase(), configured.toLowerCase(), `${variable} must be canonical`);
  assert.equal(path.extname(executable).toLowerCase(), ".exe");
  const result = await execFileAsync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${expectedVersion}\n`);
  return { path: executable, source: "explicit-test-path", version: expectedVersion };
}

async function selectedOpenCode() {
  return supportedOpenCode("1.18.2");
}

function actualOpenCodeSkip(expectedVersion) {
  if (process.platform !== "win32") return "actual OpenCode contract tests require Windows";
  const variable = ACTUAL_OPENCODE_ENV[expectedVersion];
  if (typeof process.env[variable] !== "string" || process.env[variable].trim() === "") {
    return `actual OpenCode ${expectedVersion} contract tests require ${variable}`;
  }
  return false;
}

async function trustedStudioFixture(
  t,
  { crlf = false, mutateExecutor = false, registerCleanup = true } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "manual-video-server-fixture-"));
  if (registerCleanup) t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".opencode", "agents"), { recursive: true });
  for (const relative of [
    "opencode.json",
    ".opencode/agents/manual-video-planner.md",
    ".opencode/agents/manual-video-executor.md",
  ]) {
    let source = await readFile(path.join(sourceStudioRoot, relative), "utf8");
    if (mutateExecutor && relative.endsWith("manual-video-executor.md")) source += "tampered";
    if (crlf) source = source.replace(/\r?\n/gu, "\r\n");
    await writeFile(path.join(root, relative), source, "utf8");
  }
  return root;
}

async function isolatedServeFixture(t) {
  const root = await trustedStudioFixture(t, { registerCleanup: false });
  const ownedChildren = new Set();
  t.after(async () => {
    for (const child of ownedChildren) await stopOwnedProcess(child);
    await rm(root, { recursive: true, force: true });
  });
  const home = path.join(root, ".isolated-home");
  const appData = path.join(home, "AppData", "Roaming");
  const localData = path.join(home, "AppData", "Local");
  const xdgConfig = path.join(home, ".config");
  const xdgData = path.join(home, ".local", "share");
  const xdgCache = path.join(home, ".cache");
  const xdgState = path.join(home, ".local", "state");
  for (const directory of [home, appData, localData, xdgConfig, xdgData, xdgCache, xdgState]) {
    await mkdir(directory, { recursive: true });
  }
  const username = "manual-contract";
  const password = "serve-contract-password";
  const env = {
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows",
    COMSPEC: process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe",
    Path: process.env.Path ?? "",
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    TEMP: process.env.TEMP ?? os.tmpdir(),
    TMP: process.env.TMP ?? os.tmpdir(),
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localData,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    XDG_STATE_HOME: xdgState,
    MANUAL_STUDIO_MCP_TOKEN: MCP_CAPABILITY_TOKEN,
    NO_PROXY: "127.0.0.1,localhost,[::1]",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  };
  return { env, ownedChildren, password, root, username };
}

async function stopOwnedProcess(
  child,
  { killTree = killProcessTree, timeoutMs = 5_000 } = {},
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close").catch(() => undefined);
  await killTree(child);
  await Promise.race([
    closed,
    new Promise((resolvePromise) => setTimeout(resolvePromise, timeoutMs)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("actual OpenCode serve process remained alive");
  }
}

async function startActualServe(t, executable, fixture) {
  const child = spawn(
    executable,
    ["serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd: fixture.root,
      env: fixture.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  fixture.ownedChildren.add(child);
  let stdout = "";
  let stderr = "";
  const baseUrl = await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const inspect = () => {
      const match = `${stdout}\n${stderr}`.match(
        /opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/iu,
      );
      if (match) finish(undefined, `http://127.0.0.1:${match[1]}`);
    };
    const retain = (current, chunk) => `${current}${chunk}`.slice(-256 * 1024);
    child.stdout.on("data", (chunk) => {
      stdout = retain(stdout, chunk.toString("utf8"));
      inspect();
    });
    child.stderr.on("data", (chunk) => {
      stderr = retain(stderr, chunk.toString("utf8"));
      inspect();
    });
    const onError = () => finish(new Error("actual OpenCode serve failed"));
    const onClose = () => finish(new Error("actual OpenCode serve exited before readiness"));
    child.once("error", onError);
    child.once("close", onClose);
    const timer = setTimeout(() => finish(new Error("actual OpenCode serve timed out")), 45_000);
  });
  return { baseUrl, child };
}

async function actualServeJson(baseUrl, pathname, fixture) {
  const url = new URL(pathname, baseUrl);
  url.searchParams.set("directory", fixture.root);
  const authorization = Buffer.from(`${fixture.username}:${fixture.password}`, "utf8").toString("base64");
  const response = await fetch(url, {
    headers: { Authorization: `Basic ${authorization}` },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const value = await boundedActualServeResponse(response);
  assert.equal(JSON.stringify(value).includes(fixture.password), false);
  return value;
}

async function boundedActualServeResponse(response) {
  assert.equal(response?.status, 200);
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    assert.match(contentLength, /^(?:0|[1-9]\d*)$/u);
    const advertised = Number(contentLength);
    assert.equal(Number.isSafeInteger(advertised), true);
    if (advertised > MAX_ACTUAL_SERVE_RESPONSE_BYTES) {
      await Promise.resolve(response.body?.cancel?.()).catch(() => undefined);
      throw new Error("actual OpenCode serve response is too large");
    }
  }
  const reader = response.body?.getReader?.();
  assert.ok(reader);
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    assert.equal(value instanceof Uint8Array, true);
    bytes += value.byteLength;
    if (bytes > MAX_ACTUAL_SERVE_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("actual OpenCode serve response is too large");
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

test("actual serve response parsing rejects oversized advertised and streamed bodies without buffering", async (t) => {
  await t.test("Content-Length", async () => {
    let cancelled = false;
    const response = {
      status: 200,
      headers: { get: () => String(MAX_ACTUAL_SERVE_RESPONSE_BYTES + 1) },
      body: {
        async cancel() {
          cancelled = true;
        },
      },
    };
    await assert.rejects(
      () => boundedActualServeResponse(response),
      /actual OpenCode serve response is too large/u,
    );
    assert.equal(cancelled, true);
  });

  await t.test("stream", async () => {
    let cancelled = false;
    const response = {
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.alloc(MAX_ACTUAL_SERVE_RESPONSE_BYTES));
          controller.enqueue(Buffer.from([0]));
        },
        cancel() {
          cancelled = true;
        },
      }),
    };
    await assert.rejects(
      () => boundedActualServeResponse(response),
      /actual OpenCode serve response is too large/u,
    );
    assert.equal(cancelled, true);
  });
});

test("actual serve cleanup fails closed when the owned process tree remains alive", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  let killCalls = 0;
  await assert.rejects(
    () => stopOwnedProcess(child, {
      killTree: async (target) => {
        assert.equal(target, child);
        killCalls += 1;
      },
      timeoutMs: 5,
    }),
    /actual OpenCode serve process remained alive/u,
  );
  assert.equal(killCalls, 1);
});

async function configuredAgentFixture(studioRoot, name) {
  const source = (await readFile(path.join(studioRoot, ".opencode", "agents", `${name}.md`), "utf8"))
    .replace(/\r\n?/gu, "\n");
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u);
  assert.ok(match);
  const permission = {};
  let inPermission = false;
  for (const line of match[1].split(/\r?\n/u)) {
    if (line === "permission:") {
      inPermission = true;
      continue;
    }
    if (inPermission) {
      const entry = line.match(/^  "?([*a-zA-Z_][\w*.-]*)"?:\s*(allow|deny)$/u);
      if (entry) permission[entry[1]] = entry[2];
    }
  }
  const rules = Object.entries(permission).map(([key, action]) => ({
    permission: key,
    pattern: "*",
    action,
  }));
  return {
    configured: { mode: "primary", permission },
    resolvedForDataHome(dataHome) {
      return {
        name,
        mode: "primary",
        native: false,
        prompt: match[2].trim(),
        permission: [
          ...rules,
          {
            permission: "external_directory",
            pattern: path.join(dataHome, "opencode", "tool-output", "*"),
            action: "allow",
          },
        ],
        tools: { read: false, bash: false, edit: false },
      };
    },
  };
}

async function snapshotTree(root) {
  const entries = [];
  const visit = async (current, relative) => {
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT" && relative === ".") {
        entries.push({ path: ".", type: "missing" });
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      entries.push({ path: relative, type: "link", mtimeMs: stat.mtimeMs });
      return;
    }
    if (stat.isDirectory()) {
      entries.push({ path: relative, type: "directory", mtimeMs: stat.mtimeMs });
      for (const name of (await readdir(current)).sort()) {
        await visit(path.join(current, name), relative === "." ? name : `${relative}/${name}`);
      }
      return;
    }
    assert.equal(stat.isFile(), true);
    entries.push({
      path: relative,
      type: "file",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      content: (await readFile(current)).toString("base64"),
    });
  };
  await visit(root, ".");
  return entries;
}

class FakeChild extends EventEmitter {
  constructor(pid = 43170) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  close(exitCode = 0, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = exitCode;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", exitCode, signal);
  }
}

function healthyResponse(version = "1.18.2") {
  return {
    ok: true,
    status: 200,
    json: async () => ({ healthy: true, version }),
  };
}

function createHarness(overrides = {}) {
  const calls = { spawn: [], fetch: [], owner: [], kill: [], closed: [], preflight: [], live: [], order: [] };
  const child = new FakeChild();
  const expectedVersion = Object.hasOwn(overrides, "expectedVersion")
    ? overrides.expectedVersion
    : "1.18.2";
  const server = new OpenCodeServer({
    opencodePath: path.resolve("C:\\Users\\xiro1\\.bun\\bin\\opencode.exe"),
    studioRoot: path.resolve("."),
    expectedVersion,
    port: 4096,
    env: {
      Path: process.env.Path ?? "",
      OPENAI_API_KEY: "provider-key",
      MANUAL_STUDIO_LOGIN_USERNAME: "alice",
      MANUAL_STUDIO_LOGIN_PASSWORD: "login-secret",
      PLAYWRIGHT_MCP_SECRETS_FILE: "C:\\private\\secrets.env",
      OPENCODE_TEST_HOME: "C:\\attacker-home",
      HTTP_PROXY: "http://127.0.0.1:65534",
      HTTPS_PROXY: "http://127.0.0.1:65534",
      NO_PROXY: "attacker.invalid",
      GITHUB_TOKEN: "unrelated-secret",
      AWS_SECRET_ACCESS_KEY: "unrelated-cloud-secret",
    },
    readinessTimeoutMs: 2_000,
    spawnProcess: (command, args, options) => {
      calls.spawn.push({ command, args, options });
      queueMicrotask(() => child.stdout.write("OpenCode server listening on 127.0.0.1:4096\n"));
      return child;
    },
    fetchImpl: async (url, options) => {
      calls.order.push("fetch");
      calls.fetch.push({ url, options });
      return healthyResponse(expectedVersion);
    },
    verifyPortOwner: async (port, pid) => {
      calls.order.push("owner");
      calls.owner.push({ port, pid });
    },
    killTree: async (target) => {
      calls.kill.push(target.pid);
      target.close(0, null);
    },
    waitForPortClosed: async (port) => calls.closed.push(port),
    preflightConfig: async (details) => {
      calls.preflight.push(details);
      return { valid: true };
    },
    validateLiveContract: async (details) => {
      calls.live.push(details);
      return { valid: true };
    },
    ...overrides,
  });
  return { calls, child, server };
}

for (const expectedVersion of ["1.17.19", "1.18.2"]) {
  test(`actual OpenCode ${expectedVersion} serve exposes the pinned health, config, agent, and tool shapes`, {
    skip: actualOpenCodeSkip(expectedVersion),
    timeout: 120_000,
  }, async (t) => {
    const selection = await supportedOpenCode(expectedVersion);
    const fixture = await isolatedServeFixture(t);
    const { baseUrl, child } = await startActualServe(t, selection.path, fixture);
    const health = await actualServeJson(baseUrl, "/global/health", fixture);
    assert.deepEqual(health, { healthy: true, version: expectedVersion });

    const config = await actualServeJson(baseUrl, "/config", fixture);
    assert.equal(config.model, undefined);
    assert.equal(config.small_model, undefined);
    assert.deepEqual(Object.keys(config.mcp), ["playwright"]);
    assert.equal(config.mcp.playwright.url, "http://127.0.0.1:8931/mcp");
    assert.equal(config.permission["*"], "deny");

    const agents = await actualServeJson(baseUrl, "/agent", fixture);
    for (const name of ["manual-video-planner", "manual-video-executor"]) {
      const agent = agents.find((candidate) => candidate.name === name);
      assert.ok(agent);
      assert.equal(agent.mode, "primary");
      assert.equal(agent.native, false);
      assert.equal("model" in agent, false);
    }

    const toolIds = await actualServeJson(baseUrl, "/experimental/tool/ids", fixture);
    assert.deepEqual(toolIds, [
      "invalid", "question", "bash", "read", "glob", "grep", "edit", "write", "task",
      "webfetch", "todowrite", "websearch", "skill", "apply_patch",
    ]);
    await stopOwnedProcess(child);
  });

  test(`default preflight accepts the exact OpenCode ${expectedVersion} binary`, {
    skip: actualOpenCodeSkip(expectedVersion),
    timeout: 120_000,
  }, async (t) => {
    const selection = await supportedOpenCode(expectedVersion);
    const fixture = await isolatedServeFixture(t);
    const runtimeConfigDirectory = path.join(fixture.env.XDG_CONFIG_HOME, "opencode");
    await mkdir(runtimeConfigDirectory, { recursive: true });
    await writeFile(path.join(runtimeConfigDirectory, "opencode.json"), JSON.stringify({
      model: "ollama/gemma4:12b_qat",
      small_model: "ollama/gemma4:12b_qat",
      provider: {
        ollama: {
          name: "Ollama (local)",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:11434/v1" },
          models: { "gemma4:12b_qat": { name: "Gemma 4 12B QAT (Ollama)" } },
        },
      },
    }), "utf8");
    const child = new FakeChild(45800 + Number(expectedVersion === "1.18.2"));
    const server = new OpenCodeServer({
      opencodePath: selection.path,
      expectedVersion,
      studioRoot: fixture.root,
      env: fixture.env,
      spawnProcess: () => {
        queueMicrotask(() => child.stdout.write("OpenCode server listening on 127.0.0.1:4096\n"));
        return child;
      },
      validateLiveContract: async () => ({ valid: true }),
      fetchImpl: async () => healthyResponse(expectedVersion),
      verifyPortOwner: async () => {},
      killTree: async () => child.close(),
      waitForPortClosed: async () => {},
    });
    const active = await server.startJob(jobOptions(`job-preflight${expectedVersion.replaceAll(".", "")}000000`));
    assert.equal(active.version, expectedVersion);
    await server.stop();
  });
}

test("OpenCodeServer starts exact production serve command and verifies healthy owned port", async () => {
  const { calls, server } = createHarness();
  const active = await server.startJob(jobOptions("job-0123456789abcdef"));

  assert.equal(calls.spawn.length, 1);
  assert.deepEqual(calls.spawn[0].args, [
    "serve",
    "--pure",
    "--hostname",
    "127.0.0.1",
    "--port",
    "4096",
  ]);
  assert.equal(calls.spawn[0].options.shell, false);
  assert.equal(calls.spawn[0].options.cwd, path.resolve("."));
  assert.equal("OPENAI_API_KEY" in calls.spawn[0].options.env, false);
  assert.equal("HTTP_PROXY" in calls.spawn[0].options.env, false);
  assert.equal("HTTPS_PROXY" in calls.spawn[0].options.env, false);
  assert.equal(calls.spawn[0].options.env.NO_PROXY, "127.0.0.1,localhost,[::1]");
  assert.equal(calls.spawn[0].options.env.OPENCODE_DISABLE_CLAUDE_CODE, "1");
  assert.equal(calls.spawn[0].options.env.OPENCODE_DISABLE_EXTERNAL_SKILLS, "1");
  assert.equal(calls.spawn[0].options.env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(calls.spawn[0].options.env.MANUAL_STUDIO_MCP_TOKEN, MCP_CAPABILITY_TOKEN);
  assert.equal("MANUAL_STUDIO_MCP_TOKEN" in calls.preflight[0].env, false);
  assert.equal("OPENCODE_TEST_HOME" in calls.preflight[0].env, false);
  assert.equal("MANUAL_STUDIO_LOGIN_USERNAME" in calls.spawn[0].options.env, false);
  assert.equal("MANUAL_STUDIO_LOGIN_PASSWORD" in calls.spawn[0].options.env, false);
  assert.equal("PLAYWRIGHT_MCP_SECRETS_FILE" in calls.spawn[0].options.env, false);
  assert.equal("GITHUB_TOKEN" in calls.spawn[0].options.env, false);
  assert.equal("AWS_SECRET_ACCESS_KEY" in calls.spawn[0].options.env, false);
  assert.equal(calls.preflight.length, 1);
  assert.equal(calls.preflight[0].expectedVersion, "1.18.2");
  assert.equal(calls.live.length, 1);
  assert.deepEqual(calls.owner, [{ port: 4096, pid: 43170 }]);
  assert.deepEqual(calls.order.slice(0, 2), ["owner", "fetch"]);
  assert.equal(calls.fetch[0].url, "http://127.0.0.1:4096/global/health");
  assert.equal(active.baseUrl, "http://127.0.0.1:4096");
  assert.equal(active.version, "1.18.2");
  assert.deepEqual(Object.keys(active).sort(), ["baseUrl", "jobId", "version"]);
  assert.equal("serverPassword" in active, false);
  assert.equal(JSON.stringify(active).includes(MCP_CAPABILITY_TOKEN), false);
  assert.equal(JSON.stringify(calls.spawn[0].args).includes(MCP_CAPABILITY_TOKEN), false);
  assert.equal(JSON.stringify(calls.live).includes(MCP_CAPABILITY_TOKEN), false);
  assert.equal(server.activeJobId, "job-0123456789abcdef");
  await server.stop();
});

test("OpenCodeServer binds either supported exact expected version", async (t) => {
  for (const expectedVersion of ["1.17.19", "1.18.2"]) {
    await t.test(expectedVersion, async () => {
      const { calls, server } = createHarness({ expectedVersion });
      const active = await server.startJob(jobOptions(`job-version${expectedVersion.replaceAll(".", "")}000000`));
      assert.equal(calls.preflight[0].expectedVersion, expectedVersion);
      assert.equal(active.version, expectedVersion);
      await server.stop();
    });
  }
});

test("OpenCodeServer requires a supported stable expectedVersion", () => {
  for (const expectedVersion of [undefined, "", "1.17.18", "1.18.2-beta.1", "v1.18.2"]) {
    assert.throws(
      () => createHarness({ expectedVersion }),
      (error) => error.code === "INVALID_OPENCODE_SERVER_OPTIONS",
    );
  }
});

test("OpenCodeServer exposes Basic auth only inside a generation-bound attach callback", async () => {
  const { calls, server } = createHarness();
  const active = await server.startJob(jobOptions("job-attachclosure001"));
  assert.equal(JSON.stringify(active).includes("manual-studio"), false);
  let observedPassword;
  const value = await server.withAttachOptions("manual-video-planner", async (options) => {
    observedPassword = options.env.OPENCODE_SERVER_PASSWORD;
    assert.equal(typeof observedPassword, "string");
    assert.ok(observedPassword.length >= 32);
    assert.equal(options.env.OPENCODE_SERVER_USERNAME, "manual-studio");
    assert.equal(options.env.NO_PROXY, "127.0.0.1,localhost,[::1]");
    assert.equal("MANUAL_STUDIO_MCP_TOKEN" in options.env, false);
    assert.equal("HTTP_PROXY" in options.env, false);
    assert.equal("OPENAI_API_KEY" in options.env, false);
    assert.deepEqual(
      await options.validateServerContract({
        agent: "manual-video-planner",
        baseUrl: options.baseUrl,
        studioRoot: options.studioRoot,
      }),
      { valid: true },
    );
    return "attached";
  });
  assert.equal(value, "attached");
  assert.equal(calls.live.length, 2);
  assert.equal(JSON.stringify(server.active).includes(observedPassword), false);
  await server.stop();
  await assert.rejects(
    server.withAttachOptions("manual-video-planner", async () => {}),
    (error) => error.code === "OPENCODE_SERVER_INACTIVE",
  );
});

test("OpenCodeServer releases the prior MCP capability before a replacement job", async () => {
  const children = [];
  const observedTokens = [];
  const { server } = createHarness({
    spawnProcess: (_command, _args, options) => {
      const child = new FakeChild(43200 + children.length);
      children.push(child);
      observedTokens.push(options.env.MANUAL_STUDIO_MCP_TOKEN);
      queueMicrotask(() => child.stdout.write("OpenCode server listening on 127.0.0.1:4096\n"));
      return child;
    },
    killTree: async (child) => child.close(),
  });

  await server.startJob(jobOptions("job-mcptokenreplace01"));
  await server.stop();
  await server.startJob(jobOptions("job-mcptokenreplace02", {
    mcpCapabilityToken: OTHER_MCP_CAPABILITY_TOKEN,
  }));
  await server.stop();

  assert.deepEqual(observedTokens, [MCP_CAPABILITY_TOKEN, OTHER_MCP_CAPABILITY_TOKEN]);
});

test("OpenCodeServer rejects an attach stopped during deferred live validation before client spawn", async () => {
  let liveCalls = 0;
  let enterValidation;
  let releaseValidation;
  let clientProcessSpawns = 0;
  const validationEntered = new Promise((resolvePromise) => { enterValidation = resolvePromise; });
  const validationGate = new Promise((resolvePromise) => { releaseValidation = resolvePromise; });
  const { server } = createHarness({
    validateLiveContract: async () => {
      liveCalls += 1;
      if (liveCalls === 1) return { valid: true };
      enterValidation();
      await validationGate;
      return { valid: true };
    },
  });
  await server.startJob(jobOptions("job-attachstoprace01"));

  const attaching = server.withAttachOptions("manual-video-planner", async (options) => runOpenCode({
    ...options,
    opencodePath: path.resolve("C:\\tools\\opencode.exe"),
    agent: "manual-video-planner",
    prompt: "Produce the approved plan JSON.",
    processRunner: async () => {
      clientProcessSpawns += 1;
      throw new Error("stale client spawn");
    },
  }));
  await validationEntered;
  await server.stop();
  releaseValidation();

  await assert.rejects(
    attaching,
    (error) => error.code === "OPENCODE_SERVER_CONTRACT_INVALID",
  );
  assert.equal(clientProcessSpawns, 0);
});

test("OpenCodeServer refuses unsafe resolved config before serve and unsafe live drift after health", async (t) => {
  await t.test("preflight", async () => {
    const { calls, server } = createHarness({
      preflightConfig: async () => { throw new Error("raw provider secret"); },
    });
    await assert.rejects(
      server.startJob(jobOptions("job-preflightunsafe01")),
      (error) => error.code === "OPENCODE_SERVER_PREFLIGHT_FAILED" && !String(error).includes("secret"),
    );
    assert.equal(calls.spawn.length, 0);
  });

  await t.test("live drift", async () => {
    const { calls, server } = createHarness({
      validateLiveContract: async () => { throw new Error("raw live secret"); },
    });
    await assert.rejects(
      server.startJob(jobOptions("job-livedriftunsafe1")),
      (error) => error.code === "OPENCODE_SERVER_START_FAILED" && !String(error).includes("secret"),
    );
    assert.equal(calls.spawn.length, 1);
    assert.equal(calls.kill.length, 1);
  });
});

test("OpenCodeServer keeps one process across phases and refuses a second active job", async () => {
  const { calls, server } = createHarness();
  const first = await server.startJob(jobOptions("job-aaaaaaaaaaaaaaaa"));
  assert.equal(server.active, first);
  assert.equal(server.active, first);
  await assert.rejects(
    server.startJob(jobOptions("job-bbbbbbbbbbbbbbbb")),
    (error) => error.code === "OPENCODE_SERVER_BUSY",
  );
  assert.equal(calls.spawn.length, 1);
  await server.stop();
});

test("OpenCodeServer accepts the canonical UUID shape emitted by JobStore", async () => {
  const { server } = createHarness();
  const active = await server.startJob(jobOptions("123e4567-e89b-42d3-a456-426614174000"));
  assert.equal(active.jobId, "123e4567-e89b-42d3-a456-426614174000");
  await server.stop();
});

test("OpenCodeServer rejects false health, wrong version, dead child, and port owner mismatch safely", async (t) => {
  const samples = [
    {
      name: "unhealthy",
      override: { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ healthy: false, version: "1.18.2" }) }) },
    },
    {
      name: "wrong version",
      override: { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ healthy: true, version: "1.17.19" }) }) },
    },
    {
      name: "owner mismatch",
      override: { verifyPortOwner: async () => { throw new Error("private owner details"); } },
    },
  ];
  for (const sample of samples) {
    await t.test(sample.name, async () => {
      const { server } = createHarness(sample.override);
      await assert.rejects(
        server.startJob(jobOptions("job-cccccccccccccccc")),
        (error) => error.code === "OPENCODE_SERVER_START_FAILED" && !String(error).includes("private"),
      );
    });
  }
});

test("OpenCodeServer cancellation and stop terminate the entire tree and wait for port closure", async () => {
  const { calls, server } = createHarness();
  const controller = new AbortController();
  await server.startJob(jobOptions("job-dddddddddddddddd", { signal: controller.signal }));
  controller.abort(new Error("abort secret"));
  await server.stopped;

  assert.deepEqual(calls.kill, [43170]);
  assert.deepEqual(calls.closed, [4096]);
  assert.equal(server.active, null);
});

test("OpenCodeServer stop aborts awaited owner and health gates before live validation", async (t) => {
  await t.test("owner gate", async () => {
    let entered;
    const enteredPromise = new Promise((resolvePromise) => { entered = resolvePromise; });
    const { calls, server } = createHarness({
      verifyPortOwner: async (_port, _pid, signal) => {
        entered();
        await new Promise((_resolvePromise, rejectPromise) => {
          const abort = () => rejectPromise(new Error("aborted"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      },
    });
    const starting = server.startJob(jobOptions("job-ownerabortgate01"));
    await enteredPromise;
    await server.stop();
    await assert.rejects(starting, (error) => error.code === "OPENCODE_SERVER_START_FAILED");
    assert.equal(calls.fetch.length, 0);
    assert.equal(calls.live.length, 0);
  });

  await t.test("health gate", async () => {
    let entered;
    const enteredPromise = new Promise((resolvePromise) => { entered = resolvePromise; });
    const { calls, server } = createHarness({
      fetchImpl: async (_url, options) => {
        entered();
        return new Promise((_resolvePromise, rejectPromise) => {
          const abort = () => rejectPromise(new Error("aborted"));
          options.signal.addEventListener("abort", abort, { once: true });
          if (options.signal.aborted) abort();
        });
      },
    });
    const starting = server.startJob(jobOptions("job-healthabortgate1"));
    await enteredPromise;
    await server.stop();
    await assert.rejects(starting, (error) => error.code === "OPENCODE_SERVER_START_FAILED");
    assert.equal(calls.live.length, 0);
  });
});

test("OpenCodeServer rejects already-aborted and hostile options without spawning", async () => {
  const { calls, server } = createHarness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    server.startJob(jobOptions("job-eeeeeeeeeeeeeeee", { signal: controller.signal })),
    (error) => error.code === "OPENCODE_SERVER_ABORTED",
  );
  assert.equal(calls.spawn.length, 0);

  assert.throws(
    () => new OpenCodeServer({ opencodePath: "opencode.exe", studioRoot: path.resolve(".") }),
    (error) => error.code === "INVALID_OPENCODE_SERVER_OPTIONS",
  );
  const hostile = Object.create({ get studioRoot() { throw new Error("getter secret"); } });
  assert.throws(
    () => new OpenCodeServer(hostile),
    (error) => error.code === "INVALID_OPENCODE_SERVER_OPTIONS" && !String(error).includes("secret"),
  );
  assert.throws(
    () => new OpenCodeServer({
      opencodePath: path.resolve("C:\\tools\\opencode.exe"),
      studioRoot: path.resolve("."),
      env: { Path: process.env.Path ?? "", OPENCODE_CONFIG_CONTENT: "{}" },
    }),
    (error) => error.code === "INVALID_OPENCODE_SERVER_OPTIONS",
  );
});

test("OpenCodeServer requires a canonical 32-byte MCP capability before preflight or spawn", async () => {
  const { calls, server } = createHarness();
  const nonCanonical = `${MCP_CAPABILITY_TOKEN.slice(0, -1)}d`;
  for (const options of [
    { jobId: "job-missingmcptoken01" },
    { jobId: "job-emptymcptoken0001", mcpCapabilityToken: "" },
    { jobId: "job-shortmcptoken000", mcpCapabilityToken: MCP_CAPABILITY_TOKEN.slice(1) },
    { jobId: "job-paddingmcptoken0", mcpCapabilityToken: `${MCP_CAPABILITY_TOKEN}=` },
    { jobId: "job-noncanonicalmcp1", mcpCapabilityToken: nonCanonical },
  ]) {
    await assert.rejects(
      server.startJob(options),
      (error) =>
        error.code === "INVALID_OPENCODE_JOB_OPTIONS" &&
        !String(error).includes(MCP_CAPABILITY_TOKEN) &&
        !String(error).includes(nonCanonical),
    );
  }
  assert.equal(calls.preflight.length, 0);
  assert.equal(calls.spawn.length, 0);
});

test("OpenCodeServer bounds readiness output and never exposes raw debug configuration", async () => {
  const secret = "server-output-secret";
  const { server, child } = createHarness({
    spawnProcess: () => {
      queueMicrotask(() => child.stderr.write(`${secret}${"x".repeat(70_000)}\n`));
      return child;
    },
  });
  await assert.rejects(
    server.startJob(jobOptions("job-ffffffffffffffff")),
    (error) =>
      error.code === "OPENCODE_SERVER_START_FAILED" &&
      !String(error).includes(secret) &&
      !JSON.stringify(error).includes(secret),
  );
});

test("OpenCodeServer clears a crashed active process and permits a replacement job", async () => {
  const children = [];
  const { server } = createHarness({
    spawnProcess: () => {
      const child = new FakeChild(44000 + children.length);
      children.push(child);
      queueMicrotask(() => child.stdout.write("OpenCode server listening on 127.0.0.1:4096\n"));
      return child;
    },
    killTree: async (child) => child.close(),
  });
  await server.startJob(jobOptions("job-crashrecovery001"));
  children[0].close(91, null);
  const deadline = Date.now() + 2_000;
  while (server.active && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.equal(server.active, null);
  await server.startJob(jobOptions("job-crashrecovery002"));
  assert.equal(children.length, 2);
  await server.stop();
});

test("OpenCodeServer stop joins pending crash recovery before cleanup and replacement", async () => {
  const children = [];
  let cleanupCalls = 0;
  let closedCalls = 0;
  let enterRecovery;
  let releaseRecovery;
  const recoveryEntered = new Promise((resolvePromise) => { enterRecovery = resolvePromise; });
  const recoveryGate = new Promise((resolvePromise) => { releaseRecovery = resolvePromise; });
  const { server } = createHarness({
    preflightConfig: async () => ({
      valid: true,
      cleanup: async () => { cleanupCalls += 1; },
    }),
    spawnProcess: () => {
      const child = new FakeChild(44500 + children.length);
      children.push(child);
      queueMicrotask(() => child.stdout.write("OpenCode server listening on 127.0.0.1:4096\n"));
      return child;
    },
    killTree: async (child) => child.close(),
    waitForPortClosed: async () => {
      closedCalls += 1;
      if (closedCalls === 1) {
        enterRecovery();
        await recoveryGate;
      }
    },
  });

  await server.startJob(jobOptions("job-crashjoin0000001"));
  children[0].close(91, null);
  await recoveryEntered;

  let stopSettled = false;
  const stopping = server.stop().finally(() => { stopSettled = true; });
  let blockedStartSettled = false;
  const blockedStart = server.startJob(jobOptions("job-crashjoin0000002"));
  blockedStart.then(
    () => { blockedStartSettled = true; },
    () => { blockedStartSettled = true; },
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  assert.equal(stopSettled, false);
  assert.equal(blockedStartSettled, false);
  assert.equal(cleanupCalls, 0);

  releaseRecovery();
  await stopping;
  assert.equal(cleanupCalls, 1);
  await assert.rejects(
    blockedStart,
    (error) => error.code === "OPENCODE_SERVER_BUSY",
  );
  await server.startJob(jobOptions("job-crashjoin0000003"));
  assert.equal(children.length, 2);
  await server.stop();
  assert.equal(cleanupCalls, 2);
});

test("OpenCodeServer quarantines failed crash recovery until port closure is re-proved", async () => {
  const children = [];
  let cleanupCalls = 0;
  let closedCalls = 0;
  const { server } = createHarness({
    preflightConfig: async () => ({
      valid: true,
      cleanup: async () => { cleanupCalls += 1; },
    }),
    spawnProcess: () => {
      const child = new FakeChild(44600 + children.length);
      children.push(child);
      queueMicrotask(() => child.stdout.write("OpenCode server listening on 127.0.0.1:4096\n"));
      return child;
    },
    killTree: async (child) => child.close(),
    waitForPortClosed: async () => {
      closedCalls += 1;
      if (closedCalls <= 2) throw new Error("port remains owned");
    },
  });

  await server.startJob(jobOptions("job-crashretry000001"));
  children[0].close(91, null);
  await assert.rejects(server.stopped, /port remains owned/u);
  assert.equal(cleanupCalls, 0);

  await assert.rejects(
    server.stop(),
    (error) => error.code === "OPENCODE_SERVER_STOP_FAILED",
  );
  assert.equal(cleanupCalls, 0);
  await assert.rejects(
    server.startJob(jobOptions("job-crashretry000002")),
    (error) => error.code === "OPENCODE_SERVER_RECOVERY_FAILED",
  );

  await server.stop();
  assert.equal(cleanupCalls, 1);
  await server.startJob(jobOptions("job-crashretry000003"));
  assert.equal(children.length, 2);
  await server.stop();
  assert.equal(cleanupCalls, 2);
});

test("OpenCodeServer contains AbortSignal stop rejection while preserving stopped failure", async () => {
  let cleanupCalls = 0;
  let closedCalls = 0;
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const { server } = createHarness({
      preflightConfig: async () => ({
        valid: true,
        cleanup: async () => { cleanupCalls += 1; },
      }),
      waitForPortClosed: async () => {
        closedCalls += 1;
        if (closedCalls === 1) throw new Error("abort port remains owned");
      },
    });
    const controller = new AbortController();
    await server.startJob(jobOptions("job-abortstopfail001", { signal: controller.signal }));

    controller.abort();
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.deepEqual(unhandled, []);
    await assert.rejects(
      server.stopped,
      (error) => error.code === "OPENCODE_SERVER_STOP_FAILED",
    );
    assert.equal(cleanupCalls, 0);

    await server.stop();
    assert.equal(cleanupCalls, 1);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("OpenCodeServer stop supersedes an awaited preflight and prevents a late spawn", async () => {
  let release;
  let entered;
  let preflightCalls = 0;
  let cleanupCalls = 0;
  const enteredPromise = new Promise((resolvePromise) => { entered = resolvePromise; });
  const deferred = new Promise((resolvePromise) => { release = resolvePromise; });
  const { calls, server } = createHarness({
    preflightConfig: async () => {
      preflightCalls += 1;
      if (preflightCalls === 1) {
        entered();
        await deferred;
        return { valid: true, cleanup: async () => { cleanupCalls += 1; } };
      }
      return { valid: true };
    },
  });
  const starting = server.startJob(jobOptions("job-stoprace00000001"));
  await enteredPromise;
  const stopping = server.stop();
  await assert.rejects(
    server.startJob(jobOptions("job-stoprace00000002")),
    (error) => error.code === "OPENCODE_SERVER_BUSY",
  );
  release();
  await stopping;
  await assert.rejects(starting, (error) => error.code === "OPENCODE_SERVER_ABORTED");
  assert.equal(calls.spawn.length, 0);
  assert.equal(cleanupCalls, 1);

  await server.startJob(jobOptions("job-stoprace00000003"));
  assert.equal(calls.spawn.length, 1);
  await server.stop();
});

test("default preflight canonicalizes CRLF, revalidates the executable, and isolates data homes", {
  skip: actualOpenCodeSkip("1.18.2"),
  timeout: 120_000,
}, async (t) => {
  const studioRoot = await trustedStudioFixture(t, { crlf: true });
  const xdgConfig = path.join(studioRoot, "xdg-config");
  await mkdir(path.join(xdgConfig, "opencode"), { recursive: true });
  await writeFile(path.join(xdgConfig, "opencode", "opencode.json"), JSON.stringify({
    model: "ollama/gemma4:12b_qat",
    small_model: "ollama/gemma4:12b_qat",
    provider: {
      ollama: {
        name: "Ollama (local)",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:11434/v1" },
        models: { "gemma4:12b_qat": { name: "Gemma 4 12B QAT (Ollama)" } },
      },
    },
  }), "utf8");
  const projectConfig = JSON.parse(await readFile(path.join(studioRoot, "opencode.json"), "utf8"));
  const planner = await configuredAgentFixture(studioRoot, "manual-video-planner");
  const executor = await configuredAgentFixture(studioRoot, "manual-video-executor");
  const resolvedConfig = {
    $schema: "https://opencode.ai/config.json",
    agent: {
      "manual-video-planner": planner.configured,
      "manual-video-executor": executor.configured,
    },
    command: {},
    mcp: {
      playwright: {
        ...projectConfig.mcp.playwright,
        headers: { Authorization: `Bearer ${MCP_CAPABILITY_TOKEN}` },
      },
    },
    mode: {},
    model: "ollama/gemma4:12b_qat",
    permission: projectConfig.permission,
    plugin: [],
    provider: {
      ollama: {
        name: "Ollama (local)",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:11434/v1" },
        models: { "gemma4:12b_qat": { name: "Gemma 4 12B QAT (Ollama)" } },
      },
    },
    small_model: "ollama/gemma4:12b_qat",
    username: "fixture",
  };
  const agentNames = [
    "build", "compaction", "explore", "general", "manual-video-executor",
    "manual-video-planner", "plan", "summary", "title",
  ];
  const toolIds = [
    "invalid", "question", "bash", "read", "glob", "grep", "edit", "write", "task",
    "webfetch", "todowrite", "websearch", "skill", "apply_patch",
  ];
  const openCodeSelection = await selectedOpenCode();
  const opencodePath = openCodeSelection.path;
  const defaultHome = path.join(studioRoot, "default-user-home");
  const scenarios = [
    {
      name: "custom XDG_DATA_HOME",
      dataHome: path.join(studioRoot, "custom-xdg-data"),
      environment() {
        return { ...process.env, XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: this.dataHome };
      },
    },
    {
      name: "default user data home",
      dataHome: path.join(defaultHome, ".local", "share"),
      environment() {
        const value = { ...process.env, XDG_CONFIG_HOME: xdgConfig };
        delete value.XDG_DATA_HOME;
        return value;
      },
      defaultHome,
    },
  ];

  await t.test("rejects framed version output at the first process boundary", async () => {
    const calls = [];
    let serveCalls = 0;
    const server = new OpenCodeServer({
      opencodePath,
      expectedVersion: openCodeSelection.version,
      studioRoot,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: path.join(studioRoot, "framed-version-data"),
      },
      preflightProcessRunner: async (options) => {
        calls.push(options);
        return {
          exitCode: 0,
          lines: [],
          signal: null,
          stderr: "",
          stdout: ` ${openCodeSelection.version} \n`,
        };
      },
      spawnProcess: () => {
        serveCalls += 1;
        throw new Error("must not serve");
      },
      validateLiveContract: async () => ({ valid: true }),
    });

    await assert.rejects(
      server.startJob(jobOptions("job-framedversion001")),
      (error) => error.code === "OPENCODE_SERVER_PREFLIGHT_FAILED",
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, opencodePath);
    assert.deepEqual(calls[0].args, ["--version"]);
    assert.equal(calls[0].cwd, studioRoot);
    assert.equal(calls[0].timeoutMs, 5_000);
    assert.equal(calls[0].signal instanceof AbortSignal, true);
    assert.equal("OPENAI_API_KEY" in calls[0].env, false);
    assert.equal(serveCalls, 0);
  });

  await t.test("rejects a non-regular executable before running it", async () => {
    const unsafeExecutable = path.join(studioRoot, "unsafe-opencode.exe");
    await mkdir(unsafeExecutable);
    let processCalls = 0;
    let serveCalls = 0;
    const server = new OpenCodeServer({
      opencodePath: unsafeExecutable,
      expectedVersion: openCodeSelection.version,
      studioRoot,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: path.join(studioRoot, "unsafe-executable-data"),
      },
      preflightProcessRunner: async () => {
        processCalls += 1;
        return {
          exitCode: 0,
          lines: [],
          signal: null,
          stderr: "",
          stdout: `${openCodeSelection.version}\n`,
        };
      },
      spawnProcess: () => {
        serveCalls += 1;
        throw new Error("must not serve");
      },
      validateLiveContract: async () => ({ valid: true }),
    });

    await assert.rejects(
      server.startJob(jobOptions("job-unsafebinary0001")),
      (error) => error.code === "OPENCODE_SERVER_PREFLIGHT_FAILED",
    );
    assert.equal(processCalls, 0);
    assert.equal(serveCalls, 0);
  });

  for (const [index, scenario] of scenarios.entries()) {
    await t.test(scenario.name, async () => {
      await mkdir(scenario.dataHome, { recursive: true });
      const originalCanary = path.join(scenario.dataHome, "manual-video-canary.bin");
      await writeFile(originalCanary, `unchanged-${index}`, "utf8");
      const originalSnapshot = await snapshotTree(scenario.dataHome);
      const child = new FakeChild(44700 + index);
      let spawnedEnvironment;
      let resolvedAgents;
      let configCalls = 0;
      let mcpCalls = 0;
      let liveCapabilityToken = MCP_CAPABILITY_TOKEN;
      const jsonResponse = (value, status = 200) => ({
        ok: status === 200,
        status,
        json: async () => value,
      });
      const serverOptions = {
        opencodePath,
        expectedVersion: openCodeSelection.version,
        studioRoot,
        env: scenario.environment(),
        readinessTimeoutMs: 120_000,
        spawnProcess: (_command, _args, options) => {
          spawnedEnvironment = options.env;
          resolvedAgents = agentNames.map((name) => {
            if (name === "manual-video-planner") {
              const { tools: _debugOnlyTools, ...liveAgent } = planner.resolvedForDataHome(
                spawnedEnvironment.XDG_DATA_HOME,
              );
              return liveAgent;
            }
            if (name === "manual-video-executor") {
              const { tools: _debugOnlyTools, ...liveAgent } = executor.resolvedForDataHome(
                spawnedEnvironment.XDG_DATA_HOME,
              );
              return liveAgent;
            }
            return { name };
          });
          queueMicrotask(() => child.stdout.write("OpenCode server listening on 127.0.0.1:4096\n"));
          return child;
        },
        fetchImpl: async (url, options) => {
          assert.match(options.headers.Authorization, /^Basic\s/u);
          const pathname = new URL(url).pathname;
          if (pathname === "/global/health") return healthyResponse(openCodeSelection.version);
          if (pathname === "/config") {
            configCalls += 1;
            if (configCalls === 1) return jsonResponse({ retry: true }, 503);
            return jsonResponse({
              ...resolvedConfig,
              mcp: {
                playwright: {
                  ...resolvedConfig.mcp.playwright,
                  headers: { Authorization: `Bearer ${liveCapabilityToken}` },
                },
              },
            });
          }
          if (pathname === "/agent") return jsonResponse(resolvedAgents);
          if (pathname === "/experimental/tool/ids") return jsonResponse(toolIds);
          if (pathname === "/mcp") {
            mcpCalls += 1;
            if (mcpCalls === 1) throw new Error("transient reset");
            if (mcpCalls === 2) return jsonResponse({ playwright: { status: "connecting" } });
            return jsonResponse({ playwright: { status: "connected" } });
          }
          throw new Error("unexpected endpoint");
        },
        verifyPortOwner: async () => {},
        killTree: async () => child.close(),
        waitForPortClosed: async () => {},
      };
      let server;
      if (scenario.defaultHome) {
        const previousUserProfile = process.env.USERPROFILE;
        process.env.USERPROFILE = scenario.defaultHome;
        try {
          server = new OpenCodeServer(serverOptions);
        } finally {
          if (previousUserProfile === undefined) delete process.env.USERPROFILE;
          else process.env.USERPROFILE = previousUserProfile;
        }
      } else {
        server = new OpenCodeServer(serverOptions);
      }

      await server.startJob(jobOptions(`job-defaultpreflight${index + 1}`));
      const isolationRoot = path.dirname(spawnedEnvironment.XDG_CONFIG_HOME);
      assert.equal(spawnedEnvironment.XDG_DATA_HOME, path.join(isolationRoot, "data"));
      assert.notEqual(spawnedEnvironment.XDG_DATA_HOME, path.resolve(scenario.dataHome));
      await assert.rejects(
        lstat(path.join(spawnedEnvironment.XDG_DATA_HOME, "manual-video-canary.bin")),
        (error) => error.code === "ENOENT",
      );
      assert.equal(spawnedEnvironment.OPENCODE_TEST_HOME, spawnedEnvironment.HOME);
      assert.equal(spawnedEnvironment.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
      assert.equal(spawnedEnvironment.MANUAL_STUDIO_MCP_TOKEN, MCP_CAPABILITY_TOKEN);
      assert.equal("OPENAI_API_KEY" in spawnedEnvironment, false);
      assert.equal(configCalls, 2);
      assert.equal(mcpCalls, 3);
      const isolatedConfig = await readFile(
        path.join(spawnedEnvironment.XDG_CONFIG_HOME, "opencode", "opencode.json"),
        "utf8",
      );
      assert.equal(isolatedConfig.includes("{env:MANUAL_STUDIO_MCP_TOKEN}"), true);
      assert.equal(isolatedConfig.includes(MCP_CAPABILITY_TOKEN), false);

      liveCapabilityToken = OTHER_MCP_CAPABILITY_TOKEN;
      await assert.rejects(
        server.withAttachOptions("manual-video-planner", async (options) =>
          options.validateServerContract({
            agent: "manual-video-planner",
            baseUrl: options.baseUrl,
            studioRoot: options.studioRoot,
          })),
        (error) =>
          !String(error).includes(MCP_CAPABILITY_TOKEN) &&
          !String(error).includes(OTHER_MCP_CAPABILITY_TOKEN),
      );
      liveCapabilityToken = MCP_CAPABILITY_TOKEN;

      const plannerIndex = resolvedAgents.findIndex(({ name }) => name === "manual-video-planner");
      const livePlanner = resolvedAgents[plannerIndex];
      resolvedAgents[plannerIndex] = {
        ...livePlanner,
        tools: planner.resolvedForDataHome(spawnedEnvironment.XDG_DATA_HOME).tools,
      };
      await assert.rejects(
        server.withAttachOptions("manual-video-planner", async (options) =>
          options.validateServerContract({
            agent: "manual-video-planner",
            baseUrl: options.baseUrl,
            studioRoot: options.studioRoot,
          })),
        (error) => error instanceof Error,
      );
      resolvedAgents[plannerIndex] = livePlanner;

      const outside = path.join(studioRoot, `outside-canary-${index}`);
      const cleanupCanary = path.join(outside, "canary.txt");
      await mkdir(outside);
      await writeFile(cleanupCanary, "untouched", "utf8");
      await rm(spawnedEnvironment.XDG_CACHE_HOME, { recursive: true, force: true });
      await symlink(outside, spawnedEnvironment.XDG_CACHE_HOME, "junction");
      await server.stop();
      assert.equal(await readFile(cleanupCanary, "utf8"), "untouched");
      assert.deepEqual(await snapshotTree(scenario.dataHome), originalSnapshot);
      await assert.rejects(lstat(isolationRoot), (error) => error.code === "ENOENT");
    });
  }
});

test("default preflight rejects a changed trusted agent before invoking OpenCode", async (t) => {
  const studioRoot = await trustedStudioFixture(t, { mutateExecutor: true });
  let debugCalls = 0;
  let serveCalls = 0;
  const server = new OpenCodeServer({
    opencodePath: path.resolve("C:\\tools\\opencode.exe"),
    expectedVersion: "1.18.2",
    studioRoot,
    env: { ...process.env },
    preflightProcessRunner: async () => {
      debugCalls += 1;
      throw new Error("must not run");
    },
    spawnProcess: () => {
      serveCalls += 1;
      throw new Error("must not run");
    },
    validateLiveContract: async () => ({ valid: true }),
  });
  await assert.rejects(
    server.startJob(jobOptions("job-tamperedagent001")),
    (error) => error.code === "OPENCODE_SERVER_PREFLIGHT_FAILED",
  );
  assert.equal(debugCalls, 0);
  assert.equal(serveCalls, 0);
});

test("stop aborts and awaits the supervised default preflight before resolving", {
  skip: actualOpenCodeSkip("1.18.2"),
}, async () => {
  const before = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith("manual-video-opencode-")));
  const openCodeSelection = await selectedOpenCode();
  let entered;
  let runnerAborts = 0;
  let serveCalls = 0;
  const enteredPromise = new Promise((resolvePromise) => { entered = resolvePromise; });
  const server = new OpenCodeServer({
    opencodePath: openCodeSelection.path,
    expectedVersion: openCodeSelection.version,
    studioRoot: sourceStudioRoot,
    env: { ...process.env },
    preflightProcessRunner: async (options) => {
      entered();
      return new Promise((_resolvePromise, rejectPromise) => {
        const abort = () => {
          runnerAborts += 1;
          rejectPromise(Object.assign(new Error("aborted"), { code: "PROCESS_ABORTED" }));
        };
        options.signal.addEventListener("abort", abort, { once: true });
        if (options.signal.aborted) abort();
      });
    },
    spawnProcess: () => {
      serveCalls += 1;
      throw new Error("must not serve");
    },
    validateLiveContract: async () => ({ valid: true }),
  });
  const starting = server.startJob(jobOptions("job-stopdefaultpre01"));
  await enteredPromise;
  await server.stop();
  await assert.rejects(starting, (error) => error.code === "OPENCODE_SERVER_ABORTED");
  assert.equal(runnerAborts, 1);
  assert.equal(serveCalls, 0);
  const after = (await readdir(os.tmpdir())).filter((name) => name.startsWith("manual-video-opencode-") && !before.has(name));
  assert.deepEqual(after, []);
});
