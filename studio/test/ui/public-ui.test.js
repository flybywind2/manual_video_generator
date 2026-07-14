import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const publicRoot = join(here, "..", "..", "public");

async function source(name) {
  return readFile(join(publicRoot, name), "utf8");
}

test("the first viewport exposes the AI Center Manual Video Studio creation flow", async () => {
  const html = await source("index.html");

  assert.match(html, /AI Center/u);
  assert.match(html, /Manual Video Studio/u);
  assert.match(html, /id="job-form"/u);
  assert.match(html, /id="target-url"[^>]*type="url"/u);
  assert.match(html, /id="prompt"/u);
  assert.match(html, /id="completion-condition"/u);
  assert.match(html, /name="auth-mode"/u);
  assert.match(html, /id="credential-id"/u);
  assert.match(html, /aria-live="polite"/u);
  assert.match(html, /id="workflow"/u);
});

test("the workflow surface includes every review gate and final artifact action", async () => {
  const html = await source("index.html");

  for (const id of [
    "manual-login-panel",
    "plan-panel",
    "execution-panel",
    "preview-panel",
    "completed-panel",
    "confirm-login-button",
    "approve-plan-button",
    "execute-button",
    "approve-preview-button",
    "download-video-link",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(html, /<video[^>]*id="preview-player"/u);
  assert.match(html, /<ol[^>]*id="workflow-steps"/u);
});

test("automatic login exposes an ephemeral credential save surface", async () => {
  const html = await source("index.html");

  assert.match(html, /id="new-credential-id"/u);
  assert.match(html, /id="credential-username"[^>]*autocomplete="username"/u);
  assert.match(html, /id="credential-secret"[^>]*type="password"/u);
  assert.match(html, /id="save-credential-button"/u);
  assert.match(html, /id="credential-save-status"[^>]*role="status"/u);
});

test("preview review exposes an accessible digest-bound scene editor", async () => {
  const [html, javascript] = await Promise.all([source("index.html"), source("app.js")]);

  assert.match(html, /<form[^>]*id="media-edit-form"/u);
  assert.match(html, /id="media-scene-id"/u);
  assert.match(html, /id="media-narration-text"/u);
  assert.match(html, /id="media-caption-text"/u);
  assert.match(html, /id="save-media-edit-button"[^>]*disabled/u);
  assert.match(html, /원본 브라우저 녹화[^<]*보존/u);
  assert.match(html, /id="media-edit-status"[^>]*role="status"/u);
  assert.match(javascript, /mediaEditForm\.addEventListener\("submit"/u);
  assert.match(javascript, /api\.editMedia\(memory\.jobId/u);
  const previewUpdate = javascript.slice(
    javascript.indexOf("if (payload.previewDigest"),
    javascript.indexOf("if (payload.outputArtifact"),
  );
  assert.match(previewUpdate, /syncMediaEditAvailability\(\)/u);
});

test("the visual contract uses the AI Center light enterprise tokens accessibly", async () => {
  const css = await source("styles.css");

  for (const token of ["#F7F9FC", "#245BFF", "#7C3AED", "#21D4FD", "#D8E0EC", "#07111F"]) {
    assert.match(css, new RegExp(token, "iu"));
  }
  assert.match(css, /--control-radius:\s*6px/u);
  assert.match(css, /--card-radius:\s*8px/u);
  assert.match(css, /min-height:\s*44px/u);
  assert.match(css, /:focus-visible/u);
  assert.match(css, /@media\s*\(max-width:\s*767px\)/u);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
  assert.match(css, /\.preview-stage[^}]*#07111F/su);
});

test("the browser module never persists or logs credentials", async () => {
  const javascript = await source("app.js");

  assert.doesNotMatch(javascript, /localStorage|sessionStorage|console\s*\./u);
  assert.doesNotMatch(javascript, /passphrase|authorization/u);
  assert.doesNotMatch(javascript, /memory\s*=\s*\{[^}]*username|memory\s*=\s*\{[^}]*password/su);
});

test("the API client isolates every workflow endpoint and JSON request", async () => {
  const { createStudioApi } = await import("../../public/app.js");
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const api = createStudioApi({ fetchImpl, EventSourceImpl: class {} });
  const plan = { schemaVersion: "1.1", steps: [] };
  const digest = "a".repeat(64);

  await api.createJob({
    targetUrl: "https://example.test",
    prompt: "안내",
    completionCondition: "완료 화면이 보이면 끝",
    authMode: "manual",
    voice: "F1",
  });
  await api.getJob("job-1");
  await api.confirmManualLogin("job-1");
  await api.updatePlan("job-1", plan, digest);
  await api.approvePlan("job-1", digest);
  await api.execute("job-1", digest);
  await api.editMedia("job-1", {
    previewDigest: "b".repeat(64),
    sceneId: "step-01",
    captionText: "새 캡션",
  }, digest);
  await api.approvePreview("job-1", digest);
  await api.cancel("job-1");
  await api.saveCredential("team-login", { username: "operator", password: "one-use-value" });

  assert.deepEqual(calls.map(({ url, init }) => [url, init.method ?? "GET"]), [
    ["/api/jobs", "POST"],
    ["/api/jobs/job-1", "GET"],
    ["/api/jobs/job-1/login/manual/confirm", "POST"],
    ["/api/jobs/job-1/plan", "PUT"],
    ["/api/jobs/job-1/plan/approve", "POST"],
    ["/api/jobs/job-1/execute", "POST"],
    ["/api/jobs/job-1/media-plan", "PUT"],
    ["/api/jobs/job-1/preview/approve", "POST"],
    ["/api/jobs/job-1/cancel", "POST"],
    ["/api/credentials/team-login", "PUT"],
  ]);
  assert.deepEqual(JSON.parse(calls[3].init.body), { plan, planDigest: digest });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    targetUrl: "https://example.test",
    prompt: "안내",
    completionCondition: "완료 화면이 보이면 끝",
    authMode: "manual",
    voice: "F1",
  });
  assert.deepEqual(JSON.parse(calls[6].init.body), {
    previewDigest: digest,
    sceneId: "step-01",
    captionText: "새 캡션",
  });
  assert.equal(calls[2].init.body, undefined);
  assert.equal(calls[8].init.body, undefined);
  assert.deepEqual(JSON.parse(calls[9].init.body), {
    username: "operator",
    password: "one-use-value",
  });
});

test("workflow event payloads are read only from exact digest-bound contracts", async () => {
  const { readWorkflowEvent } = await import("../../public/app.js");
  const plan = { schemaVersion: "1.1", steps: [] };
  const planDigest = "a".repeat(64);
  const previewDigest = "b".repeat(64);

  assert.deepEqual(readWorkflowEvent({
    event: "APPROVE_PLAN",
    data: { plan, planDigest },
  }), { plan, planDigest });
  assert.deepEqual(readWorkflowEvent({
    event: "COMPOSITION_COMPLETED",
    data: {
      preview: {
        planDigest,
        previewDigest,
        mediaPlan: { schemaVersion: "1.0" },
        previewArtifact: "preview/manual.mp4",
        captionsArtifact: "preview/captions.vtt",
      },
      previewDigest: "c".repeat(64),
      previewArtifact: "ignored.mp4",
    },
  }), {
    previewDigest,
    previewArtifact: "preview/manual.mp4",
  });
  assert.deepEqual(readWorkflowEvent({
    event: "RENDER_COMPLETED",
    data: { outputArtifact: "video/final.mp4" },
  }), { outputArtifact: "video/final.mp4" });

  assert.deepEqual(readWorkflowEvent({
    event: "COMPOSITION_COMPLETED",
    data: { preview: { previewDigest: "not-a-digest", previewArtifact: "../escape.mp4" } },
  }), {});
  assert.deepEqual(readWorkflowEvent({
    event: "RENDER_COMPLETED",
    data: { outputArtifact: "https://attacker.invalid/final.mp4" },
  }), {});
});

test("reload recovery accepts only a bounded job id from the current URL", async () => {
  const { jobIdFromLocation, jobUrl } = await import("../../public/app.js");

  assert.equal(jobIdFromLocation({ href: "http://127.0.0.1:4317/?job=job-safe_42" }), "job-safe_42");
  assert.equal(jobIdFromLocation({ href: "http://127.0.0.1:4317/?job=../escape" }), null);
  assert.equal(jobIdFromLocation({ href: "not a URL" }), null);
  assert.equal(jobUrl({ href: "http://127.0.0.1:4317/?view=studio#start" }, "job-safe_42"), "/?view=studio&job=job-safe_42#start");
  assert.equal(jobUrl({ href: "http://127.0.0.1:4317/?view=studio&job=old" }, null), "/?view=studio");
});

test("SSE replay restores payloads without allowing old or duplicate states to regress the UI", async () => {
  const { createWorkflowCursor, responseSnapshot } = await import("../../public/app.js");
  const cursor = createWorkflowCursor(5);

  assert.deepEqual(cursor.accept({ sequence: 2 }), { processPayload: true, renderState: false });
  assert.deepEqual(cursor.accept({ sequence: 2 }), { processPayload: false, renderState: false });
  assert.deepEqual(cursor.accept({ sequence: 5 }), { processPayload: true, renderState: true });
  assert.deepEqual(cursor.accept({ sequence: 6 }), { processPayload: true, renderState: true });
  assert.deepEqual(cursor.accept({ sequence: 4 }), { processPayload: false, renderState: false });
  assert.equal(cursor.acceptSnapshot(5), false);
  assert.equal(cursor.acceptSnapshot(7), true);
  assert.equal(cursor.acceptSnapshot(6), false);

  assert.equal(responseSnapshot({ accepted: true, jobId: "job-1", operation: "execute" }), null);
  assert.deepEqual(responseSnapshot({
    job: { id: "job-1", state: "approved", eventSequence: 7 },
  }), { id: "job-1", state: "approved", eventSequence: 7 });
});

test("credential fields are erased synchronously after the request body is created", async () => {
  const { sendTransientCredential } = await import("../../public/app.js");
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const observed = [];
  const fields = {
    id: { value: "team-login" },
    username: { value: "operator" },
    secret: { value: "one-use-value" },
  };
  const api = {
    saveCredential(id, values) {
      observed.push([id, { ...values }]);
      return pending;
    },
  };

  const saving = sendTransientCredential(api, fields);
  assert.equal(fields.username.value, "");
  assert.equal(fields.secret.value, "");
  assert.deepEqual(observed, [["team-login", {
    username: "operator",
    password: "one-use-value",
  }]]);
  release({ saved: true });
  await saving;
});

test("media edit fields require a current preview and at least one changed text value", async () => {
  const { mediaEditRequest } = await import("../../public/app.js");
  const digest = "a".repeat(64);
  const fields = {
    sceneId: { value: " step-01 " },
    narration: { value: "  새 내레이션  " },
    caption: { value: " " },
  };

  assert.equal(mediaEditRequest(fields, null), null);
  assert.deepEqual(mediaEditRequest(fields, digest), {
    previewDigest: digest,
    edit: { sceneId: "step-01", narrationText: "새 내레이션" },
  });
  fields.narration.value = " ";
  assert.equal(mediaEditRequest(fields, digest), null);
  fields.caption.value = "  새 자막  ";
  assert.deepEqual(mediaEditRequest(fields, digest), {
    previewDigest: digest,
    edit: { sceneId: "step-01", captionText: "새 자막" },
  });
});

test("the API client converts non-success responses into safe user-facing errors", async () => {
  const { createStudioApi } = await import("../../public/app.js");
  const api = createStudioApi({
    fetchImpl: async () => new Response(JSON.stringify({
      error: { code: "INVALID_JOB_REQUEST", message: "unsafe detail is ignored" },
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
    EventSourceImpl: class {},
  });

  await assert.rejects(api.getJob("job-1"), (error) => {
    assert.equal(error.name, "StudioApiError");
    assert.equal(error.code, "INVALID_JOB_REQUEST");
    assert.equal(error.status, 400);
    assert.doesNotMatch(error.message, /unsafe detail/u);
    return true;
  });
});

test("the API client subscribes to named SSE workflow events without persisting state", async () => {
  const { createStudioApi } = await import("../../public/app.js");
  const sources = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
      sources.push(this);
    }

    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }

    close() {
      this.closed = true;
    }

    emit(name, data) {
      this.listeners.get(name)?.({ data: JSON.stringify(data) });
    }
  }
  const api = createStudioApi({ fetchImpl: async () => new Response(), EventSourceImpl: FakeEventSource });
  const received = [];
  const errors = [];
  const subscription = api.subscribe("job-42", {
    onEvent: (event) => received.push(event),
    onError: (error) => errors.push(error),
  });

  assert.equal(sources[0].url, "/api/jobs/job-42/events");
  sources[0].emit("AUTH_REQUIRED", { sequence: 3, event: "AUTH_REQUIRED", state: "awaiting_manual_login" });
  sources[0].emit("PLAN_READY", { sequence: 5, event: "PLAN_READY", state: "plan_review" });
  assert.deepEqual(received.map(({ state }) => state), ["awaiting_manual_login", "plan_review"]);
  assert.deepEqual(errors, []);

  subscription.close();
  assert.equal(sources[0].closed, true);
});
