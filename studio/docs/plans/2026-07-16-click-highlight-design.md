# Click-Position Highlight Design

**Date:** 2026-07-16
**Status:** Approved

## Problem

The final manual video does not show a reliable click-position highlight. Playwright MCP action annotations are subtle and may disappear during navigation, while the media producer currently assigns `highlight: null` to every real scene.

## Goals

- Collect the real viewport rectangle for every approved `browser_click`.
- Bind geometry to the job, generation, plan digest, step, and call ID.
- Preserve each click through scene trimming and playback-rate conversion.
- Render a visible AI Center-style outline and center ripple for every click.
- Remain generic across websites and reject forged or invalid geometry.

## Non-goals

- Screenshot or video computer-vision inference.
- Site-specific selectors.
- Model-authored arbitrary JavaScript.

## Chosen approach

The coordinator inserts a fixed geometry-probe call immediately before each approved click. The probe uses Playwright MCP `browser_evaluate` against the exact same target locator. Its coordinator-owned function scrolls the element into view with instant behavior, reads `getBoundingClientRect()`, and returns only `x`, `y`, `width`, and `height`.

This use of `browser_evaluate` remains constrained by the exact-call MCP gateway. The gateway accepts it only at the approved queue position with the exact canonical function and target. Planning remains unable to evaluate JavaScript; any changed function, target, order, or extra call quarantines execution.

A targeted `browser_snapshot({ boxes: true })` was considered, but it cannot guarantee that an off-screen element has been scrolled to the location Playwright will click. `browser_highlight` was rejected as the primary solution because its page overlay may disappear during navigation and does not survive post-production trimming.

## Execution queue

Each approved business click expands to:

```text
<call-id>.highlight-bounds  browser_evaluate  fixed geometry function + same target
<call-id>                   browser_click     original approved arguments
```

Non-click calls remain unchanged. Existing video action annotations stay enabled as a supplementary cursor cue, but the final video no longer depends on them.

The geometry function is exported from the execution-call domain module so queue compilation, gateway validation, and tests share one byte-identical constant. The trusted coordinator normalizes finite geometry outward: floor left/top and ceil right/bottom.

## Trusted geometry capture

While handling the probe response, the MCP gateway still knows the approved call ID and generation. It stores only this exact immutable shape:

```json
{
  "approvedCallId": "step_1.1.highlight-bounds",
  "x": 8,
  "y": 121,
  "width": 127,
  "height": 24
}
```

It rejects non-JSON output, unknown fields, non-finite values, zero-area or out-of-frame rectangles, duplicate probe IDs, and responses outside the approved queue. `readExecutionHighlights()` releases records only when job ID, generation, plan digest, queue completion, and expected probe IDs all match. The browser runtime verifies the binding again.

The executor-authored report schema stays unchanged. Untrusted model output cannot add geometry.

## Coordinator binding

After execution, the coordinator combines the approved queue, gateway-measured call timing, and gateway-owned geometry. Each click becomes coordinator-owned metadata:

```json
{
  "stepId": "step_1",
  "callId": "step_1.1",
  "at": "2026-07-16T11:17:53.018Z",
  "x": 8,
  "y": 121,
  "width": 127,
  "height": 24
}
```

`at` is the measured start of the click call, after the probe has made the target visible. A domain binder validates and appends this metadata only after the normal execution report has passed validation. Candidate executor JSON containing highlight fields remains invalid.

## Scene trimming and time conversion

The producer groups trusted highlights by step. Click scenes may contain multiple highlights; wait-only scenes use an empty array.

Long coordinator dwell is still removed, but the source window must contain 250 ms of pre-roll before the earliest click and at least 900 ms after the latest click whenever the narration-sized window can contain that span. The window shifts without growing when possible, preserving the media-drift limit. If it cannot contain every click cue, production fails rather than dropping a click silently.

The media-plan input carries source timestamps. `createMediaPlan()` converts them through the scene playback rate to absolute output timing. Persisted click cues use:

```json
{
  "highlights": [
    {
      "callId": "step_1.1",
      "x": 8,
      "y": 121,
      "width": 127,
      "height": 24,
      "startMs": 180,
      "durationMs": 900
    }
  ]
}
```

Each cue is clamped to its owning scene without moving into a different scene. Empty arrays are explicit; a completed click scene cannot silently degrade to `null`.

## HyperFrames visual

HyperFrames creates one 900 ms clip per cue:

- a rounded target outline padded by 12 px and clamped to 1920x1080;
- a purple-to-blue glow matching the AI Center language;
- two expanding rings centered on the target rectangle, the default Playwright click point;
- a scale/fade animation legible on light and dark pages.

The generated overlay uses DOM/CSS with `pointer-events: none`. It remains visible even when navigation removes the original element.

## Failure behavior

- A failed probe stops at the approved call and reports a bounded tool failure.
- Geometry drift or stale binding quarantines the gateway.
- Missing geometry for a completed click rejects execution output.
- Invalid or out-of-frame geometry rejects production.
- A cue that cannot be retained in its source scene rejects composition.
- Wait-only and non-click steps legitimately persist `highlights: []`.

## Testing strategy

1. Domain queue tests prove every click receives exactly one immutable fixed probe immediately before it, while non-click calls do not.
2. Gateway tests prove valid capture and reject malformed, extra-field, duplicate, stale, reordered, and out-of-bounds geometry.
3. Browser-runtime and workflow tests prove job/generation/digest/call binding and measured click timestamps.
4. Execution-report tests prove executor-authored geometry is rejected while the coordinator binder accepts only approved clicks.
5. Producer tests prove click scenes receive geometry, wait scenes stay empty, trimming retains click windows, and impossible spans fail loudly.
6. Media-plan and composition tests prove multiple timed cues, bounds validation, timeline conversion, and generated pulse clips.
7. HyperFrames tests render timed cues and verify the DOM contract.
8. A real local fixture E2E run regenerates a video and checks click scenes in `media-plan.json`, composition clips, and sampled final frames for the visible purple-blue cue.

## Compatibility

The implementation uses only OpenCode, Playwright MCP, Supertonic, HyperFrames, and FFmpeg. It adds no site-specific behavior and keeps the supported OpenCode range at 1.17.19 or newer. Existing completed jobs remain historical artifacts; new jobs use the timed `highlights` contract.
