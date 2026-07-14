import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  StudioError,
  TRANSITIONS,
  transition as workflowTransition,
} from "../domain/state-machine.js";

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const EVENT_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const FORBIDDEN_JOB_IDS = new Set([
  "__proto__",
  "aux",
  "clock$",
  "con",
  "constructor",
  "nul",
  "prn",
  "prototype",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);
const FORBIDDEN_DATA_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const EVENT_FIELDS = Object.freeze([
  "jobId",
  "sequence",
  "timestamp",
  "event",
  "state",
  "data",
]);
const SNAPSHOT_FIELDS = Object.freeze([
  "id",
  "state",
  "createdAt",
  "updatedAt",
  "eventSequence",
]);
const atomicWriteChains = new Map();

function jobError(code, message, reason, retryable = false) {
  return new StudioError(message, {
    code,
    stage: "storage",
    retryable,
    details: reason === undefined ? {} : { reason },
  });
}

function assertJobId(jobId) {
  if (
    typeof jobId !== "string" ||
    !JOB_ID.test(jobId) ||
    FORBIDDEN_JOB_IDS.has(jobId.toLowerCase())
  ) {
    throw jobError(
      "INVALID_JOB_ID",
      "The job identifier is invalid.",
      "invalid_identifier",
    );
  }
  return jobId;
}

function isSensitiveKey(key) {
  const normalized = key.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
  return [
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "password",
    "passphrase",
    "secret",
    "token",
  ].some((suffix) => normalized.endsWith(suffix));
}

function publicDataError(code, reason) {
  throw jobError(
    code,
    "The public job data is invalid.",
    reason,
  );
}

function clonePublicData(value, seen = new WeakSet()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      publicDataError("INVALID_PUBLIC_DATA", "non_finite_number");
    }
    return value;
  }
  if (typeof value !== "object") {
    publicDataError("INVALID_PUBLIC_DATA", "json_value_required");
  }
  if (seen.has(value)) {
    publicDataError("INVALID_PUBLIC_DATA", "cyclic_value");
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      publicDataError("INVALID_PUBLIC_DATA", "plain_array_required");
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some(
        (key) =>
          key !== "length" &&
          (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)),
      )
    ) {
      publicDataError("INVALID_PUBLIC_DATA", "array_fields_invalid");
    }
    const clone = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        publicDataError("INVALID_PUBLIC_DATA", "dense_data_array_required");
      }
      clone.push(clonePublicData(descriptor.value, seen));
    }
    seen.delete(value);
    return Object.freeze(clone);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    publicDataError("INVALID_PUBLIC_DATA", "plain_object_required");
  }
  const clone = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      publicDataError("INVALID_PUBLIC_DATA", "string_keys_required");
    }
    if (FORBIDDEN_DATA_KEYS.has(key)) {
      publicDataError("INVALID_PUBLIC_DATA", "unsafe_key");
    }
    if (isSensitiveKey(key)) {
      publicDataError("SENSITIVE_PUBLIC_DATA", "sensitive_key");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      publicDataError("INVALID_PUBLIC_DATA", "enumerable_data_properties_required");
    }
    clone[key] = clonePublicData(descriptor.value, seen);
  }
  seen.delete(value);
  return Object.freeze(clone);
}

function safeTimestamp(value) {
  const date = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw jobError(
      "INVALID_TIMESTAMP",
      "The job timestamp is invalid.",
      "invalid_clock_value",
    );
  }
  return date.toISOString();
}

function monotonicTimestamp(value, floor) {
  const timestamp = safeTimestamp(value);
  return floor !== undefined && timestamp < floor ? floor : timestamp;
}

function exactOwnFields(value, fields) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === fields.length &&
    keys.every((key) => typeof key === "string" && fields.includes(key)) &&
    fields.every((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      return descriptor !== undefined && "value" in descriptor;
    })
  );
}

function freezeSnapshot(snapshot, request) {
  return Object.freeze({
    id: snapshot.id,
    state: snapshot.state,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    eventSequence: snapshot.eventSequence,
    request,
  });
}

function ensureContained(root, candidate) {
  const child = resolve(candidate);
  const fromRoot = relative(root, child);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromRoot)
  ) {
    throw jobError(
      "UNSAFE_JOB_PATH",
      "The job path is outside the configured root.",
      "path_escape",
    );
  }
  return child;
}

async function durableAppend(path, line) {
  let handle;
  try {
    handle = await open(path, "a", 0o600);
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function renameAtomically(temporary, target) {
  let waitedMs = 0;
  let intervalMs = 4;
  for (;;) {
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        error?.code !== "EPERM" ||
        waitedMs >= 1_000
      ) {
        throw error;
      }
      // Windows denies replacement while a reader briefly holds the target.
      // Keep the old complete file in place and retry only that sharing error.
      await delay(intervalMs);
      waitedMs += intervalMs;
      intervalMs = Math.min(intervalMs * 2, 32);
    }
  }
}

async function replaceJsonAtomically(path, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  let renamed = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameAtomically(temporary, path);
    renamed = true;
  } finally {
    await handle?.close();
    if (!renamed) {
      await rm(temporary, { force: true });
    }
  }
}

export function writeJsonAtomically(path, value) {
  const target = resolve(path);
  const previous = atomicWriteChains.get(target) ?? Promise.resolve();
  const result = previous.then(() => replaceJsonAtomically(target, value));
  const gate = result.catch(() => undefined).finally(() => {
    if (atomicWriteChains.get(target) === gate) {
      atomicWriteChains.delete(target);
    }
  });
  atomicWriteChains.set(target, gate);
  return result;
}

function parseJson(text, kind) {
  try {
    return JSON.parse(text);
  } catch {
    throw jobError(
      "CORRUPT_JOB_DATA",
      "The persisted job data is corrupt.",
      `invalid_${kind}_json`,
    );
  }
}

function validateEvent(rawEvent, jobId, previous) {
  if (!exactOwnFields(rawEvent, EVENT_FIELDS)) {
    throw jobError(
      "CORRUPT_JOB_DATA",
      "The persisted event is invalid.",
      "event_fields_invalid",
    );
  }
  if (
    rawEvent.jobId !== jobId ||
    !Number.isSafeInteger(rawEvent.sequence) ||
    rawEvent.sequence !== (previous?.sequence ?? 0) + 1 ||
    typeof rawEvent.event !== "string" ||
    !EVENT_NAME.test(rawEvent.event) ||
    typeof rawEvent.state !== "string" ||
    !Object.hasOwn(TRANSITIONS, rawEvent.state)
  ) {
    throw jobError(
      "CORRUPT_JOB_DATA",
      "The persisted event is invalid.",
      "event_contract_invalid",
    );
  }
  const timestamp = safeTimestamp(rawEvent.timestamp);
  if (
    timestamp !== rawEvent.timestamp ||
    (previous !== undefined && timestamp < previous.timestamp)
  ) {
    throw jobError(
      "CORRUPT_JOB_DATA",
      "The persisted event is invalid.",
      "event_timestamp_invalid",
    );
  }
  if (previous === undefined) {
    if (
      rawEvent.sequence !== 1 ||
      rawEvent.event !== "JOB_CREATED" ||
      rawEvent.state !== "created"
    ) {
      throw jobError(
        "CORRUPT_JOB_DATA",
        "The persisted event is invalid.",
        "first_event_invalid",
      );
    }
  } else {
    let expectedState;
    try {
      expectedState = workflowTransition(previous.state, rawEvent.event);
    } catch {
      throw jobError(
        "CORRUPT_JOB_DATA",
        "The persisted event is invalid.",
        "event_transition_invalid",
      );
    }
    if (expectedState !== rawEvent.state) {
      throw jobError(
        "CORRUPT_JOB_DATA",
        "The persisted event is invalid.",
        "event_state_invalid",
      );
    }
  }
  let data;
  try {
    data = clonePublicData(rawEvent.data);
  } catch {
    throw jobError(
      "CORRUPT_JOB_DATA",
      "The persisted event is invalid.",
      "event_data_invalid",
    );
  }
  return Object.freeze({
    jobId,
    sequence: rawEvent.sequence,
    timestamp,
    event: rawEvent.event,
    state: rawEvent.state,
    data,
  });
}

function parseEvents(text, jobId) {
  if (typeof text !== "string" || !text.endsWith("\n")) {
    throw jobError(
      "CORRUPT_JOB_DATA",
      "The persisted event stream is corrupt.",
      "unterminated_event_stream",
    );
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw jobError(
      "CORRUPT_JOB_DATA",
      "The persisted event stream is corrupt.",
      "empty_event_line",
    );
  }
  const events = [];
  for (const line of lines) {
    const parsed = parseJson(line, "event");
    events.push(validateEvent(parsed, jobId, events.at(-1)));
  }
  return Object.freeze(events);
}

function snapshotFromEvents(jobId, events) {
  const first = events[0];
  const latest = events.at(-1);
  return Object.freeze({
    id: jobId,
    state: latest.state,
    createdAt: first.timestamp,
    updatedAt: latest.timestamp,
    eventSequence: latest.sequence,
  });
}

function validSnapshot(value, recovered) {
  return (
    exactOwnFields(value, SNAPSHOT_FIELDS) &&
    SNAPSHOT_FIELDS.every((field) => value[field] === recovered[field])
  );
}

export class JobStore {
  #root;
  #now;
  #randomId;
  #chains = new Map();
  #listeners = new Set();

  constructor({ root, now = () => new Date(), randomId = randomUUID } = {}) {
    if (typeof root !== "string" || root.length === 0 || !isAbsolute(root)) {
      throw jobError(
        "INVALID_JOBS_ROOT",
        "The jobs root must be an absolute path.",
        "absolute_path_required",
      );
    }
    if (typeof now !== "function" || typeof randomId !== "function") {
      throw jobError(
        "INVALID_JOB_STORE_OPTIONS",
        "The job store options are invalid.",
        "function_required",
      );
    }
    this.#root = resolve(root);
    this.#now = now;
    this.#randomId = randomId;
  }

  get root() {
    return this.#root;
  }

  async #ensureRoot() {
    await mkdir(this.#root, { recursive: true });
    const rootStat = await lstat(this.#root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw jobError(
        "UNSAFE_JOB_PATH",
        "The configured jobs root is unsafe.",
        "unsafe_root",
      );
    }
  }

  #paths(jobId) {
    const validId = assertJobId(jobId);
    const directory = ensureContained(this.#root, join(this.#root, validId));
    return Object.freeze({
      directory,
      request: ensureContained(this.#root, join(directory, "request.json")),
      snapshot: ensureContained(this.#root, join(directory, "job.json")),
      events: ensureContained(this.#root, join(directory, "events.jsonl")),
    });
  }

  async #assertSafeEntry(path, { directory = false, required = true } = {}) {
    let entry;
    try {
      entry = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT" && !required) {
        return false;
      }
      if (error?.code === "ENOENT") {
        throw jobError(
          "JOB_NOT_FOUND",
          "The job does not exist.",
          "missing_job_data",
        );
      }
      throw error;
    }
    if (
      entry.isSymbolicLink() ||
      (directory ? !entry.isDirectory() : !entry.isFile())
    ) {
      throw jobError(
        "UNSAFE_JOB_PATH",
        "The persisted job path is unsafe.",
        "symlink_or_wrong_type",
      );
    }
    return true;
  }

  #serialize(jobId, operation) {
    const previous = this.#chains.get(jobId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const gate = result.catch(() => undefined).finally(() => {
      if (this.#chains.get(jobId) === gate) {
        this.#chains.delete(jobId);
      }
    });
    this.#chains.set(jobId, gate);
    return result;
  }

  #notify(event) {
    for (const listener of [...this.#listeners]) {
      try {
        Promise.resolve(listener(event)).catch(() => undefined);
      } catch {
        // Persistence and other listeners must survive a subscriber failure.
      }
    }
  }

  onEvent(listener) {
    if (typeof listener !== "function") {
      throw jobError(
        "INVALID_EVENT_LISTENER",
        "The event listener is invalid.",
        "function_required",
      );
    }
    this.#listeners.add(listener);
    let closed = false;
    return () => {
      if (!closed) {
        closed = true;
        this.#listeners.delete(listener);
      }
    };
  }

  async create(request) {
    await this.#ensureRoot();
    const safeRequest = clonePublicData(request);
    const jobId = assertJobId(this.#randomId());
    const paths = this.#paths(jobId);
    try {
      await mkdir(paths.directory, { recursive: false });
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw jobError(
          "JOB_ID_COLLISION",
          "The generated job identifier already exists.",
          "identifier_collision",
          true,
        );
      }
      throw error;
    }
    const timestamp = safeTimestamp(this.#now());
    const event = Object.freeze({
      jobId,
      sequence: 1,
      timestamp,
      event: "JOB_CREATED",
      state: "created",
      data: Object.freeze({}),
    });
    const snapshot = Object.freeze({
      id: jobId,
      state: "created",
      createdAt: timestamp,
      updatedAt: timestamp,
      eventSequence: 1,
    });
    try {
      await writeJsonAtomically(paths.request, safeRequest);
      await durableAppend(paths.events, `${JSON.stringify(event)}\n`);
      this.#notify(event);
      await writeJsonAtomically(paths.snapshot, snapshot);
    } catch (error) {
      await rm(paths.directory, { force: true, recursive: true });
      throw error;
    }
    return freezeSnapshot(snapshot, safeRequest);
  }

  async #loadInternal(jobId) {
    await this.#ensureRoot();
    const paths = this.#paths(jobId);
    await this.#assertSafeEntry(paths.directory, { directory: true });
    await this.#assertSafeEntry(paths.request);
    await this.#assertSafeEntry(paths.events);
    const snapshotExists = await this.#assertSafeEntry(paths.snapshot, {
      required: false,
    });
    const [requestText, eventText] = await Promise.all([
      readFile(paths.request, "utf8"),
      readFile(paths.events, "utf8"),
    ]);
    let safeRequest;
    try {
      safeRequest = clonePublicData(parseJson(requestText, "request"));
    } catch (error) {
      if (error instanceof StudioError && error.code === "CORRUPT_JOB_DATA") {
        throw error;
      }
      throw jobError(
        "CORRUPT_JOB_DATA",
        "The persisted request is invalid.",
        "request_contract_invalid",
      );
    }
    const events = parseEvents(eventText, jobId);
    const recovered = snapshotFromEvents(jobId, events);
    let persistedSnapshot;
    if (snapshotExists) {
      try {
        persistedSnapshot = parseJson(
          await readFile(paths.snapshot, "utf8"),
          "snapshot",
        );
      } catch {
        persistedSnapshot = undefined;
      }
    }
    if (!validSnapshot(persistedSnapshot, recovered)) {
      await writeJsonAtomically(paths.snapshot, recovered);
    }
    return Object.freeze({
      job: freezeSnapshot(recovered, safeRequest),
      events,
    });
  }

  async load(jobId) {
    const validId = assertJobId(jobId);
    return this.#serialize(validId, async () => {
      const { job } = await this.#loadInternal(validId);
      return job;
    });
  }

  async readEvents(jobId, afterSequence = 0) {
    const validId = assertJobId(jobId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw jobError(
        "INVALID_EVENT_SEQUENCE",
        "The event sequence is invalid.",
        "non_negative_safe_integer_required",
      );
    }
    return this.#serialize(validId, async () => {
      const { events } = await this.#loadInternal(validId);
      return Object.freeze(
        events.filter(({ sequence }) => sequence > afterSequence),
      );
    });
  }

  async transition(jobId, eventName, data = {}) {
    const validId = assertJobId(jobId);
    const safeData = clonePublicData(data);
    return this.#serialize(validId, async () => {
      const { job: current } = await this.#loadInternal(validId);
      const nextState = workflowTransition(current.state, eventName);
      const timestamp = monotonicTimestamp(this.#now(), current.updatedAt);
      const event = Object.freeze({
        jobId: validId,
        sequence: current.eventSequence + 1,
        timestamp,
        event: eventName,
        state: nextState,
        data: safeData,
      });
      const snapshot = Object.freeze({
        id: validId,
        state: nextState,
        createdAt: current.createdAt,
        updatedAt: timestamp,
        eventSequence: event.sequence,
      });
      const paths = this.#paths(validId);
      await durableAppend(paths.events, `${JSON.stringify(event)}\n`);
      this.#notify(event);
      await writeJsonAtomically(paths.snapshot, snapshot);
      return freezeSnapshot(snapshot, current.request);
    });
  }

  async list() {
    await this.#ensureRoot();
    const entries = await readdir(this.#root, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      try {
        assertJobId(entry.name);
      } catch {
        continue;
      }
      jobs.push(await this.load(entry.name));
    }
    jobs.sort((left, right) => {
      const newest = right.createdAt.localeCompare(left.createdAt);
      if (newest !== 0) {
        return newest;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
    return Object.freeze(jobs);
  }
}
