import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const CREDENTIAL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const RESERVED_NAMES = new Set([
  "aux",
  "clock$",
  "con",
  "nul",
  "prn",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);
const CIPHERTEXT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_STORED_BYTES = 2 * 1024 * 1024;

const DPAPI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.Security
  $requestText = [Console]::In.ReadToEnd()
  $request = $requestText | ConvertFrom-Json
  if ($null -eq $request -or $request.payload -isnot [string]) {
    throw 'invalid request'
  }
  if ($request.operation -eq 'protect') {
    $plainBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$request.payload)
    $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
      $plainBytes,
      $null,
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [Console]::Out.Write([Convert]::ToBase64String($protectedBytes))
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  } elseif ($request.operation -eq 'unprotect') {
    $protectedBytes = [Convert]::FromBase64String([string]$request.payload)
    $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $protectedBytes,
      $null,
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $plainText = [System.Text.Encoding]::UTF8.GetString($plainBytes)
    [Console]::Out.Write($plainText)
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    $plainText = $null
  } else {
    throw 'invalid operation'
  }
} catch {
  [Console]::Error.Write('DPAPI_OPERATION_FAILED')
  exit 20
}
`;
const ENCODED_DPAPI_SCRIPT = Buffer.from(DPAPI_SCRIPT, "utf16le").toString(
  "base64",
);
const POWERSHELL_ARGS = Object.freeze([
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
  ENCODED_DPAPI_SCRIPT,
]);

class CredentialVaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CredentialVaultError";
    this.code = code;
  }
}

function vaultError(code, message) {
  return new CredentialVaultError(code, message);
}

function validateName(name) {
  if (
    typeof name !== "string" ||
    !CREDENTIAL_NAME.test(name) ||
    RESERVED_NAMES.has(name.toLowerCase())
  ) {
    throw vaultError(
      "INVALID_CREDENTIAL_NAME",
      "The credential name is invalid.",
    );
  }
  return name;
}

function isWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalCredentialOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw vaultError("INVALID_CREDENTIALS", "The credentials are invalid.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw vaultError("INVALID_CREDENTIALS", "The credentials are invalid.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw vaultError("INVALID_CREDENTIALS", "The credentials are invalid.");
  }
  return parsed.origin;
}

function inspectCredentials(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw vaultError("INVALID_CREDENTIALS", "The credentials are invalid.");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 3 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !["origin", "username", "password"].includes(key),
    )
  ) {
    throw vaultError("INVALID_CREDENTIALS", "The credentials are invalid.");
  }
  const origin = Object.getOwnPropertyDescriptor(value, "origin");
  const username = Object.getOwnPropertyDescriptor(value, "username");
  const password = Object.getOwnPropertyDescriptor(value, "password");
  if (
    origin === undefined ||
    username === undefined ||
    password === undefined ||
    !("value" in origin) ||
    !("value" in username) ||
    !("value" in password) ||
    origin.enumerable !== true ||
    username.enumerable !== true ||
    password.enumerable !== true ||
    typeof username.value !== "string" ||
    typeof password.value !== "string" ||
    username.value.length === 0 ||
    username.value.length > 256 ||
    password.value.length === 0 ||
    password.value.length > 4_096 ||
    !isWellFormedUnicode(username.value) ||
    !isWellFormedUnicode(password.value)
  ) {
    throw vaultError("INVALID_CREDENTIALS", "The credentials are invalid.");
  }
  return Object.freeze({
    origin: canonicalCredentialOrigin(origin.value),
    username: username.value,
    password: password.value,
  });
}

function validateCredentials(value) {
  try {
    return inspectCredentials(value);
  } catch {
    throw vaultError("INVALID_CREDENTIALS", "The credentials are invalid.");
  }
}

function exactStoredPayload(value) {
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
    keys.length === 2 &&
    keys.includes("version") &&
    keys.includes("ciphertext") &&
    value.version === 2 &&
    typeof value.ciphertext === "string" &&
    value.ciphertext.length > 0 &&
    value.ciphertext.length <= MAX_STORED_BYTES &&
    value.ciphertext.length % 4 === 0 &&
    CIPHERTEXT.test(value.ciphertext)
  );
}

function canonicalPath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function ensureChild(root, candidate) {
  const target = resolve(candidate);
  const fromRoot = relative(root, target);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromRoot)
  ) {
    throw vaultError("UNSAFE_VAULT_PATH", "The credential path is unsafe.");
  }
  return target;
}

async function readEntry(path) {
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

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

async function inspectDirectoryPrefix(prefix) {
  const entry = await readEntry(prefix);
  if (
    entry === undefined ||
    entry.isSymbolicLink() ||
    !entry.isDirectory()
  ) {
    throw vaultError("UNSAFE_VAULT_ROOT", "The credential vault root is unsafe.");
  }
  const actual = await realpath(prefix);
  if (canonicalPath(actual) !== canonicalPath(prefix)) {
    throw vaultError("UNSAFE_VAULT_ROOT", "The credential vault root is unsafe.");
  }
  return entry;
}

async function verifyRoot(root, create) {
  try {
    const inspected = [];
    for (const prefix of pathPrefixes(root)) {
      let entry = await readEntry(prefix);
      if (entry === undefined) {
        if (!create) {
          throw vaultError(
            "UNSAFE_VAULT_ROOT",
            "The credential vault root is unsafe.",
          );
        }
        await mkdir(prefix, { mode: 0o700 });
      }
      entry = await inspectDirectoryPrefix(prefix);
      inspected.push({ entry, prefix });
    }
    for (const snapshot of inspected) {
      const current = await inspectDirectoryPrefix(snapshot.prefix);
      if (!sameIdentity(snapshot.entry, current)) {
        throw vaultError(
          "UNSAFE_VAULT_ROOT",
          "The credential vault root is unsafe.",
        );
      }
    }
  } catch {
    throw vaultError("UNSAFE_VAULT_ROOT", "The credential vault root is unsafe.");
  }
}

async function defaultRunPowerShell({
  command,
  args,
  env,
  input,
  timeoutMs,
}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(command, args, {
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      rejectPromise(new Error("PowerShell process failed."));
      return;
    }

    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const capture = (chunks) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.stdin.on("error", () => undefined);
    child.once("error", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      rejectPromise(new Error("PowerShell process failed."));
    });
    child.once("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode,
        outputExceeded,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
        timedOut,
      });
    });
    child.stdin.end(input, "utf8");
  });
}

async function renameReplacing(source, target) {
  let waited = 0;
  for (;;) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        error?.code !== "EPERM" ||
        waited >= 1_000
      ) {
        throw error;
      }
      await delay(10);
      waited += 10;
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
    }
  } finally {
    await handle.close();
  }
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
  const allowed = new Set(["root", "runPowerShell", "timeoutMs"]);
  const keys = Reflect.ownKeys(options);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    !keys.includes("root")
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
  return values;
}

function validateOptions(options) {
  try {
    const values = inspectOptions(options);
    const root = values.root;
    const runPowerShell = values.runPowerShell ?? defaultRunPowerShell;
    const timeoutMs = values.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      typeof root !== "string" ||
      !isAbsolute(root) ||
      typeof runPowerShell !== "function" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 30_000
    ) {
      throw new Error("invalid options");
    }
    return Object.freeze({ root: resolve(root), runPowerShell, timeoutMs });
  } catch {
    throw vaultError("UNSAFE_VAULT_ROOT", "The credential vault root is unsafe.");
  }
}

function validateRunnerResult(result, failureCode) {
  try {
    if (
      result === null ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      (Object.getPrototypeOf(result) !== Object.prototype &&
        Object.getPrototypeOf(result) !== null)
    ) {
      throw new Error("invalid result");
    }
    const keys = Reflect.ownKeys(result);
    const values = {};
    for (const key of keys) {
      if (typeof key !== "string") {
        throw new Error("invalid result");
      }
      const descriptor = Object.getOwnPropertyDescriptor(result, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error("invalid result");
      }
      values[key] = descriptor.value;
    }
    if (
      values.exitCode !== 0 ||
      values.timedOut === true ||
      values.outputExceeded === true ||
      typeof values.stdout !== "string" ||
      Buffer.byteLength(values.stdout, "utf8") > MAX_PROCESS_OUTPUT_BYTES
    ) {
      throw new Error("invalid result");
    }
    return values.stdout.trim();
  } catch {
    throw vaultError(failureCode, "The credential operation failed safely.");
  }
}

export class CredentialVault {
  #root;
  #runPowerShell;
  #timeoutMs;

  constructor(options = {}) {
    const { root, runPowerShell, timeoutMs } = validateOptions(options);
    this.#root = root;
    this.#runPowerShell = runPowerShell;
    this.#timeoutMs = timeoutMs;
  }

  pathFor(name) {
    const safeName = validateName(name);
    return ensureChild(this.#root, join(this.#root, `${safeName}.dpapi`));
  }

  async #execute(operation, payload, failureCode) {
    let result;
    try {
      result = await this.#runPowerShell({
        args: [...POWERSHELL_ARGS],
        command: "powershell.exe",
        env: {},
        input: JSON.stringify({ operation, payload }),
        shell: false,
        timeoutMs: this.#timeoutMs,
      });
    } catch {
      throw vaultError(failureCode, "The credential operation failed safely.");
    }
    return validateRunnerResult(result, failureCode);
  }

  async save(name, credentials) {
    const target = this.pathFor(name);
    const safeCredentials = validateCredentials(credentials);
    await verifyRoot(this.#root, true);
    const existing = await readEntry(target);
    if (
      existing !== undefined &&
      (existing.isSymbolicLink() || !existing.isFile())
    ) {
      throw vaultError("UNSAFE_VAULT_PATH", "The credential path is unsafe.");
    }

    const plaintext = JSON.stringify(safeCredentials);
    const ciphertext = await this.#execute(
      "protect",
      plaintext,
      "VAULT_ENCRYPT_FAILED",
    );
    if (
      ciphertext.length === 0 ||
      ciphertext.length > MAX_STORED_BYTES ||
      ciphertext.length % 4 !== 0 ||
      !CIPHERTEXT.test(ciphertext)
    ) {
      throw vaultError(
        "VAULT_ENCRYPT_FAILED",
        "The credential operation failed safely.",
      );
    }

    const temporary = ensureChild(
      this.#root,
      join(this.#root, `.credential-${randomUUID()}.tmp`),
    );
    let handle;
    let published = false;
    try {
      await verifyRoot(this.#root, false);
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ version: 2, ciphertext }), "utf8");
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await verifyRoot(this.#root, false);
      await renameReplacing(temporary, target);
      published = true;
      await syncDirectory(this.#root);
    } catch (error) {
      if (error instanceof CredentialVaultError) {
        throw error;
      }
      throw vaultError("VAULT_WRITE_FAILED", "The credential could not be stored.");
    } finally {
      await handle?.close();
      if (!published) {
        await rm(temporary, { force: true });
      }
    }
  }

  async load(name) {
    const target = this.pathFor(name);
    await verifyRoot(this.#root, false);
    const entry = await readEntry(target);
    if (entry === undefined) {
      throw vaultError("CREDENTIAL_NOT_FOUND", "The credential was not found.");
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw vaultError("UNSAFE_VAULT_PATH", "The credential path is unsafe.");
    }

    let stored;
    try {
      const bytes = await readFile(target);
      if (bytes.length === 0 || bytes.length > MAX_STORED_BYTES) {
        throw new Error("invalid stored length");
      }
      stored = JSON.parse(bytes.toString("utf8"));
      if (!exactStoredPayload(stored)) {
        throw new Error("invalid stored payload");
      }
    } catch {
      throw vaultError(
        "VAULT_DECRYPT_FAILED",
        "The stored credential could not be decrypted.",
      );
    }

    let plaintext;
    try {
      plaintext = await this.#execute(
        "unprotect",
        stored.ciphertext,
        "VAULT_DECRYPT_FAILED",
      );
      const parsed = JSON.parse(plaintext);
      const safeCredentials = validateCredentials(parsed);
      return Object.freeze({ ...safeCredentials });
    } catch {
      throw vaultError(
        "VAULT_DECRYPT_FAILED",
        "The stored credential could not be decrypted.",
      );
    }
  }
}
