import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

const OPERATION_DIRECTORY = /^op-[a-f0-9]{32}$/u;
const DOTENV_FILE = ".mcp-redaction.env";
const MAX_USERNAME_LENGTH = 256;
const MAX_PASSWORD_LENGTH = 4_096;
const ACL_TIMEOUT_MS = 10_000;
const MAX_ACL_OUTPUT_BYTES = 64 * 1024;

const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $request = ([Console]::In.ReadToEnd() | ConvertFrom-Json)
  if ($null -eq $request -or $request.path -isnot [string]) {
    throw 'invalid request'
  }
  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  if ($request.kind -eq 'directory') {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($current)
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
      $current, $rights, $inheritance, $propagation, $allow
    ))
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
      $system, $rights, $inheritance, $propagation, $allow
    ))
  } elseif ($request.kind -eq 'file') {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($current)
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
      $current, $rights, $allow
    ))
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
      $system, $rights, $allow
    ))
  } else {
    throw 'invalid kind'
  }
  if ($request.kind -eq 'directory') {
    [System.IO.Directory]::SetAccessControl(([string]$request.path), $acl)
  } else {
    [System.IO.File]::SetAccessControl(([string]$request.path), $acl)
  }
} catch {
  [Console]::Error.Write('ACL_OPERATION_FAILED')
  exit 21
}
`;
const ENCODED_ACL_SCRIPT = Buffer.from(ACL_SCRIPT, "utf16le").toString("base64");
const ACL_ARGUMENTS = Object.freeze([
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
  ENCODED_ACL_SCRIPT,
]);

class EphemeralSecretsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EphemeralSecretsError";
    this.code = code;
  }
}

function ephemeralError(code, message) {
  return new EphemeralSecretsError(code, message);
}

function validateRoot(runtimeRoot) {
  if (typeof runtimeRoot !== "string" || !isAbsolute(runtimeRoot)) {
    throw ephemeralError(
      "UNSAFE_EPHEMERAL_ROOT",
      "The ephemeral secrets root is unsafe.",
    );
  }
  let root;
  try {
    root = resolve(runtimeRoot);
  } catch {
    throw ephemeralError(
      "UNSAFE_EPHEMERAL_ROOT",
      "The ephemeral secrets root is unsafe.",
    );
  }
  const parsed = parse(root);
  const segments = root
    .slice(parsed.root.length)
    .split(/[\\/]/u)
    .filter(Boolean)
    .map((segment) =>
      process.platform === "win32" ? segment.toLowerCase() : segment,
    );
  if (
    segments.length < 3 ||
    segments.at(-2) !== ".runtime" ||
    segments.at(-1) !== "secrets" ||
    segments.some(
      (segment, index) =>
        segment === "data" && segments[index + 1] === "jobs",
    )
  ) {
    throw ephemeralError(
      "UNSAFE_EPHEMERAL_ROOT",
      "The ephemeral secrets root is unsafe.",
    );
  }
  return root;
}

function canonicalPath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function ensureContained(root, candidate, { allowRoot = false } = {}) {
  const target = resolve(candidate);
  const fromRoot = relative(root, target);
  const escaped =
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot);
  if (escaped || (!allowRoot && fromRoot === "")) {
    throw ephemeralError(
      "UNSAFE_EPHEMERAL_PATH",
      "The ephemeral secret path is unsafe.",
    );
  }
  return target;
}

async function safeLstat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function pathPrefixes(path) {
  const parsed = parse(path);
  const parts = path.slice(parsed.root.length).split(/[\\/]/u).filter(Boolean);
  const prefixes = [];
  let current = parsed.root;
  for (const part of parts) {
    current = join(current, part);
    prefixes.push(current);
  }
  return prefixes;
}

async function verifyRoot(runtimeRoot, { create }) {
  const root = validateRoot(runtimeRoot);
  const prefixes = pathPrefixes(root);
  let missing = false;
  for (const prefix of prefixes) {
    const entry = await safeLstat(prefix);
    if (entry === undefined) {
      missing = true;
      break;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw ephemeralError(
        "UNSAFE_EPHEMERAL_ROOT",
        "The ephemeral secrets root is unsafe.",
      );
    }
  }

  if (missing && !create) {
    return Object.freeze({ exists: false, root });
  }
  if (missing) {
    try {
      await mkdir(root, { mode: 0o700, recursive: true });
    } catch {
      throw ephemeralError(
        "UNSAFE_EPHEMERAL_ROOT",
        "The ephemeral secrets root is unsafe.",
      );
    }
  }

  for (const prefix of prefixes) {
    const entry = await safeLstat(prefix);
    if (
      entry === undefined ||
      entry.isSymbolicLink() ||
      !entry.isDirectory()
    ) {
      throw ephemeralError(
        "UNSAFE_EPHEMERAL_ROOT",
        "The ephemeral secrets root is unsafe.",
      );
    }
  }
  let actual;
  try {
    actual = await realpath(root);
  } catch {
    throw ephemeralError(
      "UNSAFE_EPHEMERAL_ROOT",
      "The ephemeral secrets root is unsafe.",
    );
  }
  if (canonicalPath(actual) !== canonicalPath(root)) {
    throw ephemeralError(
      "UNSAFE_EPHEMERAL_ROOT",
      "The ephemeral secrets root is unsafe.",
    );
  }
  if (process.platform !== "win32") {
    await chmod(root, 0o700);
  }
  return Object.freeze({ exists: true, root });
}

function inspectCredentials(credentials) {
  if (
    credentials === null ||
    typeof credentials !== "object" ||
    Array.isArray(credentials) ||
    (Object.getPrototypeOf(credentials) !== Object.prototype &&
      Object.getPrototypeOf(credentials) !== null)
  ) {
    throw ephemeralError(
      "INVALID_EPHEMERAL_CREDENTIALS",
      "The ephemeral credentials are invalid.",
    );
  }
  const keys = Reflect.ownKeys(credentials);
  if (
    keys.length !== 2 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "username" && key !== "password"),
    )
  ) {
    throw ephemeralError(
      "INVALID_EPHEMERAL_CREDENTIALS",
      "The ephemeral credentials are invalid.",
    );
  }
  const username = Object.getOwnPropertyDescriptor(credentials, "username");
  const password = Object.getOwnPropertyDescriptor(credentials, "password");
  if (
    username === undefined ||
    password === undefined ||
    !("value" in username) ||
    !("value" in password) ||
    username.enumerable !== true ||
    password.enumerable !== true ||
    typeof username.value !== "string" ||
    typeof password.value !== "string" ||
    username.value.length === 0 ||
    username.value.length > MAX_USERNAME_LENGTH ||
    password.value.length === 0 ||
    password.value.length > MAX_PASSWORD_LENGTH ||
    /[\0\r\n]/u.test(username.value) ||
    /[\0\r\n]/u.test(password.value)
  ) {
    throw ephemeralError(
      "INVALID_EPHEMERAL_CREDENTIALS",
      "The ephemeral credentials are invalid.",
    );
  }
  return Object.freeze({
    username: username.value,
    password: password.value,
  });
}

function validateCredentials(credentials) {
  try {
    return inspectCredentials(credentials);
  } catch {
    throw ephemeralError(
      "INVALID_EPHEMERAL_CREDENTIALS",
      "The ephemeral credentials are invalid.",
    );
  }
}

function quoteDotenv(value) {
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  if (!value.includes("`")) {
    return `\`${value}\``;
  }
  if (!value.includes('"') && !/\\[nr]/u.test(value)) {
    return `"${value}"`;
  }
  throw ephemeralError(
    "INVALID_EPHEMERAL_CREDENTIALS",
    "The ephemeral credentials are invalid.",
  );
}

function serializeDotenv(credentials) {
  return (
    `MCP_REDACT_USERNAME=${quoteDotenv(credentials.username)}\n` +
    `MCP_REDACT_PASSWORD=${quoteDotenv(credentials.password)}\n`
  );
}

async function runAclPowerShell(input) {
  return await new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn("powershell.exe", ACL_ARGUMENTS, {
        env: {},
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      rejectPromise(new Error("ACL process failed."));
      return;
    }
    let outputBytes = 0;
    let exceeded = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, ACL_TIMEOUT_MS);
    const count = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_ACL_OUTPUT_BYTES) {
        exceeded = true;
        child.kill();
      }
    };
    child.stdout.on("data", count);
    child.stderr.on("data", count);
    child.stdin.on("error", () => undefined);
    child.once("error", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      rejectPromise(new Error("ACL process failed."));
    });
    child.once("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (exitCode !== 0 || timedOut || exceeded) {
        rejectPromise(new Error("ACL process failed."));
      } else {
        resolvePromise();
      }
    });
    child.stdin.end(input, "utf8");
  });
}

async function defaultApplyAcl({ path, kind }) {
  try {
    if (process.platform === "win32") {
      await runAclPowerShell(JSON.stringify({ path, kind }));
    } else {
      await chmod(path, kind === "directory" ? 0o700 : 0o600);
    }
  } catch {
    throw ephemeralError(
      "EPHEMERAL_ACL_FAILED",
      "The ephemeral secret ACL could not be applied.",
    );
  }
}

function assertNotAborted(signal) {
  if (signal?.aborted === true) {
    throw ephemeralError(
      "EPHEMERAL_OPERATION_ABORTED",
      "The ephemeral secret operation was aborted.",
    );
  }
}

async function createOperationDirectory(root) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const operation = ensureContained(
      root,
      join(root, `op-${randomBytes(16).toString("hex")}`),
    );
    try {
      await mkdir(operation, { mode: 0o700 });
      return operation;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw ephemeralError(
    "EPHEMERAL_CREATE_FAILED",
    "The ephemeral secret directory could not be created.",
  );
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

async function exactRegularEntry(path, snapshot) {
  const current = await safeLstat(path);
  if (
    current === undefined ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameIdentity(snapshot, current)
  ) {
    return false;
  }
  const actual = await realpath(path);
  return canonicalPath(actual) === canonicalPath(path);
}

async function exactDirectoryEntry(path, snapshot) {
  const current = await safeLstat(path);
  if (
    current === undefined ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameIdentity(snapshot, current)
  ) {
    return false;
  }
  const actual = await realpath(path);
  return canonicalPath(actual) === canonicalPath(path);
}

async function removeStrictOperationDirectory(root, target) {
  ensureContained(root, target);
  const entry = await safeLstat(target);
  if (entry === undefined) {
    return "missing";
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    return "skipped";
  }
  const actual = await realpath(target);
  if (
    canonicalPath(actual) !== canonicalPath(target) ||
    relative(root, actual).startsWith("..") ||
    isAbsolute(relative(root, actual))
  ) {
    throw ephemeralError(
      "UNSAFE_EPHEMERAL_PATH",
      "The ephemeral secret path is unsafe.",
    );
  }
  const names = await readdir(target);
  if (names.length === 0) {
    if (!(await exactDirectoryEntry(target, entry))) {
      return "skipped";
    }
    await rmdir(target);
    return "removed";
  }
  if (names.length !== 1 || names[0] !== DOTENV_FILE) {
    return "skipped";
  }

  const secretPath = ensureContained(root, join(target, DOTENV_FILE));
  const secretEntry = await safeLstat(secretPath);
  if (
    secretEntry === undefined ||
    secretEntry.isSymbolicLink() ||
    !secretEntry.isFile() ||
    !(await exactRegularEntry(secretPath, secretEntry))
  ) {
    return "skipped";
  }
  await unlink(secretPath);
  if (
    (await readdir(target)).length !== 0 ||
    !(await exactDirectoryEntry(target, entry))
  ) {
    return "skipped";
  }
  await rmdir(target);
  return "removed";
}

function inspectOptions(options) {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype &&
      Object.getPrototypeOf(options) !== null)
  ) {
    throw new Error("invalid options");
  }
  const keys = Reflect.ownKeys(options);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "signal" && key !== "applyAcl"),
    )
  ) {
    throw new Error("invalid options");
  }
  const values = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new Error("invalid options");
    }
    values[key] = descriptor.value;
  }
  const signal = values.signal;
  const applyAcl = values.applyAcl ?? defaultApplyAcl;
  if (
    (signal !== undefined &&
      (typeof signal !== "object" ||
        Object.getPrototypeOf(signal) !== AbortSignal.prototype)) ||
    typeof applyAcl !== "function"
  ) {
    throw new Error("invalid options");
  }
  return Object.freeze({ applyAcl, signal });
}

function validateOptions(options) {
  try {
    return inspectOptions(options);
  } catch {
    throw ephemeralError(
      "INVALID_EPHEMERAL_OPTIONS",
      "The ephemeral secret options are invalid.",
    );
  }
}

export async function withEphemeralSecrets(
  runtimeRoot,
  credentials,
  fn,
  options = {},
) {
  const safeCredentials = validateCredentials(credentials);
  const dotenvText = serializeDotenv(safeCredentials);
  if (typeof fn !== "function") {
    throw ephemeralError(
      "INVALID_EPHEMERAL_CALLBACK",
      "The ephemeral secret callback is invalid.",
    );
  }
  const { applyAcl, signal } = validateOptions(options);
  assertNotAborted(signal);
  const { root } = await verifyRoot(runtimeRoot, { create: true });
  assertNotAborted(signal);
  let operation;
  let handle;
  try {
    operation = await createOperationDirectory(root);
    await applyAcl(Object.freeze({ kind: "directory", path: operation }));
    assertNotAborted(signal);
    const secretPath = ensureContained(root, join(operation, DOTENV_FILE));
    handle = await open(secretPath, "wx", 0o600);
    await applyAcl(Object.freeze({ kind: "file", path: secretPath }));
    assertNotAborted(signal);
    await handle.writeFile(dotenvText, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    assertNotAborted(signal);
    return await fn(secretPath, Object.freeze({ signal }));
  } finally {
    await handle?.close();
    if (operation !== undefined) {
      try {
        const outcome = await removeStrictOperationDirectory(root, operation);
        if (outcome === "skipped") {
          throw new Error("unsafe cleanup structure");
        }
      } catch {
        throw ephemeralError(
          "EPHEMERAL_CLEANUP_FAILED",
          "The ephemeral secret directory could not be removed.",
        );
      }
    }
  }
}

export async function scavengeEphemeralSecrets(runtimeRoot) {
  const verified = await verifyRoot(runtimeRoot, { create: false });
  if (!verified.exists) {
    return 0;
  }
  let removed = 0;
  for (const name of await readdir(verified.root)) {
    if (!OPERATION_DIRECTORY.test(name)) {
      continue;
    }
    const target = ensureContained(verified.root, join(verified.root, name));
    const entry = await safeLstat(target);
    if (
      entry === undefined ||
      entry.isSymbolicLink() ||
      !entry.isDirectory()
    ) {
      continue;
    }
    if ((await removeStrictOperationDirectory(verified.root, target)) === "removed") {
      removed += 1;
    }
  }
  return removed;
}
