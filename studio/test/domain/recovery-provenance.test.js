import assert from "node:assert/strict";
import test from "node:test";

import {
  findRecoveryAnchor,
  latestValidPlanDigest,
} from "../../src/domain/recovery-provenance.js";

const PLAN_DIGEST = "a".repeat(64);

function event(sequence, name, state = "needs_review", data = {}) {
  return { sequence, event: name, state, data };
}

test("recovery anchor skips one or multiple rejection self-events", () => {
  const mismatch = event(7, "EXECUTION_MISMATCH", "needs_review", {
    planDigest: PLAN_DIGEST,
  });

  assert.equal(
    findRecoveryAnchor(
      [mismatch, event(8, "OPERATION_REJECTED")],
      {
        anchorEvent: "EXECUTION_MISMATCH",
        currentEventSequence: 8,
        currentState: "needs_review",
      },
    ),
    mismatch,
  );
  assert.equal(
    findRecoveryAnchor(
      [
        mismatch,
        event(8, "OPERATION_REJECTED"),
        event(9, "OPERATION_REJECTED"),
      ],
      {
        anchorEvent: "EXECUTION_MISMATCH",
        currentEventSequence: 9,
        currentState: "needs_review",
      },
    ),
    mismatch,
  );
});

test("recovery anchor rejects an unrelated suffix even when a later rejection follows it", () => {
  const events = [
    event(7, "EXECUTION_MISMATCH"),
    event(8, "UNRELATED_REVIEW_EVENT"),
    event(9, "OPERATION_REJECTED"),
  ];

  assert.equal(
    findRecoveryAnchor(events, {
      anchorEvent: "EXECUTION_MISMATCH",
      currentEventSequence: 9,
      currentState: "needs_review",
    }),
    null,
  );
});

test("latest valid plan digest is recovered without invoking accessor properties", () => {
  const hostile = {};
  Object.defineProperty(hostile, "planDigest", {
    get() {
      throw new Error("getter must not run");
    },
  });
  const events = [
    event(7, "EXECUTION_MISMATCH", "needs_review", { planDigest: PLAN_DIGEST }),
    event(8, "OPERATION_REJECTED", "needs_review", hostile),
  ];

  assert.equal(latestValidPlanDigest(events), PLAN_DIGEST);
});
