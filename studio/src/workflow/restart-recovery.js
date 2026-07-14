import { latestValidPlanDigest } from "../domain/recovery-provenance.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const RENDER_ENTRY_EVENTS = new Set(["APPROVE_PREVIEW", "RETRY_RENDER"]);
const RESTART_RECOVERY = Object.freeze({
  created: Object.freeze({
    event: "CANCEL_JOB",
    reason: "interrupted_before_authentication",
    planBound: false,
    to: "cancelled",
  }),
  awaiting_manual_login: Object.freeze({
    event: "CANCEL_JOB",
    reason: "interrupted_manual_login",
    planBound: false,
    to: "cancelled",
  }),
  plan_review: Object.freeze({
    event: "CANCEL_JOB",
    reason: "interrupted_plan_review",
    planBound: false,
    to: "cancelled",
  }),
  approved: Object.freeze({
    event: "CANCEL_JOB",
    reason: "interrupted_approved_plan",
    planBound: true,
    to: "cancelled",
  }),
  authenticating: Object.freeze({
    event: "AUTHENTICATION_FAILED",
    reason: "interrupted_authentication",
    planBound: false,
    to: "failed",
  }),
  planning: Object.freeze({
    event: "PLANNING_FAILED",
    reason: "interrupted_planning",
    planBound: false,
    to: "failed",
  }),
  executing: Object.freeze({
    event: "EXECUTION_FAILED",
    reason: "interrupted_execution",
    planBound: true,
    to: "failed",
  }),
  narrating: Object.freeze({
    event: "NARRATION_FAILED",
    reason: "interrupted_narration",
    planBound: true,
    to: "failed",
  }),
  composing: Object.freeze({
    event: "COMPOSITION_FAILED",
    reason: "interrupted_composition",
    planBound: true,
    to: "failed",
  }),
  rendering: Object.freeze({
    event: "RENDER_FAILED",
    reason: "interrupted_render",
    planBound: true,
    to: "failed",
  }),
});

function ownValue(value, field) {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  try {
    const property = Object.getOwnPropertyDescriptor(value, field);
    return property !== undefined && "value" in property
      ? property.value
      : undefined;
  } catch {
    return undefined;
  }
}

function renderBinding(events) {
  let anchorIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (RENDER_ENTRY_EVENTS.has(events[index]?.event)) {
      anchorIndex = index;
      break;
    }
  }
  if (
    anchorIndex < 0 ||
    !events
      .slice(anchorIndex + 1)
      .every((event) => event?.event === "OPERATION_REJECTED")
  ) {
    return null;
  }

  const data = events[anchorIndex]?.data;
  const planDigest = ownValue(data, "planDigest");
  const previewDigest = ownValue(data, "previewDigest");
  return typeof planDigest === "string" &&
    SHA256.test(planDigest) &&
    typeof previewDigest === "string" &&
    SHA256.test(previewDigest)
    ? Object.freeze({ planDigest, previewDigest })
    : null;
}

function interruptionData(state, spec, events) {
  if (state === "rendering") {
    const binding = renderBinding(events);
    if (binding !== null) {
      return Object.freeze({ reason: spec.reason, ...binding });
    }
    const planDigest = latestValidPlanDigest(events);
    return Object.freeze({
      reason: `${spec.reason}_unrecoverable`,
      ...(planDigest === undefined ? {} : { planDigest }),
    });
  }
  if (!spec.planBound) {
    return Object.freeze({ reason: spec.reason });
  }
  const planDigest = latestValidPlanDigest(events);
  return Object.freeze({
    reason: planDigest === undefined
      ? `${spec.reason}_unrecoverable`
      : spec.reason,
    ...(planDigest === undefined ? {} : { planDigest }),
  });
}

export async function reconcileInterruptedJobs(jobStore) {
  if (
    jobStore === null ||
    typeof jobStore !== "object" ||
    typeof jobStore.list !== "function" ||
    typeof jobStore.readEvents !== "function" ||
    typeof jobStore.transition !== "function"
  ) {
    throw new TypeError("jobStore must provide list, readEvents, and transition");
  }

  const recovered = [];
  const jobs = await jobStore.list();
  for (const job of jobs) {
    const spec = typeof job?.state === "string" &&
      Object.hasOwn(RESTART_RECOVERY, job.state)
      ? RESTART_RECOVERY[job.state]
      : undefined;
    if (spec === undefined) {
      continue;
    }
    const events = await jobStore.readEvents(job.id, 0);
    const data = interruptionData(job.state, spec, events);
    await jobStore.transition(job.id, spec.event, data);
    recovered.push(Object.freeze({
      jobId: job.id,
      from: job.state,
      to: spec.to,
      reason: data.reason,
    }));
  }
  return Object.freeze(recovered);
}
