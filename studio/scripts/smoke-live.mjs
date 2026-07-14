import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "http://127.0.0.1:4317";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TERMINAL_FAILURES = new Set([
  "AUTHENTICATION_FAILED",
  "PLANNING_FAILED",
  "EXECUTION_FAILED",
  "NARRATION_FAILED",
  "COMPOSITION_FAILED",
  "RENDER_FAILED",
  "CANCEL_JOB",
]);

class SmokeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SmokeError";
    this.code = code;
  }
}

function smokeError(code, message) {
  throw new SmokeError(code, message);
}

function safeBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    smokeError("SMOKE_BASE_URL_INVALID", "The live smoke base URL is invalid.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    smokeError("SMOKE_BASE_URL_INVALID", "The live smoke service must use loopback HTTP.");
  }
  return url.href.replace(/\/$/u, "");
}

function safeJobId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    smokeError("SMOKE_RESPONSE_INVALID", "The live smoke API returned an invalid job identifier.");
  }
  return value;
}

function parseFrame(frame) {
  const fields = new Map();
  for (const line of frame.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const name = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    const current = fields.get(name);
    fields.set(name, current === undefined ? value : `${current}\n${value}`);
  }
  if (!fields.has("data")) return null;
  let data;
  try {
    data = JSON.parse(fields.get("data"));
  } catch {
    smokeError("SMOKE_SSE_INVALID", "The live smoke event stream returned invalid JSON.");
  }
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    typeof data.event !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,63}$/u.test(data.event)
  ) {
    smokeError("SMOKE_SSE_INVALID", "The live smoke event stream returned an invalid event.");
  }
  return data;
}

export function parseSseFrames(source) {
  const normalized = String(source ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const chunks = normalized.split("\n\n");
  const rest = chunks.pop() ?? "";
  const events = [];
  for (const frame of chunks) {
    const parsed = parseFrame(frame);
    if (parsed !== null) events.push(parsed);
  }
  return Object.freeze({ events: Object.freeze(events), rest });
}

async function boundedText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      smokeError("SMOKE_RESPONSE_TOO_LARGE", "The live smoke API response was too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function requestJson(baseUrl, path, { method = "GET", body, signal } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const source = await boundedText(response);
  let value;
  try {
    value = source === "" ? {} : JSON.parse(source);
  } catch {
    smokeError("SMOKE_RESPONSE_INVALID", "The live smoke API returned invalid JSON.");
  }
  if (!response.ok) {
    const code = typeof value?.error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value.error.code)
      ? value.error.code
      : "SMOKE_HTTP_FAILED";
    smokeError(code, `The live smoke API request failed with HTTP ${response.status}.`);
  }
  return value;
}

async function waitForEvent(baseUrl, jobId, accepted, timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromExternal = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  }
  try {
    const response = await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(jobId)}/events`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      smokeError("SMOKE_SSE_FAILED", "The live smoke event stream could not be opened.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) smokeError("SMOKE_SSE_CLOSED", "The live smoke event stream closed early.");
      pending += decoder.decode(value, { stream: true });
      if (pending.length > MAX_RESPONSE_BYTES) smokeError("SMOKE_SSE_INVALID", "The live smoke event frame was too large.");
      const parsed = parseSseFrames(pending);
      pending = parsed.rest;
      for (const event of parsed.events) {
        if (TERMINAL_FAILURES.has(event.event)) {
          smokeError("SMOKE_WORKFLOW_FAILED", `The live workflow stopped at ${event.event}.`);
        }
        if (accepted.has(event.event)) {
          await reader.cancel();
          return event;
        }
      }
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      if (externalSignal?.aborted) {
        smokeError("SMOKE_INTERRUPTED", "The live smoke was interrupted.");
      }
      smokeError("SMOKE_TIMEOUT", "The live workflow did not reach the expected review gate in time.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
    controller.abort();
  }
}

function digestFrom(event, key) {
  const value = event?.data?.[key];
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    smokeError("SMOKE_RESPONSE_INVALID", `The live workflow did not bind ${key} to the review gate.`);
  }
  return value;
}

async function waitForManualConfirmation(signal) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    smokeError("SMOKE_MANUAL_LOGIN_REQUIRED", "Manual login requires an interactive terminal.");
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await terminal.question("브라우저에서 로그인을 마친 뒤 Enter를 누르세요: ", { signal });
  } finally {
    terminal.close();
  }
}

export async function cancelSmokeJob(baseUrl, jobId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    await requestJson(baseUrl, `/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      body: {},
      signal: controller.signal,
    });
  } catch {
    // Preserve the original smoke failure; cancellation is deliberately best-effort.
  } finally {
    clearTimeout(timeout);
  }
}

export function buildSmokeRequest(env = process.env, baseUrl = DEFAULT_BASE_URL) {
  const authMode = env.MANUAL_STUDIO_SMOKE_AUTH_MODE ?? "manual";
  if (!new Set(["manual", "automatic"]).has(authMode)) {
    smokeError("SMOKE_AUTH_MODE_INVALID", "The live smoke authentication mode is invalid.");
  }
  const credentialId = env.MANUAL_STUDIO_SMOKE_CREDENTIAL_ID;
  if (authMode === "automatic" && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(credentialId ?? "")) {
    smokeError("SMOKE_CREDENTIAL_REQUIRED", "Automatic smoke requires MANUAL_STUDIO_SMOKE_CREDENTIAL_ID.");
  }
  const targetUrl = env.MANUAL_STUDIO_SMOKE_TARGET_URL ?? `${baseUrl}/fixture/dashboard`;
  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    smokeError("SMOKE_TARGET_INVALID", "The live smoke target URL is invalid.");
  }
  if (!new Set(["http:", "https:"]).has(parsedTarget.protocol) || parsedTarget.username || parsedTarget.password) {
    smokeError("SMOKE_TARGET_INVALID", "The live smoke target URL is unsafe.");
  }
  return Object.freeze({
    targetUrl: parsedTarget.href,
    prompt: env.MANUAL_STUDIO_SMOKE_PROMPT ?? "프로젝트 메뉴에서 Manual Video 프로젝트를 열고 완료 화면을 보여 주세요.",
    completionCondition: env.MANUAL_STUDIO_SMOKE_COMPLETION_CONDITION ?? "완료: Manual Video 프로젝트가 열렸습니다.",
    authMode,
    ...(authMode === "automatic" ? { credentialId } : {}),
  });
}

export async function runLiveSmoke({ env = process.env } = {}) {
  const baseUrl = safeBaseUrl(env.MANUAL_STUDIO_BASE_URL ?? DEFAULT_BASE_URL);
  const timeoutMs = Number(env.MANUAL_STUDIO_SMOKE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 60 * 60 * 1_000) {
    smokeError("SMOKE_TIMEOUT_INVALID", "MANUAL_STUDIO_SMOKE_TIMEOUT_MS is invalid.");
  }

  const operation = new AbortController();
  const interrupt = () => operation.abort();
  process.once("SIGINT", interrupt);
  let jobId = null;
  try {
    const health = await requestJson(baseUrl, "/api/health", { signal: operation.signal });
    if (health?.ready !== true) smokeError("SMOKE_RUNTIME_NOT_READY", "The studio doctor is not ready.");
    const request = buildSmokeRequest(env, baseUrl);
    const created = await requestJson(baseUrl, "/api/jobs", {
      method: "POST",
      body: request,
      signal: operation.signal,
    });
    jobId = safeJobId(created.id);
    process.stdout.write(`Live smoke job created: ${jobId}\n`);

    let planEvent = await waitForEvent(
      baseUrl,
      jobId,
      new Set(["AUTH_REQUIRED", "PLAN_READY"]),
      timeoutMs,
      operation.signal,
    );
    if (planEvent.event === "AUTH_REQUIRED") {
      process.stdout.write("Manual login is awaiting confirmation in the controlled browser.\n");
      await waitForManualConfirmation(operation.signal);
      await requestJson(baseUrl, `/api/jobs/${encodeURIComponent(jobId)}/login/manual/confirm`, {
        method: "POST",
        body: {},
        signal: operation.signal,
      });
      planEvent = await waitForEvent(
        baseUrl,
        jobId,
        new Set(["PLAN_READY"]),
        timeoutMs,
        operation.signal,
      );
    }

    const planDigest = digestFrom(planEvent, "planDigest");
    await requestJson(baseUrl, `/api/jobs/${encodeURIComponent(jobId)}/plan/approve`, {
      method: "POST",
      body: { planDigest },
      signal: operation.signal,
    });
    await requestJson(baseUrl, `/api/jobs/${encodeURIComponent(jobId)}/execute`, {
      method: "POST",
      body: { planDigest },
      signal: operation.signal,
    });

    const previewEvent = await waitForEvent(
      baseUrl,
      jobId,
      new Set(["COMPOSITION_COMPLETED"]),
      timeoutMs,
      operation.signal,
    );
    const previewDigest = digestFrom(previewEvent, "previewDigest");
    await requestJson(baseUrl, `/api/jobs/${encodeURIComponent(jobId)}/preview/approve`, {
      method: "POST",
      body: { previewDigest },
      signal: operation.signal,
    });
    const completed = await waitForEvent(
      baseUrl,
      jobId,
      new Set(["RENDER_COMPLETED"]),
      timeoutMs,
      operation.signal,
    );
    process.stdout.write(`Live smoke completed: ${jobId}\n`);
    return Object.freeze({ jobId, event: completed.event, state: completed.state });
  } catch (error) {
    if (jobId !== null) await cancelSmokeJob(baseUrl, jobId);
    if (operation.signal.aborted && error?.code !== "SMOKE_INTERRUPTED") {
      smokeError("SMOKE_INTERRUPTED", "The live smoke was interrupted.");
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  if (process.env.MANUAL_STUDIO_LIVE_SMOKE !== "1") {
    process.stdout.write("Live smoke skipped. Set MANUAL_STUDIO_LIVE_SMOKE=1 to run the real API workflow.\n");
  } else {
    try {
      await runLiveSmoke();
    } catch (error) {
      const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
        ? error.code
        : "SMOKE_FAILED";
      process.stderr.write(`Manual Video Studio live smoke failed: ${code}\n`);
      process.exitCode = 1;
    }
  }
}
