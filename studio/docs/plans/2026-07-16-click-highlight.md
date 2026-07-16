# Click-Position Highlight Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Carry every approved Playwright click's trusted viewport rectangle and measured time into a visible 900 ms HyperFrames target outline and center ripple.

**Architecture:** Compile a coordinator-owned geometry probe immediately before each click, capture its exact result inside the MCP gateway, and bind it to measured click timing after the executor report has been validated. Propagate multiple timed highlights through producer trimming and media-plan playback conversion, then render deterministic overlay clips in HyperFrames and verify the original symptom with a real local video.

**Tech Stack:** Node.js 22 ESM, OpenCode, Playwright MCP 0.0.78, HyperFrames 0.7.57, FFmpeg/FFprobe, `node:test`

---

### Task 1: Compile and capture trusted click geometry

**Files:**
- Modify: `src/domain/execution-calls.js:4-74`
- Modify: `src/adapters/mcp-gateway.js:12-30, 341-390, 561-617, 770-875, 1165-1215`
- Modify: `src/adapters/browser-runtime.js:37-48, 1257-1338, 1419-1485`
- Modify: `src/adapters/opencode-client.js`
- Modify: `src/adapters/opencode-server.js`
- Modify: `.opencode/agents/manual-video-executor.md:4-32`
- Test: `test/domain/execution-calls.test.js`
- Test: `test/adapters/mcp-gateway.test.js`
- Test: `test/adapters/browser-runtime.test.js`
- Test: `test/adapters/opencode-config.test.js`

**Step 1: Write failing execution-call tests**

Add assertions that each `browser_click` is immediately preceded by one generated `browser_evaluate` call whose ID is `<business-call-id>.highlight-bounds`, whose target and optional element equal the click arguments, and whose function equals an exported immutable `CLICK_GEOMETRY_FUNCTION`.

```js
assert.deepEqual(calls.slice(clickIndex - 1, clickIndex + 1), [
  {
    id: "open-menu.click.highlight-bounds",
    tool: "browser_evaluate",
    arguments: {
      element: "프로필 메뉴",
      target: "e11",
      function: CLICK_GEOMETRY_FUNCTION,
    },
  },
  approvedClick,
]);
```

Also prove wait/type calls receive no probe and blocked plans still fail before compilation.

**Step 2: Run the focused test and confirm RED**

Run: `node --test test/domain/execution-calls.test.js`

Expected: FAIL because the queue has no geometry probe and the constant is not exported.

**Step 3: Implement minimal queue expansion**

Export one fixed function string that instant-scrolls the target and returns its DOM rectangle. Insert a frozen probe before every click while preserving all existing system, dwell, evidence, and stop calls.

**Step 4: Run the execution-call test and confirm GREEN**

Run: `node --test test/domain/execution-calls.test.js`

Expected: PASS.

**Step 5: Write failing gateway and runtime tests**

Cover a valid Playwright MCP evaluate response and failures for malformed JSON, extra result fields, NaN/infinite/fractional normalization errors, zero area, out-of-frame geometry, duplicate records, stale generation/digest, wrong expected IDs, and mutated function/target arguments. Assert immutable ordered output from `readExecutionHighlights()`.

Use the actual 0.0.78 response shape:

```js
{
  result: {
    content: [{ type: "text", text: JSON.stringify({ result: '{"x":8,"y":121,"width":127,"height":24}' }) }],
  },
}
```

Adjust the fixture to the exact local MCP serialization discovered by the focused test if necessary; do not accept multiple shapes in production.

**Step 6: Run gateway/runtime tests and confirm RED**

Run: `node --test test/adapters/mcp-gateway.test.js test/adapters/browser-runtime.test.js test/adapters/opencode-config.test.js`

Expected: FAIL because evaluate is not in the execution authority and no geometry API exists.

**Step 7: Implement fail-closed capture**

- Permit `browser_evaluate` only through the installed exact execution queue and executor permission surface.
- Parse the successful response only for generated `.highlight-bounds` call IDs.
- Normalize outward to safe integers and require the rectangle to fit 1920x1080.
- Store immutable generation-owned records in the gateway.
- Add exact binding validation to gateway and browser-runtime `readExecutionHighlights()`.
- Keep planning evaluation denied.

**Step 8: Run focused tests and confirm GREEN**

Run: `node --test test/domain/execution-calls.test.js test/adapters/mcp-gateway.test.js test/adapters/browser-runtime.test.js test/adapters/opencode-config.test.js`

Expected: all focused tests PASS with zero failures.

**Step 9: Commit**

```powershell
git add src/domain/execution-calls.js src/adapters/mcp-gateway.js src/adapters/browser-runtime.js src/adapters/opencode-client.js src/adapters/opencode-server.js .opencode/agents/manual-video-executor.md test/domain/execution-calls.test.js test/adapters/mcp-gateway.test.js test/adapters/browser-runtime.test.js test/adapters/opencode-config.test.js
git commit -m "feat: capture approved click geometry"
```

### Task 2: Bind geometry to measured click timing

**Files:**
- Create: `src/domain/execution-highlights.js`
- Modify: `src/workflow/execution.js:65-106, 420-529, 739-813`
- Test: `test/domain/execution-report.test.js`
- Test: `test/workflow/execution.test.js`

**Step 1: Write failing domain-binder tests**

Specify a coordinator-only `bindExecutionHighlights(report, candidates, { plan, planDigest })` contract. A valid result must append an immutable `clickHighlights` array without changing the validated executor fields:

```js
assert.deepEqual(bound.clickHighlights, [{
  stepId: "open-menu",
  callId: "open-menu.click",
  at: "2026-07-15T00:00:00.500Z",
  x: 8,
  y: 121,
  width: 127,
  height: 24,
}]);
```

Reject unknown step/call IDs, non-click calls, duplicate/missing approved clicks, timestamps outside the step/report, extra fields, unsafe prototypes, and invalid bounds. Add a report test proving executor-authored `clickHighlights` remains an invalid extra top-level field.

**Step 2: Run domain tests and confirm RED**

Run: `node --test test/domain/execution-report.test.js`

Expected: FAIL because the coordinator binder does not exist.

**Step 3: Implement the pure binder**

Create an exact-object, dense-array validator that maps every approved `browser_click` to its owning step and returns a frozen report clone with a frozen `clickHighlights` array. Do not loosen `validateExecutionReport()` or its executor candidate schema.

**Step 4: Run domain tests and confirm GREEN**

Run: `node --test test/domain/execution-report.test.js`

Expected: PASS.

**Step 5: Write failing workflow tests**

Extend the execution fixture with `readExecutionHighlights()`. Assert that the workflow:

- requests the exact generated probe IDs for the active job/generation/digest;
- combines the probe geometry with the measured start of the following click call;
- persists one bound record per approved click;
- rejects missing, duplicate, stale, reordered, or forged geometry;
- never trusts OpenCode candidate text for click metadata.

**Step 6: Run workflow tests and confirm RED**

Run: `node --test test/workflow/execution.test.js`

Expected: FAIL because execution neither requires nor binds geometry.

**Step 7: Implement workflow binding**

Add `readExecutionHighlights` to dependency validation. After timing and artifact ownership are proven, read exact probe records, pair them with compiled click calls and measured start times, call the pure binder, and persist only the bound result. Preserve mismatch behavior without requiring highlights for unexecuted clicks.

**Step 8: Run focused tests and confirm GREEN**

Run: `node --test test/domain/execution-report.test.js test/workflow/execution.test.js`

Expected: all tests PASS.

**Step 9: Commit**

```powershell
git add src/domain/execution-highlights.js src/workflow/execution.js test/domain/execution-report.test.js test/workflow/execution.test.js
git commit -m "feat: bind click timing to execution reports"
```

### Task 3: Preserve multiple click cues through media planning

**Files:**
- Modify: `src/media/producer.js:467-559, 1103-1187, 1326-1364, 1645-1662`
- Modify: `src/media/media-plan.js:10-20, 143-185, 258-325`
- Test: `test/media/producer.test.js`
- Test: `test/media/media-plan.test.js`
- Test: `test/workflow/media.test.js`

**Step 1: Write failing producer tests**

Update the report fixture with trusted `clickHighlights`. Assert the action scene receives every approved click while the wait scene receives `highlights: []`. Add a long-dwell regression matching the real failure: the trimmed source window must shift early enough to retain 250 ms pre-roll and 900 ms post-roll without increasing its narration-sized duration.

Add a second click in one step and assert both survive in order. Add an impossible-span test that fails with a bounded producer reason instead of omitting one cue.

**Step 2: Run producer tests and confirm RED**

Run: `node --test test/media/producer.test.js`

Expected: FAIL because `reportBinding()` hardcodes `highlight: null` and trimming ignores click time.

**Step 3: Implement report-to-scene propagation and click-aware trimming**

- Validate that completed reports have one trusted highlight for every approved click and none for non-click calls.
- Convert ISO click times to source milliseconds relative to report start.
- Replace singular `highlight` with ordered `highlights` arrays.
- Shift capped action windows to contain the complete click cue span while keeping source duration stable.
- Reject an impossible cue span with `PRODUCER_HIGHLIGHT_INVALID` and a bounded reason.
- Preserve highlights through caption/narration rebuilds.

**Step 4: Run producer tests and confirm GREEN**

Run: `node --test test/media/producer.test.js`

Expected: PASS.

**Step 5: Write failing media-plan tests**

Change scene input fixtures to source-timed cues:

```js
highlights: [{
  callId: "open-menu.click",
  sourceAtMs: 600,
  x: 8,
  y: 121,
  width: 127,
  height: 24,
}]
```

Assert conversion through playback rate produces deterministic absolute `startMs` and 900 ms `durationMs`. Cover multiple ordered cues, cue/scene boundary clamping, duplicate call IDs, fractional/negative/out-of-frame geometry, timestamps outside the source scene, sparse arrays, unknown fields, and empty arrays.

**Step 6: Run media tests and confirm RED**

Run: `node --test test/media/media-plan.test.js test/workflow/media.test.js`

Expected: FAIL because the schema still accepts only singular static rectangles.

**Step 7: Implement the timed `highlights` contract**

Replace `scene.highlight` with exact dense `scene.highlights`. Validate source timestamps and geometry, calculate each final start through the selected playback rate, use a fixed 900 ms duration, require the cue to stay in its owning output scene, and emit media-plan schema version `1.1`. Preserve deterministic ordering by source time then call ID.

**Step 8: Run focused media tests and confirm GREEN**

Run: `node --test test/media/producer.test.js test/media/media-plan.test.js test/workflow/media.test.js`

Expected: all tests PASS.

**Step 9: Commit**

```powershell
git add src/media/producer.js src/media/media-plan.js test/media/producer.test.js test/media/media-plan.test.js test/workflow/media.test.js
git commit -m "feat: carry timed clicks into media plans"
```

### Task 4: Render deterministic HyperFrames click pulses

**Files:**
- Modify: `src/media/composition.js:246-319, 372-389`
- Modify: `templates/hyperframes/index.html:7-34`
- Test: `test/media/composition.test.js`
- Test: `test/adapters/hyperframes.test.js`

**Step 1: Write failing composition tests**

Assert one unique clip per cue, with deterministic IDs and distinct tracks:

```html
<div id="highlight-step_1-0" class="click-highlight clip" data-start="0.180" data-duration="0.9">
  <span class="click-target"></span>
  <span class="click-ripple"></span>
</div>
```

Verify padded/clamped rectangle CSS variables, center coordinates, safe HTML, finite timing, no runtime network/randomness, and non-overlapping track allocation for multiple scenes and clicks.

**Step 2: Run composition tests and confirm RED**

Run: `node --test test/media/composition.test.js`

Expected: FAIL because composition supports only one scene-long static `action-highlight`.

**Step 3: Implement pulse DOM and CSS**

- Validate schema `1.1` and exact timed cue fields.
- Generate one clip per cue at its absolute output time for 900 ms.
- Pad the target rectangle by 12 px and clamp it to frame bounds.
- Render a purple-blue rounded outline plus two center ripples.
- Use deterministic CSS keyframes compatible with HyperFrames capture.
- Remove the obsolete scene-long static highlight class.

**Step 4: Run composition tests and confirm GREEN**

Run: `node --test test/media/composition.test.js`

Expected: PASS.

**Step 5: Update the live HyperFrames golden test**

Feed at least two timed cues into the golden composition. Assert lint/check remain warning-free, strict render succeeds, FFprobe reports H.264 video and expected dimensions/duration, and sampled rendered pixels differ inside the cue region during the cue but not before it.

**Step 6: Run HyperFrames tests and confirm GREEN**

Run: `node --test test/adapters/hyperframes.test.js`

Expected: PASS, or only the existing documented environment skip when HyperFrames live prerequisites are unavailable.

**Step 7: Commit**

```powershell
git add src/media/composition.js templates/hyperframes/index.html test/media/composition.test.js test/adapters/hyperframes.test.js
git commit -m "feat: render timed click pulses"
```

### Task 5: Full regression and real-video proof

**Files:**
- Modify if needed: `scripts/verify.mjs`
- Modify: `README.md`
- Test: all focused and full suites
- Artifact: a new job under `data/jobs/<job-id>/artifacts/final.mp4`

**Step 1: Run the complete automated verification**

Run: `npm run verify`

Expected: exit 0 with zero test failures, zero lint/build failures, and only documented environment skips.

**Step 2: Start the checked local stack**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start.ps1 -Check`

Expected: OpenCode >=1.17.19, Playwright MCP 0.0.78, HyperFrames 0.7.57, FFmpeg, and Supertonic report ready.

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start.ps1`

Expected: studio available at `http://127.0.0.1:4317`.

**Step 3: Execute the deterministic click fixture E2E**

Create and approve a local fixture job that clicks `프로젝트 메뉴 열기`, waits, clicks `Manual Video`, and waits for the completion text. Let the normal pipeline produce preview and final artifacts; do not inject test-only coordinates.

Expected:

- the execution report contains two coordinator-owned click records;
- click scenes contain non-empty timed `highlights`, wait scenes contain `[]`;
- `composition/index.html` contains two click pulse clips;
- final video remains 1920x1080 H.264/AAC at 30 fps.

**Step 4: Verify sampled final-video frames**

Use FFmpeg to extract frames before, during, and after each cue from `artifacts/final.mp4`. Compare the known cue region to prove the purple-blue outline/ripple appears only during each 900 ms interval. Produce a contact sheet for human inspection.

Expected: both click targets have a visible cue; neither wait scene has a false cue.

**Step 5: Update documentation**

Document that click geometry is collected from the approved locator and rendered in post-production, so it works across sites and survives navigation. Keep the dependency and OpenCode compatibility statements unchanged.

**Step 6: Run fresh final verification**

Run: `npm run verify`

Expected: exit 0, all tests passing, and no unexpected skips.

Run: `git diff --check`

Expected: no output and exit 0.

**Step 7: Commit**

```powershell
git add README.md scripts/verify.mjs
git commit -m "test: verify click highlights end to end"
```

Skip the commit when `scripts/verify.mjs` needs no change and README was already updated in an earlier task. Do not commit generated job artifacts.
