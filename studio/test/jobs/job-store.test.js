import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  symlink,
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
