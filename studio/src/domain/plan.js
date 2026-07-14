import { createHash, timingSafeEqual } from "node:crypto";

import { StudioError } from "./errors.js";
import {
  canonicalForbiddenCapability,
  evaluateStepPolicy,
} from "./policy.js";

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
const STEP_REQUIRED_FIELDS = Object.freeze([
  "id",
  "action",
  "expected",
  "narration",
  "risk",
  "calls",
]);
const STEP_OPTIONAL_FIELDS = Object.freeze(["navigationTarget"]);
const VALID_RISKS = new Set(["safe", "review", "blocked"]);
const CALL_FIELDS = Object.freeze(["id", "tool", "arguments"]);
const PLANNED_TOOLS = new Set([
  "browser_click",
  "browser_fill_form",
  "browser_press_key",
  "browser_type",
  "browser_wait_for",
]);
const SAFE_PRESS_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Escape",
  "Home",
  "PageDown",
  "PageUp",
  "Tab",
]);
const CLICK_BUTTONS = new Set(["left", "middle", "right"]);
const CLICK_MODIFIERS = new Set(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"]);
const FORM_FIELD_TYPES = new Set(["textbox", "checkbox", "radio", "combobox", "slider"]);
const SENSITIVE_TARGET = /(?:password|passcode|credential|secret|비밀번호)/iu;

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

function assertExactFields(value, requiredFields, path, optionalFields = []) {
  assertPlainObject(value, path);
  const allowed = new Set([...requiredFields, ...optionalFields]);

  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      invalidPlan(`${path}.${field}`, "unknown_field");
    }
  }

  for (const field of requiredFields) {
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

function exactCallString(value, path, maximum, { preserve = false } = {}) {
  if (typeof value !== "string") {
    invalidPlan(path, "string_required");
  }
  const normalized = preserve ? value : value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    invalidPlan(path, "invalid_call_string");
  }
  return normalized;
}

function optionalBoolean(value, path) {
  if (value !== undefined && typeof value !== "boolean") {
    invalidPlan(path, "boolean_required");
  }
  return value;
}

function normalizedClickArguments(value, path) {
  assertExactFields(value, ["target"], path, ["element", "doubleClick", "button", "modifiers"]);
  const normalized = {};
  if (value.element !== undefined) {
    normalized.element = exactCallString(value.element, `${path}.element`, 512);
  }
  normalized.target = exactCallString(value.target, `${path}.target`, 2_048);
  if (value.doubleClick !== undefined) {
    normalized.doubleClick = optionalBoolean(value.doubleClick, `${path}.doubleClick`);
  }
  if (value.button !== undefined) {
    if (!CLICK_BUTTONS.has(value.button)) invalidPlan(`${path}.button`, "unsupported_button");
    normalized.button = value.button;
  }
  if (value.modifiers !== undefined) {
    if (!isDenseArray(value.modifiers) || value.modifiers.length > 5) {
      invalidPlan(`${path}.modifiers`, "invalid_modifiers");
    }
    const modifiers = value.modifiers.map((modifier, index) => {
      if (!CLICK_MODIFIERS.has(modifier)) {
        invalidPlan(`${path}.modifiers[${index}]`, "unsupported_modifier");
      }
      return modifier;
    });
    if (new Set(modifiers).size !== modifiers.length) {
      invalidPlan(`${path}.modifiers`, "duplicate_modifier");
    }
    normalized.modifiers = Object.freeze(modifiers);
  }
  return Object.freeze(normalized);
}

function assertNonSensitiveTarget(value, path) {
  if (SENSITIVE_TARGET.test(value)) {
    invalidPlan(path, "authentication_field_not_allowed");
  }
}

function normalizedTypeArguments(value, path) {
  assertExactFields(value, ["target", "text"], path, ["element", "submit", "slowly"]);
  const normalized = {};
  if (value.element !== undefined) {
    normalized.element = exactCallString(value.element, `${path}.element`, 512);
    assertNonSensitiveTarget(normalized.element, `${path}.element`);
  }
  normalized.target = exactCallString(value.target, `${path}.target`, 2_048);
  assertNonSensitiveTarget(normalized.target, `${path}.target`);
  normalized.text = exactCallString(value.text, `${path}.text`, 4_096, { preserve: true });
  if (value.submit !== undefined) {
    if (optionalBoolean(value.submit, `${path}.submit`) !== false) {
      invalidPlan(`${path}.submit`, "implicit_submit_not_allowed");
    }
    normalized.submit = false;
  }
  if (value.slowly !== undefined) {
    normalized.slowly = optionalBoolean(value.slowly, `${path}.slowly`);
  }
  return Object.freeze(normalized);
}

function normalizedFormArguments(value, path) {
  assertExactFields(value, ["fields"], path);
  if (!isDenseArray(value.fields) || value.fields.length < 1 || value.fields.length > 20) {
    invalidPlan(`${path}.fields`, "invalid_form_fields");
  }
  const fields = value.fields.map((field, index) => {
    const fieldPath = `${path}.fields[${index}]`;
    assertExactFields(field, ["name", "type", "target", "value"], fieldPath, ["element"]);
    const normalized = {
      name: exactCallString(field.name, `${fieldPath}.name`, 256),
      type: field.type,
    };
    if (!FORM_FIELD_TYPES.has(normalized.type)) {
      invalidPlan(`${fieldPath}.type`, "unsupported_form_field_type");
    }
    if (field.element !== undefined) {
      normalized.element = exactCallString(field.element, `${fieldPath}.element`, 512);
      assertNonSensitiveTarget(normalized.element, `${fieldPath}.element`);
    }
    normalized.target = exactCallString(field.target, `${fieldPath}.target`, 2_048);
    assertNonSensitiveTarget(normalized.name, `${fieldPath}.name`);
    assertNonSensitiveTarget(normalized.target, `${fieldPath}.target`);
    normalized.value = exactCallString(field.value, `${fieldPath}.value`, 4_096, { preserve: true });
    if (["checkbox", "radio"].includes(normalized.type) && !["true", "false"].includes(normalized.value)) {
      invalidPlan(`${fieldPath}.value`, "boolean_form_value_required");
    }
    return Object.freeze(normalized);
  });
  return Object.freeze({ fields: Object.freeze(fields) });
}

function normalizedPressArguments(value, path) {
  assertExactFields(value, ["key"], path);
  if (!SAFE_PRESS_KEYS.has(value.key)) {
    invalidPlan(`${path}.key`, "unsafe_key_not_allowed");
  }
  return Object.freeze({ key: value.key });
}

function normalizedWaitArguments(value, path) {
  assertExactFields(value, [], path, ["time", "text", "textGone"]);
  if (Reflect.ownKeys(value).length === 0) {
    invalidPlan(path, "wait_condition_required");
  }
  const normalized = {};
  if (value.time !== undefined) {
    if (typeof value.time !== "number" || !Number.isFinite(value.time) || value.time < 0 || value.time > 30) {
      invalidPlan(`${path}.time`, "wait_time_out_of_range");
    }
    normalized.time = value.time;
  }
  if (value.text !== undefined) {
    normalized.text = exactCallString(value.text, `${path}.text`, 512);
  }
  if (value.textGone !== undefined) {
    normalized.textGone = exactCallString(value.textGone, `${path}.textGone`, 512);
  }
  return Object.freeze(normalized);
}

function normalizedCallArguments(tool, value, path) {
  switch (tool) {
    case "browser_click": return normalizedClickArguments(value, path);
    case "browser_fill_form": return normalizedFormArguments(value, path);
    case "browser_press_key": return normalizedPressArguments(value, path);
    case "browser_type": return normalizedTypeArguments(value, path);
    case "browser_wait_for": return normalizedWaitArguments(value, path);
    default: invalidPlan(path, "unsupported_tool");
  }
}

function normalizedCalls(value, stepId, path, callIds) {
  if (!isDenseArray(value) || value.length < 1 || value.length > 10) {
    invalidPlan(path, "call_count_must_be_between_1_and_10");
  }
  const reservedSuffixes = new Set(["chapter", "evidence-snapshot", "evidence-screenshot"]);
  return Object.freeze(value.map((call, index) => {
    const callPath = `${path}[${index}]`;
    assertExactFields(call, CALL_FIELDS, callPath);
    const id = exactCallString(call.id, `${callPath}.id`, 64);
    const suffix = id.startsWith(`${stepId}.`) ? id.slice(stepId.length + 1) : "";
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(id) ||
      suffix.length === 0 ||
      reservedSuffixes.has(suffix) ||
      callIds.has(id)
    ) {
      invalidPlan(`${callPath}.id`, "invalid_or_duplicate_call_id");
    }
    callIds.add(id);
    if (typeof call.tool !== "string" || !PLANNED_TOOLS.has(call.tool)) {
      invalidPlan(`${callPath}.tool`, "unsupported_tool");
    }
    return Object.freeze({
      id,
      tool: call.tool,
      arguments: normalizedCallArguments(call.tool, call.arguments, `${callPath}.arguments`),
    });
  }));
}

function callPolicyText(calls) {
  const values = [];
  const visit = (value) => {
    if (typeof value === "string") {
      values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const key of Object.keys(value)) visit(value[key]);
    }
  };
  for (const call of calls) visit(call.arguments);
  return values.join(" ");
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

function normalizedNavigationTarget(value, path) {
  if (value === null) {
    return null;
  }

  const navigationTarget = normalizedString(value, path, 2_048);
  let parsed;
  try {
    parsed = new URL(navigationTarget);
  } catch {
    invalidPlan(path, "http_url_required");
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    invalidPlan(path, "safe_http_url_required");
  }

  return parsed.href;
}

function normalizedForbiddenActions(value) {
  return Object.freeze(
    normalizedStringArray(value, "plan.forbiddenActions").map(
      (action, index) => {
        const capability = canonicalForbiddenCapability(action);
        if (capability === null) {
          invalidPlan(
            `plan.forbiddenActions[${index}]`,
            "unsupported_forbidden_capability",
          );
        }
        return capability;
      },
    ),
  );
}

function normalizedSteps(value, targetOrigin, forbiddenActions) {
  if (!isDenseArray(value) || value.length < 1 || value.length > 30) {
    invalidPlan("plan.steps", "step_count_must_be_between_1_and_30");
  }

  const ids = new Set();
  const callIds = new Set();
  return Object.freeze(
    value.map((candidate, index) => {
      const path = `plan.steps[${index}]`;
      assertExactFields(
        candidate,
        STEP_REQUIRED_FIELDS,
        path,
        STEP_OPTIONAL_FIELDS,
      );

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
        calls: normalizedCalls(candidate.calls, id, `${path}.calls`, callIds),
      };
      if (Object.hasOwn(candidate, "navigationTarget")) {
        step.navigationTarget = normalizedNavigationTarget(
          candidate.navigationTarget,
          `${path}.navigationTarget`,
        );
      }
      step.risk = evaluateStepPolicy(
        { ...step, action: `${step.action} ${callPolicyText(step.calls)}` },
        targetOrigin,
        forbiddenActions,
      );
      return Object.freeze(step);
    }),
  );
}

function normalizePlan(candidate) {
  assertExactFields(candidate, TOP_LEVEL_FIELDS, "plan");
  if (candidate.schemaVersion !== "1.1") {
    invalidPlan("plan.schemaVersion", "unsupported_schema_version");
  }

  const targetUrl = parseTargetUrl(candidate.targetUrl);
  const targetOrigin = parseTargetOrigin(candidate.targetOrigin, targetUrl);
  const forbiddenActions = normalizedForbiddenActions(candidate.forbiddenActions);
  const normalized = {
    schemaVersion: "1.1",
    targetUrl: targetUrl.href,
    targetOrigin,
    successCriteria: Object.freeze(
      normalizedStringArray(candidate.successCriteria, "plan.successCriteria", {
        minimum: 1,
        maximum: 20,
      }),
    ),
    forbiddenActions,
    captureSettings: captureSettings(candidate.captureSettings),
    steps: normalizedSteps(candidate.steps, targetOrigin, forbiddenActions),
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

  if (canonical.steps.some((step) => step.risk === "blocked")) {
    throw new StudioError("The plan contains a blocked step.", {
      code: "BLOCKED_PLAN",
      stage: "approved",
      retryable: false,
      details: { reason: "blocked_step_present" },
    });
  }

  return canonical;
}
