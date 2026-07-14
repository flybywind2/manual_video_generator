const ENGLISH_IRREVERSIBLE =
  /\b(?:delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|send(?:s|ing)?|sent|submit(?:s|ted|ting)?|publish(?:es|ed|ing)?|purchas(?:e|es|ed|ing))\b/iu;
const KOREAN_IRREVERSIBLE =
  /(?:^|[^\p{L}\p{N}_])(?:삭제|전송|등록|구매)(?=$|[^\p{L}\p{N}_]|(?:하|합|해|했|할|한|시키|시킵|시켜|시켰|시킬|시킨))/u;
const URL_TOKEN = /(?:https?:)?\/\/[^\s<>"'`]+/giu;
const HOST_TOKEN =
  /(?:\[[0-9a-f:]+\]|localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?::\d{1,5})?(?:\/[^\s<>"'`]*)?/giu;
const VALID_RISKS = new Set(["safe", "review", "blocked"]);

function approvedOrigin(value) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      (value !== parsed.origin && value !== `${parsed.origin}/`)
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function containsUnapprovedOrigin(action, targetOrigin) {
  const origin = approvedOrigin(targetOrigin);
  if (origin === null) {
    return true;
  }

  for (const match of action.matchAll(URL_TOKEN)) {
    const token = match[0].replace(/[),.;!?]+$/gu, "");
    try {
      const parsed = new URL(token, origin);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.origin !== origin
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }

  return false;
}

function containsUnapprovedHostNavigation(action, targetOrigin) {
  const origin = approvedOrigin(targetOrigin);
  if (origin === null) {
    return true;
  }
  const protocol = new URL(origin).protocol;

  for (const match of action.matchAll(HOST_TOKEN)) {
    try {
      const parsed = new URL(`${protocol}//${match[0]}`);
      if (parsed.origin !== origin) {
        return true;
      }
    } catch {
      return true;
    }
  }

  return false;
}

function ownPolicyFields(step) {
  try {
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      return null;
    }

    const prototype = Object.getPrototypeOf(step);
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }

    const action = Object.getOwnPropertyDescriptor(step, "action");
    const risk = Object.getOwnPropertyDescriptor(step, "risk");
    if (
      action === undefined ||
      risk === undefined ||
      !("value" in action) ||
      !("value" in risk) ||
      typeof action.value !== "string" ||
      action.value.trim() === "" ||
      !VALID_RISKS.has(risk.value)
    ) {
      return null;
    }

    return { action: action.value, risk: risk.value };
  } catch {
    return null;
  }
}

export function evaluateStepPolicy(step, targetOrigin) {
  const fields = ownPolicyFields(step);
  if (fields === null) {
    return "blocked";
  }

  const { action, risk } = fields;
  if (
    ENGLISH_IRREVERSIBLE.test(action) ||
    KOREAN_IRREVERSIBLE.test(action) ||
    containsUnapprovedOrigin(action, targetOrigin) ||
    containsUnapprovedHostNavigation(action, targetOrigin)
  ) {
    return "blocked";
  }

  return risk;
}
