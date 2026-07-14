import { createHash, timingSafeEqual } from "node:crypto";

import { StudioError } from "./errors.js";
import { evaluateStepPolicy } from "./policy.js";

const TOP_LEVEL_FIELDS = Object.freeze([
  "schemaVersion",
  "targetUrl",
  "targetOrigin",
  "successCriteria",
  "forbiddenActions",
  "captureSettings",
  "steps",
]);
const CAPTURE_FIELDS = Object.freeze(["width", "height", "fps"]);
const STEP_FIELDS = Object.freeze([
  "id",
  "action",
  "expected",
  "narration",
  "risk",
]);
const VALID_RISKS = new Set(["safe", "review", "blocked"]);

function invalidPlan(path, reason) {
  throw new StudioError("The plan does not match the approved plan contract.", {
    code: "INVALID_PLAN",
    stage: "planning",
    retryable: true,
    details: { path, reason },
  });
}

function assertPlainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidPlan(path, "object_required");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidPlan(path, "plain_object_required");
  }
}

function assertExactFields(value, allowedFields, path) {
  assertPlainObject(value, path);
  const allowed = new Set(allowedFields);

  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      invalidPlan(`${path}.${field}`, "unknown_field");
    }
  }

  for (const field of allowedFields) {
    if (!Object.hasOwn(value, field)) {
      invalidPlan(`${path}.${field}`, "required_field");
    }
  }
}

function normalizedString(value, path, maxLength) {
  if (typeof value !== "string") {
    invalidPlan(path, "string_required");
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    invalidPlan(path, "non_empty_string_required");
  }
  if (normalized.length > maxLength) {
    invalidPlan(path, "string_too_long");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    invalidPlan(path, "control_character_not_allowed");
  }

  return normalized;
}

function isDenseArray(value) {
  if (!Array.isArray(value)) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      return false;
    }
  }
  return true;
}

function normalizedStringArray(value, path, { minimum = 0, maximum = 30 } = {}) {
  if (!isDenseArray(value) || value.length < minimum || value.length > maximum) {
    invalidPlan(path, "invalid_array_length");
  }

  return value.map((item, index) =>
    normalizedString(item, `${path}[${index}]`, 1_000),
  );
}

function parseTargetUrl(value) {
  const targetUrl = normalizedString(value, "plan.targetUrl", 2_048);
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    invalidPlan("plan.targetUrl", "http_url_required");
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    invalidPlan("plan.targetUrl", "safe_http_url_required");
  }

  return parsed;
}

function parseTargetOrigin(value, targetUrl) {
  const targetOrigin = normalizedString(value, "plan.targetOrigin", 2_048);
  let parsed;
  try {
    parsed = new URL(targetOrigin);
  } catch {
    invalidPlan("plan.targetOrigin", "http_origin_required");
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    invalidPlan("plan.targetOrigin", "canonical_http_origin_required");
  }

  if (parsed.origin !== targetUrl.origin) {
    invalidPlan("plan.targetOrigin", "target_origin_mismatch");
  }

  return parsed.origin;
}

function captureSettings(value) {
  assertExactFields(value, CAPTURE_FIELDS, "plan.captureSettings");
  const ranges = {
    width: [320, 3_840],
    height: [240, 2_160],
    fps: [1, 60],
  };
  const normalized = {};

  for (const field of CAPTURE_FIELDS) {
    const setting = value[field];
    const [minimum, maximum] = ranges[field];
    if (!Number.isInteger(setting) || setting < minimum || setting > maximum) {
      invalidPlan(`plan.captureSettings.${field}`, "integer_out_of_range");
    }
    normalized[field] = setting;
  }

  return Object.freeze(normalized);
}

function normalizedSteps(value, targetOrigin) {
  if (!isDenseArray(value) || value.length < 1 || value.length > 30) {
    invalidPlan("plan.steps", "step_count_must_be_between_1_and_30");
  }

  const ids = new Set();
  return Object.freeze(
    value.map((candidate, index) => {
      const path = `plan.steps[${index}]`;
      assertExactFields(candidate, STEP_FIELDS, path);

      const id = normalizedString(candidate.id, `${path}.id`, 64);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(id)) {
        invalidPlan(`${path}.id`, "invalid_step_id");
      }
      if (ids.has(id)) {
        invalidPlan(`${path}.id`, "duplicate_step_id");
      }
      ids.add(id);

      if (!VALID_RISKS.has(candidate.risk)) {
        invalidPlan(`${path}.risk`, "unsupported_risk");
      }

      const step = {
        id,
        action: normalizedString(candidate.action, `${path}.action`, 2_000),
        expected: normalizedString(candidate.expected, `${path}.expected`, 2_000),
        narration: normalizedString(candidate.narration, `${path}.narration`, 4_000),
        risk: candidate.risk,
      };
      step.risk = evaluateStepPolicy(step, targetOrigin);
      return Object.freeze(step);
    }),
  );
}

function normalizePlan(candidate) {
  assertExactFields(candidate, TOP_LEVEL_FIELDS, "plan");
  if (candidate.schemaVersion !== "1.0") {
    invalidPlan("plan.schemaVersion", "unsupported_schema_version");
  }

  const targetUrl = parseTargetUrl(candidate.targetUrl);
  const targetOrigin = parseTargetOrigin(candidate.targetOrigin, targetUrl);
  const normalized = {
    schemaVersion: "1.0",
    targetUrl: targetUrl.href,
    targetOrigin,
    successCriteria: Object.freeze(
      normalizedStringArray(candidate.successCriteria, "plan.successCriteria", {
        minimum: 1,
        maximum: 20,
      }),
    ),
    forbiddenActions: Object.freeze(
      normalizedStringArray(candidate.forbiddenActions, "plan.forbiddenActions"),
    ),
    captureSettings: captureSettings(candidate.captureSettings),
    steps: normalizedSteps(candidate.steps, targetOrigin),
  };

  return Object.freeze(normalized);
}

export function validatePlan(candidate) {
  return normalizePlan(candidate);
}

export function canonicalPlan(plan) {
  return normalizePlan(plan);
}

export function digestPlan(plan) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalPlan(plan)), "utf8")
    .digest("hex");
}

export function assertApprovedPlan(plan, expectedDigest) {
  const canonical = canonicalPlan(plan);
  const actualDigest = digestPlan(canonical);
  const validExpectedDigest =
    typeof expectedDigest === "string" && /^[a-f0-9]{64}$/u.test(expectedDigest);
  const matches =
    validExpectedDigest &&
    timingSafeEqual(
      Buffer.from(actualDigest, "hex"),
      Buffer.from(expectedDigest, "hex"),
    );

  if (!matches) {
    throw new StudioError("The plan no longer matches its approved digest.", {
      code: "PLAN_DIGEST_MISMATCH",
      stage: "approved",
      retryable: false,
      details: { reason: "approval_digest_mismatch" },
    });
  }

  return canonical;
}
