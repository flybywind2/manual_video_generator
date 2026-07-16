import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runOpenCodeRuntimeCli } from "../../scripts/opencode-runtime.mjs";

const scriptPath = fileURLToPath(new URL("../../scripts/opencode-runtime.mjs", import.meta.url));

const unavailable = {
  ready: false,
  minimum: "1.17.19",
  fallback: "1.18.2",
  path: null,
  source: null,
  version: null,
  code: "OPENCODE_UNAVAILABLE",
};

function spawnRuntimeCli(argv, environment = {}) {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const env = { ...process.env, ...environment };
    if (!Object.prototype.hasOwnProperty.call(environment, "MANUAL_STUDIO_OPENCODE_PATH")) {
      delete env.MANUAL_STUDIO_OPENCODE_PATH;
    }
    const child = spawn(process.execPath, [scriptPath, ...argv], {
      encoding: "utf8",
      env,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectSpawn);
    child.once("close", (exitCode, signal) => {
      resolveSpawn({ exitCode, signal, stderr, stdout });
    });
  });
}

test("the runtime CLI forwards check mode and emits one exact compact ready JSON line", async () => {
  const studioRoot = "C:\\safe\\studio";
  const runtimeRoot = join(studioRoot, ".runtime", "opencode");
  const environment = { PATH: "C:\\safe\\tools" };
  const calls = [];
  let stdout = "";

  const exitCode = await runOpenCodeRuntimeCli({
    argv: ["check", studioRoot, runtimeRoot],
    environment,
    resolveInstallation: async (options) => {
      calls.push(options);
      return { path: "C:\\safe\\opencode.exe", source: "path", version: "1.18.2" };
    },
    stdout: { write: (value) => { stdout += value; } },
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout, `${JSON.stringify({
    ready: true,
    minimum: "1.17.19",
    fallback: "1.18.2",
    path: "C:\\safe\\opencode.exe",
    source: "path",
    version: "1.18.2",
  })}\n`);
  assert.deepEqual(calls, [{ mode: "check", studioRoot, runtimeRoot, environment }]);
  assert.equal("explicitPath" in calls[0], false);
});

test("the runtime CLI forwards prepare mode and only includes an actually present explicit override", async () => {
  const studioRoot = "C:\\safe\\studio";
  const runtimeRoot = join(studioRoot, ".runtime", "opencode");
  const environment = { MANUAL_STUDIO_OPENCODE_PATH: "" };
  let forwarded;
  let stdout = "";

  const exitCode = await runOpenCodeRuntimeCli({
    argv: ["prepare", studioRoot, runtimeRoot],
    environment,
    resolveInstallation: async (options) => {
      forwarded = options;
      return {
        path: join(runtimeRoot, "node_modules", "opencode-ai", "bin", "opencode.exe"),
        source: "project",
        version: "1.18.2",
      };
    },
    stdout: { write: (value) => { stdout += value; } },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(forwarded, {
    mode: "prepare",
    studioRoot,
    runtimeRoot,
    environment,
    explicitPath: "",
  });
  const parsed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed), [
    "ready",
    "minimum",
    "fallback",
    "path",
    "source",
    "version",
  ]);
  assert.deepEqual(parsed, {
    ready: true,
    minimum: "1.17.19",
    fallback: "1.18.2",
    path: join(runtimeRoot, "node_modules", "opencode-ai", "bin", "opencode.exe"),
    source: "project",
    version: "1.18.2",
  });
  assert.equal(stdout, `${JSON.stringify(parsed)}\n`);
});

test("the runtime CLI sanitizes resolver failures into one exact unavailable JSON line", async () => {
  const studioRoot = "C:\\private-root-secret\\studio";
  const runtimeRoot = join(studioRoot, ".runtime", "opencode");
  let stdout = "";

  const exitCode = await runOpenCodeRuntimeCli({
    argv: ["prepare", studioRoot, runtimeRoot],
    environment: { API_SECRET: "environment-secret" },
    resolveInstallation: async () => {
      throw new Error("resolver-secret environment-secret C:\\private-root-secret");
    },
    stdout: { write: (value) => { stdout += value; } },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout, `${JSON.stringify(unavailable)}\n`);
  assert.deepEqual(Object.keys(JSON.parse(stdout)), Object.keys(unavailable));
  assert.equal(stdout.includes("resolver-secret"), false);
  assert.equal(stdout.includes("environment-secret"), false);
  assert.equal(stdout.includes("private-root-secret"), false);
});

test("the actual runtime script rejects strict argument and root violations with one JSON line and no stderr", async () => {
  const studioRoot = "C:\\safe\\studio";
  const runtimeRoot = join(studioRoot, ".runtime", "opencode");
  const cases = [
    [],
    ["check", studioRoot],
    ["check", studioRoot, runtimeRoot, "extra"],
    ["unknown", studioRoot, runtimeRoot],
    ["check", "relative-studio", "relative-runtime"],
    ["prepare", studioRoot, "C:\\other\\runtime"],
  ];

  for (const argv of cases) {
    const result = await spawnRuntimeCli(argv);
    assert.notEqual(result.exitCode, 0, argv.join(" "));
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${JSON.stringify(unavailable)}\n`);
    assert.equal(result.stdout.trim(), JSON.stringify(JSON.parse(result.stdout)));
  }
});

test("the actual runtime script emits sanitized unavailable JSON when check discovery is exhausted", async () => {
  const studioRoot = await mkdtemp(join(tmpdir(), "opencode-cli-PRIVATE_ROOT_SECRET-"));
  const runtimeRoot = join(studioRoot, ".runtime", "opencode");
  const emptyPath = join(studioRoot, "empty-path");
  await mkdir(emptyPath);

  try {
    const result = await spawnRuntimeCli(
      ["check", studioRoot, runtimeRoot],
      {
        PATH: emptyPath,
        PATHEXT: ".EXE;.CMD",
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows",
        WRAPPER_ENV_SECRET: "must-not-appear",
      },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${JSON.stringify(unavailable)}\n`);
    assert.equal(result.stdout.includes("PRIVATE_ROOT_SECRET"), false);
    assert.equal(result.stdout.includes("must-not-appear"), false);
  } finally {
    await rm(studioRoot, { recursive: true, force: true });
  }
});

test("the runner rejects lexically traversing roots before calling the resolver", async () => {
  const studioRoot = "C:\\safe\\studio";
  const traversingRuntime = `${studioRoot}\\.runtime\\child\\..\\opencode`;
  let resolverCalls = 0;
  let stdout = "";

  const exitCode = await runOpenCodeRuntimeCli({
    argv: ["prepare", studioRoot, traversingRuntime],
    resolveInstallation: async () => {
      resolverCalls += 1;
      return { path: "C:\\unsafe\\opencode.exe", source: "path", version: "1.18.2" };
    },
    stdout: { write: (value) => { stdout += value; } },
  });

  assert.equal(exitCode, 1);
  assert.equal(resolverCalls, 0);
  assert.equal(stdout, `${JSON.stringify(unavailable)}\n`);
});

test("an actually present invalid explicit override is terminal in the spawned check CLI", async () => {
  const studioRoot = await mkdtemp(join(tmpdir(), "opencode-cli-explicit-root-"));
  const runtimeRoot = join(studioRoot, ".runtime", "opencode");
  try {
    const result = await spawnRuntimeCli(
      ["check", studioRoot, runtimeRoot],
      { MANUAL_STUDIO_OPENCODE_PATH: "relative-explicit-secret" },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${JSON.stringify(unavailable)}\n`);
    assert.equal(result.stdout.includes("relative-explicit-secret"), false);
  } finally {
    await rm(studioRoot, { recursive: true, force: true });
  }
});
