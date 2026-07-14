import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { chromium } from "playwright";
import {
  BrowserRuntime,
  createOriginPolicy,
  validateMcpToolInventory,
  verifyPlaywrightMcpReady,
} from "../../src/adapters/browser-runtime.js";
import { JobStore } from "../../src/jobs/job-store.js";

const require = createRequire(import.meta.url);
const bootstrapPath = path.resolve("src/browser/browser-bootstrap-init.cjs");
const MCP_CAPABILITY_TOKEN = "A".repeat(43);

class FakeChild extends EventEmitter {
  constructor(pid = 89310) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  close() {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", 0, null);
  }
}

class FakeGateway {
  constructor(options, calls) {
    this.options = options;
    this.calls = calls;
    this.endpoint = null;
    this.active = null;
  }

  async start({ jobId, generation }) {
    this.calls.gatewayStart.push({ jobId, generation });
    this.endpoint = "http://127.0.0.1:8931/mcp";
    this.active = Object.freeze({
      endpoint: this.endpoint,
      jobId,
      generation,
      phase: "planning",
      remainingCalls: 0,
    });
    return this.active;
  }

  installApproval(input) {
    this.calls.gatewayApproval.push(input);
    this.active = Object.freeze({
      endpoint: this.endpoint,
      jobId: input.jobId,
      generation: input.generation,
      phase: "execution",
      remainingCalls: input.calls.length,
      planDigest: input.planDigest,
    });
    return Object.freeze({
      jobId: input.jobId,
      generation: input.generation,
      planDigest: input.planDigest,
      callCount: input.calls.length,
    });
  }

  async quarantine(code) {
    this.calls.gatewayQuarantine.push(code);
    if (this.active) this.active = Object.freeze({ ...this.active, phase: "quarantined" });
    return this.active;
  }

  async stop() {
    this.calls.gatewayStop.push(this.endpoint);
    this.endpoint = null;
    this.active = null;
  }
}

async function temporaryStudio(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "manual-studio-browser-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const studioRoot = path.join(base, "studio");
  const mcpPackageDir = path.join(studioRoot, "node_modules", "@playwright", "mcp");
  await mkdir(mcpPackageDir, { recursive: true });
  const fixtureBootstrap = path.join(studioRoot, "src", "browser", "browser-bootstrap-init.cjs");
  await mkdir(path.dirname(fixtureBootstrap), { recursive: true });
  await writeFile(fixtureBootstrap, await readFile(bootstrapPath), "utf8");
  await writeFile(
    path.join(mcpPackageDir, "package.json"),
    JSON.stringify({ name: "@playwright/mcp", version: "0.0.78", bin: { "playwright-mcp": "cli.js" } }),
    "utf8",
  );
  await writeFile(path.join(mcpPackageDir, "cli.js"), "process.exitCode = 0;\n", "utf8");
  return { base, mcpPackageDir, studioRoot };
}

function automaticJob() {
  return {
    id: "job-0123456789abcdef",
    targetUrl: "http://127.0.0.1:5001/app",
    originPolicy: createOriginPolicy({
      targetOrigin: "http://127.0.0.1:5001",
      authOrigins: ["http://127.0.0.1:5002"],
      resourceOrigins: ["http://127.0.0.1:5003"],
    }),
    blockedOrigins: ["http://localhost:5999"],
    auth: {
      mode: "automatic",
      loginOrigin: "http://127.0.0.1:5002",
      username: "automatic-user",
      password: "automatic-password",
      selectors: {
        username: '[name="username"]',
        password: '[name="password"]',
        submit: 'button[type="submit"]',
      },
    },
  };
}

function startRuntime(runtime, job, options = {}) {
  return runtime.start(job, {
    expectedOriginPolicyDigest: job.originPolicy.digest,
    mcpCapabilityToken: MCP_CAPABILITY_TOKEN,
    ...options,
  });
}

async function createHarness(t, overrides = {}) {
  const fixture = await temporaryStudio(t);
  const child = new FakeChild();
  const calls = {
    spawn: [],
    verify: [],
    stop: [],
    kill: [],
    gatewayConstruct: [],
    gatewayStart: [],
    gatewayApproval: [],
    gatewayQuarantine: [],
    gatewayStop: [],
    waitForPortClosed: [],
    verifyPortOwner: [],
    fatal: [],
  };
  const runtime = new BrowserRuntime({
    studioRoot: fixture.studioRoot,
    mcpPackageDir: fixture.mcpPackageDir,
    port: 8931,
    rawPort: 8932,
    env: {
      Path: process.env.Path ?? "",
      NODE_OPTIONS: "--inspect",
      PLAYWRIGHT_MCP_BROWSER: "firefox",
      PLAYWRIGHT_MCP_ALLOWED_ORIGINS: "http://attacker.invalid",
      OPENAI_API_KEY: "provider-secret",
      GITHUB_TOKEN: "github-secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
      OCI_CLI_KEY_FILE: "C:\\private\\oci.pem",
    },
    readinessTimeoutMs: 5_000,
    spawnProcess: (command, args, options) => {
      calls.spawn.push({ command, args, options });
      queueMicrotask(() => child.stderr.write("Listening on http://localhost:8932\n"));
      return child;
    },
    verifyMcpReady: async (endpoint, details) => {
      calls.verify.push({ endpoint, details });
      if (details.secretsFile) {
        assert.match(await readFile(details.secretsFile, "utf8"), /MCP_REDACT_USERNAME/u);
      }
      return { sessionId: "mcp-ready-session" };
    },
    stopRequest: async (endpoint, headers) => {
      calls.stop.push({ endpoint, headers });
      child.close();
    },
    killTree: async (target) => {
      calls.kill.push(target.pid);
      target.close();
    },
    waitForPortClosed: async (port) => calls.waitForPortClosed.push(port),
    verifyPortOwner: async (port, pid) => calls.verifyPortOwner.push({ port, pid }),
    gatewayFactory: (options) => {
      calls.gatewayConstruct.push(options);
      return new FakeGateway(options, calls);
    },
    onFatal: async (event) => calls.fatal.push(event),
    ...overrides,
  });
  return { ...fixture, calls, child, runtime };
}

test("BrowserRuntime builds the exact job MCP config and launches the pinned JS CLI through preload", async (t) => {
  const { calls, child, runtime, studioRoot } = await createHarness(t);
  const active = await startRuntime(runtime, automaticJob());

  assert.equal(calls.spawn.length, 1);
  assert.equal(calls.spawn[0].command, process.execPath);
  assert.equal(
    calls.spawn[0].options.cwd,
    path.join(studioRoot, "data", "jobs", automaticJob().id, "browser"),
  );
  assert.deepEqual(calls.spawn[0].args.slice(0, 4), [
    "--require",
    path.join(studioRoot, "src", "browser", "browser-bootstrap-init.cjs"),
    path.join(studioRoot, "node_modules", "@playwright", "mcp", "cli.js"),
    "--config",
  ]);
  const configPath = calls.spawn[0].args[4];
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(config.browser, {
    browserName: "chromium",
    isolated: false,
    userDataDir: path.join(studioRoot, "data", "browser-profile"),
    launchOptions: { channel: "msedge", headless: false },
    contextOptions: {
      viewport: { width: 1920, height: 1080 },
      serviceWorkers: "block",
    },
    initPage: [path.join(studioRoot, "src", "browser", "browser-bootstrap-init.cjs")],
  });
  assert.deepEqual(config.server, {
    host: "127.0.0.1",
    port: 8932,
    allowedHosts: ["127.0.0.1:8932", "localhost:8932"],
  });
  assert.deepEqual(config.capabilities, ["core", "devtools"]);
  assert.equal(config.sharedBrowserContext, true);
  assert.equal(config.saveSession, true);
  assert.equal(config.outputDir, path.join(studioRoot, "data", "jobs", automaticJob().id, "browser"));
  assert.deepEqual(config.network.allowedOrigins, [
    "http://127.0.0.1:5001",
    "http://127.0.0.1:5002",
    "http://127.0.0.1:5003",
  ]);
  assert.deepEqual(config.network.blockedOrigins, ["http://localhost:5999"]);
  assert.equal(JSON.stringify(config).includes("automatic-user"), false);
  assert.equal(JSON.stringify(config).includes("automatic-password"), false);
  assert.equal(JSON.stringify(config).includes(MCP_CAPABILITY_TOKEN), false);
  assert.equal(calls.verify.length, 1);
  assert.deepEqual(calls.verifyPortOwner, [{ port: 8932, pid: child.pid }]);
  assert.equal(calls.verify[0].endpoint, "http://127.0.0.1:8932/mcp");
  assert.equal(calls.gatewayConstruct.length, 1);
  assert.equal(calls.gatewayConstruct[0].upstreamUrl, "http://127.0.0.1:8932/mcp");
  assert.equal(calls.gatewayConstruct[0].port, 8931);
  assert.equal(calls.gatewayConstruct[0].capabilityToken, MCP_CAPABILITY_TOKEN);
  assert.equal(typeof calls.gatewayConstruct[0].onFatal, "function");
  assert.deepEqual(calls.gatewayStart, [{ jobId: automaticJob().id, generation: 1 }]);
  assert.equal(active.endpoint, "http://127.0.0.1:8931/mcp");
  assert.equal(active.phase, "planning");
  assert.equal(runtime.active, active);

  const childEnv = calls.spawn[0].options.env;
  assert.equal(childEnv.MANUAL_STUDIO_LOGIN_USERNAME, "automatic-user");
  assert.equal(childEnv.MANUAL_STUDIO_LOGIN_PASSWORD, "automatic-password");
  assert.equal(childEnv.MANUAL_STUDIO_LOGIN_ORIGIN, "http://127.0.0.1:5002");
  assert.equal(childEnv.MANUAL_STUDIO_TARGET_URL, "http://127.0.0.1:5001/app");
  assert.equal(Object.values(childEnv).includes(MCP_CAPABILITY_TOKEN), false);
  assert.deepEqual(JSON.parse(childEnv.MANUAL_STUDIO_NAVIGATION_ORIGINS), [
    "http://127.0.0.1:5001",
    "http://127.0.0.1:5002",
  ]);
  assert.equal("NODE_OPTIONS" in childEnv, false);
  assert.equal("PLAYWRIGHT_MCP_BROWSER" in childEnv, false);
  assert.equal("PLAYWRIGHT_MCP_ALLOWED_ORIGINS" in childEnv, false);
  assert.equal("OPENAI_API_KEY" in childEnv, false);
  assert.equal("GITHUB_TOKEN" in childEnv, false);
  assert.equal("AWS_SECRET_ACCESS_KEY" in childEnv, false);
  assert.equal("OCI_CLI_KEY_FILE" in childEnv, false);
  await assert.rejects(stat(childEnv.PLAYWRIGHT_MCP_SECRETS_FILE), /ENOENT/u);
  await runtime.stop();
});

test("Playwright MCP readiness rejects tool inventory drift before any browser tool executes", async () => {
  for (const tools of [
    [],
    [{ name: "browser_snapshot" }, { name: "browser_snapshot" }],
    [{ name: "browser_snapshot" }, { name: "browser_new_dangerous_tool" }],
  ]) {
    assert.throws(
      () => validateMcpToolInventory({ result: { tools } }),
      (error) => error.code === "BROWSER_RUNTIME_TOOL_DRIFT",
    );
  }

  const calls = [];
  const sse = (value, init = {}) => new Response(`event: message\ndata: ${JSON.stringify(value)}\n\n`, init);
  await assert.rejects(
    verifyPlaywrightMcpReady("http://127.0.0.1:8931/mcp", {
      signal: AbortSignal.timeout(2_000),
      fetchImpl: async (_url, options) => {
        calls.push({ method: options.method, body: options.body });
        if (options.method === "GET") return new Response("probe", { status: 400 });
        if (options.method === "DELETE") return new Response(null, { status: 200 });
        const request = JSON.parse(options.body);
        if (request.method === "initialize") {
          return sse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } }, {
            status: 200,
            headers: { "mcp-session-id": "fixture-session" },
          });
        }
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (request.method === "tools/list") {
          return sse({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "browser_snapshot" }] } }, { status: 200 });
        }
        throw new Error("snapshot must not execute after tool drift");
      },
    }),
    (error) => error.code === "BROWSER_RUNTIME_TOOL_DRIFT",
  );
  assert.equal(calls.some((call) => String(call.body).includes("tools/call")), false);
  assert.equal(calls.at(-1).method, "DELETE");
});

test("BrowserRuntime proves the random raw listener belongs to the spawned MCP tree before readiness", async (t) => {
  const { calls, runtime } = await createHarness(t, {
    verifyPortOwner: async () => { throw new Error("foreign listener"); },
  });
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  await assert.rejects(startRuntime(runtime, job), (error) => error.code === "BROWSER_RUNTIME_START_FAILED");
  assert.equal(calls.verify.length, 0);
  assert.equal(calls.gatewayConstruct.length, 0);
  assert.equal(calls.stop.length, 1);
  assert.equal(runtime.active, null);
});

test("BrowserRuntime manual mode passes no login values and one process remains across phases", async (t) => {
  const { calls, runtime } = await createHarness(t);
  const job = {
    ...automaticJob(),
    auth: { mode: "manual" },
  };
  const active = await startRuntime(runtime, job);
  assert.equal("MANUAL_STUDIO_LOGIN_USERNAME" in calls.spawn[0].options.env, false);
  assert.equal("MANUAL_STUDIO_LOGIN_PASSWORD" in calls.spawn[0].options.env, false);
  assert.equal("PLAYWRIGHT_MCP_SECRETS_FILE" in calls.spawn[0].options.env, false);
  assert.equal(runtime.active, active);
  assert.equal(runtime.active, active);
  await assert.rejects(startRuntime(runtime, job), (error) => error.code === "BROWSER_RUNTIME_BUSY");
  assert.equal(calls.spawn.length, 1);
  await runtime.stop();
});

test("BrowserRuntime installs the immutable approval queue only on its active gateway generation", async (t) => {
  const { calls, runtime } = await createHarness(t);
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  const active = await startRuntime(runtime, job);
  const approval = {
    jobId: job.id,
    generation: active.generation,
    planDigest: "a".repeat(64),
    calls: [
      { id: "call-001", tool: "browser_click", arguments: { target: "button-save" } },
    ],
  };

  assert.deepEqual(runtime.installApproval(approval), {
    jobId: job.id,
    generation: active.generation,
    planDigest: approval.planDigest,
    callCount: 1,
  });
  assert.equal(runtime.active.phase, "execution");
  assert.equal(runtime.active.planDigest, approval.planDigest);
  assert.deepEqual(calls.gatewayApproval, [approval]);
  await runtime.stop();
  assert.throws(
    () => runtime.installApproval(approval),
    (error) => error.code === "BROWSER_RUNTIME_INACTIVE",
  );
});

test("a gateway policy fatal is surfaced and stops the raw browser runtime", async (t) => {
  const { calls, runtime } = await createHarness(t);
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  const active = await startRuntime(runtime, job);
  const event = Object.freeze({
    code: "MCP_GATEWAY_FATAL",
    reason: "EXECUTION_CALL_MISMATCH",
    jobId: job.id,
    generation: active.generation,
    phase: "execution",
  });

  await calls.gatewayConstruct[0].onFatal(event);
  assert.deepEqual(calls.fatal, [event]);
  assert.equal(runtime.active, null);
  assert.equal(calls.stop.length, 1);
  assert.equal(calls.gatewayStop.length, 1);
});

test("raw MCP closing while the gateway starts can never produce an active runtime", async (t) => {
  let releaseGateway;
  let gatewayEntered;
  const entered = new Promise((resolvePromise) => { gatewayEntered = resolvePromise; });
  const blocked = new Promise((resolvePromise) => { releaseGateway = resolvePromise; });
  const { calls, child, runtime } = await createHarness(t, {
    gatewayFactory: (options) => {
      calls.gatewayConstruct.push(options);
      const gateway = new FakeGateway(options, calls);
      const start = gateway.start.bind(gateway);
      gateway.start = async (input) => {
        gatewayEntered();
        await blocked;
        return await start(input);
      };
      return gateway;
    },
  });
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  const starting = startRuntime(runtime, job);
  await entered;
  child.close();
  releaseGateway();

  await assert.rejects(starting, (error) => error.code === "BROWSER_RUNTIME_START_FAILED");
  assert.equal(runtime.active, null);
});

test("a gateway start cleanup failure is surfaced and retains a retryable quarantine", async (t) => {
  let allowStop = false;
  const { calls, runtime } = await createHarness(t, {
    gatewayFactory: (options) => {
      calls.gatewayConstruct.push(options);
      const gateway = new FakeGateway(options, calls);
      gateway.start = async () => { throw new Error("bind failed"); };
      gateway.stop = async () => {
        if (!allowStop) throw new Error("listener remains");
        gateway.endpoint = null;
        gateway.active = null;
      };
      return gateway;
    },
  });
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  await assert.rejects(startRuntime(runtime, job), (error) => error.code === "BROWSER_RUNTIME_STOP_FAILED");
  assert.equal(calls.stop.length, 1, "raw MCP must still be stopped after gateway cleanup failure");
  await assert.rejects(startRuntime(runtime, job), (error) => error.code === "BROWSER_RUNTIME_BUSY");
  allowStop = true;
  await runtime.stop();
  assert.equal(runtime.active, null);
});

test("BrowserRuntime accepts the canonical UUID emitted by the default JobStore", async (t) => {
  const { runtime, studioRoot } = await createHarness(t);
  const store = new JobStore({ root: path.join(studioRoot, "data", "jobs") });
  const created = await store.create({
    targetUrl: "http://127.0.0.1:5001/",
    prompt: "메뉴 사용법을 안내해 주세요.",
    authMode: "manual",
  });
  const job = { ...automaticJob(), id: created.id, auth: { mode: "manual" } };
  const active = await startRuntime(runtime, job);
  assert.equal(active.jobId, created.id);
  await runtime.stop();
});

test("BrowserRuntime selects a fresh high raw MCP port for every production job", async (t) => {
  const children = [];
  let harnessCalls;
  const harness = await createHarness(t, {
    rawPort: undefined,
    spawnProcess: (command, args, options) => {
      const child = new FakeChild(92000 + children.length);
      children.push(child);
      harnessCalls.spawn.push({ command, args, options });
      void readFile(args[4], "utf8").then((source) => {
        const config = JSON.parse(source);
        child.stderr.write(`Listening on http://localhost:${config.server.port}\n`);
      });
      return child;
    },
    stopRequest: async () => children.at(-1)?.close(),
    killTree: async (child) => child.close(),
  });
  harnessCalls = harness.calls;
  const { calls, runtime } = harness;
  const job = { ...automaticJob(), auth: { mode: "manual" } };

  await startRuntime(runtime, job);
  await runtime.stop();
  await startRuntime(runtime, job);
  await runtime.stop();

  const ports = calls.verify.map(({ endpoint }) => Number(new URL(endpoint).port));
  assert.equal(ports.length, 2);
  assert.ok(ports.every((port) => port >= 49_152 && port <= 65_535));
  assert.notEqual(ports[0], ports[1]);
  assert.deepEqual(calls.verifyPortOwner.map(({ port }) => port), ports);
});

test("BrowserRuntime stop uses authenticated MCP shutdown then bounded tree fallback", async (t) => {
  const { calls, child, runtime } = await createHarness(t, {
    stopRequest: async (endpoint, headers) => {
      calls.stop.push({ endpoint, headers });
      // Simulate an unresponsive MCP process; fallback must terminate it.
    },
  });
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  await startRuntime(runtime, job);
  await runtime.stop();
  assert.deepEqual(calls.stop, [{
    endpoint: "http://127.0.0.1:8932/killkillkill",
    headers: { "x-pw-mcp-kill": "1" },
  }]);
  assert.deepEqual(calls.gatewayStop, ["http://127.0.0.1:8931/mcp"]);
  assert.deepEqual(calls.kill, [child.pid]);
  assert.equal(runtime.active, null);
});

test("a gateway shutdown failure still stops raw MCP and keeps the runtime quarantined for retry", async (t) => {
  let gateway;
  let stopAttempts = 0;
  const { calls, runtime } = await createHarness(t, {
    gatewayFactory: (options) => {
      calls.gatewayConstruct.push(options);
      gateway = new FakeGateway(options, calls);
      const stop = gateway.stop.bind(gateway);
      gateway.stop = async () => {
        stopAttempts += 1;
        if (stopAttempts === 1) throw new Error("gateway still listening");
        await stop();
      };
      return gateway;
    },
  });
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  await startRuntime(runtime, job);

  await assert.rejects(
    runtime.stop(),
    (error) => error.code === "BROWSER_RUNTIME_STOP_FAILED",
  );
  assert.equal(calls.stop.length, 1, "raw MCP shutdown must be attempted even if the gateway fails");
  await assert.rejects(
    startRuntime(runtime, job),
    (error) => error.code === "BROWSER_RUNTIME_BUSY",
  );

  await runtime.stop();
  assert.equal(stopAttempts, 2);
  assert.equal(runtime.active, null);
});

test("raw MCP termination starts without waiting for a stalled gateway shutdown", async (t) => {
  let releaseGateway;
  const blocked = new Promise((resolvePromise) => { releaseGateway = resolvePromise; });
  const { calls, runtime } = await createHarness(t, {
    gatewayFactory: (options) => {
      calls.gatewayConstruct.push(options);
      const gateway = new FakeGateway(options, calls);
      const stop = gateway.stop.bind(gateway);
      gateway.stop = async () => {
        await blocked;
        await stop();
      };
      return gateway;
    },
  });
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  await startRuntime(runtime, job);
  const stopping = runtime.stop();
  const deadline = Date.now() + 1_000;
  while (calls.stop.length === 0 && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.equal(calls.stop.length, 1, "raw shutdown must not wait for gateway.close()");
  releaseGateway();
  await stopping;
  assert.equal(runtime.active, null);
});

test("BrowserRuntime scavenges stale ephemeral credentials and cleans on startup failure and abort", async (t) => {
  const { runtime, studioRoot } = await createHarness(t, {
    verifyMcpReady: async () => { throw new Error("secret readiness detail"); },
  });
  const stale = path.join(studioRoot, ".runtime", "secrets", `op-${"a".repeat(32)}`);
  await mkdir(stale, { recursive: true });
  await writeFile(path.join(stale, ".mcp-redaction.env"), "MCP_REDACT_USERNAME='stale'\nMCP_REDACT_PASSWORD='stale'\n", "utf8");
  await assert.rejects(
    startRuntime(runtime, automaticJob()),
    (error) => error.code === "BROWSER_RUNTIME_START_FAILED" && !String(error).includes("secret readiness"),
  );
  await assert.rejects(stat(stale), /ENOENT/u);

  const controller = new AbortController();
  controller.abort(new Error("abort secret"));
  await assert.rejects(
    startRuntime(runtime, { ...automaticJob(), auth: { mode: "manual" } }, { signal: controller.signal }),
    (error) => error.code === "BROWSER_RUNTIME_ABORTED" && !String(error).includes("secret"),
  );
});

test("stop aborts and joins a non-settling readiness verifier before releasing automatic-login secrets", async (t) => {
  let entered;
  let secretsFile;
  const verifierEntered = new Promise((resolvePromise) => { entered = resolvePromise; });
  const { calls, runtime } = await createHarness(t, {
    verifyMcpReady: async (_endpoint, details) => {
      secretsFile = details.secretsFile;
      entered();
      await new Promise(() => {});
    },
  });
  const starting = startRuntime(runtime, automaticJob());
  await verifierEntered;
  assert.equal(typeof secretsFile, "string");
  const startedAt = Date.now();
  await runtime.stop();
  assert.ok(Date.now() - startedAt < 1_000);
  await assert.rejects(starting, (error) => error.code === "BROWSER_RUNTIME_ABORTED");
  await assert.rejects(stat(secretsFile), /ENOENT/u);
  assert.equal(calls.stop.length, 1);
  assert.equal(runtime.active, null);
});

test("BrowserRuntime rejects unsafe origins, paths, selectors, prototypes, and package-version drift", async (t) => {
  const { runtime } = await createHarness(t);
  const attacks = [
    { targetUrl: "data:text/html,<script>globalThis.ran=true</script>" },
    { targetUrl: "http://127.0.0.1:5002/login" },
    { originPolicy: { ...automaticJob().originPolicy, targetOrigin: "https://example.com" } },
    { originPolicy: { ...automaticJob().originPolicy, resourceOrigins: ["http://attacker.invalid"] } },
    { blockedOrigins: ["javascript:alert(1)"] },
    { auth: { ...automaticJob().auth, selectors: { ...automaticJob().auth.selectors, username: "input, iframe" } } },
  ];
  for (const attack of attacks) {
    await assert.rejects(
      runtime.start(
        { ...automaticJob(), ...attack },
        { expectedOriginPolicyDigest: automaticJob().originPolicy.digest },
      ),
      (error) => error.code === "INVALID_BROWSER_JOB",
    );
  }

  const stale = automaticJob();
  const mutated = {
    ...stale,
    originPolicy: {
      ...stale.originPolicy,
      resourceOrigins: [...stale.originPolicy.resourceOrigins, "http://attacker.invalid"],
    },
  };
  await assert.rejects(
    runtime.start(mutated, {
      expectedOriginPolicyDigest: stale.originPolicy.digest,
      mcpCapabilityToken: MCP_CAPABILITY_TOKEN,
    }),
    (error) => error.code === "INVALID_BROWSER_JOB",
  );

  const reauthorized = {
    ...stale,
    originPolicy: createOriginPolicy({
      targetOrigin: stale.originPolicy.targetOrigin,
      authOrigins: stale.originPolicy.authOrigins,
      resourceOrigins: [...stale.originPolicy.resourceOrigins, "http://attacker.invalid"],
    }),
  };
  await assert.rejects(
    runtime.start(reauthorized, {
      expectedOriginPolicyDigest: stale.originPolicy.digest,
      mcpCapabilityToken: MCP_CAPABILITY_TOKEN,
    }),
    (error) => error.code === "INVALID_BROWSER_JOB",
  );
  await assert.rejects(
    runtime.start(stale),
    (error) => error.code === "INVALID_BROWSER_START_OPTIONS",
  );

  const hostile = Object.create({ get id() { throw new Error("getter secret"); } });
  await assert.rejects(
    runtime.start(hostile, {
      expectedOriginPolicyDigest: "a".repeat(64),
      mcpCapabilityToken: MCP_CAPABILITY_TOKEN,
    }),
    (error) => error.code === "INVALID_BROWSER_JOB" && !String(error).includes("secret"),
  );
});

test("BrowserRuntime serializes concurrent starts and active-job abort stops the tree", async (t) => {
  const { calls, runtime } = await createHarness(t);
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  const controller = new AbortController();
  const attempts = await Promise.allSettled([
    startRuntime(runtime, job, { signal: controller.signal }),
    startRuntime(runtime, job),
  ]);
  assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((entry) => entry.status === "rejected" && entry.reason.code === "BROWSER_RUNTIME_BUSY").length, 1);
  controller.abort(new Error("abort secret"));
  const deadline = Date.now() + 2_000;
  while (runtime.active && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.equal(runtime.active, null);
  assert.equal(calls.stop.length, 1);
});

test("BrowserRuntime stop invalidates a start before any MCP child is spawned", async (t) => {
  const { calls, runtime } = await createHarness(t);
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  const starting = startRuntime(runtime, job);
  await runtime.stop();
  await assert.rejects(
    starting,
    (error) => error.code === "BROWSER_RUNTIME_ABORTED",
  );
  assert.equal(calls.spawn.length, 0);
  assert.equal(runtime.active, null);
  await startRuntime(runtime, job);
  assert.equal(calls.spawn.length, 1);
  await runtime.stop();
});

test("BrowserRuntime quarantines an MCP child whose termination cannot be confirmed", async (t) => {
  const child = new FakeChild(process.pid);
  const { calls, runtime } = await createHarness(t, {
    spawnProcess: () => {
      queueMicrotask(() => child.stderr.write("Listening on http://localhost:8932\n"));
      return child;
    },
    stopRequest: async () => {},
    killTree: async () => {},
  });
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  await startRuntime(runtime, job);
  await assert.rejects(
    runtime.stop(),
    (error) => error.code === "BROWSER_RUNTIME_STOP_FAILED",
  );
  await assert.rejects(
    startRuntime(runtime, job),
    (error) => error.code === "BROWSER_RUNTIME_BUSY",
  );
});

test("a readiness failure never hides an unkillable raw MCP cleanup failure", async (t) => {
  const child = new FakeChild(process.pid);
  const { runtime } = await createHarness(t, {
    spawnProcess: () => {
      queueMicrotask(() => child.stderr.write("Listening on http://localhost:8932\n"));
      return child;
    },
    verifyMcpReady: async () => { throw new Error("readiness failed"); },
    stopRequest: async () => {},
    killTree: async () => {},
  });
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  await assert.rejects(startRuntime(runtime, job), (error) => error.code === "BROWSER_RUNTIME_STOP_FAILED");
  await assert.rejects(startRuntime(runtime, job), (error) => error.code === "BROWSER_RUNTIME_BUSY");
});

test("BrowserRuntime clears stale active state after an unexpected child crash", async (t) => {
  const children = [];
  const { calls, runtime } = await createHarness(t, {
    spawnProcess: () => {
      const child = new FakeChild(90000 + children.length);
      children.push(child);
      queueMicrotask(() => child.stderr.write("Listening on http://localhost:8932\n"));
      return child;
    },
    stopRequest: async () => children.at(-1)?.close(),
    killTree: async (child) => child.close(),
  });
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  await startRuntime(runtime, job);
  children[0].close();
  const deadline = Date.now() + 2_000;
  while (runtime.active && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.equal(runtime.active, null);
  assert.deepEqual(calls.gatewayQuarantine, ["RAW_MCP_CLOSED"]);
  await startRuntime(runtime, job);
  assert.equal(children.length, 2);
  await runtime.stop();
});

test("an unexpected raw MCP close cannot restart until its port closure is re-proven", async (t) => {
  const children = [];
  let portChecks = 0;
  const { runtime } = await createHarness(t, {
    spawnProcess: () => {
      const child = new FakeChild(91000 + children.length);
      children.push(child);
      queueMicrotask(() => child.stderr.write("Listening on http://localhost:8932\n"));
      return child;
    },
    waitForPortClosed: async () => {
      portChecks += 1;
      if (portChecks < 3) throw new Error("raw listener remains");
    },
    stopRequest: async () => children.at(-1)?.close(),
    killTree: async (child) => child.close(),
  });
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  await startRuntime(runtime, job);
  children[0].close();
  const deadline = Date.now() + 2_000;
  while (portChecks === 0 && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }

  await assert.rejects(startRuntime(runtime, job), (error) => error.code === "BROWSER_RUNTIME_BUSY");
  await assert.rejects(runtime.stop(), (error) => error.code === "BROWSER_RUNTIME_STOP_FAILED");
  await assert.rejects(startRuntime(runtime, job), (error) => error.code === "BROWSER_RUNTIME_BUSY");
  await runtime.stop();
  await startRuntime(runtime, job);
  assert.equal(children.length, 2);
  await runtime.stop();
});

test("BrowserRuntime rejects a reparse-point profile before spawning Edge", async (t) => {
  const { base, calls, runtime, studioRoot } = await createHarness(t);
  const external = path.join(base, "external-profile");
  const profile = path.join(studioRoot, "data", "browser-profile");
  await mkdir(external, { recursive: true });
  await writeFile(path.join(external, "canary.txt"), "keep", "utf8");
  await mkdir(path.dirname(profile), { recursive: true });
  await symlink(external, profile, "junction");

  await assert.rejects(
    startRuntime(runtime, { ...automaticJob(), auth: { mode: "manual" } }),
    (error) => error.code === "BROWSER_RUNTIME_PATH_UNSAFE",
  );
  assert.equal(calls.spawn.length, 0);
  assert.equal(await readFile(path.join(external, "canary.txt"), "utf8"), "keep");
});

test("BrowserRuntime never follows a replaced config directory during cleanup", async (t) => {
  const { base, calls, runtime } = await createHarness(t);
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  await startRuntime(runtime, job);
  const configPath = calls.spawn[0].args[4];
  const configDirectory = path.dirname(configPath);
  const external = path.join(base, "cleanup-canary");
  await mkdir(external, { recursive: true });
  await writeFile(path.join(external, "canary.txt"), "keep", "utf8");
  await rm(configDirectory, { recursive: true, force: true });
  await symlink(external, configDirectory, "junction");

  await assert.rejects(
    runtime.stop(),
    (error) => error.code === "BROWSER_RUNTIME_CLEANUP_FAILED",
  );
  assert.equal(await readFile(path.join(external, "canary.txt"), "utf8"), "keep");
  await assert.rejects(
    startRuntime(runtime, job),
    (error) => error.code === "BROWSER_RUNTIME_BUSY",
  );
  await assert.rejects(
    runtime.stop(),
    (error) => error.code === "BROWSER_RUNTIME_CLEANUP_FAILED",
  );
});

function loadFreshBootstrap(environment) {
  const completeEnvironment = { ...environment };
  if (!completeEnvironment.MANUAL_STUDIO_TARGET_URL) {
    const [firstOrigin] = JSON.parse(completeEnvironment.MANUAL_STUDIO_ALLOWED_ORIGINS);
    completeEnvironment.MANUAL_STUDIO_TARGET_URL = `${firstOrigin}/`;
  }
  if (!completeEnvironment.MANUAL_STUDIO_NAVIGATION_ORIGINS) {
    const [firstAllowedOrigin] = JSON.parse(completeEnvironment.MANUAL_STUDIO_ALLOWED_ORIGINS);
    let targetOrigin = firstAllowedOrigin;
    try {
      const parsedTarget = new URL(completeEnvironment.MANUAL_STUDIO_TARGET_URL);
      if (parsedTarget.protocol === "http:" || parsedTarget.protocol === "https:") targetOrigin = parsedTarget.origin;
    } catch {
      // Let the bootstrap module report the invalid target itself.
    }
    const origins = [targetOrigin];
    if (completeEnvironment.MANUAL_STUDIO_LOGIN_ORIGIN) origins.push(completeEnvironment.MANUAL_STUDIO_LOGIN_ORIGIN);
    completeEnvironment.MANUAL_STUDIO_NAVIGATION_ORIGINS = JSON.stringify([...new Set(origins)]);
  }
  const saved = {};
  for (const [key, value] of Object.entries(completeEnvironment)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  delete require.cache[require.resolve(bootstrapPath)];
  let loaded;
  try {
    loaded = require(bootstrapPath);
  } catch (error) {
    for (const key of Object.keys(completeEnvironment)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete require.cache[require.resolve(bootstrapPath)];
    throw error;
  }
  return {
    loaded,
    restore() {
      for (const key of Object.keys(completeEnvironment)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      delete require.cache[require.resolve(bootstrapPath)];
    },
  };
}

test("browser bootstrap preload captures and erases credentials before browser launch then logs in once", async () => {
  const credentials = {
    MANUAL_STUDIO_ALLOWED_ORIGINS: JSON.stringify(["http://127.0.0.1:5001"]),
    MANUAL_STUDIO_AUTH_MODE: "automatic",
    MANUAL_STUDIO_LOGIN_ORIGIN: "http://127.0.0.1:5001",
    MANUAL_STUDIO_LOGIN_USERNAME: "preload-user",
    MANUAL_STUDIO_LOGIN_PASSWORD: "preload-password",
    MANUAL_STUDIO_USERNAME_SELECTOR: '[name="username"]',
    MANUAL_STUDIO_PASSWORD_SELECTOR: '[name="password"]',
    MANUAL_STUDIO_SUBMIT_SELECTOR: 'button[type="submit"]',
  };
  const { loaded, restore } = loadFreshBootstrap(credentials);
  try {
    assert.equal(typeof loaded.default, "function");
    assert.equal(process.env.MANUAL_STUDIO_LOGIN_USERNAME, undefined);
    assert.equal(process.env.MANUAL_STUDIO_LOGIN_PASSWORD, undefined);
    const calls = [];
    let handler;
    let downloadHandler;
    const context = {
      _options: { serviceWorkers: "block" },
      serviceWorkers: () => [],
      addInitScript: async () => {},
      route: async () => {},
      routeWebSocket: async () => {},
      newCDPSession: async () => ({ on: () => {}, send: async () => {} }),
    };
    const page = {
      context: () => context,
      goto: async () => {},
      on: (name, callback) => {
        if (name === "domcontentloaded") handler = callback;
        else if (name === "download") downloadHandler = callback;
      },
      off: () => {},
      url: () => "http://127.0.0.1:5001/login",
      locator: (selector) => ({
        fill: async (value) => calls.push(["fill", selector, value]),
        click: async () => calls.push(["click", selector]),
      }),
    };
    await loaded.default({ page });
    await handler();
    assert.deepEqual(calls, [
      ["fill", '[name="username"]', "preload-user"],
      ["fill", '[name="password"]', "preload-password"],
      ["click", 'button[type="submit"]'],
    ]);
    await assert.doesNotReject(handler());
    assert.equal(calls.length, 3);
    let canceled = 0;
    await downloadHandler({ cancel: async () => { canceled += 1; } });
    assert.equal(canceled, 1);
  } finally {
    restore();
  }
});

test("automatic login ignores earlier approved pages and consumes credentials only at login origin", async () => {
  const { loaded, restore } = loadFreshBootstrap({
    MANUAL_STUDIO_ALLOWED_ORIGINS: JSON.stringify([
      "http://127.0.0.1:5001",
      "http://127.0.0.1:5002",
    ]),
    MANUAL_STUDIO_AUTH_MODE: "automatic",
    MANUAL_STUDIO_LOGIN_ORIGIN: "http://127.0.0.1:5002",
    MANUAL_STUDIO_LOGIN_USERNAME: "redirect-user",
    MANUAL_STUDIO_LOGIN_PASSWORD: "redirect-password",
  });
  try {
    const handlers = new Map();
    const removed = [];
    const calls = [];
    let currentUrl = "http://127.0.0.1:5001/landing";
    const context = {
      _options: { serviceWorkers: "block" },
      serviceWorkers: () => [],
      addInitScript: async () => {},
      route: async () => {},
      routeWebSocket: async () => {},
      newCDPSession: async () => ({ on: () => {}, send: async () => {} }),
    };
    const page = {
      context: () => context,
      goto: async (url) => { currentUrl = url; },
      on: (name, callback) => handlers.set(name, callback),
      off: (name, callback) => removed.push([name, callback]),
      url: () => currentUrl,
      close: async () => calls.push(["close"]),
      locator: (selector) => ({
        fill: async (value) => calls.push(["fill", selector, value]),
        click: async () => calls.push(["click", selector]),
      }),
    };
    await loaded.default({ page });
    const login = handlers.get("domcontentloaded");
    await login();
    assert.deepEqual(calls, []);
    assert.equal(removed.length, 0);
    currentUrl = "http://127.0.0.1:5002/login";
    await login();
    assert.equal(calls.length, 3);
    assert.equal(removed.length, 1);
    await login();
    assert.equal(calls.length, 3);
  } finally {
    restore();
  }
});

test("browser bootstrap continues a normal 304 cache revalidation response", async () => {
  const { loaded, restore } = loadFreshBootstrap({
    MANUAL_STUDIO_ALLOWED_ORIGINS: JSON.stringify(["http://127.0.0.1:5001"]),
    MANUAL_STUDIO_AUTH_MODE: "manual",
  });
  try {
    let paused;
    const commands = [];
    const session = {
      on: (name, callback) => { if (name === "Fetch.requestPaused") paused = callback; },
      send: async (method, params) => commands.push([method, params]),
    };
    const context = {
      _options: { serviceWorkers: "block" },
      serviceWorkers: () => [],
      addInitScript: async () => {},
      route: async () => {},
      routeWebSocket: async () => {},
      newCDPSession: async () => session,
    };
    const page = {
      context: () => context,
      goto: async () => {},
      on: () => {},
      close: async () => {},
    };
    await loaded.default({ page });
    paused({
      requestId: "request-304",
      request: { url: "http://127.0.0.1:5001/app.js" },
      responseStatusCode: 304,
      responseHeaders: [],
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.deepEqual(commands.at(-1), [
      "Fetch.continueResponse",
      { requestId: "request-304" },
    ]);
  } finally {
    restore();
  }
});

test("browser bootstrap owns the one initial HTTP navigation and rejects data targets", async () => {
  const { loaded, restore } = loadFreshBootstrap({
    MANUAL_STUDIO_ALLOWED_ORIGINS: JSON.stringify(["http://127.0.0.1:5001"]),
    MANUAL_STUDIO_TARGET_URL: "http://127.0.0.1:5001/manual/start",
    MANUAL_STUDIO_AUTH_MODE: "manual",
  });
  try {
    const navigations = [];
    const context = {
      _options: { serviceWorkers: "block" },
      serviceWorkers: () => [],
      addInitScript: async () => {},
      route: async () => {},
      routeWebSocket: async () => {},
      newCDPSession: async () => ({ on: () => {}, send: async () => {} }),
    };
    const page = () => ({
      context: () => context,
      goto: async (url, options) => navigations.push([url, options]),
      on: () => {},
    });
    await loaded.default({ page: page() });
    await loaded.default({ page: page() });
    assert.deepEqual(navigations, [[
      "http://127.0.0.1:5001/manual/start",
      { waitUntil: "domcontentloaded" },
    ]]);
  } finally {
    restore();
  }

  assert.throws(
    () => loadFreshBootstrap({
      MANUAL_STUDIO_ALLOWED_ORIGINS: JSON.stringify(["http://127.0.0.1:5001"]),
      MANUAL_STUDIO_TARGET_URL: "data:text/html,<script>globalThis.ran=true</script>",
      MANUAL_STUDIO_AUTH_MODE: "manual",
    }),
    /Invalid browser target URL/u,
  );
});

test("browser bootstrap permits resource requests but never top-level resource-origin navigation", async () => {
  const targetOrigin = "http://127.0.0.1:5001";
  const resourceOrigin = "http://127.0.0.1:5003";
  const { loaded, restore } = loadFreshBootstrap({
    MANUAL_STUDIO_ALLOWED_ORIGINS: JSON.stringify([targetOrigin, resourceOrigin]),
    MANUAL_STUDIO_NAVIGATION_ORIGINS: JSON.stringify([targetOrigin]),
    MANUAL_STUDIO_TARGET_URL: `${targetOrigin}/manual`,
    MANUAL_STUDIO_AUTH_MODE: "manual",
  });
  try {
    let routeHandler;
    let frameHandler;
    let closed = 0;
    let initArguments;
    const mainFrame = { url: () => `${resourceOrigin}/landing` };
    const context = {
      _options: { serviceWorkers: "block" },
      serviceWorkers: () => [],
      addInitScript: async (_script, args) => { initArguments = args; },
      route: async (_pattern, handler) => { routeHandler = handler; },
      routeWebSocket: async () => {},
      newCDPSession: async () => ({ on: () => {}, send: async () => {} }),
      close: async () => { closed += 1; },
    };
    const page = {
      context: () => context,
      goto: async () => {},
      mainFrame: () => mainFrame,
      on: (name, handler) => { if (name === "framenavigated") frameHandler = handler; },
      close: async () => { closed += 1; },
    };
    await loaded.default({ page });
    assert.deepEqual(initArguments, { origins: [targetOrigin] });
    let continued = 0;
    await routeHandler({
      request: () => ({
        frame: () => ({ page: () => page }),
        url: () => `${resourceOrigin}/asset.png`,
      }),
      fallback: async () => { continued += 1; },
      abort: async () => { throw new Error("resource request must not be aborted"); },
    });
    assert.equal(continued, 1);
    frameHandler(mainFrame);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(closed, 1);
  } finally {
    restore();
  }
});

test("automatic login is a module-wide single flight across concurrent pages", async () => {
  const { loaded, restore } = loadFreshBootstrap({
    MANUAL_STUDIO_ALLOWED_ORIGINS: JSON.stringify(["http://127.0.0.1:5002"]),
    MANUAL_STUDIO_AUTH_MODE: "automatic",
    MANUAL_STUDIO_LOGIN_ORIGIN: "http://127.0.0.1:5002",
    MANUAL_STUDIO_LOGIN_USERNAME: "single-user",
    MANUAL_STUDIO_LOGIN_PASSWORD: "single-password",
  });
  try {
    let releaseFirst;
    const firstGate = new Promise((resolvePromise) => { releaseFirst = resolvePromise; });
    const handlers = [];
    const calls = [];
    const context = {
      _options: { serviceWorkers: "block" },
      serviceWorkers: () => [],
      addInitScript: async () => {},
      route: async () => {},
      routeWebSocket: async () => {},
      newCDPSession: async () => ({ on: () => {}, send: async () => {} }),
    };
    function page(name) {
      return {
        context: () => context,
        goto: async () => {},
        on: (event, callback) => { if (event === "domcontentloaded") handlers.push(callback); },
        off: () => {},
        url: () => "http://127.0.0.1:5002/login",
        close: async () => calls.push([name, "close"]),
        locator: (selector) => ({
          fill: async (value) => {
            calls.push([name, "fill", selector, value]);
            if (name === "first" && selector === '[name="username"]') await firstGate;
          },
          click: async () => calls.push([name, "click", selector]),
        }),
      };
    }
    await loaded.default({ page: page("first") });
    await loaded.default({ page: page("second") });
    const first = handlers[0]();
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    await handlers[1]();
    releaseFirst();
    await first;
    assert.equal(calls.filter((call) => call[1] === "click").length, 1);
    assert.equal(calls.some((call) => call[0] === "second" && call[1] === "fill"), false);
    assert.equal(calls.some((call) => call[0] === "second" && call[1] === "close"), true);
  } finally {
    restore();
  }
});

async function listen(server) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  return server.address().port;
}

test("browser bootstrap blocks redirects, subresources, OOPIFs, popups, WebSockets and service workers before attacker hit", {
  skip: process.platform !== "win32",
  timeout: 45_000,
}, async (t) => {
  let attacker;
  let approved;
  let context;
  let profile;
  let restoreBootstrap;
  t.after(async () => {
    restoreBootstrap?.();
    if (context) await context.close().catch(() => undefined);
    for (const server of [approved, attacker]) {
      server?.closeIdleConnections?.();
      server?.closeAllConnections?.();
      if (server?.listening) {
        await new Promise((resolvePromise) => server.close(resolvePromise));
      }
    }
    if (profile) await rm(profile, { recursive: true, force: true });
  });
  let attackerHits = 0;
  let websocketHits = 0;
  let attackerConnections = 0;
  attacker = createServer((_request, response) => {
    attackerHits += 1;
    response.end("attacker");
  });
  attacker.on("upgrade", (_request, socket) => {
    websocketHits += 1;
    socket.destroy();
  });
  attacker.on("connection", () => { attackerConnections += 1; });
  const attackerPort = await listen(attacker);
  const attackerOrigin = `http://localhost:${attackerPort}`;

  let approvedOrigin;
  let approvedWsRedirects = 0;
  approved = createServer((request, response) => {
    if (request.url === "/redirect-same") {
      response.writeHead(302, { Location: "/ok" });
      response.end();
    } else if (request.url === "/redirect-attacker" || request.url === "/sw.js") {
      response.writeHead(302, { Location: `${attackerOrigin}/attack` });
      response.end();
    } else if (request.url === "/subresource") {
      response.end(`<img src="${attackerOrigin}/pixel">safe`);
    } else if (request.url === "/iframe") {
      response.end(`<iframe src="${attackerOrigin}/frame"></iframe>safe`);
    } else if (request.url === "/popup") {
      response.end(`<script>window.open(${JSON.stringify(`${attackerOrigin}/popup`)})</script>safe`);
    } else if (request.url === "/websocket") {
      response.end(`<script>new WebSocket(${JSON.stringify(`ws://localhost:${attackerPort}/socket`)})</script>safe`);
    } else if (request.url === "/websocket-redirects") {
      response.end('<script>for (const code of [301,302,307]) new WebSocket(`ws://${location.host}/ws-redirect-${code}`)</script>safe');
    } else if (request.url === "/service-worker") {
      response.end(`<script>navigator.serviceWorker.register('/sw.js').catch(() => {})</script>safe`);
    } else if (request.url === "/scheme-links") {
      response.end(`
        <a id="data" href="data:text/html,%3Cscript%3Edocument.body.dataset.ran='data'%3C/script%3E">data</a>
        <a id="javascript" href="javascript:document.body.dataset.ran='javascript'">javascript</a>
        <a id="about" href="about:blank">about</a>
        <a id="blob" href="#">blob</a>
        <button id="open-data" onclick="window.open('data:text/html,unsafe')">open data</button>
        <script>
          document.querySelector('#blob').href = URL.createObjectURL(new Blob([
            '<script>document.body.dataset.ran="blob"<\\/script>'
          ], { type: 'text/html' }));
        </script>
      `);
    } else if (request.url === "/etag.js") {
      if (request.headers["if-none-match"] === '"manual-studio-etag"') {
        response.writeHead(304, { ETag: '"manual-studio-etag"' });
        response.end();
      } else {
        response.writeHead(200, {
          "Content-Type": "application/javascript",
          "Cache-Control": "no-cache",
          ETag: '"manual-studio-etag"',
        });
        response.end("window.etagLoaded = true;");
      }
    } else if (request.url === "/etag-page") {
      response.end('<script src="/etag.js"></script>etag');
    } else if (request.url === "/download") {
      response.writeHead(200, { "Content-Disposition": 'attachment; filename="safe.txt"' });
      response.end("safe download");
    } else if (request.url === "/download-page") {
      response.end('<a id="download" href="/download">download</a>');
    } else {
      response.end("ok");
    }
  });
  approved.on("upgrade", (request, socket) => {
    const match = request.url.match(/^\/ws-redirect-(301|302|307)$/u);
    if (!match) {
      socket.destroy();
      return;
    }
    approvedWsRedirects += 1;
    const location = match[1] === "302"
      ? `${attackerOrigin}/ws-http-redirect`
      : `ws://localhost:${attackerPort}/ws-redirect`;
    socket.end(
      `HTTP/1.1 ${match[1]} Redirect\r\nLocation: ${location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    );
  });
  const approvedPort = await listen(approved);
  approvedOrigin = `http://127.0.0.1:${approvedPort}`;

  profile = await mkdtemp(path.join(os.tmpdir(), "manual-studio-edge-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "msedge",
    headless: true,
    serviceWorkers: "block",
    viewport: { width: 800, height: 600 },
  });
  const page = context.pages()[0] ?? await context.newPage();
  const { loaded, restore } = loadFreshBootstrap({
    MANUAL_STUDIO_ALLOWED_ORIGINS: JSON.stringify([approvedOrigin]),
    MANUAL_STUDIO_AUTH_MODE: "manual",
  });
  restoreBootstrap = restore;
  await loaded.default({ page });

  assert.equal((await page.goto(`${approvedOrigin}/redirect-same`)).status(), 200);
  const connectionSnapshots = [];
  for (const route of [
    "/redirect-attacker",
    "/subresource",
    "/iframe",
    "/popup",
    "/websocket",
    "/websocket-redirects",
    "/service-worker",
  ]) {
    await page.goto(`${approvedOrigin}${route}`).catch(() => undefined);
    await page.waitForTimeout(300);
    connectionSnapshots.push([route, attackerConnections]);
  }
  await page.goto(`${approvedOrigin}/scheme-links`);
  for (const selector of ["#data", "#javascript", "#about", "#blob", "#open-data"]) {
    await page.click(selector);
    await page.waitForTimeout(50);
    assert.equal(page.url(), `${approvedOrigin}/scheme-links`);
    assert.equal(await page.locator("body").getAttribute("data-ran"), null);
    assert.equal(context.pages().length, 1);
  }
  await page.goto(`${approvedOrigin}/etag-page`);
  assert.equal(await page.evaluate(() => window.etagLoaded), true);
  await page.reload();
  assert.equal(await page.evaluate(() => window.etagLoaded), true);
  await page.goto(`${approvedOrigin}/download-page`);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#download").click();
  const download = await downloadPromise;
  assert.ok(await download.failure());
  assert.equal(attackerHits, 0);
  assert.equal(websocketHits, 0);
  assert.equal(connectionSnapshots[0][1], 0, JSON.stringify(connectionSnapshots));
  assert.equal(
    connectionSnapshots.find(([route]) => route === "/websocket-redirects")[1],
    connectionSnapshots.find(([route]) => route === "/websocket")[1],
    JSON.stringify(connectionSnapshots),
  );
  assert.equal(approvedWsRedirects, 3);
  assert.equal(context.serviceWorkers().length, 0);
});
