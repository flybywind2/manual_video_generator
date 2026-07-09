# Quality-First Manual Video Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `gemma4:12b_qat`, Playwright, TTS, subtitles, and video rendering produce evidence-based manual videos with explicit quality validation and observable fallbacks.

**Architecture:** Add shared LLM contracts and a browser action quality policy around the existing adapters. Keep Playwright as the final executor, enrich each observation with Page Agent candidates, use VLM on every meaningful turn in `quality_first`, validate and repair its output once, then build media only from verified actions and enforce final render quality metadata.

**Tech Stack:** Python 3.10, FastAPI, Pydantic, Ollama OpenAI-compatible API, Playwright, FFmpeg, Supertonic, HyperFrames, pytest

---

### Task 1: Shared Gemma prompt and JSON request contracts

**Files:**
- Create: `backend/app/adapters/llm_contracts.py`
- Modify: `backend/app/adapters/input_extractor.py`
- Modify: `backend/app/adapters/planner.py`
- Modify: `backend/app/adapters/browser_agent.py`
- Test: `backend/tests/test_quality_first_pipeline.py`

**Step 1: Write failing prompt contract tests**

Add tests that capture the HTTP payloads from input extraction, planning, DOM Browser Agent, and VLM Browser Agent. Assert that Ollama payloads contain the role-specific prompt markers and `response_format={"type":"json_object"}`, while internal providers do not receive unsupported Ollama-only fields.

**Step 2: Run tests to verify RED**

Run:

```powershell
python -m pytest -q backend/tests/test_quality_first_pipeline.py -k "prompt or response_format" --basetemp C:\tmp\manual_video_quality_red1
```

Expected: FAIL because shared contracts and JSON response format do not exist.

**Step 3: Implement shared contracts**

Create constants for Input Extractor, Planner, DOM Browser Agent, and VLM Browser Agent. Add a helper that conditionally injects Ollama JSON response format without changing internal provider payloads. Replace inline prompt strings with these constants.

**Step 4: Run focused tests to verify GREEN**

Run the command from Step 2 and expect all selected tests to pass.

### Task 2: Video duration extraction without polluting screen inputs

**Files:**
- Modify: `backend/app/adapters/input_extractor.py`
- Test: `backend/tests/test_quality_first_pipeline.py`

**Step 1: Write failing duration tests**

Cover `5분`, `30초`, `1분 30초`, no duration, and a request containing both a business numeric value and duration. Assert that duration is stored as `scenario_brief.target_video_duration_seconds` and is absent from `input_values`.

**Step 2: Verify RED**

Run:

```powershell
python -m pytest -q backend/tests/test_quality_first_pipeline.py -k duration --basetemp C:\tmp\manual_video_quality_red2
```

Expected: FAIL because duration text is currently ignored.

**Step 3: Implement deterministic duration parsing**

Parse Korean minute/second forms from request text and completion condition, clamp through the existing 10–900 second policy, and merge the value into the scenario brief after LLM input extraction.

**Step 4: Verify GREEN**

Run the duration test slice and expect all tests to pass.

### Task 3: Bounded observation and history context

**Files:**
- Create: `backend/app/adapters/browser_quality.py`
- Modify: `backend/app/adapters/browser_agent.py`
- Test: `backend/tests/test_quality_first_pipeline.py`

**Step 1: Write failing payload-bound tests**

Generate oversized `body_text`, headings, fields, clickables, and history. Assert the compact context preserves field/clickable selectors and current values while bounding body text, list counts, and history length.

**Step 2: Verify RED**

Run:

```powershell
python -m pytest -q backend/tests/test_quality_first_pipeline.py -k compact --basetemp C:\tmp\manual_video_quality_red3
```

Expected: FAIL because raw observation/history are sent today.

**Step 3: Implement compact context helpers**

Add deterministic caps and history summaries. Keep current and failed target information, but remove duplicate body text and oversized result payloads. Use the same compact context for DOM LLM and VLM prompts.

**Step 4: Verify GREEN**

Run the compact-context test slice and expect all tests to pass.

### Task 4: Quality-first action validation and VLM repair

**Files:**
- Modify: `backend/app/adapters/browser_quality.py`
- Modify: `backend/app/adapters/browser_agent.py`
- Modify: `backend/app/config.py`
- Modify: `.env.example`
- Test: `backend/tests/test_quality_first_pipeline.py`
- Test: `backend/tests/test_config.py`

**Step 1: Write failing validator tests**

Cover unobserved selector, unknown fill label, invalid value key, prohibited toggle, repeated action without page change, consecutive capture, premature finish, and valid capture-then-finish.

**Step 2: Write failing repair tests**

Return an invalid VLM action on the first call and a valid action on the second. Assert exactly one repair call, validation errors in the second prompt, and the repaired action source/attempt metadata.

**Step 3: Verify RED**

Run:

```powershell
python -m pytest -q backend/tests/test_quality_first_pipeline.py -k "validate or repair or quality_first" --basetemp C:\tmp\manual_video_quality_red4
```

Expected: FAIL because the quality policy and repair loop do not exist.

**Step 4: Implement decision policy**

Add `MANUAL_AGENT_BROWSER_DECISION_POLICY` with `quality_first` and `balanced` values. In quality-first mode, enrich DOM candidates, call VLM for every meaningful turn, validate the normalized action, issue one repair request when invalid, then fall back to DOM LLM and local policy with structured metadata.

**Step 5: Verify GREEN**

Run the validator/repair tests and config tests. Expect all to pass.

### Task 5: Trace quality metrics and enforce state transitions

**Files:**
- Modify: `backend/app/adapters/browser_agent.py`
- Modify: `backend/app/llm_logging.py`
- Modify: `backend/app/pipeline.py`
- Test: `backend/tests/test_quality_first_pipeline.py`
- Test: `backend/tests/test_pipeline.py`

**Step 1: Write failing observability tests**

Assert that LLM/VLM records include `elapsed_ms`, request/response bytes, attempt, decision policy, validation status, repair status, and fallback reason without secret values.

**Step 2: Write failing state-transition tests**

Assert that execution does not count an invalid action as a functional step and does not complete before a verified capture.

**Step 3: Verify RED, implement, and verify GREEN**

Use focused pytest selectors for the new tests, then run the relevant existing Browser Agent and pipeline slices.

### Task 6: Media-plan deduplication and narration timing

**Files:**
- Modify: `backend/app/pipeline.py`
- Modify: `backend/app/package_builder.py`
- Test: `backend/tests/test_quality_first_pipeline.py`
- Test: `backend/tests/test_pipeline.py`

**Step 1: Write failing media quality tests**

Build action logs containing duplicate captures, repeated reasons, failed actions, and a successful final state. Assert failed actions are excluded, repeated narration is collapsed, input values are not duplicated, and duration totals match the TTS timeline.

**Step 2: Verify RED**

Run the media quality tests and confirm the current duplicate behavior fails them.

**Step 3: Implement minimal normalization**

Filter failed/skipped actions, normalize repeated narration, preserve meaningful action order, and produce one subtitle interval per retained narration step.

**Step 4: Verify GREEN**

Run media, subtitle, replay, and TTS timing tests.

### Task 7: Final render quality report

**Files:**
- Modify: `backend/app/adapters/video.py`
- Modify: `backend/app/pipeline.py`
- Modify: `tools/verify_package.py`
- Test: `backend/tests/test_quality_first_pipeline.py`
- Test: `backend/tests/test_verify_package.py`

**Step 1: Write failing quality-report tests**

Cover missing/empty video, missing audio stream metadata, excessive audio/video duration drift, requested subtitle burn-in failure, and a valid render.

**Step 2: Verify RED**

Run quality-report and package-verifier tests and confirm the new checks fail before implementation.

**Step 3: Implement quality metadata**

Add a structured `quality` section to `video_render.json` and package manifest. Reuse existing ffprobe and nonblank-frame helpers. Record quality degradation without deleting inspectable artifacts; strict mode raises the first quality failure.

**Step 4: Verify GREEN**

Run video adapter and package verification tests.

### Task 8: UI, documentation, and runtime defaults

**Files:**
- Modify: `backend/app/static/app.js`
- Modify: `backend/app/templates/index.html`
- Modify: `README.md`
- Modify: `runtime/manual-agent-runtime.env`
- Test: `backend/tests/test_home_ui.py`
- Test: `backend/tests/test_config.py`

**Step 1: Write failing UI/status tests**

Assert the status view exposes quality-first policy and labels VLM repair/fallback distinctly.

**Step 2: Verify RED, implement, and verify GREEN**

Set the local runtime policy to `quality_first`, document expected latency and required Ollama/VLM settings, then run UI/config tests.

### Task 9: Regression and live validation

**Files:**
- Validate: `backend/tests/`
- Validate: `docs/prompts/gemma4_12b_qat_video_generation.md`

**Step 1: Run focused quality tests**

```powershell
python -m pytest -q backend/tests/test_quality_first_pipeline.py --basetemp C:\tmp\manual_video_quality_focused
```

**Step 2: Run the full suite**

```powershell
python -m pytest -q --basetemp C:\tmp\manual_video_quality_full
```

**Step 3: Compile the application**

```powershell
python -m compileall backend/app tools
```

**Step 4: Run live Ollama contract scenarios**

Validate input extraction, planner, DOM/VLM action, repair, modal, textless icon, SSO wait, chatbot capture, and finish using `gemma4:12b_qat`.

**Step 5: Run sample E2E and verify package**

Generate one sample AI-mode package with Playwright MCP live, Supertonic, HyperFrames, and FFmpeg. Run `tools/verify_package.py` and inspect `fallback_events`, `degradations`, browser trace, TTS metadata, and render quality.
