import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startStudio } from "../src/index.js";

const studioRoot = join(import.meta.dirname, "..");

test("start.ps1 dot-sources normal bootstrap so the selected OpenCode reaches Node", async () => {
  const script = await readFile(join(studioRoot, "scripts", "start.ps1"), "utf8");

  assert.match(script, /\$bootstrapOutput\s*=\s*\.\s+\$BootstrapScript/iu);
  assert.match(script, /MANUAL_STUDIO_OPENCODE_PATH/iu);
  assert.match(script, /MANUAL_STUDIO_OPENCODE_VERSION/iu);
  assert.match(script, /&\s+node\.exe\s+"src[\\/]index\.js"/iu);
  assert.match(script, /if\s*\(\$Check\)[\s\S]*?-File\s+\$BootstrapScript\s+-Check/iu);
  assert.match(script, /WhatIfPreference[\s\S]*?-File\s+\$BootstrapScript\s+-WhatIf/iu);
  assert.doesNotMatch(
    script,
    /\.\s+\$BootstrapScript[^\r\n]*[\s\S]{0,240}\$LASTEXITCODE/iu,
  );
});

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function producer() {
  return Object.freeze({
    narrate: async () => {},
    compose: async () => {},
    verifyPreview: async () => {},
    render: async () => {},
    edit: async () => {},
    rebuild: async () => {},
    cancel: async () => {},
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function within(promise, label, timeoutMs = 2_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function service(overrides = {}) {
  return {
    authenticateAndPlan: async () => {},
    confirmManualLoginAndPlan: async () => {},
    updatePlan: async () => {},
    approvePlan: async () => {},
    execute: async () => {},
    reapproveExecution: async () => {},
    retryJob: async () => {},
    retryComposition: async () => {},
    cancelJob: async () => {},
    updateMediaPlan: async () => {},
    approvePreview: async () => {},
    close: async () => {},
    ...overrides,
  };
}

test("startStudio assembles and closes the production workflow graph", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "manual-studio-runtime-start-"));
  const publicRoot = join(root, "public");
  await mkdir(publicRoot);
  await Promise.all([
    writeFile(join(publicRoot, "index.html"), "<!doctype html><main id=\"app\"></main>", "utf8"),
    writeFile(join(publicRoot, "app.js"), "", "utf8"),
    writeFile(join(publicRoot, "styles.css"), "", "utf8"),
  ]);
  const calls = [];
  const port = await availablePort();
  const runtimeFactory = async (options) => {
    calls.push(["create", options.config.root, typeof options.producerFactory]);
    return Object.freeze({
      paths: Object.freeze({ opencode: join(root, "opencode.exe") }),
      runtime: Object.freeze({
        browserRuntime: {
          start: async () => {},
          sealAuthentication: async () => {},
          stop: async () => {},
          installApproval: async () => {},
          executeApproval: async () => ({
            schemaVersion: "1.0",
            jobId: "unused",
            generation: 1,
            planDigest: "0".repeat(64),
            status: "completed",
            callCount: 1,
          }),
          readExecutionTiming: () => ({
            schemaVersion: "1.0",
            clock: "unix_ms",
            jobId: "unused",
            generation: 1,
            planDigest: "0".repeat(64),
            complete: false,
            calls: [],
          }),
          readRecordingArtifact: async () => ({
            schemaVersion: "1.0",
            jobId: "unused",
            generation: 1,
            planDigest: "0".repeat(64),
            approvedCallId: "system.stop-video",
            recordingPath: "browser/generation-1-fixture/video.webm",
          }),
          readEvidenceArtifacts: async () => ({
            schemaVersion: "1.0",
            jobId: "unused",
            generation: 1,
            planDigest: "0".repeat(64),
            artifacts: [],
          }),
        },
        credentialVault: {
          load: async () => ({ username: "", password: "" }),
          save: async () => {},
        },
        executionLock: {
          acquire: async () => {},
          release: async () => {},
          cancel: async () => {},
        },
        openCodeServer: {
          startJob: async () => {},
          stop: async () => {},
          withAttachOptions: async () => {},
        },
        producer: producer(),
      }),
      close: async () => calls.push(["close"]),
    });
  };

  const studio = await within(startStudio({
    root,
    env: { MANUAL_STUDIO_PORT: String(port) },
    healthCheck: async () => ({ ready: true, checks: {} }),
    runtimeFactory,
  }), "startStudio");
  t.after(async () => {
    await studio.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  });

  assert.equal(studio.runtime.runtime.producer !== null, true);
  assert.equal(typeof studio.studioService.execute, "function");
  assert.equal(typeof studio.taskSupervisor.schedule, "function");
  assert.deepEqual(calls, [["create", root, "function"]]);

  await studio.close();
  await studio.close();
  assert.deepEqual(calls, [["create", root, "function"], ["close"]]);
});

test("startStudio removes stale per-job browser profiles before creating a runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "manual-studio-stale-browser-"));
  const publicRoot = join(root, "public");
  const browserRoot = join(root, ".runtime", "browser");
  const staleJobRoot = join(browserRoot, "job-aaaaaaaaaaaaaaaa");
  await mkdir(publicRoot);
  await mkdir(join(staleJobRoot, "profile"), { recursive: true });
  await Promise.all([
    writeFile(join(publicRoot, "index.html"), "<!doctype html><main></main>", "utf8"),
    writeFile(join(publicRoot, "app.js"), "", "utf8"),
    writeFile(join(publicRoot, "styles.css"), "", "utf8"),
    writeFile(join(staleJobRoot, "profile", "Preferences"), "stale", "utf8"),
  ]);
  t.after(() => rm(root, { force: true, recursive: true }));

  let runtimeCreated = false;
  const studio = await within(startStudio({
    root,
    env: { MANUAL_STUDIO_PORT: String(await availablePort()) },
    healthCheck: async () => ({ ready: true, checks: {} }),
    runtimeFactory: async () => {
      await assert.rejects(access(staleJobRoot), { code: "ENOENT" });
      await access(browserRoot);
      runtimeCreated = true;
      return {
        paths: { opencode: join(root, "opencode.exe") },
        runtime: {
          browserRuntime: {},
          credentialVault: {
            load: async () => ({ username: "", password: "" }),
            save: async () => {},
          },
          executionLock: {},
          openCodeServer: {},
          producer: producer(),
        },
        close: async () => {},
      };
    },
    serviceFactory: () => service(),
  }), "startStudio stale browser cleanup");
  t.after(() => studio.close().catch(() => undefined));

  assert.equal(runtimeCreated, true);
  await studio.close();
});

test("startStudio drains the workflow service before closing shared runtimes", { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "manual-studio-runtime-drain-"));
  await mkdir(join(root, "public"));
  await Promise.all([
    writeFile(join(root, "public", "index.html"), "<!doctype html><main></main>", "utf8"),
    writeFile(join(root, "public", "app.js"), "", "utf8"),
    writeFile(join(root, "public", "styles.css"), "", "utf8"),
  ]);
  t.after(() => rm(root, { force: true, recursive: true }));

  const drain = deferred();
  const calls = [];
  const studio = await within(startStudio({
    root,
    env: { MANUAL_STUDIO_PORT: String(await availablePort()) },
    healthCheck: async () => ({ ready: true, checks: {} }),
    runtimeFactory: async () => ({
      paths: { opencode: join(root, "opencode.exe") },
      runtime: {
        browserRuntime: {},
        credentialVault: {
          load: async () => ({ username: "", password: "" }),
          save: async () => {},
        },
        executionLock: {},
        openCodeServer: {},
        producer: producer(),
      },
      close: async () => calls.push("runtime.close"),
    }),
    serviceFactory: () => service({
      close: async () => {
        calls.push("service.close:start");
        await drain.promise;
        calls.push("service.close:end");
      },
    }),
  }), "startStudio drain");
  t.after(async () => {
    drain.resolve();
    await studio.close().catch(() => undefined);
  });

  const closing = studio.close();
  await waitFor(() => calls.includes("service.close:start"));
  assert.deepEqual(calls, ["service.close:start"]);

  drain.resolve();
  await within(closing, `close ${JSON.stringify(calls)}`);
  assert.deepEqual(calls, [
    "service.close:start",
    "service.close:end",
    "runtime.close",
  ]);
});
