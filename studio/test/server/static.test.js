import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { startStudio } from "../../src/index.js";

import {
  FIXTURE_PASSWORD,
  FIXTURE_USERNAME,
  sessionCookie,
  startTestStudio,
} from "../fixtures/login-site.js";

test("the static shell exposes landmarks, an application root, and module assets", async (t) => {
  const { baseUrl } = await startTestStudio(t);

  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await response.text();
  assert.match(html, /<header\b/u);
  assert.match(html, /<main\b[^>]*id="app"/u);
  assert.match(html, /<footer\b/u);
  assert.match(html, /<script\b[^>]*type="module"[^>]*src="\/app\.js"/u);
  assert.match(html, /<link\b[^>]*href="\/styles\.css"/u);

  const script = await fetch(`${baseUrl}/app.js`);
  assert.equal(script.status, 200);
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");

  const styles = await fetch(`${baseUrl}/styles.css`);
  assert.equal(styles.status, 200);
  assert.equal(styles.headers.get("content-type"), "text/css; charset=utf-8");
});

test("static routes support HEAD but reject traversal and unlisted files", async (t) => {
  const { baseUrl } = await startTestStudio(t);

  const head = await fetch(`${baseUrl}/app.js`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("content-length")) > 0, true);
  assert.equal(await head.text(), "");

  for (const path of ["/%2e%2e%2fpackage.json", "/..%5cpackage.json", "/package.json"] ) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "ROUTE_NOT_FOUND");
  }
});

test("static serving rejects a configured public-root symlink", async (t) => {
  const root = join(process.cwd(), `.tmp-static-${process.pid}-${Date.now()}`);
  const outside = join(root, "outside");
  const publicLink = join(root, "public-link");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "index.html"), "outside-secret", "utf8");
  await symlink(outside, publicLink, "junction");
  const { baseUrl } = await startTestStudio(t, { publicRoot: publicLink });
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { force: true, recursive: true });
  });

  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "UNSAFE_STATIC_ROOT");
});

test("fixture login page has deterministic accessible controls", async (t) => {
  const { baseUrl } = await startTestStudio(t);

  const response = await fetch(`${baseUrl}/fixture/login`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await response.text();
  assert.match(html, /<main\b/u);
  assert.match(html, /<label\b[^>]*for="fixture-username"[^>]*>사용자 이름<\/label>/u);
  assert.match(html, /<input\b[^>]*id="fixture-username"[^>]*name="username"[^>]*autocomplete="username"/u);
  assert.match(html, /<label\b[^>]*for="fixture-password"[^>]*>비밀번호<\/label>/u);
  assert.match(html, /<input\b[^>]*id="fixture-password"[^>]*name="password"[^>]*type="password"/u);
  assert.match(html, /<input\b[^>]*type="hidden"[^>]*name="_csrf"[^>]*value="[A-Za-z0-9_-]{43}"/u);
  assert.match(html, /<button\b[^>]*type="submit"[^>]*>로그인<\/button>/u);
});

async function login(baseUrl, username = FIXTURE_USERNAME, password = FIXTURE_PASSWORD) {
  const loginPage = await fetch(`${baseUrl}/fixture/login`);
  const html = await loginPage.text();
  const csrfToken = /<input\b[^>]*name="_csrf"[^>]*value="([A-Za-z0-9_-]{43})"/u.exec(html)?.[1];
  assert.equal(typeof csrfToken, "string");
  return fetch(`${baseUrl}/fixture/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "null",
    },
    body: new URLSearchParams({ _csrf: csrfToken, username, password }),
  });
}

test("fixture opaque-origin login requires a fresh same-page CSRF token", async (t) => {
  const { baseUrl } = await startTestStudio(t);
  for (const token of [undefined, "A".repeat(43)]) {
    const body = new URLSearchParams({
      ...(token ? { _csrf: token } : {}),
      username: FIXTURE_USERNAME,
      password: FIXTURE_PASSWORD,
    });
    const response = await fetch(`${baseUrl}/fixture/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "null",
      },
      body,
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "CROSS_ORIGIN_REQUEST");
  }

  const accepted = await login(baseUrl);
  assert.equal(accepted.status, 303);
});

test("fixture rejects incorrect credentials without creating a session", async (t) => {
  const { baseUrl } = await startTestStudio(t);

  const response = await login(baseUrl, FIXTURE_USERNAME, "incorrect");
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("set-cookie"), null);
  const html = await response.text();
  assert.match(html, /role="alert"/u);
  assert.match(html, /사용자 이름 또는 비밀번호가 올바르지 않습니다\./u);
  assert.doesNotMatch(html, /incorrect|manual-video-demo/u);
});

test("fixture creates a protected session with a constrained cookie", async (t) => {
  const { baseUrl } = await startTestStudio(t);

  const protectedResponse = await fetch(`${baseUrl}/fixture/dashboard`, { redirect: "manual" });
  assert.equal(protectedResponse.status, 303);
  assert.equal(protectedResponse.headers.get("location"), "/fixture/login");

  const response = await login(baseUrl);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/fixture/dashboard");
  const setCookie = response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^manual_fixture_session=[A-Za-z0-9_-]{32,};/u);
  assert.match(setCookie, /HttpOnly/iu);
  assert.match(setCookie, /SameSite=Strict/iu);
  assert.match(setCookie, /Path=\/fixture/iu);

  const dashboard = await fetch(`${baseUrl}/fixture/dashboard`, {
    headers: { cookie: sessionCookie(response) },
  });
  assert.equal(dashboard.status, 200);
  const html = await dashboard.text();
  assert.match(html, /<nav\b[^>]*aria-label="데모 메뉴"/u);
  assert.match(html, /href="\/fixture\/dashboard\/projects"[^>]*>프로젝트 메뉴 열기<\/a>/u);
  assert.match(html, /<button\b[^>]*type="submit"[^>]*>로그아웃<\/button>/u);
});

test("fixture sessions are bounded and evict the oldest authenticated session", async (t) => {
  const { baseUrl } = await startTestStudio(t);
  const cookies = [];
  for (let index = 0; index < 129; index += 1) {
    const response = await login(baseUrl);
    assert.equal(response.status, 303);
    cookies.push(sessionCookie(response));
  }

  const oldest = await fetch(`${baseUrl}/fixture/dashboard`, {
    redirect: "manual",
    headers: { cookie: cookies[0] },
  });
  assert.equal(oldest.status, 303);
  assert.equal(oldest.headers.get("location"), "/fixture/login");

  const newest = await fetch(`${baseUrl}/fixture/dashboard`, {
    redirect: "manual",
    headers: { cookie: cookies.at(-1) },
  });
  assert.equal(newest.status, 200);
});

test("fixture menu exposes two deterministic steps and a completion marker", async (t) => {
  const { baseUrl } = await startTestStudio(t);
  const auth = await login(baseUrl);
  const cookie = sessionCookie(auth);

  const projects = await fetch(`${baseUrl}/fixture/dashboard/projects`, {
    headers: { cookie },
  });
  assert.equal(projects.status, 200);
  const projectsHtml = await projects.text();
  assert.match(projectsHtml, /data-fixture-step="1"/u);
  assert.match(projectsHtml, /href="\/fixture\/dashboard\/projects\/manual-video"[^>]*>Manual Video 프로젝트 선택<\/a>/u);

  const completed = await fetch(`${baseUrl}/fixture/dashboard/projects/manual-video`, {
    headers: { cookie },
  });
  assert.equal(completed.status, 200);
  const completedHtml = await completed.text();
  assert.match(completedHtml, /data-fixture-step="2"/u);
  assert.match(completedHtml, /data-fixture-complete="true"/u);
  assert.match(completedHtml, /완료: Manual Video 프로젝트가 열렸습니다\./u);
});

test("fixture logout invalidates the session and expires its cookie", async (t) => {
  const { baseUrl } = await startTestStudio(t);
  const auth = await login(baseUrl);
  const cookie = sessionCookie(auth);

  const logout = await fetch(`${baseUrl}/fixture/logout`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie },
  });
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get("location"), "/fixture/login");
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/iu);

  const dashboard = await fetch(`${baseUrl}/fixture/dashboard`, {
    redirect: "manual",
    headers: { cookie },
  });
  assert.equal(dashboard.status, 303);
  assert.equal(dashboard.headers.get("location"), "/fixture/login");
});

test("fixture endpoints reject unsupported methods as structured errors", async (t) => {
  const { baseUrl } = await startTestStudio(t);
  const response = await fetch(`${baseUrl}/fixture/dashboard`, { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
  assert.equal((await response.json()).error.code, "METHOD_NOT_ALLOWED");
});

test("startStudio closes promptly while an SSE client is connected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "manual-studio-shutdown-"));
  const publicRoot = join(root, "public");
  await mkdir(publicRoot);
  await Promise.all([
    writeFile(join(publicRoot, "index.html"), "<!doctype html><main id=\"app\"></main>", "utf8"),
    writeFile(join(publicRoot, "app.js"), "", "utf8"),
    writeFile(join(publicRoot, "styles.css"), "", "utf8"),
  ]);
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const studio = await startStudio({
    root,
    env: { MANUAL_STUDIO_PORT: String(port) },
    healthCheck: async () => ({ ready: true, checks: {} }),
  });
  t.after(async () => {
    studio.app.closeAllConnections();
    await studio.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const created = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      targetUrl: `${baseUrl}/fixture/login`,
      prompt: "종료 테스트",
      authMode: "manual",
    }),
  }).then((response) => response.json());
  const stream = await fetch(`${baseUrl}/api/jobs/${created.id}/events`);
  assert.equal(stream.status, 200);

  const closePromise = studio.close();
  const closedPromptly = await Promise.race([
    closePromise.then(() => true),
    delay(200, false),
  ]);
  if (!closedPromptly) {
    studio.app.closeAllConnections();
  }
  await closePromise;
  assert.equal(closedPromptly, true);
});

test("an SSE source-side close terminates the HTTP stream so clients can reconnect", async (t) => {
  let subscriptionClosed = false;
  const eventBus = {
    subscribe() {
      return {
        ready: new Promise(() => {}),
        closing: Promise.resolve({ reason: "backpressure" }),
        closed: new Promise(() => {}),
        close() {
          subscriptionClosed = true;
        },
      };
    },
  };
  const { baseUrl } = await startTestStudio(t, {
    eventBus,
    randomId: () => "job-sse-source-close",
  });
  await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      targetUrl: `${baseUrl}/fixture/login`,
      prompt: "SSE 종료 테스트",
      authMode: "manual",
    }),
  });

  const response = await fetch(`${baseUrl}/api/jobs/job-sse-source-close/events`);
  assert.equal(response.status, 200);
  const completed = await Promise.race([
    response.text().then(
      (body) => ({ body, settled: true }),
      () => ({ body: "", settled: true }),
    ),
    delay(200, { body: "", settled: false }),
  ]);
  assert.equal(completed.settled, true);
  assert.equal(subscriptionClosed, true);
});
