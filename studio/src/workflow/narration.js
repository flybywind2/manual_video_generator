import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { ALLOWED_SUPERTONIC_VOICES } from "../adapters/supertonic-client.js";
import { StudioError } from "../domain/errors.js";
import { MAX_STEP_NARRATION_CODE_UNITS } from "../domain/plan.js";
const VOICES = new Set(ALLOWED_SUPERTONIC_VOICES);
const SAMPLE_RATE = 44_100;
const SUPERTONIC_VERSION = "1.3.1";
const MAX_SCENES = 999;
const MANIFEST_NAME = "narration.json";
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const activeOutputDirectories = new Set();

function workflowError(message, { code, retryable = false, details = {} }) {
  return new StudioError(message, {
    code,
    stage: "narration",
    retryable,
    details,
  });
}

function cancellationError() {
  return workflowError("Narration generation was cancelled.", {
    code: "NARRATION_CANCELLED",
    retryable: true,
  });
}

function isCancellationError(error) {
  return ["NARRATION_CANCELLED", "SUPERTONIC_CANCELLED"].includes(error?.code);
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    throw cancellationError();
  }
}

function outputLockKey(outputDirectory) {
  return process.platform === "win32"
    ? outputDirectory.toLowerCase()
    : outputDirectory;
}

async function withOutputLock(outputDirectory, operation) {
  const key = outputLockKey(outputDirectory);
  if (activeOutputDirectories.has(key)) {
    throw workflowError("Another narration writer owns this output directory.", {
      code: "NARRATION_OUTPUT_BUSY",
      retryable: true,
    });
  }
  activeOutputDirectories.add(key);
  try {
    return await operation();
  } finally {
    activeOutputDirectories.delete(key);
  }
}

function canonicalPath(value) {
  const normalized = resolve(value).replace(/^\\\\\?\\/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function unsafeOutputPath() {
  return workflowError("The narration output path is unsafe.", {
    code: "NARRATION_UNSAFE_OUTPUT_PATH",
  });
}

function sameDirectory(left, right) {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

async function requireSafeDirectory(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw unsafeOutputPath();
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw unsafeOutputPath();
  }
  if (canonicalPath(await realpath(path)) !== canonicalPath(path)) {
    throw unsafeOutputPath();
  }
  return metadata;
}

async function ensureOutputDirectory(outputDirectory, { create }) {
  await requireSafeDirectory(dirname(outputDirectory));
  if (create) {
    try {
      await mkdir(outputDirectory, { recursive: false });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
  }
  return requireSafeDirectory(outputDirectory);
}

function normalizeInputs({ plan, outputDirectory, client, voice, signal }) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > MAX_SCENES) {
    throw workflowError("The approved plan has no valid narration scenes.", {
      code: "NARRATION_INVALID_PLAN",
    });
  }
  if (typeof outputDirectory !== "string" || !isAbsolute(outputDirectory)) {
    throw workflowError("A full narration output directory is required.", {
      code: "NARRATION_INVALID_OUTPUT_DIRECTORY",
    });
  }
  if (
    !client ||
    typeof client.synthesize !== "function" ||
    typeof client.health !== "function"
  ) {
    throw workflowError("A Supertonic client is required.", {
      code: "NARRATION_INVALID_CLIENT",
    });
  }
  const normalizedOutputDirectory = resolve(outputDirectory);
  const normalizedClientRoot =
    typeof client.outputRoot === "string" && isAbsolute(client.outputRoot)
      ? resolve(client.outputRoot)
      : undefined;
  const pathsMatch =
    normalizedClientRoot !== undefined &&
    (process.platform === "win32"
      ? normalizedClientRoot.toLowerCase() === normalizedOutputDirectory.toLowerCase()
      : normalizedClientRoot === normalizedOutputDirectory);
  if (!pathsMatch) {
    throw workflowError(
      "The Supertonic client is not bound to this narration directory.",
      { code: "NARRATION_OUTPUT_ROOT_MISMATCH" },
    );
  }
  if (!VOICES.has(voice)) {
    throw workflowError("Only built-in Supertonic voice presets are allowed.", {
      code: "NARRATION_VOICE_NOT_ALLOWED",
    });
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw workflowError("The narration cancellation signal is invalid.", {
      code: "NARRATION_INVALID_SIGNAL",
    });
  }

  const ids = new Set();
  const scenes = plan.steps.map((step, index) => {
    if (
      !step ||
      typeof step.id !== "string" ||
      step.id.length < 1 ||
      step.id.length > 128 ||
      ids.has(step.id) ||
      typeof step.narration !== "string" ||
      step.narration.trim().length < 1 ||
      step.narration.length > MAX_STEP_NARRATION_CODE_UNITS
    ) {
      throw workflowError("A plan step has invalid narration metadata.", {
        code: "NARRATION_INVALID_PLAN",
        details: { order: index + 1 },
      });
    }
    ids.add(step.id);
    return Object.freeze({
      sceneId: step.id,
      order: index + 1,
      text: step.narration,
      file: `scene-${String(index + 1).padStart(3, "0")}.wav`,
    });
  });

  return {
    outputDirectory: normalizedOutputDirectory,
    client,
    voice,
    signal,
    scenes,
  };
}

async function requirePinnedHealth(client, signal) {
  const health = await client.health({ signal });
  if (
    health?.status !== "ok" ||
    health.model !== "supertonic-3" ||
    health.sampleRate !== SAMPLE_RATE ||
    health.version !== SUPERTONIC_VERSION ||
    !Number.isInteger(health.voicesLoaded) ||
    health.voicesLoaded < ALLOWED_SUPERTONIC_VOICES.length
  ) {
    throw workflowError("The local Supertonic runtime is not the pinned service.", {
      code: "NARRATION_SUPERTONIC_UNHEALTHY",
    });
  }
}

function pendingScene(scene, attempts = 0) {
  return {
    sceneId: scene.sceneId,
    order: scene.order,
    text: scene.text,
    status: "pending",
    file: null,
    attempts,
  };
}

function readyScene(scene, result, attempts) {
  return {
    sceneId: scene.sceneId,
    order: scene.order,
    text: scene.text,
    status: "ready",
    file: scene.file,
    durationSeconds: result.durationSeconds,
    sampleRate: result.sampleRate,
    bytes: result.bytes,
    attempts,
  };
}

function safeSynthesisError(error) {
  const code =
    typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
      ? error.code
      : "NARRATION_SYNTHESIS_FAILED";
  const stage =
    typeof error?.stage === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(error.stage)
      ? error.stage
      : "narration";
  return {
    code,
    stage,
    retryable: Boolean(error?.retryable),
  };
}

function failedScene(scene, attempts, error) {
  return {
    sceneId: scene.sceneId,
    order: scene.order,
    text: scene.text,
    status: "failed",
    file: null,
    attempts,
    error: safeSynthesisError(error),
  };
}

function manifestStatus(manifest, inProgress = false) {
  if (inProgress) {
    return "generating";
  }
  return manifest.scenes.every((scene) => scene.status === "ready")
    ? "ready"
    : "failed";
}

async function publishManifest(outputDirectory, manifest, inProgress = false) {
  manifest.status = manifestStatus(manifest, inProgress);
  const source = Buffer.from(JSON.stringify(manifest), "utf8");
  if (source.length > MAX_MANIFEST_BYTES) {
    throw workflowError("The narration manifest is too large.", {
      code: "NARRATION_INVALID_PLAN",
    });
  }
  const initialDirectory = await ensureOutputDirectory(outputDirectory, {
    create: false,
  });
  const target = join(outputDirectory, MANIFEST_NAME);
  let existing;
  try {
    existing = await lstat(target);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (
    existing !== undefined &&
    (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
  ) {
    throw unsafeOutputPath();
  }

  const temporary = join(
    outputDirectory,
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  let published = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(source);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const finalDirectory = await ensureOutputDirectory(outputDirectory, {
      create: false,
    });
    if (!sameDirectory(initialDirectory, finalDirectory)) {
      throw unsafeOutputPath();
    }
    await rename(temporary, target);
    const finalManifest = await lstat(target);
    if (
      !finalManifest.isFile() ||
      finalManifest.isSymbolicLink() ||
      finalManifest.nlink !== 1 ||
      finalManifest.size !== source.length
    ) {
      throw unsafeOutputPath();
    }
    published = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published) {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function invalidClip() {
  return workflowError("The synthesized clip is not valid PCM WAV audio.", {
    code: "NARRATION_INVALID_CLIP",
  });
}

function sameFile(left, right) {
  return (
    left.isFile() &&
    right.isFile() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.nlink === 1 &&
    right.nlink === 1
  );
}

async function readExact(handle, length, position) {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await handle.read(bytes, 0, length, position);
  if (bytesRead !== length) {
    throw invalidClip();
  }
  return bytes;
}

async function inspectPublishedWav(outputPath, result) {
  const pathMetadata = await lstat(outputPath);
  if (
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    pathMetadata.nlink !== 1 ||
    pathMetadata.size !== result.bytes ||
    pathMetadata.size < 44 ||
    pathMetadata.size > 256 * 1024 * 1024
  ) {
    throw invalidClip();
  }

  const handle = await open(outputPath, "r");
  try {
    const openedMetadata = await handle.stat();
    if (!sameFile(pathMetadata, openedMetadata)) {
      throw invalidClip();
    }
    const riff = await readExact(handle, 12, 0);
    if (
      riff.subarray(0, 4).toString("ascii") !== "RIFF" ||
      riff.subarray(8, 12).toString("ascii") !== "WAVE" ||
      riff.readUInt32LE(4) !== openedMetadata.size - 8
    ) {
      throw invalidClip();
    }

    let offset = 12;
    let format;
    let dataBytes;
    while (offset < openedMetadata.size) {
      if (offset + 8 > openedMetadata.size) {
        throw invalidClip();
      }
      const chunk = await readExact(handle, 8, offset);
      const chunkId = chunk.subarray(0, 4).toString("ascii");
      const chunkSize = chunk.readUInt32LE(4);
      const chunkStart = offset + 8;
      const chunkEnd = chunkStart + chunkSize;
      const paddedEnd = chunkEnd + (chunkSize % 2);
      if (chunkEnd > openedMetadata.size || paddedEnd > openedMetadata.size) {
        throw invalidClip();
      }
      if (chunkId === "fmt ") {
        if (format !== undefined || chunkSize < 16) {
          throw invalidClip();
        }
        const body = await readExact(handle, 16, chunkStart);
        format = {
          audioFormat: body.readUInt16LE(0),
          channels: body.readUInt16LE(2),
          sampleRate: body.readUInt32LE(4),
          byteRate: body.readUInt32LE(8),
          blockAlign: body.readUInt16LE(12),
          bitsPerSample: body.readUInt16LE(14),
        };
      } else if (chunkId === "data") {
        if (dataBytes !== undefined || chunkSize === 0) {
          throw invalidClip();
        }
        dataBytes = chunkSize;
      }
      offset = paddedEnd;
    }

    if (
      offset !== openedMetadata.size ||
      format === undefined ||
      dataBytes === undefined ||
      format.audioFormat !== 1 ||
      format.channels !== 1 ||
      format.sampleRate !== SAMPLE_RATE ||
      format.bitsPerSample !== 16 ||
      format.blockAlign !== 2 ||
      format.byteRate !== SAMPLE_RATE * format.blockAlign ||
      dataBytes % format.blockAlign !== 0
    ) {
      throw invalidClip();
    }
    const duration = dataBytes / format.blockAlign / format.sampleRate;
    if (Math.abs(duration - result.durationSeconds) > 0.01) {
      throw invalidClip();
    }

    const [finalOpenedMetadata, finalPathMetadata] = await Promise.all([
      handle.stat(),
      lstat(outputPath),
    ]);
    if (
      !sameFile(openedMetadata, finalOpenedMetadata) ||
      !sameFile(openedMetadata, finalPathMetadata)
    ) {
      throw invalidClip();
    }
  } finally {
    await handle.close();
  }
}

async function validatePublishedClip(outputPath, expected, result) {
  if (
    result?.outputPath !== outputPath ||
    result?.lang !== "ko" ||
    result?.voice !== expected.voice ||
    !Number.isFinite(result?.durationSeconds) ||
    result.durationSeconds <= 0 ||
    result.durationSeconds > 3_600 ||
    result?.sampleRate !== SAMPLE_RATE ||
    !Number.isInteger(result?.bytes) ||
    result.bytes < 44
  ) {
    throw workflowError("The synthesized clip metadata is invalid.", {
      code: "NARRATION_INVALID_CLIP",
    });
  }

  await inspectPublishedWav(outputPath, result);
}

async function synthesizeScene({
  manifest,
  scene,
  sceneIndex,
  outputDirectory,
  client,
  voice,
  signal,
}) {
  const outputPath = join(outputDirectory, scene.file);
  const attempts = (manifest.scenes[sceneIndex]?.attempts ?? 0) + 1;
  manifest.scenes[sceneIndex] = pendingScene(scene, attempts);
  await publishManifest(outputDirectory, manifest, true);

  let cancellation;
  try {
    await rm(outputPath, { force: true });
    const result = await client.synthesize({
      text: scene.text,
      voice,
      outputFile: scene.file,
      signal,
    });
    throwIfCancelled(signal);
    await validatePublishedClip(outputPath, { voice }, result);
    throwIfCancelled(signal);
    manifest.scenes[sceneIndex] = readyScene(scene, result, attempts);
  } catch (error) {
    try {
      await rm(outputPath, { force: true });
    } catch (cleanupError) {
      throw workflowError("A failed narration clip could not be removed.", {
        code: "NARRATION_CLEANUP_FAILED",
        details: { cause: cleanupError?.code ?? "cleanup_failed" },
      });
    }
    cancellation = isCancellationError(error) ? cancellationError() : undefined;
    manifest.scenes[sceneIndex] = failedScene(
      scene,
      attempts,
      cancellation ?? error,
    );
  }
  await publishManifest(outputDirectory, manifest, true);
  if (cancellation !== undefined) {
    throw cancellation;
  }
}

function finalizeCancelledGeneration(manifest, scenes) {
  const error = cancellationError();
  manifest.scenes = manifest.scenes.map((stored, index) =>
    stored.status === "pending"
      ? failedScene(scenes[index], stored.attempts, error)
      : stored,
  );
}

function incompleteError(manifest) {
  const failedScenes = manifest.scenes.filter((scene) => scene.status === "failed");
  return workflowError("One or more narration scenes could not be synthesized.", {
    code: "NARRATION_INCOMPLETE",
    retryable:
      failedScenes.length > 0 &&
      failedScenes.every((scene) => scene.error?.retryable === true),
    details: { failedSceneIds: failedScenes.map((scene) => scene.sceneId) },
  });
}

function createManifest(voice, scenes) {
  return {
    schemaVersion: "1.0",
    status: "generating",
    lang: "ko",
    voice,
    scenes: scenes.map((scene) => pendingScene(scene)),
  };
}

function resultSnapshot(manifest) {
  return structuredClone(manifest);
}

export async function generateNarration(options) {
  const normalized = normalizeInputs(options ?? {});
  return withOutputLock(normalized.outputDirectory, async () => {
    await ensureOutputDirectory(normalized.outputDirectory, { create: true });
    await requirePinnedHealth(normalized.client, normalized.signal);
    const manifest = createManifest(normalized.voice, normalized.scenes);
    await publishManifest(normalized.outputDirectory, manifest, true);

    try {
      for (let index = 0; index < normalized.scenes.length; index += 1) {
        throwIfCancelled(normalized.signal);
        await synthesizeScene({
          manifest,
          scene: normalized.scenes[index],
          sceneIndex: index,
          ...normalized,
        });
        throwIfCancelled(normalized.signal);
      }
    } catch (error) {
      if (!isCancellationError(error)) {
        throw error;
      }
      finalizeCancelledGeneration(manifest, normalized.scenes);
      await publishManifest(normalized.outputDirectory, manifest);
      throw cancellationError();
    }

    await publishManifest(normalized.outputDirectory, manifest);
    if (manifest.status !== "ready") {
      throw incompleteError(manifest);
    }
    return resultSnapshot(manifest);
  });
}

function manifestMatchesPlan(manifest, normalized) {
  return (
    manifest?.schemaVersion === "1.0" &&
    manifest.lang === "ko" &&
    manifest.voice === normalized.voice &&
    Array.isArray(manifest.scenes) &&
    manifest.scenes.length === normalized.scenes.length &&
    manifest.scenes.every((stored, index) => {
      const expected = normalized.scenes[index];
      return (
        stored?.sceneId === expected.sceneId &&
        stored.order === expected.order &&
        stored.text === expected.text &&
        ["ready", "failed"].includes(stored.status) &&
        Number.isInteger(stored.attempts) &&
        stored.attempts >= 0 &&
        (stored.attempts > 0 ||
          (stored.status === "failed" &&
            stored.error?.code === "NARRATION_CANCELLED" &&
            stored.error?.stage === "narration" &&
            stored.error?.retryable === true)) &&
        (stored.status !== "ready" ||
          (stored.file === expected.file &&
            stored.sampleRate === SAMPLE_RATE &&
            Number.isFinite(stored.durationSeconds) &&
            stored.durationSeconds > 0 &&
            Number.isInteger(stored.bytes) &&
            stored.bytes >= 44)) &&
        (stored.status !== "failed" || stored.file === null)
      );
    })
  );
}

async function loadManifest(normalized) {
  let manifest;
  try {
    await ensureOutputDirectory(normalized.outputDirectory, { create: false });
    const manifestPath = join(normalized.outputDirectory, MANIFEST_NAME);
    const pathMetadata = await lstat(manifestPath);
    if (
      !pathMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      pathMetadata.nlink !== 1 ||
      pathMetadata.size < 2 ||
      pathMetadata.size > MAX_MANIFEST_BYTES
    ) {
      throw new Error("unsafe_manifest");
    }
    const handle = await open(manifestPath, "r");
    try {
      const openedMetadata = await handle.stat();
      if (!sameFile(pathMetadata, openedMetadata)) {
        throw new Error("manifest_changed");
      }
      const source = await readExact(handle, openedMetadata.size, 0);
      const finalPathMetadata = await lstat(manifestPath);
      if (!sameFile(openedMetadata, finalPathMetadata)) {
        throw new Error("manifest_changed");
      }
      manifest = JSON.parse(source.toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    throw workflowError("The narration manifest could not be loaded.", {
      code: "NARRATION_MANIFEST_MISMATCH",
    });
  }
  if (!manifestMatchesPlan(manifest, normalized)) {
    throw workflowError("The narration manifest no longer matches the plan.", {
      code: "NARRATION_MANIFEST_MISMATCH",
    });
  }
  return manifest;
}

async function verifyReadySceneFiles(manifest, normalized) {
  try {
    for (const scene of manifest.scenes) {
      if (scene.status !== "ready") {
        continue;
      }
      const outputPath = join(normalized.outputDirectory, scene.file);
      await validatePublishedClip(
        outputPath,
        { voice: normalized.voice },
        {
          outputPath,
          lang: "ko",
          voice: normalized.voice,
          durationSeconds: scene.durationSeconds,
          sampleRate: scene.sampleRate,
          bytes: scene.bytes,
        },
      );
    }
  } catch {
    throw workflowError("A previously completed narration scene is missing or invalid.", {
      code: "NARRATION_MANIFEST_MISMATCH",
    });
  }
}

function retryIndexes(manifest, sceneIds) {
  if (!Array.isArray(sceneIds) || sceneIds.length < 1) {
    throw workflowError("At least one failed scene must be selected for retry.", {
      code: "NARRATION_RETRY_NOT_ALLOWED",
    });
  }
  const unique = new Set(sceneIds);
  if (unique.size !== sceneIds.length || sceneIds.some((id) => typeof id !== "string")) {
    throw workflowError("Narration retry scene IDs are invalid.", {
      code: "NARRATION_RETRY_NOT_ALLOWED",
    });
  }
  const indexes = [];
  for (const id of unique) {
    const index = manifest.scenes.findIndex((scene) => scene.sceneId === id);
    const scene = manifest.scenes[index];
    if (index < 0 || scene.status !== "failed" || scene.error?.retryable !== true) {
      throw workflowError("Only retryable failed narration scenes may be retried.", {
        code: "NARRATION_RETRY_NOT_ALLOWED",
      });
    }
    indexes.push(index);
  }
  return indexes.sort((left, right) => left - right);
}

export async function retryNarrationScenes(options) {
  const normalized = normalizeInputs(options ?? {});
  return withOutputLock(normalized.outputDirectory, async () => {
    await ensureOutputDirectory(normalized.outputDirectory, { create: false });
    await requirePinnedHealth(normalized.client, normalized.signal);
    const manifest = await loadManifest(normalized);
    await verifyReadySceneFiles(manifest, normalized);
    const indexes = retryIndexes(manifest, options?.sceneIds);

    try {
      for (const index of indexes) {
        throwIfCancelled(normalized.signal);
        await synthesizeScene({
          manifest,
          scene: normalized.scenes[index],
          sceneIndex: index,
          ...normalized,
        });
        throwIfCancelled(normalized.signal);
      }
    } catch (error) {
      if (!isCancellationError(error)) {
        throw error;
      }
      await publishManifest(normalized.outputDirectory, manifest);
      throw cancellationError();
    }

    await publishManifest(normalized.outputDirectory, manifest);
    if (manifest.status !== "ready") {
      throw incompleteError(manifest);
    }
    return resultSnapshot(manifest);
  });
}
