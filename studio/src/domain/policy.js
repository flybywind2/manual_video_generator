const ENGLISH_IRREVERSIBLE =
  /\b(?:delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|send(?:s|ing)?|sent|submit(?:s|ted|ting)?|publish(?:es|ed|ing)?|purchas(?:e|es|ed|ing))\b/iu;
const KOREAN_IRREVERSIBLE =
  /(?:^|[^\p{L}\p{N}_])(?:삭제|전송|등록|구매)(?=$|[^\p{L}\p{N}_]|(?:하|합|해|했|할|한|시키|시킵|시켜|시켰|시킬|시킨))/u;
const EXPLICIT_URL_TOKEN = /(?:https?:)?\/\/[^\s<>"'`]+/giu;
const HOST_TOKEN =
  /(?:\[[0-9a-f:]+\]|localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)(?::\d{1,5})?(?:\/[^\s<>"'`]*)?/giu;
const ROUTE_TOKEN =
  /(?:^|[\s("'`])([a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9._~!$&'()*+,;=:@%-]*)+)/giu;
const SCHEME_TOKEN = /\b([a-z][a-z0-9+.-]*):[^\s<>"'`]*/giu;
const RELATIVE_TARGET =
  /(?:^|[\s(\[{"'`])((?:(?:\.{1,2}\/)+|\/(?!\/)|\?|#)[^\s<>"'`\]}]*)/gu;
const POLICY_TOKEN = /[\p{L}\p{N}_]+/gu;
const VALID_RISKS = new Set(["safe", "review", "blocked"]);
const FILE_EXTENSIONS = new Set([
  "csv",
  "docx",
  "gif",
  "jpeg",
  "jpg",
  "json",
  "md",
  "mp4",
  "pdf",
  "png",
  "svg",
  "txt",
  "wav",
  "webm",
  "xlsx",
]);

export function canonicalPolicyText(value) {
  return typeof value === "string"
    ? value
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .trim()
        .replace(/\s+/gu, " ")
    : "";
}

const FORBIDDEN_CAPABILITY_ALIASES = new Map(
  [
    ["user-data.change", "user-data.change"],
    ["change user data", "user-data.change"],
    ["사용자 데이터 변경", "user-data.change"],
    ["record.delete", "record.delete"],
    ["delete", "record.delete"],
    ["remove", "record.delete"],
    ["삭제", "record.delete"],
    ["message.send", "message.send"],
    ["send", "message.send"],
    ["전송", "message.send"],
    ["form.submit", "form.submit"],
    ["submit", "form.submit"],
    ["등록", "form.submit"],
    ["content.publish", "content.publish"],
    ["publish", "content.publish"],
    ["purchase.create", "purchase.create"],
    ["purchase", "purchase.create"],
    ["구매", "purchase.create"],
  ].map(([alias, capability]) => [canonicalPolicyText(alias), capability]),
);
const FORBIDDEN_CAPABILITIES = new Set(FORBIDDEN_CAPABILITY_ALIASES.values());

export function canonicalForbiddenCapability(value) {
  return FORBIDDEN_CAPABILITY_ALIASES.get(canonicalPolicyText(value)) ?? null;
}

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

    const navigationTarget = Object.getOwnPropertyDescriptor(
      step,
      "navigationTarget",
    );
    if (
      navigationTarget !== undefined &&
      (!("value" in navigationTarget) ||
        (navigationTarget.value !== null &&
          typeof navigationTarget.value !== "string"))
    ) {
      return null;
    }

    return {
      action: action.value,
      risk: risk.value,
      navigationTargetPresent: navigationTarget !== undefined,
      navigationTarget: navigationTarget?.value,
    };
  } catch {
    return null;
  }
}

function navigationTargetUrl(fields, targetOrigin) {
  if (!fields.navigationTargetPresent) {
    return { valid: true, url: null };
  }
  if (fields.navigationTarget === null) {
    return { valid: true, url: null };
  }

  try {
    const parsed = new URL(fields.navigationTarget);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.origin !== targetOrigin
    ) {
      return { valid: false, url: null };
    }
    return { valid: true, url: parsed };
  } catch {
    return { valid: false, url: null };
  }
}

function policyTokens(value) {
  return canonicalPolicyText(value).match(POLICY_TOKEN) ?? [];
}

function englishTokenForms(token) {
  const forms = new Set([token]);
  if (token.endsWith("e")) {
    forms.add(`${token}s`);
    forms.add(`${token}d`);
    forms.add(`${token.slice(0, -1)}ing`);
  } else {
    forms.add(`${token}s`);
    forms.add(`${token}ed`);
    forms.add(`${token}ing`);
  }
  return forms;
}

const KOREAN_SUFFIXES = Object.freeze([
  "시켰습니다",
  "시킵니다",
  "했습니다",
  "하였습니다",
  "시키다",
  "시킨",
  "시켜",
  "합니다",
  "하였다",
  "하세요",
  "했어요",
  "하기",
  "한다",
  "하다",
  "해요",
  "했다",
  "해",
  "으로",
  "에서",
  "에게",
  "을",
  "를",
  "이",
  "가",
  "은",
  "는",
  "와",
  "과",
  "로",
  "에",
  "도",
  "만",
  "의",
]);

function tokenMatchesCapability(actionToken, capabilityToken) {
  if (/^[a-z0-9_]+$/u.test(capabilityToken)) {
    return englishTokenForms(capabilityToken).has(actionToken);
  }
  if (actionToken === capabilityToken) {
    return true;
  }
  for (const suffix of KOREAN_SUFFIXES) {
    if (
      actionToken.endsWith(suffix) &&
      actionToken.slice(0, -suffix.length) === capabilityToken
    ) {
      return true;
    }
  }
  return false;
}

function containsCapabilitySequence(haystack, needle) {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }

  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (
      needle.every((token, offset) =>
        tokenMatchesCapability(haystack[start + offset], token),
      )
    ) {
      return true;
    }
  }
  return false;
}

const CAPABILITY_PHRASES = Object.freeze({
  "content.publish": Object.freeze([["publish"]]),
  "form.submit": Object.freeze([["submit"], ["등록"]]),
  "message.send": Object.freeze([["send"], ["전송"]]),
  "purchase.create": Object.freeze([["purchase"], ["구매"]]),
  "record.delete": Object.freeze([["delete"], ["remove"], ["삭제"]]),
  "user-data.change": Object.freeze([
    ["change", "user", "data"],
    ["change", "the", "user", "data"],
    ["change", "user", "s", "data"],
    ["change", "the", "user", "s", "data"],
    ["update", "user", "data"],
    ["update", "the", "user", "data"],
    ["update", "user", "s", "data"],
    ["update", "the", "user", "s", "data"],
    ["사용자", "데이터", "변경"],
  ]),
});

function normalizedNavigationText(value) {
  return value
    .normalize("NFKC")
    .replace(/[\u3002\uff0e\uff61]/gu, ".");
}

function conflictsWithForbiddenAction(action, forbiddenActions) {
  if (!Array.isArray(forbiddenActions)) {
    return true;
  }

  const actionTokens = policyTokens(action);
  for (const capability of forbiddenActions) {
    if (
      typeof capability !== "string" ||
      !FORBIDDEN_CAPABILITIES.has(capability)
    ) {
      return true;
    }
    if (
      CAPABILITY_PHRASES[capability].some((phrase) =>
        containsCapabilitySequence(actionTokens, phrase),
      )
    ) {
      return true;
    }
  }
  return false;
}

function inspectExplicitUrls(action, targetOrigin, navigationUrl, metadataPresent) {
  for (const match of action.matchAll(EXPLICIT_URL_TOKEN)) {
    const token = match[0].replace(/[),.;!?]+$/gu, "");
    try {
      const parsed = new URL(token, targetOrigin);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.origin !== targetOrigin ||
        (metadataPresent &&
          (navigationUrl === null || parsed.href !== navigationUrl.href))
      ) {
        return { blocked: true, remainder: "" };
      }
    } catch {
      return { blocked: true, remainder: "" };
    }
  }

  return {
    blocked: false,
    remainder: action.replace(EXPLICIT_URL_TOKEN, " "),
  };
}

function inspectSchemeAndRelativeTargets(remainder, targetOrigin, navigationUrl) {
  const withoutHosts = remainder.replace(HOST_TOKEN, " ");

  for (const match of withoutHosts.matchAll(SCHEME_TOKEN)) {
    const scheme = match[1].toLocaleLowerCase("en-US");
    if (scheme !== "http" && scheme !== "https") {
      return true;
    }

    if (navigationUrl === null) {
      return true;
    }

    try {
      const parsed = new URL(match[0], `${targetOrigin}/`);
      if (
        parsed.origin !== targetOrigin ||
        parsed.href !== navigationUrl.href
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }

  for (const match of withoutHosts.matchAll(RELATIVE_TARGET)) {
    const token = match[1].replace(/[),.;!]+$/gu, "");
    if (navigationUrl === null) {
      return true;
    }

    try {
      const parsed = new URL(token, `${targetOrigin}/`);
      if (
        parsed.origin !== targetOrigin ||
        parsed.href !== navigationUrl.href
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }

  return false;
}

function canonicalPath(value) {
  try {
    return decodeURIComponent(value).normalize("NFKC").toLocaleLowerCase("en-US");
  } catch {
    return "";
  }
}

function fileLikeHost(token) {
  if (token.includes("/") || token.includes(":")) {
    return false;
  }
  const extension = token.split(".").at(-1)?.toLocaleLowerCase("en-US");
  return extension !== undefined && FILE_EXTENSIONS.has(extension);
}

function inspectAmbiguousNavigation(remainder, targetOrigin, navigationUrl) {
  const protocol = new URL(targetOrigin).protocol;

  for (const match of remainder.matchAll(HOST_TOKEN)) {
    const token = match[0].replace(/[),.;!?]+$/gu, "");
    if (navigationUrl === null) {
      return true;
    }

    if (fileLikeHost(token)) {
      const targetFile = canonicalPath(navigationUrl.pathname.split("/").at(-1) ?? "");
      if (targetFile !== canonicalPath(token)) {
        return true;
      }
      continue;
    }

    try {
      const parsed = new URL(`${protocol}//${token}`);
      if (parsed.origin !== targetOrigin) {
        return true;
      }
      if (
        parsed.pathname !== "/" &&
        (parsed.pathname !== navigationUrl.pathname ||
          parsed.search !== navigationUrl.search ||
          parsed.hash !== navigationUrl.hash)
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }

  const withoutHosts = remainder.replace(HOST_TOKEN, " ");
  for (const match of withoutHosts.matchAll(ROUTE_TOKEN)) {
    if (navigationUrl === null) {
      return true;
    }
    const route = canonicalPath(match[1]).replace(/^\/+|\/+$/gu, "");
    const targetPath = canonicalPath(navigationUrl.pathname).replace(
      /^\/+|\/+$/gu,
      "",
    );
    if (route === "" || (targetPath !== route && !targetPath.endsWith(`/${route}`))) {
      return true;
    }
  }

  return false;
}

export function evaluateStepPolicy(step, targetOrigin, forbiddenActions = []) {
  const fields = ownPolicyFields(step);
  const origin = approvedOrigin(targetOrigin);
  if (fields === null || origin === null) {
    return "blocked";
  }

  const normalizedAction = canonicalPolicyText(fields.action);
  if (
    ENGLISH_IRREVERSIBLE.test(normalizedAction) ||
    KOREAN_IRREVERSIBLE.test(normalizedAction) ||
    conflictsWithForbiddenAction(fields.action, forbiddenActions)
  ) {
    return "blocked";
  }

  const navigation = navigationTargetUrl(fields, origin);
  if (!navigation.valid) {
    return "blocked";
  }

  const explicit = inspectExplicitUrls(
    normalizedNavigationText(fields.action),
    origin,
    navigation.url,
    fields.navigationTargetPresent,
  );
  if (
    explicit.blocked ||
    inspectSchemeAndRelativeTargets(
      explicit.remainder,
      origin,
      navigation.url,
    ) ||
    inspectAmbiguousNavigation(explicit.remainder, origin, navigation.url)
  ) {
    return "blocked";
  }

  return fields.risk;
}
