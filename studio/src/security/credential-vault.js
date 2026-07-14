import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
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

function validateCredentials(value) {
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
    keys.length !== 2 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "username" && key !== "password"),
    )
  ) {
    throw vaultError("INVALID_CREDENTIALS", "The credentials are invalid.");
  }
  const username = Object.getOwnPropertyDescriptor(value, "username");
  const password = Object.getOwnPropertyDescriptor(value, "password");
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
    username.value.length > 256 ||
    password.value.length === 0 ||
    password.value.length > 4_096
  ) {
    throw vaultError("INVALID_CREDENTIALS", "The credentials are invalid.");
  }
  return Object.freeze({
    username: username.value,
    password: password.value,
  });
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
    value.version === 1 &&
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

async function verifyRoot(root, create) {
  let entry = await readEntry(root);
  if (entry === undefined && create) {
    await mkdir(root, { mode: 0o700, recursive: true });
    entry = await readEntry(root);
  }
  if (
    entry === undefined ||
    entry.isSymbolicLink() ||
    !entry.isDirectory()
  ) {
    throw vaultError("UNSAFE_VAULT_ROOT", "The credential vault root is unsafe.");
  }
  let actual;
  try {
    actual = await realpath(root);
  } catch {
    throw vaultError("UNSAFE_VAULT_ROOT", "The credential vault root is unsafe.");
  }
  if (canonicalPath(actual) !== canonicalPath(root)) {
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

export class CredentialVault {
  #root;
  #runPowerShell;
  #timeoutMs;

  constructor({ root, runPowerShell = defaultRunPowerShell, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (
      typeof root !== "string" ||
      !isAbsolute(root) ||
      typeof runPowerShell !== "function" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 30_000
    ) {
      throw vaultError("UNSAFE_VAULT_ROOT", "The credential vault root is unsafe.");
    }
    this.#root = resolve(root);
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
    if (
      result === null ||
      typeof result !== "object" ||
      result.exitCode !== 0 ||
      result.timedOut === true ||
      result.outputExceeded === true ||
      typeof result.stdout !== "string" ||
      Buffer.byteLength(result.stdout, "utf8") > MAX_PROCESS_OUTPUT_BYTES
    ) {
      throw vaultError(failureCode, "The credential operation failed safely.");
    }
    return result.stdout.trim();
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
    let committed = false;
    try {
      await verifyRoot(this.#root, false);
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ version: 1, ciphertext }), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await verifyRoot(this.#root, false);
      await renameReplacing(temporary, target);
      await chmod(target, 0o600);
      committed = true;
    } catch (error) {
      if (error instanceof CredentialVaultError) {
        throw error;
      }
      throw vaultError("VAULT_WRITE_FAILED", "The credential could not be stored.");
    } finally {
      await handle?.close();
      if (!committed) {
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
