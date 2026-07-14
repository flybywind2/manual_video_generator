import { timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";

import { runOpenCode as defaultRunOpenCode } from "../adapters/opencode-client.js";
import { StudioError } from "../domain/errors.js";
import {
  assertApprovedPlan,
  digestPlan,
  validatePlan,
} from "../domain/plan.js";

const PLAN_EVENTS = new Set(["PLAN_READY", "UPDATE_PLAN", "APPROVE_PLAN"]);
const MAX_PLANNER_TEXT_BYTES = 2 * 1024 * 1024;

function planningError(code, message, retryable = false) {
  return new StudioError(message, {
    code,
    stage: "planning",
    retryable,
  });
}

function validateDependencies(options) {
  const {
    jobStore,
    opencodePath,
    openCodeServer,
    runOpenCode = defaultRunOpenCode,
  } = options ?? {};
  if (
    typeof jobStore?.load !== "function" ||
    typeof jobStore?.readEvents !== "function" ||
    typeof jobStore?.transition !== "function" ||
    typeof opencodePath !== "string" ||
    !isAbsolute(opencodePath) ||
    typeof openCodeServer?.withAttachOptions !== "function" ||
    typeof runOpenCode !== "function"
  ) {
    throw planningError(
      "PLANNING_CONFIGURATION_INVALID",
      "The planning workflow is not configured safely.",
    );
  }
  return { jobStore, opencodePath, openCodeServer, runOpenCode };
}

function targetAuthority(request) {
  try {
    if (typeof request?.prompt !== "string" || request.prompt.trim() === "") {
      throw new Error("prompt");
    }
    const target = new URL(request.targetUrl);
    if (
      !["http:", "https:"].includes(target.protocol) ||
      target.username !== "" ||
      target.password !== ""
    ) {
      throw new Error("target");
    }
    return Object.freeze({
      prompt: request.prompt.trim(),
      targetOrigin: target.origin,
      targetUrl: target.href,
    });
  } catch {
    throw planningError(
      "PLANNING_REQUEST_INVALID",
      "The planning request is invalid.",
    );
  }
}

function plannerPrompt(authority) {
  return [
    "Return exactly one JSON object with no Markdown or commentary.",
    "Use schemaVersion 1.1 and these exact top-level fields:",
    "schemaVersion,targetUrl,targetOrigin,successCriteria,forbiddenActions,captureSettings,steps.",
    "Every step must contain id,action,expected,narration,risk,calls.",
    "Every call must contain id,tool,arguments and use only the planner-approved exact browser call contract.",
    "Do not navigate to or authorize any origin other than targetOrigin.",
    JSON.stringify({
      targetUrl: authority.targetUrl,
      targetOrigin: authority.targetOrigin,
      userRequest: authority.prompt,
    }),
  ].join("\n");
}

function bindPlanToRequest(candidate, authority) {
  const plan = validatePlan(candidate);
  if (
    plan.targetOrigin !== authority.targetOrigin ||
    plan.targetUrl !== authority.targetUrl
  ) {
    throw planningError(
      "PLANNING_AUTHORITY_MISMATCH",
      "The proposed plan exceeds the requested target authority.",
    );
  }
  return plan;
}

function assertCurrentDigest(actualDigest, expectedDigest) {
  const validExpected =
    typeof expectedDigest === "string" && /^[a-f0-9]{64}$/u.test(expectedDigest);
  const matches =
    validExpected &&
    timingSafeEqual(
      Buffer.from(actualDigest, "hex"),
      Buffer.from(expectedDigest, "hex"),
    );
  if (!matches) {
    throw planningError(
      "PLAN_DIGEST_MISMATCH",
      "The reviewed plan is no longer current.",
    );
  }
}

function parsePlannerText(finalText, authority) {
  if (
    typeof finalText !== "string" ||
    finalText.length === 0 ||
    Buffer.byteLength(finalText, "utf8") > MAX_PLANNER_TEXT_BYTES
  ) {
    throw planningError(
      "PLANNING_OUTPUT_INVALID",
      "The planner output is invalid.",
    );
  }
  let candidate;
  try {
    candidate = JSON.parse(finalText);
  } catch {
    throw planningError(
      "PLANNING_OUTPUT_INVALID",
      "The planner output is invalid.",
    );
  }
  return bindPlanToRequest(candidate, authority);
}

function planResult(job, plan, planDigest) {
  return Object.freeze({ job, plan, planDigest });
}

function exactPersistedPlanData(data) {
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(data)) ||
    Reflect.ownKeys(data).length !== 2 ||
    !Object.hasOwn(data, "plan") ||
    !Object.hasOwn(data, "planDigest") ||
    typeof data.planDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(data.planDigest)
  ) {
    throw planningError(
      "PLANNING_EVENT_INVALID",
      "The persisted plan event is invalid.",
    );
  }
  const plan = validatePlan(data.plan);
  if (digestPlan(plan) !== data.planDigest) {
    throw planningError(
      "PLANNING_EVENT_INVALID",
      "The persisted plan event is invalid.",
    );
  }
  return { plan, planDigest: data.planDigest };
}

export async function restoreLatestPlan(jobStore, jobId) {
  if (typeof jobStore?.readEvents !== "function") {
    throw planningError(
      "PLANNING_CONFIGURATION_INVALID",
      "The planning workflow is not configured safely.",
    );
  }
  const events = await jobStore.readEvents(jobId, 0);
  let latest = null;
  for (const event of events) {
    if (!PLAN_EVENTS.has(event.event)) continue;
    const restored = exactPersistedPlanData(event.data);
    latest = Object.freeze({
      ...restored,
      event: event.event,
      eventSequence: event.sequence,
      approved: event.event === "APPROVE_PLAN",
    });
  }
  return latest;
}

export function createPlanningWorkflow(options) {
  const settings = validateDependencies(options);

  return Object.freeze({
    async createPlan(jobId) {
      const current = await settings.jobStore.load(jobId);
      if (current.state !== "planning") {
        throw planningError(
          "PLANNING_STATE_INVALID",
          "Planning cannot start from the current job state.",
        );
      }
      const authority = targetAuthority(current.request);
      let plan;
      let planDigest;
      try {
        const report = await settings.openCodeServer.withAttachOptions(
          "manual-video-planner",
          (attachOptions) => settings.runOpenCode({
            ...attachOptions,
            opencodePath: settings.opencodePath,
            agent: "manual-video-planner",
            prompt: plannerPrompt(authority),
          }),
        );
        plan = parsePlannerText(report?.finalText, authority);
        planDigest = digestPlan(plan);
      } catch {
        try {
          await settings.jobStore.transition(jobId, "PLANNING_FAILED", {
            reason: "planner_output_rejected",
          });
        } catch {
          // The original durable state remains authoritative.
        }
        throw planningError(
          "PLANNING_FAILED",
          "A safe browser plan could not be created.",
          true,
        );
      }
      const job = await settings.jobStore.transition(jobId, "PLAN_READY", {
        plan,
        planDigest,
      });
      return planResult(job, plan, planDigest);
    },

    async updatePlan(jobId, candidate, expectedCurrentDigest) {
      const current = await settings.jobStore.load(jobId);
      if (current.state !== "plan_review") {
        throw planningError(
          "PLANNING_STATE_INVALID",
          "The plan cannot be edited from the current job state.",
        );
      }
      const latest = await restoreLatestPlan(settings.jobStore, jobId);
      if (latest === null || latest.approved) {
        throw planningError(
          "PLANNING_PLAN_MISSING",
          "There is no reviewable plan to edit.",
        );
      }
      assertCurrentDigest(latest.planDigest, expectedCurrentDigest);
      const plan = bindPlanToRequest(candidate, targetAuthority(current.request));
      const planDigest = digestPlan(plan);
      const job = await settings.jobStore.transition(jobId, "UPDATE_PLAN", {
        plan,
        planDigest,
      });
      return planResult(job, plan, planDigest);
    },

    async approvePlan(jobId, expectedPlanDigest) {
      const current = await settings.jobStore.load(jobId);
      if (current.state !== "plan_review") {
        throw planningError(
          "PLANNING_STATE_INVALID",
          "The plan cannot be approved from the current job state.",
        );
      }
      const latest = await restoreLatestPlan(settings.jobStore, jobId);
      if (latest === null || latest.approved) {
        throw planningError(
          "PLANNING_PLAN_MISSING",
          "There is no reviewable plan to approve.",
        );
      }
      const plan = assertApprovedPlan(latest.plan, expectedPlanDigest);
      const job = await settings.jobStore.transition(jobId, "APPROVE_PLAN", {
        plan,
        planDigest: latest.planDigest,
      });
      return planResult(job, plan, latest.planDigest);
    },

    restoreLatestPlan(jobId) {
      return restoreLatestPlan(settings.jobStore, jobId);
    },
  });
}
