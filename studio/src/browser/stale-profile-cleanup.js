import {
  lstat,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const JOB_ID = /^(?:job-[a-z0-9]{16,64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

export class StaleBrowserProfileCleanupError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "StaleBrowserProfileCleanupError";
    this.code = "STALE_BROWSER_PROFILE_CLEANUP_UNSAFE";
    this.reason = reason;
  }
}

function unsafe(message, reason) {
  return new StaleBrowserProfileCleanupError(message, reason);
}

function pathKey(value) {
  const absolute = resolve(value);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function insidePath(root, candidate) {
  const child = relative(resolve(root), resolve(candidate));
  return (
    child !== "" &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function safeEntryName(name) {
  return (
    typeof name === "string" &&
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

function sameIdentity(status, identity) {
  return (
    status.dev === identity.dev &&
    status.ino === identity.ino &&
    !status.isSymbolicLink() &&
    (identity.kind === "directory" ? status.isDirectory() : status.isFile())
  );
}

async function optionalPlainDirectory(directory) {
  let status;
  try {
    status = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw unsafe(
      "unsafe browser profile directory",
      "directory_is_not_plain",
    );
  }
  const canonical = await realpath(directory);
  if (pathKey(canonical) !== pathKey(directory)) {
    throw unsafe(
      "unsafe browser profile directory",
      "directory_realpath_mismatch",
    );
  }
  return Object.freeze({
    path: resolve(directory),
    canonical,
    dev: status.dev,
    ino: status.ino,
    kind: "directory",
  });
}

async function assertIdentity(identity, boundary) {
  let status;
  let canonical;
  try {
    status = await lstat(identity.path);
    canonical = await realpath(identity.path);
  } catch {
    throw unsafe("unsafe browser profile path", "entry_identity_missing");
  }
  if (
    !sameIdentity(status, identity) ||
    pathKey(canonical) !== pathKey(identity.canonical) ||
    pathKey(canonical) !== pathKey(identity.path) ||
    (boundary !== undefined && !insidePath(boundary, canonical))
  ) {
    throw unsafe("unsafe browser profile path", "entry_identity_changed");
  }
}

async function assertDirectoryChain(chain) {
  for (const identity of chain) {
    await assertIdentity(identity);
  }
  for (let index = 1; index < chain.length; index += 1) {
    if (!insidePath(chain[index - 1].canonical, chain[index].canonical)) {
      throw unsafe("unsafe browser profile directory", "directory_chain_escape");
    }
  }
}

async function inspectEntry(entry, boundary) {
  const absolute = resolve(entry);
  if (!insidePath(boundary, absolute)) {
    throw unsafe("unsafe browser profile path", "entry_path_escape");
  }

  let status;
  try {
    status = await lstat(absolute);
  } catch {
    throw unsafe("unsafe browser profile path", "entry_missing");
  }
  if (
    status.isSymbolicLink() ||
    (!status.isDirectory() && !status.isFile())
  ) {
    throw unsafe("unsafe browser profile path", "entry_type_unsafe");
  }
  const canonical = await realpath(absolute);
  if (
    pathKey(canonical) !== pathKey(absolute) ||
    !insidePath(boundary, canonical)
  ) {
    throw unsafe("unsafe browser profile path", "entry_realpath_escape");
  }
  const identity = Object.freeze({
    path: absolute,
    canonical,
    dev: status.dev,
    ino: status.ino,
    kind: status.isDirectory() ? "directory" : "file",
  });
  await assertIdentity(identity, boundary);
  if (identity.kind === "file") {
    return Object.freeze({ ...identity, children: Object.freeze([]) });
  }

  const names = (await readdir(absolute)).sort();
  if (!names.every(safeEntryName)) {
    throw unsafe("unsafe browser profile path", "entry_name_unsafe");
  }
  const children = [];
  for (const name of names) {
    await assertIdentity(identity, boundary);
    children.push(await inspectEntry(join(absolute, name), boundary));
  }
  await assertIdentity(identity, boundary);
  const after = (await readdir(absolute)).sort();
  if (
    after.length !== names.length ||
    after.some((name, index) => name !== names[index])
  ) {
    throw unsafe("unsafe browser profile path", "entry_tree_changed");
  }
  return Object.freeze({ ...identity, children: Object.freeze(children) });
}

async function removeInspectedEntry(entry, boundary, ancestors) {
  for (const ancestor of ancestors) await assertIdentity(ancestor, boundary);
  await assertIdentity(entry, boundary);
  if (entry.kind === "file") {
    await unlink(entry.path);
    return;
  }

  const nextAncestors = [...ancestors, entry];
  for (const child of entry.children) {
    await removeInspectedEntry(child, boundary, nextAncestors);
  }
  for (const ancestor of ancestors) await assertIdentity(ancestor, boundary);
  await assertIdentity(entry, boundary);
  if ((await readdir(entry.path)).length !== 0) {
    throw unsafe("unsafe browser profile path", "uninspected_entry_detected");
  }
  await rmdir(entry.path);
}

export async function cleanupStaleBrowserProfiles(studioRoot) {
  if (
    typeof studioRoot !== "string" ||
    studioRoot.length === 0 ||
    !isAbsolute(studioRoot)
  ) {
    throw new TypeError("studioRoot must be an absolute path");
  }

  const root = resolve(studioRoot);
  const rootIdentity = await optionalPlainDirectory(root);
  if (rootIdentity === null) {
    throw unsafe("unsafe browser profile directory", "studio_root_missing");
  }
  const runtimeRoot = join(root, ".runtime");
  const runtimeIdentity = await optionalPlainDirectory(runtimeRoot);
  if (runtimeIdentity === null) return Object.freeze([]);
  const browserRoot = join(runtimeRoot, "browser");
  const browserIdentity = await optionalPlainDirectory(browserRoot);
  if (browserIdentity === null) return Object.freeze([]);
  const chain = Object.freeze([rootIdentity, runtimeIdentity, browserIdentity]);
  await assertDirectoryChain(chain);

  const names = (await readdir(browserRoot)).sort();
  if (!names.every((name) => safeEntryName(name) && JOB_ID.test(name))) {
    throw unsafe("unsafe browser profile name", "invalid_job_directory_name");
  }

  const entries = [];
  for (const name of names) {
    await assertDirectoryChain(chain);
    const entry = await inspectEntry(join(browserRoot, name), browserIdentity.canonical);
    if (entry.kind !== "directory") {
      throw unsafe("unsafe browser profile path", "job_entry_not_directory");
    }
    entries.push(entry);
  }
  await assertDirectoryChain(chain);
  const afterInspection = (await readdir(browserRoot)).sort();
  if (
    afterInspection.length !== names.length ||
    afterInspection.some((name, index) => name !== names[index])
  ) {
    throw unsafe("unsafe browser profile path", "browser_tree_changed");
  }

  for (const entry of entries) {
    await assertDirectoryChain(chain);
    await removeInspectedEntry(entry, browserIdentity.canonical, []);
  }
  await assertDirectoryChain(chain);
  if ((await readdir(browserRoot)).length !== 0) {
    throw unsafe("unsafe browser profile path", "browser_tree_changed");
  }
  return Object.freeze(names);
}
