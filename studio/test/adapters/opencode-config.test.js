import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { resolveOpenCodeInstallation } from "../../src/runtime/opencode-installation.js";

const execFileAsync = promisify(execFile);
const studioRoot = path.resolve(".");
const configPath = path.join(studioRoot, "opencode.json");
const plannerPath = path.join(studioRoot, ".opencode", "agents", "manual-video-planner.md");
const executorPath = path.join(studioRoot, ".opencode", "agents", "manual-video-executor.md");
const opencodeServerPath = path.join(studioRoot, "src", "adapters", "opencode-server.js");
const mcpCapabilityToken = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
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
  const selection = expectedVersion === "1.17.19"
    ? {
        path: path.join(
          studioRoot,
          ".runtime",
          "opencode-1.17.19-probe",
          "node_modules",
          "opencode-ai",
          "bin",
          "opencode.exe",
        ),
        version: expectedVersion,
      }
    : await resolveOpenCodeInstallation({
        environment: process.env,
        mode: "check",
        runtimeRoot: path.join(studioRoot, ".runtime", "opencode"),
        studioRoot,
      });
  const executable = await realpath(selection.path);
  const stat = await lstat(executable);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(path.extname(executable).toLowerCase(), ".exe");
  const result = await execFileAsync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${expectedVersion}\n`);
  assert.equal(selection.version, expectedVersion);
  return executable;
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

for (const expectedVersion of ["1.17.19", "1.18.2"]) {
  test(`actual OpenCode ${expectedVersion} resolves the isolated config and both primary agents without model drift`, {
    skip: process.platform !== "win32",
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
    skip: process.platform !== "win32",
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
}
