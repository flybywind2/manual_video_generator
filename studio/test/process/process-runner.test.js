import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runProcess } from "../../src/process/process-runner.js";
import { createRedactor } from "../../src/security/redactor.js";

async function fixture(t, source) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-studio-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, "child.mjs");
  await writeFile(script, source, "utf8");
  return { directory, script };
}

test("runProcess emits redacted bounded stdout and stderr lines before returning them", async (t) => {
  const secret = "process-secret-123";
  const { directory, script } = await fixture(
    t,
    `process.stdout.write("first\\nsecret=${secret}\\n");\n` +
      `process.stderr.write("problem ${encodeURIComponent(secret)}\\n");\n`,
  );
  const observed = [];

  const result = await runProcess({
    command: process.execPath,
    args: [script],
    cwd: directory,
    env: {},
    timeoutMs: 5_000,
    redactor: createRedactor({ secrets: [secret], sensitiveKeys: [] }),
    onLine: async (line) => observed.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.deepEqual(observed, [
    { stream: "stdout", text: "first" },
    { stream: "stdout", text: "secret=[REDACTED]" },
    { stream: "stderr", text: "problem [REDACTED]" },
  ]);
  assert.equal(JSON.stringify({ observed, result }).includes(secret), false);
  assert.equal(result.stdout, "first\nsecret=[REDACTED]\n");
  assert.equal(result.stderr, "problem [REDACTED]\n");
  assert.equal(Object.isFrozen(result), true);
});

test("runProcess reports the exact clean, nonzero, and signaled process result", async (t) => {
  const { directory, script } = await fixture(t, "process.exitCode = 23;\n");
  const result = await runProcess({
    command: process.execPath,
    args: [script],
    cwd: directory,
    env: {},
    timeoutMs: 5_000,
  });

  assert.deepEqual(
    { exitCode: result.exitCode, signal: result.signal },
    { exitCode: 23, signal: null },
  );
});

test("runProcess rejects already-aborted and mid-flight aborted work with safe errors", async (t) => {
  const secret = "abort-error-secret";
  const { directory, script } = await fixture(
    t,
    `process.stderr.write("${secret}\\n"); setInterval(() => {}, 1000);\n`,
  );
  const already = new AbortController();
  already.abort(new Error(secret));
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: [script],
      cwd: directory,
      env: {},
      signal: already.signal,
      timeoutMs: 5_000,
    }),
    (error) => error.code === "PROCESS_ABORTED" && !String(error).includes(secret),
  );

  const controller = new AbortController();
  const running = runProcess({
    command: process.execPath,
    args: [script],
    cwd: directory,
    env: {},
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  setTimeout(() => controller.abort(new Error(secret)), 100);
  await assert.rejects(
    running,
    (error) => error.code === "PROCESS_ABORTED" && !JSON.stringify(error).includes(secret),
  );
});

test("runProcess enforces timeout and kills a Windows descendant process tree", {
  skip: process.platform !== "win32",
}, async (t) => {
  const { directory, script } = await fixture(
    t,
    `import { spawn } from "node:child_process";\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });\n` +
      `writeFileSync(new URL("grandchild.pid", import.meta.url), String(child.pid));\n` +
      `setInterval(() => {}, 1000);\n`,
  );
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: [script],
      cwd: directory,
      env: {},
      timeoutMs: 500,
    }),
    (error) => error.code === "PROCESS_TIMEOUT",
  );
  const pid = Number(await readFile(path.join(directory, "grandchild.pid"), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/iu);
});

test("runProcess kills work when the line callback fails without leaking callback text", async (t) => {
  const secret = "callback-secret";
  const { directory, script } = await fixture(
    t,
    'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);\n',
  );
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: [script],
      cwd: directory,
      env: {},
      timeoutMs: 5_000,
      onLine: () => {
        throw new Error(secret);
      },
    }),
    (error) =>
      error.code === "PROCESS_CALLBACK_FAILED" && !JSON.stringify(error).includes(secret),
  );
});

test("runProcess rejects native shims, relative executables, unsafe argv and inherited option getters", async () => {
  const root = path.resolve(".");
  const base = { args: [], cwd: root, env: {}, timeoutMs: 100 };
  for (const command of ["tool.exe", "C:\\tools\\tool.cmd", "C:\\tools\\tool.ps1"]) {
    await assert.rejects(
      runProcess({ command, ...base }),
      (error) => error.code === "INVALID_PROCESS_OPTIONS",
    );
  }

  const sparse = [];
  sparse.length = 1;
  await assert.rejects(
    runProcess({ command: process.execPath, ...base, args: sparse }),
    (error) => error.code === "INVALID_PROCESS_OPTIONS",
  );

  const options = Object.create({ get command() { throw new Error("getter secret"); } });
  await assert.rejects(
    runProcess(options),
    (error) => error.code === "INVALID_PROCESS_OPTIONS" && !String(error).includes("secret"),
  );
});

test("runProcess fails closed on oversized output lines and total output", async (t) => {
  const { directory, script } = await fixture(
    t,
    'process.stdout.write("x".repeat(70_000)); setInterval(() => {}, 1000);\n',
  );
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: [script],
      cwd: directory,
      env: {},
      timeoutMs: 5_000,
    }),
    (error) => error.code === "PROCESS_OUTPUT_LIMIT",
  );
});

test("runProcess settles after termination even when a child never emits close", async () => {
  class NeverClosingChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 987_654;
      this.exitCode = null;
      this.signalCode = null;
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
    }
  }

  const child = new NeverClosingChild();
  let killed = 0;
  const startedAt = Date.now();
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: [path.resolve("never-closes.mjs")],
      cwd: path.resolve("."),
      env: {},
      timeoutMs: 20,
      spawnProcess: () => child,
      killTree: async () => {
        killed += 1;
        child.exitCode = 137;
      },
    }),
    (error) => error.code === "PROCESS_TIMEOUT",
  );
  assert.equal(killed, 1);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("runProcess reports unconfirmed termination instead of releasing a live child", async () => {
  class StillRunningChild extends EventEmitter {
    constructor() {
      super();
      this.pid = process.pid;
      this.exitCode = null;
      this.signalCode = null;
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
    }
  }

  const child = new StillRunningChild();
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: [path.resolve("still-running.mjs")],
      cwd: path.resolve("."),
      env: {},
      timeoutMs: 20,
      spawnProcess: () => child,
      killTree: async () => {},
    }),
    (error) => error.code === "PROCESS_TERMINATION_FAILED",
  );
});

test("runProcess bounds a callback that never settles after the child closes", async (t) => {
  const { directory, script } = await fixture(
    t,
    'process.stdout.write("ready\\n");\n',
  );
  const never = new Promise(() => {});
  const startedAt = Date.now();
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: [script],
      cwd: directory,
      env: {},
      timeoutMs: 5_000,
      onLine: () => never,
    }),
    (error) => error.code === "PROCESS_CALLBACK_FAILED",
  );
  assert.ok(Date.now() - startedAt < 3_000);
});

test("runProcess rejects case-insensitive duplicate Windows environment keys", async (t) => {
  const { directory, script } = await fixture(t, "process.exit(0);\n");
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: [script],
      cwd: directory,
      env: { Path: "C:\\one", PATH: "C:\\two" },
      timeoutMs: 1_000,
    }),
    (error) => error.code === "INVALID_PROCESS_OPTIONS",
  );
});

test("runProcess recognizes the Node executable with Windows path casing differences", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows path semantics only");
    return;
  }
  const { directory, script } = await fixture(t, 'process.stdout.write("ok\\n");\n');
  const result = await runProcess({
    command: process.execPath.toUpperCase(),
    args: [script],
    cwd: directory,
    env: {},
    timeoutMs: 2_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok\n");
});
