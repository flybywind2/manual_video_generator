import { timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";

import { runOpenCode as defaultRunOpenCode } from "../adapters/opencode-client.js";
import { StudioError } from "../domain/errors.js";
import { unwrapExactJsonFence } from "../domain/json-output.js";
import {
  assertApprovedPlan,
  digestPlan,
  MAX_STEP_NARRATION_CODE_UNITS,
  parseStableAccessibilityLocator,
  validatePlan,
} from "../domain/plan.js";

const PLAN_EVENTS = new Set(["PLAN_READY", "UPDATE_PLAN", "APPROVE_PLAN"]);
const MAX_PLANNER_TEXT_BYTES = 2 * 1024 * 1024;
const DEFAULT_COMPLETION_CONDITION = "요청한 최종 화면이 보이면 완료";
const MAX_APPROVED_ORIGINS = 16;
const MAX_PLANNING_ATTEMPTS = 2;
const REQUIRED_FORBIDDEN_ACTIONS = Object.freeze([
  "user-data.change",
  "record.delete",
  "message.send",
  "form.submit",
  "content.publish",
  "purchase.create",
]);

function planningError(code, message, retryable = false, details = {}) {
  return new StudioError(message, {
    code,
    stage: "planning",
    retryable,
    details,
  });
}

function planningOptions(options) {
  if (options === undefined) return Object.freeze({ signal: undefined });
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
    Reflect.ownKeys(options).some((key) => key !== "signal") ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  ) {
    throw planningError(
      "PLANNING_OPTIONS_INVALID",
      "The planning options are invalid.",
    );
  }
  return Object.freeze({ signal: options.signal });
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
    typeof jobStore?.compareAndTransition !== "function" ||
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

function approvedOriginArray(value, targetOrigin, approvedOrigins) {
  const candidate = value === undefined ? [] : value;
  if (!Array.isArray(candidate) || candidate.length > MAX_APPROVED_ORIGINS) {
    throw new Error("origins");
  }
  const origins = candidate.map((item) => {
    if (typeof item !== "string" || item.length === 0 || item.length > 2_048) {
      throw new Error("origin");
    }
    const parsed = new URL(item.trim());
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error("origin");
    }
    const origin = parsed.origin;
    if (origin === targetOrigin || approvedOrigins.has(origin)) {
      throw new Error("origin");
    }
    approvedOrigins.add(origin);
    return origin;
  });
  return Object.freeze(origins.sort());
}

function sameOrigins(left, right) {
  return left.length === right.length && left.every((origin, index) => origin === right[index]);
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
    const completionCondition =
      typeof request.completionCondition === "string" &&
      request.completionCondition.trim() !== ""
        ? request.completionCondition.trim()
        : DEFAULT_COMPLETION_CONDITION;
    if (
      completionCondition.length > 2_000 ||
      /[\u0000\u000b\u000c\u000e-\u001f\u007f]/u.test(completionCondition)
    ) {
      throw new Error("completion condition");
    }
    const approvedOrigins = new Set();
    const authOrigins = approvedOriginArray(
      request.authOrigins,
      target.origin,
      approvedOrigins,
    );
    const resourceOrigins = approvedOriginArray(
      request.resourceOrigins,
      target.origin,
      approvedOrigins,
    );
    return Object.freeze({
      authOrigins,
      completionCondition,
      prompt: request.prompt.trim(),
      resourceOrigins,
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

function plannerRejection(error) {
  if (
    error?.code === "INVALID_PLAN" &&
    typeof error?.details?.path === "string" &&
    /^[A-Za-z0-9_.\[\]-]{1,256}$/u.test(error.details.path) &&
    typeof error?.details?.reason === "string" &&
    /^[a-z0-9_]{1,128}$/u.test(error.details.reason)
  ) {
    return Object.freeze({
      code: "INVALID_PLAN",
      path: error.details.path,
      reason: error.details.reason,
    });
  }
  if (
    typeof error?.code === "string" &&
    /^PLANNING_[A-Z0-9_]{2,63}$/u.test(error.code)
  ) {
    const reason = typeof error?.details?.reason === "string" &&
      /^[a-z][a-z0-9_]{2,63}$/u.test(error.details.reason)
      ? error.details.reason
      : null;
    return Object.freeze(reason === null
      ? { code: error.code }
      : { code: error.code, reason });
  }
  return Object.freeze({ code: "PLANNING_OUTPUT_REJECTED" });
}

function plannerPrompt(authority, rejection = null) {
  const instructions = [
    "Return exactly one JSON object with no Markdown or commentary.",
    "Your first action in this run MUST be the playwright_browser_snapshot tool. Do not return JSON until that snapshot completed successfully.",
    "Use the snapshot to identify accessible roles and names, but never put ephemeral eN or fNeN snapshot refs in the plan.",
    'Every interactive target must use this stable role/name locator grammar with double quotes: getByRole("link", { name: "Exact accessible name", exact: true }).',
    "Use exact: true for a full observed accessible name. For a future same-origin element whose requested label is an unambiguous partial accessible name, omit the exact property; runtime strict uniqueness still fails closed on zero or multiple matches.",
    "Every interactive target in a step after an earlier navigationTarget MUST omit the exact property because that future full accessible name was not observed.",
    "Never click or type during planning. If the requested label is ambiguous, return a blocked step.",
    "The locator role, accessible name, and exact flag are reviewable and digest-bound.",
    "Use schemaVersion 1.1 and these exact top-level fields:",
    "schemaVersion,targetUrl,targetOrigin,authOrigins,resourceOrigins,successCriteria,forbiddenActions,captureSettings,steps.",
    "Copy authOrigins and resourceOrigins exactly; never add, remove, or reclassify an origin.",
    "successCriteria must be a JSON array containing 1 to 20 non-empty strings, never a single string.",
    "The final successCriteria entry MUST equal the supplied completionCondition exactly, without paraphrasing or shortening it.",
    `forbiddenActions must be exactly ${JSON.stringify(REQUIRED_FORBIDDEN_ACTIONS)}.`,
    "captureSettings must be exactly {\"width\":1920,\"height\":1080,\"fps\":30}.",
    "Every step must contain id,action,expected,narration,risk,calls.",
    "For every non-blocked plan, the final step expected field MUST equal completionCondition exactly.",
    "Plan every safe action needed to reach completionCondition; an intermediate menu or loading screen is never completion.",
    "When completionCondition is literal visible page text, end the final step with browser_wait_for using that exact text; otherwise use only safe calls appropriate to the described final state.",
    `Each narration must be concise Korean guidance no longer than ${MAX_STEP_NARRATION_CODE_UNITS} code units.`,
    "risk must be exactly one of safe, review, or blocked; it is never a prose explanation.",
    "Omit navigationTarget unless a same-origin route change is intended; then use the complete expected same-origin URL.",
    "Every call must contain id,tool,arguments and use only the planner-approved exact browser call contract.",
    "browser_click arguments require target and may contain element,doubleClick,button,modifiers; target must be the stable getByRole locator.",
    "browser_type arguments require target,text and may contain element,submit,slowly; if submit is present it must be false.",
    "browser_fill_form arguments are exactly {fields:[{name,type,target,value,element?}]}; every target must be the stable getByRole locator.",
    "browser_press_key arguments are exactly {key}; Enter is forbidden.",
    "browser_wait_for arguments contain at least one of time,text,textGone; time must be between 0 and 30.",
    "Call ids must begin with the parent step id plus a dot, and all step and call ids must be unique.",
    "Business navigation is limited to targetOrigin. authOrigins are login-only and resourceOrigins are subresource-only.",
  ];
  if (rejection !== null) {
    instructions.push(
      "Previous planner object was rejected. Start over from a fresh completed snapshot and do not copy the rejected object.",
      `Safe rejection descriptor: ${JSON.stringify(rejection)}`,
    );
  }
  instructions.push(
    JSON.stringify({
      targetUrl: authority.targetUrl,
      targetOrigin: authority.targetOrigin,
      authOrigins: authority.authOrigins,
      resourceOrigins: authority.resourceOrigins,
      captureSettings: { width: 1920, height: 1080, fps: 30 },
      userRequest: authority.prompt,
      completionCondition: authority.completionCondition,
    }),
  );
  return instructions.join("\n");
}

function assertCompletedPlanningSnapshot(report) {
  if (
    !Array.isArray(report?.toolEvents) ||
    !report.toolEvents.some((event) =>
      event?.tool === "playwright_browser_snapshot" && event?.status === "completed")
  ) {
    throw planningError(
      "PLANNING_SNAPSHOT_REQUIRED",
      "The planner must inspect the authenticated browser before proposing actions.",
      true,
    );
  }
}

function bindPlanToRequest(candidate, authority) {
  const plan = validatePlan(candidate);
  let followsNavigation = false;
  for (const step of plan.steps) {
    for (const call of step.calls) {
      const targets = call.tool === "browser_fill_form"
        ? call.arguments.fields.map(({ target }) => target)
        : [call.arguments.target].filter((target) => target !== undefined);
      const locators = targets.map((target) => parseStableAccessibilityLocator(target));
      if (locators.some((locator) => locator === null)) {
        throw planningError(
          "PLANNING_TARGET_UNSTABLE",
          "Interactive browser targets must use stable accessibility locators.",
          true,
        );
      }
      if (followsNavigation && locators.some(({ exact }) => exact)) {
        throw planningError(
          "PLANNING_FUTURE_TARGET_EXACT",
          "Future-page browser targets must use strict unique partial accessibility locators.",
          true,
        );
      }
    }
    if (Object.hasOwn(step, "navigationTarget")) followsNavigation = true;
  }
  if (
    plan.targetOrigin !== authority.targetOrigin ||
    plan.targetUrl !== authority.targetUrl ||
    !sameOrigins(plan.authOrigins, authority.authOrigins) ||
    !sameOrigins(plan.resourceOrigins, authority.resourceOrigins)
  ) {
    throw planningError(
      "PLANNING_AUTHORITY_MISMATCH",
      "The proposed plan exceeds the requested target authority.",
    );
  }
  const completionError = (reason) => {
    throw planningError(
      "PLANNING_COMPLETION_UNBOUND",
      "The proposed plan is not bound to the requested completion condition.",
      true,
      { reason },
    );
  };
  if (plan.successCriteria.at(-1) !== authority.completionCondition) {
    completionError("success_criterion_missing");
  }
  if (!plan.steps.some(({ risk }) => risk === "blocked")) {
    const finalStep = plan.steps.at(-1);
    if (finalStep?.expected !== authority.completionCondition) {
      completionError("final_expected_mismatch");
    }
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
    candidate = JSON.parse(unwrapExactJsonFence(finalText));
  } catch {
    const trimmed = typeof finalText === "string" ? finalText.trim() : "";
    const reason = /^```(?:json)?\s*\{[\s\S]*\}\s*```$/iu.test(trimmed)
      ? "json_parse_fenced_object"
      : trimmed.startsWith("{") && trimmed.endsWith("}")
        ? "json_parse_object_like"
        : "json_parse_other_text";
    throw planningError(
      "PLANNING_OUTPUT_INVALID",
      "The planner output is invalid.",
      false,
      { reason },
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
  if (
    typeof jobStore?.load !== "function" ||
    typeof jobStore?.readEvents !== "function"
  ) {
    throw planningError(
      "PLANNING_CONFIGURATION_INVALID",
      "The planning workflow is not configured safely.",
    );
  }
  const current = await jobStore.load(jobId);
  const authority = targetAuthority(current.request);
  const events = await jobStore.readEvents(jobId, 0);
  let latest = null;
  for (const event of events) {
    if (!PLAN_EVENTS.has(event.event)) continue;
    const restored = exactPersistedPlanData(event.data);
    const plan = bindPlanToRequest(restored.plan, authority);
    latest = Object.freeze({
      ...restored,
      plan,
      event: event.event,
      eventSequence: event.sequence,
      approved: event.event === "APPROVE_PLAN",
    });
  }
  return latest;
}

async function commitReviewedTransition(
  settings,
  jobId,
  latest,
  eventName,
  data,
) {
  try {
    return await settings.jobStore.compareAndTransition(jobId, {
      expectedState: "plan_review",
      expectedEventSequence: latest.eventSequence,
      expectedPlanDigest: latest.planDigest,
      eventName,
      data,
    });
  } catch (error) {
    if (error?.code === "JOB_COMPARE_FAILED") {
      throw planningError(
        "PLAN_DIGEST_MISMATCH",
        "The reviewed plan is no longer current.",
      );
    }
    throw error;
  }
}

export function createPlanningWorkflow(options) {
  const settings = validateDependencies(options);

  return Object.freeze({
    async createPlan(jobId, options) {
      const { signal } = planningOptions(options);
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
        let prompt = plannerPrompt(authority);
        for (let attempt = 0; attempt < MAX_PLANNING_ATTEMPTS; attempt += 1) {
          const report = await settings.openCodeServer.withAttachOptions(
            "manual-video-planner",
            (attachOptions) => settings.runOpenCode({
              ...attachOptions,
              opencodePath: settings.opencodePath,
              agent: "manual-video-planner",
              prompt,
              signal,
            }),
          );
          try {
            assertCompletedPlanningSnapshot(report);
            plan = parsePlannerText(report?.finalText, authority);
            planDigest = digestPlan(plan);
            break;
          } catch (error) {
            if (attempt + 1 >= MAX_PLANNING_ATTEMPTS) throw error;
            prompt = plannerPrompt(authority, plannerRejection(error));
          }
        }
      } catch (error) {
        const outputFailure = plannerRejection(error);
        try {
          await settings.jobStore.transition(jobId, "PLANNING_FAILED", {
            reason: "planner_output_rejected",
            outputFailure,
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
      const job = await commitReviewedTransition(
        settings,
        jobId,
        latest,
        "UPDATE_PLAN",
        { plan, planDigest },
      );
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
      const job = await commitReviewedTransition(
        settings,
        jobId,
        latest,
        "APPROVE_PLAN",
        { plan, planDigest: latest.planDigest },
      );
      return planResult(job, plan, latest.planDigest);
    },

    restoreLatestPlan(jobId) {
      return restoreLatestPlan(settings.jobStore, jobId);
    },
  });
}
