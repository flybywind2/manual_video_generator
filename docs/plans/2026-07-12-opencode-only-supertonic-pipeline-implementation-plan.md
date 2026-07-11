# OpenCode-Only Supertonic Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all active LLM/VLM browser intelligence with one fail-fast OpenCode discovery run, replay its validated trace deterministically, and make Supertonic M1 the only TTS provider.

**Architecture:** Keep the current FastAPI request and artifact APIs stable while introducing versioned execution-trace, OpenCode discovery, and orchestration boundaries. The backend owns Edge/CDP, validation, replay, recording, redaction, and packaging; OpenCode owns request interpretation and browser discovery through a job-local Playwright MCP configuration.

**Tech Stack:** Python 3.13.14, FastAPI, Pydantic, OpenCode CLI, Playwright MCP, Edge CDP, Playwright Python, Supertonic 3, HyperFrames, FFmpeg, pytest.

---

### Task 1: Add the versioned execution trace contract

**Files:**
- Create: `backend/app/execution_trace.py`
- Test: `backend/tests/test_opencode_orchestrator.py`

**Step 1: Write failing contract tests**

Cover valid traces, unsupported schema versions, empty steps, unknown actions, missing selector/ref, raw secret values, off-origin URLs, dangerous write actions, ambiguous targets, and missing completion evidence.

**Step 2: Run tests to verify RED**

Run: `python -m pytest backend/tests/test_opencode_orchestrator.py -q`

Expected: import failure because `backend.app.execution_trace` does not exist.

**Step 3: Implement minimal Pydantic models and validator**

Create `ExecutionTrace`, `TraceStep`, `TraceAction`, `TraceEvidence`, `CompletionEvidence`, and `validate_execution_trace(trace, request, policy)`. Permit only `navigate`, `fill`, `click`, `press`, `wait`, and `capture`; require observed provenance and reject sensitive serialization.

**Step 4: Run tests to verify GREEN**

Run the focused test file and expect PASS.

**Step 5: Commit**

```powershell
git add backend/app/execution_trace.py backend/tests/test_opencode_orchestrator.py
git commit -m "feat: add OpenCode execution trace contract"
```

### Task 2: Build the job-local OpenCode browser discovery adapter

**Files:**
- Create: `backend/app/adapters/opencode_browser.py`
- Modify: `backend/app/adapters/opencode.py`
- Test: `backend/tests/test_opencode_orchestrator.py`

**Step 1: Write failing adapter tests**

Assert that the adapter writes an isolated `opencode.json`, registers only Playwright MCP with `--cdp-endpoint`, denies shell/edit/web/subagent tools, invokes `opencode run --format json` without `--model`, parses JSON events, extracts the final trace, and fails on timeout, nonzero exit, malformed output, or absent trace.

**Step 2: Run tests to verify RED**

Run the new adapter tests and expect missing module/functions.

**Step 3: Implement discovery adapter**

Add `OpenCodeBrowserDiscovery.run(request, job_dir, cdp_endpoint)` returning a validated raw trace plus paths to config, prompt, event log, trace, and concise support summary. Preserve stderr and return code without treating failure as degraded success.

**Step 4: Run tests to verify GREEN**

Run focused tests and expect PASS.

**Step 5: Commit**

```powershell
git add backend/app/adapters/opencode.py backend/app/adapters/opencode_browser.py backend/tests/test_opencode_orchestrator.py
git commit -m "feat: add OpenCode browser discovery adapter"
```

### Task 3: Add backend-owned Edge CDP session management

**Files:**
- Create: `backend/app/browser_session.py`
- Modify: `backend/app/env_bootstrap.py`
- Test: `backend/tests/test_opencode_orchestrator.py`

**Step 1: Write failing session tests**

Cover configured Edge channel/profile, loopback-only debugging endpoint, dynamic free port, startup readiness, existing `cdp_attach`, profile-lock errors, process-tree cleanup, and no credential serialization.

**Step 2: Run tests to verify RED**

Run the session test slice and expect missing `BrowserSessionManager`.

**Step 3: Implement session manager**

Implement a context manager returning `cdp_endpoint`, process metadata, profile path, and ownership status. Reuse configured CDP endpoints when supplied; otherwise launch Edge with the dedicated SSO profile and a dynamic loopback debugging port.

**Step 4: Run tests to verify GREEN**

Run focused tests and expect PASS.

**Step 5: Commit**

```powershell
git add backend/app/browser_session.py backend/app/env_bootstrap.py backend/tests/test_opencode_orchestrator.py
git commit -m "feat: manage Edge CDP sessions for OpenCode"
```

### Task 4: Replay validated traces deterministically

**Files:**
- Create: `backend/app/trace_replay.py`
- Modify: `backend/app/browser_runner.py`
- Test: `backend/tests/test_trace_replay.py`

**Step 1: Write failing replay tests**

Verify navigate/fill/click/press/wait/capture execution, exact-ref or selector targeting, narration-aware timing, pointer/highlight injection, before/after screenshots, action verification, replay divergence failure, URL-origin enforcement, and that replay never calls OpenCode or an LLM.

**Step 2: Run tests to verify RED**

Run: `python -m pytest backend/tests/test_trace_replay.py -q`

Expected: missing replay module.

**Step 3: Implement deterministic replay**

Translate each trace action to Playwright operations against the existing CDP session. Return a capture contract compatible with masking, media-plan, subtitle, and video adapters.

**Step 4: Run tests to verify GREEN**

Run focused replay tests and existing browser-runner tests.

**Step 5: Commit**

```powershell
git add backend/app/trace_replay.py backend/app/browser_runner.py backend/tests/test_trace_replay.py
git commit -m "feat: replay OpenCode traces deterministically"
```

### Task 5: Make Supertonic M1 the only fail-fast TTS

**Files:**
- Modify: `backend/app/adapters/tts.py`
- Modify: `backend/app/config.py`
- Modify: `.env.example`
- Test: `backend/tests/test_adapters.py`
- Test: `backend/tests/test_config.py`

**Step 1: Write failing TTS policy tests**

Assert the configured provider is always `supertonic`, voice is always `M1`, MeloTTS/fake providers are rejected, import/model/style/synthesis/save/empty-audio failures raise a typed `SupertonicTtsError`, and no silent WAV is created.

**Step 2: Run tests to verify RED**

Run focused TTS/config tests and observe current fallback behavior fail the assertions.

**Step 3: Simplify the adapter**

Remove active MeloTTS and silent fallback branches. Initialize Supertonic once, synthesize every narration with `M1` and `ko`, verify nonempty WAV files, write completed metadata only after all entries succeed, and clean partial output on failure.

**Step 4: Run tests to verify GREEN**

Run focused adapter/config tests and expect PASS.

**Step 5: Commit**

```powershell
git add backend/app/adapters/tts.py backend/app/config.py .env.example backend/tests/test_adapters.py backend/tests/test_config.py
git commit -m "refactor: make Supertonic the only TTS provider"
```

### Task 6: Introduce the simplified orchestrator

**Files:**
- Create: `backend/app/opencode_orchestrator.py`
- Modify: `backend/app/pipeline.py`
- Modify: `backend/app/workflow.py`
- Modify: `backend/app/workflow_graph.py`
- Test: `backend/tests/test_opencode_orchestrator.py`
- Test: `backend/tests/test_pipeline_operational_contract.py`

**Step 1: Write failing orchestration tests**

Assert the active path is request validation → browser session → OpenCode discovery → trace validation → Supertonic → replay → masking/render/package. Assert no call reaches internal planner, input-extractor LLM, browser-agent, VLM, RAG, reranker, page-agent, legacy MCP rehearsal, optional OpenCode post-pass, or silent capture fallback.

**Step 2: Run tests to verify RED**

Run focused orchestration tests and observe legacy calls.

**Step 3: Implement orchestrator and route public APIs**

Keep `PipelineInput`, `PipelineResult`, `run_pipeline`, draft/continue, rerender, and artifact contracts stable. Delegate new runs to `OpenCodeVideoOrchestrator`; retain rerender and legacy artifact readers where needed. Mark OpenCode and TTS failures as `FAILED`, not degraded.

**Step 4: Run tests to verify GREEN**

Run orchestration, pipeline contract, package, redaction, and workflow tests.

**Step 5: Commit**

```powershell
git add backend/app/opencode_orchestrator.py backend/app/pipeline.py backend/app/workflow.py backend/app/workflow_graph.py backend/tests
git commit -m "refactor: route pipeline through OpenCode orchestrator"
```

### Task 7: Remove legacy choices from UI and deployment configuration

**Files:**
- Modify: `backend/app/static/app.js`
- Modify: `backend/app/templates/index.html`
- Modify: `backend/app/config.py`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/OPENCODE_ONLY_DEPLOYMENT.md`
- Test: `backend/tests/test_home_ui.py`
- Test: `backend/tests/test_config.py`

**Step 1: Write failing UI/config tests**

Assert the home status shows OpenCode Agent, Playwright MCP/CDP, Supertonic M1, and renderer only. Assert no MeloTTS, LLM, VLM, RAG, reranker, browser-agent, or page-agent choices are presented as active requirements.

**Step 2: Run tests to verify RED**

Run UI/config tests and observe legacy options.

**Step 3: Simplify UI and docs**

Replace legacy runtime status cards and `.env` examples with the new required components and concise failure guidance. Document the company installation and smoke workflow without Docker.

**Step 4: Run tests to verify GREEN**

Run UI/config/runtime-script tests.

**Step 5: Commit**

```powershell
git add backend/app/static backend/app/templates backend/app/config.py .env.example README.md docs backend/tests
git commit -m "refactor: simplify OpenCode-only configuration"
```

### Task 8: Verify the QSike end-to-end acceptance scenario

**Files:**
- Create: `test_scenarios/qsike_service_manual.json`
- Modify: `test_secnario.md`
- Test: `backend/tests/test_opencode_orchestrator.py`

**Step 1: Add the acceptance fixture**

Define the target URL `https://qsike.com/`, Korean request, expected origin, required visible evidence, safe navigation actions, and expected package contract.

**Step 2: Run all automated tests**

Run:

```powershell
$env:TEMP='C:\tmp'
$env:TMP='C:\tmp'
python -m pytest -q --basetemp C:\tmp\manual_video_opencode_only -p no:cacheprovider
```

Expected: all tests PASS.

**Step 3: Run live QSike pipeline**

Start the app on a free loopback port and submit the acceptance fixture. Verify OpenCode controls the real QSike page through Playwright MCP, produces a valid trace, Supertonic emits nonempty Korean WAV files, replay records real pages, and final render contains audio/subtitles/highlights.

**Step 4: Inspect final artifacts**

Verify `opencode_execution_trace.json`, screenshots, replay log, TTS metadata, subtitles, video duration/audio stream, package manifest, concise support summary, and nonblank frame samples.

**Step 5: Commit acceptance assets and fixes**

```powershell
git add test_scenarios test_secnario.md backend/tests
git commit -m "test: verify QSike OpenCode-only video flow"
```
