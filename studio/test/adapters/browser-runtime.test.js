import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  executeApprovedMcpCalls,
  validateMcpToolInventory,
  verifyLoopbackPortOwner,
  verifyPlaywrightMcpReady,
} from "../../src/adapters/browser-runtime.js";
import { McpGateway } from "../../src/adapters/mcp-gateway.js";
import { CLICK_GEOMETRY_FUNCTION, compileExecutionCalls } from "../../src/domain/execution-calls.js";
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

  async start(input) {
    const { jobId, generation } = input;
    this.calls.gatewayStart.push(input);
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

  readExecutionTiming(input) {
    this.calls.gatewayTiming.push(input);
    return Object.freeze({
      schemaVersion: "1.0",
      clock: "unix_ms",
      jobId: input.jobId,
      generation: input.generation,
      planDigest: input.planDigest,
      complete: false,
      calls: Object.freeze([]),
    });
  }

  readExecutionHighlights(input) {
    this.calls.gatewayHighlights.push(input);
    return Object.freeze(this.calls.gatewayHighlightRecords.map((record) => Object.freeze({ ...record })));
  }

  readRecordingArtifact(input) {
    this.calls.gatewayArtifact.push(input);
    this.active = Object.freeze({ ...this.active, phase: "execution_complete", remainingCalls: 0 });
    return Object.freeze({
      schemaVersion: "1.0",
      jobId: input.jobId,
      generation: input.generation,
      planDigest: input.planDigest,
      approvedCallId: "system.stop-video",
      fileName: this.calls.gatewayArtifactFileName,
    });
  }

  readEvidenceArtifacts(input) {
    this.calls.gatewayEvidence.push(input);
    this.active = Object.freeze({ ...this.active, phase: "execution_complete", remainingCalls: 0 });
    return Object.freeze(input.expectedCallIds.map((approvedCallId, index) => Object.freeze({
      approvedCallId,
      fileName: this.calls.gatewayEvidenceFileNames[index],
    })));
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

test("BrowserRuntime permits automatic login at the target or an approved auth origin, never a resource-only origin", async (t) => {
  const { runtime } = await createHarness(t);
  const base = automaticJob();
  const targetPolicy = createOriginPolicy({
    targetOrigin: base.originPolicy.targetOrigin,
    authOrigins: [],
    resourceOrigins: base.originPolicy.resourceOrigins,
  });
  const targetLogin = {
    ...base,
    originPolicy: targetPolicy,
    auth: { ...base.auth, loginOrigin: targetPolicy.targetOrigin },
  };

  await startRuntime(runtime, targetLogin);
  await runtime.stop();

  const resourceLogin = {
    ...targetLogin,
    auth: { ...targetLogin.auth, loginOrigin: targetPolicy.resourceOrigins[0] },
  };
  await assert.rejects(
    startRuntime(runtime, resourceLogin),
    (error) => error.code === "INVALID_BROWSER_JOB",
  );
});

async function createHarness(t, overrides = {}) {
  const fixture = await temporaryStudio(t);
  const child = new FakeChild();
  const calls = {
    spawn: [],
    verify: [],
    stop: [],
    kill: [],
    gatewayConstruct: [],
    gatewayInstances: [],
    gatewayStart: [],
    gatewayApproval: [],
    gatewayTiming: [],
    gatewayHighlights: [],
    gatewayHighlightRecords: [],
    gatewayArtifact: [],
    gatewayArtifactFileName: "video-generation-owned.webm",
    gatewayEvidence: [],
    gatewayEvidenceFileNames: ["page-generation-owned.png"],
    coordinatorExecutions: [],
    readinessClose: [],
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
      PLAYWRIGHT_MCP_PING_TIMEOUT_MS: "999999",
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
      return details.retainSession
        ? {
            sessionId: "mcp-ready-session",
            close: async () => calls.readinessClose.push("mcp-ready-session"),
          }
        : { sessionId: "mcp-ready-session" };
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
      const gateway = new FakeGateway(options, calls);
      calls.gatewayInstances.push(gateway);
      return gateway;
    },
    onFatal: async (event) => calls.fatal.push(event),
    ...overrides,
  });
  return { ...fixture, calls, child, runtime };
}

test("the Windows owner probe accepts a loopback listener owned by the requested process", {
  skip: process.platform !== "win32" ? "Windows PowerShell ownership probe" : false,
}, async (t) => {
  const server = createServer((_request, response) => response.end("ok"));
  const port = await listen(server);
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)));

  await verifyLoopbackPortOwner(port, process.pid, AbortSignal.timeout(20_000));
  await assert.rejects(
    verifyLoopbackPortOwner(port, process.pid + 100_000, AbortSignal.timeout(20_000)),
  );
});

test("BrowserRuntime builds the exact job MCP config and launches the pinned JS CLI through preload", async (t) => {
  const { calls, child, runtime, studioRoot } = await createHarness(t);
  const active = await startRuntime(runtime, automaticJob());

  assert.equal(calls.spawn.length, 1);
  assert.equal(calls.spawn[0].command, process.execPath);
  assert.equal(
    calls.spawn[0].options.cwd,
    JSON.parse(await readFile(calls.spawn[0].args[4], "utf8")).outputDir,
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
    userDataDir: path.join(
      studioRoot,
      ".runtime",
      "browser",
      automaticJob().id,
      "profile",
    ),
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
  assert.equal(config.imageResponses, "omit");
  assert.equal(config.sharedBrowserContext, true);
  assert.equal(config.saveSession, true);
  assert.equal(path.dirname(config.outputDir), path.join(studioRoot, "data", "jobs", automaticJob().id, "browser"));
  assert.match(path.basename(config.outputDir), /^generation-1-[a-f0-9]{16}$/u);
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
  assert.equal(calls.verify[0].details.retainSession, true);
  assert.deepEqual(calls.verifyPortOwner, [{ port: 8932, pid: child.pid }]);
  assert.equal(calls.verify[0].endpoint, "http://127.0.0.1:8932/mcp");
  assert.equal(calls.gatewayConstruct.length, 1);
  assert.equal(calls.gatewayConstruct[0].upstreamUrl, "http://127.0.0.1:8932/mcp");
  assert.equal(calls.gatewayConstruct[0].port, 8931);
  assert.equal(calls.gatewayConstruct[0].capabilityToken, MCP_CAPABILITY_TOKEN);
  assert.equal(typeof calls.gatewayConstruct[0].onFatal, "function");
  assert.deepEqual(calls.gatewayStart, [{
    jobId: automaticJob().id,
    generation: 1,
    adoptedSessionId: "mcp-ready-session",
  }]);
  assert.equal(active.endpoint, "http://127.0.0.1:8931/mcp");
  assert.equal(active.phase, "planning");
  assert.equal(runtime.active, active);

  const childEnv = calls.spawn[0].options.env;
  assert.equal(childEnv.MANUAL_STUDIO_LOGIN_USERNAME, "automatic-user");
  assert.equal(childEnv.MANUAL_STUDIO_LOGIN_PASSWORD, "automatic-password");
  assert.equal(childEnv.MANUAL_STUDIO_LOGIN_ORIGIN, "http://127.0.0.1:5002");
  assert.equal(childEnv.MANUAL_STUDIO_TARGET_URL, "http://127.0.0.1:5001/app");
  assert.equal(childEnv.PLAYWRIGHT_MCP_PING_TIMEOUT_MS, "30000");
  assert.equal(Object.values(childEnv).includes(MCP_CAPABILITY_TOKEN), false);
  assert.deepEqual(JSON.parse(childEnv.MANUAL_STUDIO_NAVIGATION_ORIGINS), [
    "http://127.0.0.1:5001",
    "http://127.0.0.1:5002",
  ]);
  assert.equal(
    childEnv.MANUAL_STUDIO_AUTH_SEAL_PATH,
    path.join(studioRoot, ".runtime", "browser", automaticJob().id, "auth-sealed"),
  );
  assert.equal(
    childEnv.MANUAL_STUDIO_AUTH_ACK_PATH,
    path.join(studioRoot, ".runtime", "browser", automaticJob().id, "auth-armed"),
  );
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

test("BrowserRuntime seals a manual authentication phase inside its owned config directory", async (t) => {
  const { calls, runtime, studioRoot } = await createHarness(t);
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  await startRuntime(runtime, job);

  const sealPath = path.join(
    studioRoot,
    ".runtime",
    "browser",
    job.id,
    "auth-sealed",
  );
  const ackPath = path.join(path.dirname(sealPath), "auth-armed");
  assert.equal(calls.spawn[0].options.env.MANUAL_STUDIO_AUTH_SEAL_PATH, sealPath);
  assert.equal(calls.spawn[0].options.env.MANUAL_STUDIO_AUTH_ACK_PATH, ackPath);
  let sealSettled = false;
  const sealing = runtime.sealAuthentication(job.id).then((value) => {
    sealSettled = true;
    return value;
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if (await readFile(sealPath, "utf8")) break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(sealSettled, false);
  await writeFile(ackPath, "manual-video-auth-armed-v1\n", "utf8");
  await sealing;
  assert.equal(await readFile(sealPath, "utf8"), "manual-video-auth-sealed-v1\n");
  await assert.doesNotReject(runtime.sealAuthentication(job.id));
  await assert.rejects(
    runtime.sealAuthentication("job-ffffffffffffffff"),
    (error) => error.code === "BROWSER_RUNTIME_AUTH_SEAL_FAILED",
  );
});

test("automatic jobs use fresh owned profiles and cannot inherit an earlier login session", async (t) => {
  const children = [];
  const spawns = [];
  const { runtime, studioRoot } = await createHarness(t, {
    spawnProcess: (command, args, options) => {
      const child = new FakeChild(89_400 + children.length);
      children.push(child);
      spawns.push({ command, args, options });
      queueMicrotask(() => child.stderr.write("Listening on http://localhost:8932\n"));
      return child;
    },
    stopRequest: async () => children.at(-1)?.close(),
    killTree: async (child) => child.close(),
  });
  const firstJob = automaticJob();
  await startRuntime(runtime, firstJob);
  const firstConfig = JSON.parse(await readFile(spawns[0].args[4], "utf8"));
  const firstProfile = firstConfig.browser.userDataDir;
  const priorSession = path.join(firstProfile, "prior-auth-session.txt");
  await writeFile(priorSession, "authenticated", "utf8");

  await runtime.stop();
  await assert.rejects(stat(firstProfile), /ENOENT/u);

  const secondJob = { ...automaticJob(), id: "job-fedcba9876543210" };
  await startRuntime(runtime, secondJob);
  const secondConfig = JSON.parse(await readFile(spawns[1].args[4], "utf8"));
  const secondProfile = secondConfig.browser.userDataDir;
  assert.equal(
    firstProfile,
    path.join(studioRoot, ".runtime", "browser", firstJob.id, "profile"),
  );
  assert.equal(
    secondProfile,
    path.join(studioRoot, ".runtime", "browser", secondJob.id, "profile"),
  );
  assert.notEqual(secondProfile, firstProfile);
  await assert.rejects(readFile(path.join(secondProfile, "prior-auth-session.txt"), "utf8"), /ENOENT/u);
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
            headers: { "mcp-session-id": "fixture-session-1" },
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

test("a retained MCP session answers bounded server heartbeats until its lease closes", async () => {
  const module = await import("../../src/adapters/browser-runtime.js");
  assert.equal(typeof module.openPlaywrightMcpHeartbeat, "function");

  const sessionId = "retained-heartbeat-session";
  const requests = [];
  let streamController;
  let streamCancelled = 0;
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      streamCancelled += 1;
    },
  });
  const fetchImpl = async (_endpoint, options) => {
    const message = options.body === undefined ? null : JSON.parse(options.body);
    requests.push({ method: options.method, headers: options.headers, message });
    if (options.method === "GET") {
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "mcp-session-id": sessionId,
        },
      });
    }
    assert.deepEqual(message, { jsonrpc: "2.0", id: 17, result: {} });
    return new Response(null, { status: 202 });
  };

  const lease = await module.openPlaywrightMcpHeartbeat(
    "http://127.0.0.1:8932/mcp",
    { sessionId, fetchImpl },
  );
  streamController.enqueue(new TextEncoder().encode(
    ': keepalive\n\nevent: message\ndata: {"jsonrpc":"2.0","id":17,"method":"ping"}\n\n',
  ));
  for (let attempt = 0; attempt < 100 && requests.length < 2; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }

  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].headers["mcp-session-id"], sessionId);
  assert.equal(requests[1].method, "POST");
  assert.equal(requests[1].headers["mcp-session-id"], sessionId);
  await lease.close();
  await lease.close();
  assert.equal(streamCancelled, 1);
});

test("BrowserRuntime retains the automatic readiness session until the owned runtime stops", async (t) => {
  let readinessOptions;
  let closeCalls = 0;
  const { runtime } = await createHarness(t, {
    verifyMcpReady: async (_endpoint, options) => {
      readinessOptions = options;
      return Object.freeze({
        sessionId: "retained-readiness-session",
        close: async () => { closeCalls += 1; },
      });
    },
  });
  await startRuntime(runtime, automaticJob());
  assert.equal(readinessOptions.retainSession, true);
  assert.equal(closeCalls, 0);
  await runtime.stop();
  assert.equal(closeCalls, 1);
});

test("the retained MCP lifetime outlives the production thirty-second readiness deadline", async (t) => {
  let readinessSignal;
  let lifetimeSignal;
  let closeCalls = 0;
  const { runtime } = await createHarness(t, {
    // Compress the production 30s deadline without changing the lifetime relationship.
    readinessTimeoutMs: 100,
    verifyMcpReady: async (_endpoint, options) => {
      readinessSignal = options.signal;
      lifetimeSignal = options.lifetimeSignal;
      return Object.freeze({
        sessionId: "retained-readiness-session",
        close: async () => { closeCalls += 1; },
      });
    },
  });

  await startRuntime(runtime, { ...automaticJob(), auth: { mode: "manual" } });
  assert.ok(readinessSignal instanceof AbortSignal);
  assert.ok(lifetimeSignal instanceof AbortSignal);
  assert.notEqual(lifetimeSignal, readinessSignal);
  await new Promise((resolvePromise, rejectPromise) => {
    if (readinessSignal.aborted) {
      resolvePromise();
      return;
    }
    const deadline = setTimeout(() => rejectPromise(new Error("readiness deadline did not expire")), 1_000);
    readinessSignal.addEventListener("abort", () => {
      clearTimeout(deadline);
      resolvePromise();
    }, { once: true });
  });
  assert.equal(readinessSignal.aborted, true);
  assert.equal(lifetimeSignal.aborted, false);
  assert.equal(closeCalls, 0);

  await runtime.stop();
  assert.equal(lifetimeSignal.aborted, true);
  assert.equal(closeCalls, 1);
});

test("automatic BrowserRuntime startup rejects an incomplete retained readiness lease", async (t) => {
  for (const readiness of [
    { sessionId: "retained-readiness-session" },
    { sessionId: "short", close: async () => {} },
  ]) {
    const { calls, runtime } = await createHarness(t, {
      verifyMcpReady: async () => readiness,
    });
    await assert.rejects(
      startRuntime(runtime, automaticJob()),
      (error) => error.code === "BROWSER_RUNTIME_START_FAILED",
    );
    assert.equal(calls.gatewayConstruct.length, 0);
    assert.equal(runtime.active, null);
  }
});

test("BrowserRuntime proves the random raw listener belongs to the spawned MCP tree before readiness", async (t) => {
  const { calls, runtime } = await createHarness(t, {
    verifyPortOwner: async () => { throw new Error("foreign listener"); },
  });
  const job = automaticJob();
  await assert.rejects(startRuntime(runtime, job), (error) => error.code === "BROWSER_RUNTIME_START_FAILED");
  assert.equal(calls.verify.length, 0);
  assert.equal(calls.gatewayConstruct.length, 0);
  assert.equal(calls.stop.length, 1);
  assert.equal(runtime.active, null);
});

test("BrowserRuntime manual mode retains and adopts one exclusive executor session", async (t) => {
  const { calls, runtime } = await createHarness(t);
  const job = {
    ...automaticJob(),
    auth: { mode: "manual" },
  };
  const active = await startRuntime(runtime, job);
  assert.equal("MANUAL_STUDIO_LOGIN_USERNAME" in calls.spawn[0].options.env, false);
  assert.equal("MANUAL_STUDIO_LOGIN_PASSWORD" in calls.spawn[0].options.env, false);
  assert.equal("PLAYWRIGHT_MCP_SECRETS_FILE" in calls.spawn[0].options.env, false);
  assert.equal(calls.verify[0].details.retainSession, true);
  assert.deepEqual(calls.gatewayStart, [{
    jobId: job.id,
    generation: 1,
    adoptedSessionId: "mcp-ready-session",
  }]);
  assert.equal(runtime.active, active);
  await assert.rejects(startRuntime(runtime, job), (error) => error.code === "BROWSER_RUNTIME_BUSY");
  assert.equal(calls.spawn.length, 1);
  await runtime.stop();
  assert.deepEqual(calls.readinessClose, ["mcp-ready-session"]);
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
  const binding = {
    jobId: job.id,
    generation: active.generation,
    planDigest: approval.planDigest,
  };
  assert.deepEqual(runtime.readExecutionTiming(binding), {
    schemaVersion: "1.0",
    clock: "unix_ms",
    ...binding,
    complete: false,
    calls: [],
  });
  assert.deepEqual(calls.gatewayTiming, [binding]);
  const config = JSON.parse(await readFile(calls.spawn[0].args[4], "utf8"));
  await writeFile(path.join(config.outputDir, calls.gatewayArtifactFileName), "owned recording", "utf8");
  assert.deepEqual(await runtime.readRecordingArtifact(binding), {
    schemaVersion: "1.0",
    ...binding,
    approvedCallId: "system.stop-video",
    recordingPath: `browser/${path.basename(config.outputDir)}/${calls.gatewayArtifactFileName}`,
  });
  assert.deepEqual(calls.gatewayArtifact, [binding]);
  await runtime.stop();
  assert.throws(
    () => runtime.installApproval(approval),
    (error) => error.code === "BROWSER_RUNTIME_INACTIVE",
  );
  assert.throws(
    () => runtime.readExecutionTiming(binding),
    (error) => error.code === "BROWSER_RUNTIME_INACTIVE",
  );
  assert.throws(
    () => runtime.readExecutionHighlights({ ...binding, expectedCallIds: [] }),
    (error) => error.code === "BROWSER_RUNTIME_INACTIVE",
  );
  await assert.rejects(
    runtime.readRecordingArtifact(binding),
    (error) => error.code === "BROWSER_RUNTIME_INACTIVE",
  );
  await assert.rejects(
    runtime.readEvidenceArtifacts({
      ...binding,
      expectedCallIds: ["step-01.evidence-screenshot"],
    }),
    (error) => error.code === "BROWSER_RUNTIME_INACTIVE",
  );
});

test("BrowserRuntime revalidates exact highlight binding and returns immutable ordered geometry", async (t) => {
  const { calls, runtime } = await createHarness(t, {
    executeMcpCalls: async (input) => {
      const gateway = calls.gatewayInstances.at(-1);
      gateway.active = Object.freeze({ ...gateway.active, phase: "execution_complete", remainingCalls: 0 });
      return Object.freeze({ callCount: input.calls.length });
    },
  });
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  const active = await startRuntime(runtime, job);
  const binding = {
    jobId: job.id,
    generation: active.generation,
    planDigest: "7".repeat(64),
  };
  const callsToApprove = [
    {
      id: "step-01.click.highlight-bounds",
      tool: "browser_evaluate",
      arguments: { element: "저장", target: "button-save", function: CLICK_GEOMETRY_FUNCTION, _meta: { json: true } },
    },
    { id: "step-01.click", tool: "browser_click", arguments: { element: "저장", target: "button-save" } },
  ];
  calls.gatewayHighlightRecords = [
    { approvedCallId: callsToApprove[0].id, x: 8, y: 121, width: 127, height: 24 },
  ];
  runtime.installApproval({ ...binding, calls: callsToApprove });
  await runtime.executeApproval(binding);
  const request = { ...binding, expectedCallIds: [callsToApprove[0].id] };

  const highlights = runtime.readExecutionHighlights(request);
  assert.deepEqual(highlights, calls.gatewayHighlightRecords);
  assert.equal(Object.isFrozen(highlights), true);
  assert.equal(highlights.every((highlight) => Object.isFrozen(highlight)), true);
  assert.deepEqual(calls.gatewayHighlights, [request]);

  for (const invalid of [
    { ...request, jobId: "job-fedcba9876543210" },
    { ...request, generation: request.generation + 1 },
    { ...request, planDigest: "8".repeat(64) },
    { ...request, expectedCallIds: ["step-01.other.highlight-bounds"] },
    { ...request, expectedCallIds: [request.expectedCallIds[0], request.expectedCallIds[0]] },
    { ...request, unexpected: true },
  ]) {
    assert.throws(
      () => runtime.readExecutionHighlights(invalid),
      (error) => error.code === "BROWSER_RUNTIME_HIGHLIGHTS_FAILED",
    );
  }

  calls.gatewayHighlightRecords = [
    { approvedCallId: request.expectedCallIds[0], x: 1_900, y: 1_070, width: 21, height: 11 },
  ];
  assert.throws(
    () => runtime.readExecutionHighlights(request),
    (error) => error.code === "BROWSER_RUNTIME_HIGHLIGHTS_FAILED",
  );
});

test("BrowserRuntime executes its installed approval queue through the coordinator MCP client", async (t) => {
  const progress = [];
  const { calls, runtime } = await createHarness(t, {
    executeMcpCalls: async (input) => {
      calls.coordinatorExecutions.push(input);
      for (const call of input.calls) {
        await input.onCall({ id: call.id, tool: call.tool, status: "completed" });
      }
      const gateway = calls.gatewayInstances.at(-1);
      gateway.active = Object.freeze({
        ...gateway.active,
        phase: "execution_complete",
        remainingCalls: 0,
      });
      return Object.freeze({ callCount: input.calls.length });
    },
  });
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  const active = await startRuntime(runtime, job);
  const binding = {
    jobId: job.id,
    generation: active.generation,
    planDigest: "b".repeat(64),
  };
  const approvalCalls = [
    { id: "system.start-video", tool: "browser_start_video", arguments: { size: { width: 1920, height: 1080 } } },
    { id: "system.stop-video", tool: "browser_stop_video", arguments: {} },
  ];
  runtime.installApproval({ ...binding, calls: approvalCalls });

  assert.deepEqual(await runtime.executeApproval(binding, {
    onCall: async (event) => progress.push(event),
  }), {
    schemaVersion: "1.0",
    ...binding,
    status: "completed",
    callCount: 2,
  });
  assert.equal(calls.coordinatorExecutions.length, 1);
  assert.equal(calls.coordinatorExecutions[0].endpoint, "http://127.0.0.1:8931/mcp");
  assert.equal(calls.coordinatorExecutions[0].capabilityToken, MCP_CAPABILITY_TOKEN);
  assert.equal(calls.coordinatorExecutions[0].sessionId, "mcp-ready-session");
  assert.deepEqual(calls.coordinatorExecutions[0].calls, approvalCalls);
  assert.deepEqual(progress, [
    { id: "system.start-video", tool: "browser_start_video", status: "completed" },
    { id: "system.stop-video", tool: "browser_stop_video", status: "completed" },
  ]);
  await runtime.stop();
  assert.deepEqual(calls.readinessClose, ["mcp-ready-session"]);
});

test("the coordinator MCP client initializes one authenticated session and executes exact calls in order", async () => {
  const requests = [];
  const progress = [];
  const sessionId = "coordinator-session-1";
  const calls = [
    { id: "system.start-video", tool: "browser_start_video", arguments: { size: { width: 1920, height: 1080 } } },
    { id: "system.stop-video", tool: "browser_stop_video", arguments: {} },
  ];
  const fetchImpl = async (_endpoint, options) => {
    const message = options.body === undefined ? null : JSON.parse(options.body);
    requests.push({ method: options.method, headers: options.headers, message });
    if (options.method === "DELETE") return new Response("", { status: 200 });
    if (message.method === "initialize") {
      return new Response(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: {} } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream", "mcp-session-id": sessionId } },
      );
    }
    if (message.method === "notifications/initialized") {
      return new Response("", { status: 202 });
    }
    return new Response(
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };

  assert.deepEqual(await executeApprovedMcpCalls({
    endpoint: "http://127.0.0.1:8931/mcp",
    capabilityToken: MCP_CAPABILITY_TOKEN,
    calls,
    onCall: async (event) => progress.push(event),
    fetchImpl,
  }), { callCount: 2 });
  assert.deepEqual(requests.map(({ method, message }) => [method, message?.method]), [
    ["POST", "initialize"],
    ["POST", "notifications/initialized"],
    ["POST", "tools/call"],
    ["POST", "tools/call"],
    ["DELETE", undefined],
  ]);
  assert.equal(requests[0].headers.Authorization, `Bearer ${MCP_CAPABILITY_TOKEN}`);
  assert.equal(requests[1].headers["mcp-session-id"], sessionId);
  assert.deepEqual(requests.slice(2, 4).map(({ message }) => message.params), [
    { name: "browser_start_video", arguments: calls[0].arguments },
    { name: "browser_stop_video", arguments: calls[1].arguments },
  ]);
  assert.deepEqual(progress, calls.map(({ id, tool }) => ({ id, tool, status: "completed" })));
});

test("the coordinator MCP client reuses an adopted authenticated session without opening or deleting it", async () => {
  const requests = [];
  const progress = [];
  const sessionId = "mcp-ready-session";
  const calls = [
    { id: "system.start-video", tool: "browser_start_video", arguments: { size: { width: 1920, height: 1080 } } },
    { id: "system.stop-video", tool: "browser_stop_video", arguments: {} },
  ];
  const fetchImpl = async (_endpoint, options) => {
    const message = JSON.parse(options.body);
    requests.push({ method: options.method, headers: options.headers, message });
    return new Response(
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };

  assert.deepEqual(await executeApprovedMcpCalls({
    endpoint: "http://127.0.0.1:8931/mcp",
    capabilityToken: MCP_CAPABILITY_TOKEN,
    sessionId,
    calls,
    onCall: async (event) => progress.push(event),
    fetchImpl,
  }), { callCount: 2 });
  assert.deepEqual(requests.map(({ method, message }) => [method, message.method]), [
    ["POST", "tools/call"],
    ["POST", "tools/call"],
  ]);
  assert.equal(requests.every(({ headers }) => headers["mcp-session-id"] === sessionId), true);
  assert.deepEqual(progress, calls.map(({ id, tool }) => ({ id, tool, status: "completed" })));
});

test("a borrowed coordinator session fails without initializing or deleting the retained lease", async () => {
  const requests = [];
  await assert.rejects(
    executeApprovedMcpCalls({
      endpoint: "http://127.0.0.1:8931/mcp",
      capabilityToken: MCP_CAPABILITY_TOKEN,
      sessionId: "mcp-ready-session",
      calls: [{ id: "system.start-video", tool: "browser_start_video", arguments: {} }],
      onCall: async () => {},
      fetchImpl: async (_endpoint, options) => {
        requests.push(options);
        const message = JSON.parse(options.body);
        return new Response(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [] } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    }),
    (error) => error.code === "BROWSER_RUNTIME_MCP_TOOL_FAILED",
  );
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].body).method, "tools/call");

  let fetched = false;
  await assert.rejects(
    executeApprovedMcpCalls({
      endpoint: "http://127.0.0.1:8931/mcp",
      capabilityToken: MCP_CAPABILITY_TOKEN,
      sessionId: "short",
      calls: [{ id: "system.start-video", tool: "browser_start_video", arguments: {} }],
      onCall: async () => {},
      fetchImpl: async () => { fetched = true; },
    }),
    (error) => error.code === "BROWSER_RUNTIME_EXECUTION_INVALID",
  );
  assert.equal(fetched, false);
});

test("BrowserRuntime binds gateway-owned screenshots to generation-owned evidence paths", async (t) => {
  const { calls, runtime } = await createHarness(t);
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  const active = await startRuntime(runtime, job);
  const binding = {
    jobId: job.id,
    generation: active.generation,
    planDigest: "d".repeat(64),
  };
  runtime.installApproval({
    ...binding,
    calls: [
      {
        id: "step-01.evidence-screenshot",
        tool: "browser_take_screenshot",
        arguments: { filename: "step-01.png", type: "png" },
      },
    ],
  });
  const config = JSON.parse(await readFile(calls.spawn[0].args[4], "utf8"));
  await writeFile(path.join(config.outputDir, calls.gatewayEvidenceFileNames[0]), "owned image", "utf8");
  const input = {
    ...binding,
    expectedCallIds: ["step-01.evidence-screenshot"],
  };

  assert.deepEqual(await runtime.readEvidenceArtifacts(input), {
    schemaVersion: "1.0",
    ...binding,
    artifacts: [{
      approvedCallId: "step-01.evidence-screenshot",
      screenshotPath: `browser/${path.basename(config.outputDir)}/${calls.gatewayEvidenceFileNames[0]}`,
    }],
  });
  assert.deepEqual(calls.gatewayEvidence, [{
    expectedGenerationId: active.generation,
    expectedCallIds: ["step-01.evidence-screenshot"],
  }]);
  await runtime.stop();
});

test("BrowserRuntime rejects screenshot evidence that escapes its generation output", async (t) => {
  const { calls, runtime } = await createHarness(t);
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  const active = await startRuntime(runtime, job);
  const binding = { jobId: job.id, generation: active.generation, planDigest: "e".repeat(64) };
  runtime.installApproval({
    ...binding,
    calls: [{
      id: "step-01.evidence-screenshot",
      tool: "browser_take_screenshot",
      arguments: { filename: "step-01.png", type: "png" },
    }],
  });
  calls.gatewayEvidenceFileNames = ["../forged.png"];

  await assert.rejects(
    runtime.readEvidenceArtifacts({
      ...binding,
      expectedCallIds: ["step-01.evidence-screenshot"],
    }),
    (error) => error.code === "BROWSER_RUNTIME_EVIDENCE_FAILED",
  );
  await runtime.stop();
});

test("BrowserRuntime rejects an artifact name that escapes its generation-owned output directory", async (t) => {
  const { calls, runtime } = await createHarness(t);
  const job = { ...automaticJob(), auth: { mode: "manual" } };
  const active = await startRuntime(runtime, job);
  const binding = { jobId: job.id, generation: active.generation, planDigest: "c".repeat(64) };
  runtime.installApproval({
    ...binding,
    calls: [{ id: "system.stop-video", tool: "browser_stop_video", arguments: {} }],
  });
  calls.gatewayArtifactFileName = "../forged.webm";

  await assert.rejects(
    runtime.readRecordingArtifact(binding),
    (error) => error.code === "BROWSER_RUNTIME_ARTIFACT_FAILED",
  );
  await runtime.stop();
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
  if (!completeEnvironment.MANUAL_STUDIO_AUTH_SEAL_PATH) {
    completeEnvironment.MANUAL_STUDIO_AUTH_SEAL_PATH = path.join(
      os.tmpdir(),
      `manual-studio-bootstrap-seal-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "auth-sealed",
    );
  }
  if (!completeEnvironment.MANUAL_STUDIO_AUTH_ACK_PATH) {
    completeEnvironment.MANUAL_STUDIO_AUTH_ACK_PATH = path.join(
      path.dirname(completeEnvironment.MANUAL_STUDIO_AUTH_SEAL_PATH),
      "auth-armed",
    );
  }
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
        isNavigationRequest: () => false,
        url: () => `${resourceOrigin}/asset.png`,
      }),
      fallback: async () => { continued += 1; },
      abort: async () => { throw new Error("resource request must not be aborted"); },
    });
    assert.equal(continued, 1);
    let aborted = 0;
    let navigationContinued = 0;
    await routeHandler({
      request: () => ({
        frame: () => ({ page: () => page }),
        isNavigationRequest: () => true,
        url: () => `${resourceOrigin}/document`,
      }),
      fallback: async () => { navigationContinued += 1; },
      abort: async () => { aborted += 1; },
    });
    assert.equal(aborted, 1);
    assert.equal(navigationContinued, 0);
    frameHandler(mainFrame);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(closed, 1);
  } finally {
    restore();
  }
});

test("browser bootstrap removes auth origins from navigation immediately after the seal appears", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "manual-studio-auth-seal-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sealPath = path.join(temporary, "auth-sealed");
  const ackPath = path.join(temporary, "auth-armed");
  const targetOrigin = "http://127.0.0.1:5001";
  const authOrigin = "http://127.0.0.1:5002";
  const { loaded, restore } = loadFreshBootstrap({
    MANUAL_STUDIO_ALLOWED_ORIGINS: JSON.stringify([targetOrigin, authOrigin]),
    MANUAL_STUDIO_NAVIGATION_ORIGINS: JSON.stringify([targetOrigin, authOrigin]),
    MANUAL_STUDIO_TARGET_URL: `${targetOrigin}/app`,
    MANUAL_STUDIO_AUTH_MODE: "manual",
    MANUAL_STUDIO_AUTH_SEAL_PATH: sealPath,
    MANUAL_STUDIO_AUTH_ACK_PATH: ackPath,
  });
  try {
    let routeHandler;
    let webSocketHandler;
    let requestFinishedHandler;
    const context = {
      _options: { serviceWorkers: "block" },
      serviceWorkers: () => [],
      addInitScript: async () => {},
      route: async (_pattern, handler) => { routeHandler = handler; },
      routeWebSocket: async (_pattern, handler) => { webSocketHandler = handler; },
      newCDPSession: async () => ({ on: () => {}, send: async () => {} }),
    };
    const mainFrame = { url: () => `${targetOrigin}/app` };
    const page = {
      context: () => context,
      goto: async () => {},
      mainFrame: () => mainFrame,
      on: (name, handler) => {
        if (name === "requestfinished") requestFinishedHandler = handler;
      },
      url: () => `${targetOrigin}/app`,
      close: async () => {},
    };
    await loaded.default({ page });

    let continuedBeforeSeal = 0;
    const preSealAuthRequest = {
      frame: () => ({ page: () => page }),
      isNavigationRequest: () => true,
      url: () => `${authOrigin}/login`,
    };
    await routeHandler({
      request: () => preSealAuthRequest,
      fallback: async () => { continuedBeforeSeal += 1; },
      abort: async () => { throw new Error("auth navigation must remain available before confirmation"); },
    });
    assert.equal(continuedBeforeSeal, 1);
    requestFinishedHandler(preSealAuthRequest);

    await writeFile(sealPath, "manual-video-auth-sealed-v1\n", "utf8");
    let abortedAfterSeal = 0;
    await routeHandler({
      request: () => ({
        frame: () => ({ page: () => page }),
        isNavigationRequest: () => true,
        url: () => `${authOrigin}/login`,
      }),
      fallback: async () => { throw new Error("sealed auth navigation must not reach the network"); },
      abort: async () => { abortedAfterSeal += 1; },
    });
    assert.equal(abortedAfterSeal, 1);

    let authFetchAborted = 0;
    let authFetchContinued = 0;
    await routeHandler({
      request: () => ({
        frame: () => ({ page: () => page }),
        isNavigationRequest: () => false,
        url: () => `${authOrigin}/session`,
      }),
      fallback: async () => { authFetchContinued += 1; },
      abort: async () => { authFetchAborted += 1; },
    });
    assert.equal(authFetchAborted, 1);
    assert.equal(authFetchContinued, 0);

    let authSocketClosed = 0;
    let authSocketConnected = 0;
    await webSocketHandler({
      url: () => "ws://127.0.0.1:5002/session",
      close: async () => { authSocketClosed += 1; },
      connectToServer: async () => { authSocketConnected += 1; },
    });
    assert.equal(authSocketClosed, 1);
    assert.equal(authSocketConnected, 0);

    let targetContinued = 0;
    const postSealTargetRequest = {
      frame: () => ({ page: () => page }),
      isNavigationRequest: () => true,
      url: () => `${targetOrigin}/projects`,
    };
    await routeHandler({
      request: () => postSealTargetRequest,
      fallback: async () => { targetContinued += 1; },
      abort: async () => { throw new Error("the target origin must remain available"); },
    });
    assert.equal(targetContinued, 1);
    requestFinishedHandler(postSealTargetRequest);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        if (await readFile(ackPath, "utf8")) break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    assert.equal(await readFile(ackPath, "utf8"), "manual-video-auth-armed-v1\n");
  } finally {
    restore();
  }
});

test("browser bootstrap closes an already-open auth page instead of arming planning", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "manual-studio-auth-page-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sealPath = path.join(temporary, "auth-sealed");
  const ackPath = path.join(temporary, "auth-armed");
  const targetOrigin = "http://127.0.0.1:5001";
  const authOrigin = "http://127.0.0.1:5002";
  const { loaded, restore } = loadFreshBootstrap({
    MANUAL_STUDIO_ALLOWED_ORIGINS: JSON.stringify([targetOrigin, authOrigin]),
    MANUAL_STUDIO_NAVIGATION_ORIGINS: JSON.stringify([targetOrigin, authOrigin]),
    MANUAL_STUDIO_TARGET_URL: `${targetOrigin}/app`,
    MANUAL_STUDIO_AUTH_MODE: "manual",
    MANUAL_STUDIO_AUTH_SEAL_PATH: sealPath,
    MANUAL_STUDIO_AUTH_ACK_PATH: ackPath,
  });
  try {
    let closed = 0;
    const mainFrame = { url: () => `${authOrigin}/login` };
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
      mainFrame: () => mainFrame,
      on: () => {},
      url: () => `${authOrigin}/login`,
      close: async () => { closed += 1; },
    };
    await loaded.default({ page });
    await writeFile(sealPath, "manual-video-auth-sealed-v1\n", "utf8");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    assert.ok(closed > 0);
    await assert.rejects(readFile(ackPath, "utf8"), /ENOENT/u);
  } finally {
    restore();
  }
});

test("browser bootstrap never acknowledges while a pre-seal auth document navigation can still commit", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "manual-studio-auth-navigation-race-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sealPath = path.join(temporary, "auth-sealed");
  const ackPath = path.join(temporary, "auth-armed");
  const targetOrigin = "http://127.0.0.1:5001";
  const authOrigin = "http://127.0.0.1:5002";
  const targetUrl = `${targetOrigin}/app`;
  const authUrl = `${authOrigin}/login`;
  const { loaded, restore } = loadFreshBootstrap({
    MANUAL_STUDIO_ALLOWED_ORIGINS: JSON.stringify([targetOrigin, authOrigin]),
    MANUAL_STUDIO_NAVIGATION_ORIGINS: JSON.stringify([targetOrigin, authOrigin]),
    MANUAL_STUDIO_TARGET_URL: targetUrl,
    MANUAL_STUDIO_AUTH_MODE: "manual",
    MANUAL_STUDIO_AUTH_SEAL_PATH: sealPath,
    MANUAL_STUDIO_AUTH_ACK_PATH: ackPath,
  });
  try {
    let routeHandler;
    let requestPausedHandler;
    const protocolCalls = [];
    const mainFrame = { url: () => targetUrl };
    const session = {
      on: (name, handler) => {
        if (name === "Fetch.requestPaused") requestPausedHandler = handler;
      },
      send: async (method, parameters) => { protocolCalls.push([method, parameters]); },
    };
    const context = {
      _options: { serviceWorkers: "block" },
      serviceWorkers: () => [],
      addInitScript: async () => {},
      route: async (_pattern, handler) => { routeHandler = handler; },
      routeWebSocket: async () => {},
      newCDPSession: async () => session,
    };
    const page = {
      context: () => context,
      goto: async () => {},
      frames: () => [mainFrame],
      mainFrame: () => mainFrame,
      on: () => {},
      url: () => targetUrl,
      close: async () => {},
    };
    await loaded.default({ page });

    let routeContinued = false;
    await routeHandler({
      request: () => ({
        frame: () => ({ page: () => page }),
        isNavigationRequest: () => true,
        url: () => authUrl,
      }),
      fallback: async () => { routeContinued = true; },
      abort: async () => { throw new Error("the pre-seal auth navigation must initially be allowed"); },
    });
    assert.equal(routeContinued, true);

    requestPausedHandler({
      requestId: "auth-document-request",
      resourceType: "Document",
      request: { url: authUrl },
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    requestPausedHandler({
      requestId: "auth-document-response",
      resourceType: "Document",
      request: { url: authUrl },
      responseStatusCode: 200,
      responseHeaders: [],
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.deepEqual(
      protocolCalls.filter(([method]) => method === "Fetch.continueRequest" || method === "Fetch.continueResponse")
        .map(([method]) => method),
      ["Fetch.continueRequest", "Fetch.continueResponse"],
    );

    await writeFile(sealPath, "manual-video-auth-sealed-v1\n", "utf8");
    let acknowledgement;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        acknowledgement = await readFile(ackPath, "utf8");
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    assert.equal(
      acknowledgement,
      undefined,
      "auth-armed must remain absent until the pre-seal auth Document navigation resolves",
    );
  } finally {
    restore();
  }
});

test("automatic login writes the phase seal only after returning to the exact target", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "manual-studio-auto-seal-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sealPath = path.join(temporary, "auth-sealed");
  const targetUrl = "http://127.0.0.1:5001/app";
  const loginUrl = "http://127.0.0.1:5002/login";
  const { loaded, restore } = loadFreshBootstrap({
    MANUAL_STUDIO_ALLOWED_ORIGINS: JSON.stringify([
      "http://127.0.0.1:5001",
      "http://127.0.0.1:5002",
    ]),
    MANUAL_STUDIO_NAVIGATION_ORIGINS: JSON.stringify([
      "http://127.0.0.1:5001",
      "http://127.0.0.1:5002",
    ]),
    MANUAL_STUDIO_TARGET_URL: targetUrl,
    MANUAL_STUDIO_AUTH_MODE: "automatic",
    MANUAL_STUDIO_AUTH_SEAL_PATH: sealPath,
    MANUAL_STUDIO_LOGIN_ORIGIN: "http://127.0.0.1:5002",
    MANUAL_STUDIO_LOGIN_USERNAME: "phase-user",
    MANUAL_STUDIO_LOGIN_PASSWORD: "phase-password",
  });
  try {
    const handlers = new Map();
    let currentUrl = loginUrl;
    const mainFrame = { url: () => currentUrl };
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
      mainFrame: () => mainFrame,
      on: (name, callback) => handlers.set(name, callback),
      off: () => {},
      url: () => currentUrl,
      close: async () => {},
      locator: () => ({ fill: async () => {}, click: async () => {} }),
    };
    await loaded.default({ page });
    await handlers.get("domcontentloaded")();
    await assert.rejects(readFile(sealPath, "utf8"), /ENOENT/u);

    currentUrl = targetUrl;
    handlers.get("framenavigated")(mainFrame);
    assert.equal(await readFile(sealPath, "utf8"), "manual-video-auth-sealed-v1\n");
  } finally {
    restore();
  }
});

test("automatic login never treats a same-URL credential submission as authenticated", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "manual-studio-auto-same-url-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sealPath = path.join(temporary, "auth-sealed");
  const loginUrl = "http://127.0.0.1:5001/login";
  const { loaded, restore } = loadFreshBootstrap({
    MANUAL_STUDIO_ALLOWED_ORIGINS: JSON.stringify(["http://127.0.0.1:5001"]),
    MANUAL_STUDIO_NAVIGATION_ORIGINS: JSON.stringify(["http://127.0.0.1:5001"]),
    MANUAL_STUDIO_TARGET_URL: loginUrl,
    MANUAL_STUDIO_AUTH_MODE: "automatic",
    MANUAL_STUDIO_AUTH_SEAL_PATH: sealPath,
    MANUAL_STUDIO_LOGIN_ORIGIN: "http://127.0.0.1:5001",
    MANUAL_STUDIO_LOGIN_USERNAME: "same-url-user",
    MANUAL_STUDIO_LOGIN_PASSWORD: "rejected-password",
  });
  try {
    const handlers = new Map();
    const mainFrame = { url: () => loginUrl };
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
      mainFrame: () => mainFrame,
      on: (name, callback) => handlers.set(name, callback),
      off: () => {},
      url: () => loginUrl,
      close: async () => {},
      locator: () => ({ fill: async () => {}, click: async () => {} }),
    };
    await loaded.default({ page });
    await handlers.get("domcontentloaded")();
    await assert.rejects(readFile(sealPath, "utf8"), /ENOENT/u);
    handlers.get("framenavigated")(mainFrame);
    await assert.rejects(readFile(sealPath, "utf8"), /ENOENT/u);
  } finally {
    restore();
  }
});

test("automatic login ignores navigation that happens during credential fill before submit", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "manual-studio-auto-prefill-nav-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sealPath = path.join(temporary, "auth-sealed");
  const targetUrl = "http://127.0.0.1:5001/app";
  let currentUrl = "http://127.0.0.1:5001/login";
  const { loaded, restore } = loadFreshBootstrap({
    MANUAL_STUDIO_ALLOWED_ORIGINS: JSON.stringify(["http://127.0.0.1:5001"]),
    MANUAL_STUDIO_NAVIGATION_ORIGINS: JSON.stringify(["http://127.0.0.1:5001"]),
    MANUAL_STUDIO_TARGET_URL: targetUrl,
    MANUAL_STUDIO_AUTH_MODE: "automatic",
    MANUAL_STUDIO_AUTH_SEAL_PATH: sealPath,
    MANUAL_STUDIO_LOGIN_ORIGIN: "http://127.0.0.1:5001",
    MANUAL_STUDIO_LOGIN_USERNAME: "prefill-user",
    MANUAL_STUDIO_LOGIN_PASSWORD: "prefill-password",
  });
  try {
    const handlers = new Map();
    const mainFrame = { url: () => currentUrl };
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
      mainFrame: () => mainFrame,
      on: (name, callback) => handlers.set(name, callback),
      off: () => {},
      url: () => currentUrl,
      close: async () => {},
      locator: (selector) => ({
        fill: async () => {
          if (selector === '[name="username"]') {
            currentUrl = targetUrl;
            handlers.get("framenavigated")(mainFrame);
          }
        },
        click: async () => {},
      }),
    };
    await loaded.default({ page });
    await handlers.get("domcontentloaded")();
    await assert.rejects(readFile(sealPath, "utf8"), /ENOENT/u);
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

async function listen(server, port = 0) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, "127.0.0.1", resolvePromise);
  });
  return server.address().port;
}

async function unusedLoopbackPort(excludedPorts) {
  while (true) {
    const server = createServer();
    const port = await listen(server);
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => error ? rejectPromise(error) : resolvePromise());
    });
    if (!excludedPorts.has(port)) return port;
  }
}

async function assertLoopbackPortsReleased(ports) {
  for (const port of ports) {
    const server = createServer();
    await listen(server, port);
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => error ? rejectPromise(error) : resolvePromise());
    });
  }
}

async function startRuntimeWithObservedPortRetry(createAttempt) {
  for (let index = 0; index < 2; index += 1) {
    const attempt = await createAttempt(index);
    try {
      return { index, attempt, active: await attempt.start() };
    } catch (error) {
      await attempt.cleanup();
      if (
        error?.code !== "BROWSER_RUNTIME_START_FAILED" ||
        attempt.observedAddressCollision !== true ||
        index === 1
      ) {
        throw error;
      }
    }
  }
  throw new Error("runtime attempts exhausted");
}

test("runtime start retry requires an explicitly observed address collision and cleans every failure", async (t) => {
  const startFailure = Object.assign(new Error("wrapped start failure"), {
    code: "BROWSER_RUNTIME_START_FAILED",
  });

  await t.test("an unobserved generic start failure is cleaned and never retried", async () => {
    const events = [];
    await assert.rejects(
      startRuntimeWithObservedPortRetry(async (index) => ({
        observedAddressCollision: false,
        start: async () => {
          events.push(`start:${index}`);
          throw startFailure;
        },
        cleanup: async () => events.push(`release:${index}`),
      })),
      (error) => error === startFailure,
    );
    assert.deepEqual(events, ["start:0", "release:0"]);
  });

  await t.test("every failed attempt is cleaned before the final failure is surfaced", async () => {
    const events = [];
    await assert.rejects(
      startRuntimeWithObservedPortRetry(async (index) => ({
        observedAddressCollision: index === 0,
        start: async () => {
          events.push(`start:${index}`);
          throw startFailure;
        },
        cleanup: async () => events.push(`release:${index}`),
      })),
      (error) => error === startFailure,
    );
    assert.deepEqual(events, ["start:0", "release:0", "start:1", "release:1"]);
  });
});

test("actual Edge automatic login seals only after a credential redirect reaches the target", {
  skip: process.platform !== "win32",
  timeout: 45_000,
}, async (t) => {
  let server;
  let context;
  let profile;
  let restoreBootstrap;
  t.after(async () => {
    restoreBootstrap?.();
    if (context) await context.close().catch(() => undefined);
    server?.closeIdleConnections?.();
    server?.closeAllConnections?.();
    if (server?.listening) {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
    if (profile) await rm(profile, { recursive: true, force: true });
  });

  let authenticated = false;
  server = createServer((request, response) => {
    const send = (status, body, headers = {}) => {
      response.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        ...headers,
      });
      response.end(body);
    };
    if (request.method === "GET" && request.url === "/app") {
      if (!authenticated) {
        send(303, "", { Location: "/login" });
      } else {
        send(200, "<!doctype html><title>Target</title><h1>Target ready</h1>");
      }
      return;
    }
    if (request.method === "GET" && request.url === "/login") {
      send(200, '<!doctype html><title>Login</title><form method="post" action="/login"><input name="username"><input name="password" type="password"><button type="submit">Login</button></form>');
      return;
    }
    if (request.method === "POST" && request.url === "/login") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        if (form.get("username") === "automatic-user" && form.get("password") === "automatic-password") {
          authenticated = true;
          send(303, "", { Location: "/app" });
        } else {
          send(401, "invalid");
        }
      });
      return;
    }
    send(404, "missing");
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const targetUrl = `${origin}/app`;
  profile = await mkdtemp(path.join(os.tmpdir(), "manual-studio-auto-edge-"));
  const sealPath = path.join(profile, "auth-sealed");
  const ackPath = path.join(profile, "auth-armed");
  const { loaded, restore } = loadFreshBootstrap({
    MANUAL_STUDIO_ALLOWED_ORIGINS: JSON.stringify([origin]),
    MANUAL_STUDIO_NAVIGATION_ORIGINS: JSON.stringify([origin]),
    MANUAL_STUDIO_TARGET_URL: targetUrl,
    MANUAL_STUDIO_AUTH_MODE: "automatic",
    MANUAL_STUDIO_AUTH_SEAL_PATH: sealPath,
    MANUAL_STUDIO_AUTH_ACK_PATH: ackPath,
    MANUAL_STUDIO_LOGIN_ORIGIN: origin,
    MANUAL_STUDIO_LOGIN_USERNAME: "automatic-user",
    MANUAL_STUDIO_LOGIN_PASSWORD: "automatic-password",
  });
  restoreBootstrap = restore;
  context = await chromium.launchPersistentContext(profile, {
    channel: "msedge",
    headless: true,
    serviceWorkers: "block",
    viewport: { width: 800, height: 600 },
  });
  const page = context.pages()[0] ?? await context.newPage();
  await loaded.default({ page });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if (await readFile(ackPath, "utf8") === "manual-video-auth-armed-v1\n") break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert.equal(authenticated, true);
  assert.equal(page.url(), targetUrl);
  assert.equal(await readFile(sealPath, "utf8"), "manual-video-auth-sealed-v1\n");
  assert.equal(await readFile(ackPath, "utf8"), "manual-video-auth-armed-v1\n");
  const planningPage = await context.newPage();
  await loaded.default({ page: planningPage });
  assert.equal(planningPage.url(), targetUrl);
});

test("production BrowserRuntime keeps automatic login alive through the MCP readiness probe", {
  skip: process.platform !== "win32",
  timeout: 60_000,
}, async (t) => {
  let server;
  let runtime;
  const jobId = randomUUID();
  const studioRoot = path.resolve(".");
  t.after(async () => {
    if (runtime) await runtime.stop().catch(() => undefined);
    server?.closeIdleConnections?.();
    server?.closeAllConnections?.();
    if (server?.listening) {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
    await rm(path.join(studioRoot, "data", "jobs", jobId), { recursive: true, force: true });
  });

  let authenticated = false;
  server = createServer((request, response) => {
    const send = (status, body, headers = {}) => {
      response.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        ...headers,
      });
      response.end(body);
    };
    if (request.method === "GET" && request.url === "/app") {
      if (!authenticated) send(303, "", { Location: "/login" });
      else send(200, "<!doctype html><title>Target</title><h1>Target ready</h1>");
      return;
    }
    if (request.method === "GET" && request.url === "/login") {
      send(200, '<!doctype html><title>Login</title><form method="post" action="/login"><input name="username"><input name="password" type="password"><button type="submit">Login</button></form>');
      return;
    }
    if (request.method === "POST" && request.url === "/login") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        if (form.get("username") === "automatic-user" && form.get("password") === "automatic-password") {
          authenticated = true;
          send(303, "", { Location: "/app" });
        } else {
          send(401, "invalid");
        }
      });
      return;
    }
    send(404, "missing");
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const targetUrl = `${origin}/app`;
  const calls = {
    gatewayStart: [], gatewayApproval: [], gatewayTiming: [], gatewayArtifact: [],
    gatewayArtifactFileName: "video-generation-owned.webm", gatewayQuarantine: [], gatewayStop: [],
  };
  runtime = new BrowserRuntime({
    studioRoot,
    mcpPackageDir: path.join(studioRoot, "node_modules", "@playwright", "mcp"),
    port: 8931,
    env: { Path: process.env.Path ?? "" },
    readinessTimeoutMs: 10_000,
    gatewayFactory: (options) => new FakeGateway(options, calls),
  });
  const originPolicy = createOriginPolicy({
    targetOrigin: origin,
    authOrigins: [],
    resourceOrigins: [],
  });
  const job = {
    id: jobId,
    targetUrl,
    originPolicy,
    blockedOrigins: [],
    auth: {
      mode: "automatic",
      loginOrigin: origin,
      username: "automatic-user",
      password: "automatic-password",
      selectors: {
        username: '[name="username"]',
        password: '[name="password"]',
        submit: 'button[type="submit"]',
      },
    },
  };
  await startRuntime(runtime, job);
  await runtime.sealAuthentication(jobId);
  assert.equal(authenticated, true);
});

test("production BrowserRuntime retries a stolen port then captures click geometry from Playwright MCP 0.0.78", {
  skip: process.platform !== "win32",
  timeout: 60_000,
}, async (t) => {
  let server;
  let runtime;
  let collisionServer;
  let jobId;
  let active;
  const jobIds = new Set();
  const studioRoot = path.resolve(".");
  t.after(async () => {
    if (runtime) await runtime.stop().catch(() => undefined);
    collisionServer?.closeIdleConnections?.();
    collisionServer?.closeAllConnections?.();
    if (collisionServer?.listening) {
      await new Promise((resolvePromise) => collisionServer.close(resolvePromise));
    }
    server?.closeIdleConnections?.();
    server?.closeAllConnections?.();
    if (server?.listening) {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
    for (const id of jobIds) {
      await rm(path.join(studioRoot, "data", "jobs", id), { recursive: true, force: true });
    }
  });

  server = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end('<!doctype html><title>Geometry fixture</title><button id="geometry-target" style="position:absolute;left:40px;top:50px;width:120px;height:40px;box-sizing:border-box">Capture geometry</button>');
  });
  const fixturePort = await listen(server);
  const origin = `http://127.0.0.1:${fixturePort}`;
  const targetUrl = `${origin}/app`;
  collisionServer = createServer();
  const stolenPublicPort = await listen(collisionServer);
  const attemptedPorts = new Set([fixturePort, stolenPublicPort]);
  const originPolicy = createOriginPolicy({ targetOrigin: origin, authOrigins: [], resourceOrigins: [] });
  const started = await startRuntimeWithObservedPortRetry(async (attemptIndex) => {
    const attemptJobId = randomUUID();
    jobIds.add(attemptJobId);
    const publicPort = attemptIndex === 0
      ? stolenPublicPort
      : await unusedLoopbackPort(attemptedPorts);
    attemptedPorts.add(publicPort);
    const rawPort = await unusedLoopbackPort(attemptedPorts);
    attemptedPorts.add(rawPort);
    const attempt = { observedAddressCollision: false };
    const candidate = new BrowserRuntime({
      studioRoot,
      mcpPackageDir: path.join(studioRoot, "node_modules", "@playwright", "mcp"),
      port: publicPort,
      rawPort,
      env: { Path: process.env.Path ?? "" },
      readinessTimeoutMs: 15_000,
      gatewayFactory: (options) => {
        const gateway = new McpGateway(options);
        const startGateway = gateway.start.bind(gateway);
        gateway.start = async (input) => {
          try {
            return await startGateway(input);
          } catch (error) {
            const collisionAddress = collisionServer?.address();
            if (
              error?.code === "MCP_GATEWAY_START_FAILED" &&
              attemptIndex === 0 &&
              options.port === publicPort &&
              collisionServer?.listening === true &&
              collisionAddress !== null &&
              typeof collisionAddress === "object" &&
              collisionAddress.address === "127.0.0.1" &&
              collisionAddress.port === publicPort
            ) {
              attempt.observedAddressCollision = true;
            }
            throw error;
          }
        };
        return gateway;
      },
    });
    runtime = candidate;
    return Object.assign(attempt, {
      runtime: candidate,
      jobId: attemptJobId,
      start: () => startRuntime(candidate, {
        id: attemptJobId,
        targetUrl,
        originPolicy,
        blockedOrigins: [],
        auth: { mode: "manual" },
      }),
      cleanup: async () => {
        await candidate.stop();
        if (runtime === candidate) runtime = undefined;
        const jobDirectory = path.join(studioRoot, "data", "jobs", attemptJobId);
        await rm(jobDirectory, { recursive: true, force: true });
        await assert.rejects(stat(jobDirectory), (candidateError) => candidateError?.code === "ENOENT");
        await assert.rejects(
          stat(path.join(studioRoot, ".runtime", "browser", attemptJobId)),
          (candidateError) => candidateError?.code === "ENOENT",
        );
        if (attempt.observedAddressCollision) {
          collisionServer.closeIdleConnections?.();
          collisionServer.closeAllConnections?.();
          await new Promise((resolvePromise) => collisionServer.close(resolvePromise));
          collisionServer = undefined;
        }
        await assertLoopbackPortsReleased([publicPort, rawPort]);
      },
    });
  });
  assert.equal(started.index, 1);
  runtime = started.attempt.runtime;
  jobId = started.attempt.jobId;
  active = started.active;
  assert.ok(active);
  assert.ok(runtime);
  const compiled = compileExecutionCalls({
    schemaVersion: "1.1",
    targetUrl,
    targetOrigin: origin,
    authOrigins: [],
    resourceOrigins: [],
    successCriteria: ["Geometry fixture is visible"],
    forbiddenActions: ["사용자 데이터 변경"],
    captureSettings: { width: 1920, height: 1080, fps: 30 },
    steps: [{
      id: "step-01",
      action: "Capture the button geometry",
      expected: "The button remains visible",
      narration: "Capture the button position.",
      risk: "safe",
      calls: [{
        id: "step-01.click",
        tool: "browser_click",
        arguments: {
          element: "Capture geometry",
          target: 'getByRole("button", { name: "Capture geometry", exact: true })',
        },
      }],
    }],
  });
  const probeIndex = compiled.findIndex(({ id }) => id === "step-01.click.highlight-bounds");
  const calls = [compiled[probeIndex], compiled[probeIndex + 1]];
  const binding = { jobId, generation: active.generation, planDigest: "7".repeat(64) };
  runtime.installApproval({ ...binding, calls });

  await runtime.executeApproval(binding);

  assert.deepEqual(runtime.readExecutionHighlights({
    ...binding,
    expectedCallIds: [calls[0].id],
  }), [{
    approvedCallId: "step-01.click.highlight-bounds",
    x: 40,
    y: 50,
    width: 120,
    height: 40,
  }]);
});

test("browser bootstrap blocks redirects, subresources, OOPIFs, popups, WebSockets and service workers before attacker hit", {
  skip: process.platform !== "win32",
  timeout: 45_000,
}, async (t) => {
  let attacker;
  let approved;
  let auth;
  let resource;
  let context;
  let profile;
  let restoreBootstrap;
  t.after(async () => {
    restoreBootstrap?.();
    if (context) await context.close().catch(() => undefined);
    for (const server of [approved, auth, attacker, resource]) {
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

  let resourceHits = 0;
  resource = createServer((_request, response) => {
    resourceHits += 1;
    response.end("resource");
  });
  const resourcePort = await listen(resource);
  const resourceOrigin = `http://127.0.0.1:${resourcePort}`;

  let authHits = 0;
  auth = createServer((request, response) => {
    if (request.url === "/login") authHits += 1;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("auth");
  });
  const authPort = await listen(auth);
  const authOrigin = `http://127.0.0.1:${authPort}`;

  let approvedOrigin;
  let approvedWsRedirects = 0;
  approved = createServer((request, response) => {
    if (request.url === "/redirect-same") {
      response.writeHead(302, { Location: "/ok" });
      response.end();
    } else if (request.url === "/redirect-resource") {
      response.writeHead(302, { Location: `${resourceOrigin}/document` });
      response.end();
    } else if (request.url === "/resource-image") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<img src="${resourceOrigin}/pixel">resource image`);
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
  const authSealPath = path.join(profile, "auth-sealed");
  const authAckPath = path.join(profile, "auth-armed");
  const resourceDiagnostics = [];
  page.on("request", (request) => {
    if (request.url().startsWith(resourceOrigin)) {
      resourceDiagnostics.push(["request", request.resourceType(), request.isNavigationRequest()]);
    }
  });
  page.on("requestfailed", (request) => {
    if (request.url().startsWith(resourceOrigin)) {
      resourceDiagnostics.push(["failed", request.failure()?.errorText ?? null]);
    }
  });
  const { loaded, restore } = loadFreshBootstrap({
    MANUAL_STUDIO_ALLOWED_ORIGINS: JSON.stringify([approvedOrigin, authOrigin, resourceOrigin]),
    MANUAL_STUDIO_NAVIGATION_ORIGINS: JSON.stringify([approvedOrigin, authOrigin]),
    MANUAL_STUDIO_TARGET_URL: `${approvedOrigin}/ok`,
    MANUAL_STUDIO_AUTH_MODE: "manual",
    MANUAL_STUDIO_AUTH_SEAL_PATH: authSealPath,
  });
  restoreBootstrap = restore;
  await loaded.default({ page });

  assert.equal((await page.goto(`${approvedOrigin}/redirect-same`)).status(), 200);
  assert.equal((await page.goto(`${authOrigin}/login`)).status(), 200);
  assert.equal(authHits, 1);
  assert.equal((await page.goto(`${approvedOrigin}/ok`)).status(), 200);
  await writeFile(authSealPath, "manual-video-auth-sealed-v1\n", "utf8");
  let authenticationArmed = false;
  const authenticationDeadline = Date.now() + 10_000;
  while (Date.now() < authenticationDeadline) {
    try {
      if (await readFile(authAckPath, "utf8") === "manual-video-auth-armed-v1\n") {
        authenticationArmed = true;
        break;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert.equal(authenticationArmed, true, "manual authentication was not armed before the bounded deadline");
  await page.goto(`${authOrigin}/login`).catch(() => undefined);
  await page.waitForTimeout(100);
  assert.equal(authHits, 1);
  await page.goto(`${approvedOrigin}/resource-image`);
  await page.waitForTimeout(100);
  assert.equal(resourceHits, 1, JSON.stringify(resourceDiagnostics));
  resourceHits = 0;
  await page.goto(`${approvedOrigin}/redirect-resource`).catch(() => undefined);
  await page.waitForTimeout(100);
  assert.equal(resourceHits, 0);
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
