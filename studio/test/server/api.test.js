import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import test from "node:test";

import { startTestStudio } from "../fixtures/login-site.js";

const CREATED_AT = "2026-07-14T01:02:03.000Z";

function validRequest(overrides = {}) {
  return {
    targetUrl: "http://127.0.0.1:4317/fixture/login",
    prompt: "프로젝트 메뉴에서 Manual Video 프로젝트를 여는 방법을 알려 주세요.",
    authMode: "manual",
    ...overrides,
  };
}

async function json(response) {
  assert.match(response.headers.get("content-type") ?? "", /^application\/json; charset=utf-8$/u);
  return response.json();
}

async function createJob(baseUrl, body = validRequest()) {
  return fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function rawRequest(baseUrl, path, { body = "", headers = {}, method = "GET" } = {}) {
  const target = new URL(baseUrl);
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: target.hostname,
      port: Number(target.port),
      path,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: response.headers,
        status: response.statusCode,
      }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

test("GET /api/health returns only safe readiness fields", async (t) => {
  const { baseUrl } = await startTestStudio(t);

  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await json(response), {
    ready: true,
    checks: {
      node: { status: "ready", expected: ">=22", actual: "24.13.1" },
    },
  });
});

test("the loopback service rejects DNS rebinding and cross-origin requests before routing", async (t) => {
  const { baseUrl, store } = await startTestStudio(t, {
    randomId: () => "job-must-not-exist",
  });
  const port = new URL(baseUrl).port;

  const rebound = await rawRequest(baseUrl, "/api/health", {
    headers: { Host: `attacker.example:${port}` },
  });
  assert.equal(rebound.status, 421);
  assert.equal(JSON.parse(rebound.body).error.code, "MISDIRECTED_REQUEST");

  const absoluteForm = await rawRequest(baseUrl, "http://attacker.example/api/health", {
    headers: { Host: `127.0.0.1:${port}` },
  });
  assert.equal(absoluteForm.status, 421);
  assert.equal(JSON.parse(absoluteForm.body).error.code, "MISDIRECTED_REQUEST");

  const requestBody = JSON.stringify(validRequest());
  const crossOrigin = await rawRequest(baseUrl, "/api/jobs", {
    method: "POST",
    headers: {
      "Content-Length": Buffer.byteLength(requestBody),
      "Content-Type": "application/json",
      Host: `127.0.0.1:${port}`,
      Origin: "https://attacker.example",
      "Sec-Fetch-Site": "cross-site",
    },
    body: requestBody,
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(JSON.parse(crossOrigin.body).error.code, "CROSS_ORIGIN_REQUEST");
  assert.deepEqual(await store.list(), []);
});

test("POST /api/jobs validates and persists a normalized public request", async (t) => {
  const { baseUrl, store } = await startTestStudio(t, {
    now: () => CREATED_AT,
    randomId: () => "job-http-create",
  });

  const response = await createJob(baseUrl, validRequest({
    targetUrl: "HTTP://127.0.0.1:4317/fixture/login",
    prompt: "  프로젝트 메뉴를 여는 방법  ",
  }));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("location"), "/api/jobs/job-http-create");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await json(response);
  assert.deepEqual(body, {
    id: "job-http-create",
    state: "created",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    eventSequence: 1,
    request: {
      targetUrl: "http://127.0.0.1:4317/fixture/login",
      prompt: "프로젝트 메뉴를 여는 방법",
      completionCondition: "요청한 최종 화면이 보이면 완료",
      authMode: "manual",
      voice: "F1",
    },
  });
  assert.deepEqual(await store.load("job-http-create"), body);
});

test("POST /api/jobs accepts an opaque credential reference but never raw credentials", async (t) => {
  const { baseUrl } = await startTestStudio(t, {
    randomId: () => "job-automatic",
  });

  const accepted = await createJob(baseUrl, validRequest({
    authMode: "automatic",
    credentialId: "fixture-login",
  }));
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).request.credentialId, "fixture-login");

  const rejected = await createJob(baseUrl, validRequest({
    username: "demo",
    password: "manual-video-demo",
  }));
  assert.equal(rejected.status, 400);
  const body = await json(rejected);
  assert.equal(body.error.code, "INVALID_JOB_REQUEST");
  assert.doesNotMatch(JSON.stringify(body), /manual-video-demo|demo/u);
});

test("POST /api/jobs rejects invalid URLs, prompts, auth modes, and credential references", async (t) => {
  const invalidCases = [
    validRequest({ targetUrl: "file:///C:/secret.txt" }),
    validRequest({ targetUrl: "https://user:pass@example.test/" }),
    validRequest({ targetUrl: "not a URL" }),
    validRequest({ prompt: "   " }),
    validRequest({ prompt: "x".repeat(10_001) }),
    validRequest({ authMode: "password" }),
    validRequest({ authMode: "automatic" }),
    validRequest({ authMode: "manual", credentialId: "unexpected" }),
    validRequest({ authMode: "automatic", credentialId: "../secret" }),
    validRequest({ completionCondition: "x".repeat(2_001) }),
    validRequest({ voice: "custom-clone" }),
  ];

  for (const [index, request] of invalidCases.entries()) {
    await t.test(String(index), async (t) => {
      const { baseUrl } = await startTestStudio(t);
      const response = await createJob(baseUrl, request);
      assert.equal(response.status, 400);
      assert.equal((await json(response)).error.code, "INVALID_JOB_REQUEST");
    });
  }
});

test("JSON endpoints enforce media type, syntax, and a bounded body", async (t) => {
  const { baseUrl } = await startTestStudio(t, { maxJsonBytes: 128 });

  const wrongType = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);
  assert.equal((await json(wrongType)).error.code, "UNSUPPORTED_MEDIA_TYPE");

  const malformed = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await json(malformed)).error.code, "INVALID_JSON");

  const oversized = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validRequest({ prompt: "x".repeat(500) })),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await json(oversized)).error.code, "REQUEST_BODY_TOO_LARGE");
});

test("GET /api/jobs/:id returns a public snapshot and maps a missing job safely", async (t) => {
  const { baseUrl } = await startTestStudio(t, {
    randomId: () => "job-public-read",
  });
  await createJob(baseUrl);

  const response = await fetch(`${baseUrl}/api/jobs/job-public-read`);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.id, "job-public-read");
  assert.deepEqual(Object.keys(body.request), [
    "targetUrl",
    "prompt",
    "completionCondition",
    "authMode",
    "voice",
  ]);

  const missing = await fetch(`${baseUrl}/api/jobs/job-missing`);
  assert.equal(missing.status, 404);
  const missingBody = await json(missing);
  assert.equal(missingBody.error.code, "JOB_NOT_FOUND");
  assert.equal(missingBody.error.stage, "storage");
  assert.equal(missingBody.error.retryable, false);
});

test("GET /api/jobs/:id/events replays SSE sequence IDs after Last-Event-ID", async (t) => {
  const { baseUrl, store } = await startTestStudio(t, {
    randomId: () => "job-sse-replay",
  });
  await createJob(baseUrl);
  await store.transition("job-sse-replay", "START_AUTHENTICATION", { authMode: "manual" });
  await store.transition("job-sse-replay", "AUTH_REQUIRED", {});

  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/jobs/job-sse-replay/events`, {
    headers: { "last-event-id": "1" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("id: 3\n")) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    text += decoder.decode(value, { stream: true });
  }
  controller.abort();
  assert.doesNotMatch(text, /id: 1\n/u);
  assert.match(text, /id: 2\nevent: START_AUTHENTICATION\ndata: \{.*"sequence":2.*\}\n\n/u);
  assert.match(text, /id: 3\nevent: AUTH_REQUIRED\ndata: \{.*"sequence":3.*\}\n\n/u);
});

test("SSE validates Last-Event-ID and a missing job before opening the stream", async (t) => {
  const { baseUrl } = await startTestStudio(t);

  const invalid = await fetch(`${baseUrl}/api/jobs/job-missing/events`, {
    headers: { "last-event-id": "-1" },
  });
  assert.equal(invalid.status, 400);
  assert.equal((await json(invalid)).error.code, "INVALID_EVENT_SEQUENCE");

  const missing = await fetch(`${baseUrl}/api/jobs/job-missing/events`);
  assert.equal(missing.status, 404);
  assert.equal((await json(missing)).error.code, "JOB_NOT_FOUND");
});

async function prepareArtifactJob(t, name = "video/final.mp4") {
  const context = await startTestStudio(t, {
    randomId: () => "job-artifact",
  });
  await createJob(context.baseUrl);
  const artifacts = join(context.jobsRoot, "job-artifact", "artifacts");
  await mkdir(join(artifacts, "video"), { recursive: true });
  await writeFile(join(artifacts, "video", "final.mp4"), Buffer.from("0123456789"));
  await writeFile(join(artifacts, "private.txt"), "not listed", "utf8");
  await writeFile(
    join(artifacts, "manifest.json"),
    `${JSON.stringify({ files: [name] })}\n`,
    "utf8",
  );
  return { ...context, artifacts };
}

test("artifact GET serves only a manifest-listed regular file", async (t) => {
  const { baseUrl } = await prepareArtifactJob(t);

  const response = await fetch(`${baseUrl}/api/jobs/job-artifact/artifacts/video/final.mp4`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-length"), "10");
  assert.equal(await response.text(), "0123456789");

  const unlisted = await fetch(`${baseUrl}/api/jobs/job-artifact/artifacts/private.txt`);
  assert.equal(unlisted.status, 404);
  assert.equal((await json(unlisted)).error.code, "ARTIFACT_NOT_FOUND");
});

test("HTML artifacts can be downloaded but never execute in the studio origin", async (t) => {
  const { baseUrl, artifacts } = await prepareArtifactJob(t, "preview.html");
  await writeFile(join(artifacts, "preview.html"), "<script>globalThis.pwned = true</script>", "utf8");

  const response = await fetch(`${baseUrl}/api/jobs/job-artifact/artifacts/preview.html`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("content-disposition"), "attachment; filename=\"artifact.html\"");
  assert.equal(response.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  assert.match(await response.text(), /globalThis\.pwned/u);
});

test("artifact GET supports single closed, open, and suffix byte ranges", async (t) => {
  const { baseUrl } = await prepareArtifactJob(t);
  const url = `${baseUrl}/api/jobs/job-artifact/artifacts/video/final.mp4`;
  const cases = [
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
  ];

  for (const [range, expected, contentRange] of cases) {
    const response = await fetch(url, { headers: { range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), contentRange);
    assert.equal(response.headers.get("content-length"), String(expected.length));
    assert.equal(await response.text(), expected);
  }
});

test("artifact GET returns 416 for malformed, multiple, and unsatisfiable ranges", async (t) => {
  const { baseUrl } = await prepareArtifactJob(t);
  const url = `${baseUrl}/api/jobs/job-artifact/artifacts/video/final.mp4`;

  for (const range of ["items=0-1", "bytes=0-1,3-4", "bytes=20-", "bytes=5-2", "bytes=-0"]) {
    const response = await fetch(url, { headers: { range } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), "bytes */10");
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal((await json(response)).error.code, "RANGE_NOT_SATISFIABLE");
  }
});

test("artifact routing rejects traversal, manifest access, unsafe manifests, and symlinks", async (t) => {
  await t.test("path traversal and manifest", async (t) => {
    const { baseUrl } = await prepareArtifactJob(t);
    for (const path of [
      "..%2Frequest.json",
      "%2e%2e%5crequest.json",
      "manifest.json",
      "video%2F..%2Fprivate.txt",
    ]) {
      const response = await fetch(`${baseUrl}/api/jobs/job-artifact/artifacts/${path}`);
      assert.equal([400, 404].includes(response.status), true);
    }
  });

  await t.test("unsafe manifest entry", async (t) => {
    const { baseUrl } = await prepareArtifactJob(t, "../request.json");
    const response = await fetch(`${baseUrl}/api/jobs/job-artifact/artifacts/video/final.mp4`);
    assert.equal(response.status, 500);
    assert.equal((await json(response)).error.code, "INVALID_ARTIFACT_MANIFEST");
  });

  await t.test("file symlink", async (t) => {
    const { baseUrl, artifacts, temporary } = await prepareArtifactJob(t, "linked.mp4");
    const outside = join(temporary, "outside.mp4");
    await writeFile(outside, "outside-secret", "utf8");
    try {
      await symlink(outside, join(artifacts, "linked.mp4"), "file");
    } catch (error) {
      if (process.platform === "win32" && error?.code === "EPERM") {
        t.skip("Windows file symlinks require Developer Mode or elevation");
        return;
      }
      throw error;
    }
    const response = await fetch(`${baseUrl}/api/jobs/job-artifact/artifacts/linked.mp4`);
    assert.equal(response.status, 404);
    assert.equal((await json(response)).error.code, "ARTIFACT_NOT_FOUND");
  });

  await t.test("directory junction", async (t) => {
    const { baseUrl, artifacts, temporary } = await prepareArtifactJob(t, "linked/final.mp4");
    const outside = join(temporary, "outside-dir");
    await mkdir(outside);
    await writeFile(join(outside, "final.mp4"), "outside-secret", "utf8");
    await symlink(outside, join(artifacts, "linked"), "junction");
    const response = await fetch(`${baseUrl}/api/jobs/job-artifact/artifacts/linked/final.mp4`);
    assert.equal(response.status, 404);
    assert.equal((await json(response)).error.code, "ARTIFACT_NOT_FOUND");
  });
});

test("unsupported methods and unknown routes return structured JSON errors", async (t) => {
  const { baseUrl } = await startTestStudio(t);

  const method = await fetch(`${baseUrl}/api/health`, { method: "POST" });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET");
  assert.equal((await json(method)).error.code, "METHOD_NOT_ALLOWED");

  const unknown = await fetch(`${baseUrl}/api/unknown`);
  assert.equal(unknown.status, 404);
  assert.equal((await json(unknown)).error.code, "ROUTE_NOT_FOUND");
});
