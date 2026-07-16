import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { verifyLoopbackPortOwner } from "./browser-runtime.js";
import {
  sanitizeOpenCodeEnvironment,
  sanitizeOpenCodeServerEnvironment,
} from "./opencode-client.js";
import { killProcessTree, runProcess } from "../process/process-runner.js";
import {
  resolveOpenCodeExecutable,
  supportsOpenCodeVersion,
} from "../runtime/opencode-installation.js";
import { createRedactor } from "../security/redactor.js";

const MAX_READINESS_LINE_BYTES = 64 * 1024;
const MAX_READINESS_BYTES = 512 * 1024;
const MAX_CONTRACT_BYTES = 2 * 1024 * 1024;
const TRUSTED_PROJECT_DIGEST = "bdad2488e3f7bb89b4f7f2a1611ad76262a29996de3c0f7ec1e34f77e2b094b6";
const JOB_ID = /^(?:job-[a-z0-9]{16,64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const MCP_CAPABILITY_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const AGENT_TOOLS = Object.freeze({
  "manual-video-planner": Object.freeze([
    "playwright_browser_snapshot",
    "playwright_browser_wait_for",
    "playwright_browser_take_screenshot",
  ]),
  "manual-video-executor": Object.freeze([
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
const FORBIDDEN_PERMISSIONS = Object.freeze([
  "bash",
  "edit",
  "external_directory",
  "question",
  "task",
  "webfetch",
  "websearch",
  "playwright_browser_navigate",
  "playwright_browser_navigate_back",
  "playwright_browser_tabs",
  "playwright_browser_evaluate",
  "playwright_browser_file_upload",
  "playwright_browser_network_state_set",
  "playwright_browser_run_code_unsafe",
  "playwright_browser_storage_state",
]);
const PINNED_TOOL_IDS = Object.freeze([
  "invalid", "question", "bash", "read", "glob", "grep", "edit", "write", "task",
  "webfetch", "todowrite", "websearch", "skill", "apply_patch",
]);
const PINNED_AGENT_NAMES = Object.freeze([
  "build", "compaction", "explore", "general", "manual-video-executor",
  "manual-video-planner", "plan", "summary", "title",
]);
const RESOLVED_CONFIG_KEYS = Object.freeze([
  "$schema", "agent", "command", "mcp", "mode", "model", "permission", "plugin",
  "provider", "small_model", "username",
]);
const OPTION_KEYS = new Set([
  "opencodePath",
  "expectedVersion",
  "studioRoot",
  "port",
  "env",
  "readinessTimeoutMs",
  "spawnProcess",
  "fetchImpl",
  "verifyPortOwner",
  "killTree",
  "waitForPortClosed",
  "redactor",
  "preflightConfig",
  "preflightProcessRunner",
  "validateLiveContract",
]);

export class OpenCodeServerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenCodeServerError";
    this.code = code;
  }

  toJSON() {
    return Object.freeze({ name: this.name, code: this.code, message: this.message });
  }
}

class IsolationCleanupFailure extends Error {
  constructor(cleanup) {
    super("isolation cleanup failed");
    this.name = "IsolationCleanupFailure";
    this.cleanup = cleanup;
  }
}

function serverError(code, message) {
  return new OpenCodeServerError(code, message);
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

function isCanonicalMcpCapabilityToken(value) {
  if (typeof value !== "string" || !MCP_CAPABILITY_TOKEN.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

function mcpCapabilityDigest(value) {
  if (!isCanonicalMcpCapabilityToken(value)) throw new Error("invalid capability");
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function inspectOptions(options) {
  if (!isPlain(options)) throw new Error("invalid");
  if (Reflect.ownKeys(options).some((key) => typeof key !== "string" || !OPTION_KEYS.has(key))) {
    throw new Error("unknown");
  }
  const opencodePath = dataValue(options, "opencodePath", true);
  const expectedVersion = dataValue(options, "expectedVersion", true);
  const studioRoot = dataValue(options, "studioRoot", true);
  const port = dataValue(options, "port") ?? 4096;
  const rawEnvironment = dataValue(options, "env") ?? process.env;
  const env = sanitizeOpenCodeServerEnvironment(rawEnvironment);
  const originalEnvironment = rawEnvironment === process.env ? { ...process.env } : rawEnvironment;
  const environmentByName = new Map(
    Reflect.ownKeys(originalEnvironment)
      .filter((key) => typeof key === "string")
      .map((key) => [key.toUpperCase(), dataValue(originalEnvironment, key, true)]),
  );
  if ([...environmentByName.keys()].some((key) => key.startsWith("OPENCODE_CONFIG"))) {
    throw new Error("OpenCode config override");
  }
  const originalConfigHome = environmentByName.get("XDG_CONFIG_HOME");
  if (originalConfigHome !== undefined &&
      (typeof originalConfigHome !== "string" || !path.isAbsolute(originalConfigHome))) {
    throw new Error("invalid XDG path");
  }
  const readinessTimeoutMs = dataValue(options, "readinessTimeoutMs") ?? 30_000;
  const spawnProcess = dataValue(options, "spawnProcess") ?? spawn;
  const fetchImpl = dataValue(options, "fetchImpl") ?? fetch;
  const verifyPortOwner = dataValue(options, "verifyPortOwner") ?? verifyLoopbackPortOwner;
  const killTree = dataValue(options, "killTree") ?? killProcessTree;
  const waitForPortClosed = dataValue(options, "waitForPortClosed") ?? defaultWaitForPortClosed;
  const redactor = dataValue(options, "redactor") ?? createRedactor();
  const configuredPreflight = dataValue(options, "preflightConfig");
  const preflightConfig = configuredPreflight ?? defaultPreflightConfig;
  const preflightProcessRunner = dataValue(options, "preflightProcessRunner") ?? runProcess;
  const configuredLiveValidation = dataValue(options, "validateLiveContract");
  const validateLiveContract = configuredLiveValidation ?? defaultValidateLiveContract;
  if (
    typeof opencodePath !== "string" ||
    !path.isAbsolute(opencodePath) ||
    path.extname(opencodePath).toLowerCase() !== ".exe" ||
    !supportsOpenCodeVersion(expectedVersion) ||
    typeof studioRoot !== "string" ||
    !path.isAbsolute(studioRoot) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !Number.isSafeInteger(readinessTimeoutMs) ||
    readinessTimeoutMs < 100 ||
    readinessTimeoutMs > 120_000 ||
    typeof spawnProcess !== "function" ||
    typeof fetchImpl !== "function" ||
    typeof verifyPortOwner !== "function" ||
    typeof killTree !== "function" ||
    typeof waitForPortClosed !== "function" ||
    typeof preflightConfig !== "function" ||
    typeof preflightProcessRunner !== "function" ||
    typeof validateLiveContract !== "function" ||
    !isPlain(redactor) ||
    typeof redactor.text !== "function"
  ) {
    throw new Error("invalid value");
  }
  return Object.freeze({
    opencodePath,
    expectedVersion,
    studioRoot,
    port,
    env,
    readinessTimeoutMs,
    spawnProcess,
    fetchImpl,
    verifyPortOwner,
    killTree,
    waitForPortClosed,
    redactor,
    preflightConfig,
    validateLiveContract,
    usesDefaultPreflight: configuredPreflight === undefined,
    usesDefaultLiveValidation: configuredLiveValidation === undefined,
    preflightProcessRunner,
    originalConfigHome: originalConfigHome === undefined ? null : path.resolve(originalConfigHome),
  });
}

function validateOptions(options) {
  try {
    return inspectOptions(options);
  } catch {
    throw serverError("INVALID_OPENCODE_SERVER_OPTIONS", "The OpenCode server options are invalid.");
  }
}

function inspectStartOptions(options) {
  try {
    if (!isPlain(options) || Reflect.ownKeys(options).some((key) =>
      key !== "jobId" && key !== "mcpCapabilityToken" && key !== "signal")) {
      throw new Error("invalid");
    }
    const jobId = dataValue(options, "jobId", true);
    const mcpCapabilityToken = dataValue(options, "mcpCapabilityToken", true);
    const signal = dataValue(options, "signal");
    if (
      typeof jobId !== "string" ||
      !JOB_ID.test(jobId) ||
      !isCanonicalMcpCapabilityToken(mcpCapabilityToken) ||
      (signal !== undefined &&
        (typeof signal !== "object" || Object.getPrototypeOf(signal) !== AbortSignal.prototype))
    ) {
      throw new Error("invalid");
    }
    return Object.freeze({ jobId, mcpCapabilityToken, signal });
  } catch {
    throw serverError("INVALID_OPENCODE_JOB_OPTIONS", "The OpenCode job options are invalid.");
  }
}

function canConnect(port) {
  return new Promise((resolvePromise) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function defaultWaitForPortClosed(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await canConnect(port))) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("port remained open");
}

function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function parseBoundedJson(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_CONTRACT_BYTES) {
    throw new Error("contract limit");
  }
  const value = JSON.parse(source);
  if (value === null || typeof value !== "object") throw new Error("contract shape");
  return value;
}

function readPermissionRecord(record, expectedAllows) {
  if (!isPlain(record) || dataValue(record, "*") !== "deny") throw new Error("permission");
  const expected = new Set(expectedAllows);
  const actual = new Set();
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") throw new Error("permission key");
    const action = dataValue(record, key, true);
    if (action !== "allow" && action !== "deny") throw new Error("permission action");
    if (action === "allow") {
      if (!expected.has(key)) throw new Error("unexpected allow");
      actual.add(key);
    }
  }
  if (actual.size !== expected.size || [...expected].some((tool) => !actual.has(tool))) {
    throw new Error("missing allow");
  }
}

function validateConfiguredAgent(agent, name) {
  if (
    !isPlain(agent) ||
    dataValue(agent, "mode") !== "primary" ||
    Object.hasOwn(agent, "model")
  ) {
    throw new Error("agent");
  }
  readPermissionRecord(dataValue(agent, "permission", true), AGENT_TOOLS[name]);
}

function validateResolvedConfig(config, expectedCapabilityDigest) {
  if (!isPlain(config) || !/^[a-f0-9]{64}$/u.test(expectedCapabilityDigest)) {
    throw new Error("config");
  }
  exactKeys(config, RESOLVED_CONFIG_KEYS);
  const instructions = dataValue(config, "instructions");
  const plugins = dataValue(config, "plugin");
  const pluginOrigins = dataValue(config, "plugin_origins");
  const commands = dataValue(config, "command");
  const skills = dataValue(config, "skills");
  const tools = dataValue(config, "tools");
  if (
    (instructions !== undefined && (!Array.isArray(instructions) || instructions.length !== 0)) ||
    !Array.isArray(plugins) ||
    plugins.length !== 0 ||
    (pluginOrigins !== undefined && (!Array.isArray(pluginOrigins) || pluginOrigins.length !== 0)) ||
    !isPlain(commands) ||
    Reflect.ownKeys(commands).length !== 0 ||
    (tools !== undefined && (!isPlain(tools) || Reflect.ownKeys(tools).length !== 0)) ||
    (skills !== undefined && (
      !isPlain(skills) ||
      Reflect.ownKeys(skills).some((key) => key !== "paths" && key !== "urls") ||
      Reflect.ownKeys(skills).some((key) => !Array.isArray(dataValue(skills, key, true)) || dataValue(skills, key, true).length !== 0)
    ))
  ) {
    throw new Error("extension surface");
  }
  if (
    dataValue(config, "$schema") !== "https://opencode.ai/config.json" ||
    !isPlain(dataValue(config, "mode", true)) ||
    Reflect.ownKeys(dataValue(config, "mode", true)).length !== 0 ||
    typeof dataValue(config, "username", true) !== "string"
  ) {
    throw new Error("resolved defaults");
  }
  readPermissionRecord(dataValue(config, "permission", true), []);
  const mcp = dataValue(config, "mcp", true);
  if (!isPlain(mcp) || Reflect.ownKeys(mcp).length !== 1 || !Object.hasOwn(mcp, "playwright")) {
    throw new Error("mcp");
  }
  const playwright = dataValue(mcp, "playwright", true);
  exactKeys(playwright, ["type", "url", "enabled", "oauth", "headers"]);
  const headers = dataValue(playwright, "headers", true);
  exactKeys(headers, ["Authorization"]);
  const authorization = dataValue(headers, "Authorization", true);
  if (
    !isPlain(playwright) ||
    dataValue(playwright, "type") !== "remote" ||
    dataValue(playwright, "url") !== "http://127.0.0.1:8931/mcp" ||
    dataValue(playwright, "enabled") !== true ||
    dataValue(playwright, "oauth") !== false ||
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ") ||
    mcpCapabilityDigest(authorization.slice("Bearer ".length)) !== expectedCapabilityDigest
  ) {
    throw new Error("mcp");
  }
  const agents = dataValue(config, "agent", true);
  if (
    !isPlain(agents) ||
    Reflect.ownKeys(agents).length !== Object.keys(AGENT_TOOLS).length
  ) {
    throw new Error("agents");
  }
  for (const name of Object.keys(AGENT_TOOLS)) {
    validateConfiguredAgent(dataValue(agents, name, true), name);
  }
}

function ownString(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0")) {
    throw new Error(name);
  }
  return value;
}

function exactKeys(record, expected) {
  if (!isPlain(record)) throw new Error("record");
  const actual = Reflect.ownKeys(record);
  if (
    actual.some((key) => typeof key !== "string") ||
    actual.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error("record keys");
  }
}

function captureSelectedRuntime(config, strictProviders = false) {
  if (!isPlain(config)) throw new Error("global config");
  const model = ownString(dataValue(config, "model", true), "model");
  const smallModel = ownString(dataValue(config, "small_model", true), "small model");
  const selections = [model, smallModel].map((selection) => {
    const slash = selection.indexOf("/");
    if (slash < 1 || slash === selection.length - 1) throw new Error("model selection");
    const provider = selection.slice(0, slash);
    const modelId = selection.slice(slash + 1);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(provider) || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/u.test(modelId)) {
      throw new Error("model selection");
    }
    return { provider, modelId };
  });
  const providerNames = new Set(selections.map(({ provider }) => provider));
  if (providerNames.size !== 1 || !providerNames.has("ollama")) throw new Error("provider");
  const providers = dataValue(config, "provider", true);
  if (strictProviders) exactKeys(providers, ["ollama"]);
  const source = dataValue(providers, "ollama", true);
  exactKeys(source, ["name", "npm", "options", "models"]);
  if (dataValue(source, "npm", true) !== "@ai-sdk/openai-compatible") throw new Error("provider npm");
  const providerName = ownString(dataValue(source, "name", true), "provider name");
  const options = dataValue(source, "options", true);
  exactKeys(options, ["baseURL"]);
  if (dataValue(options, "baseURL", true) !== "http://127.0.0.1:11434/v1") {
    throw new Error("provider endpoint");
  }
  const sourceModels = dataValue(source, "models", true);
  const selectedIds = [...new Set(selections.map(({ modelId }) => modelId))];
  exactKeys(sourceModels, selectedIds);
  const models = Object.create(null);
  for (const modelId of selectedIds) {
    const sourceModel = dataValue(sourceModels, modelId, true);
    exactKeys(sourceModel, ["name"]);
    models[modelId] = Object.freeze({ name: ownString(dataValue(sourceModel, "name", true), "model name") });
  }
  const provider = Object.freeze({
    name: providerName,
    npm: "@ai-sdk/openai-compatible",
    options: Object.freeze({ baseURL: "http://127.0.0.1:11434/v1" }),
    models: Object.freeze(models),
  });
  return Object.freeze({ model, smallModel, provider: Object.freeze({ ollama: provider }) });
}

function validateSelectedRuntime(config, runtime) {
  if (
    dataValue(config, "model") !== runtime.model ||
    dataValue(config, "small_model") !== runtime.smallModel
  ) {
    throw new Error("runtime model");
  }
  const selected = captureSelectedRuntime(config, true);
  if (JSON.stringify(selected) !== JSON.stringify(runtime)) throw new Error("runtime provider");
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function readGlobalConfig(configHome) {
  const home = configHome ?? path.join(os.homedir(), ".config");
  const opencodeHome = path.join(home, "opencode");
  const configFile = path.join(opencodeHome, "opencode.json");
  for (const directory of [home, opencodeHome]) {
    const stat = await lstat(directory);
    const canonical = await realpath(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      canonicalPath(directory) !== canonicalPath(canonical)
    ) {
      throw new Error("unsafe global config path");
    }
  }
  try {
    await lstat(path.join(opencodeHome, "opencode.jsonc"));
    throw new Error("ambiguous global config");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const before = await lstat(configFile);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("unsafe global config");
  const source = await readFile(configFile);
  const after = await lstat(configFile);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    source.length > MAX_CONTRACT_BYTES
  ) {
    throw new Error("global config changed");
  }
  return parseBoundedJson(new TextDecoder("utf-8", { fatal: true }).decode(source));
}

function insidePath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function assertRegularFile(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe file");
}

function promptBody(source) {
  const match = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/u);
  if (!match) throw new Error("agent front matter");
  return match[1].trim();
}

function canonicalProjectText(source) {
  const value = new TextDecoder("utf-8", { fatal: true }).decode(source);
  return value.replace(/\r\n?|\n/gu, "\n");
}

async function snapshotProjectManifest(studioRoot) {
  const configPath = path.join(studioRoot, "opencode.json");
  const opencodeDirectory = path.join(studioRoot, ".opencode");
  const agentsDirectory = path.join(opencodeDirectory, "agents");
  for (const directory of [studioRoot, opencodeDirectory, agentsDirectory]) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe project directory");
  }
  const topEntries = (await readdir(opencodeDirectory)).sort();
  if (topEntries.length !== 1 || topEntries[0] !== "agents") throw new Error("project extension surface");
  const agentNames = Object.keys(AGENT_TOOLS);
  const expectedFiles = agentNames.map((name) => `${name}.md`).sort();
  const actualFiles = (await readdir(agentsDirectory)).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) throw new Error("project agents");
  await assertRegularFile(configPath);
  const files = [["opencode.json", configPath]];
  for (const name of agentNames) {
    const agentPath = path.join(agentsDirectory, `${name}.md`);
    await assertRegularFile(agentPath);
    files.push([`.opencode/agents/${name}.md`, agentPath]);
  }
  const hash = createHash("sha256");
  const prompts = Object.create(null);
  const agentSources = Object.create(null);
  let projectConfig;
  for (const [relative, file] of files) {
    const source = await readFile(file);
    if (source.length > MAX_CONTRACT_BYTES) throw new Error("project file limit");
    const canonicalSource = canonicalProjectText(source);
    hash.update(relative, "utf8");
    hash.update(Buffer.from([0]));
    hash.update(canonicalSource, "utf8");
    hash.update(Buffer.from([0]));
    if (relative.endsWith(".md")) {
      const name = path.basename(relative, ".md");
      agentSources[name] = canonicalSource;
      prompts[name] = promptBody(agentSources[name]);
    } else {
      projectConfig = parseBoundedJson(canonicalSource);
    }
  }
  return Object.freeze({
    digest: hash.digest("hex"),
    prompts: Object.freeze(prompts),
    agentSources: Object.freeze(agentSources),
    projectConfig,
  });
}

async function assertNoWorkspaceInstructions(studioRoot) {
  let current = path.resolve(studioRoot);
  for (let depth = 0; depth < 64; depth += 1) {
    for (const name of ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]) {
      try {
        await lstat(path.join(current, name));
        throw new Error("workspace instruction");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    try {
      await lstat(path.join(current, ".git"));
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("worktree root");
    current = parent;
  }
  throw new Error("worktree depth");
}

async function atomicPrivateWrite(file, source) {
  const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function removeTreeNoFollow(current, rootReal) {
  const stat = await lstat(current);
  if (stat.isSymbolicLink()) {
    await rm(current, { force: true });
    return;
  }
  if (!stat.isDirectory()) {
    await unlink(current);
    return;
  }
  const currentReal = await realpath(current);
  if (!insidePath(rootReal, currentReal)) throw new Error("cleanup escape");
  for (const name of await readdir(current)) {
    await removeTreeNoFollow(path.join(current, name), rootReal);
  }
  await rmdir(current);
}

async function createIsolatedEnvironment(baseEnvironment, runtime, manifest, mcpCapabilityToken) {
  if (!isCanonicalMcpCapabilityToken(mcpCapabilityToken)) throw new Error("invalid capability");
  const tempRoot = path.resolve(os.tmpdir());
  const tempStat = await lstat(tempRoot);
  const tempReal = await realpath(tempRoot);
  if (!tempStat.isDirectory() || tempStat.isSymbolicLink() || canonicalPath(tempRoot) !== canonicalPath(tempReal)) {
    throw new Error("unsafe temp root");
  }
  const root = await mkdtemp(path.join(tempReal, "manual-video-opencode-"));
  const rootReal = await realpath(root);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !insidePath(tempReal, rootReal)) {
    throw new Error("unsafe isolation root");
  }
  const markerToken = randomBytes(32).toString("hex");
  const markerPath = path.join(root, ".manual-video-opencode-owned");
  try {
    const configHome = path.join(root, "config");
    const dataHome = path.join(root, "data");
    const cacheHome = path.join(root, "cache");
    const stateHome = path.join(root, "state");
    const runtimeHome = path.join(root, "runtime");
    const isolatedHome = path.join(root, "home");
    const appDataRoot = path.join(isolatedHome, "AppData");
    const appData = path.join(appDataRoot, "Roaming");
    const localAppData = path.join(appDataRoot, "Local");
    const opencodeHome = path.join(configHome, "opencode");
    const agentsHome = path.join(opencodeHome, "agents");
    for (const directory of [configHome, dataHome, cacheHome, stateHome, runtimeHome, isolatedHome, appDataRoot, appData, localAppData, opencodeHome, agentsHome]) {
      await mkdir(directory, { mode: 0o700 });
    }
    await atomicPrivateWrite(markerPath, markerToken);
    const minimalConfig = JSON.stringify({
      ...manifest.projectConfig,
      model: runtime.model,
      small_model: runtime.smallModel,
      provider: runtime.provider,
    }, null, 2);
    await atomicPrivateWrite(path.join(opencodeHome, "opencode.json"), `${minimalConfig}\n`);
    for (const name of Object.keys(AGENT_TOOLS)) {
      await atomicPrivateWrite(path.join(agentsHome, `${name}.md`), manifest.agentSources[name]);
    }
    const environment = Object.freeze({
      ...baseEnvironment,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
      XDG_STATE_HOME: stateHome,
      XDG_RUNTIME_DIR: runtimeHome,
      MANUAL_STUDIO_MCP_TOKEN: mcpCapabilityToken,
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_TEST_HOME: isolatedHome,
    });
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      const current = await lstat(root).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (!current) {
        cleaned = true;
        return;
      }
      if (current.isSymbolicLink()) {
        await rm(root, { force: true });
        cleaned = true;
        return;
      }
      if (!current.isDirectory() || current.dev !== rootStat.dev || current.ino !== rootStat.ino) {
        throw new Error("isolation identity changed");
      }
      await assertRegularFile(markerPath);
      if ((await readFile(markerPath, "utf8")) !== markerToken) throw new Error("isolation marker changed");
      await removeTreeNoFollow(root, rootReal);
      cleaned = true;
    };
    return Object.freeze({ environment, cleanup, root });
  } catch (error) {
    try {
      await removeTreeNoFollow(root, rootReal);
    } catch {
      throw new IsolationCleanupFailure(() => removeTreeNoFollow(root, rootReal));
    }
    throw error;
  }
}

function effectivePermission(rules, permission) {
  let action;
  for (const rule of rules) {
    if (!isPlain(rule)) throw new Error("permission rule");
    const rulePermission = dataValue(rule, "permission", true);
    const pattern = dataValue(rule, "pattern", true);
    const nextAction = dataValue(rule, "action", true);
    if (
      typeof rulePermission !== "string" ||
      typeof pattern !== "string" ||
      (nextAction !== "allow" && nextAction !== "deny" && nextAction !== "ask")
    ) {
      throw new Error("permission rule");
    }
    if (pattern === "*" && (rulePermission === "*" || rulePermission === permission)) {
      action = nextAction;
    }
  }
  return action;
}

function validateResolvedAgent(
  agent,
  name,
  expectedPrompt,
  dataHome = path.join(os.homedir(), ".local", "share"),
  requireDebugTools = true,
) {
  if (
    !isPlain(agent) ||
    dataValue(agent, "name") !== name ||
    dataValue(agent, "mode") !== "primary" ||
    dataValue(agent, "native") !== false ||
    Object.hasOwn(agent, "model")
  ) {
    throw new Error("resolved agent");
  }
  const rules = dataValue(agent, "permission", true);
  if (!Array.isArray(rules) || Object.getPrototypeOf(rules) !== Array.prototype) {
    throw new Error("resolved permissions");
  }
  if (expectedPrompt !== undefined && dataValue(agent, "prompt")?.trim() !== expectedPrompt) {
    throw new Error("resolved prompt");
  }
  const toolsRecord = dataValue(agent, "tools");
  if (requireDebugTools) {
    if (
      !isPlain(toolsRecord) ||
      Reflect.ownKeys(toolsRecord).length === 0 ||
      Reflect.ownKeys(toolsRecord).some((key) => dataValue(toolsRecord, key, true) !== false)
    ) {
      throw new Error("native tools");
    }
  } else if (Object.hasOwn(agent, "tools")) {
    throw new Error("live native tools");
  }
  let finalDeny = -1;
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (
      isPlain(rule) &&
      dataValue(rule, "permission") === "*" &&
      dataValue(rule, "pattern") === "*" &&
      dataValue(rule, "action") === "deny"
    ) {
      finalDeny = index;
    }
  }
  if (finalDeny < 0) throw new Error("final deny");
  const tail = rules.slice(finalDeny + 1);
  const allows = new Set(AGENT_TOOLS[name]);
  const expectedActions = new Map();
  for (const permission of new Set([...Object.values(AGENT_TOOLS).flat(), ...FORBIDDEN_PERMISSIONS])) {
    expectedActions.set(permission, allows.has(permission) ? "allow" : "deny");
  }
  const seen = new Set();
  const toolOutputPattern = path.join(dataHome, "opencode", "tool-output", "*");
  let internalException = 0;
  for (const rule of tail) {
    if (!isPlain(rule)) throw new Error("tail rule");
    const permission = dataValue(rule, "permission", true);
    const pattern = dataValue(rule, "pattern", true);
    const action = dataValue(rule, "action", true);
    if (
      permission === "external_directory" &&
      pattern === toolOutputPattern &&
      action === "allow"
    ) {
      internalException += 1;
      continue;
    }
    if (
      pattern !== "*" ||
      !expectedActions.has(permission) ||
      expectedActions.get(permission) !== action ||
      seen.has(permission)
    ) {
      throw new Error("unexpected tail rule");
    }
    seen.add(permission);
  }
  if (
    internalException !== 1 ||
    seen.size !== expectedActions.size ||
    [...expectedActions.keys()].some((permission) => !seen.has(permission))
  ) {
    throw new Error("tail rule drift");
  }
  for (const tool of new Set([
    ...Object.values(AGENT_TOOLS).flat(),
    ...FORBIDDEN_PERMISSIONS,
    "manual_video_unknown_tool",
  ])) {
    const expected = allows.has(tool) ? "allow" : "deny";
    if (effectivePermission(rules, tool) !== expected) throw new Error("effective permission");
  }
}

async function runDebugProcess(processRunner, opencodePath, args, studioRoot, env, signal, timeoutMs) {
  return processRunner({
    command: opencodePath,
    args,
    cwd: studioRoot,
    env,
    signal,
    timeoutMs,
  });
}

async function runDebugJson(opencodePath, args, studioRoot, env, signal, processRunner = runProcess) {
  const result = await runDebugProcess(processRunner, opencodePath, args, studioRoot, env, signal, 30_000);
  if (result.exitCode !== 0 || result.signal !== null) throw new Error("debug process");
  return parseBoundedJson(result.stdout);
}

async function defaultPreflightConfig(details) {
  const { opencodePath, studioRoot, env } = details;
  const mcpCapabilityToken = dataValue(env, "MANUAL_STUDIO_MCP_TOKEN", true);
  const capabilityDigest = mcpCapabilityDigest(mcpCapabilityToken);
  await assertNoWorkspaceInstructions(studioRoot);
  const manifest = await snapshotProjectManifest(studioRoot);
  if (manifest.digest !== TRUSTED_PROJECT_DIGEST) throw new Error("project manifest");
  const globalSnapshot = await readGlobalConfig(details.originalConfigHome);
  const runtime = captureSelectedRuntime(globalSnapshot);
  const isolated = await createIsolatedEnvironment(
    env,
    runtime,
    manifest,
    mcpCapabilityToken,
  );
  try {
    const selection = await resolveOpenCodeExecutable({
      environment: isolated.environment,
      explicitPath: opencodePath,
      runVersion: async (command, args, execution) => {
        const result = await details.processRunner({
          command,
          args,
          cwd: studioRoot,
          env: execution.env,
          signal: details.signal,
          timeoutMs: execution.timeout,
        });
        if (
          !isPlain(result) ||
          !Number.isInteger(dataValue(result, "exitCode", true)) ||
          dataValue(result, "signal", true) !== null ||
          typeof dataValue(result, "stdout", true) !== "string" ||
          typeof dataValue(result, "stderr", true) !== "string"
        ) {
          throw new Error("version process");
        }
        return result;
      },
    });
    if (selection.version !== details.expectedVersion) {
      throw new Error("version");
    }
    const config = await runDebugJson(
      opencodePath,
      ["debug", "config", "--pure"],
      studioRoot,
      isolated.environment,
      details.signal,
      details.processRunner,
    );
    validateResolvedConfig(config, capabilityDigest);
    validateSelectedRuntime(config, runtime);
    for (const name of Object.keys(AGENT_TOOLS)) {
      const agent = await runDebugJson(
        opencodePath,
        ["debug", "agent", name, "--pure"],
        studioRoot,
        isolated.environment,
        details.signal,
        details.processRunner,
      );
      validateResolvedAgent(agent, name, manifest.prompts[name], isolated.environment.XDG_DATA_HOME);
    }
    return Object.freeze({
      valid: true,
      environment: isolated.environment,
      cleanup: isolated.cleanup,
      manifestDigest: manifest.digest,
      runtime,
    });
  } catch (error) {
    try {
      await isolated.cleanup();
    } catch {
      throw new IsolationCleanupFailure(isolated.cleanup);
    }
    throw error;
  }
}

async function boundedResponseJson(response) {
  if (!response || response.ok !== true || response.status !== 200) throw new Error("response");
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_CONTRACT_BYTES) {
      throw new Error("response limit");
    }
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CONTRACT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("response limit");
      }
      chunks.push(Buffer.from(value));
    }
    return parseBoundedJson(Buffer.concat(chunks, bytes).toString("utf8"));
  }
  if (typeof response.text === "function") {
    return parseBoundedJson(await response.text());
  }
  if (typeof response.json === "function") {
    const value = await response.json();
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_CONTRACT_BYTES) throw new Error("response limit");
    return value;
  }
  throw new Error("response");
}

async function defaultValidateLiveContract(details) {
  await assertNoWorkspaceInstructions(details.studioRoot);
  const manifest = await snapshotProjectManifest(details.studioRoot);
  if (
    manifest.digest !== TRUSTED_PROJECT_DIGEST ||
    manifest.digest !== details.manifestDigest
  ) throw new Error("manifest drift");
  const headers = { Authorization: basicAuthorization(details.username, details.password) };
  const deadline = Date.now() + 10_000;
  const delay = (milliseconds) => new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      details.signal?.removeEventListener("abort", abort);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const timer = setTimeout(() => finish(), milliseconds);
    const abort = () => finish(new Error("aborted"));
    details.signal?.addEventListener("abort", abort, { once: true });
    if (details.signal?.aborted) abort();
  });
  const requestOnce = async (pathname) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || details.signal?.aborted) throw new Error("live deadline");
    const url = new URL(pathname, details.baseUrl);
    url.searchParams.set("directory", details.studioRoot);
    const requestSignal = details.signal
      ? AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(3_000, remaining))), details.signal])
      : AbortSignal.timeout(Math.max(1, Math.min(3_000, remaining)));
    const value = await boundedResponseJson(await details.fetchImpl(url.href, {
      headers,
      cache: "no-store",
      signal: requestSignal,
    }));
    if (Date.now() > deadline || details.signal?.aborted) throw new Error("live deadline");
    return value;
  };
  const requestRetry = async (pathname) => {
    while (true) {
      try {
        return await requestOnce(pathname);
      } catch (error) {
        if (Date.now() >= deadline || details.signal?.aborted) throw error;
        await delay(Math.min(100, Math.max(1, deadline - Date.now())));
      }
    }
  };
  const waitForMcp = async () => {
    while (true) {
      let mcp;
      try {
        mcp = await requestOnce("/mcp");
      } catch (error) {
        if (Date.now() >= deadline || details.signal?.aborted) throw error;
        await delay(Math.min(100, Math.max(1, deadline - Date.now())));
        continue;
      }
      if (
        !isPlain(mcp) ||
        Reflect.ownKeys(mcp).length !== 1 ||
        !isPlain(dataValue(mcp, "playwright", true))
      ) {
        throw new Error("live mcp");
      }
      if (dataValue(dataValue(mcp, "playwright", true), "status") === "connected") return;
      if (Date.now() >= deadline || details.signal?.aborted) throw new Error("live mcp");
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  };
  const [config, agents, toolIds] = await Promise.all([
    requestRetry("/config"),
    requestRetry("/agent"),
    requestRetry("/experimental/tool/ids"),
    waitForMcp(),
  ]);
  validateResolvedConfig(config, details.mcpCapabilityDigest);
  validateSelectedRuntime(config, details.runtime);
  if (!Array.isArray(agents) || Object.getPrototypeOf(agents) !== Array.prototype) {
    throw new Error("live agents");
  }
  const actualAgentNames = agents.map((agent) => isPlain(agent) ? dataValue(agent, "name") : undefined);
  if (
    actualAgentNames.some((name) => typeof name !== "string") ||
    new Set(actualAgentNames).size !== PINNED_AGENT_NAMES.length ||
    actualAgentNames.length !== PINNED_AGENT_NAMES.length ||
    [...PINNED_AGENT_NAMES].some((name) => !actualAgentNames.includes(name))
  ) {
    throw new Error("live agent inventory");
  }
  for (const name of Object.keys(AGENT_TOOLS)) {
    const matches = agents.filter((agent) => isPlain(agent) && dataValue(agent, "name") === name);
    if (matches.length !== 1) throw new Error("live agent");
    validateResolvedAgent(matches[0], name, manifest.prompts[name], details.dataHome, false);
  }
  if (
    !Array.isArray(toolIds) ||
    Object.getPrototypeOf(toolIds) !== Array.prototype ||
    toolIds.length !== PINNED_TOOL_IDS.length ||
    new Set(toolIds).size !== PINNED_TOOL_IDS.length ||
    toolIds.some((tool, index) => tool !== PINNED_TOOL_IDS[index])
  ) {
    throw new Error("live tools");
  }
  return Object.freeze({ valid: true });
}

export class OpenCodeServer {
  #settings;
  #active = null;
  #child = null;
  #abort = null;
  #abortSignal = null;
  #stopped = Promise.resolve();
  #stopPromise = null;
  #password = null;
  #username = "manual-studio";
  #starting = false;
  #preflightInFlight = false;
  #preflightDone = Promise.resolve();
  #finishPreflight = null;
  #startAbort = null;
  #stopping = false;
  #generation = 0;
  #recovery = Promise.resolve();
  #jobEnvironment = null;
  #isolationCleanup = null;
  #manifestDigest = null;
  #mcpCapabilityDigest = null;
  #runtime = null;
  #portMayBeOpen = false;

  constructor(options) {
    this.#settings = validateOptions(options);
  }

  get active() {
    return this.#active;
  }

  get activeJobId() {
    return this.#active?.jobId ?? null;
  }

  get stopped() {
    return this.#stopped;
  }

  async #health(signal) {
    const response = await this.#settings.fetchImpl(
      `http://127.0.0.1:${this.#settings.port}/global/health`,
      {
        headers: { Authorization: basicAuthorization(this.#username, this.#password) },
        signal: signal
          ? AbortSignal.any([AbortSignal.timeout(2_000), signal])
          : AbortSignal.timeout(2_000),
      },
    );
    const value = await boundedResponseJson(response);
    if (
      !isPlain(value) ||
      value.healthy !== true ||
      value.version !== this.#settings.expectedVersion
    ) {
      throw new Error("health");
    }
    return value.version;
  }

  #detachAbort() {
    if (this.#abort && this.#abortSignal) {
      this.#abortSignal.removeEventListener("abort", this.#abort);
    }
    this.#abort = null;
    this.#abortSignal = null;
  }

  #liveContractDetails(signal) {
    if (!this.#password || !this.#jobEnvironment) throw new Error("inactive contract");
    return Object.freeze({
      baseUrl: `http://127.0.0.1:${this.#settings.port}`,
      expectedVersion: this.#settings.expectedVersion,
      studioRoot: this.#settings.studioRoot,
      username: this.#username,
      password: this.#password,
      fetchImpl: this.#settings.fetchImpl,
      manifestDigest: this.#manifestDigest,
      runtime: this.#runtime,
      dataHome: this.#jobEnvironment.XDG_DATA_HOME,
      signal,
    });
  }

  #validateLiveContract(signal) {
    const details = this.#liveContractDetails(signal);
    if (!this.#settings.usesDefaultLiveValidation) {
      return this.#settings.validateLiveContract(details);
    }
    if (!/^[a-f0-9]{64}$/u.test(this.#mcpCapabilityDigest)) {
      throw new Error("inactive capability");
    }
    return this.#settings.validateLiveContract(Object.freeze({
      ...details,
      mcpCapabilityDigest: this.#mcpCapabilityDigest,
    }));
  }

  #handleUnexpectedClose(child, generation) {
    if (
      this.#stopping ||
      this.#child !== child ||
      this.#generation !== generation ||
      !this.#active
    ) {
      return;
    }
    this.#generation += 1;
    this.#startAbort?.abort();
    this.#startAbort = null;
    const cleanup = this.#isolationCleanup;
    this.#portMayBeOpen = true;
    this.#active = null;
    this.#child = null;
    this.#password = null;
    this.#jobEnvironment = null;
    this.#isolationCleanup = null;
    this.#manifestDigest = null;
    this.#mcpCapabilityDigest = null;
    this.#runtime = null;
    this.#detachAbort();
    const recovery = (async () => {
      let portClosed = false;
      try {
        await this.#settings.waitForPortClosed(this.#settings.port);
        portClosed = true;
        this.#portMayBeOpen = false;
        if (cleanup) await cleanup();
      } catch (error) {
        this.#portMayBeOpen = !portClosed;
        this.#isolationCleanup = cleanup;
        throw error;
      }
    })();
    recovery.catch(() => {});
    this.#recovery = recovery;
    this.#stopped = recovery;
  }

  async startJob(options) {
    const { jobId, mcpCapabilityToken, signal } = inspectStartOptions(options);
    try {
      await this.#recovery;
    } catch {
      throw serverError("OPENCODE_SERVER_RECOVERY_FAILED", "The previous OpenCode server did not stop safely.");
    }
    if (this.#isolationCleanup && !this.#child && !this.#active) {
      throw serverError("OPENCODE_SERVER_RECOVERY_FAILED", "The previous OpenCode isolation was not removed safely.");
    }
    if (this.#active || this.#child || this.#starting || this.#preflightInFlight || this.#stopping) {
      throw serverError("OPENCODE_SERVER_BUSY", "An OpenCode job is already active.");
    }
    if (signal?.aborted) {
      throw serverError("OPENCODE_SERVER_ABORTED", "The OpenCode server start was aborted.");
    }

    const startGeneration = this.#generation;
    const internalAbort = new AbortController();
    const startSignal = signal
      ? AbortSignal.any([signal, internalAbort.signal])
      : internalAbort.signal;
    this.#startAbort = internalAbort;
    this.#starting = true;
    this.#preflightInFlight = true;
    this.#preflightDone = new Promise((resolvePromise) => {
      this.#finishPreflight = resolvePromise;
    });
    let preflight;
    try {
      const preflightEnvironment = this.#settings.usesDefaultPreflight
        ? Object.freeze({
            ...this.#settings.env,
            MANUAL_STUDIO_MCP_TOKEN: mcpCapabilityToken,
          })
        : this.#settings.env;
      preflight = await this.#settings.preflightConfig(Object.freeze({
        opencodePath: this.#settings.opencodePath,
        expectedVersion: this.#settings.expectedVersion,
        studioRoot: this.#settings.studioRoot,
        env: preflightEnvironment,
        originalConfigHome: this.#settings.originalConfigHome,
        processRunner: this.#settings.preflightProcessRunner,
        signal: startSignal,
      }));
      if (!isPlain(preflight) || preflight.valid !== true) throw new Error("preflight");
      if (this.#generation !== startGeneration || !this.#starting) {
        throw serverError("OPENCODE_SERVER_ABORTED", "The OpenCode server start was superseded.");
      }
      if (this.#settings.usesDefaultPreflight) {
        if (
          !isPlain(preflight.environment) ||
          typeof preflight.cleanup !== "function" ||
          dataValue(preflight.environment, "MANUAL_STUDIO_MCP_TOKEN", true) !== mcpCapabilityToken ||
          typeof preflight.manifestDigest !== "string" ||
          !/^[a-f0-9]{64}$/u.test(preflight.manifestDigest) ||
          !isPlain(preflight.runtime)
        ) {
          throw new Error("preflight contract");
        }
        this.#jobEnvironment = preflight.environment;
        this.#isolationCleanup = preflight.cleanup;
        this.#manifestDigest = preflight.manifestDigest;
        this.#runtime = preflight.runtime;
      } else {
        this.#jobEnvironment = Object.freeze({
          ...this.#settings.env,
          MANUAL_STUDIO_MCP_TOKEN: mcpCapabilityToken,
        });
        if (typeof preflight.cleanup === "function") {
          this.#isolationCleanup = preflight.cleanup;
        }
      }
      this.#mcpCapabilityDigest = mcpCapabilityDigest(mcpCapabilityToken);
      this.#preflightInFlight = false;
      this.#finishPreflight?.();
      this.#finishPreflight = null;
    } catch (error) {
      this.#starting = false;
      const cleanup = error instanceof IsolationCleanupFailure
        ? error.cleanup
        : preflight?.cleanup;
      if (cleanup) {
        try {
          await cleanup();
        } catch {
          this.#isolationCleanup = cleanup;
          this.#jobEnvironment = null;
          this.#manifestDigest = null;
          this.#mcpCapabilityDigest = null;
          this.#runtime = null;
          this.#preflightInFlight = false;
          this.#finishPreflight?.();
          this.#finishPreflight = null;
          throw serverError("OPENCODE_SERVER_RECOVERY_FAILED", "The OpenCode isolation was not removed safely.");
        }
      }
      this.#preflightInFlight = false;
      this.#finishPreflight?.();
      this.#finishPreflight = null;
      this.#jobEnvironment = null;
      this.#isolationCleanup = null;
      this.#manifestDigest = null;
      this.#mcpCapabilityDigest = null;
      this.#runtime = null;
      if (error instanceof OpenCodeServerError) throw error;
      if (startSignal.aborted) {
        throw serverError("OPENCODE_SERVER_ABORTED", "The OpenCode server start was aborted.");
      }
      throw serverError("OPENCODE_SERVER_PREFLIGHT_FAILED", "The OpenCode server configuration is unsafe.");
    }
    if (startSignal.aborted || this.#generation !== startGeneration || !this.#starting) {
      this.#starting = false;
      const cleanup = this.#isolationCleanup;
      try {
        await cleanup?.();
      } catch {
        this.#password = null;
        this.#jobEnvironment = null;
        this.#manifestDigest = null;
        this.#mcpCapabilityDigest = null;
        this.#runtime = null;
        throw serverError("OPENCODE_SERVER_RECOVERY_FAILED", "The OpenCode isolation was not removed safely.");
      }
      this.#jobEnvironment = null;
      this.#isolationCleanup = null;
      this.#manifestDigest = null;
      this.#mcpCapabilityDigest = null;
      this.#runtime = null;
      throw serverError("OPENCODE_SERVER_ABORTED", "The OpenCode server start was aborted.");
    }

    const args = [
      "serve",
      "--pure",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(this.#settings.port),
    ];
    this.#password = randomBytes(32).toString("base64url");
    const env = {
      ...this.#jobEnvironment,
      OPENCODE_SERVER_USERNAME: this.#username,
      OPENCODE_SERVER_PASSWORD: this.#password,
    };
    let child;
    try {
      child = this.#settings.spawnProcess(this.#settings.opencodePath, args, {
        cwd: this.#settings.studioRoot,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      const cleanup = this.#isolationCleanup;
      this.#starting = false;
      this.#password = null;
      try {
        await cleanup?.();
      } catch {
        this.#jobEnvironment = null;
        this.#manifestDigest = null;
        this.#mcpCapabilityDigest = null;
        this.#runtime = null;
        throw serverError("OPENCODE_SERVER_RECOVERY_FAILED", "The OpenCode isolation was not removed safely.");
      }
      this.#jobEnvironment = null;
      this.#isolationCleanup = null;
      this.#manifestDigest = null;
      this.#mcpCapabilityDigest = null;
      this.#runtime = null;
      throw serverError("OPENCODE_SERVER_START_FAILED", "The OpenCode server could not start.");
    }
    this.#child = child;
    this.#portMayBeOpen = true;
    const generation = ++this.#generation;
    const deadline = Date.now() + this.#settings.readinessTimeoutMs;
    let outputBytes = 0;
    let sawListening = false;
    let startFailure;
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const pending = { stdout: "", stderr: "" };
    const inspectLine = (rawLine) => {
      if (Buffer.byteLength(rawLine) > MAX_READINESS_LINE_BYTES) {
        startFailure = new Error("line limit");
        return;
      }
      let safe;
      try {
        safe = this.#settings.redactor.text(rawLine);
      } catch {
        startFailure = new Error("redaction");
        return;
      }
      if (/opencode server listening on http:\/\/127\.0\.0\.1:\d+/iu.test(safe) ||
          /OpenCode server listening on 127\.0\.0\.1:\d+/iu.test(safe)) {
        sawListening = true;
      }
    };
    const consume = (stream, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_READINESS_BYTES) {
        startFailure = new Error("output limit");
        return;
      }
      pending[stream] += decoders[stream].write(chunk);
      while (true) {
        const newline = pending[stream].indexOf("\n");
        if (newline < 0) break;
        let line = pending[stream].slice(0, newline);
        pending[stream] = pending[stream].slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        inspectLine(line);
      }
      if (Buffer.byteLength(pending[stream]) > MAX_READINESS_LINE_BYTES) startFailure = new Error("line limit");
    };
    child.stdout?.on("data", (chunk) => consume("stdout", chunk));
    child.stderr?.on("data", (chunk) => consume("stderr", chunk));
    child.once?.("error", () => { startFailure = new Error("spawn"); });
    child.once?.("close", () => {
      if (!this.#active) startFailure = new Error("closed");
      this.#handleUnexpectedClose(child, generation);
    });

    try {
      while (!sawListening && !startFailure && Date.now() < deadline) {
        if (startSignal.aborted || this.#generation !== generation || !this.#starting) {
          throw serverError("OPENCODE_SERVER_ABORTED", "The OpenCode server start was aborted.");
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
      if (!sawListening || startFailure || child.exitCode !== null || child.signalCode !== null) {
        throw new Error("readiness");
      }
      await this.#settings.verifyPortOwner(this.#settings.port, child.pid, startSignal);
      if (startSignal.aborted || this.#generation !== generation || !this.#starting || child.exitCode !== null || child.signalCode !== null) throw new Error("dead");
      const version = await this.#health(startSignal);
      if (startSignal.aborted || this.#generation !== generation || !this.#starting || child.exitCode !== null || child.signalCode !== null) throw new Error("dead");
      const validation = await this.#validateLiveContract(startSignal);
      if (!isPlain(validation) || validation.valid !== true) throw new Error("live contract");
      if (startSignal.aborted || this.#generation !== generation || !this.#starting || child.exitCode !== null || child.signalCode !== null) throw new Error("dead");

      const active = Object.freeze({
        baseUrl: `http://127.0.0.1:${this.#settings.port}`,
        jobId,
        version,
      });
      this.#active = active;
      this.#starting = false;
      if (signal) {
        this.#abort = () => {
          const stopping = this.stop();
          stopping.catch(() => {});
        };
        this.#abortSignal = signal;
        signal.addEventListener("abort", this.#abort, { once: true });
        if (signal.aborted) {
          await this.stop();
          throw serverError("OPENCODE_SERVER_ABORTED", "The OpenCode server start was aborted.");
        }
      }
      return active;
    } catch (error) {
      this.#starting = false;
      try {
        if (this.#stopPromise) await this.#stopPromise;
        else await this.#stopInternal();
      } catch (stopError) {
        throw stopError;
      }
      if (error instanceof OpenCodeServerError) throw error;
      throw serverError("OPENCODE_SERVER_START_FAILED", "The OpenCode server could not start.");
    }
  }

  async withAttachOptions(agent, callback) {
    if (!Object.hasOwn(AGENT_TOOLS, agent) || typeof callback !== "function") {
      throw serverError("INVALID_OPENCODE_ATTACH_OPTIONS", "The OpenCode attach options are invalid.");
    }
    if (!this.#active || !this.#password || !this.#jobEnvironment) {
      throw serverError("OPENCODE_SERVER_INACTIVE", "The OpenCode server is not active.");
    }
    const generation = this.#generation;
    const baseUrl = this.#active.baseUrl;
    const studioRoot = this.#settings.studioRoot;
    const requestMatchesActiveServer = (request) => {
      if (
        generation !== this.#generation ||
        !this.#active ||
        this.#active.baseUrl !== baseUrl ||
        !isPlain(request)
      ) {
        return false;
      }
      try {
        const keys = Reflect.ownKeys(request);
        return (
          keys.length === 3 &&
          keys.every((key) => key === "agent" || key === "baseUrl" || key === "studioRoot") &&
          dataValue(request, "agent", true) === agent &&
          dataValue(request, "baseUrl", true) === baseUrl &&
          dataValue(request, "studioRoot", true) === studioRoot
        );
      } catch {
        return false;
      }
    };
    let environment = sanitizeOpenCodeEnvironment({
      ...this.#jobEnvironment,
      OPENCODE_SERVER_USERNAME: this.#username,
      OPENCODE_SERVER_PASSWORD: this.#password,
    });
    let options = Object.freeze({
      baseUrl,
      studioRoot,
      env: environment,
      validateServerContract: async (request) => {
        if (!requestMatchesActiveServer(request)) throw new Error("stale attach");
        const validation = await this.#validateLiveContract();
        if (!requestMatchesActiveServer(request)) throw new Error("stale attach");
        if (!isPlain(validation) || validation.valid !== true) throw new Error("contract drift");
        return Object.freeze({ valid: true });
      },
    });
    try {
      const result = await callback(options);
      if (generation !== this.#generation || !this.#active) {
        throw serverError("OPENCODE_SERVER_STALE", "The OpenCode server changed during attach.");
      }
      return result;
    } finally {
      options = null;
      environment = null;
    }
  }

  async #stopInternal() {
    const pendingRecovery = this.#recovery;
    this.#stopping = true;
    this.#starting = false;
    this.#active = null;
    this.#detachAbort();
    this.#generation += 1;
    this.#startAbort?.abort();
    await this.#preflightDone;
    await pendingRecovery.catch(() => {});
    const child = this.#child;
    const cleanup = this.#isolationCleanup;
    let safeToCleanup = child === null && !this.#portMayBeOpen;
    if (child) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          await this.#settings.killTree(child);
        } catch {
          // Port closure below is authoritative.
        }
      }
      try {
        await this.#settings.waitForPortClosed(this.#settings.port);
        this.#portMayBeOpen = false;
        safeToCleanup = true;
      } catch {
        this.#stopping = false;
        throw serverError("OPENCODE_SERVER_STOP_FAILED", "The OpenCode server could not stop safely.");
      }
    } else if (this.#portMayBeOpen) {
      try {
        await this.#settings.waitForPortClosed(this.#settings.port);
        this.#portMayBeOpen = false;
        safeToCleanup = true;
      } catch {
        this.#stopping = false;
        throw serverError("OPENCODE_SERVER_STOP_FAILED", "The OpenCode server could not stop safely.");
      }
    }
    if (safeToCleanup && cleanup) {
      try {
        await cleanup();
      } catch {
        this.#password = null;
        this.#jobEnvironment = null;
        this.#manifestDigest = null;
        this.#mcpCapabilityDigest = null;
        this.#runtime = null;
        this.#stopping = false;
        throw serverError("OPENCODE_SERVER_STOP_FAILED", "The OpenCode server could not stop safely.");
      }
    }
    this.#child = null;
    this.#password = null;
    this.#jobEnvironment = null;
    this.#isolationCleanup = null;
    this.#manifestDigest = null;
    this.#mcpCapabilityDigest = null;
    this.#runtime = null;
    this.#portMayBeOpen = false;
    this.#startAbort = null;
    this.#preflightDone = Promise.resolve();
    this.#finishPreflight = null;
    this.#stopping = false;
    this.#recovery = Promise.resolve();
  }

  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = this.#stopInternal()
      .finally(() => { this.#stopPromise = null; });
    this.#stopped = this.#stopPromise;
    return this.#stopPromise;
  }
}
