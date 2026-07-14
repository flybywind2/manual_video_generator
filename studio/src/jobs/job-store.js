import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
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
const PUBLIC_REFERENCE_KEYS = new Set([
  "credentialid",
  "credentialref",
  "vaultid",
  "passwordselector",
]);
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
const OWNER_FIELDS = Object.freeze(["pid", "token", "createdAt"]);
const COMPARE_TRANSITION_FIELDS = Object.freeze([
  "expectedState",
  "expectedEventSequence",
  "expectedPlanDigest",
  "eventName",
  "data",
]);
const ROOT_LOCK_NAME = ".studio-owner.lock";
const atomicWriteChains = new Map();
const jobOperationChains = new Map();
const rootLeaseChains = new Map();
const rootOwners = new Map();
const rootListenerGroups = new Map();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

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

function compareTransitionInput(value) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== COMPARE_TRANSITION_FIELDS.length ||
      !Reflect.ownKeys(value).every(
        (key) => typeof key === "string" && COMPARE_TRANSITION_FIELDS.includes(key),
      )
    ) {
      throw new Error("fields");
    }
    const values = Object.create(null);
    for (const field of COMPARE_TRANSITION_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("property");
      }
      values[field] = descriptor.value;
    }
    if (
      typeof values.expectedState !== "string" ||
      !Object.hasOwn(TRANSITIONS, values.expectedState) ||
      !Number.isSafeInteger(values.expectedEventSequence) ||
      values.expectedEventSequence < 1 ||
      typeof values.expectedPlanDigest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(values.expectedPlanDigest) ||
      typeof values.eventName !== "string" ||
      !EVENT_NAME.test(values.eventName)
    ) {
      throw new Error("value");
    }
    return Object.freeze({
      expectedState: values.expectedState,
      expectedEventSequence: values.expectedEventSequence,
      expectedPlanDigest: values.expectedPlanDigest,
      eventName: values.eventName,
      data: clonePublicData(values.data),
    });
  } catch (error) {
    if (error instanceof StudioError) throw error;
    throw jobError(
      "INVALID_COMPARE_TRANSITION",
      "The compare-and-transition request is invalid.",
      "invalid_compare_contract",
    );
  }
}

function isSensitiveKey(key) {
  const normalized = key
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9]/gu, "")
    .toLowerCase();
  if (PUBLIC_REFERENCE_KEYS.has(normalized)) {
    return false;
  }
  if (
    [
      "apikey",
      "privatekey",
      "accesskey",
      "secretkey",
      "passwordhash",
      "passwordderived",
    ].some((marker) => normalized.includes(marker))
  ) {
    return true;
  }
  return [
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "password",
    "passphrase",
    "secret",
    "token",
  ].some((marker) => normalized.includes(marker));
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

function canonicalPathKey(path) {
  const canonical = resolve(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function serializeOperation(chains, key, operation) {
  const previous = chains.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const gate = result.catch(() => undefined).finally(() => {
    if (chains.get(key) === gate) {
      chains.delete(key);
    }
  });
  chains.set(key, gate);
  return result;
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

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    try {
      await handle.sync();
    } catch (error) {
      if (process.platform !== "win32" || error?.code !== "EPERM") {
        throw error;
      }
      // Node cannot FlushFileBuffers on directory handles on Windows. NTFS still
      // provides atomic rename; all file contents are flushed before publication.
    }
  } finally {
    await handle.close();
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

function parseEvents(bytes, jobId) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw jobError(
      "CORRUPT_JOB_DATA",
      "The persisted event stream is corrupt.",
      "empty_event_stream",
    );
  }
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    throw jobError(
      "CORRUPT_JOB_DATA",
      "The persisted event stream is corrupt.",
      "no_committed_event",
    );
  }
  const committedEnd = lastNewline + 1;
  let committedText;
  try {
    committedText = utf8Decoder.decode(bytes.subarray(0, committedEnd));
  } catch {
    throw jobError(
      "CORRUPT_JOB_DATA",
      "The persisted event stream is corrupt.",
      "invalid_event_utf8",
    );
  }
  const lines = committedText.slice(0, -1).split("\n");
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
  return Object.freeze({
    events: Object.freeze(events),
    committedEnd,
    originalLength: bytes.length,
  });
}

async function truncateUncommittedTail(path, committedEnd, expectedLength) {
  let handle;
  try {
    handle = await open(path, "r+");
    const { size } = await handle.stat();
    if (size !== expectedLength) {
      throw jobError(
        "CONCURRENT_JOB_WRITE",
        "The event stream changed while it was being recovered.",
        "event_size_changed",
        true,
      );
    }
    await handle.truncate(committedEnd);
    await handle.sync();
  } finally {
    await handle?.close();
  }
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

function parseOwnerMetadata(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw jobError(
      "INVALID_ROOT_OWNER",
      "The jobs root owner record is invalid.",
      "invalid_owner_json",
    );
  }
  if (
    !exactOwnFields(value, OWNER_FIELDS) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.token !== "string" ||
    !/^[A-Za-z0-9-]{8,128}$/u.test(value.token) ||
    typeof value.createdAt !== "string" ||
    safeTimestamp(value.createdAt) !== value.createdAt
  ) {
    throw jobError(
      "INVALID_ROOT_OWNER",
      "The jobs root owner record is invalid.",
      "invalid_owner_contract",
    );
  }
  return Object.freeze({
    pid: value.pid,
    token: value.token,
    createdAt: value.createdAt,
  });
}

async function readOwnerMetadata(lockPath) {
  let entry;
  try {
    entry = await lstat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw jobError(
      "UNSAFE_JOB_PATH",
      "The jobs root owner path is unsafe.",
      "unsafe_owner_path",
    );
  }
  return parseOwnerMetadata(await readFile(lockPath, "utf8"));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function ownerMatches(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.pid === right.pid &&
    left.token === right.token &&
    left.createdAt === right.createdAt
  );
}

function ownershipLost() {
  return jobError(
    "ROOT_LOCK_OWNERSHIP_LOST",
    "The jobs root ownership was lost.",
    "owner_record_changed",
  );
}

async function createOwnerFile(lockPath, metadata) {
  let handle;
  let created = false;
  let committed = false;
  try {
    handle = await open(lockPath, "wx", 0o600);
    created = true;
    await handle.writeFile(JSON.stringify(metadata), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    committed = true;
  } finally {
    await handle?.close();
    if (created && !committed) {
      try {
        await unlink(lockPath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
}

async function acquireRootLease(root) {
  const canonicalRoot = await realpath(root);
  const key = canonicalPathKey(canonicalRoot);
  return serializeOperation(rootLeaseChains, key, async () => {
    const existing = rootOwners.get(key);
    if (existing !== undefined) {
      const persisted = await readOwnerMetadata(existing.lockPath);
      if (
        persisted === undefined ||
        persisted.pid !== process.pid ||
        persisted.token !== existing.token
      ) {
        rootOwners.delete(key);
        throw jobError(
          "ROOT_LOCK_OWNERSHIP_LOST",
          "The jobs root ownership was lost.",
          "owner_record_changed",
        );
      }
      existing.references += 1;
      return Object.freeze({ key, token: existing.token });
    }

    const lockPath = ensureContained(root, join(root, ROOT_LOCK_NAME));
    const token = randomUUID();
    const metadata = Object.freeze({
      pid: process.pid,
      token,
      createdAt: new Date().toISOString(),
    });
    for (;;) {
      try {
        await createOwnerFile(lockPath, metadata);
        rootOwners.set(key, { lockPath, token, references: 1 });
        return Object.freeze({ key, token });
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
      }

      const owner = await readOwnerMetadata(lockPath);
      if (owner === undefined) {
        continue;
      }
      if (processIsAlive(owner.pid)) {
        throw jobError(
          "JOBS_ROOT_LOCKED",
          "Another local service process owns the jobs root.",
          "live_foreign_owner",
          true,
        );
      }

      const stalePath = ensureContained(
        root,
        join(root, `.studio-owner.stale.${randomUUID()}`),
      );
      try {
        await rename(lockPath, stalePath);
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      const claimedOwner = await readOwnerMetadata(stalePath);
      if (!ownerMatches(claimedOwner, owner)) {
        try {
          await rename(stalePath, lockPath);
        } catch {
          throw jobError(
            "ROOT_LOCK_RECOVERY_RACE",
            "The jobs root owner changed during stale recovery.",
            "owner_changed_during_recovery",
            true,
          );
        }
        if (claimedOwner !== undefined && processIsAlive(claimedOwner.pid)) {
          throw jobError(
            "JOBS_ROOT_LOCKED",
            "Another local service process owns the jobs root.",
            "live_foreign_owner",
            true,
          );
        }
        continue;
      }
      await unlink(stalePath);
    }
  });
}

async function verifyRootLease(lease) {
  return serializeOperation(rootLeaseChains, lease.key, async () => {
    const existing = rootOwners.get(lease.key);
    if (existing === undefined || existing.token !== lease.token) {
      throw ownershipLost();
    }
    const persisted = await readOwnerMetadata(existing.lockPath);
    if (
      persisted === undefined ||
      persisted.pid !== process.pid ||
      persisted.token !== existing.token
    ) {
      rootOwners.delete(lease.key);
      throw ownershipLost();
    }
  });
}

async function releaseRootLease(lease) {
  return serializeOperation(rootLeaseChains, lease.key, async () => {
    const existing = rootOwners.get(lease.key);
    if (existing === undefined || existing.token !== lease.token) {
      throw ownershipLost();
    }
    const persisted = await readOwnerMetadata(existing.lockPath);
    if (
      persisted === undefined ||
      persisted.pid !== process.pid ||
      persisted.token !== existing.token
    ) {
      rootOwners.delete(lease.key);
      throw ownershipLost();
    }
    if (existing.references > 1) {
      existing.references -= 1;
      return;
    }
    const releasedPath = ensureContained(
      dirname(existing.lockPath),
      join(
        dirname(existing.lockPath),
        `.studio-owner.release.${existing.token}.${randomUUID()}`,
      ),
    );
    try {
      await renameAtomically(existing.lockPath, releasedPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        rootOwners.delete(lease.key);
        throw ownershipLost();
      }
      throw error;
    }

    let releasedOwner;
    try {
      releasedOwner = await readOwnerMetadata(releasedPath);
    } catch (error) {
      rootOwners.delete(lease.key);
      throw error;
    }
    if (!ownerMatches(releasedOwner, persisted)) {
      rootOwners.delete(lease.key);
      try {
        await renameAtomically(releasedPath, existing.lockPath);
      } catch {
        throw jobError(
          "ROOT_LOCK_RECOVERY_RACE",
          "The jobs root owner changed during lease release.",
          "owner_changed_during_release",
          true,
        );
      }
      throw ownershipLost();
    }

    rootOwners.delete(lease.key);
    await unlink(releasedPath);
    await syncDirectory(dirname(existing.lockPath));
  });
}

async function removeCreateStaging(root, stagingPath) {
  const resolvedRoot = resolve(root);
  const resolvedStaging = resolve(stagingPath);
  if (
    dirname(resolvedStaging) !== resolvedRoot ||
    !basename(resolvedStaging).startsWith(".create-")
  ) {
    throw jobError(
      "UNSAFE_JOB_PATH",
      "The create staging path is unsafe.",
      "unsafe_staging_cleanup",
    );
  }
  await rm(resolvedStaging, { force: true, recursive: true });
}

export class JobStore {
  #root;
  #now;
  #randomId;
  #listeners = new Set();
  #ownership;
  #ownershipPromise;
  #closed = false;
  #closePromise;
  #inFlight = new Set();
  #listenerKey;
  #listenerGroupRegistered = false;

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
    this.#listenerKey = canonicalPathKey(this.#root);
  }

  get root() {
    return this.#root;
  }

  async #ensureRoot() {
    if (this.#closed) {
      throw jobError(
        "JOB_STORE_CLOSED",
        "The job store is closed.",
        "closed_store",
      );
    }
    await mkdir(this.#root, { recursive: true });
    const rootStat = await lstat(this.#root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw jobError(
        "UNSAFE_JOB_PATH",
        "The configured jobs root is unsafe.",
        "unsafe_root",
      );
    }
    if (this.#ownership === undefined) {
      if (this.#ownershipPromise === undefined) {
        this.#ownershipPromise = acquireRootLease(this.#root)
          .then((ownership) => {
            this.#ownership = ownership;
            return ownership;
          })
          .catch((error) => {
            this.#ownershipPromise = undefined;
            throw error;
          });
      }
      await this.#ownershipPromise;
    } else {
      await verifyRootLease(this.#ownership);
    }
    this.#moveListenerGroup(this.#ownership.key);
  }

  #attachListenerGroup() {
    if (this.#listenerGroupRegistered || this.#listeners.size === 0) {
      return;
    }
    let group = rootListenerGroups.get(this.#listenerKey);
    if (group === undefined) {
      group = new Set();
      rootListenerGroups.set(this.#listenerKey, group);
    }
    group.add(this.#listeners);
    this.#listenerGroupRegistered = true;
  }

  #detachListenerGroup() {
    if (!this.#listenerGroupRegistered) {
      return;
    }
    const group = rootListenerGroups.get(this.#listenerKey);
    group?.delete(this.#listeners);
    if (group?.size === 0) {
      rootListenerGroups.delete(this.#listenerKey);
    }
    this.#listenerGroupRegistered = false;
  }

  #moveListenerGroup(listenerKey) {
    if (listenerKey === this.#listenerKey) {
      return;
    }
    this.#detachListenerGroup();
    this.#listenerKey = listenerKey;
    this.#attachListenerGroup();
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
    const key = canonicalPathKey(this.#paths(jobId).directory);
    return this.#track(serializeOperation(jobOperationChains, key, operation));
  }

  #track(operation) {
    this.#inFlight.add(operation);
    const remove = () => this.#inFlight.delete(operation);
    operation.then(remove, remove);
    return operation;
  }

  #notify(event) {
    const group = rootListenerGroups.get(this.#listenerKey);
    for (const listeners of group === undefined ? [] : [...group]) {
      for (const listener of [...listeners]) {
        try {
          Promise.resolve(listener(event)).catch(() => undefined);
        } catch {
          // Persistence and other listeners must survive a subscriber failure.
        }
      }
    }
  }

  onEvent(listener) {
    if (this.#closed) {
      throw jobError(
        "JOB_STORE_CLOSED",
        "The job store is closed.",
        "closed_store",
      );
    }
    if (typeof listener !== "function") {
      throw jobError(
        "INVALID_EVENT_LISTENER",
        "The event listener is invalid.",
        "function_required",
      );
    }
    this.#listeners.add(listener);
    this.#attachListenerGroup();
    let closed = false;
    return () => {
      if (!closed) {
        closed = true;
        this.#listeners.delete(listener);
        if (this.#listeners.size === 0) {
          this.#detachListenerGroup();
        }
      }
    };
  }

  async create(request) {
    const safeRequest = clonePublicData(request);
    const jobId = assertJobId(this.#randomId());
    return this.#serialize(jobId, async () => {
      await this.#ensureRoot();
      const finalPaths = this.#paths(jobId);
      try {
        await lstat(finalPaths.directory);
        throw jobError(
          "JOB_ID_COLLISION",
          "The generated job identifier already exists.",
          "identifier_collision",
          true,
        );
      } catch (error) {
        if (error instanceof StudioError) {
          throw error;
        }
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }

      const stagingDirectory = ensureContained(
        this.#root,
        join(this.#root, `.create-${jobId}-${randomUUID()}`),
      );
      const stagingPaths = Object.freeze({
        directory: stagingDirectory,
        request: ensureContained(
          this.#root,
          join(stagingDirectory, "request.json"),
        ),
        snapshot: ensureContained(
          this.#root,
          join(stagingDirectory, "job.json"),
        ),
        events: ensureContained(
          this.#root,
          join(stagingDirectory, "events.jsonl"),
        ),
      });
      await mkdir(stagingDirectory, { recursive: false });
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
      let committed = false;
      try {
        await writeJsonAtomically(stagingPaths.request, safeRequest);
        await durableAppend(
          stagingPaths.events,
          `${JSON.stringify(event)}\n`,
        );
        await writeJsonAtomically(stagingPaths.snapshot, snapshot);
        await syncDirectory(stagingPaths.directory);
        try {
          await rename(stagingPaths.directory, finalPaths.directory);
        } catch (error) {
          if (
            error?.code === "EEXIST" ||
            error?.code === "ENOTEMPTY" ||
            error?.code === "EPERM"
          ) {
            throw jobError(
              "JOB_ID_COLLISION",
              "The generated job identifier already exists.",
              "identifier_collision",
              true,
            );
          }
          throw error;
        }
        committed = true;
        await syncDirectory(this.#root);
      } catch (error) {
        if (!committed) {
          await removeCreateStaging(this.#root, stagingPaths.directory);
        }
        throw error;
      }
      this.#notify(event);
      return freezeSnapshot(snapshot, safeRequest);
    });
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
    const [requestText, eventBytes] = await Promise.all([
      readFile(paths.request, "utf8"),
      readFile(paths.events),
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
    const parsedEvents = parseEvents(eventBytes, jobId);
    if (parsedEvents.committedEnd < parsedEvents.originalLength) {
      await truncateUncommittedTail(
        paths.events,
        parsedEvents.committedEnd,
        parsedEvents.originalLength,
      );
    }
    const { events } = parsedEvents;
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

  async #commitTransition(validId, current, eventName, safeData) {
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
    try {
      await writeJsonAtomically(paths.snapshot, snapshot);
    } catch {
      // The durable event is the commit record; job.json is a repairable cache.
    }
    return freezeSnapshot(snapshot, current.request);
  }

  async transition(jobId, eventName, data = {}) {
    const validId = assertJobId(jobId);
    const safeData = clonePublicData(data);
    return this.#serialize(validId, async () => {
      const { job: current } = await this.#loadInternal(validId);
      return this.#commitTransition(validId, current, eventName, safeData);
    });
  }

  async compareAndTransition(jobId, input) {
    const validId = assertJobId(jobId);
    const comparison = compareTransitionInput(input);
    return this.#serialize(validId, async () => {
      const { job: current, events } = await this.#loadInternal(validId);
      const latest = events.at(-1);
      const digestProperty = latest === undefined
        ? undefined
        : Object.getOwnPropertyDescriptor(latest.data, "planDigest");
      const actualDigest =
        digestProperty && "value" in digestProperty
          ? digestProperty.value
          : undefined;
      const digestMatches =
        typeof actualDigest === "string" &&
        /^[a-f0-9]{64}$/u.test(actualDigest) &&
        timingSafeEqual(
          Buffer.from(actualDigest, "hex"),
          Buffer.from(comparison.expectedPlanDigest, "hex"),
        );
      if (
        current.state !== comparison.expectedState ||
        current.eventSequence !== comparison.expectedEventSequence ||
        latest?.sequence !== comparison.expectedEventSequence ||
        !digestMatches
      ) {
        throw jobError(
          "JOB_COMPARE_FAILED",
          "The job changed before the transition could be committed.",
          "current_job_changed",
          true,
        );
      }
      return this.#commitTransition(
        validId,
        current,
        comparison.eventName,
        comparison.data,
      );
    });
  }

  async #listInternal() {
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
      try {
        jobs.push(await this.load(entry.name));
      } catch (error) {
        if (
          !(error instanceof StudioError) ||
          !["CORRUPT_JOB_DATA", "JOB_NOT_FOUND", "UNSAFE_JOB_PATH"].includes(
            error.code,
          )
        ) {
          throw error;
        }
        await this.#serialize(entry.name, async () => {
          const source = this.#paths(entry.name).directory;
          let sourceStat;
          try {
            sourceStat = await lstat(source);
          } catch (sourceError) {
            if (sourceError?.code === "ENOENT") {
              return;
            }
            throw sourceError;
          }
          if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
            return;
          }
          const quarantine = ensureContained(
            this.#root,
            join(this.#root, `.corrupt-${entry.name}-${randomUUID()}`),
          );
          await rename(source, quarantine);
          await syncDirectory(this.#root);
        });
      }
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

  list() {
    return this.#track(this.#listInternal());
  }

  close() {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    this.#closed = true;
    this.#detachListenerGroup();
    this.#listeners.clear();
    const pending = [...this.#inFlight];
    this.#closePromise = (async () => {
      await Promise.allSettled(pending);
      let ownership = this.#ownership;
      if (ownership === undefined && this.#ownershipPromise !== undefined) {
        try {
          ownership = await this.#ownershipPromise;
        } catch {
          return;
        }
      }
      if (ownership !== undefined) {
        await releaseRootLease(ownership);
        this.#ownership = undefined;
      }
    })();
    return this.#closePromise;
  }
}
