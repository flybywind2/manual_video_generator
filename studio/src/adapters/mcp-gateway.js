import { createServer, request as httpRequest } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { CLICK_GEOMETRY_FUNCTION } from "../domain/execution-calls.js";

const JOB_ID = /^(?:job-[a-z0-9]{16,64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const SESSION_ID = /^[A-Za-z0-9._~-]{16,256}$/u;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_POST_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PLANNING_CALLS = 128;
const MAX_SESSIONS = 16;
const MAX_PROGRESS_TOKEN_BYTES = 512;
const SAFE_STATUS = new Set([200, 202, 204, 400, 404, 405, 406, 409, 413, 415, 429, 500, 502, 503, 504]);
const PLANNING_TOOLS = new Set([
  "browser_snapshot",
  "browser_wait_for",
  "browser_take_screenshot",
]);
const EXECUTION_TOOLS = new Set([
  "browser_snapshot",
  "browser_click",
  "browser_evaluate",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_wait_for",
  "browser_take_screenshot",
  "browser_start_video",
  "browser_stop_video",
  "browser_video_chapter",
  "browser_video_show_actions",
  "browser_video_hide_actions",
]);
const ALWAYS_FORBIDDEN_TOOLS = new Set([
  "browser_navigate",
  "browser_navigate_back",
  "browser_tabs",
]);
const FORWARDED_REQUEST_HEADERS = Object.freeze([
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
]);
const FORWARDED_RESPONSE_HEADERS = Object.freeze([
  "cache-control",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
]);

function inspectCapabilityToken(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("capability token");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) throw new Error("capability token");
  return value;
}

function hasCapability(request, capabilityToken) {
  const authorizationHeaders = request.rawHeaders.filter(
    (header, index) => index % 2 === 0 && header.toLowerCase() === "authorization",
  );
  if (authorizationHeaders.length !== 1) return false;
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return false;
  const expected = Buffer.from(`Bearer ${capabilityToken}`, "utf8");
  const received = Buffer.from(authorization, "utf8");
  const comparable = Buffer.alloc(expected.length);
  received.copy(comparable, 0, 0, expected.length);
  const equal = timingSafeEqual(comparable, expected);
  return equal && received.length === expected.length;
}

function validProgressMetadata(value) {
  if (!isPlain(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== "progressToken") return false;
  const token = dataValue(value, "progressToken", true);
  if (Number.isSafeInteger(token)) return true;
  return typeof token === "string" &&
    token.length > 0 &&
    !token.includes("\0") &&
    Buffer.byteLength(token, "utf8") <= MAX_PROGRESS_TOKEN_BYTES;
}

export class McpGatewayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "McpGatewayError";
    this.code = code;
  }

  toJSON() {
    return Object.freeze({ name: this.name, code: this.code, message: this.message });
  }
}

class PolicyViolation extends Error {
  constructor(reason, id = null) {
    super(reason);
    this.reason = reason;
    this.id = safeRpcId(id);
  }
}

function gatewayError(code, message) {
  return new McpGatewayError(code, message);
}

function isPlain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataValue(record, key, required = false) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) {
    if (required) throw new Error("missing");
    return undefined;
  }
  if (!("value" in descriptor) || !descriptor.enumerable) throw new Error("unsafe");
  return descriptor.value;
}

function safeRpcId(value) {
  if (value === null || Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && value.length <= 128 && !/[\0\r\n]/u.test(value)) return value;
  return null;
}

function parseUpstreamUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("upstream URL");
  const parsed = new URL(value);
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !parsed.port ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/mcp" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("upstream URL");
  }
  return Object.freeze({ hostname: "127.0.0.1", port, path: "/mcp", href: parsed.href });
}

function inspectConstructor(options) {
  if (!isPlain(options) || Reflect.ownKeys(options).some((key) => !["upstreamUrl", "port", "upstreamTimeoutMs", "capabilityToken", "onFatal"].includes(key))) {
    throw new Error("options");
  }
  const upstream = parseUpstreamUrl(dataValue(options, "upstreamUrl", true));
  const port = dataValue(options, "port") ?? 8931;
  const upstreamTimeoutMs = dataValue(options, "upstreamTimeoutMs") ?? 30_000;
  const capabilityToken = inspectCapabilityToken(dataValue(options, "capabilityToken", true));
  const onFatal = dataValue(options, "onFatal", true);
  if (
    !Number.isSafeInteger(port) ||
    port < 0 ||
    port > 65_535 ||
    !Number.isSafeInteger(upstreamTimeoutMs) ||
    upstreamTimeoutMs < 50 ||
    upstreamTimeoutMs > 120_000 ||
    typeof onFatal !== "function"
  ) {
    throw new Error("options");
  }
  return Object.freeze({ upstream, port, upstreamTimeoutMs, capabilityToken, onFatal });
}

function validateConstructor(options) {
  try {
    return inspectConstructor(options);
  } catch {
    throw gatewayError("INVALID_MCP_GATEWAY_OPTIONS", "The MCP gateway options are invalid.");
  }
}

function inspectStart(value) {
  if (!isPlain(value) || Reflect.ownKeys(value).some((key) => !["jobId", "generation", "adoptedSessionId"].includes(key))) {
    throw new Error("start");
  }
  const jobId = dataValue(value, "jobId", true);
  const generation = dataValue(value, "generation", true);
  const adoptedSessionId = dataValue(value, "adoptedSessionId");
  if (typeof jobId !== "string" || !JOB_ID.test(jobId) || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("start");
  }
  if (adoptedSessionId !== undefined && (typeof adoptedSessionId !== "string" || !SESSION_ID.test(adoptedSessionId))) {
    throw new Error("start");
  }
  return Object.freeze({ jobId, generation, adoptedSessionId });
}

function parseMessage(source) {
  let message;
  try {
    message = JSON.parse(source);
  } catch {
    throw new PolicyViolation("INVALID_JSON_RPC");
  }
  if (!isPlain(message) || dataValue(message, "jsonrpc") !== "2.0") {
    throw new PolicyViolation("INVALID_JSON_RPC", isPlain(message) ? dataValue(message, "id") : null);
  }
  const id = dataValue(message, "id");
  const method = dataValue(message, "method");
  if (method === undefined) {
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (id === undefined || hasResult === hasError) throw new PolicyViolation("INVALID_JSON_RPC", id);
    return Object.freeze({ id, message, method: null, response: true });
  }
  if (typeof method !== "string" || method.length === 0 || method.length > 128 || /[\0\r\n]/u.test(method)) {
    throw new PolicyViolation("INVALID_JSON_RPC", id);
  }
  return Object.freeze({ id, message, method, response: false });
}

function sessionHeader(request) {
  const value = request.headers["mcp-session-id"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SESSION_ID.test(value)) throw new PolicyViolation("INVALID_SESSION");
  const duplicates = request.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === "mcp-session-id");
  if (duplicates.length !== 1) throw new PolicyViolation("INVALID_SESSION");
  return value;
}

function hasFilename(value, depth = 0) {
  if (depth > 32) return true;
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => hasFilename(entry, depth + 1));
  if (!isPlain(value)) return true;
  return Reflect.ownKeys(value).some((key) =>
    typeof key !== "string" || key.toLowerCase() === "filename" || hasFilename(dataValue(value, key, true), depth + 1));
}

function exactArgumentKeys(value, allowed) {
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === "string" && allowed.has(key));
}

function boundedText(value, maximum = 2048) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\0\r\n]/u.test(value);
}

function validPlanningArguments(tool, argumentsValue) {
  if (tool === "browser_snapshot") {
    if (!exactArgumentKeys(argumentsValue, new Set(["target", "depth", "boxes"]))) return false;
    const target = dataValue(argumentsValue, "target");
    const depth = dataValue(argumentsValue, "depth");
    const boxes = dataValue(argumentsValue, "boxes");
    return (
      (target === undefined || boundedText(target)) &&
      (depth === undefined || (Number.isSafeInteger(depth) && depth >= 0 && depth <= 20)) &&
      (boxes === undefined || typeof boxes === "boolean")
    );
  }
  if (tool === "browser_wait_for") {
    if (!exactArgumentKeys(argumentsValue, new Set(["time", "text", "textGone"]))) return false;
    const time = dataValue(argumentsValue, "time");
    const text = dataValue(argumentsValue, "text");
    const textGone = dataValue(argumentsValue, "textGone");
    return (
      Reflect.ownKeys(argumentsValue).length >= 1 &&
      (time === undefined || (typeof time === "number" && Number.isFinite(time) && time >= 0 && time <= 30)) &&
      (text === undefined || boundedText(text, 512)) &&
      (textGone === undefined || boundedText(textGone, 512))
    );
  }
  if (tool === "browser_take_screenshot") {
    if (!exactArgumentKeys(argumentsValue, new Set(["element", "target", "type", "fullPage", "scale"]))) return false;
    const element = dataValue(argumentsValue, "element");
    const target = dataValue(argumentsValue, "target");
    const type = dataValue(argumentsValue, "type");
    const fullPage = dataValue(argumentsValue, "fullPage");
    const scale = dataValue(argumentsValue, "scale");
    return (
      (element === undefined || boundedText(element)) &&
      (target === undefined || boundedText(target)) &&
      (type === "png" || type === "jpeg") &&
      (scale === "css" || scale === "device") &&
      (fullPage === undefined || fullPage === false)
    );
  }
  return false;
}

function cloneJson(value, depth = 0) {
  if (depth > 32) throw new Error("JSON depth");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON number");
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 512) throw new Error("JSON array");
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)))
    ) {
      throw new Error("JSON array");
    }
    return Object.freeze(value.map((entry, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error("JSON array");
      return cloneJson(descriptor.value, depth + 1);
    }));
  }
  if (!isPlain(value)) throw new Error("JSON object");
  const output = Object.create(null);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 512) throw new Error("JSON object");
  for (const key of keys) {
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.length > 256 ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype" ||
      /[\0\r\n]/u.test(key)
    ) {
      throw new Error("JSON key");
    }
    output[key] = cloneJson(dataValue(value, key, true), depth + 1);
  }
  return Object.freeze(output);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function inspectApproval(value) {
  if (
    !isPlain(value) ||
    Reflect.ownKeys(value).some((key) => !["jobId", "generation", "planDigest", "calls"].includes(key))
  ) {
    throw new Error("approval");
  }
  const jobId = dataValue(value, "jobId", true);
  const generation = dataValue(value, "generation", true);
  const planDigest = dataValue(value, "planDigest", true);
  const sourceCalls = dataValue(value, "calls", true);
  if (
    typeof jobId !== "string" ||
    !JOB_ID.test(jobId) ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    typeof planDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(planDigest) ||
    !Array.isArray(sourceCalls) ||
    Object.getPrototypeOf(sourceCalls) !== Array.prototype ||
    sourceCalls.length === 0 ||
    sourceCalls.length > 512
  ) {
    throw new Error("approval");
  }
  const arrayKeys = Reflect.ownKeys(sourceCalls);
  if (
    arrayKeys.length !== sourceCalls.length + 1 ||
    arrayKeys.some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)))
  ) {
    throw new Error("approval calls");
  }
  const ids = new Set();
  const calls = sourceCalls.map((source, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(sourceCalls, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || !isPlain(source)) {
      throw new Error("approval call");
    }
    const keys = Reflect.ownKeys(source);
    if (keys.length !== 3 || keys.some((key) => !["id", "tool", "arguments"].includes(key))) {
      throw new Error("approval call");
    }
    const id = dataValue(source, "id", true);
    const tool = dataValue(source, "tool", true);
    const argumentsValue = cloneJson(dataValue(source, "arguments", true));
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(id) ||
      ids.has(id) ||
      typeof tool !== "string" ||
      !EXECUTION_TOOLS.has(tool) ||
      ALWAYS_FORBIDDEN_TOOLS.has(tool) ||
      !isPlain(argumentsValue) ||
      hasFilename(argumentsValue)
    ) {
      throw new Error("approval call");
    }
    ids.add(id);
    return Object.freeze({ id, tool, arguments: argumentsValue, canonicalArguments: canonicalJson(argumentsValue) });
  });
  if (Buffer.byteLength(canonicalJson(calls.map(({ id, tool, arguments: args }) => ({ id, tool, arguments: args })))) > MAX_REQUEST_BYTES) {
    throw new Error("approval size");
  }
  for (let index = 0; index < calls.length; index += 1) {
    const probe = calls[index];
    if (probe.tool !== "browser_evaluate") continue;
    const click = calls[index + 1];
    const probeArguments = probe.arguments;
    const clickArguments = click?.arguments;
    const expectedKeys = Object.hasOwn(clickArguments ?? {}, "element")
      ? ["element", "target", "function"]
      : ["target", "function"];
    if (
      !click ||
      click.tool !== "browser_click" ||
      probe.id !== `${click.id}.highlight-bounds` ||
      Reflect.ownKeys(probeArguments).length !== expectedKeys.length ||
      Reflect.ownKeys(probeArguments).some((key) => typeof key !== "string" || !expectedKeys.includes(key)) ||
      dataValue(probeArguments, "function", true) !== CLICK_GEOMETRY_FUNCTION ||
      dataValue(probeArguments, "target", true) !== dataValue(clickArguments, "target", true) ||
      (Object.hasOwn(clickArguments, "element") &&
        dataValue(probeArguments, "element", true) !== dataValue(clickArguments, "element", true))
    ) {
      throw new Error("approval geometry probe");
    }
  }
  return Object.freeze({ jobId, generation, planDigest, calls: Object.freeze(calls) });
}

function inspectTimingBinding(value) {
  if (
    !isPlain(value) ||
    Reflect.ownKeys(value).length !== 3 ||
    Reflect.ownKeys(value).some((key) => !["jobId", "generation", "planDigest"].includes(key))
  ) {
    throw new Error("timing binding");
  }
  const jobId = dataValue(value, "jobId", true);
  const generation = dataValue(value, "generation", true);
  const planDigest = dataValue(value, "planDigest", true);
  if (
    typeof jobId !== "string" ||
    !JOB_ID.test(jobId) ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    typeof planDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(planDigest)
  ) {
    throw new Error("timing binding");
  }
  return Object.freeze({ jobId, generation, planDigest });
}

function inspectHighlightBinding(value) {
  if (
    !isPlain(value) ||
    Reflect.ownKeys(value).length !== 4 ||
    Reflect.ownKeys(value).some((key) => !["jobId", "generation", "planDigest", "expectedCallIds"].includes(key))
  ) {
    throw new Error("highlight binding");
  }
  const timing = inspectTimingBinding({
    jobId: dataValue(value, "jobId", true),
    generation: dataValue(value, "generation", true),
    planDigest: dataValue(value, "planDigest", true),
  });
  const sourceIds = dataValue(value, "expectedCallIds", true);
  if (
    !Array.isArray(sourceIds) ||
    Object.getPrototypeOf(sourceIds) !== Array.prototype ||
    sourceIds.length > 128 ||
    Reflect.ownKeys(sourceIds).length !== sourceIds.length + 1
  ) {
    throw new Error("highlight ids");
  }
  const seen = new Set();
  const expectedCallIds = sourceIds.map((id, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(sourceIds, String(index));
    if (
      !descriptor?.enumerable ||
      !("value" in descriptor) ||
      typeof id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\.highlight-bounds$/u.test(id) ||
      seen.has(id)
    ) {
      throw new Error("highlight id");
    }
    seen.add(id);
    return id;
  });
  return Object.freeze({ ...timing, expectedCallIds: Object.freeze(expectedCallIds) });
}

function inspectEvidenceBinding(value) {
  if (
    !isPlain(value) ||
    Reflect.ownKeys(value).length !== 2 ||
    Reflect.ownKeys(value).some((key) => !["expectedGenerationId", "expectedCallIds"].includes(key))
  ) {
    throw new Error("evidence binding");
  }
  const expectedGenerationId = dataValue(value, "expectedGenerationId", true);
  const sourceCallIds = dataValue(value, "expectedCallIds", true);
  const arrayKeys = Array.isArray(sourceCallIds) ? Reflect.ownKeys(sourceCallIds) : [];
  if (
    !Number.isSafeInteger(expectedGenerationId) ||
    expectedGenerationId < 1 ||
    !Array.isArray(sourceCallIds) ||
    Object.getPrototypeOf(sourceCallIds) !== Array.prototype ||
    sourceCallIds.length > 512 ||
    arrayKeys.length !== sourceCallIds.length + 1 ||
    arrayKeys.some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)))
  ) {
    throw new Error("evidence binding");
  }
  const ids = new Set();
  const expectedCallIds = sourceCallIds.map((_source, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(sourceCallIds, String(index));
    const id = descriptor?.value;
    if (
      !descriptor?.enumerable ||
      typeof id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(id) ||
      ids.has(id)
    ) {
      throw new Error("evidence call id");
    }
    ids.add(id);
    return id;
  });
  return Object.freeze({
    expectedGenerationId,
    expectedCallIds: Object.freeze(expectedCallIds),
  });
}

async function readBoundedBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new PolicyViolation("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  if (bytes === 0) throw new PolicyViolation("INVALID_JSON_RPC");
  return Buffer.concat(chunks, bytes);
}

function responseHeaders(upstreamHeaders) {
  const output = Object.create(null);
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstreamHeaders[name];
    if (typeof value === "string" && !/[\0\r\n]/u.test(value)) output[name] = value;
  }
  output["x-content-type-options"] = "nosniff";
  return output;
}

function requestHeaders(request, body) {
  const output = Object.create(null);
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string" && !/[\0\r\n]/u.test(value)) output[name] = value;
  }
  if (body !== undefined) output["content-length"] = String(body.length);
  return output;
}

function sendPlain(response, status, message) {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  const body = `${message}\n`;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendPolicyError(response, id, quarantined = false) {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: safeRpcId(id),
    error: {
      code: quarantined ? -32_002 : -32_001,
      message: quarantined ? "MCP gateway quarantined." : "MCP gateway policy violation.",
    },
  });
  response.writeHead(quarantined ? 423 : 403, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function parseSseMessages(source) {
  const messages = [];
  for (const block of source.replace(/\r\n?/gu, "\n").split(/\n\n/gu)) {
    if (!block.trim()) continue;
    const data = block.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      throw new Error("invalid SSE JSON");
    }
  }
  return messages;
}

function validateToolResponse(chunks, contentType, expectedId) {
  const source = Buffer.concat(chunks).toString("utf8");
  let messages;
  try {
    messages = contentType.toLowerCase().startsWith("text/event-stream")
      ? parseSseMessages(source)
      : [JSON.parse(source)];
  } catch {
    throw new PolicyViolation("TOOL_CALL_FAILED", expectedId);
  }
  const matches = messages.filter((message) =>
    isPlain(message) &&
    dataValue(message, "jsonrpc") === "2.0" &&
    dataValue(message, "id") === expectedId);
  if (matches.length !== 1) throw new PolicyViolation("TOOL_CALL_FAILED", expectedId);
  const message = matches[0];
  if (Object.hasOwn(message, "error") || !Object.hasOwn(message, "result")) {
    throw new PolicyViolation("TOOL_CALL_FAILED", expectedId);
  }
  const result = dataValue(message, "result", true);
  if (!isPlain(result) || dataValue(result, "isError") === true) {
    throw new PolicyViolation("TOOL_CALL_FAILED", expectedId);
  }
  return result;
}

function clickGeometry(result, expectedId) {
  try {
    if (
      !isPlain(result) ||
      Reflect.ownKeys(result).length !== 1 ||
      Reflect.ownKeys(result)[0] !== "content"
    ) {
      throw new Error("result");
    }
    const content = dataValue(result, "content", true);
    if (
      !Array.isArray(content) ||
      Object.getPrototypeOf(content) !== Array.prototype ||
      content.length !== 1 ||
      Reflect.ownKeys(content).length !== 2
    ) {
      throw new Error("content");
    }
    const descriptor = Object.getOwnPropertyDescriptor(content, "0");
    const item = descriptor?.value;
    if (
      !descriptor?.enumerable ||
      !isPlain(item) ||
      Reflect.ownKeys(item).length !== 2 ||
      Reflect.ownKeys(item).some((key) => !["type", "text"].includes(key)) ||
      dataValue(item, "type", true) !== "text"
    ) {
      throw new Error("content item");
    }
    const text = dataValue(item, "text", true);
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 4_096) throw new Error("text");
    const envelope = JSON.parse(text);
    if (
      !isPlain(envelope) ||
      Reflect.ownKeys(envelope).length !== 1 ||
      Reflect.ownKeys(envelope)[0] !== "result"
    ) {
      throw new Error("envelope");
    }
    const encodedGeometry = dataValue(envelope, "result", true);
    if (typeof encodedGeometry !== "string" || Buffer.byteLength(encodedGeometry, "utf8") > 1_024) {
      throw new Error("encoded geometry");
    }
    const geometry = JSON.parse(encodedGeometry);
    const names = ["x", "y", "width", "height"];
    if (
      !isPlain(geometry) ||
      Reflect.ownKeys(geometry).length !== names.length ||
      Reflect.ownKeys(geometry).some((key) => typeof key !== "string" || !names.includes(key))
    ) {
      throw new Error("geometry");
    }
    const x = dataValue(geometry, "x", true);
    const y = dataValue(geometry, "y", true);
    const width = dataValue(geometry, "width", true);
    const height = dataValue(geometry, "height", true);
    if (
      ![x, y, width, height].every((value) => typeof value === "number" && Number.isFinite(value)) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new Error("geometry values");
    }
    const left = Math.floor(x);
    const top = Math.floor(y);
    const right = Math.ceil(x + width);
    const bottom = Math.ceil(y + height);
    if (
      ![left, top, right, bottom].every(Number.isSafeInteger) ||
      left < 0 ||
      top < 0 ||
      right <= left ||
      bottom <= top ||
      right > 1_920 ||
      bottom > 1_080
    ) {
      throw new Error("geometry bounds");
    }
    return Object.freeze({ x: left, y: top, width: right - left, height: bottom - top });
  } catch {
    throw new PolicyViolation("HIGHLIGHT_GEOMETRY_INVALID", expectedId);
  }
}

function recordingArtifactFileName(result, expectedId) {
  try {
    const content = dataValue(result, "content", true);
    if (
      !Array.isArray(content) ||
      Object.getPrototypeOf(content) !== Array.prototype ||
      content.length !== 1 ||
      Reflect.ownKeys(content).length !== 2
    ) {
      throw new Error("content");
    }
    const descriptor = Object.getOwnPropertyDescriptor(content, "0");
    const item = descriptor?.value;
    if (
      !descriptor?.enumerable ||
      !isPlain(item) ||
      Reflect.ownKeys(item).length !== 2 ||
      Reflect.ownKeys(item).some((key) => !["type", "text"].includes(key)) ||
      dataValue(item, "type", true) !== "text"
    ) {
      throw new Error("content item");
    }
    const text = dataValue(item, "text", true);
    if (typeof text !== "string") throw new Error("text");
    const matches = [...text.matchAll(/^- \[Video\]\(\.\/([A-Za-z0-9][A-Za-z0-9._-]{0,199}\.webm)\)$/gmu)];
    if (matches.length !== 1) throw new Error("video links");
    return matches[0][1];
  } catch {
    throw new PolicyViolation("RECORDING_ARTIFACT_INVALID", expectedId);
  }
}

function evidenceArtifactFileName(result, expectedId) {
  try {
    const content = dataValue(result, "content", true);
    if (
      !Array.isArray(content) ||
      Object.getPrototypeOf(content) !== Array.prototype ||
      content.length !== 1 ||
      Reflect.ownKeys(content).length !== 2
    ) {
      throw new Error("content");
    }
    const descriptor = Object.getOwnPropertyDescriptor(content, "0");
    const item = descriptor?.value;
    if (
      !descriptor?.enumerable ||
      !isPlain(item) ||
      Reflect.ownKeys(item).length !== 2 ||
      Reflect.ownKeys(item).some((key) => !["type", "text"].includes(key)) ||
      dataValue(item, "type", true) !== "text"
    ) {
      throw new Error("content item");
    }
    const text = dataValue(item, "text", true);
    if (typeof text !== "string") throw new Error("text");
    const screenshotLines = text
      .replace(/\r\n?/gu, "\n")
      .split("\n")
      .filter((line) => line.includes("[Screenshot"));
    if (screenshotLines.length !== 1) throw new Error("screenshot links");
    const match = /^- \[Screenshot of viewport\]\(\.\/([A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(?:png|jpe?g))\)$/u.exec(screenshotLines[0]);
    if (!match) throw new Error("screenshot link");
    return match[1];
  } catch {
    throw new PolicyViolation("EVIDENCE_ARTIFACT_INVALID", expectedId);
  }
}

export class McpGateway {
  #settings;
  #server = null;
  #endpoint = null;
  #jobId = null;
  #generation = null;
  #lifecycle = null;
  #phase = "stopped";
  #sessions = new Map();
  #executorSessionId = null;
  #pendingInitializations = new Set();
  #sockets = new Set();
  #upstreamRequests = new Set();
  #inFlightTool = null;
  #planningCalls = 0;
  #approval = null;
  #approvalIndex = 0;
  #executionTiming = [];
  #executionHighlights = [];
  #recordingArtifact = null;
  #evidenceArtifacts = [];
  #lastTimingMs = 0;
  #fatalTriggered = false;
  #stopPromise = null;

  constructor(options) {
    this.#settings = validateConstructor(options);
  }

  get endpoint() {
    return this.#endpoint;
  }

  get active() {
    if (!this.#endpoint || !this.#jobId || this.#generation === null || this.#phase === "stopped") return null;
    const active = {
      endpoint: this.#endpoint,
      jobId: this.#jobId,
      generation: this.#generation,
      phase: this.#phase,
      remainingCalls: this.#approval ? this.#approval.calls.length - this.#approvalIndex : 0,
    };
    if (this.#approval) active.planDigest = this.#approval.planDigest;
    return Object.freeze(active);
  }

  async start(input) {
    let start;
    try {
      start = inspectStart(input);
    } catch {
      throw gatewayError("INVALID_MCP_GATEWAY_START", "The MCP gateway start request is invalid.");
    }
    if (this.#stopPromise || this.#server || this.#phase !== "stopped") {
      throw gatewayError("MCP_GATEWAY_BUSY", "The MCP gateway is already active.");
    }
    this.#jobId = start.jobId;
    this.#generation = start.generation;
    this.#lifecycle = Object.freeze({});
    this.#phase = "planning";
    this.#sessions.clear();
    this.#executorSessionId = start.adoptedSessionId ?? null;
    if (start.adoptedSessionId !== undefined) {
      this.#sessions.set(start.adoptedSessionId, Object.freeze({ generation: start.generation }));
    }
    this.#pendingInitializations.clear();
    this.#planningCalls = 0;
    this.#approval = null;
    this.#approvalIndex = 0;
    this.#executionTiming = [];
    this.#executionHighlights = [];
    this.#recordingArtifact = null;
    this.#evidenceArtifacts = [];
    this.#lastTimingMs = 0;
    this.#fatalTriggered = false;
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.#server = server;
    server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
    });
    server.on("clientError", (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    try {
      await new Promise((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(this.#settings.port, "127.0.0.1", resolvePromise);
      });
      const address = server.address();
      if (!address || typeof address === "string" || address.port === this.#settings.upstream.port) {
        throw new Error("unsafe port");
      }
      this.#endpoint = `http://127.0.0.1:${address.port}/mcp`;
      return this.active;
    } catch {
      await this.stop().catch(() => undefined);
      throw gatewayError("MCP_GATEWAY_START_FAILED", "The MCP gateway could not start.");
    }
  }

  async quarantine(code = "COORDINATOR_QUARANTINE") {
    if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(code)) {
      throw gatewayError("INVALID_MCP_GATEWAY_QUARANTINE", "The MCP gateway quarantine request is invalid.");
    }
    this.#enterQuarantine(code);
    return this.active;
  }

  installApproval(input) {
    let approval;
    try {
      approval = inspectApproval(input);
    } catch {
      this.#enterQuarantine("INVALID_APPROVAL");
      throw gatewayError("INVALID_MCP_GATEWAY_APPROVAL", "The MCP gateway approval is invalid.");
    }
    if (this.#executorSessionId === null) {
      this.#enterQuarantine("EXECUTOR_SESSION_REQUIRED");
      throw gatewayError("INVALID_MCP_GATEWAY_APPROVAL", "The MCP gateway approval is invalid.");
    }
    if (
      this.#phase !== "planning" ||
      this.#inFlightTool ||
      approval.jobId !== this.#jobId ||
      approval.generation !== this.#generation
    ) {
      this.#enterQuarantine("STALE_APPROVAL");
      throw gatewayError("INVALID_MCP_GATEWAY_APPROVAL", "The MCP gateway approval is invalid.");
    }
    this.#approval = approval;
    this.#approvalIndex = 0;
    this.#executionTiming = [];
    this.#executionHighlights = [];
    this.#recordingArtifact = null;
    this.#evidenceArtifacts = [];
    this.#lastTimingMs = 0;
    this.#phase = "execution";
    return Object.freeze({
      jobId: approval.jobId,
      generation: approval.generation,
      planDigest: approval.planDigest,
      callCount: approval.calls.length,
    });
  }

  readExecutionTiming(input) {
    let binding;
    try {
      binding = inspectTimingBinding(input);
    } catch {
      throw gatewayError("INVALID_MCP_GATEWAY_TIMING", "The MCP execution timing request is invalid.");
    }
    if (
      !this.#approval ||
      !["execution", "execution_complete"].includes(this.#phase) ||
      binding.jobId !== this.#jobId ||
      binding.generation !== this.#generation ||
      binding.planDigest !== this.#approval.planDigest
    ) {
      throw gatewayError("INVALID_MCP_GATEWAY_TIMING", "The MCP execution timing request is invalid.");
    }
    return Object.freeze({
      schemaVersion: "1.0",
      clock: "unix_ms",
      jobId: binding.jobId,
      generation: binding.generation,
      planDigest: binding.planDigest,
      complete:
        this.#phase === "execution_complete" &&
        this.#executionTiming.length === this.#approval.calls.length,
      calls: Object.freeze([...this.#executionTiming]),
    });
  }

  readExecutionHighlights(input) {
    let binding;
    try {
      binding = inspectHighlightBinding(input);
    } catch {
      throw gatewayError("INVALID_MCP_GATEWAY_HIGHLIGHTS", "The MCP execution highlights request is invalid.");
    }
    const approvedProbeIds = this.#approval?.calls
      .filter(({ tool }) => tool === "browser_evaluate")
      .map(({ id }) => id) ?? [];
    if (
      !this.#approval ||
      this.#phase !== "execution_complete" ||
      binding.jobId !== this.#jobId ||
      binding.generation !== this.#generation ||
      binding.planDigest !== this.#approval.planDigest ||
      binding.expectedCallIds.length !== approvedProbeIds.length ||
      binding.expectedCallIds.length !== this.#executionHighlights.length ||
      new Set(this.#executionHighlights.map(({ approvedCallId }) => approvedCallId)).size !== this.#executionHighlights.length ||
      binding.expectedCallIds.some((id, index) =>
        id !== approvedProbeIds[index] ||
        id !== this.#executionHighlights[index]?.approvedCallId)
    ) {
      throw gatewayError("INVALID_MCP_GATEWAY_HIGHLIGHTS", "The MCP execution highlights request is invalid.");
    }
    return Object.freeze(this.#executionHighlights.map((highlight) => Object.freeze({ ...highlight })));
  }

  readRecordingArtifact(input) {
    let binding;
    try {
      binding = inspectTimingBinding(input);
    } catch {
      throw gatewayError("INVALID_MCP_GATEWAY_ARTIFACT", "The MCP recording artifact request is invalid.");
    }
    const artifact = this.#recordingArtifact;
    if (
      !artifact ||
      !this.#approval ||
      this.#phase !== "execution_complete" ||
      binding.jobId !== this.#jobId ||
      binding.generation !== this.#generation ||
      binding.planDigest !== this.#approval.planDigest ||
      artifact.jobId !== binding.jobId ||
      artifact.generation !== binding.generation ||
      artifact.planDigest !== binding.planDigest
    ) {
      throw gatewayError("INVALID_MCP_GATEWAY_ARTIFACT", "The MCP recording artifact request is invalid.");
    }
    return artifact;
  }

  readEvidenceArtifacts(input) {
    let binding;
    try {
      binding = inspectEvidenceBinding(input);
    } catch {
      throw gatewayError("INVALID_MCP_GATEWAY_EVIDENCE", "The MCP screenshot evidence request is invalid.");
    }
    if (
      !this.#approval ||
      this.#phase !== "execution_complete" ||
      binding.expectedGenerationId !== this.#generation ||
      binding.expectedCallIds.length !== this.#evidenceArtifacts.length ||
      this.#evidenceArtifacts.some((artifact, index) =>
        artifact.generation !== binding.expectedGenerationId ||
        artifact.approvedCallId !== binding.expectedCallIds[index])
    ) {
      throw gatewayError("INVALID_MCP_GATEWAY_EVIDENCE", "The MCP screenshot evidence request is invalid.");
    }
    return Object.freeze(this.#evidenceArtifacts.map((artifact) => Object.freeze({
      approvedCallId: artifact.approvedCallId,
      fileName: artifact.fileName,
    })));
  }

  #enterQuarantine(reason) {
    if (this.#phase === "stopped" || this.#phase === "quarantined") return;
    const previousPhase = this.#phase;
    this.#phase = "quarantined";
    this.#sessions.clear();
    this.#executorSessionId = null;
    this.#pendingInitializations.clear();
    this.#inFlightTool = null;
    this.#recordingArtifact = null;
    this.#evidenceArtifacts = [];
    this.#executionHighlights = [];
    for (const request of this.#upstreamRequests) request.destroy();
    if (this.#fatalTriggered) return;
    this.#fatalTriggered = true;
    const event = Object.freeze({
      code: "MCP_GATEWAY_FATAL",
      reason,
      jobId: this.#jobId,
      generation: this.#generation,
      phase: previousPhase,
    });
    queueMicrotask(() => {
      void Promise.resolve(this.#settings.onFatal(event)).catch(() => undefined);
    });
  }

  #assertSession(sessionId) {
    const session = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    if (!session || session.generation !== this.#generation) throw new PolicyViolation("UNKNOWN_SESSION");
  }

  #authorize(request, parsed) {
    const sessionId = sessionHeader(request);
    if (parsed.method === "initialize") {
      if (this.#executorSessionId !== null && this.#phase !== "planning") {
        throw new PolicyViolation("EXECUTION_SESSION_MISMATCH", parsed.id);
      }
      if (sessionId !== undefined) throw new PolicyViolation("INITIALIZE_WITH_SESSION", parsed.id);
      if (this.#sessions.size + this.#pendingInitializations.size >= MAX_SESSIONS) {
        throw new PolicyViolation("SESSION_LIMIT", parsed.id);
      }
      const initializationReservation = Object.freeze({});
      this.#pendingInitializations.add(initializationReservation);
      return Object.freeze({ initialize: true, initializationReservation, parsed, sessionId: undefined, tool: null });
    }
    this.#assertSession(sessionId);
    if (parsed.response) return Object.freeze({ initialize: false, parsed, sessionId, tool: null });
    if (["notifications/initialized", "notifications/cancelled", "ping", "tools/list"].includes(parsed.method)) {
      return Object.freeze({ initialize: false, parsed, sessionId, tool: null });
    }
    if (parsed.method !== "tools/call") throw new PolicyViolation("METHOD_NOT_ALLOWED", parsed.id);
    if (safeRpcId(parsed.id) !== parsed.id) throw new PolicyViolation("INVALID_TOOL_CALL", parsed.id);
    if (this.#inFlightTool) throw new PolicyViolation("CONCURRENT_TOOL_CALL", parsed.id);
    const params = dataValue(parsed.message, "params");
    if (
      !isPlain(params) ||
      Reflect.ownKeys(params).some((key) => !["name", "arguments", "_meta"].includes(key)) ||
      (Object.hasOwn(params, "_meta") && !validProgressMetadata(dataValue(params, "_meta", true)))
    ) {
      throw new PolicyViolation("INVALID_TOOL_CALL", parsed.id);
    }
    const name = dataValue(params, "name", true);
    const sourceArguments = dataValue(params, "arguments", true);
    let argumentsValue;
    try {
      argumentsValue = cloneJson(sourceArguments);
    } catch {
      throw new PolicyViolation("INVALID_TOOL_CALL", parsed.id);
    }
    if (typeof name !== "string" || !isPlain(argumentsValue) || hasFilename(argumentsValue)) {
      throw new PolicyViolation(hasFilename(argumentsValue) ? "FILENAME_NOT_ALLOWED" : "INVALID_TOOL_CALL", parsed.id);
    }
    if (ALWAYS_FORBIDDEN_TOOLS.has(name)) throw new PolicyViolation("TOOL_ALWAYS_FORBIDDEN", parsed.id);
    let approvedCall = null;
    if (this.#phase === "planning") {
      if (!PLANNING_TOOLS.has(name) || this.#planningCalls >= MAX_PLANNING_CALLS) {
        throw new PolicyViolation("TOOL_NOT_ALLOWED_IN_PHASE", parsed.id);
      }
      if (!validPlanningArguments(name, argumentsValue)) {
        throw new PolicyViolation("INVALID_PLANNING_ARGUMENTS", parsed.id);
      }
    } else if (this.#phase === "execution") {
      if (this.#executorSessionId !== null && sessionId !== this.#executorSessionId) {
        throw new PolicyViolation("EXECUTION_SESSION_MISMATCH", parsed.id);
      }
      const expected = this.#approval?.calls[this.#approvalIndex];
      if (
        !expected ||
        name !== expected.tool ||
        canonicalJson(argumentsValue) !== expected.canonicalArguments
      ) {
        throw new PolicyViolation("EXECUTION_CALL_MISMATCH", parsed.id);
      }
      approvedCall = expected;
    } else {
      throw new PolicyViolation("TOOL_NOT_ALLOWED_IN_PHASE", parsed.id);
    }
    const tool = Object.freeze({
      name,
      phase: this.#phase,
      approvalIndex: this.#approvalIndex,
      approvedCallId: approvedCall?.id ?? null,
      startedAtMs: approvedCall === null ? null : Math.max(Date.now(), this.#lastTimingMs),
      generation: this.#generation,
      lifecycle: this.#lifecycle,
    });
    this.#inFlightTool = tool;
    return Object.freeze({ initialize: false, parsed, sessionId, tool });
  }

  #toolCommitState(tool) {
    if (
      this.#phase === "quarantined" ||
      this.#phase === "stopped" ||
      this.#lifecycle !== tool.lifecycle ||
      this.#generation !== tool.generation
    ) {
      return "stale";
    }
    if (this.#phase !== tool.phase || this.#inFlightTool !== tool) return "invalid";
    return "current";
  }

  async #handle(request, response) {
    if (request.url !== "/mcp") {
      sendPlain(response, 404, "Not found.");
      return;
    }
    if (!hasCapability(request, this.#settings.capabilityToken)) {
      sendPlain(response, 401, "Unauthorized.");
      return;
    }
    const address = this.#server?.address();
    const expectedHost = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
    if (request.headers.host !== expectedHost) {
      sendPlain(response, 421, "Misdirected request.");
      return;
    }
    if (!new Set(["GET", "POST", "DELETE"]).has(request.method)) {
      sendPlain(response, 405, "Method not allowed.");
      return;
    }
    if (this.#phase === "quarantined") {
      sendPolicyError(response, null, true);
      return;
    }
    if (this.#phase === "stopped") {
      sendPlain(response, 503, "Gateway stopped.");
      return;
    }
    try {
      let body;
      let authorization = Object.freeze({ initialize: false, parsed: null, sessionId: undefined, tool: null });
      if (request.method === "POST") {
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
          throw new PolicyViolation("INVALID_CONTENT_TYPE");
        }
        body = await readBoundedBody(request);
        const parsed = parseMessage(body.toString("utf8"));
        authorization = this.#authorize(request, parsed);
      } else {
        const sessionId = sessionHeader(request);
        this.#assertSession(sessionId);
        authorization = Object.freeze({ initialize: false, parsed: null, sessionId, tool: null });
      }
      await this.#proxy(request, response, body, authorization);
    } catch (error) {
      const violation = error instanceof PolicyViolation
        ? error
        : new PolicyViolation("GATEWAY_FAILURE");
      this.#enterQuarantine(violation.reason);
      sendPolicyError(response, violation.id, false);
    }
  }

  async #proxy(downstreamRequest, downstreamResponse, body, authorization) {
    await new Promise((resolvePromise, rejectPromise) => {
      let responseStarted = false;
      let responseCompleted = false;
      let responseBytes = 0;
      let settled = false;
      const toolResponseChunks = [];
      const upstreamRequest = httpRequest({
        hostname: this.#settings.upstream.hostname,
        port: this.#settings.upstream.port,
        path: this.#settings.upstream.path,
        method: downstreamRequest.method,
        headers: requestHeaders(downstreamRequest, body),
        agent: false,
      });
      this.#upstreamRequests.add(upstreamRequest);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (authorization.initializationReservation) {
          this.#pendingInitializations.delete(authorization.initializationReservation);
        }
        this.#upstreamRequests.delete(upstreamRequest);
        downstreamRequest.off("aborted", onDownstreamAborted);
        downstreamResponse.off("close", onDownstreamClosed);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const onDownstreamAborted = () => {
        upstreamRequest.destroy();
        finish(new PolicyViolation("DOWNSTREAM_ABORTED", authorization.parsed?.id));
      };
      downstreamRequest.once("aborted", onDownstreamAborted);
      const onDownstreamClosed = () => {
        if (responseCompleted || settled) return;
        upstreamRequest.destroy();
        finish(new PolicyViolation("DOWNSTREAM_ABORTED", authorization.parsed?.id));
      };
      downstreamResponse.once("close", onDownstreamClosed);
      if (downstreamRequest.method === "POST") {
        upstreamRequest.setTimeout(this.#settings.upstreamTimeoutMs, () => {
          finish(new PolicyViolation("UPSTREAM_TIMEOUT", authorization.parsed?.id));
          upstreamRequest.destroy();
        });
      }
      upstreamRequest.once("error", () => {
        if (!responseStarted) finish(new PolicyViolation("UPSTREAM_UNAVAILABLE", authorization.parsed?.id));
      });
      upstreamRequest.once("response", (upstreamResponse) => {
        responseStarted = true;
        const status = upstreamResponse.statusCode;
        const contentType = upstreamResponse.headers["content-type"];
        const emptyDeleteCandidate =
          downstreamRequest.method === "DELETE" &&
          status === 200 &&
          typeof contentType === "string" &&
          /^text\/plain(?:\s*;|$)/iu.test(contentType);
        if (
          !SAFE_STATUS.has(status) ||
          (![202, 204].includes(status) &&
            !emptyDeleteCandidate &&
            (typeof contentType !== "string" || !/^(?:application\/json|text\/event-stream)(?:\s*;|$)/iu.test(contentType)))
        ) {
          upstreamResponse.destroy();
          finish(new PolicyViolation("UNSAFE_UPSTREAM_RESPONSE", authorization.parsed?.id));
          return;
        }
        const returnedSession = upstreamResponse.headers["mcp-session-id"];
        if (authorization.initialize) {
          if (status !== 200 || typeof returnedSession !== "string" || !SESSION_ID.test(returnedSession) || this.#sessions.has(returnedSession)) {
            upstreamResponse.destroy();
            finish(new PolicyViolation("INVALID_UPSTREAM_SESSION", authorization.parsed?.id));
            return;
          }
          this.#sessions.set(returnedSession, Object.freeze({ generation: this.#generation }));
        } else if (returnedSession !== undefined && returnedSession !== authorization.sessionId) {
          upstreamResponse.destroy();
          finish(new PolicyViolation("UPSTREAM_SESSION_DRIFT", authorization.parsed?.id));
          return;
        }
        downstreamResponse.writeHead(status, responseHeaders(upstreamResponse.headers));
        upstreamResponse.on("data", (chunk) => {
          if (settled) return;
          responseBytes += chunk.length;
          if (downstreamRequest.method !== "GET" && responseBytes > MAX_POST_RESPONSE_BYTES) {
            upstreamResponse.destroy();
            downstreamResponse.destroy();
            finish(new PolicyViolation("UPSTREAM_RESPONSE_TOO_LARGE", authorization.parsed?.id));
            return;
          }
          if (!downstreamResponse.write(chunk)) upstreamResponse.pause();
          if (authorization.tool) toolResponseChunks.push(Buffer.from(chunk));
        });
        downstreamResponse.on("drain", () => upstreamResponse.resume());
        upstreamResponse.once("end", () => {
          if (settled) return;
          responseCompleted = true;
          downstreamResponse.end();
          if (authorization.tool) {
            const commitState = this.#toolCommitState(authorization.tool);
            if (commitState === "stale") {
              finish();
              return;
            }
            if (commitState === "invalid") {
              finish(new PolicyViolation("TOOL_RESPONSE_STATE_DRIFT", authorization.parsed?.id));
              return;
            }
            if (status < 200 || status >= 300) {
              finish(new PolicyViolation("TOOL_CALL_FAILED", authorization.parsed?.id));
              return;
            }
            let recordingFileName = null;
            let evidenceFileName = null;
            let geometry = null;
            try {
              const result = validateToolResponse(toolResponseChunks, contentType, authorization.parsed.id);
              if (
                authorization.tool.phase === "execution" &&
                authorization.tool.name === "browser_evaluate"
              ) {
                geometry = clickGeometry(result, authorization.parsed.id);
              }
              if (authorization.tool.name === "browser_stop_video") {
                recordingFileName = recordingArtifactFileName(result, authorization.parsed.id);
              }
              if (
                authorization.tool.phase === "execution" &&
                authorization.tool.name === "browser_take_screenshot"
              ) {
                evidenceFileName = evidenceArtifactFileName(result, authorization.parsed.id);
              }
            } catch (error) {
              finish(error instanceof PolicyViolation ? error : new PolicyViolation("TOOL_CALL_FAILED", authorization.parsed?.id));
              return;
            }
            if (authorization.tool.phase === "planning") {
              this.#planningCalls += 1;
            } else {
              if (authorization.tool.approvalIndex !== this.#approvalIndex) {
                finish(new PolicyViolation("EXECUTION_QUEUE_DRIFT", authorization.parsed?.id));
                return;
              }
              const endedAtMs = Math.max(Date.now(), authorization.tool.startedAtMs + 1);
              this.#executionTiming.push(Object.freeze({
                id: authorization.tool.approvedCallId,
                tool: authorization.tool.name,
                startedAtMs: authorization.tool.startedAtMs,
                endedAtMs,
              }));
              if (recordingFileName !== null) {
                this.#recordingArtifact = Object.freeze({
                  schemaVersion: "1.0",
                  jobId: this.#jobId,
                  generation: this.#generation,
                  planDigest: this.#approval.planDigest,
                  approvedCallId: authorization.tool.approvedCallId,
                  fileName: recordingFileName,
                });
              }
              if (evidenceFileName !== null) {
                this.#evidenceArtifacts.push(Object.freeze({
                  generation: this.#generation,
                  approvedCallId: authorization.tool.approvedCallId,
                  fileName: evidenceFileName,
                }));
              }
              if (geometry !== null) {
                if (this.#executionHighlights.some(({ approvedCallId }) =>
                  approvedCallId === authorization.tool.approvedCallId)) {
                  finish(new PolicyViolation("HIGHLIGHT_GEOMETRY_DUPLICATE", authorization.parsed?.id));
                  return;
                }
                this.#executionHighlights.push(Object.freeze({
                  approvedCallId: authorization.tool.approvedCallId,
                  ...geometry,
                }));
              }
              this.#lastTimingMs = endedAtMs;
              this.#approvalIndex += 1;
              if (this.#approvalIndex === this.#approval.calls.length) this.#phase = "execution_complete";
            }
            this.#inFlightTool = null;
          }
          if (emptyDeleteCandidate && responseBytes !== 0) {
            finish(new PolicyViolation("UNSAFE_UPSTREAM_RESPONSE", authorization.parsed?.id));
            return;
          }
          if (downstreamRequest.method === "DELETE" && status >= 200 && status < 300) {
            this.#sessions.delete(authorization.sessionId);
          }
          finish();
        });
        upstreamResponse.once("aborted", () => {
          if (!responseCompleted) finish(new PolicyViolation("UPSTREAM_RESPONSE_ABORTED", authorization.parsed?.id));
        });
        upstreamResponse.once("error", () => {
          if (!responseCompleted) finish(new PolicyViolation("UPSTREAM_RESPONSE_FAILED", authorization.parsed?.id));
        });
      });
      if (body !== undefined) upstreamRequest.end(body);
      else upstreamRequest.end();
    });
  }

  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = (async () => {
      this.#phase = "stopped";
      this.#lifecycle = null;
      this.#sessions.clear();
      this.#executorSessionId = null;
      this.#pendingInitializations.clear();
      this.#inFlightTool = null;
      this.#approval = null;
      this.#approvalIndex = 0;
      this.#executionTiming = [];
      this.#executionHighlights = [];
      this.#recordingArtifact = null;
      this.#evidenceArtifacts = [];
      this.#lastTimingMs = 0;
      for (const request of this.#upstreamRequests) request.destroy();
      this.#upstreamRequests.clear();
      const server = this.#server;
      this.#server = null;
      if (server) {
        for (const socket of this.#sockets) socket.destroy();
        this.#sockets.clear();
        await new Promise((resolvePromise) => server.close(() => resolvePromise()));
      }
      this.#endpoint = null;
      this.#jobId = null;
      this.#generation = null;
    })().finally(() => {
      this.#stopPromise = null;
    });
    return this.#stopPromise;
  }
}
