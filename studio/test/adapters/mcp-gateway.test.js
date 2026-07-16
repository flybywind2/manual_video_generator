import assert from "node:assert/strict";
import { createServer, request as httpRequest, ServerResponse } from "node:http";
import test from "node:test";

import { executeApprovedMcpCalls } from "../../src/adapters/browser-runtime.js";
import { McpGateway } from "../../src/adapters/mcp-gateway.js";
import { CLICK_GEOMETRY_FUNCTION } from "../../src/domain/execution-calls.js";

const JOB_ID = "job-0123456789abcdef";
const CAPABILITY_TOKEN = Buffer.alloc(32, 0x5a).toString("base64url");
const OTHER_CAPABILITY_TOKEN = Buffer.alloc(32, 0xa5).toString("base64url");
const EXECUTOR_SESSION_ID = "raw-session-executor-0123456789abcdef";

function createGateway(options) {
  return new McpGateway({ ...options, capabilityToken: CAPABILITY_TOKEN });
}

function sse(value) {
  return `event: message\ndata: ${JSON.stringify(value)}\n\n`;
}

function clickCalls(id, target, element) {
  return [
    {
      id: `${id}.highlight-bounds`,
      tool: "browser_evaluate",
      arguments: {
        ...(element === undefined ? {} : { element }),
        target,
        function: CLICK_GEOMETRY_FUNCTION,
      },
    },
    {
      id,
      tool: "browser_click",
      arguments: {
        ...(element === undefined ? {} : { element }),
        target,
      },
    },
  ];
}

function evaluateToolResult(geometry) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ result: typeof geometry === "string" ? geometry : JSON.stringify(geometry) }),
    }],
  };
}

async function listen(server) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  return server.address().port;
}

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function startUpstream(t, { getResponder, initializeResponder, toolResponder } = {}) {
  const calls = [];
  const requests = [];
  let sessionSequence = 0;
  const server = createServer(async (request, response) => {
    const body = await readRequest(request);
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    if (request.method === "POST") {
      const message = JSON.parse(body);
      if (message.method === "initialize") {
        const sessionId = `raw-session-${++sessionSequence}-0123456789abcdef`;
        if (initializeResponder) {
          await initializeResponder({ message, request, response, sessionId });
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "mcp-session-id": sessionId,
          "cache-control": "no-cache",
          "set-cookie": "unsafe=secret",
          location: "http://attacker.invalid/redirect",
          "x-upstream-secret": "must-not-cross",
        });
        response.end(sse({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: {} } }));
        return;
      }
      if (message.method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
        return;
      }
      if (message.method === "tools/list") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sse({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
        return;
      }
      if (message.method === "tools/call") {
        calls.push({
          sessionId: request.headers["mcp-session-id"],
          name: message.params?.name,
          arguments: message.params?.arguments,
        });
        if (toolResponder) {
          await toolResponder({ message, request, response });
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sse({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } }));
        return;
      }
    }
    if (request.method === "GET" && getResponder) {
      await getResponder({ request, response });
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(200, { "content-type": "text/plain; charset=UTF-8" });
      response.end();
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  const port = await listen(server);
  t.after(async () => {
    server.closeAllConnections?.();
    if (server.listening) await new Promise((resolvePromise) => server.close(resolvePromise));
  });
  return { calls, port, requests, server };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.fail("Timed out waiting for condition.");
}

async function request(endpoint, {
  method = "POST",
  sessionId,
  message,
  body,
  headers = {},
  authorized = true,
} = {}) {
  const url = new URL(endpoint);
  const source = body ?? (message === undefined ? undefined : JSON.stringify(message));
  return await new Promise((resolvePromise, rejectPromise) => {
    const outgoing = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: {
        ...(authorized ? { authorization: `Bearer ${CAPABILITY_TOKEN}` } : {}),
        ...(source === undefined ? {} : {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(source),
        }),
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...headers,
      },
    });
    outgoing.once("error", rejectPromise);
    outgoing.once("response", async (response) => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolvePromise({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      } catch (error) {
        rejectPromise(error);
      }
    });
    if (source !== undefined) outgoing.end(source);
    else outgoing.end();
  });
}

async function initialize(endpoint) {
  const response = await request(endpoint, {
    message: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "gateway-test", version: "1" },
      },
    },
    headers: {
      authorization: `Bearer ${CAPABILITY_TOKEN}`,
      cookie: "must-not-cross=1",
      "x-forwarded-for": "203.0.113.10",
    },
  });
  assert.equal(response.status, 200);
  assert.match(response.body, /"protocolVersion":"2025-03-26"/u);
  assert.equal(typeof response.headers["mcp-session-id"], "string");
  return { response, sessionId: response.headers["mcp-session-id"] };
}

test("a 256-bit capability blocks unauthenticated cross-origin reads and form posts without quarantine", async (t) => {
  const upstream = await startUpstream(t);
  const fatals = [];
  assert.throws(
    () => new McpGateway({
      upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
      port: 0,
      onFatal: async () => {},
    }),
    (error) => error.code === "INVALID_MCP_GATEWAY_OPTIONS",
  );
  assert.throws(
    () => new McpGateway({
      upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
      port: 0,
      capabilityToken: "short",
      onFatal: async () => {},
    }),
    (error) => error.code === "INVALID_MCP_GATEWAY_OPTIONS",
  );
  const gateway = new McpGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    capabilityToken: CAPABILITY_TOKEN,
    onFatal: async (event) => fatals.push(event),
  });
  t.after(() => gateway.stop());
  await gateway.start({ jobId: JOB_ID, generation: 6 });
  const { sessionId } = await initialize(gateway.endpoint);
  const upstreamCount = upstream.requests.length;

  const unauthenticatedGet = await request(gateway.endpoint, {
    method: "GET",
    sessionId,
    authorized: false,
    headers: { origin: "https://attacker.invalid" },
  });
  assert.equal(unauthenticatedGet.status, 401);

  const unauthenticatedForm = await request(gateway.endpoint, {
    sessionId,
    body: "method=tools%2Flist",
    authorized: false,
    headers: {
      origin: "https://attacker.invalid",
      "content-type": "application/x-www-form-urlencoded",
    },
  });
  assert.equal(unauthenticatedForm.status, 401);

  const wrongToken = await request(gateway.endpoint, {
    sessionId,
    authorized: false,
    message: { jsonrpc: "2.0", id: 601, method: "tools/list", params: {} },
    headers: { authorization: `Bearer ${OTHER_CAPABILITY_TOKEN}` },
  });
  assert.equal(wrongToken.status, 401);

  const duplicateToken = await request(gateway.endpoint, {
    sessionId,
    authorized: false,
    message: { jsonrpc: "2.0", id: 602, method: "tools/list", params: {} },
    headers: { authorization: [`Bearer ${CAPABILITY_TOKEN}`, `Bearer ${CAPABILITY_TOKEN}`] },
  });
  assert.equal(duplicateToken.status, 401);

  assert.equal(upstream.requests.length, upstreamCount);
  assert.equal(gateway.active.phase, "planning");
  assert.deepEqual(fatals, []);

  const authenticated = await request(gateway.endpoint, {
    sessionId,
    message: { jsonrpc: "2.0", id: 603, method: "tools/list", params: {} },
  });
  assert.equal(authenticated.status, 200);
  assert.equal(upstream.requests.length, upstreamCount + 1);
  assert.equal(gateway.active.phase, "planning");
  assert.deepEqual(fatals, []);
});

test("planning proxies only the exact observation calls through a generation-bound MCP session", async (t) => {
  const upstream = await startUpstream(t);
  const fatals = [];
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async (event) => fatals.push(event),
  });
  t.after(() => gateway.stop());

  const active = await gateway.start({ jobId: JOB_ID, generation: 7 });
  assert.equal(gateway.endpoint, active.endpoint);
  assert.deepEqual(gateway.active, {
    endpoint: active.endpoint,
    jobId: JOB_ID,
    generation: 7,
    phase: "planning",
    remainingCalls: 0,
  });

  const initialized = await initialize(gateway.endpoint);
  assert.equal(initialized.response.headers["set-cookie"], undefined);
  assert.equal(initialized.response.headers.location, undefined);
  assert.equal(initialized.response.headers["x-upstream-secret"], undefined);

  const notification = await request(gateway.endpoint, {
    sessionId: initialized.sessionId,
    message: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  assert.equal(notification.status, 202);

  const listed = await request(gateway.endpoint, {
    sessionId: initialized.sessionId,
    message: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  });
  assert.equal(listed.status, 200);

  for (const [id, name, argumentsValue, metadata] of [
    [3, "browser_snapshot", {}, { progressToken: 2 }],
    [4, "browser_wait_for", { time: 0.01 }, { progressToken: "planner-progress-4" }],
    [5, "browser_take_screenshot", { type: "png", scale: "css" }, undefined],
  ]) {
    const observed = await request(gateway.endpoint, {
      sessionId: initialized.sessionId,
      message: {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name,
          arguments: argumentsValue,
          ...(metadata === undefined ? {} : { _meta: metadata }),
        },
      },
    });
    assert.equal(observed.status, 200);
  }

  assert.deepEqual(upstream.calls.map(({ name }) => name), [
    "browser_snapshot",
    "browser_wait_for",
    "browser_take_screenshot",
  ]);
  const forwardedMetadata = upstream.requests
    .map(({ body }) => JSON.parse(body))
    .filter(({ method }) => method === "tools/call")
    .map(({ params }) => params._meta);
  assert.deepEqual(forwardedMetadata, [
    { progressToken: 2 },
    { progressToken: "planner-progress-4" },
    undefined,
  ]);
  assert.ok(upstream.calls.every(({ sessionId }) => sessionId === initialized.sessionId));
  assert.equal(upstream.requests[0].headers.authorization, undefined);
  assert.equal(upstream.requests[0].headers.cookie, undefined);
  assert.equal(upstream.requests[0].headers["x-forwarded-for"], undefined);
  assert.deepEqual(fatals, []);
});

test("planning rejects noncanonical progress metadata before raw MCP", async (t) => {
  const cases = [
    { name: "null metadata", metadata: null },
    { name: "missing token", metadata: {} },
    { name: "extra metadata", metadata: { progressToken: 2, unexpected: true } },
    { name: "fractional token", metadata: { progressToken: 1.5 } },
    { name: "empty token", metadata: { progressToken: "" } },
    { name: "unbounded token", metadata: { progressToken: "x".repeat(513) } },
    { name: "nul token", metadata: { progressToken: "bad\0token" } },
  ];

  for (const [index, policyCase] of cases.entries()) {
    await t.test(policyCase.name, async (t) => {
      const upstream = await startUpstream(t);
      const fatals = [];
      const gateway = createGateway({
        upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
        port: 0,
        onFatal: async (event) => fatals.push(event),
      });
      t.after(() => gateway.stop());
      await gateway.start({ jobId: JOB_ID, generation: 72 + index });
      const { sessionId } = await initialize(gateway.endpoint);
      upstream.calls.length = 0;

      const response = await request(gateway.endpoint, {
        sessionId,
        message: {
          jsonrpc: "2.0",
          id: 700 + index,
          method: "tools/call",
          params: {
            name: "browser_snapshot",
            arguments: {},
            _meta: policyCase.metadata,
          },
        },
      });
      assert.equal(response.status, 403);
      await waitFor(() => fatals.length === 1);
      assert.deepEqual(upstream.calls, []);
      assert.equal(fatals[0].reason, "INVALID_TOOL_CALL");
    });
  }
});

test("the actual MCP empty text/plain DELETE response closes only its registered session", async (t) => {
  const upstream = await startUpstream(t);
  const fatals = [];
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async (event) => fatals.push(event),
  });
  t.after(() => gateway.stop());
  await gateway.start({ jobId: JOB_ID, generation: 71 });
  const { sessionId } = await initialize(gateway.endpoint);

  const deleted = await request(gateway.endpoint, { method: "DELETE", sessionId });
  assert.equal(deleted.status, 200);
  assert.match(deleted.headers["content-type"], /^text\/plain/iu);
  assert.equal(deleted.body, "");
  assert.deepEqual(fatals, []);

  const stale = await request(gateway.endpoint, {
    sessionId,
    message: { jsonrpc: "2.0", id: 72, method: "tools/list", params: {} },
  });
  assert.equal(stale.status, 403);
  await waitFor(() => fatals.length === 1);
  assert.equal(fatals[0].reason, "UNKNOWN_SESSION");
});

test("execution accepts only the installed ordered exact calls and freezes the approval contract", async (t) => {
  const upstream = await startUpstream(t);
  const fatals = [];
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async (event) => fatals.push(event),
  });
  t.after(() => gateway.stop());
  await gateway.start({ jobId: JOB_ID, generation: 8, adoptedSessionId: EXECUTOR_SESSION_ID });
  const sessionId = EXECUTOR_SESSION_ID;
  const firstArguments = { target: "button-submit", button: "left" };
  const planDigest = "a".repeat(64);
  const approval = {
    jobId: JOB_ID,
    generation: 8,
    planDigest,
    calls: [
      { id: "call-001", tool: "browser_click", arguments: firstArguments },
      { id: "call-002", tool: "browser_type", arguments: { target: "input-name", text: "approved text" } },
    ],
  };

  assert.deepEqual(gateway.installApproval(approval), {
    jobId: JOB_ID,
    generation: 8,
    planDigest,
    callCount: 2,
  });
  firstArguments.target = "mutated-after-install";
  approval.calls.push({ id: "call-003", tool: "browser_press_key", arguments: { key: "Enter" } });
  assert.deepEqual(gateway.active, {
    endpoint: gateway.endpoint,
    jobId: JOB_ID,
    generation: 8,
    phase: "execution",
    remainingCalls: 2,
    planDigest,
  });

  const first = await request(gateway.endpoint, {
    sessionId,
    message: {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "browser_click",
        arguments: { button: "left", target: "button-submit" },
        _meta: { progressToken: 10 },
      },
    },
  });
  assert.equal(first.status, 200);
  assert.equal(gateway.active.remainingCalls, 1);

  const second = await request(gateway.endpoint, {
    sessionId,
    message: {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "browser_type",
        arguments: { text: "approved text", target: "input-name" },
        _meta: { progressToken: "executor-progress-11" },
      },
    },
  });
  assert.equal(second.status, 200);
  assert.equal(gateway.active.phase, "execution_complete");
  assert.equal(gateway.active.remainingCalls, 0);
  const forwardedProgressTokens = upstream.requests
    .map(({ body }) => JSON.parse(body))
    .filter(({ method }) => method === "tools/call")
    .map(({ params }) => params._meta.progressToken);
  assert.deepEqual(forwardedProgressTokens, [10, "executor-progress-11"]);
  assert.deepEqual(upstream.calls.map(({ name }) => name), ["browser_click", "browser_type"]);

  const extra = await request(gateway.endpoint, {
    sessionId,
    message: {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "browser_press_key", arguments: { key: "Enter" } },
    },
  });
  assert.equal(extra.status, 403);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(gateway.active.phase, "quarantined");
  assert.equal(fatals.length, 1);
  assert.equal(fatals[0].reason, "TOOL_NOT_ALLOWED_IN_PHASE");
  assert.deepEqual(upstream.calls.map(({ name }) => name), ["browser_click", "browser_type"]);
});

test("execution timing is measured from successful approved calls and bound to the active approval", async (t) => {
  const recordingFileName = "video-2026-07-15T00-00-00-000Z.webm";
  const upstream = await startUpstream(t, {
    toolResponder: async ({ message, response }) => {
      const text = message.params?.name === "browser_stop_video"
        ? `### Result\n- [Video](./${recordingFileName})`
        : "ok";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text }] },
      }));
    },
  });
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async () => {},
  });
  t.after(() => gateway.stop());
  await gateway.start({ jobId: JOB_ID, generation: 81, adoptedSessionId: EXECUTOR_SESSION_ID });
  const sessionId = EXECUTOR_SESSION_ID;
  const planDigest = "e".repeat(64);
  const calls = [
    { id: "system.start-video", tool: "browser_start_video", arguments: { size: { width: 1920, height: 1080 } } },
    { id: "step-01.click", tool: "browser_click", arguments: { target: "button-submit" } },
    { id: "system.stop-video", tool: "browser_stop_video", arguments: {} },
  ];
  const binding = { jobId: JOB_ID, generation: 81, planDigest };
  gateway.installApproval({ ...binding, calls });

  assert.deepEqual(gateway.readExecutionTiming(binding), {
    schemaVersion: "1.0",
    clock: "unix_ms",
    ...binding,
    complete: false,
    calls: [],
  });

  for (const [index, call] of calls.entries()) {
    const response = await request(gateway.endpoint, {
      sessionId,
      message: {
        jsonrpc: "2.0",
        id: 100 + index,
        method: "tools/call",
        params: { name: call.tool, arguments: call.arguments },
      },
    });
    assert.equal(response.status, 200);
  }

  const timing = gateway.readExecutionTiming(binding);
  assert.equal(timing.complete, true);
  assert.deepEqual(
    timing.calls.map(({ id, tool }) => ({ id, tool })),
    calls.map(({ id, tool }) => ({ id, tool })),
  );
  for (const [index, call] of timing.calls.entries()) {
    assert.equal(Number.isSafeInteger(call.startedAtMs), true);
    assert.equal(Number.isSafeInteger(call.endedAtMs), true);
    assert.equal(call.endedAtMs > call.startedAtMs, true);
    if (index > 0) assert.equal(call.startedAtMs >= timing.calls[index - 1].endedAtMs, true);
    assert.equal(Object.isFrozen(call), true);
  }
  assert.equal(Object.isFrozen(timing), true);
  assert.equal(Object.isFrozen(timing.calls), true);
  assert.deepEqual(gateway.readRecordingArtifact(binding), {
    schemaVersion: "1.0",
    jobId: JOB_ID,
    generation: 81,
    planDigest,
    approvedCallId: "system.stop-video",
    fileName: recordingFileName,
  });
  assert.equal(Object.isFrozen(gateway.readRecordingArtifact(binding)), true);
  assert.throws(
    () => gateway.readExecutionTiming({ ...binding, planDigest: "f".repeat(64) }),
    (error) => error.code === "INVALID_MCP_GATEWAY_TIMING",
  );
  assert.throws(
    () => gateway.readRecordingArtifact({ ...binding, generation: 82 }),
    (error) => error.code === "INVALID_MCP_GATEWAY_ARTIFACT",
  );
});

test("completed execution returns immutable ordered click geometry from the exact Playwright MCP 0.0.78 response", async (t) => {
  const geometries = new Map([
    ["first-target", { x: 8.25, y: 120.75, width: 126.5, height: 23.1 }],
    ["second-target", { x: 1_800, y: 1_000, width: 120, height: 80 }],
  ]);
  const upstream = await startUpstream(t, {
    toolResponder: async ({ message, response }) => {
      const result = message.params?.name === "browser_evaluate"
        ? evaluateToolResult(geometries.get(message.params.arguments.target))
        : { content: [{ type: "text", text: "ok" }] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse({ jsonrpc: "2.0", id: message.id, result }));
    },
  });
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async () => {},
  });
  t.after(() => gateway.stop());
  const binding = {
    jobId: JOB_ID,
    generation: 82,
    planDigest: "8".repeat(64),
    expectedCallIds: ["step-01.first.highlight-bounds", "step-01.second.highlight-bounds"],
  };
  const calls = [
    ...clickCalls("step-01.first", "first-target", "첫 번째 대상"),
    ...clickCalls("step-01.second", "second-target"),
  ];
  await gateway.start({ jobId: binding.jobId, generation: binding.generation, adoptedSessionId: EXECUTOR_SESSION_ID });
  gateway.installApproval({
    jobId: binding.jobId,
    generation: binding.generation,
    planDigest: binding.planDigest,
    calls,
  });

  assert.throws(
    () => gateway.readExecutionHighlights(binding),
    (error) => error.code === "INVALID_MCP_GATEWAY_HIGHLIGHTS",
  );
  for (const [index, call] of calls.entries()) {
    const outcome = await request(gateway.endpoint, {
      sessionId: EXECUTOR_SESSION_ID,
      message: {
        jsonrpc: "2.0",
        id: 200 + index,
        method: "tools/call",
        params: { name: call.tool, arguments: call.arguments },
      },
    });
    assert.equal(outcome.status, 200);
  }

  const highlights = gateway.readExecutionHighlights(binding);
  assert.deepEqual(highlights, [
    { approvedCallId: "step-01.first.highlight-bounds", x: 8, y: 120, width: 127, height: 24 },
    { approvedCallId: "step-01.second.highlight-bounds", x: 1_800, y: 1_000, width: 120, height: 80 },
  ]);
  assert.equal(Object.isFrozen(highlights), true);
  assert.equal(highlights.every((highlight) => Object.isFrozen(highlight)), true);
  for (const invalid of [
    { ...binding, jobId: "job-fedcba9876543210" },
    { ...binding, generation: 83 },
    { ...binding, planDigest: "9".repeat(64) },
    { ...binding, expectedCallIds: [...binding.expectedCallIds].reverse() },
    { ...binding, expectedCallIds: [binding.expectedCallIds[0], binding.expectedCallIds[0]] },
    { ...binding, expectedCallIds: ["step-01.unknown.highlight-bounds", binding.expectedCallIds[1]] },
  ]) {
    assert.throws(
      () => gateway.readExecutionHighlights(invalid),
      (error) => error.code === "INVALID_MCP_GATEWAY_HIGHLIGHTS",
    );
  }
});

test("click geometry capture rejects every non-canonical or unsafe evaluate result before queue commit", async (t) => {
  const validGeometry = JSON.stringify({ x: 8, y: 121, width: 127, height: 24 });
  const cases = [
    { name: "malformed response text", result: { content: [{ type: "text", text: "not-json" }] } },
    { name: "extra outer result field", result: { ...evaluateToolResult(validGeometry), structuredContent: {} } },
    { name: "multiple content items", result: { content: [{ type: "text", text: JSON.stringify({ result: validGeometry }) }, { type: "text", text: "duplicate" }] } },
    { name: "extra envelope field", result: { content: [{ type: "text", text: JSON.stringify({ result: validGeometry, extra: true }) }] } },
    { name: "non-string envelope result", result: { content: [{ type: "text", text: JSON.stringify({ result: { x: 8, y: 121, width: 127, height: 24 } }) }] } },
    { name: "malformed geometry JSON", result: evaluateToolResult("{not-json") },
    { name: "extra geometry field", result: evaluateToolResult('{"x":8,"y":121,"width":127,"height":24,"extra":true}') },
    { name: "non-finite coordinate", result: evaluateToolResult('{"x":1e400,"y":121,"width":127,"height":24}') },
    { name: "null coordinate", result: evaluateToolResult('{"x":null,"y":121,"width":127,"height":24}') },
    { name: "zero width", result: evaluateToolResult({ x: 8, y: 121, width: 0, height: 24 }) },
    { name: "negative height", result: evaluateToolResult({ x: 8, y: 121, width: 127, height: -1 }) },
    { name: "negative normalized origin", result: evaluateToolResult({ x: -0.1, y: 121, width: 127, height: 24 }) },
    { name: "right edge outside frame", result: evaluateToolResult({ x: 1_900, y: 121, width: 21, height: 24 }) },
    { name: "bottom edge outside frame", result: evaluateToolResult({ x: 8, y: 1_070, width: 127, height: 11 }) },
  ];

  for (const [index, failureCase] of cases.entries()) {
    await t.test(failureCase.name, async (t) => {
      const upstream = await startUpstream(t, {
        toolResponder: async ({ message, response }) => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(sse({ jsonrpc: "2.0", id: message.id, result: failureCase.result }));
        },
      });
      const fatals = [];
      const gateway = createGateway({
        upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
        port: 0,
        onFatal: async (event) => fatals.push(event),
      });
      t.after(() => gateway.stop());
      const generation = 200 + index;
      const planDigest = "a".repeat(64);
      const calls = clickCalls("step-01.click", "approved-target", "승인 대상");
      await gateway.start({ jobId: JOB_ID, generation, adoptedSessionId: EXECUTOR_SESSION_ID });
      gateway.installApproval({ jobId: JOB_ID, generation, planDigest, calls });

      await request(gateway.endpoint, {
        sessionId: EXECUTOR_SESSION_ID,
        message: {
          jsonrpc: "2.0",
          id: 400 + index,
          method: "tools/call",
          params: { name: calls[0].tool, arguments: calls[0].arguments },
        },
      }).catch(() => undefined);
      await waitFor(() => fatals.length === 1);
      assert.equal(fatals[0].reason, "HIGHLIGHT_GEOMETRY_INVALID");
      assert.equal(gateway.active.phase, "quarantined");
      assert.equal(gateway.active.remainingCalls, calls.length);
      assert.throws(
        () => gateway.readExecutionHighlights({
          jobId: JOB_ID,
          generation,
          planDigest,
          expectedCallIds: [calls[0].id],
        }),
        (error) => error.code === "INVALID_MCP_GATEWAY_HIGHLIGHTS",
      );
    });
  }
});

test("approval accepts evaluate only as an exact generated probe immediately before its matching click", async (t) => {
  const baseCalls = clickCalls("step-01.click", "approved-target", "승인 대상");
  const cases = [
    { name: "reordered probe", calls: [baseCalls[1], baseCalls[0]] },
    { name: "wrong generated id", calls: [{ ...baseCalls[0], id: "step-01.wrong.highlight-bounds" }, baseCalls[1]] },
    { name: "mutated function", calls: [{ ...baseCalls[0], arguments: { ...baseCalls[0].arguments, function: "(element) => ({ x: 0, y: 0, width: 1, height: 1 })" } }, baseCalls[1]] },
    { name: "mutated target", calls: [{ ...baseCalls[0], arguments: { ...baseCalls[0].arguments, target: "other-target" } }, baseCalls[1]] },
    { name: "mutated element", calls: [{ ...baseCalls[0], arguments: { ...baseCalls[0].arguments, element: "다른 대상" } }, baseCalls[1]] },
    { name: "arbitrary evaluate", calls: [{ id: "step-01.evaluate", tool: "browser_evaluate", arguments: baseCalls[0].arguments }] },
  ];

  for (const [index, invalidCase] of cases.entries()) {
    await t.test(invalidCase.name, async (t) => {
      const upstream = await startUpstream(t);
      const fatals = [];
      const gateway = createGateway({
        upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
        port: 0,
        onFatal: async (event) => fatals.push(event),
      });
      t.after(() => gateway.stop());
      const generation = 300 + index;
      await gateway.start({ jobId: JOB_ID, generation, adoptedSessionId: EXECUTOR_SESSION_ID });
      assert.throws(
        () => gateway.installApproval({
          jobId: JOB_ID,
          generation,
          planDigest: "b".repeat(64),
          calls: invalidCase.calls,
        }),
        (error) => error.code === "INVALID_MCP_GATEWAY_APPROVAL",
      );
      await waitFor(() => fatals.length === 1);
      assert.equal(fatals[0].reason, "INVALID_APPROVAL");
      assert.equal(gateway.active.phase, "quarantined");
      assert.deepEqual(upstream.calls, []);
    });
  }
});

test("the production coordinator MCP client completes an installed gateway approval", async (t) => {
  const upstream = await startUpstream(t, {
    toolResponder: async ({ message, response }) => {
      const text = message.params?.name === "browser_stop_video"
        ? "### Result\n- [Video](./video-coordinator.webm)"
        : "ok";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text }] },
      }));
    },
  });
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async () => {},
  });
  t.after(() => gateway.stop());
  await gateway.start({ jobId: JOB_ID, generation: 91, adoptedSessionId: EXECUTOR_SESSION_ID });
  const calls = [
    { id: "system.start-video", tool: "browser_start_video", arguments: { size: { width: 1920, height: 1080 } } },
    { id: "system.stop-video", tool: "browser_stop_video", arguments: {} },
  ];
  gateway.installApproval({
    jobId: JOB_ID,
    generation: 91,
    planDigest: "a".repeat(64),
    calls,
  });

  assert.deepEqual(await executeApprovedMcpCalls({
    endpoint: gateway.endpoint,
    capabilityToken: CAPABILITY_TOKEN,
    sessionId: EXECUTOR_SESSION_ID,
    calls,
    onCall: async () => {},
  }), { callCount: 2 });
  assert.equal(gateway.active.phase, "execution_complete");
  assert.equal(gateway.active.remainingCalls, 0);
});

test("approval fails closed without a retained executor session", async (t) => {
  const upstream = await startUpstream(t);
  const fatals = [];
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async (event) => fatals.push(event),
  });
  t.after(() => gateway.stop());
  await gateway.start({ jobId: JOB_ID, generation: 911 });

  assert.throws(
    () => gateway.installApproval({
      jobId: JOB_ID,
      generation: 911,
      planDigest: "1".repeat(64),
      calls: [{ id: "step-01.click", tool: "browser_click", arguments: { target: "approved" } }],
    }),
    (error) => error.code === "INVALID_MCP_GATEWAY_APPROVAL",
  );
  await waitFor(() => fatals.length === 1);
  assert.equal(fatals[0].reason, "EXECUTOR_SESSION_REQUIRED");
  assert.equal(gateway.active.phase, "quarantined");
  assert.equal(upstream.requests.length, 0);
});

test("the gateway adopts the retained readiness session for coordinator execution", async (t) => {
  const adoptedSessionId = "raw-session-adopted-0123456789abcdef";
  const upstream = await startUpstream(t, {
    toolResponder: async ({ message, response }) => {
      const text = message.params?.name === "browser_stop_video"
        ? "### Result\n- [Video](./video-adopted-session.webm)"
        : "ok";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text }] },
      }));
    },
  });
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async () => {},
  });
  t.after(() => gateway.stop());
  await gateway.start({ jobId: JOB_ID, generation: 92, adoptedSessionId });
  const calls = [
    { id: "system.start-video", tool: "browser_start_video", arguments: { size: { width: 1920, height: 1080 } } },
    { id: "system.stop-video", tool: "browser_stop_video", arguments: {} },
  ];
  gateway.installApproval({
    jobId: JOB_ID,
    generation: 92,
    planDigest: "b".repeat(64),
    calls,
  });

  assert.deepEqual(await executeApprovedMcpCalls({
    endpoint: gateway.endpoint,
    capabilityToken: CAPABILITY_TOKEN,
    sessionId: adoptedSessionId,
    calls,
    onCall: async () => {},
  }), { callCount: 2 });
  assert.equal(gateway.active.phase, "execution_complete");
  assert.deepEqual(upstream.calls.map(({ sessionId, name }) => ({ sessionId, name })), [
    { sessionId: adoptedSessionId, name: "browser_start_video" },
    { sessionId: adoptedSessionId, name: "browser_stop_video" },
  ]);
  assert.equal(upstream.requests.some(({ body }) => body.includes('"method":"initialize"')), false);
  assert.equal(upstream.requests.some(({ method }) => method === "DELETE"), false);
});

test("an adopted executor session rejects planner sessions and new execution initializations", async (t) => {
  const adoptedSessionId = "raw-session-adopted-0123456789abcdef";
  const upstream = await startUpstream(t);
  const fatals = [];
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async (event) => fatals.push(event),
  });
  t.after(() => gateway.stop());
  await gateway.start({ jobId: JOB_ID, generation: 93, adoptedSessionId });
  const planner = await initialize(gateway.endpoint);
  gateway.installApproval({
    jobId: JOB_ID,
    generation: 93,
    planDigest: "c".repeat(64),
    calls: [{ id: "step-01.click", tool: "browser_click", arguments: { target: "approved" } }],
  });

  const plannerAttempt = await request(gateway.endpoint, {
    sessionId: planner.sessionId,
    message: {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "browser_click", arguments: { target: "approved" } },
    },
  });
  assert.equal(plannerAttempt.status, 403);
  await waitFor(() => fatals.length === 1);
  assert.equal(fatals[0].reason, "EXECUTION_SESSION_MISMATCH");
  assert.equal(upstream.calls.length, 0);

  const secondUpstream = await startUpstream(t);
  const secondGateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${secondUpstream.port}/mcp`,
    port: 0,
    onFatal: async () => {},
  });
  t.after(() => secondGateway.stop());
  await secondGateway.start({ jobId: JOB_ID, generation: 94, adoptedSessionId });
  secondGateway.installApproval({
    jobId: JOB_ID,
    generation: 94,
    planDigest: "d".repeat(64),
    calls: [{ id: "step-01.click", tool: "browser_click", arguments: { target: "approved" } }],
  });
  const initializeAttempt = await request(secondGateway.endpoint, {
    message: {
      jsonrpc: "2.0",
      id: 21,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "late-client", version: "1" },
      },
    },
  });
  assert.equal(initializeAttempt.status, 403);
  assert.equal(secondUpstream.requests.length, 0);
});

test("completed execution returns immutable ordered screenshot evidence bound to its generation and approved calls", async (t) => {
  const screenshotFileNames = [
    "page-2026-07-15T01-02-03-004Z.png",
    "page-2026-07-15T01-02-04-005Z.jpeg",
    "page-2026-07-15T01-02-05-006Z.jpg",
  ];
  let screenshotIndex = 0;
  const upstream = await startUpstream(t, {
    toolResponder: async ({ message, response }) => {
      const isScreenshot = message.params?.name === "browser_take_screenshot";
      const text = isScreenshot
        ? `### Result\n- [Screenshot of viewport](./${screenshotFileNames[screenshotIndex++]})\n### Ran Playwright code\n\`\`\`js\nawait page.screenshot();\n\`\`\``
        : "ok";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text }] },
      }));
    },
  });
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async () => {},
  });
  t.after(() => gateway.stop());
  await gateway.start({ jobId: JOB_ID, generation: 82, adoptedSessionId: EXECUTOR_SESSION_ID });
  const sessionId = EXECUTOR_SESSION_ID;
  const calls = [
    { id: "step-01.evidence-screenshot", tool: "browser_take_screenshot", arguments: { type: "png", scale: "css" } },
    { id: "step-01.wait", tool: "browser_wait_for", arguments: { time: 0.01 } },
    { id: "step-02.evidence-screenshot", tool: "browser_take_screenshot", arguments: { type: "jpeg", scale: "css" } },
    { id: "step-03.evidence-screenshot", tool: "browser_take_screenshot", arguments: { type: "jpeg", scale: "css" } },
  ];
  gateway.installApproval({
    jobId: JOB_ID,
    generation: 82,
    planDigest: "9".repeat(64),
    calls,
  });
  const evidenceRequest = {
    expectedGenerationId: 82,
    expectedCallIds: [
      "step-01.evidence-screenshot",
      "step-02.evidence-screenshot",
      "step-03.evidence-screenshot",
    ],
  };

  await assert.rejects(
    async () => gateway.readEvidenceArtifacts(evidenceRequest),
    (error) => error.code === "INVALID_MCP_GATEWAY_EVIDENCE",
  );

  for (const [index, call] of calls.entries()) {
    const response = await request(gateway.endpoint, {
      sessionId,
      message: {
        jsonrpc: "2.0",
        id: 820 + index,
        method: "tools/call",
        params: { name: call.tool, arguments: call.arguments },
      },
    });
    assert.equal(response.status, 200);
  }

  const evidence = gateway.readEvidenceArtifacts(evidenceRequest);
  assert.deepEqual(evidence, [
    { approvedCallId: "step-01.evidence-screenshot", fileName: screenshotFileNames[0] },
    { approvedCallId: "step-02.evidence-screenshot", fileName: screenshotFileNames[1] },
    { approvedCallId: "step-03.evidence-screenshot", fileName: screenshotFileNames[2] },
  ]);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(evidence.every((artifact) => Object.isFrozen(artifact)), true);
  assert.throws(
    () => gateway.readEvidenceArtifacts({ ...evidenceRequest, expectedGenerationId: 83 }),
    (error) => error.code === "INVALID_MCP_GATEWAY_EVIDENCE",
  );
  assert.throws(
    () => gateway.readEvidenceArtifacts({ ...evidenceRequest, expectedCallIds: [...evidenceRequest.expectedCallIds].reverse() }),
    (error) => error.code === "INVALID_MCP_GATEWAY_EVIDENCE",
  );
});

test("an approved screenshot without exactly one safe omitted-image result is quarantined before queue commit", async (t) => {
  const cases = [
    {
      name: "missing screenshot link",
      content: [{ type: "text", text: "### Result\nScreenshot unavailable" }],
    },
    {
      name: "path traversal",
      content: [{ type: "text", text: "- [Screenshot of viewport](../forged.png)" }],
    },
    {
      name: "multiple screenshot links",
      content: [{
        type: "text",
        text: "- [Screenshot of viewport](./one.png)\n- [Screenshot of viewport](./two.jpg)",
      }],
    },
    {
      name: "unsupported image extension",
      content: [{ type: "text", text: "- [Screenshot of viewport](./forged.webp)" }],
    },
    {
      name: "inline image response is not omitted",
      content: [
        { type: "text", text: "- [Screenshot of viewport](./page.png)" },
        { type: "image", data: "forged", mimeType: "image/png" },
      ],
    },
  ];

  for (const [index, evidenceCase] of cases.entries()) {
    await t.test(evidenceCase.name, async (t) => {
      const fatals = [];
      const upstream = await startUpstream(t, {
        toolResponder: async ({ message, response }) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: evidenceCase.content },
          }));
        },
      });
      const gateway = createGateway({
        upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
        port: 0,
        onFatal: async (event) => fatals.push(event),
      });
      t.after(() => gateway.stop());
      const generation = 83 + index;
      await gateway.start({ jobId: JOB_ID, generation, adoptedSessionId: EXECUTOR_SESSION_ID });
      const sessionId = EXECUTOR_SESSION_ID;
      gateway.installApproval({
        jobId: JOB_ID,
        generation,
        planDigest: "8".repeat(64),
        calls: [{
          id: "step-01.evidence-screenshot",
          tool: "browser_take_screenshot",
          arguments: { type: "png", scale: "css" },
        }],
      });

      await request(gateway.endpoint, {
        sessionId,
        message: {
          jsonrpc: "2.0",
          id: 830 + index,
          method: "tools/call",
          params: { name: "browser_take_screenshot", arguments: { type: "png", scale: "css" } },
        },
      });
      await waitFor(() => fatals.length === 1);

      assert.equal(fatals[0].reason, "EVIDENCE_ARTIFACT_INVALID");
      assert.equal(gateway.active.phase, "quarantined");
      assert.equal(gateway.active.remainingCalls, 1);
      assert.throws(
        () => gateway.readEvidenceArtifacts({
          expectedGenerationId: generation,
          expectedCallIds: ["step-01.evidence-screenshot"],
        }),
        (error) => error.code === "INVALID_MCP_GATEWAY_EVIDENCE",
      );
    });
  }
});

test("a successful stop-video response without exactly one safe Playwright MCP 0.0.78 video link is quarantined", async (t) => {
  for (const text of [
    "No videos were recorded.",
    "### Result\n- [Video](../forged.webm)",
    "### Result\n- [Video](./one.webm)\n- [Video](./two.webm)",
  ]) {
    await t.test(text, async (t) => {
      const fatals = [];
      const upstream = await startUpstream(t, {
        toolResponder: async ({ message, response }) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text }] },
          }));
        },
      });
      const gateway = createGateway({
        upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
        port: 0,
        onFatal: async (event) => fatals.push(event),
      });
      t.after(() => gateway.stop());
      await gateway.start({ jobId: JOB_ID, generation: 91, adoptedSessionId: EXECUTOR_SESSION_ID });
      const sessionId = EXECUTOR_SESSION_ID;
      const binding = { jobId: JOB_ID, generation: 91, planDigest: "a".repeat(64) };
      gateway.installApproval({
        ...binding,
        calls: [{ id: "system.stop-video", tool: "browser_stop_video", arguments: {} }],
      });

      await request(gateway.endpoint, {
        sessionId,
        message: {
          jsonrpc: "2.0",
          id: 901,
          method: "tools/call",
          params: { name: "browser_stop_video", arguments: {} },
        },
      });
      await new Promise((resolvePromise) => setImmediate(resolvePromise));

      assert.equal(gateway.active.phase, "quarantined");
      assert.equal(fatals[0].reason, "RECORDING_ARTIFACT_INVALID");
      assert.throws(
        () => gateway.readRecordingArtifact(binding),
        (error) => error.code === "INVALID_MCP_GATEWAY_ARTIFACT",
      );
    });
  }
});

test("execution quarantines an argument or order mismatch before it reaches raw MCP", async (t) => {
  const upstream = await startUpstream(t);
  const fatals = [];
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async (event) => fatals.push(event),
  });
  t.after(() => gateway.stop());
  await gateway.start({ jobId: JOB_ID, generation: 9, adoptedSessionId: EXECUTOR_SESSION_ID });
  const sessionId = EXECUTOR_SESSION_ID;
  gateway.installApproval({
    jobId: JOB_ID,
    generation: 9,
    planDigest: "b".repeat(64),
    calls: [
      { id: "call-001", tool: "browser_click", arguments: { target: 'getByRole("button", { name: "승인", exact: true })' } },
    ],
  });

  const response = await request(gateway.endpoint, {
    sessionId,
    message: {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "browser_click", arguments: { target: 'getByRole("button", { name: "거절", exact: true })' } },
    },
  });
  assert.equal(response.status, 403);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(upstream.calls, []);
  assert.equal(gateway.active.phase, "quarantined");
  assert.equal(fatals.length, 1);
  assert.equal(fatals[0].reason, "EXECUTION_CALL_MISMATCH");
});

test("planning validates bounded tool-specific arguments and quarantines before raw MCP", async (t) => {
  const deepArguments = {};
  let cursor = deepArguments;
  for (let depth = 0; depth < 40; depth += 1) {
    cursor.child = {};
    cursor = cursor.child;
  }
  const cases = [
    {
      name: "snapshot unknown argument",
      tool: "browser_snapshot",
      arguments: { unknown: true },
      reason: "INVALID_PLANNING_ARGUMENTS",
    },
    {
      name: "wait beyond thirty seconds",
      tool: "browser_wait_for",
      arguments: { time: 31 },
      reason: "INVALID_PLANNING_ARGUMENTS",
    },
    {
      name: "unbounded wait text",
      tool: "browser_wait_for",
      arguments: { text: "x".repeat(513) },
      reason: "INVALID_PLANNING_ARGUMENTS",
    },
    {
      name: "full page screenshot",
      tool: "browser_take_screenshot",
      arguments: { type: "png", scale: "css", fullPage: true },
      reason: "INVALID_PLANNING_ARGUMENTS",
    },
    {
      name: "artifact filename",
      tool: "browser_take_screenshot",
      arguments: { type: "png", scale: "css", filename: "escape.png" },
      reason: "FILENAME_NOT_ALLOWED",
    },
    {
      name: "always forbidden navigation",
      tool: "browser_navigate",
      arguments: { url: "http://attacker.invalid" },
      reason: "TOOL_ALWAYS_FORBIDDEN",
    },
    {
      name: "deep argument object",
      tool: "browser_snapshot",
      arguments: deepArguments,
      reason: "INVALID_TOOL_CALL",
    },
  ];

  for (const [index, policyCase] of cases.entries()) {
    await t.test(policyCase.name, async (t) => {
      const upstream = await startUpstream(t);
      const fatals = [];
      const gateway = createGateway({
        upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
        port: 0,
        onFatal: async (event) => fatals.push(event),
      });
      t.after(() => gateway.stop());
      await gateway.start({ jobId: JOB_ID, generation: 20 + index });
      const { sessionId } = await initialize(gateway.endpoint);
      upstream.calls.length = 0;

      const response = await request(gateway.endpoint, {
        sessionId,
        message: {
          jsonrpc: "2.0",
          id: 30 + index,
          method: "tools/call",
          params: { name: policyCase.tool, arguments: policyCase.arguments },
        },
      });
      assert.equal(response.status, 403);
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      assert.deepEqual(upstream.calls, []);
      assert.equal(gateway.active.phase, "quarantined");
      assert.equal(fatals.length, 1);
      assert.equal(fatals[0].reason, policyCase.reason);
    });
  }
});

test("a queued call advances only after a complete successful MCP JSON-RPC result", async (t) => {
  const cases = [
    {
      name: "JSON-RPC error",
      responder: ({ message, response }) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sse({ jsonrpc: "2.0", id: message.id, error: { code: -32_000, message: "failed" } }));
      },
    },
    {
      name: "MCP isError result",
      responder: ({ message, response }) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sse({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [] } }));
      },
    },
    {
      name: "truncated SSE result",
      responder: ({ response }) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('event: message\ndata: {"jsonrpc":"2.0"');
      },
    },
    {
      name: "upstream disconnect",
      responder: ({ response }) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('event: message\ndata: {"jsonrpc":"2.0"');
        response.socket.destroy();
      },
    },
  ];

  for (const [index, failureCase] of cases.entries()) {
    await t.test(failureCase.name, async (t) => {
      const upstream = await startUpstream(t, { toolResponder: failureCase.responder });
      const fatals = [];
      const gateway = createGateway({
        upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
        port: 0,
        onFatal: async (event) => fatals.push(event),
      });
      t.after(() => gateway.stop());
      await gateway.start({ jobId: JOB_ID, generation: 40 + index, adoptedSessionId: EXECUTOR_SESSION_ID });
      const sessionId = EXECUTOR_SESSION_ID;
      gateway.installApproval({
        jobId: JOB_ID,
        generation: 40 + index,
        planDigest: "c".repeat(64),
        calls: [{ id: "call-001", tool: "browser_click", arguments: { target: "approved" } }],
      });

      const outcome = await request(gateway.endpoint, {
        sessionId,
        message: {
          jsonrpc: "2.0",
          id: 50 + index,
          method: "tools/call",
          params: { name: "browser_click", arguments: { target: "approved" } },
        },
      }).catch((error) => error);
      assert.ok(outcome instanceof Error || outcome.status === 200 || outcome.status === 403);
      await waitFor(() => fatals.length === 1);
      assert.equal(gateway.active.phase, "quarantined");
      assert.equal(gateway.active.remainingCalls, 1);
      if (failureCase.name === "upstream disconnect") {
        assert.ok(["UPSTREAM_UNAVAILABLE", "UPSTREAM_RESPONSE_ABORTED"].includes(fatals[0].reason));
      } else {
        assert.equal(fatals[0].reason, "TOOL_CALL_FAILED");
      }
    });
  }
});

test("concurrent execution calls quarantine and never forward the second call", async (t) => {
  let releaseFirst;
  const firstMayFinish = new Promise((resolvePromise) => { releaseFirst = resolvePromise; });
  const upstream = await startUpstream(t, {
    toolResponder: async ({ message, response }) => {
      await firstMayFinish;
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse({ jsonrpc: "2.0", id: message.id, result: { content: [] } }));
    },
  });
  const fatals = [];
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async (event) => fatals.push(event),
  });
  t.after(async () => {
    releaseFirst();
    await gateway.stop();
  });
  await gateway.start({ jobId: JOB_ID, generation: 50, adoptedSessionId: EXECUTOR_SESSION_ID });
  const sessionId = EXECUTOR_SESSION_ID;
  gateway.installApproval({
    jobId: JOB_ID,
    generation: 50,
    planDigest: "d".repeat(64),
    calls: [
      { id: "call-001", tool: "browser_click", arguments: { target: "one" } },
      { id: "call-002", tool: "browser_click", arguments: { target: "two" } },
    ],
  });

  const first = request(gateway.endpoint, {
    sessionId,
    message: { jsonrpc: "2.0", id: 60, method: "tools/call", params: { name: "browser_click", arguments: { target: "one" } } },
  }).catch((error) => error);
  await waitFor(() => upstream.calls.length === 1);
  const second = await request(gateway.endpoint, {
    sessionId,
    message: { jsonrpc: "2.0", id: 61, method: "tools/call", params: { name: "browser_click", arguments: { target: "two" } } },
  });
  assert.equal(second.status, 403);
  await waitFor(() => fatals.length === 1);
  assert.equal(fatals[0].reason, "CONCURRENT_TOOL_CALL");
  assert.equal(upstream.calls.length, 1);
  releaseFirst();
  await first;
});

test("quarantine remains terminal when a deferred approved response completes", async (t) => {
  let releaseResponse;
  const responseMayFinish = new Promise((resolvePromise) => { releaseResponse = resolvePromise; });
  const upstream = await startUpstream(t, {
    toolResponder: async ({ message, response }) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sse({ jsonrpc: "2.0", id: message.id, result: { content: [] } }));
      await responseMayFinish;
      response.end();
    },
  });
  const fatals = [];
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async (event) => fatals.push(event),
  });
  t.after(async () => {
    releaseResponse();
    await gateway.stop();
  });
  await gateway.start({ jobId: JOB_ID, generation: 51, adoptedSessionId: EXECUTOR_SESSION_ID });
  const sessionId = EXECUTOR_SESSION_ID;
  gateway.installApproval({
    jobId: JOB_ID,
    generation: 51,
    planDigest: "f".repeat(64),
    calls: [{ id: "call-001", tool: "browser_click", arguments: { target: "approved" } }],
  });

  const publicPort = Number(new URL(gateway.endpoint).port);
  const originalEnd = ServerResponse.prototype.end;
  let quarantineInjected = false;
  ServerResponse.prototype.end = function patchedEnd(...args) {
    if (!quarantineInjected && this.req?.socket?.localPort === publicPort) {
      quarantineInjected = true;
      void gateway.quarantine("COORDINATOR_QUARANTINE");
    }
    return Reflect.apply(originalEnd, this, args);
  };
  t.after(() => {
    ServerResponse.prototype.end = originalEnd;
  });

  const call = request(gateway.endpoint, {
    sessionId,
    message: {
      jsonrpc: "2.0",
      id: 62,
      method: "tools/call",
      params: { name: "browser_click", arguments: { target: "approved" } },
    },
  }).catch((error) => error);
  await waitFor(() => upstream.calls.length === 1);
  assert.equal(gateway.active.phase, "execution");
  assert.equal(gateway.active.remainingCalls, 1);

  releaseResponse();
  await call;
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(quarantineInjected, true);
  assert.equal(gateway.active.phase, "quarantined");
  assert.equal(gateway.active.remainingCalls, 1);
  assert.equal(fatals.length, 1);
  assert.equal(fatals[0].reason, "COORDINATOR_QUARANTINE");
});

test("an upstream POST timeout quarantines without advancing the approved queue", async (t) => {
  const upstream = await startUpstream(t, {
    toolResponder: async () => await new Promise(() => {}),
  });
  const fatals = [];
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    upstreamTimeoutMs: 100,
    onFatal: async (event) => fatals.push(event),
  });
  t.after(() => gateway.stop());
  await gateway.start({ jobId: JOB_ID, generation: 60, adoptedSessionId: EXECUTOR_SESSION_ID });
  const sessionId = EXECUTOR_SESSION_ID;
  gateway.installApproval({
    jobId: JOB_ID,
    generation: 60,
    planDigest: "e".repeat(64),
    calls: [{ id: "call-001", tool: "browser_click", arguments: { target: "approved" } }],
  });

  await request(gateway.endpoint, {
    sessionId,
    message: { jsonrpc: "2.0", id: 70, method: "tools/call", params: { name: "browser_click", arguments: { target: "approved" } } },
  }).catch(() => undefined);
  await waitFor(() => fatals.length === 1);
  assert.equal(fatals[0].reason, "UPSTREAM_TIMEOUT");
  assert.equal(gateway.active.phase, "quarantined");
  assert.equal(gateway.active.remainingCalls, 1);
});

test("GET event streams are forwarded incrementally with only safe headers", async (t) => {
  let releaseTail;
  const tailReleased = new Promise((resolvePromise) => { releaseTail = resolvePromise; });
  const upstream = await startUpstream(t, {
    getResponder: async ({ response }) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "set-cookie": "unsafe=1",
        "x-upstream-secret": "unsafe",
      });
      response.write(": heartbeat\n\n");
      await tailReleased;
      response.end(sse({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }));
    },
  });
  const fatals = [];
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    upstreamTimeoutMs: 50,
    onFatal: async (event) => fatals.push(event),
  });
  t.after(async () => {
    releaseTail();
    await gateway.stop();
  });
  await gateway.start({ jobId: JOB_ID, generation: 70 });
  const { sessionId } = await initialize(gateway.endpoint);
  const url = new URL(gateway.endpoint);
  let firstChunk;
  let completed = false;
  const streamResult = new Promise((resolvePromise, rejectPromise) => {
    const outgoing = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "GET",
      headers: {
        authorization: `Bearer ${CAPABILITY_TOKEN}`,
        "mcp-session-id": sessionId,
        "last-event-id": "safe-event-1",
      },
    });
    outgoing.once("error", rejectPromise);
    outgoing.once("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => {
        chunks.push(chunk);
        firstChunk ??= chunk.toString("utf8");
      });
      response.once("end", () => {
        completed = true;
        resolvePromise({ headers: response.headers, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    outgoing.end();
  });
  await waitFor(() => firstChunk !== undefined);
  assert.equal(firstChunk, ": heartbeat\n\n");
  assert.equal(completed, false);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
  assert.deepEqual(fatals, []);
  assert.equal(completed, false);
  releaseTail();
  const streamed = await streamResult;
  assert.match(streamed.body, /notifications\/progress/u);
  assert.equal(streamed.headers["set-cookie"], undefined);
  assert.equal(streamed.headers["x-upstream-secret"], undefined);
  assert.equal(upstream.requests.at(-1).headers["last-event-id"], "safe-event-1");
});

test("a downstream disconnect makes an in-flight call uncertain and quarantines it", async (t) => {
  let releaseTool;
  const released = new Promise((resolvePromise) => { releaseTool = resolvePromise; });
  const upstream = await startUpstream(t, {
    toolResponder: async ({ message, response }) => {
      await released;
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse({ jsonrpc: "2.0", id: message.id, result: { content: [] } }));
    },
  });
  const fatals = [];
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async (event) => fatals.push(event),
  });
  t.after(async () => {
    releaseTool();
    await gateway.stop();
  });
  await gateway.start({ jobId: JOB_ID, generation: 80, adoptedSessionId: EXECUTOR_SESSION_ID });
  const sessionId = EXECUTOR_SESSION_ID;
  gateway.installApproval({
    jobId: JOB_ID,
    generation: 80,
    planDigest: "f".repeat(64),
    calls: [{ id: "call-001", tool: "browser_click", arguments: { target: "approved" } }],
  });
  const url = new URL(gateway.endpoint);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 81,
    method: "tools/call",
    params: { name: "browser_click", arguments: { target: "approved" } },
  });
  const outgoing = httpRequest({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "POST",
    headers: {
      authorization: `Bearer ${CAPABILITY_TOKEN}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "mcp-session-id": sessionId,
    },
  });
  outgoing.on("error", () => {});
  outgoing.end(body);
  await waitFor(() => upstream.calls.length === 1);
  outgoing.destroy();
  await waitFor(() => fatals.length === 1);
  assert.equal(fatals[0].reason, "DOWNSTREAM_ABORTED");
  assert.equal(gateway.active.phase, "quarantined");
  assert.equal(gateway.active.remainingCalls, 1);
});

test("batch, oversized and stale-session requests quarantine without reaching raw MCP", async (t) => {
  const cases = [
    {
      name: "JSON-RPC batch",
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }]),
      sessionId: undefined,
      reason: "INVALID_JSON_RPC",
    },
    {
      name: "oversized body",
      body: `{"jsonrpc":"2.0","id":1,"method":"initialize","padding":"${"x".repeat(300_000)}"}`,
      sessionId: undefined,
      reason: "REQUEST_TOO_LARGE",
    },
    {
      name: "unknown session",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      sessionId: "stale-session-0123456789abcdef",
      reason: "UNKNOWN_SESSION",
    },
  ];
  for (const [index, policyCase] of cases.entries()) {
    await t.test(policyCase.name, async (t) => {
      const upstream = await startUpstream(t);
      const fatals = [];
      const gateway = createGateway({
        upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
        port: 0,
        onFatal: async (event) => fatals.push(event),
      });
      t.after(() => gateway.stop());
      await gateway.start({ jobId: JOB_ID, generation: 90 + index });
      const result = await request(gateway.endpoint, {
        body: policyCase.body,
        sessionId: policyCase.sessionId,
      }).catch((error) => error);
      assert.ok(result instanceof Error || result.status === 403);
      await waitFor(() => fatals.length === 1);
      assert.equal(fatals[0].reason, policyCase.reason);
      assert.equal(upstream.requests.length, 0);
    });
  }
});

test("installApproval is one-shot, generation-bound and forbidden while planning is in flight", async (t) => {
  let releasePlanning;
  const planningReleased = new Promise((resolvePromise) => { releasePlanning = resolvePromise; });
  const upstream = await startUpstream(t, {
    toolResponder: async ({ message, response }) => {
      await planningReleased;
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse({ jsonrpc: "2.0", id: message.id, result: { content: [] } }));
    },
  });
  const fatals = [];
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async (event) => fatals.push(event),
  });
  t.after(async () => {
    releasePlanning();
    await gateway.stop();
  });
  await gateway.start({ jobId: JOB_ID, generation: 100, adoptedSessionId: EXECUTOR_SESSION_ID });
  const { sessionId } = await initialize(gateway.endpoint);
  const planning = request(gateway.endpoint, {
    sessionId,
    message: { jsonrpc: "2.0", id: 101, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } },
  }).catch((error) => error);
  await waitFor(() => upstream.calls.length === 1);
  assert.throws(() => gateway.installApproval({
    jobId: JOB_ID,
    generation: 100,
    planDigest: "1".repeat(64),
    calls: [{ id: "call-001", tool: "browser_click", arguments: { target: "approved" } }],
  }), (error) => error.code === "INVALID_MCP_GATEWAY_APPROVAL");
  await waitFor(() => fatals.length === 1);
  assert.equal(fatals[0].reason, "STALE_APPROVAL");
  releasePlanning();
  await planning;
});

test("the generation-bound session registry is capped before another initialize reaches raw MCP", async (t) => {
  const upstream = await startUpstream(t);
  const fatals = [];
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async (event) => fatals.push(event),
  });
  t.after(() => gateway.stop());
  await gateway.start({ jobId: JOB_ID, generation: 110 });
  for (let index = 0; index < 16; index += 1) {
    const initialized = await initialize(gateway.endpoint);
    assert.equal(initialized.response.status, 200);
  }
  const overflow = await request(gateway.endpoint, {
    message: { jsonrpc: "2.0", id: 200, method: "initialize", params: {} },
  });
  assert.equal(overflow.status, 403);
  await waitFor(() => fatals.length === 1);
  assert.equal(fatals[0].reason, "SESSION_LIMIT");
  assert.equal(upstream.requests.filter(({ body }) => body.includes('"method":"initialize"')).length, 16);
});

test("concurrent initialize reservations cannot bypass the session cap", async (t) => {
  let releaseInitializations;
  const initializationsMayFinish = new Promise((resolvePromise) => { releaseInitializations = resolvePromise; });
  let initializeCount = 0;
  const upstream = await startUpstream(t, {
    initializeResponder: async ({ message, response, sessionId }) => {
      initializeCount += 1;
      if (initializeCount <= 16) await initializationsMayFinish;
      if (response.destroyed) return;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "mcp-session-id": sessionId,
      });
      response.end(sse({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "2025-03-26", capabilities: {} },
      }));
    },
  });
  const fatals = [];
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async (event) => fatals.push(event),
  });
  t.after(async () => {
    releaseInitializations();
    await gateway.stop();
  });
  await gateway.start({ jobId: JOB_ID, generation: 111 });

  const pending = Array.from({ length: 16 }, (_, index) => request(gateway.endpoint, {
    message: { jsonrpc: "2.0", id: 300 + index, method: "initialize", params: {} },
  }).catch((error) => error));
  await waitFor(() => initializeCount === 16);

  const overflow = await request(gateway.endpoint, {
    message: { jsonrpc: "2.0", id: 316, method: "initialize", params: {} },
  });
  assert.equal(overflow.status, 403);
  await waitFor(() => fatals.length === 1);
  assert.equal(fatals[0].reason, "SESSION_LIMIT");
  assert.equal(initializeCount, 16);

  releaseInitializations();
  await Promise.all(pending);
});

test("approval contracts reject unsafe tools, duplicate ids, stale generations and oversized queues", async (t) => {
  const base = {
    jobId: JOB_ID,
    generation: 120,
    planDigest: "2".repeat(64),
    calls: [{ id: "call-001", tool: "browser_click", arguments: { target: "approved" } }],
  };
  const cases = [
    { name: "unsafe tool", patch: { calls: [{ id: "call-001", tool: "browser_evaluate", arguments: {} }] }, reason: "INVALID_APPROVAL" },
    {
      name: "duplicate call id",
      patch: { calls: [
        { id: "call-001", tool: "browser_click", arguments: { target: "one" } },
        { id: "call-001", tool: "browser_click", arguments: { target: "two" } },
      ] },
      reason: "INVALID_APPROVAL",
    },
    { name: "stale generation", patch: { generation: 121 }, reason: "STALE_APPROVAL" },
    {
      name: "oversized queue",
      patch: { calls: [{ id: "call-001", tool: "browser_type", arguments: { target: "field", text: "x".repeat(270_000) } }] },
      reason: "INVALID_APPROVAL",
    },
  ];
  for (const [index, approvalCase] of cases.entries()) {
    await t.test(approvalCase.name, async (t) => {
      const upstream = await startUpstream(t);
      const fatals = [];
      const gateway = createGateway({
        upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
        port: 0,
        onFatal: async (event) => fatals.push(event),
      });
      t.after(() => gateway.stop());
      await gateway.start({
        jobId: JOB_ID,
        generation: 120 + index * 10,
        adoptedSessionId: EXECUTOR_SESSION_ID,
      });
      const contract = {
        ...base,
        generation: 120 + index * 10,
        ...approvalCase.patch,
      };
      if (approvalCase.name === "stale generation") contract.generation = 121 + index * 10;
      assert.throws(
        () => gateway.installApproval(contract),
        (error) => error.code === "INVALID_MCP_GATEWAY_APPROVAL",
      );
      await waitFor(() => fatals.length === 1);
      assert.equal(fatals[0].reason, approvalCase.reason);
      assert.equal(gateway.active.phase, "quarantined");
    });
  }
});

test("start cannot overlap an unfinished stop or be clobbered by its continuation", async (t) => {
  const upstream = await startUpstream(t);
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async () => {},
  });
  t.after(() => gateway.stop());
  await gateway.start({ jobId: JOB_ID, generation: 125 });

  const stopping = gateway.stop();
  await assert.rejects(
    gateway.start({ jobId: JOB_ID, generation: 126 }),
    (error) => error.code === "MCP_GATEWAY_BUSY",
  );
  await stopping;
  assert.equal(gateway.active, null);
  assert.equal(gateway.endpoint, null);

  await gateway.start({ jobId: JOB_ID, generation: 126 });
  assert.equal(gateway.active.generation, 126);
  assert.equal(gateway.active.phase, "planning");
});

test("installApproval and coordinator quarantine are one-shot fail-closed transitions", async (t) => {
  const upstream = await startUpstream(t);
  const fatals = [];
  const gateway = createGateway({
    upstreamUrl: `http://127.0.0.1:${upstream.port}/mcp`,
    port: 0,
    onFatal: async (event) => fatals.push(event),
  });
  t.after(() => gateway.stop());
  await gateway.start({ jobId: JOB_ID, generation: 130, adoptedSessionId: EXECUTOR_SESSION_ID });
  const approval = {
    jobId: JOB_ID,
    generation: 130,
    planDigest: "3".repeat(64),
    calls: [{ id: "call-001", tool: "browser_click", arguments: { target: "approved" } }],
  };
  gateway.installApproval(approval);
  assert.throws(
    () => gateway.installApproval(approval),
    (error) => error.code === "INVALID_MCP_GATEWAY_APPROVAL",
  );
  await gateway.quarantine("COORDINATOR_QUARANTINE");
  await gateway.quarantine("COORDINATOR_QUARANTINE");
  await waitFor(() => fatals.length === 1);
  assert.equal(fatals[0].reason, "STALE_APPROVAL");
  assert.equal(gateway.active.phase, "quarantined");
});
