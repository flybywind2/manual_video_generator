import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

import { StudioError } from "../domain/errors.js";

export const ALLOWED_SUPERTONIC_VOICES = Object.freeze([
  "M1",
  "M2",
  "M3",
  "M4",
  "M5",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
]);

const ALLOWED_VOICES = new Set(ALLOWED_SUPERTONIC_VOICES);
const EXPECTED_SAMPLE_RATE = 44_100;
const EXPECTED_VERSION = "1.3.1";
const MAX_ERROR_BODY_BYTES = 8_192;
const MAX_AUDIO_BYTES = 256 * 1024 * 1024;
const synthesisQueue = [];
let synthesisActive = false;

function narrationError(message, { code, retryable = false, details = {} }) {
  return new StudioError(message, {
    code,
    stage: "narration",
    retryable,
    details,
  });
}

function cancellationError() {
  return narrationError("The Supertonic request was cancelled.", {
    code: "SUPERTONIC_CANCELLED",
    retryable: true,
  });
}

function drainSynthesisQueue() {
  if (synthesisActive) {
    return;
  }
  const entry = synthesisQueue.shift();
  if (entry === undefined) {
    return;
  }
  if (entry.signal?.aborted) {
    entry.signal.removeEventListener("abort", entry.onAbort);
    entry.reject(cancellationError());
    queueMicrotask(drainSynthesisQueue);
    return;
  }

  synthesisActive = true;
  entry.started = true;
  Promise.resolve()
    .then(entry.operation)
    .then(entry.resolve, entry.reject)
    .finally(() => {
      entry.signal?.removeEventListener("abort", entry.onAbort);
      synthesisActive = false;
      drainSynthesisQueue();
    });
}

function enqueueSynthesis(signal, operation) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancellationError());
      return;
    }
    const entry = {
      signal,
      operation,
      resolve,
      reject,
      started: false,
      onAbort: undefined,
    };
    entry.onAbort = () => {
      if (entry.started) {
        return;
      }
      const index = synthesisQueue.indexOf(entry);
      if (index >= 0) {
        synthesisQueue.splice(index, 1);
      }
      signal.removeEventListener("abort", entry.onAbort);
      reject(cancellationError());
    };
    signal?.addEventListener("abort", entry.onAbort, { once: true });
    synthesisQueue.push(entry);
    drainSynthesisQueue();
  });
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw narrationError("Supertonic base URL is invalid.", {
      code: "SUPERTONIC_INVALID_BASE_URL",
    });
  }

  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    url.protocol !== "http:" ||
    !loopback ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw narrationError("Supertonic must use a plain loopback HTTP origin.", {
      code: "SUPERTONIC_INVALID_BASE_URL",
    });
  }

  return url.origin;
}

function validateTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw narrationError("Supertonic timeout is outside the supported range.", {
      code: "SUPERTONIC_INVALID_TIMEOUT",
    });
  }
  return timeoutMs;
}

function validateSynthesisInput({ text, voice, outputFile, signal }) {
  if (typeof text !== "string" || text.trim().length === 0 || text.length > 20_000) {
    throw narrationError("Narration text is empty or too long.", {
      code: "SUPERTONIC_INVALID_TEXT",
    });
  }
  if (!ALLOWED_VOICES.has(voice)) {
    throw narrationError("Only built-in Supertonic voice presets are allowed.", {
      code: "SUPERTONIC_VOICE_NOT_ALLOWED",
    });
  }
  if (
    typeof outputFile !== "string" ||
    outputFile.length < 1 ||
    outputFile.length > 512 ||
    isAbsolute(outputFile) ||
    outputFile.includes("\\") ||
    extname(outputFile).toLowerCase() !== ".wav"
  ) {
    throw narrationError("A safe relative WAV output file is required.", {
      code: "SUPERTONIC_INVALID_OUTPUT_FILE",
    });
  }
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  const parts = outputFile.split("/");
  if (
    parts.some(
      (part) =>
        part.length < 1 ||
        part.length > 128 ||
        !/^[a-z0-9][a-z0-9._-]*$/iu.test(part) ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        reserved.test(part),
    )
  ) {
    throw narrationError("The WAV output file contains an unsafe path segment.", {
      code: "SUPERTONIC_INVALID_OUTPUT_FILE",
    });
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw narrationError("The cancellation signal is invalid.", {
      code: "SUPERTONIC_INVALID_SIGNAL",
    });
  }
}

function normalizeOutputRoot(value) {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2_048 ||
    !isAbsolute(value) ||
    /^[\\/]{2}/u.test(value) ||
    value.includes("\0")
  ) {
    throw narrationError("The Supertonic output root is invalid.", {
      code: "SUPERTONIC_INVALID_OUTPUT_ROOT",
    });
  }
  return resolve(value);
}

function canonicalPath(value) {
  const normalized = resolve(value).replace(/^\\\\\?\\/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function outputTarget(outputRoot, outputFile) {
  const target = resolve(outputRoot, ...outputFile.split("/"));
  const relation = relative(outputRoot, target);
  if (
    relation.length === 0 ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw narrationError("The WAV output escaped its job-owned root.", {
      code: "SUPERTONIC_INVALID_OUTPUT_FILE",
    });
  }
  return target;
}

function unsafeOutputPath() {
  return narrationError("The Supertonic output path is unsafe.", {
    code: "SUPERTONIC_UNSAFE_OUTPUT_PATH",
  });
}

async function safeDirectoryMetadata(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw unsafeOutputPath();
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw unsafeOutputPath();
  }
  return metadata;
}

async function ensureSafeParent(outputRoot, parent) {
  await safeDirectoryMetadata(outputRoot);
  if (canonicalPath(await realpath(outputRoot)) !== canonicalPath(outputRoot)) {
    throw unsafeOutputPath();
  }

  const relation = relative(outputRoot, parent);
  const segments = relation.length === 0 ? [] : relation.split(sep);
  let current = outputRoot;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current, { recursive: false });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
    await safeDirectoryMetadata(current);
  }
  if (canonicalPath(await realpath(parent)) !== canonicalPath(parent)) {
    throw unsafeOutputPath();
  }
  return safeDirectoryMetadata(parent);
}

async function assertSafeOutputEntry(target) {
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1
  ) {
    throw unsafeOutputPath();
  }
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

function responseContentType(response) {
  return (response.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function positiveDuration(response) {
  const raw = response.headers.get("x-audio-duration");
  const value = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 3_600) {
    throw narrationError("Supertonic returned invalid duration metadata.", {
      code: "SUPERTONIC_INVALID_DURATION",
    });
  }
  return value;
}

function expectedSampleRate(response) {
  const sampleRate = Number(response.headers.get("x-sample-rate"));
  if (!Number.isInteger(sampleRate) || sampleRate !== EXPECTED_SAMPLE_RATE) {
    throw narrationError("Supertonic returned an unexpected sample rate.", {
      code: "SUPERTONIC_INVALID_SAMPLE_RATE",
    });
  }
  return sampleRate;
}

function expectedVersion(response) {
  if (response.headers.get("x-supertonic-version") !== EXPECTED_VERSION) {
    throw narrationError("Supertonic returned an unexpected runtime version.", {
      code: "SUPERTONIC_INVALID_VERSION",
    });
  }
}

function invalidWav() {
  return narrationError("Supertonic returned an invalid PCM WAV payload.", {
    code: "SUPERTONIC_INVALID_AUDIO",
  });
}

function validateWav(bytes, durationSeconds, sampleRate) {
  if (
    bytes.length < 44 ||
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WAVE" ||
    bytes.readUInt32LE(4) !== bytes.length - 8
  ) {
    throw invalidWav();
  }
  if (bytes.length > MAX_AUDIO_BYTES) {
    throw narrationError("Supertonic audio exceeded the local size limit.", {
      code: "SUPERTONIC_INVALID_AUDIO",
    });
  }

  let offset = 12;
  let format;
  let dataBytes;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw invalidWav();
    }
    const chunkId = bytes.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    const paddedEnd = chunkEnd + (chunkSize % 2);
    if (chunkEnd > bytes.length || paddedEnd > bytes.length) {
      throw invalidWav();
    }

    if (chunkId === "fmt ") {
      if (format !== undefined || chunkSize < 16) {
        throw invalidWav();
      }
      format = Object.freeze({
        audioFormat: bytes.readUInt16LE(chunkStart),
        channels: bytes.readUInt16LE(chunkStart + 2),
        sampleRate: bytes.readUInt32LE(chunkStart + 4),
        byteRate: bytes.readUInt32LE(chunkStart + 8),
        blockAlign: bytes.readUInt16LE(chunkStart + 12),
        bitsPerSample: bytes.readUInt16LE(chunkStart + 14),
      });
    } else if (chunkId === "data") {
      if (dataBytes !== undefined || chunkSize === 0) {
        throw invalidWav();
      }
      dataBytes = chunkSize;
    }
    offset = paddedEnd;
  }

  if (
    offset !== bytes.length ||
    format === undefined ||
    dataBytes === undefined ||
    format.audioFormat !== 1 ||
    format.channels !== 1 ||
    format.sampleRate !== sampleRate ||
    format.sampleRate !== EXPECTED_SAMPLE_RATE ||
    format.bitsPerSample !== 16 ||
    format.blockAlign !== 2 ||
    format.byteRate !== format.sampleRate * format.blockAlign ||
    dataBytes % format.blockAlign !== 0
  ) {
    throw invalidWav();
  }

  const actualDuration = dataBytes / format.blockAlign / format.sampleRate;
  if (Math.abs(actualDuration - durationSeconds) > 0.01) {
    throw narrationError(
      "Supertonic duration metadata does not match the PCM sample count.",
      { code: "SUPERTONIC_INVALID_DURATION" },
    );
  }
}

async function boundedUpstreamCode(bytes) {
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    const code = parsed?.error?.code;
    return typeof code === "string" && /^[a-z0-9_]{1,64}$/u.test(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}

async function requireOk(response, bytes) {
  if (response.ok) {
    return;
  }

  const upstreamCode = await boundedUpstreamCode(bytes);
  const unavailable = response.status === 503 || response.status >= 500;
  throw narrationError(
    unavailable
      ? "The local Supertonic service is unavailable."
      : "Supertonic rejected the synthesis request.",
    {
      code: unavailable
        ? "SUPERTONIC_UNAVAILABLE"
        : "SUPERTONIC_REQUEST_REJECTED",
      retryable: unavailable,
      details: {
        status: response.status,
        ...(upstreamCode ? { upstreamCode } : {}),
      },
    },
  );
}

async function readBodyBounded(response, limit, tooLargeError) {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > limit
  ) {
    await response.body?.cancel().catch(() => undefined);
    if (tooLargeError !== undefined) {
      throw tooLargeError();
    }
    return Buffer.alloc(0);
  }

  if (response.body === null) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (length + value.byteLength > limit) {
        if (tooLargeError !== undefined) {
          throw tooLargeError();
        }
        const remaining = limit - length;
        if (remaining > 0) {
          chunks.push(
            Buffer.from(value.buffer, value.byteOffset, remaining),
          );
          length += remaining;
        }
        break;
      }
      length += value.byteLength;
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function atomicWrite(outputRoot, target, bytes) {
  const parent = dirname(target);
  const initialParent = await ensureSafeParent(outputRoot, parent);
  await assertSafeOutputEntry(target);
  const temporary = join(
    parent,
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let published = false;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const finalParent = await ensureSafeParent(outputRoot, parent);
    if (!sameDirectory(initialParent, finalParent)) {
      throw unsafeOutputPath();
    }
    await assertSafeOutputEntry(target);
    await rename(temporary, target);
    const publishedMetadata = await lstat(target);
    if (
      !publishedMetadata.isFile() ||
      publishedMetadata.isSymbolicLink() ||
      publishedMetadata.nlink !== 1
    ) {
      throw unsafeOutputPath();
    }
    published = true;
  } finally {
    await handle?.close().catch(() => {});
    if (!published) {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}

export class SupertonicClient {
  #baseUrl;
  #outputRoot;
  #timeoutMs;

  constructor({
    baseUrl = "http://127.0.0.1:7788",
    timeoutMs = 120_000,
    outputRoot,
  } = {}) {
    this.#baseUrl = normalizeBaseUrl(baseUrl);
    this.#timeoutMs = validateTimeout(timeoutMs);
    this.#outputRoot = normalizeOutputRoot(outputRoot);
  }

  get outputRoot() {
    return this.#outputRoot;
  }

  async #request(pathname, init, externalSignal, successLimit, successLimitError) {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(externalSignal.reason);
    if (externalSignal?.aborted) {
      onAbort();
    } else {
      externalSignal?.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    timer.unref?.();

    try {
      const response = await fetch(`${this.#baseUrl}${pathname}`, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      const bytes = await readBodyBounded(
        response,
        response.ok ? successLimit : MAX_ERROR_BODY_BYTES,
        response.ok ? successLimitError : undefined,
      );
      return { response, bytes };
    } catch (error) {
      if (timedOut) {
        throw narrationError("The Supertonic request timed out.", {
          code: "SUPERTONIC_TIMEOUT",
          retryable: true,
        });
      }
      if (externalSignal?.aborted) {
        throw narrationError("The Supertonic request was cancelled.", {
          code: "SUPERTONIC_CANCELLED",
          retryable: true,
        });
      }
      if (error instanceof StudioError) {
        throw error;
      }
      throw narrationError("The local Supertonic service could not be reached.", {
        code: "SUPERTONIC_UNAVAILABLE",
        retryable: true,
        details: { cause: error?.code ?? error?.name ?? "request_failed" },
      });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  }

  async health({ signal } = {}) {
    const { response, bytes } = await this.#request(
      "/v1/health",
      { method: "GET" },
      signal,
      MAX_ERROR_BODY_BYTES,
      () =>
        narrationError("Supertonic health returned too much data.", {
          code: "SUPERTONIC_INVALID_HEALTH",
        }),
    );
    await requireOk(response, bytes);
    if (responseContentType(response) !== "application/json") {
      throw narrationError("Supertonic health returned an invalid media type.", {
        code: "SUPERTONIC_INVALID_HEALTH",
      });
    }

    let health;
    try {
      health = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw narrationError("Supertonic health returned invalid JSON.", {
        code: "SUPERTONIC_INVALID_HEALTH",
      });
    }
    if (
      health?.status !== "ok" ||
      health.model !== "supertonic-3" ||
      health.sample_rate !== EXPECTED_SAMPLE_RATE ||
      health.version !== EXPECTED_VERSION ||
      !Number.isInteger(health.voices_loaded) ||
      health.voices_loaded < ALLOWED_SUPERTONIC_VOICES.length
    ) {
      throw narrationError("Supertonic health does not match the pinned runtime.", {
        code: "SUPERTONIC_INVALID_HEALTH",
      });
    }

    return Object.freeze({
      status: health.status,
      model: health.model,
      sampleRate: health.sample_rate,
      version: health.version,
      voicesLoaded: health.voices_loaded,
    });
  }

  async synthesize(options) {
    validateSynthesisInput(options ?? {});
    if (this.#outputRoot === undefined) {
      throw narrationError("Supertonic synthesis requires a job-owned output root.", {
        code: "SUPERTONIC_OUTPUT_ROOT_REQUIRED",
      });
    }
    return enqueueSynthesis(options.signal, () => this.#synthesize(options));
  }

  async #synthesize({ text, voice, outputFile, signal }) {
    const outputPath = outputTarget(this.#outputRoot, outputFile);
    const { response, bytes } = await this.#request(
      "/v1/tts",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          voice,
          lang: "ko",
          response_format: "wav",
        }),
      },
      signal,
      MAX_AUDIO_BYTES,
      () =>
        narrationError("Supertonic audio exceeded the local size limit.", {
          code: "SUPERTONIC_INVALID_AUDIO",
        }),
    );
    await requireOk(response, bytes);
    if (responseContentType(response) !== "audio/wav") {
      throw narrationError("Supertonic returned an unsupported audio format.", {
        code: "SUPERTONIC_INVALID_AUDIO",
      });
    }

    const durationSeconds = positiveDuration(response);
    const sampleRate = expectedSampleRate(response);
    expectedVersion(response);
    validateWav(bytes, durationSeconds, sampleRate);
    await atomicWrite(this.#outputRoot, outputPath, bytes);

    return Object.freeze({
      outputPath,
      durationSeconds,
      sampleRate,
      voice,
      lang: "ko",
      bytes: bytes.length,
    });
  }
}

export async function runSupertonicSmoke({
  baseUrl = "http://127.0.0.1:7788",
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "manual-studio-supertonic-smoke-"));
  const outputPath = join(directory, "korean-smoke.wav");
  try {
    const client = new SupertonicClient({ baseUrl, outputRoot: directory });
    const health = await client.health();
    const audio = await client.synthesize({
      text: "수퍼토닉 한국어 음성 합성 점검입니다.",
      voice: "F1",
      outputFile: basename(outputPath),
    });
    return Object.freeze({
      status: health.status,
      model: health.model,
      version: health.version,
      sampleRate: audio.sampleRate,
      durationSeconds: audio.durationSeconds,
      bytes: audio.bytes,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const isEntryPoint =
  typeof process.argv[1] === "string" &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isEntryPoint) {
  if (process.argv.length !== 3 || process.argv[2] !== "--smoke") {
    console.error("Usage: node src/adapters/supertonic-client.js --smoke");
    process.exitCode = 2;
  } else {
    runSupertonicSmoke()
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => {
        const report =
          error instanceof StudioError
            ? error.toJSON()
            : {
                name: "StudioError",
                publicMessage: "The operation could not be completed.",
                code: "SUPERTONIC_SMOKE_FAILED",
                stage: "narration",
                retryable: false,
                details: {},
              };
        console.error(JSON.stringify(report));
        process.exitCode = 1;
      });
  }
}
