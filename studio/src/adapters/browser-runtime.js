import { execFile, spawn } from "node:child_process";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import { McpGateway } from "./mcp-gateway.js";
import { killProcessTree } from "../process/process-runner.js";
import {
  scavengeEphemeralSecrets,
  withEphemeralSecrets,
} from "../security/ephemeral-secrets.js";

const EXPECTED_MCP_VERSION = "0.0.78";
const execFileAsync = promisify(execFile);
const JOB_ID = /^(?:job-[a-z0-9]{16,64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const MAX_READINESS_BYTES = 512 * 1024;
const MAX_READINESS_LINE_BYTES = 64 * 1024;
const MAX_MCP_RESPONSE_BYTES = 1024 * 1024;
const EXPECTED_MCP_TOOL_INVENTORY_HASH = "cf2da181b4a8ce33d9e3f228dca5ffc86604b0a982ce993a7177a3273dd998ac";
const EXPECTED_MCP_TOOL_NAMES = Object.freeze([
  "browser_close", "browser_resize", "browser_console_messages", "browser_resume",
  "browser_highlight", "browser_hide_highlight", "browser_annotate", "browser_handle_dialog",
  "browser_evaluate", "browser_file_upload", "browser_drop", "browser_find",
  "browser_fill_form", "browser_press_key", "browser_type", "browser_navigate",
  "browser_navigate_back", "browser_network_requests", "browser_network_request",
  "browser_run_code_unsafe", "browser_take_screenshot", "browser_snapshot", "browser_click",
  "browser_drag", "browser_hover", "browser_select_option", "browser_tabs",
  "browser_start_tracing", "browser_stop_tracing", "browser_start_video", "browser_stop_video",
  "browser_video_chapter", "browser_video_show_actions", "browser_video_hide_actions",
  "browser_wait_for",
]);
const SELECTOR = /^(?:#[A-Za-z][A-Za-z0-9_-]{0,80}|\[name="[A-Za-z][A-Za-z0-9_.:-]{0,80}"\]|input\[type="(?:email|password|text)"\]|button\[type="submit"\])$/u;
const MCP_ENVIRONMENT_ALLOWLIST = new Set([
  "COMSPEC",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "WINDIR",
]);
const OPTION_KEYS = new Set([
  "studioRoot",
  "mcpPackageDir",
  "port",
  "rawPort",
  "env",
  "readinessTimeoutMs",
  "spawnProcess",
  "verifyMcpReady",
  "stopRequest",
  "killTree",
  "waitForPortClosed",
  "verifyPortOwner",
  "gatewayFactory",
  "onFatal",
]);

export class BrowserRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BrowserRuntimeError";
    this.code = code;
  }

  toJSON() {
    return Object.freeze({ name: this.name, code: this.code, message: this.message });
  }
}

function runtimeError(code, message) {
  return new BrowserRuntimeError(code, message);
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsidePath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertPlainDirectory(directory) {
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("unsafe directory");
  const resolved = await realpath(directory);
  if (pathKey(resolved) !== pathKey(directory)) throw new Error("reparse directory");
  return status;
}

async function ensureDirectoryChain(boundary, target, { exclusiveTarget = false } = {}) {
  const root = path.resolve(boundary);
  const destination = path.resolve(target);
  if (!isInsidePath(root, destination) || pathKey(root) === pathKey(destination)) {
    throw new Error("path boundary");
  }
  await assertPlainDirectory(root);
  const parts = path.relative(root, destination).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const exclusive = exclusiveTarget && index === parts.length - 1;
    try {
      await mkdir(current, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (exclusive || error?.code !== "EEXIST") throw error;
    }
    await assertPlainDirectory(current);
  }
}

async function captureDirectoryIdentity(directory) {
  const status = await assertPlainDirectory(directory);
  return Object.freeze({
    real: await realpath(directory),
    dev: status.dev,
    ino: status.ino,
  });
}

async function removeEntryNoFollow(entry, rootReal) {
  let status;
  try {
    status = await lstat(entry);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (status.isSymbolicLink()) {
    await unlink(entry);
    return;
  }
  if (!status.isDirectory()) {
    await unlink(entry);
    return;
  }
  const resolved = await realpath(entry);
  if (!isInsidePath(rootReal, resolved) || pathKey(resolved) !== pathKey(entry)) {
    throw new Error("unsafe cleanup directory");
  }
  for (const name of await readdir(entry)) {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new Error("unsafe cleanup entry");
    }
    await removeEntryNoFollow(path.join(entry, name), rootReal);
  }
  await rmdir(entry);
}

async function removeOwnedDirectory(directory, identity) {
  let status;
  try {
    status = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("owned directory replaced");
  const resolved = await realpath(directory);
  if (
    pathKey(resolved) !== pathKey(identity.real) ||
    status.dev !== identity.dev ||
    status.ino !== identity.ino
  ) {
    throw new Error("owned directory identity changed");
  }
  await removeEntryNoFollow(directory, identity.real);
}

function childHasStopped(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try {
    process.kill(child.pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

async function waitForChildStopped(child, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childHasStopped(child)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  return childHasStopped(child);
}

async function withDeadline(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withAbortDeadline(promise, signal, timeoutMs, message) {
  let abortHandler;
  const aborted = new Promise((_, rejectPromise) => {
    abortHandler = () => rejectPromise(new Error(message));
    if (signal.aborted) abortHandler();
    else signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    return await withDeadline(Promise.race([promise, aborted]), timeoutMs, message);
  } finally {
    signal.removeEventListener("abort", abortHandler);
  }
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

function canonicalOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) throw new Error("origin");
  const parsed = new URL(value);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.origin !== value ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("origin");
  }
  return parsed.origin;
}

function canonicalTargetUrl(value, targetOrigin) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) throw new Error("target URL");
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.origin !== targetOrigin
  ) {
    throw new Error("target URL");
  }
  return parsed.href;
}

function readOriginArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 32) {
    throw new Error("origins");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)))
  ) {
    throw new Error("origins");
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error("origins");
    result.push(canonicalOrigin(descriptor.value));
  }
  return Object.freeze([...new Set(result)].sort());
}

function policyPayload(targetOrigin, authOrigins, resourceOrigins) {
  return JSON.stringify({ targetOrigin, authOrigins, resourceOrigins });
}

function policyDigest(targetOrigin, authOrigins, resourceOrigins) {
  return createHash("sha256")
    .update(policyPayload(targetOrigin, authOrigins, resourceOrigins), "utf8")
    .digest("hex");
}

export function createOriginPolicy({ targetOrigin, authOrigins = [], resourceOrigins = [] } = {}) {
  try {
    const target = canonicalOrigin(targetOrigin);
    const auth = readOriginArray(authOrigins);
    const resources = readOriginArray(resourceOrigins);
    return Object.freeze({
      targetOrigin: target,
      authOrigins: auth,
      resourceOrigins: resources,
      digest: policyDigest(target, auth, resources),
    });
  } catch {
    throw runtimeError("INVALID_ORIGIN_POLICY", "The browser origin policy is invalid.");
  }
}

function validateOriginPolicy(policy) {
  if (!isPlain(policy)) throw new Error("policy");
  const keys = Reflect.ownKeys(policy);
  if (
    keys.length !== 4 ||
    keys.some((key) => !["targetOrigin", "authOrigins", "resourceOrigins", "digest"].includes(key))
  ) {
    throw new Error("policy");
  }
  const targetOrigin = canonicalOrigin(dataValue(policy, "targetOrigin", true));
  const authOrigins = readOriginArray(dataValue(policy, "authOrigins", true));
  const resourceOrigins = readOriginArray(dataValue(policy, "resourceOrigins", true));
  const digest = dataValue(policy, "digest", true);
  if (
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(digest) ||
    digest !== policyDigest(targetOrigin, authOrigins, resourceOrigins)
  ) {
    throw new Error("digest");
  }
  return Object.freeze({ targetOrigin, authOrigins, resourceOrigins, digest });
}

function readSelectors(value) {
  if (!isPlain(value)) throw new Error("selectors");
  if (Reflect.ownKeys(value).some((key) => !["username", "password", "submit"].includes(key))) {
    throw new Error("selectors");
  }
  const defaults = {
    username: '[name="username"]',
    password: '[name="password"]',
    submit: 'button[type="submit"]',
  };
  const result = {};
  for (const key of Object.keys(defaults)) {
    const selected = dataValue(value, key) ?? defaults[key];
    if (typeof selected !== "string" || !SELECTOR.test(selected)) throw new Error("selector");
    result[key] = selected;
  }
  return Object.freeze(result);
}

function readAuth(value, originPolicy) {
  if (!isPlain(value)) throw new Error("auth");
  const mode = dataValue(value, "mode", true);
  if (mode === "manual") {
    if (Reflect.ownKeys(value).length !== 1) throw new Error("manual auth");
    return Object.freeze({ mode });
  }
  if (mode !== "automatic" || Reflect.ownKeys(value).some((key) => !["mode", "loginOrigin", "username", "password", "selectors"].includes(key))) {
    throw new Error("auth");
  }
  const loginOrigin = canonicalOrigin(dataValue(value, "loginOrigin", true));
  const username = dataValue(value, "username", true);
  const password = dataValue(value, "password", true);
  const selectors = readSelectors(dataValue(value, "selectors") ?? {});
  if (
    !originPolicy.authOrigins.includes(loginOrigin) ||
    typeof username !== "string" || username.length === 0 || username.length > 256 || /[\0\r\n]/u.test(username) ||
    typeof password !== "string" || password.length === 0 || password.length > 4096 || /[\0\r\n]/u.test(password)
  ) {
    throw new Error("auth");
  }
  return Object.freeze({ mode, loginOrigin, username, password, selectors });
}

function validateJob(job) {
  try {
    if (!isPlain(job) || Reflect.ownKeys(job).some((key) => !["id", "targetUrl", "originPolicy", "blockedOrigins", "auth"].includes(key))) {
      throw new Error("job");
    }
    const id = dataValue(job, "id", true);
    const originPolicy = validateOriginPolicy(dataValue(job, "originPolicy", true));
    const targetUrl = canonicalTargetUrl(dataValue(job, "targetUrl", true), originPolicy.targetOrigin);
    const blockedOrigins = readOriginArray(dataValue(job, "blockedOrigins") ?? []);
    const auth = readAuth(dataValue(job, "auth", true), originPolicy);
    const allowed = Object.freeze([
      ...new Set([
        originPolicy.targetOrigin,
        ...originPolicy.authOrigins,
        ...originPolicy.resourceOrigins,
      ]),
    ].sort());
    const navigationAllowed = Object.freeze([
      ...new Set([originPolicy.targetOrigin, ...originPolicy.authOrigins]),
    ].sort());
    if (
      typeof id !== "string" ||
      !JOB_ID.test(id) ||
      blockedOrigins.some((origin) => allowed.includes(origin))
    ) {
      throw new Error("job");
    }
    return Object.freeze({ id, targetUrl, originPolicy, allowed, navigationAllowed, blockedOrigins, auth });
  } catch {
    throw runtimeError("INVALID_BROWSER_JOB", "The browser job is invalid.");
  }
}

function sanitizeMcpEnvironment(environment) {
  if (!isPlain(environment)) throw new Error("environment");
  const output = Object.create(null);
  const seen = new Set();
  for (const key of Reflect.ownKeys(environment)) {
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    if (
      typeof key !== "string" || !descriptor || !("value" in descriptor) || !descriptor.enumerable ||
      typeof descriptor.value !== "string" || key.includes("=") || key.includes("\0") || descriptor.value.includes("\0")
    ) {
      throw new Error("environment");
    }
    const normalized = key.toUpperCase();
    if (seen.has(normalized)) throw new Error("environment");
    seen.add(normalized);
    if (MCP_ENVIRONMENT_ALLOWLIST.has(normalized)) {
      output[key] = descriptor.value;
    }
  }
  return output;
}

async function isLoopbackPortOpen(port) {
  return await new Promise((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(200, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function defaultWaitForPortClosed(port, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isLoopbackPortOpen(port))) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  if (await isLoopbackPortOpen(port)) throw new Error("port still open");
}

const OWNER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$root = [int]$args[0]
$port = [int]$args[1]
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId
$owned = [System.Collections.Generic.HashSet[int]]::new()
[void]$owned.Add($root)
do {
  $changed = $false
  foreach ($process in $all) {
    if ($owned.Contains([int]$process.ParentProcessId) -and $owned.Add([int]$process.ProcessId)) {
      $changed = $true
    }
  }
} while ($changed)
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop)
if ($listeners.Count -ne 1) { exit 19 }
$listener = $listeners[0]
if ($listener.LocalAddress -ne '127.0.0.1' -or -not $owned.Contains([int]$listener.OwningProcess)) { exit 19 }
`;
const OWNER_SCRIPT_BASE64 = Buffer.from(OWNER_SCRIPT, "utf16le").toString("base64");

async function defaultVerifyPortOwner(port, pid, signal) {
  if (process.platform !== "win32") return;
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  await execFileAsync(
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      OWNER_SCRIPT_BASE64,
      String(pid),
      String(port),
    ],
    { encoding: "utf8", timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024, signal },
  );
}

function chooseRawPort(publicPort, previousPort) {
  let selected;
  do selected = randomInt(49_152, 65_536);
  while (selected === publicPort || selected === previousPort);
  return selected;
}

function inspectOptions(options) {
  if (!isPlain(options) || Reflect.ownKeys(options).some((key) => typeof key !== "string" || !OPTION_KEYS.has(key))) {
    throw new Error("options");
  }
  const studioRoot = dataValue(options, "studioRoot", true);
  const mcpPackageDir = dataValue(options, "mcpPackageDir", true);
  const port = dataValue(options, "port") ?? 8931;
  const rawPort = dataValue(options, "rawPort");
  const env = sanitizeMcpEnvironment(dataValue(options, "env") ?? process.env);
  const readinessTimeoutMs = dataValue(options, "readinessTimeoutMs") ?? 30_000;
  const spawnProcess = dataValue(options, "spawnProcess") ?? spawn;
  const verifyMcpReady = dataValue(options, "verifyMcpReady") ?? verifyPlaywrightMcpReady;
  const stopRequest = dataValue(options, "stopRequest") ?? defaultStopRequest;
  const killTree = dataValue(options, "killTree") ?? killProcessTree;
  const waitForPortClosed = dataValue(options, "waitForPortClosed") ?? defaultWaitForPortClosed;
  const verifyPortOwner = dataValue(options, "verifyPortOwner") ?? defaultVerifyPortOwner;
  const gatewayFactory = dataValue(options, "gatewayFactory") ?? ((settings) => new McpGateway(settings));
  const onFatal = dataValue(options, "onFatal") ?? (async () => undefined);
  if (
    typeof studioRoot !== "string" || !path.isAbsolute(studioRoot) ||
    typeof mcpPackageDir !== "string" || mcpPackageDir !== path.join(studioRoot, "node_modules", "@playwright", "mcp") ||
    !Number.isSafeInteger(port) || port < 1 || port > 65_535 ||
    (rawPort !== undefined && (!Number.isSafeInteger(rawPort) || rawPort < 1 || rawPort > 65_535 || rawPort === port)) ||
    !Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs < 100 || readinessTimeoutMs > 120_000 ||
    typeof spawnProcess !== "function" || typeof verifyMcpReady !== "function" || typeof stopRequest !== "function" || typeof killTree !== "function" ||
    typeof waitForPortClosed !== "function" || typeof verifyPortOwner !== "function" ||
    typeof gatewayFactory !== "function" || typeof onFatal !== "function"
  ) {
    throw new Error("options");
  }
  return Object.freeze({
    studioRoot,
    mcpPackageDir,
    port,
    rawPort,
    env,
    readinessTimeoutMs,
    spawnProcess,
    verifyMcpReady,
    stopRequest,
    killTree,
    waitForPortClosed,
    verifyPortOwner,
    gatewayFactory,
    onFatal,
  });
}

function validateOptions(options) {
  try {
    return inspectOptions(options);
  } catch {
    throw runtimeError("INVALID_BROWSER_RUNTIME_OPTIONS", "The browser runtime options are invalid.");
  }
}

async function parseMcpResponse(response) {
  let text;
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_MCP_RESPONSE_BYTES) throw new Error("MCP response too large");
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    text = Buffer.concat(chunks, bytes).toString("utf8");
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > MAX_MCP_RESPONSE_BYTES) throw new Error("MCP response too large");
  }
  const dataLine = text.split(/\r?\n/u).filter((line) => line.startsWith("data:")).at(-1);
  try {
    return JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
  } catch {
    throw new Error("invalid MCP response");
  }
}

export function validateMcpToolInventory(value) {
  try {
    if (!isPlain(value) || !isPlain(value.result)) throw new Error("inventory");
    const tools = value.result.tools;
    if (!Array.isArray(tools) || Object.getPrototypeOf(tools) !== Array.prototype) throw new Error("inventory");
    const names = tools.map((tool) => isPlain(tool) ? dataValue(tool, "name", true) : undefined);
    if (
      names.length !== EXPECTED_MCP_TOOL_NAMES.length ||
      new Set(names).size !== EXPECTED_MCP_TOOL_NAMES.length ||
      names.some((name, index) => name !== EXPECTED_MCP_TOOL_NAMES[index])
    ) {
      throw new Error("inventory names");
    }
    const digest = createHash("sha256").update(JSON.stringify(tools), "utf8").digest("hex");
    if (digest !== EXPECTED_MCP_TOOL_INVENTORY_HASH) throw new Error("inventory schema");
    return Object.freeze({ valid: true, digest });
  } catch {
    throw runtimeError("BROWSER_RUNTIME_TOOL_DRIFT", "The Playwright MCP tool inventory is unsafe.");
  }
}

export async function verifyPlaywrightMcpReady(endpoint, { signal, fetchImpl = fetch }) {
  const probe = await fetchImpl(endpoint, { method: "GET", signal });
  if (probe.status !== 400) throw new Error("MCP endpoint probe failed");
  const headers = { Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
  const initialize = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "manual-video-studio-readiness", version: "1" } } }),
    signal,
  });
  if (!initialize.ok) throw new Error("MCP initialize failed");
  const initialized = await parseMcpResponse(initialize);
  if (initialized.error || !initialized.result) throw new Error("MCP initialize failed");
  const sessionId = initialize.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("MCP session missing");
  const sessionHeaders = { ...headers, "mcp-session-id": sessionId };
  await fetchImpl(endpoint, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal,
  });
  try {
    const toolList = await fetchImpl(endpoint, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      signal,
    });
    if (!toolList.ok) throw new Error("MCP tool inventory failed");
    validateMcpToolInventory(await parseMcpResponse(toolList));
    const snapshot = await fetchImpl(endpoint, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } }),
      signal,
    });
    if (!snapshot.ok) throw new Error("MCP browser readiness failed");
    const value = await parseMcpResponse(snapshot);
    if (value.error || value.result?.isError === true) throw new Error("MCP browser readiness failed");
    return Object.freeze({ sessionId });
  } finally {
    await fetchImpl(endpoint, { method: "DELETE", headers: sessionHeaders, signal }).catch(() => undefined);
  }
}

async function defaultStopRequest(endpoint, headers) {
  await fetch(endpoint, { method: "POST", headers, signal: AbortSignal.timeout(2_000) });
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

function startOptions(options) {
  try {
    if (!isPlain(options) || Reflect.ownKeys(options).some((key) => !["signal", "expectedOriginPolicyDigest", "mcpCapabilityToken"].includes(key))) throw new Error("options");
    const signal = dataValue(options, "signal");
    const expectedOriginPolicyDigest = dataValue(options, "expectedOriginPolicyDigest", true);
    const mcpCapabilityToken = dataValue(options, "mcpCapabilityToken", true);
    if (signal !== undefined && (typeof signal !== "object" || Object.getPrototypeOf(signal) !== AbortSignal.prototype)) throw new Error("signal");
    if (typeof expectedOriginPolicyDigest !== "string" || !/^[a-f0-9]{64}$/u.test(expectedOriginPolicyDigest)) throw new Error("digest");
    if (
      typeof mcpCapabilityToken !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(mcpCapabilityToken) ||
      Buffer.from(mcpCapabilityToken, "base64url").length !== 32 ||
      Buffer.from(mcpCapabilityToken, "base64url").toString("base64url") !== mcpCapabilityToken
    ) {
      throw new Error("capability");
    }
    return { expectedOriginPolicyDigest, mcpCapabilityToken, signal };
  } catch {
    throw runtimeError("INVALID_BROWSER_START_OPTIONS", "The browser start options are invalid.");
  }
}

export class BrowserRuntime {
  #settings;
  #active = null;
  #child = null;
  #gateway = null;
  #configDirectory = null;
  #configIdentity = null;
  #cleanupPromise = null;
  #stopPromise = null;
  #stopping = false;
  #starting = false;
  #abortSignal = null;
  #abortHandler = null;
  #generation = 0;
  #rawPortMayBeOpen = false;
  #rawPort = null;
  #lastRawPort = null;
  #startAbort = null;
  #startDone = Promise.resolve();
  #finishStart = null;

  constructor(options) {
    this.#settings = validateOptions(options);
  }

  get active() {
    return this.#gateway?.active ?? this.#active;
  }

  installApproval(input) {
    if (!this.#active || !this.#gateway) {
      throw runtimeError("BROWSER_RUNTIME_INACTIVE", "The browser runtime is not active.");
    }
    try {
      const installed = this.#gateway.installApproval(input);
      this.#active = this.#gateway.active;
      return installed;
    } catch (error) {
      if (error instanceof BrowserRuntimeError) throw error;
      throw runtimeError("BROWSER_RUNTIME_APPROVAL_FAILED", "The browser approval could not be installed.");
    }
  }

  #completeStartBarrier(controller) {
    if (this.#startAbort !== controller) return;
    this.#startAbort = null;
    const finish = this.#finishStart;
    this.#finishStart = null;
    finish?.();
  }

  async start(jobInput, options = {}) {
    const job = validateJob(jobInput);
    const { expectedOriginPolicyDigest, mcpCapabilityToken, signal } = startOptions(options);
    if (
      !timingSafeEqual(
        Buffer.from(job.originPolicy.digest, "ascii"),
        Buffer.from(expectedOriginPolicyDigest, "ascii"),
      )
    ) {
      throw runtimeError("INVALID_BROWSER_JOB", "The browser job is invalid.");
    }
    if (this.#active || this.#child || this.#gateway || this.#configDirectory || this.#rawPortMayBeOpen || this.#starting || this.#stopping) {
      throw runtimeError("BROWSER_RUNTIME_BUSY", "A browser runtime is already active.");
    }
    if (signal?.aborted) throw runtimeError("BROWSER_RUNTIME_ABORTED", "The browser runtime start was aborted.");
    this.#starting = true;
    const generation = ++this.#generation;
    const rawPort = this.#settings.rawPort ?? chooseRawPort(this.#settings.port, this.#lastRawPort);
    this.#rawPort = rawPort;
    this.#lastRawPort = rawPort;
    const assertCurrentGeneration = () => {
      if (this.#generation !== generation || this.#stopping) {
        this.#starting = false;
        throw runtimeError("BROWSER_RUNTIME_ABORTED", "The browser runtime start was aborted.");
      }
    };

    const manifestPath = path.join(this.#settings.mcpPackageDir, "package.json");
    const cliPath = path.join(this.#settings.mcpPackageDir, "cli.js");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest.version !== EXPECTED_MCP_VERSION || manifest.bin?.["playwright-mcp"] !== "cli.js") throw new Error("version");
      await readFile(cliPath);
    } catch {
      this.#starting = false;
      throw runtimeError("BROWSER_RUNTIME_VERSION_MISMATCH", "The Playwright MCP runtime is not the pinned version.");
    }
    assertCurrentGeneration();

    const bootstrap = path.join(this.#settings.studioRoot, "src", "browser", "browser-bootstrap-init.cjs");
    const runtimeRoot = path.join(this.#settings.studioRoot, ".runtime");
    const secretsRoot = path.join(runtimeRoot, "secrets");
    const configDirectory = path.join(runtimeRoot, "browser", job.id);
    const configPath = path.join(configDirectory, "mcp-config.json");
    const outputDir = path.join(this.#settings.studioRoot, "data", "jobs", job.id, "browser");
    const profileDir = path.join(this.#settings.studioRoot, "data", "browser-profile");
    let preparedConfigIdentity = null;
    try {
      await scavengeEphemeralSecrets(secretsRoot);
      await ensureDirectoryChain(this.#settings.studioRoot, path.dirname(configDirectory));
      await ensureDirectoryChain(this.#settings.studioRoot, configDirectory, { exclusiveTarget: true });
      preparedConfigIdentity = await captureDirectoryIdentity(configDirectory);
      await ensureDirectoryChain(this.#settings.studioRoot, outputDir);
      await ensureDirectoryChain(this.#settings.studioRoot, profileDir);
      assertCurrentGeneration();
    } catch (error) {
      if (preparedConfigIdentity) {
        await removeOwnedDirectory(configDirectory, preparedConfigIdentity).catch(() => undefined);
      }
      this.#starting = false;
      if (error instanceof BrowserRuntimeError) throw error;
      throw runtimeError("BROWSER_RUNTIME_PATH_UNSAFE", "A browser runtime path is unsafe.");
    }
    const config = {
      browser: {
        browserName: "chromium",
        isolated: false,
        userDataDir: profileDir,
        launchOptions: { channel: "msedge", headless: false },
        contextOptions: { viewport: { width: 1920, height: 1080 }, serviceWorkers: "block" },
        initPage: [bootstrap],
      },
      server: {
        host: "127.0.0.1",
        port: rawPort,
        allowedHosts: [`127.0.0.1:${rawPort}`, `localhost:${rawPort}`],
      },
      capabilities: ["core", "devtools"],
      saveSession: true,
      sharedBrowserContext: true,
      outputDir,
      network: { allowedOrigins: [...job.allowed], blockedOrigins: [...job.blockedOrigins] },
    };
    try {
      await writeJsonAtomic(configPath, config);
      this.#configDirectory = configDirectory;
      this.#configIdentity = preparedConfigIdentity;
      assertCurrentGeneration();
    } catch (error) {
      await removeOwnedDirectory(configDirectory, preparedConfigIdentity).catch(() => undefined);
      this.#starting = false;
      if (error instanceof BrowserRuntimeError) throw error;
      throw runtimeError("BROWSER_RUNTIME_PATH_UNSAFE", "A browser runtime path is unsafe.");
    }

    const internalStartAbort = new AbortController();
    const startSignal = signal
      ? AbortSignal.any([signal, internalStartAbort.signal])
      : internalStartAbort.signal;
    this.#startAbort = internalStartAbort;
    this.#startDone = new Promise((resolvePromise) => {
      this.#finishStart = resolvePromise;
    });

    const launch = async (secretsFile) => {
      assertCurrentGeneration();
      const env = {
        ...this.#settings.env,
        MANUAL_STUDIO_ALLOWED_ORIGINS: JSON.stringify(job.allowed),
        MANUAL_STUDIO_NAVIGATION_ORIGINS: JSON.stringify(job.navigationAllowed),
        MANUAL_STUDIO_AUTH_MODE: job.auth.mode,
        MANUAL_STUDIO_TARGET_URL: job.targetUrl,
      };
      if (secretsFile) env.PLAYWRIGHT_MCP_SECRETS_FILE = secretsFile;
      if (job.auth.mode === "automatic") {
        env.MANUAL_STUDIO_LOGIN_ORIGIN = job.auth.loginOrigin;
        env.MANUAL_STUDIO_LOGIN_USERNAME = job.auth.username;
        env.MANUAL_STUDIO_LOGIN_PASSWORD = job.auth.password;
        env.MANUAL_STUDIO_USERNAME_SELECTOR = job.auth.selectors.username;
        env.MANUAL_STUDIO_PASSWORD_SELECTOR = job.auth.selectors.password;
        env.MANUAL_STUDIO_SUBMIT_SELECTOR = job.auth.selectors.submit;
      }
      let child;
      try {
        child = this.#settings.spawnProcess(
          process.execPath,
          ["--require", bootstrap, cliPath, "--config", configPath],
          { cwd: outputDir, env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
      } catch {
        throw new Error("spawn");
      }
      this.#child = child;
      this.#rawPortMayBeOpen = true;
      child.once?.("close", () => {
        if (this.#generation === generation && this.#child === child && !this.#stopping) {
          void this.#handleUnexpectedClose(child, generation);
        }
      });
      let sawListening = false;
      let outputBytes = 0;
      let failed = false;
      const consume = (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_READINESS_BYTES) { failed = true; return; }
        for (const line of chunk.toString("utf8").split(/\r?\n/u)) {
          if (Buffer.byteLength(line) > MAX_READINESS_LINE_BYTES) { failed = true; return; }
          if (line.includes(`Listening on http://localhost:${rawPort}`)) sawListening = true;
        }
      };
      child.stdout?.on("data", consume);
      child.stderr?.on("data", consume);
      child.once?.("error", () => { failed = true; });
      const deadline = Date.now() + this.#settings.readinessTimeoutMs;
      while (!sawListening && !failed && Date.now() < deadline) {
        assertCurrentGeneration();
        if (startSignal.aborted) throw runtimeError("BROWSER_RUNTIME_ABORTED", "The browser runtime start was aborted.");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
      if (!sawListening || failed || child.exitCode !== null || child.signalCode !== null) throw new Error("readiness");
      const readinessSignal = AbortSignal.any([AbortSignal.timeout(this.#settings.readinessTimeoutMs), startSignal]);
      await withAbortDeadline(
        Promise.resolve().then(() => this.#settings.verifyPortOwner(rawPort, child.pid, readinessSignal)),
        startSignal,
        this.#settings.readinessTimeoutMs,
        "MCP owner verification stopped",
      );
      await withAbortDeadline(
        Promise.resolve().then(() => this.#settings.verifyMcpReady(
          `http://127.0.0.1:${rawPort}/mcp`,
          Object.freeze({ signal: readinessSignal, secretsFile }),
        )),
        startSignal,
        this.#settings.readinessTimeoutMs,
        "MCP readiness stopped",
      );
      assertCurrentGeneration();
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("closed");
    };

    try {
      if (job.auth.mode === "automatic") {
        await withEphemeralSecrets(
          secretsRoot,
          { username: job.auth.username, password: job.auth.password },
          launch,
          { signal: startSignal },
        );
      } else {
        await launch(undefined);
      }
      assertCurrentGeneration();
      if (!this.#child || this.#child.exitCode !== null || this.#child.signalCode !== null) throw new Error("closed");
      let gateway;
      try {
        gateway = this.#settings.gatewayFactory(Object.freeze({
          upstreamUrl: `http://127.0.0.1:${rawPort}/mcp`,
          port: this.#settings.port,
          capabilityToken: mcpCapabilityToken,
          onFatal: async (event) => this.#handleGatewayFatal(event, generation),
        }));
        if (
          !gateway ||
          typeof gateway !== "object" ||
          typeof gateway.start !== "function" ||
          typeof gateway.stop !== "function" ||
          typeof gateway.quarantine !== "function" ||
          typeof gateway.installApproval !== "function"
        ) {
          throw new Error("gateway");
        }
        this.#gateway = gateway;
        await withAbortDeadline(
          Promise.resolve().then(() => gateway.start({ jobId: job.id, generation })),
          startSignal,
          this.#settings.readinessTimeoutMs,
          "MCP gateway start stopped",
        );
      } catch (error) {
        if (gateway && typeof gateway.stop === "function") {
          try {
            await gateway.stop();
            if (this.#gateway === gateway) this.#gateway = null;
          } catch {
            throw runtimeError("BROWSER_RUNTIME_STOP_FAILED", "The browser runtime could not stop safely.");
          }
        }
        if (error instanceof BrowserRuntimeError) throw error;
        throw new Error("gateway");
      }
      assertCurrentGeneration();
      if (!this.#child || this.#child.exitCode !== null || this.#child.signalCode !== null) throw new Error("closed");
      const active = gateway.active;
      if (
        !active ||
        active.endpoint !== `http://127.0.0.1:${this.#settings.port}/mcp` ||
        active.jobId !== job.id ||
        active.generation !== generation ||
        active.phase !== "planning"
      ) {
        throw new Error("gateway");
      }
      this.#active = active;
      this.#starting = false;
      if (signal) {
        this.#abortSignal = signal;
        this.#abortHandler = () => {
          const stopping = this.stop();
          stopping.catch(() => undefined);
        };
        signal.addEventListener("abort", this.#abortHandler, { once: true });
        if (signal.aborted) {
          void this.stop();
          throw runtimeError("BROWSER_RUNTIME_ABORTED", "The browser runtime start was aborted.");
        }
      }
      return active;
    } catch (error) {
      this.#starting = false;
      this.#completeStartBarrier(internalStartAbort);
      let stopFailure;
      try {
        await this.stop();
      } catch (candidate) {
        stopFailure = candidate;
      }
      if (stopFailure instanceof BrowserRuntimeError) throw stopFailure;
      if (error instanceof BrowserRuntimeError) throw error;
      if (startSignal.aborted) {
        throw runtimeError("BROWSER_RUNTIME_ABORTED", "The browser runtime start was aborted.");
      }
      throw runtimeError("BROWSER_RUNTIME_START_FAILED", "The browser runtime could not start.");
    } finally {
      this.#completeStartBarrier(internalStartAbort);
    }
  }

  async #handleGatewayFatal(event, generation) {
    if (this.#generation !== generation || !this.#gateway) return;
    const stopping = this.stop();
    stopping.catch(() => undefined);
    try {
      await this.#settings.onFatal(event);
    } finally {
      await stopping;
    }
  }

  async #handleUnexpectedClose(child, generation) {
    if (this.#generation !== generation || this.#child !== child) return;
    const gateway = this.#gateway;
    this.#child = null;
    this.#active = null;
    if (this.#abortSignal && this.#abortHandler) {
      this.#abortSignal.removeEventListener("abort", this.#abortHandler);
    }
    this.#abortSignal = null;
    this.#abortHandler = null;
    if (gateway) {
      await gateway.quarantine("RAW_MCP_CLOSED").catch(() => undefined);
      await gateway.stop().catch(() => undefined);
    }
    try {
      await this.#settings.waitForPortClosed(this.#rawPort);
      this.#rawPortMayBeOpen = false;
    } catch {
      return;
    }
    if (!this.#starting && this.#gateway === gateway) this.#gateway = null;
    await this.#cleanupConfig().catch(() => undefined);
  }

  async #cleanupConfig() {
    if (this.#cleanupPromise) return this.#cleanupPromise;
    const directory = this.#configDirectory;
    const identity = this.#configIdentity;
    if (!directory || !identity) return;
    this.#cleanupPromise = (async () => {
      try {
        await removeOwnedDirectory(directory, identity);
      } catch {
        throw runtimeError("BROWSER_RUNTIME_CLEANUP_FAILED", "The browser runtime files could not be cleaned safely.");
      }
      if (this.#configDirectory === directory && this.#configIdentity === identity) {
        this.#configDirectory = null;
        this.#configIdentity = null;
      }
    })().finally(() => {
      this.#cleanupPromise = null;
    });
    return this.#cleanupPromise;
  }

  async stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    this.#generation += 1;
    const startAbort = this.#startAbort;
    const startDone = this.#startDone;
    startAbort?.abort();
    this.#stopPromise = (async () => {
      const gateway = this.#gateway;
      const child = this.#child;
      if (this.#abortSignal && this.#abortHandler) {
        this.#abortSignal.removeEventListener("abort", this.#abortHandler);
      }
      this.#abortSignal = null;
      this.#abortHandler = null;
      const startSettlement = withDeadline(startDone, 2_000, "browser start settlement timeout");
      const gatewayStop = (async () => {
        if (!gateway) return true;
        await withDeadline(Promise.resolve().then(() => gateway.stop()), 2_000, "gateway stop timeout");
        return true;
      })();
      const rawStop = (async () => {
        let childStopped = true;
        if (child) {
          try {
            await this.#settings.stopRequest(
              `http://127.0.0.1:${this.#rawPort}/killkillkill`,
              { "x-pw-mcp-kill": "1" },
            );
          } catch {
            // The process-tree fallback below is authoritative.
          }
          const deadline = Date.now() + 250;
          while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
          }
          if (child.exitCode === null && child.signalCode === null) {
            try {
              await this.#settings.killTree(child);
            } catch {
              // The explicit stopped-state check below is authoritative.
            }
          }
          if (!(await waitForChildStopped(child))) {
            childStopped = false;
          }
        }
        if (this.#rawPortMayBeOpen) {
          try {
            await this.#settings.waitForPortClosed(this.#rawPort);
            this.#rawPortMayBeOpen = false;
          } catch {
            childStopped = false;
          }
        }
        return childStopped;
      })();
      const [startResult, gatewayResult, rawResult] = await Promise.allSettled([startSettlement, gatewayStop, rawStop]);
      if (
        startResult.status === "rejected" ||
        gatewayResult.status === "rejected" ||
        rawResult.status === "rejected" ||
        rawResult.value !== true
      ) {
        throw runtimeError("BROWSER_RUNTIME_STOP_FAILED", "The browser runtime could not stop safely.");
      }
      this.#gateway = null;
      this.#child = null;
      this.#active = null;
      this.#rawPort = null;
      await this.#cleanupConfig();
    })().finally(() => {
      this.#stopping = false;
      this.#stopPromise = null;
    });
    return this.#stopPromise;
  }
}
