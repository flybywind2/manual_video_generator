import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runProcess } from "../../src/process/process-runner.js";

const execFileAsync = promisify(execFile);
const studioRoot = path.resolve(".");
const configPath = path.join(studioRoot, "opencode.json");
const plannerPath = path.join(studioRoot, ".opencode", "agents", "manual-video-planner.md");
const executorPath = path.join(studioRoot, ".opencode", "agents", "manual-video-executor.md");
const opencodeServerPath = path.join(studioRoot, "src", "adapters", "opencode-server.js");
const mcpCapabilityToken = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const ACTUAL_OPENCODE_ENV = Object.freeze({
  "1.17.19": "MANUAL_STUDIO_TEST_OPENCODE_1_17_19_PATH",
  "1.18.2": "MANUAL_STUDIO_TEST_OPENCODE_1_18_2_PATH",
});
const MAX_WIRE_REQUEST_BYTES = 256 * 1024;
const MAX_WIRE_TOOLS = 64;
const WIRE_CAPTURE_TIMEOUT_MS = 15_000;
const plannerTools = Object.freeze([
  "playwright_browser_snapshot",
  "playwright_browser_wait_for",
  "playwright_browser_take_screenshot",
]);
const executorTools = Object.freeze([
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
]);

function parseFrontMatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u);
  assert.ok(match, "agent must have YAML front matter");
  const header = {};
  let section;
  for (const line of match[1].split(/\r?\n/u)) {
    const top = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/u);
    if (top) {
      section = top[1];
      header[section] = top[2] || {};
      continue;
    }
    const nested = line.match(/^  "?([*a-zA-Z_][\w*.-]*)"?:\s*(\w+)$/u);
    if (nested && section && typeof header[section] === "object") {
      header[section][nested[1]] = nested[2];
    }
  }
  return { body: match[2], header };
}

test("opencode.json configures only the coordinator-owned loopback Playwright MCP", async () => {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(config.mcp, {
    playwright: {
      type: "remote",
      url: "http://127.0.0.1:8931/mcp",
      enabled: true,
      oauth: false,
      headers: {
        Authorization: "Bearer {env:MANUAL_STUDIO_MCP_TOKEN}",
      },
    },
  });
  assert.equal("model" in config, false);
  assert.equal("small_model" in config, false);
  assert.equal("plugin" in config, false);
});

test("global and agent permissions deny everything then allow only exact required Playwright tools", async () => {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.permission["*"], "deny");
  assert.deepEqual(
    Object.keys(config.permission).filter((key) => config.permission[key] === "allow").sort(),
    [],
  );
  for (const forbidden of [
    "bash",
    "edit",
    "webfetch",
    "websearch",
    "task",
    "external_directory",
    "question",
    "playwright_browser_run_code_unsafe",
    "playwright_browser_evaluate",
    "playwright_browser_file_upload",
    "playwright_browser_network_state_set",
    "playwright_browser_storage_state",
    "playwright_browser_navigate",
    "playwright_browser_navigate_back",
    "playwright_browser_tabs",
  ]) {
    assert.notEqual(config.permission[forbidden], "allow");
  }

  for (const [file, expectedTools] of [
    [plannerPath, plannerTools],
    [executorPath, executorTools],
  ]) {
    const agent = parseFrontMatter(await readFile(file, "utf8"));
    assert.equal(agent.header.mode, "primary");
    assert.equal("model" in agent.header, false);
    assert.equal(agent.header.permission["*"], "deny");
    assert.deepEqual(
      Object.keys(agent.header.permission).filter((key) => agent.header.permission[key] === "allow").sort(),
      [...expectedTools].sort(),
    );
  }
});

test("planner cannot perform business actions or start recording before approval", async () => {
  const planner = parseFrontMatter(await readFile(plannerPath, "utf8"));
  assert.notEqual(planner.header.permission.playwright_browser_navigate, "allow");
  assert.notEqual(planner.header.permission.playwright_browser_navigate_back, "allow");
  for (const tool of [
    "playwright_browser_click",
    "playwright_browser_type",
    "playwright_browser_fill_form",
    "playwright_browser_press_key",
    "playwright_browser_start_video",
    "playwright_browser_stop_video",
    "playwright_browser_video_chapter",
    "playwright_browser_video_show_actions",
    "playwright_browser_video_hide_actions",
  ]) {
    assert.notEqual(planner.header.permission[tool], "allow");
  }

  const executor = parseFrontMatter(await readFile(executorPath, "utf8"));
  assert.notEqual(executor.header.permission.playwright_browser_navigate, "allow");
  assert.notEqual(executor.header.permission.playwright_browser_navigate_back, "allow");
  assert.notEqual(executor.header.permission.playwright_browser_tabs, "allow");
});

test("planner and executor prompts enforce immutable JSON-only plan and digest-bound evidence execution", async () => {
  const planner = parseFrontMatter(await readFile(plannerPath, "utf8"));
  assert.match(planner.body, /one JSON plan object/iu);
  assert.match(planner.body, /never start (?:video )?recording|do not start (?:video )?recording/iu);
  assert.match(planner.body, /forbidden actions/iu);
  assert.match(planner.body, /target origin/iu);
  assert.match(planner.body, /omit the `filename` argument/iu);
  assert.match(planner.body, /never navigate by URL or browser history/iu);
  assert.match(planner.body, /schemaVersion.*1\.1/isu);
  assert.match(planner.body, /authOrigins.*resourceOrigins/isu);
  assert.match(planner.body, /1920.*1080.*30/isu);
  assert.match(planner.body, /must exactly equal.*coordinator-supplied/iu);
  assert.match(planner.body, /exact ordered `calls`/iu);
  assert.match(planner.body, /browser_(?:click|fill_form|press_key|type|wait_for)/iu);
  assert.match(planner.body, /Each step must have between 1 and 10 calls/iu);
  assert.match(planner.body, /getByRole.*exact: true/isu);
  assert.match(planner.body, /getByText.*visible.*label.*exact: true/isu);
  assert.match(planner.body, /regex.*chaining.*CSS.*XPath.*`text=`/isu);
  assert.match(planner.body, /never put ephemeral `eN` or `fNeN`/iu);

  const executor = parseFrontMatter(await readFile(executorPath, "utf8"));
  assert.match(executor.body, /approved plan digest/iu);
  assert.match(executor.body, /start video recording/iu);
  assert.match(executor.body, /one evidence record per step/iu);
  assert.match(executor.body, /stop immediately.*mismatch/isu);
  assert.match(executor.body, /one JSON execution report/iu);
  assert.match(executor.body, /omit the `filename` argument/iu);
  assert.match(executor.body, /never navigate by URL or browser history/iu);
  assert.match(executor.body, /schemaVersion.*1\.0/isu);
  assert.match(executor.body, /exact supplied call queue/iu);
  assert.match(executor.body, /toolCalls.*steps/isu);
});

test("trusted project digest matches the exact OpenCode config and agent prompts", async () => {
  const files = [
    ["opencode.json", configPath],
    [".opencode/agents/manual-video-planner.md", plannerPath],
    [".opencode/agents/manual-video-executor.md", executorPath],
  ];
  const hash = createHash("sha256");
  for (const [relative, file] of files) {
    const source = (await readFile(file, "utf8")).replace(/\r\n?|\n/gu, "\n");
    hash.update(relative, "utf8");
    hash.update(Buffer.from([0]));
    hash.update(source, "utf8");
    hash.update(Buffer.from([0]));
  }
  const serverSource = await readFile(opencodeServerPath, "utf8");
  const trusted = serverSource.match(/const TRUSTED_PROJECT_DIGEST = "([a-f0-9]{64})";/u);
  assert.ok(trusted);
  assert.equal(trusted[1], hash.digest("hex"));
});

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
  return executable;
}

function actualOpenCodeSkip(expectedVersion) {
  if (process.platform !== "win32") return "actual OpenCode contract tests require Windows";
  const variable = ACTUAL_OPENCODE_ENV[expectedVersion];
  if (typeof process.env[variable] !== "string" || process.env[variable].trim() === "") {
    return `actual OpenCode ${expectedVersion} contract tests require ${variable}`;
  }
  return false;
}

async function isolatedProject(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "manual-studio-opencode-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(configPath, path.join(root, "opencode.json"));
  await mkdir(path.join(root, ".opencode", "agents"), { recursive: true });
  await cp(plannerPath, path.join(root, ".opencode", "agents", "manual-video-planner.md"));
  await cp(executorPath, path.join(root, ".opencode", "agents", "manual-video-executor.md"));
  const home = path.join(root, ".isolated-home");
  const appData = path.join(home, "AppData", "Roaming");
  const localData = path.join(home, "AppData", "Local");
  for (const directory of [home, appData, localData]) await mkdir(directory, { recursive: true });
  const env = {
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    Path: process.env.Path ?? "",
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    TEMP: process.env.TEMP ?? os.tmpdir(),
    TMP: process.env.TMP ?? os.tmpdir(),
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localData,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    MANUAL_STUDIO_MCP_TOKEN: mcpCapabilityToken,
  };
  return { env, root };
}

async function debugJson(executable, args, fixture) {
  const result = await execFileAsync(executable, args, {
    cwd: fixture.root,
    env: fixture.env,
    encoding: "utf8",
    timeout: 45_000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.stderr.includes("password"), false);
  assert.equal(result.stderr.includes(mcpCapabilityToken), false);
  return JSON.parse(result.stdout);
}

async function openWireCaptureServer(t) {
  let captureSettled = false;
  let resolveCapture;
  let rejectCapture;
  const captured = new Promise((resolvePromise, rejectPromise) => {
    resolveCapture = resolvePromise;
    rejectCapture = rejectPromise;
  });
  void captured.catch(() => {});
  const settleCapture = (callback, value) => {
    if (captureSettled) return;
    captureSettled = true;
    clearTimeout(captureTimer);
    callback(value);
  };
  const captureTimer = setTimeout(() => {
    settleCapture(rejectCapture, new Error("OpenCode wire request was not received in time."));
  }, WIRE_CAPTURE_TIMEOUT_MS);

  const server = createServer((request, response) => {
    if (captureSettled) {
      response.writeHead(409).end();
      return;
    }
    let bytes = 0;
    let requestFailed = false;
    const chunks = [];
    const rejectRequest = (status, message) => {
      if (requestFailed) return;
      requestFailed = true;
      if (!response.headersSent) response.writeHead(status);
      response.end();
      request.destroy();
      settleCapture(rejectCapture, new Error(message));
    };
    request.setTimeout(WIRE_CAPTURE_TIMEOUT_MS, () => {
      rejectRequest(408, "OpenCode wire request body timed out.");
    });
    request.on("data", (chunk) => {
      if (requestFailed) return;
      bytes += chunk.length;
      if (bytes > MAX_WIRE_REQUEST_BYTES) {
        chunks.length = 0;
        rejectRequest(413, "OpenCode wire request body exceeded the limit.");
        return;
      }
      chunks.push(chunk);
    });
    request.once("aborted", () => {
      settleCapture(rejectCapture, new Error("OpenCode wire request was aborted."));
    });
    request.once("error", () => {
      settleCapture(rejectCapture, new Error("OpenCode wire request failed."));
    });
    request.once("end", () => {
      if (captureSettled || requestFailed || bytes > MAX_WIRE_REQUEST_BYTES) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
      } catch {
        rejectRequest(400, "OpenCode wire request body was not JSON.");
        return;
      }
      const newline = "\n";
      const responseBody = [
        'data: {"id":"wire","object":"chat.completion.chunk","created":1,"model":"gemma4:12b_qat","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
        "",
        'data: {"id":"wire","object":"chat.completion.chunk","created":1,"model":"gemma4:12b_qat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        "",
        'data: {"id":"wire","object":"chat.completion.chunk","created":1,"model":"gemma4:12b_qat","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
        "",
        "data: [DONE]",
        "",
      ].join(newline);
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "close",
      });
      response.end(responseBody);
      settleCapture(resolveCapture, Object.freeze({
        body,
        method: request.method,
        path: request.url,
      }));
    });
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = WIRE_CAPTURE_TIMEOUT_MS;
  server.keepAliveTimeout = 1_000;
  server.on("clientError", (_error, socket) => {
    socket.destroy();
    settleCapture(rejectCapture, new Error("OpenCode wire client failed."));
  });
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      const onError = () => rejectPromise(new Error("OpenCode wire capture could not listen."));
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolvePromise();
      });
    });
  } catch (error) {
    settleCapture(rejectCapture, error);
    if (server.listening) {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
    throw error;
  }
  server.on("error", () => {
    settleCapture(rejectCapture, new Error("OpenCode wire capture server failed."));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    settleCapture(rejectCapture, new Error("OpenCode wire capture closed."));
    if (!server.listening) return;
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => error
        ? rejectPromise(new Error("OpenCode wire capture did not close."))
        : resolvePromise());
      server.closeAllConnections();
    });
  };
  t.after(close);
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    captured,
    close,
  });
}

async function isolatedWireProject(t, baseUrl) {
  const root = await mkdtemp(path.join(os.tmpdir(), "manual-studio-opencode-wire-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const appData = path.join(root, "appdata");
  const localAppData = path.join(root, "localappdata");
  const configHome = path.join(root, "config");
  const opencodeHome = path.join(configHome, "opencode");
  const dataHome = path.join(root, "data");
  const cacheHome = path.join(root, "cache");
  const stateHome = path.join(root, "state");
  const runtimeHome = path.join(root, "runtime");
  for (const directory of [
    home,
    appData,
    localAppData,
    opencodeHome,
    dataHome,
    cacheHome,
    stateHome,
    runtimeHome,
  ]) {
    await mkdir(directory, { recursive: true });
  }
  const model = "gemma4:12b_qat";
  await writeFile(path.join(opencodeHome, "opencode.json"), `${JSON.stringify({
    model: `ollama/${model}`,
    small_model: `ollama/${model}`,
    provider: {
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        name: "Bounded wire capture",
        options: {
          baseURL: baseUrl,
          apiKey: "wire-test",
        },
        models: {
          [model]: {
            name: "Gemma 4 12B QAT wire capture",
            tool_call: true,
            options: {
              reasoningEffort: "none",
            },
          },
        },
      },
    },
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return Object.freeze({
    root,
    env: {
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      Path: process.env.Path ?? "",
      PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
      TEMP: process.env.TEMP ?? os.tmpdir(),
      TMP: process.env.TMP ?? os.tmpdir(),
      HOME: home,
      USERPROFILE: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
      XDG_STATE_HOME: stateHome,
      XDG_RUNTIME_DIR: runtimeHome,
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    },
  });
}

for (const expectedVersion of ["1.17.19", "1.18.2"]) {
  test(`actual OpenCode ${expectedVersion} resolves the isolated config and both primary agents without model drift`, {
    skip: actualOpenCodeSkip(expectedVersion),
    timeout: 120_000,
  }, async (t) => {
    const executable = await supportedOpenCode(expectedVersion);
    const fixture = await isolatedProject(t);
    const resolved = await debugJson(executable, ["debug", "config", "--pure"], fixture);
    assert.equal(resolved.model, undefined);
    assert.equal(resolved.small_model, undefined);
    assert.deepEqual(Object.keys(resolved.mcp), ["playwright"]);
    assert.equal(resolved.mcp.playwright.url, "http://127.0.0.1:8931/mcp");
    assert.deepEqual(resolved.mcp.playwright.headers, {
      Authorization: `Bearer ${mcpCapabilityToken}`,
    });
    assert.equal(resolved.permission["*"], "deny");

    for (const name of ["manual-video-planner", "manual-video-executor"]) {
      const agent = await debugJson(executable, ["debug", "agent", name, "--pure"], fixture);
      assert.equal(agent.name, name);
      assert.equal(agent.mode, "primary");
      assert.equal(agent.model, undefined);
    }
  });

  test(`actual OpenCode ${expectedVersion} isolated agents reject native and unsafe browser tools`, {
    skip: actualOpenCodeSkip(expectedVersion),
    timeout: 120_000,
  }, async (t) => {
    const executable = await supportedOpenCode(expectedVersion);
    const fixture = await isolatedProject(t);
    for (const tool of [
      "bash",
      "edit",
      "webfetch",
      "websearch",
      "external_directory",
      "playwright_browser_run_code_unsafe",
      "playwright_browser_evaluate",
      "playwright_browser_file_upload",
    ]) {
      await assert.rejects(
        execFileAsync(
          executable,
          ["debug", "agent", "manual-video-executor", "--tool", tool, "--params", "{}", "--pure"],
          { cwd: fixture.root, env: fixture.env, encoding: "utf8", timeout: 30_000, windowsHide: true, maxBuffer: 256 * 1024 },
        ),
        (error) => {
          const safe = `${error.stdout ?? ""}${error.stderr ?? ""}`;
          return !safe.includes("automatic-password") && /(?:disabled|denied|not found|not_found)/iu.test(safe);
        },
      );
    }
  });

  test(`actual OpenCode ${expectedVersion} forwards the bounded Gemma tool-call compatibility request`, {
    skip: actualOpenCodeSkip(expectedVersion),
    timeout: 60_000,
  }, async (t) => {
    const executable = await supportedOpenCode(expectedVersion);
    const wire = await openWireCaptureServer(t);
    const fixture = await isolatedWireProject(t, wire.baseUrl);
    let outcomes;
    try {
      outcomes = await Promise.allSettled([
        runProcess({
          command: executable,
          args: [
            "run",
            "--pure",
            "--format",
            "json",
            "--title",
            `wire-${expectedVersion}`,
            "--model",
            "ollama/gemma4:12b_qat",
            "Return exactly OK. Do not call any tool.",
          ],
          cwd: fixture.root,
          env: fixture.env,
          timeoutMs: 30_000,
        }),
        wire.captured,
      ]);
    } finally {
      await wire.close();
    }

    const [processOutcome, captureOutcome] = outcomes;
    assert.equal(processOutcome.status, "fulfilled", "OpenCode wire process must finish safely");
    assert.equal(captureOutcome.status, "fulfilled", "OpenCode wire request must be captured safely");
    const result = processOutcome.value;
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stdout.includes("wire-test"), false);
    assert.equal(result.stderr.includes("wire-test"), false);

    const request = captureOutcome.value;
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/v1/chat/completions");
    assert.equal(request.body.model, "gemma4:12b_qat");
    assert.equal(request.body.reasoning_effort, "none");
    assert.equal(Object.hasOwn(request.body, "extraBody"), false);
    assert.equal(request.body.stream, true);
    assert.equal(Array.isArray(request.body.tools), true);
    assert.ok(request.body.tools.length > 0);
    assert.ok(request.body.tools.length <= MAX_WIRE_TOOLS);
    for (const tool of request.body.tools) {
      assert.equal(tool?.type, "function");
      assert.equal(typeof tool?.function?.name, "string");
      assert.ok(tool.function.name.length > 0);
    }
  });
}
