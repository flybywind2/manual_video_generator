import assert from "node:assert/strict";
import test from "node:test";

import { ExecutionLock } from "../../src/jobs/execution-lock.js";

test("one job is active, one is queued, and a third fails closed", () => {
  const lock = new ExecutionLock();

  assert.equal(lock.acquire("job-a"), "active");
  assert.equal(lock.acquire("job-b"), "queued");
  assert.throws(() => lock.acquire("job-c"), {
    code: "QUEUE_FULL",
    stage: "queue",
    retryable: true,
  });
  assert.deepEqual(lock.snapshot(), {
    activeJobId: "job-a",
    queuedJobId: "job-b",
  });
});

test("release and active cancellation promote the queued job FIFO", () => {
  const released = new ExecutionLock();
  released.acquire("job-a");
  released.acquire("job-b");

  assert.deepEqual(released.release("job-a"), {
    activeJobId: "job-b",
    queuedJobId: null,
  });
  assert.equal(released.acquire("job-c"), "queued");

  assert.deepEqual(released.cancel("job-b"), {
    activeJobId: "job-c",
    queuedJobId: null,
  });
});

test("cancelling a queued job leaves the active job undisturbed", () => {
  const lock = new ExecutionLock();
  lock.acquire("job-a");
  lock.acquire("job-b");

  assert.deepEqual(lock.cancel("job-b"), {
    activeJobId: "job-a",
    queuedJobId: null,
  });
  assert.equal(lock.acquire("job-c"), "queued");
  assert.deepEqual(lock.snapshot(), {
    activeJobId: "job-a",
    queuedJobId: "job-c",
  });
});

test("duplicate acquire, release, and cancellation are explicitly idempotent", () => {
  const lock = new ExecutionLock();
  assert.equal(lock.acquire("job-a"), "active");
  assert.equal(lock.acquire("job-a"), "active");
  assert.equal(lock.acquire("job-b"), "queued");
  assert.equal(lock.acquire("job-b"), "queued");

  assert.deepEqual(lock.release("job-b"), {
    activeJobId: "job-a",
    queuedJobId: "job-b",
  });
  assert.deepEqual(lock.cancel("job-absent"), {
    activeJobId: "job-a",
    queuedJobId: "job-b",
  });
  assert.deepEqual(lock.release("job-a"), {
    activeJobId: "job-b",
    queuedJobId: null,
  });
  assert.deepEqual(lock.release("job-a"), {
    activeJobId: "job-b",
    queuedJobId: null,
  });
  assert.deepEqual(lock.cancel("job-a"), {
    activeJobId: "job-b",
    queuedJobId: null,
  });
});

test("forged and prototype-sensitive IDs fail closed without changing state", () => {
  const lock = new ExecutionLock();
  lock.acquire("job-safe");
  const forgedIds = [
    "",
    "../escape",
    "job/child",
    "job\\child",
    "__proto__",
    "constructor",
    "prototype",
    new String("job-forged"),
    Object.create({ toString: () => "job-forged" }),
  ];

  for (const id of forgedIds) {
    assert.throws(() => lock.acquire(id), { code: "INVALID_JOB_ID" });
    assert.throws(() => lock.release(id), { code: "INVALID_JOB_ID" });
    assert.throws(() => lock.cancel(id), { code: "INVALID_JOB_ID" });
  }
  assert.deepEqual(lock.snapshot(), {
    activeJobId: "job-safe",
    queuedJobId: null,
  });
});

test("snapshots are immutable JSON-safe own data", () => {
  const lock = new ExecutionLock();
  lock.acquire("job-a");
  const snapshot = lock.snapshot();

  assert.equal(Object.getPrototypeOf(snapshot), Object.prototype);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.deepEqual(Reflect.ownKeys(snapshot), ["activeJobId", "queuedJobId"]);
  assert.equal(JSON.stringify(snapshot), '{"activeJobId":"job-a","queuedJobId":null}');
  assert.throws(() => {
    snapshot.activeJobId = "job-forged";
  }, TypeError);
  assert.equal(lock.snapshot().activeJobId, "job-a");
});
