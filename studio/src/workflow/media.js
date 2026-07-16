import { timingSafeEqual } from "node:crypto";

import { StudioError } from "../domain/errors.js";
import { MAX_STEP_NARRATION_CODE_UNITS } from "../domain/plan.js";
import { mediaPlanDigest } from "../media/composition.js";

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SHA256_DIGEST = /^[a-f0-9]{64}$/u;
const PRESERVED_CAPTURE_ARTIFACTS = Object.freeze([
  "recording",
  "trace",
  "evidence",
]);
const DOWNSTREAM_ARTIFACTS = Object.freeze([
  "composition",
  "preview",
  "render",
  "quality",
]);

function workflowError(code, message, reason, retryable = false) {
  return new StudioError(message, {
    code,
    stage: "preview_review",
    retryable,
    details: { reason },
  });
}

function jobId(value) {
  if (typeof value !== "string" || !JOB_ID.test(value)) {
    throw workflowError(
      "MEDIA_EDIT_NOT_ALLOWED",
      "The media job identifier is invalid.",
      "invalid_job_id",
    );
  }
  return value;
}

function dependency(value, name, code) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} dependency is required for ${code}`);
  }
  return value;
}

function editableText(value, reason, maximum = 4_000) {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw workflowError(
      "MEDIA_EDIT_NOT_ALLOWED",
      "The media edit text is invalid.",
      reason,
    );
  }
  return value.trim();
}

function assertState(job, expected, code, message) {
  if (
    job === null ||
    typeof job !== "object" ||
    job.state !== expected
  ) {
    throw workflowError(code, message, "job_state_mismatch");
  }
}

function requiredDigest(value, reason) {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    throw workflowError(
      "MEDIA_PREVIEW_STALE",
      "The approved media preview no longer matches the current media plan.",
      reason,
    );
  }
  return value;
}

function sameDigest(left, right) {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function digestMediaPlan(mediaPlan, reason) {
  try {
    return mediaPlanDigest(mediaPlan);
  } catch {
    throw workflowError(
      "MEDIA_PREVIEW_STALE",
      "The approved media preview no longer matches the current media plan.",
      reason,
    );
  }
}

function digestPreviewArtifact(artifact) {
  if (
    artifact === null ||
    typeof artifact !== "object" ||
    Array.isArray(artifact)
  ) {
    throw workflowError(
      "MEDIA_PREVIEW_STALE",
      "The approved media preview no longer matches the current media plan.",
      "missing_preview_artifact",
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(artifact, "mediaPlanDigest");
  if (descriptor === undefined || !("value" in descriptor)) {
    throw workflowError(
      "MEDIA_PREVIEW_STALE",
      "The approved media preview no longer matches the current media plan.",
      "invalid_preview_artifact",
    );
  }
  return requiredDigest(descriptor.value, "invalid_preview_digest");
}

function assertMatchingDigest(actual, expected, reason) {
  if (!sameDigest(actual, expected)) {
    throw workflowError(
      "MEDIA_PREVIEW_STALE",
      "The approved media preview no longer matches the current media plan.",
      reason,
    );
  }
}

function freezeTree(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      freezeTree(child);
    }
    Object.freeze(value);
  }
  return value;
}

function editableManifest(mediaPlan) {
  let clone;
  try {
    clone = structuredClone(mediaPlan);
  } catch {
    throw workflowError(
      "MEDIA_EDIT_NOT_ALLOWED",
      "The media plan cannot be edited safely.",
      "invalid_media_plan",
    );
  }
  if (
    clone === null ||
    typeof clone !== "object" ||
    clone.schemaVersion !== "1.1" ||
    !Array.isArray(clone.scenes) ||
    !Array.isArray(clone.captions) ||
    clone.scenes.length < 1 ||
    clone.scenes.length !== clone.captions.length
  ) {
    throw workflowError(
      "MEDIA_EDIT_NOT_ALLOWED",
      "The media plan cannot be edited safely.",
      "invalid_media_plan",
    );
  }
  return clone;
}

function matchingScene(mediaPlan, sceneId) {
  if (typeof sceneId !== "string" || !JOB_ID.test(sceneId)) {
    throw workflowError(
      "MEDIA_EDIT_NOT_ALLOWED",
      "The media scene identifier is invalid.",
      "invalid_scene_id",
    );
  }
  const matches = mediaPlan.scenes.filter((scene) => scene?.id === sceneId);
  if (matches.length !== 1) {
    throw workflowError(
      "MEDIA_EDIT_NOT_ALLOWED",
      "The selected media scene does not exist.",
      "scene_not_found",
    );
  }
  return matches[0];
}

function applyCaption(mediaPlan, scene, captionText) {
  const captions = mediaPlan.captions.filter((caption) => caption?.sceneId === scene.id);
  if (
    captions.length !== 1 ||
    scene.caption === null ||
    typeof scene.caption !== "object"
  ) {
    throw workflowError(
      "MEDIA_EDIT_NOT_ALLOWED",
      "The selected scene has no editable caption.",
      "caption_not_found",
    );
  }
  scene.caption.text = captionText;
  captions[0].text = captionText;
}

function applyNarration(scene, narrationText) {
  if (
    scene.narration === null ||
    typeof scene.narration !== "object" ||
    typeof scene.narration.text !== "string"
  ) {
    throw workflowError(
      "MEDIA_EDIT_NOT_ALLOWED",
      "The selected scene has no editable narration.",
      "narration_not_found",
    );
  }
  scene.narration.text = narrationText;
}

function editRequest(options) {
  const hasNarration = Object.hasOwn(options, "narrationText");
  const hasCaption = Object.hasOwn(options, "captionText");
  if (!hasNarration && !hasCaption) {
    throw workflowError(
      "MEDIA_EDIT_NOT_ALLOWED",
      "At least one media field must be edited.",
      "empty_edit",
    );
  }
  return {
    narrationText: hasNarration
      ? editableText(
          options.narrationText,
          "invalid_narration_text",
          MAX_STEP_NARRATION_CODE_UNITS,
        )
      : undefined,
    captionText: hasCaption
      ? editableText(options.captionText, "invalid_caption_text")
      : undefined,
  };
}

export async function updateMediaPlan(options = {}) {
  const id = jobId(options.jobId);
  const loadJob = dependency(options.loadJob, "loadJob", "media edit");
  const readMediaPlan = dependency(options.readMediaPlan, "readMediaPlan", "media edit");
  const writeMediaPlan = dependency(options.writeMediaPlan, "writeMediaPlan", "media edit");
  const invalidateArtifacts = dependency(
    options.invalidateArtifacts,
    "invalidateArtifacts",
    "media edit",
  );
  const moveToStage = dependency(options.moveToStage, "moveToStage", "media edit");
  assertState(
    await loadJob(id),
    "preview_review",
    "MEDIA_EDIT_NOT_ALLOWED",
    "Media can only be edited during preview review.",
  );

  const edit = editRequest(options);
  const currentMediaPlan = await readMediaPlan(id);
  const previousMediaPlanDigest = digestMediaPlan(
    currentMediaPlan,
    "invalid_current_media_plan",
  );
  const mediaPlan = editableManifest(currentMediaPlan);
  const scene = matchingScene(mediaPlan, options.sceneId);
  let changed = false;
  if (edit.narrationText !== undefined) {
    changed ||= edit.narrationText !== scene.narration?.text;
    applyNarration(scene, edit.narrationText);
  }
  if (edit.captionText !== undefined) {
    changed ||= edit.captionText !== scene.caption?.text;
    applyCaption(mediaPlan, scene, edit.captionText);
  }
  if (!changed) {
    throw workflowError(
      "MEDIA_EDIT_NOT_ALLOWED",
      "The media edit does not change the approved preview.",
      "unchanged_edit",
    );
  }

  const nextState = edit.narrationText !== undefined ? "narrating" : "composing";
  const invalidated = Object.freeze([
    ...(edit.narrationText !== undefined ? [`narration:${scene.id}`] : []),
    ...DOWNSTREAM_ARTIFACTS,
  ]);
  const nextPlan = freezeTree(mediaPlan);
  const nextMediaPlanDigest = digestMediaPlan(nextPlan, "invalid_edited_media_plan");

  await moveToStage(id, nextState, {
    sceneId: scene.id,
    editType: edit.narrationText !== undefined ? "narration" : "caption",
    expectedState: "preview_review",
    previousMediaPlanDigest,
    nextMediaPlanDigest,
  });
  assertState(
    await loadJob(id),
    nextState,
    "MEDIA_EDIT_NOT_ALLOWED",
    "The media edit transition did not complete safely.",
  );

  // Transition first so a failed compare-and-swap cannot mutate the approved
  // plan or preview. Failures after this point are non-approvable by state.
  await invalidateArtifacts(id, invalidated);
  await writeMediaPlan(id, nextPlan);

  return Object.freeze({
    state: nextState,
    mediaPlan: nextPlan,
    mediaPlanDigest: nextMediaPlanDigest,
    invalidated,
    preserved: PRESERVED_CAPTURE_ARTIFACTS,
  });
}

export async function renderFinal(options = {}) {
  const id = jobId(options.jobId);
  const expectedMediaPlanDigest = requiredDigest(
    options.expectedMediaPlanDigest,
    "missing_expected_media_plan_digest",
  );
  const loadJob = dependency(options.loadJob, "loadJob", "final render");
  const readMediaPlan = dependency(options.readMediaPlan, "readMediaPlan", "final render");
  const render = dependency(options.render, "render", "final render");
  const qualityGate = dependency(options.qualityGate, "qualityGate", "final render");
  assertState(
    await loadJob(id),
    "rendering",
    "MEDIA_RENDER_NOT_ALLOWED",
    "Final media can only render after preview approval.",
  );
  const mediaPlan = await readMediaPlan(id);
  if (
    mediaPlan === null ||
    typeof mediaPlan !== "object" ||
    !Number.isSafeInteger(mediaPlan?.video?.durationMs) ||
    mediaPlan.video.durationMs < 1
  ) {
    throw workflowError(
      "MEDIA_RENDER_NOT_ALLOWED",
      "The final render has no valid media duration contract.",
      "invalid_media_plan",
    );
  }
  assertMatchingDigest(
    digestMediaPlan(mediaPlan, "invalid_render_media_plan"),
    expectedMediaPlanDigest,
    "render_media_plan_changed",
  );
  const renderResult = await render({
    jobId: id,
    mediaPlan,
    signal: options.signal,
  });
  assertState(
    await loadJob(id),
    "rendering",
    "MEDIA_RENDER_NOT_ALLOWED",
    "The media job changed state while the final render was running.",
  );
  assertMatchingDigest(
    digestMediaPlan(
      await readMediaPlan(id),
      "invalid_post_render_media_plan",
    ),
    expectedMediaPlanDigest,
    "media_plan_changed_during_render",
  );
  if (renderResult === null || typeof renderResult !== "object") {
    throw workflowError(
      "MEDIA_RENDER_FAILED",
      "The final renderer returned no media artifact.",
      "invalid_render_result",
      true,
    );
  }
  const quality = await qualityGate({
    jobId: id,
    render: renderResult,
    expectedDurationMs: mediaPlan.video.durationMs,
    signal: options.signal,
  });
  if (quality === null || typeof quality !== "object") {
    throw workflowError(
      "MEDIA_RENDER_FAILED",
      "The final media quality gate returned no result.",
      "invalid_quality_result",
      true,
    );
  }
  assertState(
    await loadJob(id),
    "rendering",
    "MEDIA_RENDER_NOT_ALLOWED",
    "The media job changed state while media quality was being verified.",
  );
  assertMatchingDigest(
    digestMediaPlan(
      await readMediaPlan(id),
      "invalid_post_quality_media_plan",
    ),
    expectedMediaPlanDigest,
    "media_plan_changed_during_quality_gate",
  );
  return Object.freeze({
    render: renderResult,
    quality,
    previewDigest: expectedMediaPlanDigest,
  });
}

export async function approvePreview(options = {}) {
  const id = jobId(options.jobId);
  const expectedPreviewDigest = requiredDigest(
    options.expectedPreviewDigest,
    "missing_expected_preview_digest",
  );
  const loadJob = dependency(options.loadJob, "loadJob", "preview approval");
  const readMediaPlan = dependency(
    options.readMediaPlan,
    "readMediaPlan",
    "preview approval",
  );
  const readPreviewArtifact = dependency(
    options.readPreviewArtifact,
    "readPreviewArtifact",
    "preview approval",
  );
  const moveToStage = dependency(options.moveToStage, "moveToStage", "preview approval");
  assertState(
    await loadJob(id),
    "preview_review",
    "MEDIA_RENDER_NOT_ALLOWED",
    "Only a pending preview can be approved.",
  );
  const [mediaPlan, previewArtifact] = await Promise.all([
    readMediaPlan(id),
    readPreviewArtifact(id),
  ]);
  const currentMediaPlanDigest = digestMediaPlan(
    mediaPlan,
    "invalid_current_media_plan",
  );
  const artifactMediaPlanDigest = digestPreviewArtifact(previewArtifact);
  assertMatchingDigest(
    currentMediaPlanDigest,
    expectedPreviewDigest,
    "requested_preview_is_stale",
  );
  assertMatchingDigest(
    artifactMediaPlanDigest,
    expectedPreviewDigest,
    "preview_artifact_is_stale",
  );
  assertState(
    await loadJob(id),
    "preview_review",
    "MEDIA_RENDER_NOT_ALLOWED",
    "The media job changed state while preview approval was being verified.",
  );
  await moveToStage(id, "rendering", {
    approved: true,
    expectedState: "preview_review",
    previewDigest: expectedPreviewDigest,
  });
  const final = await renderFinal({
    ...options,
    jobId: id,
    expectedMediaPlanDigest: expectedPreviewDigest,
  });
  await moveToStage(id, "completed", {
    previewDigest: expectedPreviewDigest,
    outputPath:
      typeof final.render.outputPath === "string"
        ? final.render.outputPath
        : "rendered",
  });
  return Object.freeze({ state: "completed", ...final });
}

export class MediaWorkflow {
  #dependencies;
  #chains = new Map();

  constructor(dependencies = {}) {
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      throw new TypeError("media workflow dependencies are required");
    }
    this.#dependencies = { ...dependencies };
  }

  #serialize(id, operation) {
    const validId = jobId(id);
    const previous = this.#chains.get(validId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const gate = result.catch(() => undefined).finally(() => {
      if (this.#chains.get(validId) === gate) {
        this.#chains.delete(validId);
      }
    });
    this.#chains.set(validId, gate);
    return result;
  }

  updateMediaPlan(options) {
    return this.#serialize(options?.jobId, () =>
      updateMediaPlan({ ...this.#dependencies, ...options }),
    );
  }

  approvePreview(options) {
    return this.#serialize(options?.jobId, () =>
      approvePreview({ ...this.#dependencies, ...options }),
    );
  }

  renderFinal(options) {
    return this.#serialize(options?.jobId, () =>
      renderFinal({ ...this.#dependencies, ...options }),
    );
  }
}
