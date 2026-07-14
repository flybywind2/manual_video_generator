import { extname } from "node:path/posix";

import { StudioError } from "../domain/errors.js";
import { MAX_STEP_NARRATION_CODE_UNITS } from "../domain/plan.js";

export const MIN_PLAYBACK_RATE = 0.9;
export const MAX_PLAYBACK_RATE = 1.1;
export const MAX_MEDIA_DRIFT_MS = 500;

const INPUT_FIELDS = Object.freeze(["recordingPath", "scenes", "narrations"]);
const SCENE_FIELDS = Object.freeze([
  "id",
  "sourceStartMs",
  "sourceEndMs",
  "caption",
  "chapter",
  "highlight",
]);
const NARRATION_FIELDS = Object.freeze(["sceneId", "path", "durationMs", "text"]);
const HIGHLIGHT_FIELDS = Object.freeze(["x", "y", "width", "height"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function mediaPlanError(code, reason) {
  throw new StudioError("The media plan is invalid.", {
    code,
    stage: "composing",
    retryable: code === "MEDIA_DRIFT_EXCEEDED",
    details: { reason },
  });
}

function ownData(value, fields, reason) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    mediaPlanError("INVALID_MEDIA_PLAN", reason);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    !keys.every((key) => typeof key === "string" && fields.includes(key))
  ) {
    mediaPlanError("INVALID_MEDIA_PLAN", `${reason}_fields`);
  }
  const result = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      mediaPlanError("INVALID_MEDIA_PLAN", `${reason}_data_properties`);
    }
    result[field] = descriptor.value;
  }
  return result;
}

function denseArray(value, reason, { minimum = 1, maximum = 100 } = {}) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    mediaPlanError("INVALID_MEDIA_PLAN", reason);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      mediaPlanError("INVALID_MEDIA_PLAN", `${reason}_sparse`);
    }
  }
  return value;
}

function cleanText(value, reason, maximum) {
  if (typeof value !== "string") {
    mediaPlanError("INVALID_MEDIA_PLAN", reason);
  }
  const text = value.trim();
  if (
    text.length < 1 ||
    text.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
  ) {
    mediaPlanError("INVALID_MEDIA_PLAN", reason);
  }
  return text;
}

function identifier(value, reason) {
  const id = cleanText(value, reason, 64);
  if (!ID_PATTERN.test(id)) {
    mediaPlanError("INVALID_MEDIA_PLAN", reason);
  }
  return id;
}

function milliseconds(value, reason) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 24 * 60 * 60 * 1_000) {
    mediaPlanError("INVALID_MEDIA_PLAN", reason);
  }
  return value;
}

function assetPath(value, reason, extension) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1_024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.includes("?") ||
    value.includes("#") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
  ) {
    mediaPlanError("INVALID_MEDIA_PLAN", reason);
  }
  const segments = value.split("/");
  if (
    segments.length < 2 ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        !PATH_SEGMENT.test(segment),
    ) ||
    extname(value).toLowerCase() !== extension
  ) {
    mediaPlanError("INVALID_MEDIA_PLAN", reason);
  }
  return value;
}

function normalizedHighlight(value) {
  if (value === null) {
    return null;
  }
  const fields = ownData(value, HIGHLIGHT_FIELDS, "highlight");
  for (const field of HIGHLIGHT_FIELDS) {
    if (!Number.isSafeInteger(fields[field])) {
      mediaPlanError("INVALID_MEDIA_PLAN", "highlight_integer_required");
    }
  }
  if (
    fields.x < 0 ||
    fields.y < 0 ||
    fields.width < 1 ||
    fields.height < 1 ||
    fields.x + fields.width > 1_920 ||
    fields.y + fields.height > 1_080
  ) {
    mediaPlanError("INVALID_MEDIA_PLAN", "highlight_out_of_bounds");
  }
  return Object.freeze({
    x: fields.x,
    y: fields.y,
    width: fields.width,
    height: fields.height,
  });
}

function normalizedScene(candidate) {
  const fields = ownData(candidate, SCENE_FIELDS, "scene");
  const startMs = milliseconds(fields.sourceStartMs, "scene_start");
  const endMs = milliseconds(fields.sourceEndMs, "scene_end");
  if (endMs <= startMs) {
    mediaPlanError("INVALID_MEDIA_PLAN", "scene_range");
  }
  return {
    id: identifier(fields.id, "scene_id"),
    sourceStartMs: startMs,
    sourceEndMs: endMs,
    caption: cleanText(fields.caption, "scene_caption", 4_000),
    chapter: cleanText(fields.chapter, "scene_chapter", 200),
    highlight: normalizedHighlight(fields.highlight),
  };
}

function normalizedNarration(candidate) {
  const fields = ownData(candidate, NARRATION_FIELDS, "narration");
  const durationMs = milliseconds(fields.durationMs, "narration_duration");
  if (durationMs < 1) {
    mediaPlanError("INVALID_MEDIA_PLAN", "narration_duration");
  }
  return {
    sceneId: identifier(fields.sceneId, "narration_scene_id"),
    path: assetPath(fields.path, "narration_path", ".wav"),
    durationMs,
    text: cleanText(
      fields.text,
      "narration_text",
      MAX_STEP_NARRATION_CODE_UNITS,
    ),
  };
}

function roundSix(value) {
  return Number(value.toFixed(6));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function createMediaPlan(candidate) {
  const input = ownData(candidate, INPUT_FIELDS, "media_plan");
  const recordingPath = assetPath(input.recordingPath, "recording_path", ".mp4");
  const scenes = denseArray(input.scenes, "scenes").map(normalizedScene);
  const narrations = denseArray(input.narrations, "narrations").map(normalizedNarration);

  const sceneIds = new Set();
  for (const scene of scenes) {
    if (sceneIds.has(scene.id)) {
      mediaPlanError("INVALID_MEDIA_PLAN", "duplicate_scene_id");
    }
    sceneIds.add(scene.id);
  }
  const narrationByScene = new Map();
  for (const narration of narrations) {
    if (narrationByScene.has(narration.sceneId)) {
      mediaPlanError("INVALID_MEDIA_PLAN", "duplicate_narration_scene_id");
    }
    narrationByScene.set(narration.sceneId, narration);
  }
  if (
    narrationByScene.size !== sceneIds.size ||
    [...sceneIds].some((id) => !narrationByScene.has(id)) ||
    [...narrationByScene].some(([id]) => !sceneIds.has(id))
  ) {
    mediaPlanError("INVALID_MEDIA_PLAN", "scene_narration_mismatch");
  }

  scenes.sort(
    (left, right) =>
      left.sourceStartMs - right.sourceStartMs || left.id.localeCompare(right.id, "en"),
  );
  for (let index = 1; index < scenes.length; index += 1) {
    if (scenes[index].sourceStartMs < scenes[index - 1].sourceEndMs) {
      mediaPlanError("INVALID_MEDIA_PLAN", "overlapping_scenes");
    }
  }

  let outputStartMs = 0;
  const plannedScenes = [];
  const captions = [];
  const chapters = [];
  for (const scene of scenes) {
    const narration = narrationByScene.get(scene.id);
    const sourceDurationMs = scene.sourceEndMs - scene.sourceStartMs;
    const desiredPlaybackRate = sourceDurationMs / narration.durationMs;
    const playbackRate = Math.min(
      MAX_PLAYBACK_RATE,
      Math.max(MIN_PLAYBACK_RATE, desiredPlaybackRate),
    );
    const adjustedVideoDurationMs = sourceDurationMs / playbackRate;
    const driftMs = Math.round(Math.abs(adjustedVideoDurationMs - narration.durationMs));
    if (driftMs > MAX_MEDIA_DRIFT_MS) {
      mediaPlanError("MEDIA_DRIFT_EXCEEDED", "scene_media_drift");
    }
    const outputDurationMs = Math.max(
      narration.durationMs,
      Math.round(adjustedVideoDurationMs),
    );
    const outputEndMs = outputStartMs + outputDurationMs;
    const caption = {
      text: scene.caption,
      startMs: outputStartMs,
      endMs: outputStartMs + narration.durationMs,
    };
    plannedScenes.push({
      id: scene.id,
      source: {
        startMs: scene.sourceStartMs,
        endMs: scene.sourceEndMs,
        durationMs: sourceDurationMs,
        playbackRate: roundSix(playbackRate),
      },
      output: {
        startMs: outputStartMs,
        endMs: outputEndMs,
        durationMs: outputDurationMs,
      },
      narration: {
        path: narration.path,
        durationMs: narration.durationMs,
        text: narration.text,
      },
      caption,
      chapter: scene.chapter,
      highlight: scene.highlight,
      driftMs,
    });
    captions.push({ sceneId: scene.id, ...caption });
    chapters.push({ sceneId: scene.id, startMs: outputStartMs, label: scene.chapter });
    outputStartMs = outputEndMs;
  }

  return deepFreeze({
    schemaVersion: "1.0",
    video: {
      width: 1_920,
      height: 1_080,
      fps: 30,
      durationMs: outputStartMs,
    },
    recordingPath,
    scenes: plannedScenes,
    captions,
    chapters,
  });
}
