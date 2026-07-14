# OpenCode Manual Video Studio Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a fresh Windows-local web service that converts an approved Korean prompt into a real browser manual video using only OpenCode, Playwright MCP, Supertonic 3, HyperFrames, and FFmpeg as product engines.

**Architecture:** A dependency-light Node coordinator owns HTTP/SSE, file-backed jobs, approval gates, process lifecycle, and media validation. OpenCode is the only reasoning agent and uses Playwright MCP for browser exploration, execution, and recording; Supertonic generates scene WAV files, then FFmpeg and a stable HyperFrames template produce and verify the final MP4.

**Tech Stack:** Node.js 24 ESM with built-in `node:test`, OpenCode 1.4.1, `@playwright/mcp@0.0.78`, Python 3.13.14 with `supertonic[serve]==1.3.1`, `hyperframes@0.7.57`, FFmpeg/FFprobe 8.1.1, vanilla HTML/CSS/JavaScript, Windows PowerShell and DPAPI.

---

## Working Rules

- Work only inside the `codex/manual-video-studio-rebuild` worktree.
- Read `docs/plans/2026-07-14-opencode-manual-video-studio-design.md` before Task 1.
- Use `@superpowers:test-driven-development` for every production behavior: add one failing test, run it and confirm the expected failure, write the minimum implementation, rerun, then refactor while green.
- Use `@superpowers:systematic-debugging` before changing code in response to any unexpected failure.
- Do not import or call anything under `backend/` from new `studio/` code.
- Do not add React, Express, FastAPI, a database, another AI model, another TTS engine, another browser driver, or another renderer.
- Keep OpenCode commands free of `--model`.
- Commit after every task using only that task's files.

## Task 1: Create the isolated Node workspace and preflight contract

**Files:**
- Create: `studio/package.json`
- Create: `studio/src/config.js`
- Create: `studio/src/preflight.js`
- Create: `studio/scripts/doctor.mjs`
- Create: `studio/test/preflight.test.js`
- Create: `studio/.gitignore`

**Step 1: Write the failing preflight tests**

Create `studio/test/preflight.test.js` with tests for version pins, Node 22+, absolute service paths, command discovery, and a safe public status object:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildConfig } from "../src/config.js";
import { inspectRuntime } from "../src/preflight.js";

test("buildConfig pins the five product engines", () => {
  const config = buildConfig({ root: "C:/manual-video/studio" });
  assert.equal(config.versions.playwrightMcp, "0.0.78");
  assert.equal(config.versions.supertonic, "1.3.1");
  assert.equal(config.versions.hyperframes, "0.7.57");
  assert.match(config.paths.jobs, /data[\\/]jobs$/);
});

test("inspectRuntime reports commands without leaking environment values", async () => {
  const report = await inspectRuntime({
    nodeVersion: "24.13.1",
    locate: async (name) => `C:/tools/${name}.exe`,
    version: async (name) => ({ opencode: "1.4.1", ffmpeg: "8.1.1" })[name] ?? "ok",
  });
  assert.equal(report.status, "ready");
  assert.equal(JSON.stringify(report).includes("process.env"), false);
});
```

**Step 2: Run the tests and verify RED**

Run: `cd studio; node --test test/preflight.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/config.js`.

**Step 3: Add the package and minimum configuration**

Create `studio/package.json` as ESM with scripts `test`, `doctor`, `start`, `verify`, and `smoke:live`. Depend only on exact `hyperframes@0.7.57` and `@playwright/mcp@0.0.78`. Invoke both package binaries through `process.execPath` plus their resolved JavaScript entry points so Windows never depends on `.cmd`/`.ps1` shell resolution.

Implement:

```js
export function buildConfig({ root, env = process.env }) {
  return Object.freeze({
    host: "127.0.0.1",
    port: Number(env.MANUAL_STUDIO_PORT ?? 4317),
    root,
    versions: { playwrightMcp: "0.0.78", supertonic: "1.3.1", hyperframes: "0.7.57" },
    paths: {
      jobs: new URL("./data/jobs/", pathToFileURL(`${root}/`)).pathname,
      profile: new URL("./data/browser-profile/", pathToFileURL(`${root}/`)).pathname,
    },
  });
}
```

`inspectRuntime()` must report Node, OpenCode, the exact local Playwright MCP package, Python 3.13, Supertonic, HyperFrames, FFmpeg, and FFprobe independently with `ready`, `missing`, or `mismatch` status.

**Step 4: Ignore generated runtime state**

`studio/.gitignore` must include `node_modules/`, `data/`, `.runtime/`, `*.log`, and generated HyperFrames render directories.

**Step 5: Install and verify GREEN**

Run: `cd studio; npm install`

Run: `node --test test/preflight.test.js`

Expected: both preflight tests PASS and `npm ls hyperframes` reports exactly `0.7.57`.

**Step 6: Commit**

```powershell
git add studio/package.json studio/package-lock.json studio/.gitignore studio/src/config.js studio/src/preflight.js studio/scripts/doctor.mjs studio/test/preflight.test.js
git commit -m "feat: bootstrap manual video studio runtime"
```

## Task 2: Implement the plan contract, safety policy, and state machine

**Files:**
- Create: `studio/src/domain/errors.js`
- Create: `studio/src/domain/state-machine.js`
- Create: `studio/src/domain/plan.js`
- Create: `studio/src/domain/policy.js`
- Create: `studio/test/domain/state-machine.test.js`
- Create: `studio/test/domain/plan.test.js`

**Step 1: Write the failing state tests**

Test valid transitions through `created → authenticating → awaiting_manual_login → planning → plan_review → approved → executing` and assert that `plan_review → narrating` throws `INVALID_TRANSITION`.

```js
assert.equal(transition("plan_review", "APPROVE_PLAN"), "approved");
assert.equal(transition("approved", "START_EXECUTION"), "executing");
assert.throws(() => transition("plan_review", "START_NARRATION"), {
  code: "INVALID_TRANSITION",
});
```

**Step 2: Verify state tests fail**

Run: `cd studio; node --test test/domain/state-machine.test.js`

Expected: FAIL because `state-machine.js` does not exist.

**Step 3: Implement the explicit transition table**

Use a frozen transition map, a `StudioError` carrying `code`, `stage`, `retryable`, and `details`, and no implicit fallback transitions.

**Step 4: Write the failing plan and policy tests**

Cover all of these behaviors:

- rejects unknown top-level and step fields;
- requires an HTTP(S) target and at least one step;
- canonicalizes steps and produces a stable SHA-256 digest;
- rejects digest mismatch on execution;
- allows the approved target origin;
- marks cross-origin navigation and irreversible Korean/English verbs as blocked;
- caps plans at 30 steps.

**Step 5: Verify plan tests fail**

Run: `node --test test/domain/plan.test.js`

Expected: FAIL because the plan API is missing.

**Step 6: Implement the minimum schema and policy**

Expose:

```js
export function validatePlan(candidate) {}
export function canonicalPlan(plan) {}
export function digestPlan(plan) {}
export function assertApprovedPlan(plan, expectedDigest) {}
export function evaluateStepPolicy(step, targetOrigin) {}
```

Only `safe`, `review`, and `blocked` are valid risk values. Block `delete`, `remove`, `send`, `submit`, `publish`, `purchase`, `삭제`, `전송`, `등록`, `구매`, and origin changes unless explicitly represented and re-approved.

**Step 7: Run the focused domain suite**

Run: `node --test test/domain/*.test.js`

Expected: all domain tests PASS.

**Step 8: Commit**

```powershell
git add studio/src/domain studio/test/domain
git commit -m "feat: add approved plan and workflow contracts"
```

## Task 3: Build atomic file-backed jobs, events, and the single-run lock

**Files:**
- Create: `studio/src/jobs/job-store.js`
- Create: `studio/src/jobs/event-bus.js`
- Create: `studio/src/jobs/execution-lock.js`
- Create: `studio/test/jobs/job-store.test.js`
- Create: `studio/test/jobs/execution-lock.test.js`

**Step 1: Write the failing job-store tests**

Use a temporary directory and assert that:

- `create()` writes `request.json`, `job.json`, and `events.jsonl`;
- `transition()` atomically updates state and appends one event;
- `load()` rejects path traversal job IDs;
- a new store instance reconstructs the last state;
- `list()` sorts newest jobs first.

**Step 2: Verify RED**

Run: `cd studio; node --test test/jobs/job-store.test.js`

Expected: FAIL because `JobStore` is missing.

**Step 3: Implement the store**

Write JSON to `<name>.tmp`, flush/close it, then rename. Constrain every resolved path under the configured jobs root. Append events as one compact JSON object per line.

```js
const store = new JobStore({ root, now, randomId });
const job = await store.create(request);
await store.transition(job.id, "AUTH_REQUIRED", { authMode: "manual" });
```

**Step 4: Write and run the failing lock tests**

Assert one active job, one queued job, rejection of a third, FIFO promotion, and cancellation release.

Run: `node --test test/jobs/execution-lock.test.js`

Expected: FAIL because `ExecutionLock` is missing.

**Step 5: Implement the lock and event subscription**

`ExecutionLock.acquire(jobId)` returns `active` or `queued`; a third call throws `QUEUE_FULL`. `EventBus.subscribe(jobId, afterSequence)` replays persisted events before live events so SSE reconnects do not lose progress.

**Step 6: Verify GREEN**

Run: `node --test test/jobs/*.test.js`

Expected: all job tests PASS.

**Step 7: Commit**

```powershell
git add studio/src/jobs studio/test/jobs
git commit -m "feat: persist jobs and serialize browser execution"
```

## Task 4: Protect credentials and redact every process boundary

**Files:**
- Create: `studio/src/security/redactor.js`
- Create: `studio/src/security/credential-vault.js`
- Create: `studio/src/security/ephemeral-secrets.js`
- Create: `studio/test/security/redactor.test.js`
- Create: `studio/test/security/credential-vault.test.js`
- Create: `studio/test/security/ephemeral-secrets.test.js`

**Step 1: Write the failing redaction tests**

Test exact secret values, case-insensitive credential keys, URL-encoded values, nested objects, and overlapping secrets. The longer value must be replaced first.

**Step 2: Verify RED**

Run: `cd studio; node --test test/security/redactor.test.js`

Expected: FAIL with missing `redactor.js`.

**Step 3: Implement a reusable redactor**

Expose `createRedactor({ secrets, sensitiveKeys })` with `text()` and `value()` methods. Never log the input used to construct the redactor.

**Step 4: Write the failing Windows DPAPI round-trip test**

```js
const vault = new CredentialVault({ root: tmp, runPowerShell });
await vault.save("fixture", { username: "demo", password: "secret-123" });
assert.equal(await readFile(vault.pathFor("fixture"), "utf8").then(x => x.includes("secret-123")), false);
assert.deepEqual(await vault.load("fixture"), { username: "demo", password: "secret-123" });
```

Also assert invalid credential names cannot escape the vault directory.

**Step 5: Verify DPAPI test fails, then implement**

Run: `node --test test/security/credential-vault.test.js`

Expected RED: module missing.

Use PowerShell and `[System.Security.Cryptography.ProtectedData]` with `CurrentUser`. Pass plaintext through stdin, never command-line arguments.

**Step 6: Test and implement crash-safe ephemeral MCP redaction secrets**

Plaintext must never be written below `studio/data/jobs/`. `withEphemeralSecrets(runtimeRoot, credentials, fn)` creates a per-job directory below ignored `studio/.runtime/secrets/`, restricts its ACL to the current Windows user, writes the shortest-lived dotenv file used only for MCP response redaction, invokes `fn(path)`, and removes the directory in `finally` for success, thrown error, and aborted signal. `scavengeEphemeralSecrets()` removes stale directories at service startup after verifying every resolved path remains under the runtime root. The actual automatic-login values are passed only in the standalone Playwright MCP child environment and consumed by the service-owned init-page module; OpenCode never receives them.

**Step 7: Verify GREEN**

Run: `node --test test/security/*.test.js`

Expected: all security tests PASS and no test output contains `secret-123`.

**Step 8: Commit**

```powershell
git add studio/src/security studio/test/security
git commit -m "feat: secure local login credentials"
```

## Task 5: Supervise processes and integrate OpenCode JSON sessions

**Files:**
- Create: `studio/src/process/process-runner.js`
- Create: `studio/src/adapters/opencode-events.js`
- Create: `studio/src/adapters/opencode-client.js`
- Create: `studio/src/adapters/opencode-server.js`
- Create: `studio/src/adapters/browser-runtime.js`
- Create: `studio/src/adapters/mcp-gateway.js`
- Create: `studio/src/browser/browser-bootstrap-init.cjs`
- Create: `studio/opencode.json`
- Create: `studio/.opencode/agents/manual-video-planner.md`
- Create: `studio/.opencode/agents/manual-video-executor.md`
- Create: `studio/test/process/process-runner.test.js`
- Create: `studio/test/adapters/opencode-client.test.js`
- Create: `studio/test/adapters/opencode-server.test.js`
- Create: `studio/test/adapters/browser-runtime.test.js`
- Create: `studio/test/adapters/mcp-gateway.test.js`
- Create: `studio/test/adapters/opencode-config.test.js`

**Step 1: Write the failing process-runner tests**

Use short Node child processes to verify stdout/stderr line events, timeout, abort, Windows process-tree termination, exit code, and redaction before persistence.

**Step 2: Verify RED and implement the runner**

Run: `cd studio; node --test test/process/process-runner.test.js`

Expected RED: module missing.

Implement `runProcess({ command, args, cwd, env, signal, timeoutMs, onLine, redactor })` without `shell: true`. Node package CLIs are always invoked as `process.execPath, [resolvedCliPath, ...args]`; native commands must resolve to `.exe`. Add a Windows test proving no `.cmd` or `.ps1` shim is passed to `spawn`.

**Step 3: Write failing OpenCode event tests**

Feed JSON lines representing session creation, text deltas, tool calls, and completion. Assert the parser returns session ID, final text, normalized tool events, and ignores non-JSON diagnostic lines without hiding them.

**Step 4: Verify RED and implement the parser/client**

Run: `node --test test/adapters/opencode-client.test.js`

Expected RED: missing parser/client.

The client command must equal this shape and never contain `--model` or `--dangerously-skip-permissions`:

```js
[
  "run", "--pure", "--format", "json",
  "--attach", baseUrl,
  "--dir", studioRoot,
  "--agent", agent,
  prompt,
]
```

**Step 5: Write failing job-scoped Playwright MCP runtime and gateway tests**

Test `BrowserRuntime.start(job)` before implementing it. It must:

- generate a job-specific MCP config with `network.allowedOrigins` containing only the target origin plus explicitly approved authentication/resource origins as defense in depth;
- set `contextOptions.serviceWorkers` to `"block"` so service workers cannot bypass request routing;
- pass the same canonical origin set to the service-owned browser bootstrap module, which installs one `BrowserContext.route("**/*")` handler before navigation and aborts every document, subresource, and redirect request whose parsed origin is not approved;
- set `blockedOrigins` for known test attacker origins while treating MCP origin options as convenience guards rather than the security boundary;
- bind raw MCP to a fresh high job-scoped loopback port with `sharedBrowserContext`, headed Edge, persistent profile, `1920x1080`, job output directory, session saving, `core` and `devtools` capabilities;
- expose only a coordinator-owned gateway at `127.0.0.1:8931`, require a fresh canonical 256-bit bearer capability on every request, and never forward that header upstream;
- in planning, allow only bounded snapshot/wait/screenshot calls; after approval, accept only the immutable ordered queue of exact tool calls bound to the plan digest, quarantining on drift or uncertain completion;
- launch the exact local `@playwright/mcp@0.0.78` JavaScript CLI through `process.execPath`;
- pass automatic-login values only in the MCP child environment and to `browser-bootstrap-init.cjs`, never in OpenCode environment, arguments, or job artifacts;
- use the ephemeral secrets file only for MCP response redaction, delete it immediately after MCP startup, and scavenge it after a simulated crash;
- keep one job-scoped MCP process alive across authentication, planning, and execution, then stop its process tree on completion/cancel.

`browser-bootstrap-init.cjs` is service-owned code loaded with MCP `initPage` for manual and automatic jobs. Before any target navigation it installs the context route guard described above and verifies service workers are blocked. In automatic mode it additionally registers a one-shot DOM-content handler, confines itself to the approved login origin, uses validated username/password/submit selectors (with conservative defaults), reads credentials from its process environment, fills and submits through the provided Playwright `page`, clears its local references, and never prints values.

Run: `node --test test/adapters/browser-runtime.test.js test/adapters/mcp-gateway.test.js`

Expected RED: `BrowserRuntime` and the init-page module do not exist.

**Step 6: Implement the standalone browser runtime and job-scoped OpenCode server**

OpenCode connects to the capability-authenticated coordinator gateway at `http://127.0.0.1:8931/mcp`; it cannot address the raw MCP listener, does not spawn MCP, and does not inherit login secrets. `OpenCodeServer.startJob()` requires the job capability, places it only in the isolated server environment used by the remote-MCP authorization header placeholder, launches `opencode serve --pure --hostname 127.0.0.1 --port 4096`, waits for readiness, remains alive for every phase of the active job, and stops before the next queued job. Add tests for readiness, port ownership, capability/config drift, cancellation, secret-free attached CLI environment, and restart isolation.

Run: `node --test test/adapters/browser-runtime.test.js test/adapters/opencode-server.test.js`

Expected: PASS, including direct-navigation, subresource, service-worker, WebSocket, and redirect probes whose attacker server receives zero HTTP requests. Disable the MCP `network.allowedOrigins` option in one test to prove the service-owned route guard is the enforcing layer. Document that speculative preconnect may still open a TCP connection, so this is not full process-level egress isolation.

**Step 7: Write the failing config/agent tests**

Parse `opencode.json` and Markdown front matter. Assert:

- project-local MCP configuration points only to the coordinator-owned loopback Playwright endpoint;
- the remote MCP entry uses exactly `Authorization: Bearer {env:MANUAL_STUDIO_MCP_TOKEN}` and never persists a real capability;
- global permission is `"*": "deny"`, and only the exact required `playwright_*` tools are re-allowed;
- `edit`, `bash`, `webfetch`, `websearch`, `task`, `external_directory`, `question`, unsafe browser code, and every non-required MCP tool remain denied;
- planner and executor are primary agents and contain no `model` field;
- allowed tool names are limited to required `playwright_*` operations.

**Step 8: Add exact OpenCode configuration and prompts**

Use `.opencode/agents/` and front matter supported by current OpenCode. Planner final output is one JSON plan object. Executor must start recording, follow the approved digest and steps, emit one evidence record per step, stop on mismatch, and return one JSON execution report.

Run `opencode debug config --pure` and `opencode debug agent manual-video-planner --pure` from `studio/`. Parse the resolved result in the test and add negative probes showing `bash`, `edit`, `webfetch`, `websearch`, `external_directory`, and `playwright_browser_run_code` cannot execute. Self-parsing `opencode.json` alone is not sufficient.

**Step 9: Run the focused suite**

Run: `node --test test/process/*.test.js test/adapters/opencode-*.test.js`

Expected: all tests PASS.

**Step 10: Commit**

```powershell
git add studio/src/process studio/src/adapters/opencode-events.js studio/src/adapters/opencode-client.js studio/src/adapters/opencode-server.js studio/src/adapters/browser-runtime.js studio/src/adapters/mcp-gateway.js studio/src/browser studio/opencode.json studio/.opencode studio/test/process studio/test/adapters/opencode-client.test.js studio/test/adapters/opencode-server.test.js studio/test/adapters/browser-runtime.test.js studio/test/adapters/mcp-gateway.test.js studio/test/adapters/opencode-config.test.js
git commit -m "feat: orchestrate restricted OpenCode browser agents"
```

## Task 6: Serve the API, SSE stream, static app, and login fixture

**Files:**
- Create: `studio/src/server/router.js`
- Create: `studio/src/server/app.js`
- Create: `studio/src/index.js`
- Create: `studio/src/fixture/login-site.js`
- Create: `studio/public/index.html`
- Create: `studio/public/app.js`
- Create: `studio/public/styles.css`
- Create: `studio/test/server/app.test.js`
- Create: `studio/test/fixture/login-site.test.js`

**Step 1: Write the failing HTTP contract tests**

Start the app on an ephemeral port and test:

- `GET /api/health` returns safe tool readiness;
- `POST /api/jobs` validates URL/prompt/auth mode and returns 201;
- `GET /api/jobs/:id` returns current state without raw secrets;
- `GET /api/jobs/:id/events` is an SSE response and replays sequence IDs;
- `GET /api/jobs/:id/artifacts/*` serves only manifest-listed files below that job directory, supports single HTTP byte ranges for video playback, and rejects traversal, symlinks, and unlisted files;
- unsupported methods and unknown routes return structured JSON errors;
- static paths cannot traverse outside `public/`.

**Step 2: Verify RED**

Run: `cd studio; node --test test/server/app.test.js`

Expected: FAIL because the server modules are missing.

**Step 3: Implement the minimum built-in Node server**

Use `http.createServer`, an explicit route table, bounded JSON request bodies, exact content types, and `Cache-Control: no-store` for APIs. Implement correct `200`, `206`, `416`, `Content-Range`, `Accept-Ranges`, and streaming behavior for listed media artifacts. Inject stores/adapters so tests use real domain code and fake external processes only where unavoidable.

**Step 4: Write the failing fixture tests**

Test `/fixture/login`, correct/incorrect credentials, session cookie, protected `/fixture/dashboard`, menu navigation, a two-step completion marker, and logout.

**Step 5: Implement the local fixture**

Credentials are fixed only for the fixture: `demo` / `manual-video-demo`. Mark every interactive element with accessible names and deterministic visible results.

**Step 6: Add the smallest static shell**

At this task, `public/index.html` only needs the application root, accessibility landmarks, and module script. Full styling and interactions arrive in Task 11.

**Step 7: Verify GREEN**

Run: `node --test test/server/*.test.js test/fixture/*.test.js`

Expected: all server and fixture tests PASS.

**Step 8: Commit**

```powershell
git add studio/src/server studio/src/index.js studio/src/fixture studio/public studio/test/server studio/test/fixture
git commit -m "feat: expose local studio API and fixture site"
```

## Task 7: Implement authentication and plan-review orchestration

**Files:**
- Create: `studio/src/workflow/authentication.js`
- Create: `studio/src/workflow/planning.js`
- Create: `studio/src/workflow/studio-service.js`
- Modify: `studio/src/server/router.js`
- Test: `studio/test/workflow/authentication.test.js`
- Test: `studio/test/workflow/planning.test.js`

**Step 1: Write failing manual-login workflow tests**

Assert that manual mode opens the URL through the planner bootstrap session, enters `awaiting_manual_login`, and cannot plan until `confirmManualLogin(jobId)` is called.

**Step 2: Verify RED and implement manual auth**

Run: `cd studio; node --test --test-name-pattern=manual test/workflow/authentication.test.js`

Expected RED: workflow module missing.

Implement the smallest stateful handshake while leaving the job-scoped standalone MCP browser alive. The OpenCode server stays attached to that MCP endpoint but does not own the browser process.

**Step 3: Write failing automatic-login tests**

Assert the credential vault entry is decrypted only while starting `BrowserRuntime`, OpenCode receives neither values nor a secret path, the standalone MCP child alone receives login environment values, the service-owned init-page performs the login, and ephemeral redaction files are outside artifacts and cleaned on success, failure, cancellation, and next-start scavenging.

**Step 4: Verify automatic-login tests are RED, then implement**

Run: `node --test --test-name-pattern=automatic test/workflow/authentication.test.js`

Expected RED: automatic mode is not implemented.

Expected: both auth modes PASS; no assertion output contains fixture credentials.

**Step 5: Write failing planning tests**

Use a fake OpenCode final response and real plan validation. Test valid plan persistence, malformed JSON, blocked action, target-origin mismatch, plan editing, and approval digest.

**Step 6: Verify planning tests are RED**

Run: `node --test test/workflow/planning.test.js`

Expected: FAIL because planning orchestration is missing.

**Step 7: Implement planning and API endpoints**

Add:

```text
POST /api/jobs/:id/login/manual/confirm
PUT  /api/jobs/:id/plan
POST /api/jobs/:id/plan/approve
```

The planner cannot transition to execution. Approval stores canonical plan plus SHA-256 digest and moves only to `approved`; it never invokes a business-action tool. Starting execution remains an explicit action in Task 8.

**Step 8: Run focused workflow and server tests**

Run: `node --test test/workflow/authentication.test.js test/workflow/planning.test.js test/server/app.test.js`

Expected: PASS.

**Step 9: Commit**

```powershell
git add studio/src/workflow studio/src/server/router.js studio/test/workflow studio/test/server/app.test.js
git commit -m "feat: gate browser plans behind local authentication and approval"
```

## Task 8: Execute approved browser steps and preserve evidence

**Files:**
- Create: `studio/src/workflow/execution.js`
- Create: `studio/src/domain/execution-report.js`
- Modify: `studio/src/workflow/studio-service.js`
- Modify: `studio/src/server/router.js`
- Test: `studio/test/workflow/execution.test.js`
- Test: `studio/test/domain/execution-report.test.js`

**Step 1: Write failing execution-report tests**

Validate step IDs, start/end times, screenshot paths, expected-result status, raw recording path, tool-call allowlist, and exact approved digest. Reject missing evidence and unapproved extra steps.

**Step 2: Verify RED and implement report validation**

Run: `cd studio; node --test test/domain/execution-report.test.js`

Expected RED: module missing.

**Step 3: Write failing execution workflow tests**

Cover:

- cannot execute without both `approved` state and matching approved digest;
- obtains the single-run lock;
- invokes `manual-video-executor` with the canonical plan;
- persists redacted OpenCode events while streaming progress;
- transitions to `needs_review` on mismatch or origin change;
- cancellation terminates the process and releases the lock;
- successful execution stores the report and transitions to `narrating`.

**Step 4: Verify RED and implement**

Run: `node --test test/workflow/execution.test.js`

Expected RED: execution service missing.

Add `POST /api/jobs/:id/execute`, `POST /api/jobs/:id/cancel`, and `POST /api/jobs/:id/retry`.

**Step 5: Add a real fixture execution contract test**

Guard it behind `MANUAL_STUDIO_LIVE_OPENCODE=1`. It must use the current configured OpenCode model, the real pinned Playwright MCP, the fixture dashboard, two approved steps, recording, action overlays, screenshots, and expected-result evidence. Do not pass `--model`. Assert the MCP tool log contains zero business-action calls before approval. Add a fixture link that redirects to a second local origin and prove `network.allowedOrigins` blocks the request before the attacker server records any hit.

**Step 6: Run non-live tests**

Run: `node --test test/domain/execution-report.test.js test/workflow/execution.test.js`

Expected: PASS; live test is skipped unless explicitly enabled.

**Step 7: Commit**

```powershell
git add studio/src/workflow/execution.js studio/src/domain/execution-report.js studio/src/workflow/studio-service.js studio/src/server/router.js studio/test/workflow/execution.test.js studio/test/domain/execution-report.test.js
git commit -m "feat: execute approved plans with browser evidence"
```

## Task 9: Generate real Korean scene narration with Supertonic

**Files:**
- Create: `studio/src/adapters/supertonic-client.js`
- Create: `studio/src/workflow/narration.js`
- Create: `studio/test/adapters/supertonic-client.test.js`
- Create: `studio/test/workflow/narration.test.js`
- Create: `studio/scripts/supertonic.ps1`

**Step 1: Write failing client contract tests**

Use a local test HTTP server. Assert `/v1/health`, one `/v1/tts` request per scene, explicit `lang: "ko"`, allowed preset voices, WAV response only, duration-header parsing, concurrency one, timeout, and structured 503 handling.

**Step 2: Verify RED and implement**

Run: `cd studio; node --test test/adapters/supertonic-client.test.js`

Expected RED: module missing.

Use native `fetch`; write the received ArrayBuffer atomically to the scene WAV path. Reject MP3/AAC/Opus and invalid or absent duration.

**Step 3: Write failing narration workflow tests**

Assert ordered scene files, preserved Korean narration text, retry of one failed scene, `narration.json`, and no silent fallback.

**Step 4: Verify narration workflow tests are RED**

Run: `node --test test/workflow/narration.test.js`

Expected: FAIL because `narration.js` does not exist.

**Step 5: Implement narration workflow and sidecar script**

`supertonic.ps1` must create/use a Python 3.13.14 venv, install exact `supertonic[serve]==1.3.1`, download the pinned model on request, and bind only `127.0.0.1:7788`.

**Step 6: Run focused tests**

Run: `node --test test/adapters/supertonic-client.test.js test/workflow/narration.test.js`

Expected: PASS.

**Step 7: Run a real Korean synthesis smoke**

Run: `powershell -ExecutionPolicy Bypass -File scripts/supertonic.ps1 -Ensure -Start`

Run: `npm run smoke:supertonic`

Expected: a non-empty 44.1 kHz WAV with duration greater than zero; no generated file is committed.

**Step 8: Commit**

```powershell
git add studio/src/adapters/supertonic-client.js studio/src/workflow/narration.js studio/test/adapters/supertonic-client.test.js studio/test/workflow/narration.test.js studio/scripts/supertonic.ps1 studio/package.json
git commit -m "feat: synthesize Korean scene narration with Supertonic"
```

## Task 10: Normalize, compose, preview, render, and gate media

**Files:**
- Create: `studio/src/adapters/ffmpeg.js`
- Create: `studio/src/adapters/hyperframes.js`
- Create: `studio/src/media/media-plan.js`
- Create: `studio/src/media/composition.js`
- Create: `studio/src/media/quality-gate.js`
- Create: `studio/src/workflow/media.js`
- Create: `studio/templates/hyperframes/index.html`
- Create: `studio/test/adapters/ffmpeg.test.js`
- Create: `studio/test/adapters/hyperframes.test.js`
- Create: `studio/test/media/media-plan.test.js`
- Create: `studio/test/media/composition.test.js`
- Create: `studio/test/media/quality-gate.test.js`
- Create: `studio/test/workflow/media.test.js`

**Step 1: Write failing FFmpeg command tests**

Assert raw WebM normalization uses 1920x1080 padding, 30 fps CFR, H.264, CRF 18, yuv420p, faststart, no shell quoting, and an output inside the job directory.

**Step 2: Verify FFmpeg tests are RED**

Run: `cd studio; node --test test/adapters/ffmpeg.test.js`

Expected: FAIL because `ffmpeg.js` does not exist.

**Step 3: Implement and run an actual small normalization test**

Use FFmpeg `testsrc2` only as a test input. The acceptance workflow must still use real Playwright video.

Run: `cd studio; node --test test/adapters/ffmpeg.test.js`

Expected: PASS and FFprobe reads the generated test MP4.

**Step 4: Write failing media-plan tests**

Align each browser step range with its narration duration, generate caption cues, cap stretch to a documented safe range, and reject missing/overlapping scenes or more than 500 ms unexplained drift.

**Step 5: Verify media-plan tests are RED**

Run: `node --test test/media/media-plan.test.js`

Expected: FAIL because `media-plan.js` does not exist.

**Step 6: Implement media-plan generation**

Return a deterministic JSON manifest containing scene source ranges, output ranges, WAV paths, captions, chapter labels, and highlight metadata.

**Step 7: Write failing composition tests**

Assert escaped text, relative in-job media URLs, stable `data-composition-id`, 1920x1080, timed `.clip` nodes, separate muted video and narration audio, deterministic duration, and no runtime fetch, randomness, or infinite animation.

**Step 8: Verify composition tests are RED, then implement template compilation**

Run: `node --test test/media/composition.test.js`

Expected RED: composition compiler is missing.

Application code replaces explicit template slots. OpenCode never writes arbitrary composition HTML.

**Step 9: Write failing HyperFrames and quality tests**

Check exact version, `HYPERFRAMES_SKIP_SKILLS=1`, lint/check/preview/render commands, strict render flags, output existence, and FFprobe requirements for H.264/AAC/1920x1080/30 fps/duration.

**Step 10: Verify HyperFrames and quality tests are RED**

Run: `node --test test/adapters/hyperframes.test.js test/media/quality-gate.test.js`

Expected: FAIL because the adapter and gate are missing.

**Step 11: Implement adapters and run a golden render**

Run: `node --test test/adapters/hyperframes.test.js test/media/*.test.js`

Run: `npm run smoke:hyperframes`

Expected: lint and check succeed, preview starts, a real MP4 renders, and the quality gate passes.

**Step 12: Test and implement preview edits without recapture**

Write `test/workflow/media.test.js` first. Approving a preview must render; editing narration or captions must invalidate only narration/composition/render artifacts, preserve the raw Playwright recording and evidence, and return to `narrating` or `composing` as appropriate. Invalid scene IDs and edits after cancellation must fail.

Run: `node --test test/workflow/media.test.js`

Expected RED: media workflow is missing.

Implement `updateMediaPlan()`, `approvePreview()`, and `renderFinal()` with explicit artifact invalidation. Add `PUT /api/jobs/:id/media-plan` and `POST /api/jobs/:id/preview/approve` in Task 12 when the router is wired.

Run: `node --test test/workflow/media.test.js`

Expected GREEN: all media edit/re-render cases PASS without invoking browser capture.

**Step 13: Commit**

```powershell
git add studio/src/adapters/ffmpeg.js studio/src/adapters/hyperframes.js studio/src/media studio/src/workflow/media.js studio/templates studio/test/adapters/ffmpeg.test.js studio/test/adapters/hyperframes.test.js studio/test/media studio/test/workflow/media.test.js studio/package.json
git commit -m "feat: compose and verify final manual videos"
```

## Task 11: Build the AI Center job UI and recovery interactions

**Required skill:** Use `@ai-center-design` and reread its `references/DESIGN.md` before editing UI files.

**Files:**
- Modify: `studio/public/index.html`
- Modify: `studio/public/app.js`
- Modify: `studio/public/styles.css`
- Create: `studio/test/ui/home-ui.test.js`
- Create: `studio/test/ui/job-ui.test.js`

**Step 1: Write failing first-viewport tests**

Fetch the real page and assert visible `AI Center`, `Manual Studio`, target URL, prompt, login mode, primary action, origin-dot/connection markup, semantic landmarks, labels, and no old backend asset paths.

**Step 2: Verify RED**

Run: `cd studio; node --test test/ui/home-ui.test.js`

Expected: FAIL because the minimal shell lacks the required UI.

**Step 3: Implement the approved visual system**

Use a cool light canvas, one directional origin-dot connection field, blue/violet/cyan tokens, 1 px hairlines, 6 px controls, 8 px cards, SamsungOne/Pretendard/Inter/system fallbacks, and a dark surface only for video preview. Keep identity visible in the first viewport rather than only in navigation.

**Step 4: Write failing workflow interaction tests**

Test the state-to-view mapping, editable/reorderable plan rows, risk labels, approval, manual-login confirmation, execute/cancel/retry, live event rendering, artifact links, preview approval, and narration/caption rerender request.

**Step 5: Verify workflow interaction tests are RED**

Run: `node --test test/ui/job-ui.test.js`

Expected: FAIL because the client interactions are not implemented.

**Step 6: Implement the vanilla client**

Use one state store, `fetch`, and `EventSource`; no framework. Render text with DOM text nodes, never untrusted `innerHTML`. Disable actions that are invalid for the current server state.

**Step 7: Add responsive and accessibility rules**

Desktop uses workflow/center/inspector columns. Below 768 px, use one prioritized column; maintain 44 px targets, visible focus, `prefers-reduced-motion`, 4.5:1 text contrast, no horizontal scrolling, and text labels alongside status color.

**Step 8: Run UI tests**

Run: `node --test test/ui/*.test.js test/server/app.test.js`

Expected: PASS.

**Step 9: Run real browser visual smoke**

Use the Playwright MCP/browser testing skill against the running local service at 1440x900 and 390x844. Save screenshots outside tracked source. Verify no overlap, no horizontal scroll, working keyboard focus, and visible first-viewport AI Center identity.

**Step 10: Commit**

```powershell
git add studio/public studio/test/ui
git commit -m "feat: add AI Center manual video workspace"
```

## Task 12: Wire the complete workflow and operational scripts

**Files:**
- Modify: `studio/src/workflow/studio-service.js`
- Modify: `studio/src/server/router.js`
- Create: `studio/scripts/bootstrap.ps1`
- Create: `studio/scripts/start.ps1`
- Create: `studio/scripts/verify.mjs`
- Create: `studio/scripts/smoke-live.mjs`
- Create: `studio/README.md`
- Create: `studio/test/operational/full-workflow.test.js`
- Create: `studio/test/operational/scripts.test.js`

**Step 1: Write the failing full-workflow test**

With fake external-process boundaries and real domain/store/server code, drive:

```text
create → authenticate → plan → edit → approve → execute → narrate
→ compose → preview approve → render → quality gate → completed
```

Assert every state, event sequence, artifact, retry boundary, and final response.

**Step 2: Verify RED and connect all stages**

Run: `cd studio; node --test test/operational/full-workflow.test.js`

Expected RED: workflow stops after one of the not-yet-connected stages.

Implement the minimum orchestration to make the full contract green. Wire `PUT /api/jobs/:id/media-plan` and `POST /api/jobs/:id/preview/approve`; editing narration/captions must rerun only narration/composition/render stages and retain browser capture/evidence.

**Step 3: Write failing script contract tests**

Parse scripts and run their safe flags. Assert:

- bootstrap checks Node 22+, OpenCode, Python 3.13.14, Supertonic, Playwright MCP, HyperFrames, FFmpeg, and FFprobe;
- start binds only `127.0.0.1` and opens the service UI;
- no script runs the old FastAPI backend;
- doctor output contains versions/statuses but no credentials;
- verify fails on placeholder, silent, wrong-codec, or missing-caption artifacts.

**Step 4: Implement scripts and documentation**

First run: `node --test test/operational/scripts.test.js`

Expected RED: required scripts or safe flags are missing.

Document exact bootstrap/start commands, manual and automatic login, model download size, local data paths, retry behavior, generated-content disclosure, and OpenRAIL-M notice. Make `studio/scripts/start.ps1` the only documented entry point.

Run: `node --test test/operational/scripts.test.js`

Expected GREEN: all script contract tests PASS.

**Step 5: Run the complete automated studio suite**

Run: `cd studio; npm test`

Expected: all studio tests PASS with no warnings or leaked secrets.

**Step 6: Commit**

```powershell
git add studio/src/workflow/studio-service.js studio/src/server/router.js studio/scripts studio/README.md studio/test/operational studio/package.json
git commit -m "feat: complete local manual video workflow"
```

## Task 13: Prove the real five-tool path end to end

**Required skills:** Use `@superpowers:verification-before-completion` before any completion claim and `@superpowers:systematic-debugging` for any failure.

**Files:**
- Modify only if a newly reproduced bug has a failing regression test first.
- Generate under ignored `studio/data/jobs/<live-job-id>/`.

**Step 1: Run clean automated verification**

Run:

```powershell
cd studio
npm ci
npm test
npm run doctor
npm run verify
```

Expected: all commands exit 0; doctor reports the exact selected engines ready.

**Step 2: Start the real sidecars and service**

Run `studio/scripts/start.ps1` with visible Edge, OpenCode server, Playwright MCP, and Supertonic. Confirm all processes bind to loopback only.

**Step 3: Verify manual login live**

Against the fixture site:

- create a Korean prompt for two menu actions;
- log in manually in the visible browser;
- confirm login in the UI;
- inspect and edit the generated plan;
- verify no action recording starts before approval;
- approve and execute.

**Step 4: Verify automatic login live**

Store fixture credentials and validated login selectors through DPAPI, create a second job, and run the same workflow without typing credentials. Confirm the coordinator-owned Playwright MCP init-page performed login, OpenCode never received the values, ephemeral redaction files were removed, and searching every job artifact for both fixture values returns zero matches.

**Step 5: Verify final media**

Require real Playwright screenshots and recording, real Korean Supertonic audio, rendered captions and chapter/action highlights, and a final non-placeholder MP4. Run FFprobe and require:

```text
1920x1080
30 fps
H.264 video
AAC audio
non-zero audio duration
scene drift <= 500 ms
```

**Step 6: Exercise recovery**

Force one page mismatch and kill one render. Verify `needs_review`, artifact preservation, re-approval, retry from the safe stage, and final completion without recapturing unaffected steps. Attempt a malicious redirect to an unapproved local origin and verify its server receives zero HTTP requests because the service-owned request guard and MCP allowlist reject it. Report the observed speculative-preconnect TCP limitation separately.

**Step 7: Perform desktop and mobile UI smoke**

Use real browser inspection at 1440x900 and 390x844. Verify first-viewport AI Center identity, no overlap/horizontal scrolling, keyboard reachability, live progress, error details, and final video playback.

**Step 8: Run repository finish checks**

Run from worktree root:

```powershell
git status --short
git diff --check
rg -n "from backend|import backend|backend\.app" studio
```

Expected: only intended files changed, no whitespace errors, and the backend import search returns no matches. The legacy backend suite is not part of product completion because the approved implementation is isolated under `studio/`; the clean-worktree baseline was already established before Task 1.

**Step 9: Commit any regression-tested finish fixes**

If no fixes were required, do not create an empty commit. If fixes were required, stage only those files and use a specific commit message.

## Final Handoff

When all verification is green, use `@superpowers:finishing-a-development-branch` to present integration options. Report:

- worktree and branch;
- exact startup command;
- automated test counts;
- live job ID and final MP4 path;
- tool versions actually exercised;
- any remaining limitation that was observed rather than assumed.
