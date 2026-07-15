import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import { StudioError } from "../domain/errors.js";
import { MAX_STEP_NARRATION_CODE_UNITS } from "../domain/plan.js";
import { latestValidPlanDigest } from "../domain/recovery-provenance.js";

const JSON_TYPE = "application/json; charset=utf-8";
const HTML_TYPE = "text/html; charset=utf-8";
const SSE_TYPE = "text/event-stream; charset=utf-8";
const DEFAULT_MAX_JSON_BYTES = 64 * 1024;
const MAX_FORM_BYTES = 8 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PROMPT_LENGTH = 10_000;
const MAX_COMPLETION_CONDITION_LENGTH = 2_000;
const MAX_URL_LENGTH = 2_048;
const MAX_APPROVED_ORIGINS = 16;
const MAX_ARTIFACT_FILES = 1_000;
const CREDENTIAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const PLAN_DIGEST = /^[a-f0-9]{64}$/u;
const SCENE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const VOICES = new Set(["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"]);
const DEFAULT_COMPLETION_CONDITION = "요청한 최종 화면이 보이면 완료";
const CHECK_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const SAFE_CHECK_STATUS = new Set(["ready", "missing", "mismatch"]);
const STATIC_ROUTES = Object.freeze(new Map([
  ["/", Object.freeze({ file: "index.html", type: HTML_TYPE })],
  ["/index.html", Object.freeze({ file: "index.html", type: HTML_TYPE })],
  ["/app.js", Object.freeze({ file: "app.js", type: "text/javascript; charset=utf-8" })],
  ["/styles.css", Object.freeze({ file: "styles.css", type: "text/css; charset=utf-8" })],
]));
const ARTIFACT_TYPES = Object.freeze(new Map([
  [".aac", "audio/aac"],
  [".css", "text/css; charset=utf-8"],
  [".html", "application/octet-stream"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", JSON_TYPE],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".txt", "text/plain; charset=utf-8"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".vtt", "text/vtt; charset=utf-8"],
  [".webvtt", "text/vtt; charset=utf-8"],
]));
const ERROR_STATUS = Object.freeze({
  AUTHENTICATION_STATE_INVALID: 409,
  EXECUTION_ALREADY_RUNNING: 409,
  EXECUTION_BUSY: 409,
  EXECUTION_STATE_INVALID: 409,
  INVALID_JOB_ID: 400,
  INVALID_EVENT_SEQUENCE: 400,
  INVALID_EVENT_SUBSCRIPTION: 400,
  JOB_NOT_FOUND: 404,
  MEDIA_EDIT_NOT_ALLOWED: 409,
  MEDIA_RENDER_NOT_ALLOWED: 409,
  PLAN_DIGEST_MISMATCH: 409,
  PLANNING_STATE_INVALID: 409,
  PREVIEW_DIGEST_MISMATCH: 409,
  PRODUCTION_ALREADY_RUNNING: 409,
  PRODUCTION_STATE_INVALID: 409,
  UNSAFE_JOB_PATH: 404,
  CORRUPT_JOB_DATA: 500,
  JOBS_ROOT_LOCKED: 503,
  ROOT_LOCK_OWNERSHIP_LOST: 503,
});
const PUBLIC_MESSAGES = Object.freeze({
  ARTIFACT_NOT_FOUND: "요청한 산출물을 찾을 수 없습니다.",
  INTERNAL_SERVER_ERROR: "요청을 처리하지 못했습니다.",
  INVALID_ARTIFACT_MANIFEST: "산출물 목록을 읽을 수 없습니다.",
  INVALID_EVENT_SEQUENCE: "이벤트 순서 번호가 올바르지 않습니다.",
  INVALID_JOB_REQUEST: "작업 요청 형식이 올바르지 않습니다.",
  INVALID_JSON: "JSON 요청 본문이 올바르지 않습니다.",
  CROSS_ORIGIN_REQUEST: "교차 출처 요청은 허용되지 않습니다.",
  METHOD_NOT_ALLOWED: "이 경로에서 지원하지 않는 메서드입니다.",
  MISDIRECTED_REQUEST: "이 로컬 서비스로 향한 요청이 아닙니다.",
  RANGE_NOT_SATISFIABLE: "요청한 바이트 범위를 제공할 수 없습니다.",
  REQUEST_BODY_TOO_LARGE: "요청 본문이 허용 크기를 초과했습니다.",
  ROUTE_NOT_FOUND: "요청한 경로를 찾을 수 없습니다.",
  UNSAFE_STATIC_ROOT: "정적 파일 경로를 안전하게 열 수 없습니다.",
  UNSUPPORTED_MEDIA_TYPE: "지원하지 않는 요청 콘텐츠 형식입니다.",
});
const FIXTURE_USERNAME = "demo";
const FIXTURE_PASSWORD = "manual-video-demo";
const FIXTURE_COOKIE = "manual_fixture_session";
const FIXTURE_SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_FIXTURE_SESSIONS = 128;
const FIXTURE_LOGIN_TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_FIXTURE_LOGIN_TOKENS = 128;
const FIXTURE_LOGIN_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const STATIC_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const FIXTURE_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

class HttpError extends Error {
  constructor(status, code, { message, stage = "server", retryable = false, headers = {} } = {}) {
    super(code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.publicMessage = message ?? PUBLIC_MESSAGES[code] ?? PUBLIC_MESSAGES.INTERNAL_SERVER_ERROR;
    this.stage = stage;
    this.retryable = retryable;
    this.headers = headers;
  }
}

function setCommonHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function sendBuffer(response, status, bytes, contentType, headers = {}) {
  setCommonHeaders(response);
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", String(bytes.length));
  for (const [name, value] of Object.entries(headers)) {
    response.setHeader(name, value);
  }
  response.end(bytes);
}

function sendJson(response, status, value, headers = {}) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  sendBuffer(response, status, bytes, JSON_TYPE, {
    "Cache-Control": "no-store",
    ...headers,
  });
}

function sendHtml(response, status, html, headers = {}) {
  sendBuffer(response, status, Buffer.from(html, "utf8"), HTML_TYPE, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": FIXTURE_CSP,
    ...headers,
  });
}

function publicError(error) {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof StudioError) {
    const snapshot = error.toJSON();
    return new HttpError(ERROR_STATUS[snapshot.code] ?? 500, snapshot.code, {
      message: PUBLIC_MESSAGES[snapshot.code] ?? snapshot.publicMessage,
      stage: snapshot.stage,
      retryable: snapshot.retryable,
    });
  }
  return new HttpError(500, "INTERNAL_SERVER_ERROR");
}

function sendError(response, error) {
  const safe = publicError(error);
  if (response.headersSent) {
    response.destroy();
    return;
  }
  sendJson(response, safe.status, {
    error: {
      code: safe.code,
      message: safe.publicMessage,
      stage: safe.stage,
      retryable: safe.retryable,
      artifactPaths: [],
    },
  }, safe.headers);
}

function rawHeaderCount(request, name) {
  const expected = name.toLowerCase();
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (String(request.rawHeaders[index]).toLowerCase() === expected) {
      count += 1;
    }
  }
  return count;
}

function assertLocalRequestAuthority(request) {
  const localAddress = request.socket?.localAddress;
  const localPort = request.socket?.localPort;
  const host = request.headers.host;
  const expectedHost = Number.isSafeInteger(localPort)
    ? `127.0.0.1:${localPort}`
    : "";
  if (
    localAddress !== "127.0.0.1" ||
    expectedHost === "" ||
    rawHeaderCount(request, "host") !== 1 ||
    typeof host !== "string" ||
    host !== expectedHost ||
    typeof request.url !== "string" ||
    !request.url.startsWith("/") ||
    request.url.startsWith("//")
  ) {
    request.resume();
    throw new HttpError(421, "MISDIRECTED_REQUEST");
  }

  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  const opaqueFixtureLogin =
    origin === "null" &&
    request.method === "POST" &&
    request.url === "/fixture/login";
  if (
    rawHeaderCount(request, "origin") > 1 ||
    (origin !== undefined &&
      (typeof origin !== "string" ||
        (origin !== `http://${expectedHost}` && !opaqueFixtureLogin))) ||
    (fetchSite !== undefined &&
      (typeof fetchSite !== "string" ||
        !new Set(["none", "same-origin"]).has(fetchSite.toLowerCase())))
  ) {
    request.resume();
    throw new HttpError(403, "CROSS_ORIGIN_REQUEST");
  }
}

function methodNotAllowed(allowed) {
  throw new HttpError(405, "METHOD_NOT_ALLOWED", {
    headers: { Allow: allowed.join(", ") },
  });
}

function assertMethod(request, methods) {
  if (!methods.includes(request.method)) {
    methodNotAllowed(methods);
  }
}

function mediaType(request) {
  return String(request.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

async function readBoundedBody(request, maximum) {
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    if (!/^\d+$/u.test(declared) || Number(declared) > maximum) {
      request.resume();
      throw new HttpError(413, "REQUEST_BODY_TOO_LARGE");
    }
  }
  const encoding = String(request.headers["content-encoding"] ?? "identity").toLowerCase();
  if (encoding !== "identity") {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE");
  }

  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) {
    throw new HttpError(413, "REQUEST_BODY_TOO_LARGE");
  }
  return Buffer.concat(chunks, size);
}

async function readJson(request, maximum) {
  if (mediaType(request) !== "application/json") {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE");
  }
  const body = await readBoundedBody(request, maximum);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }
}

async function readOptionalEmptyJson(request, maximum) {
  if (
    request.headers["transfer-encoding"] === undefined &&
    (request.headers["content-length"] === undefined || request.headers["content-length"] === "0")
  ) {
    return;
  }
  const body = await readJson(request, maximum);
  if (!isPlainRecord(body) || Reflect.ownKeys(body).length !== 0) {
    throw new HttpError(400, "INVALID_JSON");
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function approvedOriginArray(value, targetOrigin, approvedOrigins) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_APPROVED_ORIGINS) {
    throw new HttpError(400, "INVALID_JOB_REQUEST");
  }
  const origins = value.map((item) => {
    if (typeof item !== "string" || item.length === 0 || item.length > MAX_URL_LENGTH) {
      throw new HttpError(400, "INVALID_JOB_REQUEST");
    }
    let parsed;
    try {
      parsed = new URL(item.trim());
    } catch {
      throw new HttpError(400, "INVALID_JOB_REQUEST");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new HttpError(400, "INVALID_JOB_REQUEST");
    }
    const origin = parsed.origin;
    if (origin === targetOrigin || approvedOrigins.has(origin)) {
      throw new HttpError(400, "INVALID_JOB_REQUEST");
    }
    approvedOrigins.add(origin);
    return origin;
  });
  return Object.freeze(origins.sort());
}

function validateJobRequest(value) {
  if (!isPlainRecord(value)) {
    throw new HttpError(400, "INVALID_JOB_REQUEST");
  }
  const allowed = new Set([
    "targetUrl",
    "prompt",
    "completionCondition",
    "authMode",
    "authOrigins",
    "resourceOrigins",
    "credentialId",
    "voice",
  ]);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key))) {
    throw new HttpError(400, "INVALID_JOB_REQUEST");
  }
  if (typeof value.targetUrl !== "string" || value.targetUrl.length > MAX_URL_LENGTH) {
    throw new HttpError(400, "INVALID_JOB_REQUEST");
  }
  let target;
  try {
    target = new URL(value.targetUrl);
  } catch {
    throw new HttpError(400, "INVALID_JOB_REQUEST");
  }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    throw new HttpError(400, "INVALID_JOB_REQUEST");
  }
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH || /[\u0000\u000b\u000c\u000e-\u001f\u007f]/u.test(prompt)) {
    throw new HttpError(400, "INVALID_JOB_REQUEST");
  }
  if (!new Set(["manual", "automatic"]).has(value.authMode)) {
    throw new HttpError(400, "INVALID_JOB_REQUEST");
  }
  if (value.authMode === "automatic") {
    if (typeof value.credentialId !== "string" || !CREDENTIAL_ID.test(value.credentialId)) {
      throw new HttpError(400, "INVALID_JOB_REQUEST");
    }
  } else if (value.credentialId !== undefined) {
    throw new HttpError(400, "INVALID_JOB_REQUEST");
  }
  const completionCondition = typeof value.completionCondition === "string"
    ? value.completionCondition.trim()
    : "";
  if (
    completionCondition.length > MAX_COMPLETION_CONDITION_LENGTH ||
    /[\u0000\u000b\u000c\u000e-\u001f\u007f]/u.test(completionCondition)
  ) {
    throw new HttpError(400, "INVALID_JOB_REQUEST");
  }
  const voice = value.voice ?? "F1";
  if (typeof voice !== "string" || !VOICES.has(voice)) {
    throw new HttpError(400, "INVALID_JOB_REQUEST");
  }
  const approvedOrigins = new Set();
  const authOrigins = approvedOriginArray(value.authOrigins, target.origin, approvedOrigins);
  const resourceOrigins = approvedOriginArray(value.resourceOrigins, target.origin, approvedOrigins);
  if (value.authMode === "automatic" && authOrigins.length > 1) {
    throw new HttpError(400, "INVALID_JOB_REQUEST");
  }

  return Object.freeze({
    targetUrl: target.href,
    prompt,
    completionCondition: completionCondition || DEFAULT_COMPLETION_CONDITION,
    authMode: value.authMode,
    authOrigins,
    resourceOrigins,
    voice,
    ...(value.credentialId === undefined ? {} : { credentialId: value.credentialId }),
  });
}

function exactBody(value, allowed, required, code) {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new HttpError(400, code);
  }
  return value;
}

function digestBody(value, field, code) {
  const body = exactBody(value, [field], [field], code);
  if (typeof body[field] !== "string" || !PLAN_DIGEST.test(body[field])) {
    throw new HttpError(400, code);
  }
  return body[field];
}

function executionReapprovalBody(value) {
  const body = exactBody(
    value,
    ["planDigest", "mismatchSequence"],
    ["planDigest", "mismatchSequence"],
    "INVALID_REAPPROVAL_REQUEST",
  );
  if (
    typeof body.planDigest !== "string" ||
    !PLAN_DIGEST.test(body.planDigest) ||
    !Number.isSafeInteger(body.mismatchSequence) ||
    body.mismatchSequence < 1
  ) {
    throw new HttpError(400, "INVALID_REAPPROVAL_REQUEST");
  }
  return Object.freeze({
    planDigest: body.planDigest,
    mismatchSequence: body.mismatchSequence,
  });
}

function recoveryBody(value) {
  const body = exactBody(
    value,
    ["planDigest", "previewDigest"],
    ["planDigest", "previewDigest"],
    "INVALID_RETRY_REQUEST",
  );
  if (!PLAN_DIGEST.test(body.planDigest) || !PLAN_DIGEST.test(body.previewDigest)) {
    throw new HttpError(400, "INVALID_RETRY_REQUEST");
  }
  return Object.freeze({
    planDigest: body.planDigest,
    previewDigest: body.previewDigest,
  });
}

function planUpdateBody(value) {
  const body = exactBody(value, ["plan", "planDigest"], ["plan", "planDigest"], "INVALID_PLAN_REQUEST");
  if (!isPlainRecord(body.plan) || typeof body.planDigest !== "string" || !PLAN_DIGEST.test(body.planDigest)) {
    throw new HttpError(400, "INVALID_PLAN_REQUEST");
  }
  return body;
}

function mediaEditBody(value) {
  const body = exactBody(
    value,
    ["previewDigest", "sceneId", "narrationText", "captionText"],
    ["previewDigest", "sceneId"],
    "INVALID_MEDIA_EDIT",
  );
  if (
    typeof body.sceneId !== "string" ||
    !SCENE_ID.test(body.sceneId) ||
    typeof body.previewDigest !== "string" ||
    !PLAN_DIGEST.test(body.previewDigest) ||
    (!Object.hasOwn(body, "narrationText") && !Object.hasOwn(body, "captionText"))
  ) {
    throw new HttpError(400, "INVALID_MEDIA_EDIT");
  }
  for (const field of ["narrationText", "captionText"]) {
    if (!Object.hasOwn(body, field)) continue;
    if (
      typeof body[field] !== "string" ||
      body[field].trim().length === 0 ||
      body[field].length > (field === "narrationText" ? MAX_STEP_NARRATION_CODE_UNITS : 4_000) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body[field])
    ) {
      throw new HttpError(400, "INVALID_MEDIA_EDIT");
    }
  }
  return Object.freeze({
    previewDigest: body.previewDigest,
    sceneId: body.sceneId,
    ...(Object.hasOwn(body, "narrationText") ? { narrationText: body.narrationText.trim() } : {}),
    ...(Object.hasOwn(body, "captionText") ? { captionText: body.captionText.trim() } : {}),
  });
}

function credentialBody(value) {
  const body = exactBody(
    value,
    ["origin", "username", "password"],
    ["origin", "username", "password"],
    "INVALID_CREDENTIAL_REQUEST",
  );
  let origin;
  try {
    const parsed = new URL(body.origin);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error("invalid credential origin");
    }
    origin = parsed.origin;
  } catch {
    throw new HttpError(400, "INVALID_CREDENTIAL_REQUEST");
  }
  if (
    typeof body.origin !== "string" ||
    body.origin.length < 1 ||
    body.origin.length > MAX_URL_LENGTH ||
    typeof body.username !== "string" ||
    body.username.length < 1 ||
    body.username.length > 256 ||
    typeof body.password !== "string" ||
    body.password.length < 1 ||
    body.password.length > 4_096
  ) {
    throw new HttpError(400, "INVALID_CREDENTIAL_REQUEST");
  }
  return { origin, username: body.username, password: body.password };
}

function accepted(response, jobId, operation) {
  sendJson(response, 202, { accepted: true, jobId, operation });
}

function safeHealth(value) {
  const checks = {};
  if (isPlainRecord(value?.checks)) {
    for (const [key, check] of Object.entries(value.checks).slice(0, 32)) {
      if (!CHECK_KEY.test(key) || !isPlainRecord(check) || !SAFE_CHECK_STATUS.has(check.status)) {
        continue;
      }
      const safe = { status: check.status };
      for (const field of ["expected", "actual", "reason"]) {
        const item = check[field];
        if (item === null || (typeof item === "string" && item.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(item))) {
          safe[field] = item;
        }
      }
      checks[key] = safe;
    }
  }
  return { ready: value?.ready === true, checks };
}

function scheduleWorkflow(context, jobId, operation) {
  context.scheduleBackground(async (signal) => {
    try {
      return await operation(signal);
    } catch (error) {
      const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
        ? error.code
        : "WORKFLOW_OPERATION_REJECTED";
      try {
        const events = await context.jobStore.readEvents(jobId, 0);
        const planDigest = latestValidPlanDigest(events);
        const data = {
          code,
          retryable: error?.retryable === true,
        };
        if (planDigest !== undefined) data.planDigest = planDigest;
        await context.jobStore.transition(jobId, "OPERATION_REJECTED", data);
      } catch {
        // A workflow-owned terminal event or concurrent mutation remains authoritative.
      }
      throw error;
    }
  });
}

function decodeComponent(value, code = "ROUTE_NOT_FOUND") {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, code);
  }
}

function eventSequence(request) {
  const raw = request.headers["last-event-id"];
  if (raw === undefined || raw === "") {
    return 0;
  }
  if (Array.isArray(raw) || !/^\d+$/u.test(raw)) {
    throw new HttpError(400, "INVALID_EVENT_SEQUENCE");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new HttpError(400, "INVALID_EVENT_SEQUENCE");
  }
  return value;
}

async function handleEvents(request, response, { eventBus, jobStore }, jobId) {
  const afterSequence = eventSequence(request);
  await jobStore.load(jobId);
  setCommonHeaders(response);
  response.statusCode = 200;
  response.setHeader("Content-Type", SSE_TYPE);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
  response.write(": connected\n\n");

  let clientClosed;
  const closedByClient = new Promise((resolveClosed) => {
    clientClosed = resolveClosed;
  });
  const subscription = eventBus.subscribe(jobId, afterSequence, async (event) => {
    if (response.destroyed || response.writableEnded) {
      return;
    }
    const frame = `id: ${event.sequence}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
    if (!response.write(frame)) {
      await new Promise((resolveDrain) => {
        const finish = () => {
          response.off("drain", finish);
          response.off("close", finish);
          resolveDrain();
        };
        response.once("drain", finish);
        response.once("close", finish);
      });
    }
  });
  const close = () => {
    clientClosed();
    subscription.close();
  };
  request.once("aborted", close);
  response.once("close", close);
  try {
    const terminal = Promise.race([
      subscription.closing.then((details) => ({ kind: "source", reason: details.reason })),
      closedByClient.then(() => ({ kind: "client", reason: "client" })),
    ]);
    const first = await Promise.race([
      subscription.ready.then(() => ({ kind: "ready", reason: null })),
      terminal,
    ]);
    const closedBy = first.kind === "ready" ? await terminal : first;
    if (closedBy.kind === "source" && closedBy.reason !== "client" && !response.destroyed && !response.writableEnded) {
      if (closedBy.reason === "backpressure") {
        response.destroy();
      } else {
        response.end();
      }
    }
  } finally {
    request.off("aborted", close);
    response.off("close", close);
    subscription.close();
  }
}

function contained(root, candidate) {
  const child = resolve(candidate);
  const fromRoot = relative(resolve(root), child);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

async function assertRegularNoLinks(root, target, unsafeCode, { rootCode = unsafeCode } = {}) {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  if (!contained(absoluteRoot, absoluteTarget)) {
    throw new HttpError(404, unsafeCode);
  }
  let rootEntry;
  try {
    rootEntry = await lstat(absoluteRoot);
  } catch {
    throw new HttpError(500, rootCode);
  }
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new HttpError(500, rootCode);
  }

  const parts = relative(absoluteRoot, absoluteTarget).split(sep);
  let current = absoluteRoot;
  let targetEntry;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new HttpError(404, unsafeCode);
      }
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new HttpError(404, unsafeCode);
    }
    const isLast = index === parts.length - 1;
    if ((!isLast && !entry.isDirectory()) || (isLast && !entry.isFile())) {
      throw new HttpError(404, unsafeCode);
    }
    if (isLast) {
      targetEntry = entry;
    }
  }
  const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(absoluteRoot), realpath(absoluteTarget)]);
  if (!contained(canonicalRoot, canonicalTarget)) {
    throw new HttpError(404, unsafeCode);
  }
  return targetEntry;
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size
  );
}

export async function openVerifiedRegular(
  root,
  target,
  unsafeCode,
  { rootCode = unsafeCode, afterInspect } = {},
) {
  const inspected = await assertRegularNoLinks(root, target, unsafeCode, { rootCode });
  if (inspected.nlink !== 1) {
    throw new HttpError(404, unsafeCode);
  }
  if (afterInspect !== undefined) {
    if (typeof afterInspect !== "function") {
      throw new TypeError("afterInspect must be a function");
    }
    await afterInspect();
  }

  let handle;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await open(target, flags);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !sameFileIdentity(inspected, opened)
    ) {
      throw new HttpError(404, unsafeCode);
    }
    const rechecked = await assertRegularNoLinks(root, target, unsafeCode, { rootCode });
    if (!sameFileIdentity(opened, rechecked)) {
      throw new HttpError(404, unsafeCode);
    }
    return Object.freeze({ handle, stat: opened });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(404, unsafeCode);
  }
}

async function readBoundedFile(handle, maximum, errorCode) {
  const bytes = Buffer.allocUnsafe(maximum + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  if (offset > maximum) {
    throw new HttpError(500, errorCode);
  }
  return bytes.subarray(0, offset);
}

function artifactName(raw) {
  const value = decodeComponent(raw, "ARTIFACT_NOT_FOUND");
  if (value.length === 0 || value.length > 1_024 || value.includes("\\") || value.includes("\0") || value.startsWith("/") || value.endsWith("/")) {
    throw new HttpError(404, "ARTIFACT_NOT_FOUND");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..") || value === "manifest.json") {
    throw new HttpError(404, "ARTIFACT_NOT_FOUND");
  }
  return value;
}

function parseManifest(source) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new HttpError(500, "INVALID_ARTIFACT_MANIFEST");
  }
  if (!isPlainRecord(manifest) || Object.keys(manifest).length !== 1 || !Array.isArray(manifest.files) || manifest.files.length > MAX_ARTIFACT_FILES) {
    throw new HttpError(500, "INVALID_ARTIFACT_MANIFEST");
  }
  const files = new Set();
  for (const file of manifest.files) {
    try {
      if (typeof file !== "string" || artifactName(encodeURIComponent(file).replaceAll("%2F", "/")) !== file || files.has(file)) {
        throw new Error("invalid");
      }
      files.add(file);
    } catch {
      throw new HttpError(500, "INVALID_ARTIFACT_MANIFEST");
    }
  }
  return files;
}

function parseRange(raw, size) {
  if (raw === undefined) {
    return null;
  }
  if (Array.isArray(raw) || raw.includes(",")) {
    return false;
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(raw);
  if (!match || (match[1] === "" && match[2] === "")) {
    return false;
  }
  let start;
  let end;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return false;
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      return false;
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

async function handleArtifact(request, response, context, jobId, rawName) {
  const name = artifactName(rawName);
  await context.jobStore.load(jobId);
  const jobRoot = join(context.jobsRoot, jobId);
  const artifactsRoot = join(jobRoot, "artifacts");
  const manifestPath = join(artifactsRoot, "manifest.json");
  const manifestFile = await openVerifiedRegular(jobRoot, manifestPath, "ARTIFACT_NOT_FOUND");
  let listed;
  try {
    if (manifestFile.stat.size > MAX_MANIFEST_BYTES) {
      throw new HttpError(500, "INVALID_ARTIFACT_MANIFEST");
    }
    const manifestBytes = await readBoundedFile(
      manifestFile.handle,
      MAX_MANIFEST_BYTES,
      "INVALID_ARTIFACT_MANIFEST",
    );
    listed = parseManifest(manifestBytes.toString("utf8"));
  } finally {
    await manifestFile.handle.close().catch(() => undefined);
  }
  if (!listed.has(name)) {
    throw new HttpError(404, "ARTIFACT_NOT_FOUND");
  }
  const path = join(artifactsRoot, ...name.split("/"));
  const artifactFile = await openVerifiedRegular(artifactsRoot, path, "ARTIFACT_NOT_FOUND");
  try {
    const fileStat = artifactFile.stat;
    const range = parseRange(request.headers.range, fileStat.size);
    if (range === false || (fileStat.size === 0 && request.headers.range !== undefined)) {
      throw new HttpError(416, "RANGE_NOT_SATISFIABLE", {
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes */${fileStat.size}`,
        },
      });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, fileStat.size - 1);
    const length = range === null ? fileStat.size : end - start + 1;
    setCommonHeaders(response);
    response.statusCode = range === null ? 200 : 206;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Type", ARTIFACT_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream");
    if (extname(path).toLowerCase() === ".html") {
      response.setHeader("Content-Disposition", 'attachment; filename="artifact.html"');
      response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    }
    response.setHeader("Content-Length", String(length));
    if (range !== null) {
      response.setHeader("Content-Range", `bytes ${start}-${end}/${fileStat.size}`);
    }
    if (fileStat.size === 0) {
      response.end();
      return;
    }
    try {
      await pipeline(
        artifactFile.handle.createReadStream({ autoClose: false, start, end }),
        response,
      );
    } catch (error) {
      if (!response.destroyed) {
        response.destroy(error);
      }
    }
  } finally {
    await artifactFile.handle.close().catch(() => undefined);
  }
}

function cookieValue(request, name) {
  const cookie = String(request.headers.cookie ?? "");
  for (const pair of cookie.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) {
      continue;
    }
    return pair.slice(separator + 1).trim();
  }
  return null;
}

function sameSecret(left, right) {
  const leftDigest = Buffer.from(left, "utf8");
  const rightDigest = Buffer.from(right, "utf8");
  return leftDigest.length === rightDigest.length && timingSafeEqual(leftDigest, rightDigest);
}

function fixturePage(title, content) {
  return `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body><header><strong>Manual Studio Login Fixture</strong></header>${content}<footer>Deterministic local test site</footer></body>
</html>`;
}

function loginPage({ csrfToken, invalid = false }) {
  return fixturePage("로그인", `<main><h1>로그인</h1>${invalid ? '<p role="alert">사용자 이름 또는 비밀번호가 올바르지 않습니다.</p>' : ""}<form method="post" action="/fixture/login"><input type="hidden" name="_csrf" value="${csrfToken}"><label for="fixture-username">사용자 이름</label><input id="fixture-username" name="username" autocomplete="username" required><label for="fixture-password">비밀번호</label><input id="fixture-password" name="password" type="password" autocomplete="current-password" required><button type="submit">로그인</button></form></main>`);
}

function issueFixtureLoginToken(context, now) {
  while (context.fixtureLoginTokens.size >= MAX_FIXTURE_LOGIN_TOKENS) {
    const oldest = context.fixtureLoginTokens.keys().next().value;
    if (oldest === undefined) break;
    context.fixtureLoginTokens.delete(oldest);
  }
  const token = randomBytes(32).toString("base64url");
  context.fixtureLoginTokens.set(token, now + FIXTURE_LOGIN_TOKEN_TTL_MS);
  return token;
}

function consumeFixtureLoginToken(context, token, now) {
  if (typeof token !== "string" || !FIXTURE_LOGIN_TOKEN.test(token)) return false;
  const expiresAt = context.fixtureLoginTokens.get(token);
  context.fixtureLoginTokens.delete(token);
  return expiresAt !== undefined && expiresAt > now;
}

function dashboardPage() {
  return fixturePage("대시보드", '<main><h1>데모 대시보드</h1><nav aria-label="데모 메뉴"><a href="/fixture/dashboard/projects">프로젝트 메뉴 열기</a></nav><form method="post" action="/fixture/logout"><button type="submit">로그아웃</button></form></main>');
}

function projectsPage() {
  return fixturePage("프로젝트", '<main data-fixture-step="1"><h1>프로젝트</h1><a href="/fixture/dashboard/projects/manual-video">Manual Video 프로젝트 선택</a><a href="/fixture/dashboard">대시보드로 돌아가기</a></main>');
}

function completedPage() {
  return fixturePage("Manual Video", '<main data-fixture-step="2"><h1>Manual Video</h1><p role="status" data-fixture-complete="true">완료: Manual Video 프로젝트가 열렸습니다.</p><a href="/fixture/dashboard">대시보드로 돌아가기</a></main>');
}

async function readForm(request) {
  if (mediaType(request) !== "application/x-www-form-urlencoded") {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE");
  }
  const body = await readBoundedBody(request, MAX_FORM_BYTES);
  return new URLSearchParams(body.toString("utf8"));
}

function redirect(response, location, headers = {}) {
  setCommonHeaders(response);
  response.writeHead(303, {
    "Cache-Control": "no-store",
    Location: location,
    ...headers,
  });
  response.end();
}

async function handleFixture(request, response, context, pathname) {
  const now = Date.now();
  for (const [session, sessionExpiresAt] of context.fixtureSessions) {
    if (sessionExpiresAt <= now) context.fixtureSessions.delete(session);
  }
  for (const [token, tokenExpiresAt] of context.fixtureLoginTokens) {
    if (tokenExpiresAt <= now) context.fixtureLoginTokens.delete(token);
  }
  const token = cookieValue(request, FIXTURE_COOKIE);
  const expiresAt = token === null ? undefined : context.fixtureSessions.get(token);
  const authenticated = expiresAt !== undefined && expiresAt > now;
  if (token !== null && !authenticated) {
    context.fixtureSessions.delete(token);
  }

  if (pathname === "/fixture/login") {
    assertMethod(request, ["GET", "POST"]);
    if (request.method === "GET") {
      if (authenticated) {
        redirect(response, "/fixture/dashboard");
      } else {
        sendHtml(response, 200, loginPage({ csrfToken: issueFixtureLoginToken(context, now) }));
      }
      return;
    }
    const form = await readForm(request);
    if (!consumeFixtureLoginToken(context, form.get("_csrf"), now)) {
      throw new HttpError(403, "CROSS_ORIGIN_REQUEST");
    }
    const username = form.get("username") ?? "";
    const password = form.get("password") ?? "";
    if (!sameSecret(username, FIXTURE_USERNAME) || !sameSecret(password, FIXTURE_PASSWORD)) {
      sendHtml(response, 401, loginPage({
        csrfToken: issueFixtureLoginToken(context, now),
        invalid: true,
      }));
      return;
    }
    const session = randomBytes(32).toString("base64url");
    while (context.fixtureSessions.size >= MAX_FIXTURE_SESSIONS) {
      const oldest = context.fixtureSessions.keys().next().value;
      if (oldest === undefined) break;
      context.fixtureSessions.delete(oldest);
    }
    context.fixtureSessions.set(session, now + FIXTURE_SESSION_TTL_MS);
    redirect(response, "/fixture/dashboard", {
      "Set-Cookie": `${FIXTURE_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/fixture; Max-Age=3600`,
    });
    return;
  }

  if (pathname === "/fixture/logout") {
    assertMethod(request, ["POST"]);
    if (token !== null) {
      context.fixtureSessions.delete(token);
    }
    redirect(response, "/fixture/login", {
      "Set-Cookie": `${FIXTURE_COOKIE}=; HttpOnly; SameSite=Strict; Path=/fixture; Max-Age=0`,
    });
    return;
  }

  const protectedPages = new Map([
    ["/fixture/dashboard", dashboardPage],
    ["/fixture/dashboard/projects", projectsPage],
    ["/fixture/dashboard/projects/manual-video", completedPage],
  ]);
  const render = protectedPages.get(pathname);
  if (render !== undefined) {
    assertMethod(request, ["GET"]);
    if (!authenticated) {
      redirect(response, "/fixture/login");
      return;
    }
    sendHtml(response, 200, render());
    return;
  }
  throw new HttpError(404, "ROUTE_NOT_FOUND");
}

async function serveStatic(request, response, publicRoot, route) {
  assertMethod(request, ["GET", "HEAD"]);
  const path = join(publicRoot, route.file);
  const staticFile = await openVerifiedRegular(publicRoot, path, "ROUTE_NOT_FOUND", {
    rootCode: "UNSAFE_STATIC_ROOT",
  });
  try {
    const fileStat = staticFile.stat;
    setCommonHeaders(response);
    response.statusCode = 200;
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Content-Security-Policy", STATIC_CSP);
    response.setHeader("Content-Type", route.type);
    response.setHeader("Content-Length", String(fileStat.size));
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    try {
      await pipeline(staticFile.handle.createReadStream({ autoClose: false }), response);
    } catch (error) {
      if (!response.destroyed) {
        response.destroy(error);
      }
    }
  } finally {
    await staticFile.handle.close().catch(() => undefined);
  }
}

export function createRouter({
  jobStore,
  eventBus,
  healthCheck,
  jobsRoot = jobStore?.root,
  publicRoot,
  maxJsonBytes = DEFAULT_MAX_JSON_BYTES,
  credentialVault = null,
  studioService = null,
  scheduleBackground = (operation) => {
    setImmediate(() => {
      Promise.resolve().then(operation).catch(() => undefined);
    });
  },
} = {}) {
  if (!jobStore || typeof jobStore.create !== "function" || typeof jobStore.load !== "function") {
    throw new TypeError("jobStore is required");
  }
  if (!eventBus || typeof eventBus.subscribe !== "function") {
    throw new TypeError("eventBus is required");
  }
  if (typeof healthCheck !== "function") {
    throw new TypeError("healthCheck is required");
  }
  if (typeof jobsRoot !== "string" || !isAbsolute(jobsRoot)) {
    throw new TypeError("jobsRoot must be absolute");
  }
  if (typeof publicRoot !== "string" || !isAbsolute(publicRoot)) {
    throw new TypeError("publicRoot must be absolute");
  }
  if (!Number.isSafeInteger(maxJsonBytes) || maxJsonBytes < 1 || maxJsonBytes > 1024 * 1024) {
    throw new TypeError("maxJsonBytes is invalid");
  }
  if (studioService !== null) {
    const methods = [
      "authenticateAndPlan",
      "confirmManualLoginAndPlan",
      "updatePlan",
      "approvePlan",
      "execute",
      "reapproveExecution",
      "retryComposition",
      "retryJob",
      "cancelJob",
      "updateMediaPlan",
      "approvePreview",
    ];
    if (methods.some((method) => typeof studioService?.[method] !== "function")) {
      throw new TypeError("studioService is invalid");
    }
  }
  if (credentialVault !== null && typeof credentialVault?.save !== "function") {
    throw new TypeError("credentialVault is invalid");
  }
  if (typeof scheduleBackground !== "function") {
    throw new TypeError("scheduleBackground is invalid");
  }
  const context = Object.freeze({
    credentialVault,
    eventBus,
    fixtureLoginTokens: new Map(),
    fixtureSessions: new Map(),
    healthCheck,
    jobStore,
    jobsRoot: resolve(jobsRoot),
    maxJsonBytes,
    publicRoot: resolve(publicRoot),
    scheduleBackground,
    studioService,
  });

  return async function route(request, response) {
    try {
      assertLocalRequestAuthority(request);
      if (typeof request.url !== "string" || request.url.length > 16_384) {
        throw new HttpError(404, "ROUTE_NOT_FOUND");
      }
      let url;
      try {
        url = new URL(request.url, "http://127.0.0.1");
      } catch {
        throw new HttpError(400, "ROUTE_NOT_FOUND");
      }
      const { pathname } = url;

      if (pathname === "/api/health") {
        assertMethod(request, ["GET"]);
        sendJson(response, 200, safeHealth(await context.healthCheck()));
        return;
      }
      if (pathname === "/api/jobs") {
        assertMethod(request, ["POST"]);
        const requestBody = validateJobRequest(await readJson(request, context.maxJsonBytes));
        const created = await context.jobStore.create(requestBody);
        sendJson(response, 201, created, { Location: `/api/jobs/${encodeURIComponent(created.id)}` });
        if (context.studioService !== null) {
          scheduleWorkflow(context, created.id, (signal) =>
            context.studioService.authenticateAndPlan(created.id, { signal }));
        }
        return;
      }

      const credentialMatch = /^\/api\/credentials\/([^/]+)$/u.exec(pathname);
      if (credentialMatch) {
        assertMethod(request, ["PUT"]);
        if (context.credentialVault === null) throw new HttpError(503, "CREDENTIAL_VAULT_UNAVAILABLE");
        const credentialId = decodeComponent(credentialMatch[1]);
        if (!CREDENTIAL_ID.test(credentialId)) throw new HttpError(400, "INVALID_CREDENTIAL_REQUEST");
        const credentials = credentialBody(await readJson(request, context.maxJsonBytes));
        await context.credentialVault.save(credentialId, credentials);
        setCommonHeaders(response);
        response.statusCode = 204;
        response.setHeader("Cache-Control", "no-store");
        response.end();
        return;
      }

      const workflowMatch = /^\/api\/jobs\/([^/]+)\/(login\/manual\/confirm|plan|plan\/approve|execute|execution\/reapprove|composition\/retry|retry|cancel|media-plan|preview\/approve)$/u.exec(pathname);
      if (workflowMatch) {
        if (context.studioService === null) throw new HttpError(503, "WORKFLOW_UNAVAILABLE");
        const jobId = decodeComponent(workflowMatch[1]);
        if (!JOB_ID.test(jobId)) throw new HttpError(400, "INVALID_JOB_ID");
        const action = workflowMatch[2];
        if (action === "login/manual/confirm") {
          assertMethod(request, ["POST"]);
          await readOptionalEmptyJson(request, context.maxJsonBytes);
          scheduleWorkflow(context, jobId, (signal) =>
            context.studioService.confirmManualLoginAndPlan(jobId, { signal }));
          accepted(response, jobId, "confirm_login");
          return;
        }
        if (action === "plan") {
          assertMethod(request, ["PUT"]);
          const body = planUpdateBody(await readJson(request, context.maxJsonBytes));
          sendJson(response, 200, await context.studioService.updatePlan(jobId, body.plan, body.planDigest));
          return;
        }
        if (action === "plan/approve") {
          assertMethod(request, ["POST"]);
          const digest = digestBody(await readJson(request, context.maxJsonBytes), "planDigest", "INVALID_PLAN_REQUEST");
          sendJson(response, 200, await context.studioService.approvePlan(jobId, digest));
          return;
        }
        if (action === "execute") {
          assertMethod(request, ["POST"]);
          const digest = digestBody(await readJson(request, context.maxJsonBytes), "planDigest", "INVALID_EXECUTION_REQUEST");
          scheduleWorkflow(context, jobId, (signal) =>
            context.studioService.execute(jobId, digest, { signal }));
          accepted(response, jobId, "execute");
          return;
        }
        if (action === "execution/reapprove") {
          assertMethod(request, ["POST"]);
          const recovery = executionReapprovalBody(await readJson(request, context.maxJsonBytes));
          scheduleWorkflow(context, jobId, (signal) =>
            context.studioService.reapproveExecution(jobId, recovery, { signal }));
          accepted(response, jobId, "reapprove_execution");
          return;
        }
        if (action === "composition/retry") {
          assertMethod(request, ["POST"]);
          const digest = digestBody(
            await readJson(request, context.maxJsonBytes),
            "planDigest",
            "INVALID_RETRY_REQUEST",
          );
          scheduleWorkflow(context, jobId, (signal) =>
            context.studioService.retryComposition(jobId, digest, { signal }));
          accepted(response, jobId, "retry_composition");
          return;
        }
        if (action === "retry") {
          assertMethod(request, ["POST"]);
          const recovery = recoveryBody(await readJson(request, context.maxJsonBytes));
          scheduleWorkflow(context, jobId, (signal) =>
            context.studioService.retryJob(jobId, recovery, { signal }));
          accepted(response, jobId, "retry_render");
          return;
        }
        if (action === "cancel") {
          assertMethod(request, ["POST"]);
          await readOptionalEmptyJson(request, context.maxJsonBytes);
          sendJson(response, 200, await context.studioService.cancelJob(jobId));
          return;
        }
        if (action === "media-plan") {
          assertMethod(request, ["PUT"]);
          const edit = mediaEditBody(await readJson(request, context.maxJsonBytes));
          scheduleWorkflow(context, jobId, (signal) =>
            context.studioService.updateMediaPlan(jobId, edit, { signal }));
          accepted(response, jobId, "edit_media");
          return;
        }
        assertMethod(request, ["POST"]);
        const digest = digestBody(await readJson(request, context.maxJsonBytes), "previewDigest", "INVALID_PREVIEW_REQUEST");
        scheduleWorkflow(context, jobId, (signal) =>
          context.studioService.approvePreview(jobId, digest, { signal }));
        accepted(response, jobId, "render");
        return;
      }

      const artifactMatch = /^\/api\/jobs\/([^/]+)\/artifacts\/(.+)$/u.exec(pathname);
      if (artifactMatch) {
        assertMethod(request, ["GET"]);
        await handleArtifact(request, response, context, decodeComponent(artifactMatch[1]), artifactMatch[2]);
        return;
      }
      const eventMatch = /^\/api\/jobs\/([^/]+)\/events$/u.exec(pathname);
      if (eventMatch) {
        assertMethod(request, ["GET"]);
        await handleEvents(request, response, context, decodeComponent(eventMatch[1]));
        return;
      }
      const jobMatch = /^\/api\/jobs\/([^/]+)$/u.exec(pathname);
      if (jobMatch) {
        assertMethod(request, ["GET"]);
        sendJson(response, 200, await context.jobStore.load(decodeComponent(jobMatch[1])));
        return;
      }
      if (pathname.startsWith("/fixture/")) {
        await handleFixture(request, response, context, pathname);
        return;
      }
      const staticRoute = STATIC_ROUTES.get(pathname);
      if (staticRoute !== undefined) {
        await serveStatic(request, response, context.publicRoot, staticRoute);
        return;
      }
      throw new HttpError(404, "ROUTE_NOT_FOUND");
    } catch (error) {
      sendError(response, error);
    }
  };
}
