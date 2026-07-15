import path from "node:path";

import { OpenCodeEventParser } from "./opencode-events.js";
import { runProcess } from "../process/process-runner.js";
import { createRedactor } from "../security/redactor.js";

const OPTION_KEYS = new Set([
  "opencodePath",
  "baseUrl",
  "studioRoot",
  "agent",
  "sessionId",
  "prompt",
  "env",
  "signal",
  "timeoutMs",
  "redactor",
  "onEvent",
  "processRunner",
  "validateServerContract",
]);
const AGENTS = new Set(["manual-video-planner", "manual-video-executor"]);
const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,252}$/u;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_WINDOWS_COMMAND_UNITS = 24_000;
const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
const AGENT_FALLBACK = /(?:agent\b.*\bnot found|fall(?:ing)? back\b.*\b(?:default|agent)|using\b.*\bdefault agent)/iu;
const STRIPPED_ENVIRONMENT = /^(?:PLAYWRIGHT_MCP_|MCP_REDACT_|MANUAL_STUDIO_(?:LOGIN_|MCP_TOKEN$)|LOGIN_(?:USERNAME|PASSWORD|ORIGIN|.*SELECTOR))/iu;
const ATTACH_ENVIRONMENT = new Set([
  "APPDATA",
  "COMSPEC",
  "HOME",
  "LOCALAPPDATA",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_TEST_HOME",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
]);
const SERVER_ENVIRONMENT = new Set([
  "COMSPEC",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "WINDIR",
]);
const AGENT_TOOLS = Object.freeze({
  "manual-video-planner": new Set([
    "playwright_browser_snapshot",
    "playwright_browser_wait_for",
    "playwright_browser_take_screenshot",
  ]),
  "manual-video-executor": new Set([
    "playwright_browser_snapshot",
    "playwright_browser_click",
    "playwright_browser_type",
    "playwright_browser_fill_form",
    "playwright_browser_press_key",
    "playwright_browser_wait_for",
    "playwright_browser_take_screenshot",
    "playwright_browser_start_video",
    "playwright_browser_stop_video",
    "playwright_browser_video_chapter",
    "playwright_browser_video_show_actions",
    "playwright_browser_video_hide_actions",
  ]),
});

export class OpenCodeClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenCodeClientError";
    this.code = code;
  }

  toJSON() {
    return Object.freeze({ name: this.name, code: this.code, message: this.message });
  }
}

function clientError(code, message) {
  return new OpenCodeClientError(code, message);
}

function isPlain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataValue(record, key, required = false) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) {
    if (required) throw new Error("missing");
    return undefined;
  }
  if (!("value" in descriptor) || !descriptor.enumerable) {
    throw new Error("unsafe");
  }
  return descriptor.value;
}

function sanitizeEnvironment(environment, allowlist) {
  if (environment === process.env) {
    environment = { ...process.env };
  }
  if (!isPlain(environment)) {
    throw clientError("INVALID_OPENCODE_OPTIONS", "The OpenCode options are invalid.");
  }
  const output = Object.create(null);
  const seen = new Set();
  for (const key of Reflect.ownKeys(environment)) {
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.includes("=") ||
      key.includes("\0") ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype"
    ) {
      throw clientError("INVALID_OPENCODE_OPTIONS", "The OpenCode options are invalid.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "string" ||
      descriptor.value.includes("\0")
    ) {
      throw clientError("INVALID_OPENCODE_OPTIONS", "The OpenCode options are invalid.");
    }
    const normalized = key.toUpperCase();
    if (seen.has(normalized)) {
      throw clientError("INVALID_OPENCODE_OPTIONS", "The OpenCode options are invalid.");
    }
    seen.add(normalized);
    if (!STRIPPED_ENVIRONMENT.test(key) && allowlist.has(normalized) && normalized !== "NO_PROXY") {
      output[normalized] = descriptor.value;
    }
  }
  output.NO_PROXY = "127.0.0.1,localhost,[::1]";
  output.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  output.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
  output.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  if (process.platform !== "win32") {
    output.no_proxy = output.NO_PROXY;
  }
  return Object.freeze(output);
}

export function sanitizeOpenCodeEnvironment(environment) {
  return sanitizeEnvironment(environment, ATTACH_ENVIRONMENT);
}

export function sanitizeOpenCodeServerEnvironment(environment) {
  return sanitizeEnvironment(environment, SERVER_ENVIRONMENT);
}

function conservativeCommandUnits(command, args) {
  return 2 * command.length + 2 + args.reduce((total, argument) => total + 2 * argument.length + 3, 0);
}

function inspectOptions(options) {
  if (!isPlain(options)) throw new Error("invalid");
  if (Reflect.ownKeys(options).some((key) => typeof key !== "string" || !OPTION_KEYS.has(key))) {
    throw new Error("unknown");
  }
  const opencodePath = dataValue(options, "opencodePath", true);
  const baseUrl = dataValue(options, "baseUrl", true);
  const studioRoot = dataValue(options, "studioRoot", true);
  const agent = dataValue(options, "agent", true);
  const sessionId = dataValue(options, "sessionId");
  const prompt = dataValue(options, "prompt", true);
  const env = sanitizeOpenCodeEnvironment(dataValue(options, "env", true));
  const signal = dataValue(options, "signal");
  const timeoutMs = dataValue(options, "timeoutMs") ?? 30 * 60 * 1000;
  const redactor = dataValue(options, "redactor") ?? createRedactor();
  const onEvent = dataValue(options, "onEvent");
  const processRunner = dataValue(options, "processRunner") ?? runProcess;
  const validateServerContract = dataValue(options, "validateServerContract", true);

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("url");
  }
  if (
    typeof opencodePath !== "string" ||
    !path.isAbsolute(opencodePath) ||
    path.extname(opencodePath).toLowerCase() !== ".exe" ||
    typeof studioRoot !== "string" ||
    !path.isAbsolute(studioRoot) ||
    typeof agent !== "string" ||
    !AGENTS.has(agent) ||
    (sessionId !== undefined &&
      (typeof sessionId !== "string" || !SESSION_ID.test(sessionId))) ||
    typeof prompt !== "string" ||
    prompt.length === 0 ||
    prompt.includes("\0") ||
    Buffer.byteLength(prompt) > MAX_PROMPT_BYTES ||
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !parsed.port ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    (signal !== undefined &&
      (typeof signal !== "object" || Object.getPrototypeOf(signal) !== AbortSignal.prototype)) ||
    !isPlain(redactor) ||
    typeof redactor.text !== "function" ||
    typeof redactor.value !== "function" ||
    (onEvent !== undefined && typeof onEvent !== "function") ||
    typeof processRunner !== "function"
    || typeof validateServerContract !== "function"
  ) {
    throw new Error("invalid value");
  }
  const commandArguments = [
    "run", "--pure", "--format", "json", "--attach", parsed.origin,
    "--dir", studioRoot, "--agent", agent,
    ...(sessionId === undefined ? [] : ["--session", sessionId]),
    "--", prompt,
  ];
  if (conservativeCommandUnits(opencodePath, commandArguments) > MAX_WINDOWS_COMMAND_UNITS) {
    throw new Error("command line too large");
  }
  return Object.freeze({
    opencodePath,
    baseUrl: parsed.origin,
    studioRoot,
    agent,
    sessionId,
    prompt,
    env,
    signal,
    timeoutMs,
    redactor,
    onEvent,
    processRunner,
    validateServerContract,
  });
}

function validateOptions(options) {
  try {
    return inspectOptions(options);
  } catch (error) {
    if (error instanceof OpenCodeClientError) throw error;
    throw clientError("INVALID_OPENCODE_OPTIONS", "The OpenCode options are invalid.");
  }
}

export async function runOpenCode(options) {
  const settings = validateOptions(options);
  const parser = new OpenCodeEventParser({ redactor: settings.redactor });
  const args = Object.freeze([
    "run",
    "--pure",
    "--format",
    "json",
    "--attach",
    settings.baseUrl,
    "--dir",
    settings.studioRoot,
    "--agent",
    settings.agent,
    ...(settings.sessionId === undefined ? [] : ["--session", settings.sessionId]),
    "--",
    settings.prompt,
  ]);
  const diagnostics = [];
  let diagnosticBytes = 0;
  let fallbackWarning = false;

  try {
    const validation = await settings.validateServerContract(Object.freeze({
      agent: settings.agent,
      baseUrl: settings.baseUrl,
      studioRoot: settings.studioRoot,
    }));
    if (!isPlain(validation) || validation.valid !== true) {
      throw new Error("invalid contract");
    }
  } catch {
    throw clientError(
      "OPENCODE_SERVER_CONTRACT_INVALID",
      "The attached OpenCode server contract is invalid.",
    );
  }

  let processResult;
  try {
    processResult = await settings.processRunner({
      command: settings.opencodePath,
      args,
      cwd: settings.studioRoot,
      env: settings.env,
      signal: settings.signal,
      timeoutMs: settings.timeoutMs,
      redactor: settings.redactor,
      onLine: async ({ stream, text }) => {
        if (stream === "stderr") {
          let safe;
          try {
            safe = settings.redactor.text(text);
          } catch {
            throw clientError("OPENCODE_DIAGNOSTIC_FAILED", "The OpenCode diagnostic is invalid.");
          }
          diagnosticBytes += Buffer.byteLength(safe);
          if (diagnosticBytes > MAX_DIAGNOSTIC_BYTES) {
            throw clientError("OPENCODE_DIAGNOSTIC_LIMIT", "The OpenCode diagnostic limit was exceeded.");
          }
          diagnostics.push(safe);
          fallbackWarning ||= AGENT_FALLBACK.test(safe);
          if (settings.onEvent) {
            await settings.onEvent(Object.freeze({ kind: "diagnostic", text: safe }));
          }
          return;
        }
        if (stream !== "stdout") {
          throw clientError("OPENCODE_STREAM_INVALID", "The OpenCode output stream is invalid.");
        }
        const parsed = parser.push(text);
        if (parsed.kind === "event" && settings.sessionId !== undefined) {
          const eventSessionId = dataValue(parsed.event, "sessionID") ??
            dataValue(parsed.event, "sessionId");
          if (eventSessionId !== settings.sessionId) {
            throw clientError(
              "OPENCODE_SESSION_MISMATCH",
              "OpenCode returned a different session.",
            );
          }
        }
        if (parsed.kind === "event" && parsed.event.type === "tool_use") {
          const tool = parsed.event.part?.tool;
          if (typeof tool !== "string" || !AGENT_TOOLS[settings.agent].has(tool)) {
            throw clientError("OPENCODE_TOOL_NOT_ALLOWED", "OpenCode used a tool that is not allowed for this agent.");
          }
        }
        if (parsed.kind === "diagnostic") {
          fallbackWarning ||= AGENT_FALLBACK.test(parsed.text);
        }
        if (settings.onEvent) {
          await settings.onEvent(parsed);
        }
      },
    });
  } catch (error) {
    if (error instanceof OpenCodeClientError) throw error;
    if (error?.code?.startsWith?.("OPENCODE_")) throw error;
    throw clientError("OPENCODE_PROCESS_FAILED", "The OpenCode process failed.");
  }
  const report = parser.finish();
  if (processResult?.exitCode !== 0 || processResult?.signal !== null) {
    throw clientError("OPENCODE_EXIT_FAILED", "OpenCode did not exit cleanly.");
  }
  if (report.hadError) {
    throw clientError("OPENCODE_REPORTED_ERROR", "OpenCode reported an error.");
  }
  if (fallbackWarning) {
    throw clientError("OPENCODE_AGENT_FALLBACK", "OpenCode attempted to use a fallback agent.");
  }
  if (!report.completed || !report.sessionId) {
    throw clientError("OPENCODE_INCOMPLETE", "OpenCode did not complete its session.");
  }
  if (settings.sessionId !== undefined && report.sessionId !== settings.sessionId) {
    throw clientError(
      "OPENCODE_SESSION_MISMATCH",
      "OpenCode returned a different session.",
    );
  }
  return Object.freeze({
    ...report,
    diagnostics: Object.freeze([...report.diagnostics, ...diagnostics]),
  });
}
