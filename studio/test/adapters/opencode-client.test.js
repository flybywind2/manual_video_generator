import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  OpenCodeEventError,
  parseOpenCodeLines,
} from "../../src/adapters/opencode-events.js";
import { runOpenCode } from "../../src/adapters/opencode-client.js";
import { createRedactor } from "../../src/security/redactor.js";

const sessionID = "ses_0123456789";

function event(type, part = undefined, extra = {}) {
  const partTypes = {
    step_start: "step-start",
    text: "text",
    tool_use: "tool",
    reasoning: "reasoning",
    step_finish: "step-finish",
  };
  const normalizedPart = type === "error" && part === undefined
    ? undefined
    : {
        id: `part-${type}`,
        messageID: "msg-1",
        sessionID,
        type: partTypes[type],
        ...(part ?? {}),
      };
  return JSON.stringify({
    type,
    timestamp: 1_752_400_000_000,
    sessionID,
    ...(normalizedPart === undefined ? {} : { part: normalizedPart }),
    ...extra,
  });
}

function successfulLines() {
  return [
    event("step_start", { type: "step-start", id: "part-1" }),
    event("reasoning", { type: "reasoning", text: "bounded thought" }),
    event("tool_use", {
      type: "tool",
      callID: "call-1",
      tool: "playwright_browser_snapshot",
      state: { status: "completed", input: { depth: 2 }, output: "snapshot" },
    }),
    event("step_finish", { type: "step-finish", reason: "stop" }),
    event("step_start", { type: "step-start", id: "part-2" }),
    event("text", { type: "text", text: '{"schemaVersion":1,"steps":[]}' }),
    event("step_finish", { type: "step-finish", reason: "stop" }),
  ];
}

test("parseOpenCodeLines enforces the version-independent synthetic event contract", () => {
  const report = parseOpenCodeLines([
    ...successfulLines(),
    "OpenCode diagnostic without JSON",
  ]);

  assert.equal(report.sessionId, sessionID);
  assert.equal(report.finalText, '{"schemaVersion":1,"steps":[]}');
  assert.equal(report.completed, true);
  assert.equal(report.hadError, false);
  assert.deepEqual(report.toolEvents, [
    {
      callId: "call-1",
      tool: "playwright_browser_snapshot",
      status: "completed",
      input: { depth: 2 },
      output: "snapshot",
    },
  ]);
  assert.deepEqual(report.diagnostics, ["OpenCode diagnostic without JSON"]);
  assert.equal(Object.isFrozen(report), true);
});

test("parseOpenCodeLines rejects unknown JSON event envelopes", () => {
  assert.throws(
    () => parseOpenCodeLines([event("future_event", { type: "future", value: 1 })]),
    (error) => error.code === "OPENCODE_EVENT_UNKNOWN",
  );
});

test("parseOpenCodeLines redacts diagnostics and event content before retaining it", () => {
  const secret = "opencode-event-secret";
  const report = parseOpenCodeLines(
    [
      `diagnostic ${secret}`,
      event("step_start", { type: "step-start" }),
      event("text", { type: "text", text: `answer ${secret}` }),
      event("step_finish", { type: "step-finish" }),
    ],
    { redactor: createRedactor({ secrets: [secret], sensitiveKeys: ["password"] }) },
  );
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(report.finalText, "answer [REDACTED]");
});

test("parseOpenCodeLines fails closed on malformed JSON-looking, oversized, or mixed-session input", () => {
  assert.throws(
    () => parseOpenCodeLines(["{not-json"]),
    (error) => error instanceof OpenCodeEventError && error.code === "OPENCODE_EVENT_MALFORMED",
  );
  assert.throws(
    () => parseOpenCodeLines([`diagnostic ${"x".repeat(300_000)}`]),
    (error) => error.code === "OPENCODE_EVENT_LIMIT",
  );
  assert.throws(
    () =>
      parseOpenCodeLines([
        event("step_start", { type: "step-start" }),
        JSON.stringify({ type: "text", sessionID: "ses_other", part: { text: "x" } }),
      ]),
    (error) => error.code === "OPENCODE_SESSION_MISMATCH",
  );
  assert.throws(
    () =>
      parseOpenCodeLines([
        event("step_start", { type: "step-start", sessionID: "ses_other" }),
      ]),
    (error) => error.code === "OPENCODE_SESSION_MISMATCH",
  );
});

test("parseOpenCodeLines only accepts a nonempty text-only terminal iteration", () => {
  for (const lines of [
    [event("step_start"), event("tool_use", { type: "tool", callID: "call-terminal-1", tool: "playwright_browser_snapshot", state: { status: "completed", input: {} } }), event("step_finish")],
    [event("step_start"), event("text", { type: "text", text: "" }), event("step_finish")],
    [event("step_start"), event("text", { type: "text", text: "unfinished" })],
    [event("step_start"), event("text", { type: "text", text: "mixed" }), event("tool_use", { type: "tool", callID: "call-terminal-2", tool: "playwright_browser_click", state: { status: "completed", input: {} } }), event("step_finish")],
  ]) {
    const report = parseOpenCodeLines(lines);
    assert.equal(report.completed, false);
    assert.equal(report.finalText, "");
  }

  const report = parseOpenCodeLines([
    event("step_start"),
    event("text", { type: "text", text: "intermediate text" }),
    event("tool_use", { type: "tool", callID: "call-terminal-3", tool: "playwright_browser_click", state: { status: "completed", input: {} } }),
    event("step_finish"),
    event("step_start"),
    event("text", { type: "text", text: "terminal text" }),
    event("step_finish"),
  ]);
  assert.equal(report.completed, true);
  assert.equal(report.finalText, "terminal text");
});

test("parseOpenCodeLines upserts duplicate complete text parts and rejects multiple terminal parts", () => {
  const updated = parseOpenCodeLines([
    event("step_start"),
    event("text", { id: "text-1", type: "text", text: "stale" }),
    event("text", { id: "text-1", type: "text", text: "terminal" }),
    event("step_finish"),
  ]);
  assert.equal(updated.completed, true);
  assert.equal(updated.finalText, "terminal");

  const ambiguous = parseOpenCodeLines([
    event("step_start"),
    event("text", { id: "text-1", type: "text", text: '{"a":1}' }),
    event("text", { id: "text-2", type: "text", text: '{"b":2}' }),
    event("step_finish"),
  ]);
  assert.equal(ambiguous.completed, false);
  assert.equal(ambiguous.finalText, "");
});

test("parseOpenCodeLines rejects model-chosen evidence filenames for every write-capable tool", () => {
  for (const tool of [
    "playwright_browser_snapshot",
    "playwright_browser_take_screenshot",
    "playwright_browser_start_video",
  ]) {
    assert.throws(
      () => parseOpenCodeLines([
        event("step_start"),
        event("tool_use", {
          id: `tool-${tool}`,
          type: "tool",
          callID: `call-${tool}`,
          tool,
          state: {
            status: "completed",
            input: { filename: "../../opencode.json" },
            output: "written",
          },
        }),
        event("step_finish"),
      ]),
      (error) => error.code === "OPENCODE_UNSAFE_TOOL_INPUT",
    );
  }
});

test("parseOpenCodeLines rejects malformed tool envelopes and filename type tricks", () => {
  const invalidParts = [
    { tool: "playwright_browser_snapshot", state: { status: "completed", input: {} } },
    { callID: "call-1", state: { status: "completed", input: {} } },
    { callID: "call-1", tool: "playwright_browser_snapshot", state: { input: {} } },
    { callID: "call-1", tool: "playwright_browser_snapshot", state: { status: "completed" } },
    { callID: "call-1", tool: "playwright_browser_snapshot", state: { status: "completed", input: null } },
    { callID: "call-1", tool: "playwright_browser_snapshot", state: { status: "completed", input: [] } },
  ];
  for (const part of invalidParts) {
    assert.throws(
      () => parseOpenCodeLines([
        event("step_start"),
        event("tool_use", { type: "tool", ...part }),
      ]),
      (error) => error.code === "OPENCODE_EVENT_MALFORMED",
    );
  }
  assert.throws(
    () => parseOpenCodeLines([
      event("step_start"),
      event("tool_use", {
        type: "tool",
        callID: "call-unsafe",
        tool: "playwright_browser_take_screenshot",
        state: {
          status: "completed",
          input: Object.assign(Object.create(null), { filename: null }),
        },
      }),
    ]),
    (error) => error.code === "OPENCODE_UNSAFE_TOOL_INPUT",
  );
});

test("parseOpenCodeLines fails closed on accessor, prototype, and cyclic event values", () => {
  const accessor = {};
  Object.defineProperty(accessor, "type", {
    enumerable: true,
    get() {
      throw new Error("getter secret");
    },
  });
  assert.throws(
    () => parseOpenCodeLines([accessor]),
    (error) => error.code === "OPENCODE_EVENT_MALFORMED" && !String(error).includes("secret"),
  );

  const inherited = Object.create({ type: "text" });
  inherited.sessionID = sessionID;
  assert.throws(
    () => parseOpenCodeLines([inherited]),
    (error) => error.code === "OPENCODE_EVENT_MALFORMED",
  );
});

test("runOpenCode uses only the selected absolute binary and the exact approved argument shape", async () => {
  const studioRoot = path.resolve(".");
  const opencodePath = path.resolve("C:\\tools\\opencode.exe");
  const captured = [];
  const result = await runOpenCode({
    opencodePath,
    baseUrl: "http://127.0.0.1:4096",
    studioRoot,
    agent: "manual-video-planner",
    prompt: "Produce the approved plan JSON.",
    env: {
      Path: process.env.Path ?? "",
      OPENAI_API_KEY: "provider-key-needed-by-opencode",
      MANUAL_STUDIO_LOGIN_USERNAME: "alice",
      MANUAL_STUDIO_LOGIN_PASSWORD: "login-secret",
      PLAYWRIGHT_MCP_SECRETS_FILE: "C:\\private\\secret.env",
      MANUAL_STUDIO_MCP_TOKEN: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
    },
    validateServerContract: async () => ({ valid: true }),
    processRunner: async (options) => {
      captured.push(options);
      for (const line of successfulLines()) {
        await options.onLine({ stream: "stdout", text: line });
      }
      await options.onLine({ stream: "stderr", text: "safe diagnostic" });
      await options.onLine({ stream: "stderr", text: '{"type":"error","sessionID":"spoof"}' });
      return { exitCode: 0, signal: null, stdout: "", stderr: "", lines: [] };
    },
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].command, opencodePath);
  assert.deepEqual(captured[0].args, [
    "run",
    "--pure",
    "--format",
    "json",
    "--attach",
    "http://127.0.0.1:4096",
    "--dir",
    studioRoot,
    "--agent",
    "manual-video-planner",
    "--",
    "Produce the approved plan JSON.",
  ]);
  assert.equal(captured[0].args.includes("--model"), false);
  assert.equal(captured[0].args.includes("--dangerously-skip-permissions"), false);
  assert.equal("OPENAI_API_KEY" in captured[0].env, false);
  assert.equal("MANUAL_STUDIO_LOGIN_USERNAME" in captured[0].env, false);
  assert.equal("MANUAL_STUDIO_LOGIN_PASSWORD" in captured[0].env, false);
  assert.equal("PLAYWRIGHT_MCP_SECRETS_FILE" in captured[0].env, false);
  assert.equal("MANUAL_STUDIO_MCP_TOKEN" in captured[0].env, false);
  assert.equal(result.finalText, '{"schemaVersion":1,"steps":[]}');
  assert.equal(result.sessionId, sessionID);
  assert.deepEqual(result.diagnostics, [
    "safe diagnostic",
    '{"type":"error","sessionID":"spoof"}',
  ]);
});

test("runOpenCode resumes only the requested session with exact option ordering", async () => {
  const studioRoot = path.resolve(".");
  const opencodePath = path.resolve("C:\\tools\\opencode.exe");
  let captured;

  const result = await runOpenCode({
    opencodePath,
    baseUrl: "http://127.0.0.1:4096",
    studioRoot,
    agent: "manual-video-planner",
    prompt: "Repair the rejected plan.",
    sessionId: sessionID,
    env: {},
    validateServerContract: async () => ({ valid: true }),
    processRunner: async (options) => {
      captured = options.args;
      for (const line of successfulLines()) {
        await options.onLine({ stream: "stdout", text: line });
      }
      return { exitCode: 0, signal: null };
    },
  });

  assert.deepEqual(captured, [
    "run",
    "--pure",
    "--format",
    "json",
    "--attach",
    "http://127.0.0.1:4096",
    "--dir",
    studioRoot,
    "--agent",
    "manual-video-planner",
    "--session",
    sessionID,
    "--",
    "Repair the rejected plan.",
  ]);
  assert.equal(result.sessionId, sessionID);
});

test("runOpenCode rejects a continuation that returns a different session", async () => {
  const returnedSession = "ses_abcdefghij";
  let emittedLines = 0;

  await assert.rejects(
    runOpenCode({
      opencodePath: path.resolve("C:\\tools\\opencode.exe"),
      baseUrl: "http://127.0.0.1:4096",
      studioRoot: path.resolve("."),
      agent: "manual-video-planner",
      prompt: "Repair the rejected plan.",
      sessionId: sessionID,
      env: {},
      validateServerContract: async () => ({ valid: true }),
      processRunner: async (options) => {
        for (const line of successfulLines()) {
          emittedLines += 1;
          await options.onLine({
            stream: "stdout",
            text: line.replaceAll(sessionID, returnedSession),
          });
        }
        return { exitCode: 0, signal: null };
      },
    }),
    (error) => error.code === "OPENCODE_SESSION_MISMATCH",
  );
  assert.equal(emittedLines, 1);
});

test("runOpenCode rejects unsafe continuation session identifiers before spawning", async () => {
  const common = {
    opencodePath: path.resolve("C:\\tools\\opencode.exe"),
    baseUrl: "http://127.0.0.1:4096",
    studioRoot: path.resolve("."),
    agent: "manual-video-planner",
    prompt: "plan",
    env: {},
    validateServerContract: async () => ({ valid: true }),
  };
  let invoked = false;

  for (const sessionId of [
    "",
    "session-without-prefix",
    "--agent",
    "ses_contains space",
    "ses_path/escape",
    "ses_null\0suffix",
    `ses_${"a".repeat(253)}`,
    7,
  ]) {
    await assert.rejects(
      runOpenCode({
        ...common,
        sessionId,
        processRunner: async () => { invoked = true; },
      }),
      (error) => error.code === "INVALID_OPENCODE_OPTIONS",
    );
  }
  assert.equal(invoked, false);
});

test("runOpenCode includes continuation options in the conservative command budget", async () => {
  const opencodePath = path.resolve("C:\\tools\\opencode.exe");
  const studioRoot = path.resolve(".");
  const prefix = [
    "run", "--pure", "--format", "json", "--attach", "http://127.0.0.1:4096",
    "--dir", studioRoot, "--agent", "manual-video-planner", "--", "",
  ];
  const units = (command, args) =>
    2 * command.length + 2 + args.reduce(
      (total, argument) => total + 2 * argument.length + 3,
      0,
    );
  const prompt = "p".repeat(Math.floor((24_000 - units(opencodePath, prefix)) / 2));
  let invocations = 0;
  const common = {
    opencodePath,
    baseUrl: "http://127.0.0.1:4096",
    studioRoot,
    agent: "manual-video-planner",
    prompt,
    env: {},
    validateServerContract: async () => ({ valid: true }),
    processRunner: async (options) => {
      invocations += 1;
      for (const line of successfulLines()) {
        await options.onLine({ stream: "stdout", text: line });
      }
      return { exitCode: 0, signal: null };
    },
  };

  await runOpenCode(common);
  await assert.rejects(
    runOpenCode({ ...common, sessionId: sessionID }),
    (error) => error.code === "INVALID_OPENCODE_OPTIONS",
  );
  assert.equal(invocations, 1);
});

test("runOpenCode terminates option parsing before an option-shaped user prompt", async () => {
  for (const prompt of ["--version", "--agent=build", "--dangerously-skip-permissions"]) {
    let captured;
    await runOpenCode({
      opencodePath: path.resolve("C:\\tools\\opencode.exe"),
      baseUrl: "http://127.0.0.1:4096",
      studioRoot: path.resolve("."),
      agent: "manual-video-planner",
      prompt,
      env: {},
      validateServerContract: async () => ({ valid: true }),
      processRunner: async (options) => {
        captured = options.args;
        for (const line of successfulLines()) await options.onLine({ stream: "stdout", text: line });
        return { exitCode: 0, signal: null };
      },
    });
    assert.deepEqual(captured.slice(-2), ["--", prompt]);
    assert.equal(captured.indexOf("--"), captured.length - 2);
  }
});

test("runOpenCode requires clean exit and same-session step_finish and rejects error events", async (t) => {
  const studioRoot = path.resolve(".");
  const common = {
    opencodePath: path.resolve("C:\\tools\\opencode.exe"),
    baseUrl: "http://127.0.0.1:4096",
    studioRoot,
    agent: "manual-video-executor",
    prompt: "Execute the approved digest.",
    env: {},
    validateServerContract: async () => ({ valid: true }),
  };
  const cases = [
    {
      name: "missing completion",
      lines: [
        event("step_start", { type: "step-start" }),
        event("text", { type: "text", text: "partial" }),
      ],
      exitCode: 0,
      code: "OPENCODE_INCOMPLETE",
    },
    {
      name: "nonzero exit",
      lines: successfulLines(),
      exitCode: 7,
      code: "OPENCODE_EXIT_FAILED",
    },
    {
      name: "agent fallback warning",
      lines: successfulLines(),
      stderr: ["Agent manual-video-executor not found; falling back to default agent"],
      exitCode: 0,
      code: "OPENCODE_AGENT_FALLBACK",
    },
    {
      name: "error event on exit zero",
      lines: [
        event("step_start", { type: "step-start" }),
        event("error", undefined, { error: { name: "ProviderError", message: "safe" } }),
        event("step_finish", { type: "step-finish" }),
      ],
      exitCode: 0,
      code: "OPENCODE_REPORTED_ERROR",
    },
  ];

  for (const sample of cases) {
    await t.test(sample.name, async () => {
      await assert.rejects(
        runOpenCode({
          ...common,
          processRunner: async (options) => {
            for (const line of sample.lines) {
              await options.onLine({ stream: "stdout", text: line });
            }
            for (const line of sample.stderr ?? []) {
              await options.onLine({ stream: "stderr", text: line });
            }
            return { exitCode: sample.exitCode, signal: null, stdout: "", stderr: "", lines: [] };
          },
        }),
        (error) => error.code === sample.code,
      );
    });
  }
});

test("runOpenCode rejects unsafe agent, URL, prompt, executable and options without evaluating getters", async () => {
  const root = path.resolve(".");
  const good = {
    opencodePath: path.resolve("C:\\tools\\opencode.exe"),
    baseUrl: "http://127.0.0.1:4096",
    studioRoot: root,
    agent: "manual-video-planner",
    prompt: "plan",
    env: {},
    validateServerContract: async () => ({ valid: true }),
    processRunner: async () => ({ exitCode: 0, signal: null }),
  };
  for (const override of [
    { opencodePath: "opencode.exe" },
    { opencodePath: path.resolve("C:\\tools\\opencode.cmd") },
    { baseUrl: "http://example.com:4096" },
    { agent: "../../unsafe" },
    { prompt: "" },
  ]) {
    await assert.rejects(runOpenCode({ ...good, ...override }), (error) =>
      error.code === "INVALID_OPENCODE_OPTIONS");
  }

  const hostile = Object.create({ get prompt() { throw new Error("getter secret"); } });
  await assert.rejects(
    runOpenCode(hostile),
    (error) => error.code === "INVALID_OPENCODE_OPTIONS" && !String(error).includes("secret"),
  );
});

test("runOpenCode validates the live attached agent before spawning and blocks tool drift", async () => {
  const common = {
    opencodePath: path.resolve("C:\\tools\\opencode.exe"),
    baseUrl: "http://127.0.0.1:4096",
    studioRoot: path.resolve("."),
    agent: "manual-video-planner",
    prompt: "plan",
    env: {},
  };
  let processCalls = 0;
  await assert.rejects(
    runOpenCode({
      ...common,
      validateServerContract: async () => { throw new Error("raw config secret"); },
      processRunner: async () => { processCalls += 1; },
    }),
    (error) => error.code === "OPENCODE_SERVER_CONTRACT_INVALID" && !String(error).includes("secret"),
  );
  assert.equal(processCalls, 0);

  await assert.rejects(
    runOpenCode({
      ...common,
      validateServerContract: async () => ({ valid: true }),
      processRunner: async (options) => {
        for (const line of [
          event("step_start"),
          event("tool_use", {
            type: "tool",
            callID: "call-drift",
            tool: "playwright_browser_click",
            state: { status: "completed", input: { target: "button" }, output: "clicked" },
          }),
          event("step_finish"),
          event("step_start", { id: "final-step" }),
          event("text", { id: "final-text", text: "{}" }),
          event("step_finish", { id: "final-finish" }),
        ]) {
          await options.onLine({ stream: "stdout", text: line });
        }
        return { exitCode: 0, signal: null };
      },
    }),
    (error) => error.code === "OPENCODE_TOOL_NOT_ALLOWED",
  );
});

test("runOpenCode reserves navigation, history, and tab creation for the coordinator", async () => {
  for (const tool of [
    "playwright_browser_navigate",
    "playwright_browser_navigate_back",
    "playwright_browser_tabs",
  ]) {
    await assert.rejects(
      runOpenCode({
        opencodePath: path.resolve("C:\\tools\\opencode.exe"),
        baseUrl: "http://127.0.0.1:4096",
        studioRoot: path.resolve("."),
        agent: "manual-video-executor",
        prompt: "execute",
        env: {},
        validateServerContract: async () => ({ valid: true }),
        processRunner: async (options) => {
          for (const line of [
            event("step_start"),
            event("tool_use", {
              type: "tool",
              callID: `call-${tool}`,
              tool,
              state: { status: "completed", input: {}, output: "blocked" },
            }),
          ]) await options.onLine({ stream: "stdout", text: line });
          return { exitCode: 0, signal: null };
        },
      }),
      (error) => error.code === "OPENCODE_TOOL_NOT_ALLOWED",
    );
  }
});

test("runOpenCode rejects command lines beyond the conservative Windows UTF-16 budget", async () => {
  let invoked = false;
  await assert.rejects(
    runOpenCode({
      opencodePath: path.resolve("C:\\tools\\opencode.exe"),
      baseUrl: "http://127.0.0.1:4096",
      studioRoot: path.resolve("."),
      agent: "manual-video-executor",
      prompt: "가".repeat(20_000),
      env: {},
      validateServerContract: async () => ({ valid: true }),
      processRunner: async () => { invoked = true; },
    }),
    (error) => error.code === "INVALID_OPENCODE_OPTIONS",
  );
  assert.equal(invoked, false);
});
