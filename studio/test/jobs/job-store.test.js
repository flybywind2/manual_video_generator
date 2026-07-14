import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, watch, writeFileSync } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  JobStore,
  writeJsonAtomically,
} from "../../src/jobs/job-store.js";
import { EventBus } from "../../src/jobs/event-bus.js";

const CREATED_AT = "2026-07-14T01:02:03.000Z";

async function temporaryRoot(t) {
  const root = join(
    tmpdir(),
    `manual-video-job-store-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

function sequential(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForOutput(child, expected, timeoutMs = 5_000) {
  child.stdout.setEncoding("utf8");
  let output = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child output: ${output}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk;
      if (output.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Child exited with ${code}: ${output}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.on("exit", onExit);
  });
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
}

function request(overrides = {}) {
  return {
    targetUrl: "https://fixture.example.test/login",
    prompt: "프로젝트 메뉴를 여는 방법을 안내해 주세요.",
    authMode: "manual",
    ...overrides,
  };
}

function parseEventLines(text) {
  assert.equal(text.endsWith("\n"), true);
  const lines = text.trimEnd().split("\n");
  for (const line of lines) {
    assert.equal(line, JSON.stringify(JSON.parse(line)));
  }
  return lines.map((line) => JSON.parse(line));
}

test("create writes request, snapshot, and a compact first event", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({
    root,
    now: () => CREATED_AT,
    randomId: () => "job-alpha",
  });

  const created = await store.create(request());
  const jobRoot = join(root, "job-alpha");
  const [requestText, jobText, eventText] = await Promise.all([
    readFile(join(jobRoot, "request.json"), "utf8"),
    readFile(join(jobRoot, "job.json"), "utf8"),
    readFile(join(jobRoot, "events.jsonl"), "utf8"),
  ]);

  assert.deepEqual(JSON.parse(requestText), request());
  assert.deepEqual(JSON.parse(jobText), {
    id: "job-alpha",
    state: "created",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    eventSequence: 1,
  });
  const events = parseEventLines(eventText);
  assert.deepEqual(events, [
    {
      jobId: "job-alpha",
      sequence: 1,
      timestamp: CREATED_AT,
      event: "JOB_CREATED",
      state: "created",
      data: {},
    },
  ]);
  assert.deepEqual(created, {
    id: "job-alpha",
    state: "created",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    eventSequence: 1,
    request: request(),
  });
  assert.match(events[0].timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.equal(Number.isNaN(Date.parse(events[0].timestamp)), false);
});

test("transition reuses the state contract, serializes writers, and appends one event", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({
    root,
    now: sequential([
      CREATED_AT,
      "2026-07-14T01:02:04.000Z",
      "2026-07-14T01:02:05.000Z",
    ]),
    randomId: () => "job-serial",
  });
  await store.create(request());

  const [authenticating, awaitingLogin] = await Promise.all([
    store.transition("job-serial", "START_AUTHENTICATION", {
      authMode: "manual",
    }),
    store.transition("job-serial", "AUTH_REQUIRED", { reason: "login" }),
  ]);

  assert.equal(authenticating.state, "authenticating");
  assert.equal(authenticating.eventSequence, 2);
  assert.equal(awaitingLogin.state, "awaiting_manual_login");
  assert.equal(awaitingLogin.eventSequence, 3);
  const beforeInvalid = await readFile(
    join(root, "job-serial", "events.jsonl"),
    "utf8",
  );
  await assert.rejects(
    store.transition("job-serial", "PLAN_READY", {}),
    { code: "INVALID_TRANSITION" },
  );
  assert.equal(
    await readFile(join(root, "job-serial", "events.jsonl"), "utf8"),
    beforeInvalid,
  );

  const events = parseEventLines(beforeInvalid);
  assert.deepEqual(
    events.map(({ sequence, event, state }) => ({ sequence, event, state })),
    [
      { sequence: 1, event: "JOB_CREATED", state: "created" },
      {
        sequence: 2,
        event: "START_AUTHENTICATION",
        state: "authenticating",
      },
      {
        sequence: 3,
        event: "AUTH_REQUIRED",
        state: "awaiting_manual_login",
      },
    ],
  );
  assert.deepEqual(events[1].data, { authMode: "manual" });
  assert.deepEqual(events[2].data, { reason: "login" });
  assert.deepEqual(JSON.parse(
    await readFile(join(root, "job-serial", "job.json"), "utf8"),
  ), {
    id: "job-serial",
    state: "awaiting_manual_login",
    createdAt: CREATED_AT,
    updatedAt: "2026-07-14T01:02:05.000Z",
    eventSequence: 3,
  });
});

test("atomic JSON replacement never exposes a partial document and uses unique temporaries", async (t) => {
  const root = await temporaryRoot(t);
  const target = join(root, "atomic.json");
  await writeJsonAtomically(target, { marker: "seed" });
  const heldReader = await open(target, "r");
  const replacement = writeJsonAtomically(target, {
    marker: "replacement",
    payload: "x".repeat(256 * 1024),
  }).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), {
    marker: "seed",
  });
  await heldReader.close();
  const replacementResult = await replacement;
  assert.equal(replacementResult.ok, true, replacementResult.error?.message);
  assert.equal(JSON.parse(await readFile(target, "utf8")).marker, "replacement");

  const documents = Array.from({ length: 12 }, (_, index) => ({
    marker: `write-${index}`,
    payload: String(index).repeat(256 * 1024),
  }));
  const writes = documents.map((document) =>
    writeJsonAtomically(target, document),
  );
  await Promise.all(writes);
  const final = JSON.parse(await readFile(target, "utf8"));
  assert.match(final.marker, /^write-\d+$/u);
  assert.equal(
    final.payload,
    final.marker.slice("write-".length).repeat(256 * 1024),
  );
  assert.deepEqual(
    (await readdir(root)).filter((name) => name !== "atomic.json"),
    [],
  );
});

test("load rejects malformed, reserved, forged, and escaping job identifiers", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({ root, randomId: () => "job-safe" });
  await store.create(request());
  const invalidIds = [
    "",
    ".",
    "..",
    "../escape",
    "..\\escape",
    "/absolute",
    "C:\\absolute",
    "\\\\server\\share",
    "job/child",
    "job\\child",
    "CON",
    "con",
    "NUL.txt",
    "PRN",
    "AUX",
    "COM1",
    "LPT9",
    "constructor",
    "prototype",
    "__proto__",
    "a".repeat(129),
    new String("job-safe"),
    Object.create({ toString: () => "job-safe" }),
  ];

  for (const id of invalidIds) {
    await assert.rejects(store.load(id), { code: "INVALID_JOB_ID" });
  }
});

test("load rejects a job directory symlink escape and list does not follow it", async (t) => {
  const root = await temporaryRoot(t);
  const jobsRoot = join(root, "jobs");
  const outside = join(root, "outside", "job-external");
  await mkdir(outside, { recursive: true });
  const store = new JobStore({
    root: jobsRoot,
    now: () => CREATED_AT,
    randomId: () => "job-inside",
  });
  await store.create(request());
  await symlink(outside, join(jobsRoot, "job-link"), "junction");

  await assert.rejects(store.load("job-link"), {
    code: "UNSAFE_JOB_PATH",
  });
  assert.deepEqual(
    (await store.list()).map((job) => job.id),
    ["job-inside"],
  );
});

test("restart replays a durable event newer than job.json and repairs the snapshot", async (t) => {
  const root = await temporaryRoot(t);
  const first = new JobStore({
    root,
    now: sequential([CREATED_AT, "2026-07-14T01:02:04.000Z"]),
    randomId: () => "job-recovery",
  });
  await first.create(request());
  await first.transition("job-recovery", "START_AUTHENTICATION", {
    authMode: "manual",
  });
  const crashWindowEvent = {
    jobId: "job-recovery",
    sequence: 3,
    timestamp: "2026-07-14T01:02:05.000Z",
    event: "AUTH_REQUIRED",
    state: "awaiting_manual_login",
    data: { reason: "manual_login" },
  };
  await appendFile(
    join(root, "job-recovery", "events.jsonl"),
    `${JSON.stringify(crashWindowEvent)}\n`,
    "utf8",
  );

  const restarted = new JobStore({
    root,
    now: () => "2026-07-14T01:02:06.000Z",
    randomId: () => "unused",
  });
  const recovered = await restarted.load("job-recovery");
  assert.equal(recovered.state, "awaiting_manual_login");
  assert.equal(recovered.eventSequence, 3);
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "job-recovery", "job.json"), "utf8")),
    {
      id: "job-recovery",
      state: "awaiting_manual_login",
      createdAt: CREATED_AT,
      updatedAt: "2026-07-14T01:02:05.000Z",
      eventSequence: 3,
    },
  );

  const resumed = await restarted.transition(
    "job-recovery",
    "CONFIRM_LOGIN",
    {},
  );
  assert.equal(resumed.state, "planning");
  assert.equal(resumed.eventSequence, 4);
  assert.deepEqual(
    (await restarted.readEvents("job-recovery", 0)).map(
      ({ sequence }) => sequence,
    ),
    [1, 2, 3, 4],
  );
});

test("load truncates only an unterminated trailing event by its byte offset", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({
    root,
    now: sequential([CREATED_AT, "2026-07-14T01:02:04.000Z"]),
    randomId: () => "job-partial-tail",
  });
  await store.create(request());
  const eventsPath = join(root, "job-partial-tail", "events.jsonl");
  const committedPrefix = await readFile(eventsPath);
  const multibytePartial = Buffer.from('{"sequence":2,"note":"한');
  await appendFile(
    eventsPath,
    multibytePartial.subarray(0, multibytePartial.length - 1),
  );

  const recovered = await store.load("job-partial-tail");
  assert.equal(recovered.state, "created");
  assert.equal(recovered.eventSequence, 1);
  assert.deepEqual(await readFile(eventsPath), committedPrefix);

  const transitioned = await store.transition(
    "job-partial-tail",
    "START_AUTHENTICATION",
    {},
  );
  assert.equal(transitioned.eventSequence, 2);
  assert.deepEqual(
    (await store.readEvents("job-partial-tail", 0)).map(({ sequence }) => sequence),
    [1, 2],
  );
});

test("load rejects a complete newline-terminated malformed event", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({
    root,
    now: () => CREATED_AT,
    randomId: () => "job-complete-forgery",
  });
  await store.create(request());
  await appendFile(
    join(root, "job-complete-forgery", "events.jsonl"),
    `${JSON.stringify({ forged: true })}\n`,
    "utf8",
  );

  await assert.rejects(store.load("job-complete-forgery"), {
    code: "CORRUPT_JOB_DATA",
  });
});

test("a durable transition remains committed when snapshot replacement fails", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({
    root,
    now: sequential([CREATED_AT, "2026-07-14T01:02:04.000Z"]),
    randomId: () => "job-committed-append",
  });
  await store.create(request());
  const snapshotPath = join(root, "job-committed-append", "job.json");
  const heldReader = await open(snapshotPath, "r");
  let committed;
  try {
    committed = await store.transition(
      "job-committed-append",
      "START_AUTHENTICATION",
      {},
    );
  } finally {
    await heldReader.close();
  }
  assert.equal(committed.state, "authenticating");
  assert.equal(committed.eventSequence, 2);

  const restarted = new JobStore({ root });
  const recovered = await restarted.load("job-committed-append");
  assert.equal(recovered.state, "authenticating");
  assert.equal(recovered.eventSequence, 2);
  assert.deepEqual(
    (await restarted.readEvents("job-committed-append", 0)).map(
      ({ sequence }) => sequence,
    ),
    [1, 2],
  );
});

test("close keeps root ownership until an in-flight transition settles", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({
    root,
    now: sequential([CREATED_AT, "2026-07-14T01:02:04.000Z"]),
    randomId: () => "job-close-in-flight",
  });
  await store.create(request());
  const snapshotPath = join(root, "job-close-in-flight", "job.json");
  const heldReader = await open(snapshotPath, "r");
  const appendCommitted = deferred();
  store.onEvent((event) => {
    if (event.event === "START_AUTHENTICATION") {
      appendCommitted.resolve();
    }
  });
  const transitionPromise = store.transition(
    "job-close-in-flight",
    "START_AUTHENTICATION",
    {},
  );
  await appendCommitted.promise;
  let closeSettled = false;
  const closePromise = store.close().then(() => {
    closeSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(closeSettled, false);
  assert.equal(existsSync(join(root, ".studio-owner.lock")), true);
  await heldReader.close();
  await transitionPromise;
  await closePromise;
  assert.equal(existsSync(join(root, ".studio-owner.lock")), false);
});

test("two stores sharing one root serialize transitions by canonical job path", async (t) => {
  const root = await temporaryRoot(t);
  const first = new JobStore({
    root,
    now: sequential([CREATED_AT, "2026-07-14T01:02:04.000Z"]),
    randomId: () => "job-shared-chain",
  });
  const second = new JobStore({
    root,
    now: () => "2026-07-14T01:02:05.000Z",
  });
  await first.create(request());

  const [authenticated, awaitingLogin] = await Promise.all([
    first.transition("job-shared-chain", "START_AUTHENTICATION", {}),
    second.transition("job-shared-chain", "AUTH_REQUIRED", {}),
  ]);

  assert.equal(authenticated.state, "authenticating");
  assert.equal(authenticated.eventSequence, 2);
  assert.equal(awaitingLogin.state, "awaiting_manual_login");
  assert.equal(awaitingLogin.eventSequence, 3);
  assert.deepEqual(
    (await first.readEvents("job-shared-chain", 0)).map(
      ({ sequence, event }) => [sequence, event],
    ),
    [
      [1, "JOB_CREATED"],
      [2, "START_AUTHENTICATION"],
      [3, "AUTH_REQUIRED"],
    ],
  );
  await second.close();
  await first.close();
});

test("a live foreign process owns the jobs root exclusively", async (t) => {
  const root = await temporaryRoot(t);
  const moduleUrl = new URL("../../src/jobs/job-store.js", import.meta.url).href;
  const script = `
    import { JobStore } from ${JSON.stringify(moduleUrl)};
    const store = new JobStore({ root: ${JSON.stringify(root)} });
    await store.list();
    process.stdout.write("READY\\n");
    process.on("SIGTERM", async () => {
      await store.close?.();
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => terminateChild(child));
  await waitForOutput(child, "READY\n");

  const foreign = new JobStore({ root });
  await assert.rejects(foreign.list(), {
    code: "JOBS_ROOT_LOCKED",
    retryable: true,
  });
  await terminateChild(child);
});

test("a demonstrably stale root owner is replaced and released explicitly", async (t) => {
  const root = await temporaryRoot(t);
  const lockPath = join(root, ".studio-owner.lock");
  await writeFile(
    lockPath,
    JSON.stringify({
      pid: 2_147_483_647,
      token: "stale-owner-token",
      createdAt: CREATED_AT,
    }),
    "utf8",
  );
  const store = new JobStore({ root });

  await store.list();
  const owner = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.notEqual(owner.token, "stale-owner-token");
  await store.close();
  await assert.rejects(readFile(lockPath), { code: "ENOENT" });
});

test("stale recovery never deletes an owner that replaced the inspected lease", async (t) => {
  const root = await temporaryRoot(t);
  const lockPath = join(root, ".studio-owner.lock");
  const stalePid = 2_147_483_647;
  await writeFile(
    lockPath,
    JSON.stringify({
      pid: stalePid,
      token: "stale-race-token",
      createdAt: CREATED_AT,
    }),
    "utf8",
  );
  const foreignOwner = {
    pid: process.pid,
    token: "foreign-race-token",
    createdAt: CREATED_AT,
  };
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === stalePid) {
      writeFileSync(lockPath, JSON.stringify(foreignOwner), "utf8");
      const missing = new Error("stale pid");
      missing.code = "ESRCH";
      throw missing;
    }
    return originalKill.call(process, pid, signal);
  };
  try {
    const store = new JobStore({ root });
    await assert.rejects(store.list(), { code: "JOBS_ROOT_LOCKED" });
  } finally {
    process.kill = originalKill;
  }
  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), foreignOwner);
});

test("root ownership never follows a lock symlink", async (t) => {
  const root = await temporaryRoot(t);
  const jobsRoot = join(root, "jobs");
  const outside = join(root, "outside-owner");
  await mkdir(jobsRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "marker.txt"), "unchanged", "utf8");
  await symlink(outside, join(jobsRoot, ".studio-owner.lock"), "junction");
  const store = new JobStore({ root: jobsRoot });

  await assert.rejects(store.list(), { code: "UNSAFE_JOB_PATH" });
  assert.equal(await readFile(join(outside, "marker.txt"), "utf8"), "unchanged");
});

test("operations and close fail closed without deleting a replaced active lease", async (t) => {
  const root = await temporaryRoot(t);
  const first = new JobStore({ root });
  const second = new JobStore({ root });
  await first.list();
  await second.list();
  const lockPath = join(root, ".studio-owner.lock");
  const foreignOwner = {
    pid: process.pid,
    token: "foreign-live-token",
    createdAt: CREATED_AT,
  };
  await writeFile(lockPath, JSON.stringify(foreignOwner), "utf8");

  let operationError;
  try {
    await second.list();
  } catch (error) {
    operationError = error;
  }
  let closeError;
  try {
    await first.close();
  } catch (error) {
    closeError = error;
  }
  assert.equal(operationError?.code, "ROOT_LOCK_OWNERSHIP_LOST");
  assert.equal(closeError?.code, "ROOT_LOCK_OWNERSHIP_LOST");
  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), foreignOwner);
});

test("close cannot delete a new owner installed during lease release", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({ root });
  await store.list();
  const lockPath = join(root, ".studio-owner.lock");
  const foreignOwner = {
    pid: process.pid,
    token: "replacement-release-token",
    createdAt: CREATED_AT,
  };
  const replacementInstalled = deferred();
  const watcher = watch(root, (_eventType, filename) => {
    if (!String(filename).startsWith(".studio-owner.release.")) {
      return;
    }
    try {
      writeFileSync(lockPath, JSON.stringify(foreignOwner), {
        encoding: "utf8",
        flag: "wx",
      });
      replacementInstalled.resolve();
    } catch (error) {
      if (error?.code !== "EEXIST") {
        replacementInstalled.reject(error);
      }
    }
  });
  t.after(() => watcher.close());
  const timeout = setTimeout(
    () => replacementInstalled.reject(new Error("release handoff was not observable")),
    2_000,
  );

  const closePromise = store.close();
  try {
    await replacementInstalled.promise;
  } finally {
    clearTimeout(timeout);
  }
  await closePromise;
  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), foreignOwner);
});

test("create publishes JOB_CREATED only after an atomic complete directory commit", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({
    root,
    now: () => CREATED_AT,
    randomId: () => "job-publish-complete",
  });
  let publication;
  const unsubscribe = store.onEvent((event) => {
    if (event.event !== "JOB_CREATED") {
      return;
    }
    const jobRoot = join(root, event.jobId);
    publication = {
      request: existsSync(join(jobRoot, "request.json")),
      snapshot: existsSync(join(jobRoot, "job.json")),
      events: existsSync(join(jobRoot, "events.jsonl")),
      staging: readdirSync(root).some((name) => name.startsWith(".create-")),
    };
  });

  await store.create(request());
  unsubscribe();
  assert.deepEqual(publication, {
    request: true,
    snapshot: true,
    events: true,
    staging: false,
  });
});

test("list quarantines an incomplete visible job and ignores orphan create staging", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({
    root,
    now: () => CREATED_AT,
    randomId: () => "job-intact",
  });
  await store.create(request());
  await mkdir(join(root, "job-incomplete"));
  await writeFile(
    join(root, "job-incomplete", "request.json"),
    JSON.stringify(request()),
    "utf8",
  );
  const orphanStaging = join(root, ".create-job-orphan-deadbeef");
  await mkdir(orphanStaging);
  await writeFile(join(orphanStaging, "request.json"), "partial", "utf8");

  assert.deepEqual(
    (await store.list()).map(({ id }) => id),
    ["job-intact"],
  );
  const names = await readdir(root);
  assert.equal(names.includes("job-incomplete"), false);
  assert.equal(
    names.some((name) => name.startsWith(".corrupt-job-incomplete-")),
    true,
  );
  assert.equal(names.includes(".create-job-orphan-deadbeef"), true);
});

test("secret-derived key variants are rejected before persistent files exist", async (t) => {
  const parent = await temporaryRoot(t);
  const sensitiveKeys = [
    "apiKey",
    "privateKey",
    "accessKey",
    "secretKey",
    "passwordHash",
    "passwordDerivedKey",
    "tokenValue",
    "passwordValue",
    "authorizationHeader",
    "cookieHeader",
    "passwordHybrid",
    "secretFluid",
    "tokenValid",
  ];

  for (const [index, key] of sensitiveKeys.entries()) {
    await t.test(key, async () => {
      const root = join(parent, `case-${index}`);
      const store = new JobStore({
        root,
        randomId: () => `job-sensitive-${index}`,
      });
      await assert.rejects(
        store.create(request({ nested: { [key]: "plaintext-value" } })),
        { code: "SENSITIVE_PUBLIC_DATA" },
      );
      await assert.rejects(readdir(root), { code: "ENOENT" });
    });
  }
});

test("opaque credential references and password selectors remain public-safe", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({
    root,
    now: () => CREATED_AT,
    randomId: () => "job-safe-references",
  });
  const safeRequest = request({
    credentialId: "vault-entry-7",
    nested: {
      credentialRef: "login-profile",
      vaultId: "local-vault",
      passwordSelector: "#password",
    },
  });

  const created = await store.create(safeRequest);
  assert.deepEqual(created.request, safeRequest);
});

test("list sorts newest first with an ID tie-break and ignores symlinks", async (t) => {
  const root = await temporaryRoot(t);
  const ids = ["job-old", "job-z", "job-a"];
  const store = new JobStore({
    root: join(root, "jobs"),
    now: sequential([
      "2026-07-14T01:00:00.000Z",
      "2026-07-14T02:00:00.000Z",
      "2026-07-14T02:00:00.000Z",
    ]),
    randomId: () => ids.shift(),
  });
  await store.create(request({ prompt: "old" }));
  await store.create(request({ prompt: "z" }));
  await store.create(request({ prompt: "a" }));
  const outside = join(root, "outside");
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(root, "jobs", "job-link"), "junction");

  assert.deepEqual(
    (await store.list()).map(({ id }) => id),
    ["job-a", "job-z", "job-old"],
  );
});

test("public request, state, and events contain only immutable JSON-safe own data", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({
    root,
    now: () => CREATED_AT,
    randomId: sequential([
      "job-safe-data",
      "job-prototype",
      "job-accessor",
      "job-date",
      "job-buffer",
      "job-secret",
    ]),
  });
  const nullPrototypeRequest = Object.assign(Object.create(null), request());
  const created = await store.create(nullPrototypeRequest);
  const events = await store.readEvents(created.id, 0);

  assert.equal(Object.getPrototypeOf(created), Object.prototype);
  assert.equal(Object.getPrototypeOf(created.request), Object.prototype);
  assert.equal(Object.getPrototypeOf(events[0]), Object.prototype);
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.request), true);
  assert.equal(Object.isFrozen(events), true);
  assert.equal(Object.isFrozen(events[0]), true);
  assert.doesNotThrow(() => JSON.stringify({ created, events }));

  const inherited = Object.create({ inherited: "not-own" });
  inherited.targetUrl = "https://fixture.example.test";
  await assert.rejects(store.create(inherited), {
    code: "INVALID_PUBLIC_DATA",
  });

  let getterRan = false;
  const accessor = request();
  Object.defineProperty(accessor, "prompt", {
    enumerable: true,
    get() {
      getterRan = true;
      return "secret";
    },
  });
  await assert.rejects(store.create(accessor), {
    code: "INVALID_PUBLIC_DATA",
  });
  assert.equal(getterRan, false);
  await assert.rejects(store.create(request({ when: new Date() })), {
    code: "INVALID_PUBLIC_DATA",
  });
  await assert.rejects(store.create(request({ bytes: Buffer.from("private") })), {
    code: "INVALID_PUBLIC_DATA",
  });
  await assert.rejects(store.create(request({ password: "must-not-persist" })), {
    code: "SENSITIVE_PUBLIC_DATA",
  });
  await assert.rejects(
    store.transition(created.id, "START_AUTHENTICATION", {
      authorization: "must-not-persist",
    }),
    { code: "SENSITIVE_PUBLIC_DATA" },
  );
  assert.equal((await store.readEvents(created.id, 0)).length, 1);
});

test("EventBus replays persisted events before buffered live events without gaps", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({
    root,
    now: sequential([
      CREATED_AT,
      "2026-07-14T01:02:04.000Z",
      "2026-07-14T01:02:05.000Z",
      "2026-07-14T01:02:06.000Z",
    ]),
    randomId: () => "job-event-race",
  });
  await store.create(request());
  const replayStarted = deferred();
  const releaseReplay = deferred();
  const delayedStore = {
    onEvent: store.onEvent.bind(store),
    async readEvents(jobId, afterSequence) {
      const persisted = await store.readEvents(jobId, afterSequence);
      replayStarted.resolve();
      await releaseReplay.promise;
      return persisted;
    },
  };
  const bus = new EventBus({ store: delayedStore });
  const received = [];
  const subscription = bus.subscribe("job-event-race", 0, (event) => {
    received.push(event.sequence);
  });

  await replayStarted.promise;
  await store.transition("job-event-race", "START_AUTHENTICATION", {
    authMode: "manual",
  });
  releaseReplay.resolve();
  await subscription.ready;
  assert.deepEqual(received, [1, 2]);

  await store.transition("job-event-race", "AUTH_REQUIRED", {});
  assert.deepEqual(received, [1, 2, 3]);
  subscription.close();
  subscription.close();
  await store.transition("job-event-race", "CONFIRM_LOGIN", {});
  assert.deepEqual(received, [1, 2, 3]);
});

test("EventBus filters replay/live overlap and honors afterSequence exactly", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({
    root,
    now: sequential([
      CREATED_AT,
      "2026-07-14T01:02:04.000Z",
      "2026-07-14T01:02:05.000Z",
      "2026-07-14T01:02:06.000Z",
    ]),
    randomId: () => "job-event-filter",
  });
  await store.create(request());
  await store.transition("job-event-filter", "START_AUTHENTICATION", {});
  await store.transition("job-event-filter", "AUTH_REQUIRED", {});
  const bus = new EventBus({ store });
  const received = [];
  const subscription = bus.subscribe("job-event-filter", 1, ({ sequence }) => {
    received.push(sequence);
  });

  await subscription.ready;
  assert.deepEqual(received, [2, 3]);
  await store.transition("job-event-filter", "CONFIRM_LOGIN", {});
  assert.deepEqual(received, [2, 3, 4]);
  subscription.close();
});

test("subscriber failure cannot break persistence or another subscriber", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({
    root,
    now: sequential([CREATED_AT, "2026-07-14T01:02:04.000Z"]),
    randomId: () => "job-event-isolation",
  });
  await store.create(request());
  const bus = new EventBus({ store });
  const bad = bus.subscribe("job-event-isolation", 0, () => {
    throw new Error("subscriber failure");
  });
  const received = [];
  const good = bus.subscribe("job-event-isolation", 0, ({ sequence }) => {
    received.push(sequence);
  });

  await Promise.all([bad.ready, good.ready]);
  assert.deepEqual(received, [1]);
  await assert.doesNotReject(
    store.transition("job-event-isolation", "START_AUTHENTICATION", {}),
  );
  assert.deepEqual(received, [1, 2]);
  assert.deepEqual(
    (await store.readEvents("job-event-isolation", 0)).map(
      ({ sequence }) => sequence,
    ),
    [1, 2],
  );
  bad.close();
  good.close();
});

test("EventBus awaits replay callbacks and completes every effect in sequence", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({
    root,
    now: sequential([
      CREATED_AT,
      "2026-07-14T01:02:04.000Z",
      "2026-07-14T01:02:05.000Z",
      "2026-07-14T01:02:06.000Z",
    ]),
    randomId: () => "job-async-order",
  });
  await store.create(request());
  await store.transition("job-async-order", "START_AUTHENTICATION", {});
  const replayStarted = deferred();
  const releaseReplay = deferred();
  const liveStarted = deferred();
  const releaseLive = deferred();
  const effects = [];
  const bus = new EventBus({ store });
  const subscription = bus.subscribe("job-async-order", 0, async ({ sequence }) => {
    if (sequence === 1) {
      replayStarted.resolve();
      await releaseReplay.promise;
    }
    if (sequence === 3) {
      liveStarted.resolve();
      await releaseLive.promise;
    }
    effects.push(sequence);
  });
  let readySettled = false;
  subscription.ready.then(() => {
    readySettled = true;
  });

  await replayStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readySettled, false);
  assert.deepEqual(effects, []);
  releaseReplay.resolve();
  await subscription.ready;
  assert.deepEqual(effects, [1, 2]);

  await store.transition("job-async-order", "AUTH_REQUIRED", {});
  await liveStarted.promise;
  await store.transition("job-async-order", "CONFIRM_LOGIN", {});
  assert.deepEqual(effects, [1, 2]);
  releaseLive.resolve();
  await subscription.idle();
  assert.deepEqual(effects, [1, 2, 3, 4]);
  subscription.close();
  await subscription.closed;
});

test("EventBus observes sibling-store commits that occur during replay", async (t) => {
  const root = await temporaryRoot(t);
  const first = new JobStore({
    root,
    now: () => CREATED_AT,
    randomId: () => "job-sibling-events",
  });
  const second = new JobStore({
    root,
    now: () => "2026-07-14T01:02:04.000Z",
  });
  await first.create(request());
  const replayStarted = deferred();
  const releaseReplay = deferred();
  const effects = [];
  const subscription = new EventBus({ store: first }).subscribe(
    "job-sibling-events",
    0,
    async ({ sequence }) => {
      if (sequence === 1) {
        replayStarted.resolve();
        await releaseReplay.promise;
      }
      effects.push(sequence);
    },
  );

  await replayStarted.promise;
  await second.transition("job-sibling-events", "START_AUTHENTICATION", {});
  releaseReplay.resolve();
  await subscription.ready;
  await subscription.idle();

  assert.deepEqual(effects, [1, 2]);
  subscription.close();
  await subscription.closed;
  await second.close();
  await first.close();
});

test("EventBus unsubscribe skips queued callbacks that have not started", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({
    root,
    now: sequential([
      CREATED_AT,
      "2026-07-14T01:02:04.000Z",
      "2026-07-14T01:02:05.000Z",
    ]),
    randomId: () => "job-unsubscribe-queue",
  });
  await store.create(request());
  const activeStarted = deferred();
  const releaseActive = deferred();
  const effects = [];
  const subscription = new EventBus({ store }).subscribe(
    "job-unsubscribe-queue",
    1,
    async ({ sequence }) => {
      if (sequence === 2) {
        activeStarted.resolve();
        await releaseActive.promise;
      }
      effects.push(sequence);
    },
  );
  await subscription.ready;
  await store.transition("job-unsubscribe-queue", "START_AUTHENTICATION", {});
  await activeStarted.promise;
  await store.transition("job-unsubscribe-queue", "AUTH_REQUIRED", {});

  subscription.close();
  releaseActive.resolve();
  const closed = await subscription.closed;
  assert.deepEqual(effects, [2]);
  assert.deepEqual(closed, {
    reason: "client",
    lastDeliveredSequence: 2,
  });
});

test("EventBus closes on bounded backpressure so persisted events can replay", async (t) => {
  const root = await temporaryRoot(t);
  const store = new JobStore({
    root,
    now: sequential([
      CREATED_AT,
      "2026-07-14T01:02:04.000Z",
      "2026-07-14T01:02:05.000Z",
      "2026-07-14T01:02:06.000Z",
    ]),
    randomId: () => "job-backpressure",
  });
  await store.create(request());
  const activeStarted = deferred();
  const releaseActive = deferred();
  const effects = [];
  const subscription = new EventBus({ store, maxPending: 2 }).subscribe(
    "job-backpressure",
    1,
    async ({ sequence }) => {
      if (sequence === 2) {
        activeStarted.resolve();
        await releaseActive.promise;
      }
      effects.push(sequence);
    },
  );
  await subscription.ready;
  await store.transition("job-backpressure", "START_AUTHENTICATION", {});
  await activeStarted.promise;
  await store.transition("job-backpressure", "AUTH_REQUIRED", {});
  await store.transition("job-backpressure", "CONFIRM_LOGIN", {});
  assert.deepEqual(effects, []);

  releaseActive.resolve();
  assert.deepEqual(await subscription.closed, {
    reason: "backpressure",
    lastDeliveredSequence: 2,
  });
  assert.deepEqual(effects, [2]);
  assert.deepEqual(
    (await store.readEvents("job-backpressure", 2)).map(({ sequence }) => sequence),
    [3, 4],
  );
});
