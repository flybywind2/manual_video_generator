import assert from "node:assert/strict";
import test from "node:test";

import { TaskSupervisor } from "../../src/jobs/task-supervisor.js";

test("tracks background work, passes one shutdown signal, and drains before close resolves", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const signals = [];
  const supervisor = new TaskSupervisor();
  const task = supervisor.schedule(async (signal) => {
    signals.push(signal);
    await gate;
    return 42;
  });

  assert.equal(supervisor.pendingCount, 1);
  await Promise.resolve();
  const closing = supervisor.close();
  assert.equal(signals[0].aborted, true);
  let closed = false;
  closing.then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();

  assert.equal(await task, 42);
  const results = await closing;
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(supervisor.pendingCount, 0);
});

test("normalizes background failures through the error hook without unhandled rejection", async () => {
  const errors = [];
  const failure = Object.assign(new Error("private"), { code: "PLANNING_FAILED" });
  const supervisor = new TaskSupervisor({ onError: (error) => errors.push(error.code) });

  await assert.rejects(supervisor.schedule(async () => { throw failure; }), (error) => error === failure);
  assert.deepEqual(errors, ["PLANNING_FAILED"]);
  assert.equal(supervisor.pendingCount, 0);
  await supervisor.close();
});

test("close is idempotent and rejects work scheduled after shutdown", async () => {
  const supervisor = new TaskSupervisor();
  const first = supervisor.close();
  assert.equal(first, supervisor.close());
  await first;
  assert.throws(() => supervisor.schedule(async () => undefined), {
    code: "TASK_SUPERVISOR_CLOSED",
  });
});
