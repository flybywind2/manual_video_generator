import { spawn } from "node:child_process";
import { isAbsolute, extname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { createRedactor } from "../security/redactor.js";

const OPTION_KEYS = new Set([
  "command",
  "args",
  "cwd",
  "env",
  "signal",
  "timeoutMs",
  "onLine",
  "redactor",
  "spawnProcess",
  "killTree",
]);
const NODE_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_ARGUMENTS = 512;
const MAX_ARGUMENT_BYTES = 256 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 512;
const MAX_ENVIRONMENT_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const CALLBACK_SETTLEMENT_MS = 1_000;

export class ProcessRunError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProcessRunError";
    this.code = code;
  }

  toJSON() {
    return Object.freeze({
      name: this.name,
      code: this.code,
      message: this.message,
    });
  }
}

function processError(code, message) {
  return new ProcessRunError(code, message);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataValue(record, key, { required = false } = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) {
    if (required) {
      throw new Error("missing");
    }
    return undefined;
  }
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    throw new Error("unsafe descriptor");
  }
  return descriptor.value;
}

function readStringArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error("invalid array");
  }
  const keys = Reflect.ownKeys(value);
  if (
    value.length > MAX_ARGUMENTS ||
    keys.length !== value.length + 1 ||
    keys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)),
    )
  ) {
    throw new Error("invalid array");
  }
  let bytes = 0;
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      typeof descriptor.value !== "string" ||
      descriptor.value.includes("\0")
    ) {
      throw new Error("invalid argument");
    }
    bytes += Buffer.byteLength(descriptor.value);
    if (bytes > MAX_ARGUMENT_BYTES) {
      throw new Error("arguments too large");
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function readEnvironment(value) {
  if (!isPlainRecord(value)) {
    throw new Error("invalid environment");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new Error("environment too large");
  }
  const result = Object.create(null);
  const normalizedKeys = new Set();
  let bytes = 0;
  for (const key of keys) {
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.includes("=") ||
      key.includes("\0") ||
      FORBIDDEN_KEYS.has(key)
    ) {
      throw new Error("invalid environment key");
    }
    const normalizedKey = key.toUpperCase();
    if (normalizedKeys.has(normalizedKey)) {
      throw new Error("duplicate environment key");
    }
    normalizedKeys.add(normalizedKey);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      typeof descriptor.value !== "string" ||
      descriptor.value.includes("\0")
    ) {
      throw new Error("invalid environment value");
    }
    bytes += Buffer.byteLength(key) + Buffer.byteLength(descriptor.value);
    if (bytes > MAX_ENVIRONMENT_BYTES) {
      throw new Error("environment too large");
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function readRedactor(value) {
  if (value === undefined) {
    return createRedactor();
  }
  if (!isPlainRecord(value)) {
    throw new Error("invalid redactor");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => key !== "text" && key !== "value")) {
    throw new Error("invalid redactor");
  }
  const text = dataValue(value, "text", { required: true });
  const redactValue = dataValue(value, "value", { required: true });
  if (typeof text !== "function" || typeof redactValue !== "function") {
    throw new Error("invalid redactor");
  }
  return value;
}

function inspectOptions(options) {
  if (!isPlainRecord(options)) {
    throw new Error("invalid options");
  }
  const keys = Reflect.ownKeys(options);
  if (
    keys.some(
      (key) => typeof key !== "string" || !OPTION_KEYS.has(key),
    )
  ) {
    throw new Error("unknown option");
  }
  const command = dataValue(options, "command", { required: true });
  const args = readStringArray(dataValue(options, "args", { required: true }));
  const cwd = dataValue(options, "cwd", { required: true });
  const env = readEnvironment(dataValue(options, "env", { required: true }));
  const signal = dataValue(options, "signal");
  const timeoutMs = dataValue(options, "timeoutMs", { required: true });
  const onLine = dataValue(options, "onLine");
  const redactor = readRedactor(dataValue(options, "redactor"));
  const spawnProcess = dataValue(options, "spawnProcess") ?? spawn;
  const killTree = dataValue(options, "killTree") ?? killProcessTree;

  if (
    typeof command !== "string" ||
    !isAbsolute(command) ||
    command.includes("\0") ||
    typeof cwd !== "string" ||
    !isAbsolute(cwd) ||
    cwd.includes("\0") ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS ||
    (onLine !== undefined && typeof onLine !== "function") ||
    typeof spawnProcess !== "function" ||
    typeof killTree !== "function" ||
    (signal !== undefined &&
      (typeof signal !== "object" ||
        Object.getPrototypeOf(signal) !== AbortSignal.prototype))
  ) {
    throw new Error("invalid option value");
  }

  const isNodeCommand = process.platform === "win32"
    ? command.toLowerCase() === process.execPath.toLowerCase()
    : command === process.execPath;
  if (isNodeCommand) {
    if (
      args.length === 0 ||
      !isAbsolute(args[0]) ||
      !NODE_EXTENSIONS.has(extname(args[0]).toLowerCase())
    ) {
      throw new Error("invalid Node entry");
    }
  } else if (extname(command).toLowerCase() !== ".exe") {
    throw new Error("invalid native executable");
  }

  return Object.freeze({
    command,
    args,
    cwd,
    env,
    signal,
    timeoutMs,
    onLine,
    redactor,
    spawnProcess,
    killTree,
  });
}

function validateOptions(options) {
  try {
    return inspectOptions(options);
  } catch {
    throw processError(
      "INVALID_PROCESS_OPTIONS",
      "The process options are invalid.",
    );
  }
}

async function runTaskkill(pid) {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const taskkill = join(systemRoot, "System32", "taskkill.exe");
  return await new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
        env: { SystemRoot: systemRoot },
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolvePromise(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise(false);
    }, 5_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolvePromise(false);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise(exitCode === 0);
    });
  });
}

function childHasStopped(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try {
    process.kill(child.pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

async function waitForChildStopped(child, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childHasStopped(child)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  return childHasStopped(child);
}

export async function killProcessTree(child) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid < 1) {
    return;
  }
  let requested = true;
  if (process.platform === "win32") {
    requested = await runTaskkill(child.pid);
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        requested = false;
      }
    }
  }
  if (await waitForChildStopped(child)) return;
  if (!requested || !childHasStopped(child)) {
    throw processError("PROCESS_TERMINATION_FAILED", "The process termination could not be confirmed.");
  }
}

function frozenResult(exitCode, signal, stdout, stderr, lines) {
  return Object.freeze({
    exitCode,
    signal,
    stdout,
    stderr,
    lines: Object.freeze([...lines]),
  });
}

export async function runProcess(options) {
  const settings = validateOptions(options);
  if (settings.signal?.aborted) {
    throw processError("PROCESS_ABORTED", "The process was aborted.");
  }

  return await new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = settings.spawnProcess(settings.command, [...settings.args], {
        cwd: settings.cwd,
        env: { ...settings.env },
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      rejectPromise(processError("PROCESS_SPAWN_FAILED", "The process could not be started."));
      return;
    }

    const outputs = { stdout: "", stderr: "" };
    const pending = { stdout: "", stderr: "" };
    const decoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    const lines = [];
    let outputBytes = 0;
    let callbackChain = Promise.resolve();
    let failure;
    let closed = false;
    let settled = false;
    let killing = false;
    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      settings.signal?.removeEventListener("abort", abort);
    };

    const settleFailure = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(failure ?? processError("PROCESS_TERMINATION_FAILED", "The process did not stop safely."));
    };

    const terminate = (error) => {
      if (failure === undefined) {
        failure = error;
      }
      if (!killing) {
        killing = true;
        clearTimeout(timer);
        void Promise.resolve(settings.killTree(child))
          .then(async () => {
            if (!closed && !(await waitForChildStopped(child, 250))) {
              failure = processError("PROCESS_TERMINATION_FAILED", "The process termination could not be confirmed.");
            }
          })
          .catch(() => {
            failure = processError("PROCESS_TERMINATION_FAILED", "The process termination could not be confirmed.");
          })
          .finally(() => {
            if (!closed) {
              settleFailure();
            }
          });
      }
    };

    const deliverLine = (stream, rawText, terminated) => {
      const rawBytes = Buffer.byteLength(rawText);
      if (rawBytes > MAX_LINE_BYTES) {
        terminate(processError("PROCESS_OUTPUT_LIMIT", "The process output limit was exceeded."));
        return;
      }
      let text;
      try {
        text = settings.redactor.text(rawText);
      } catch {
        terminate(processError("PROCESS_REDACTION_FAILED", "The process output could not be redacted."));
        return;
      }
      if (typeof text !== "string") {
        terminate(processError("PROCESS_REDACTION_FAILED", "The process output could not be redacted."));
        return;
      }
      const event = Object.freeze({ stream, text });
      lines.push(event);
      outputs[stream] += text + (terminated ? "\n" : "");
      if (settings.onLine) {
        callbackChain = callbackChain
          .then(() => settings.onLine(event))
          .catch(() => {
            terminate(processError("PROCESS_CALLBACK_FAILED", "The process output callback failed."));
          });
      }
    };

    const consume = (stream, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminate(processError("PROCESS_OUTPUT_LIMIT", "The process output limit was exceeded."));
        return;
      }
      pending[stream] += decoders[stream].write(chunk);
      while (true) {
        const newline = pending[stream].indexOf("\n");
        if (newline === -1) {
          if (Buffer.byteLength(pending[stream]) > MAX_LINE_BYTES) {
            terminate(processError("PROCESS_OUTPUT_LIMIT", "The process output limit was exceeded."));
          }
          return;
        }
        let line = pending[stream].slice(0, newline);
        pending[stream] = pending[stream].slice(newline + 1);
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }
        deliverLine(stream, line, true);
      }
    };

    const flush = (stream) => {
      pending[stream] += decoders[stream].end();
      if (pending[stream].length > 0) {
        deliverLine(stream, pending[stream], false);
        pending[stream] = "";
      }
    };

    child.stdout.on("data", (chunk) => consume("stdout", chunk));
    child.stderr.on("data", (chunk) => consume("stderr", chunk));
    child.once("error", () => {
      terminate(processError("PROCESS_SPAWN_FAILED", "The process could not be started."));
      if (!closed && !settled) {
        settled = true;
        cleanup();
        rejectPromise(failure);
      }
    });

    timer = setTimeout(() => {
      terminate(processError("PROCESS_TIMEOUT", "The process timed out."));
    }, settings.timeoutMs);

    const abort = () => {
      terminate(processError("PROCESS_ABORTED", "The process was aborted."));
    };
    settings.signal?.addEventListener("abort", abort, { once: true });

    child.once("close", (exitCode, signal) => {
      closed = true;
      clearTimeout(timer);
      settings.signal?.removeEventListener("abort", abort);
      flush("stdout");
      flush("stderr");
      let callbackTimer;
      const callbacksSettled = Promise.race([
        callbackChain.then(() => true),
        new Promise((resolveCallback) => {
          callbackTimer = setTimeout(() => resolveCallback(false), CALLBACK_SETTLEMENT_MS);
        }),
      ]);
      void callbacksSettled.then((completed) => {
        clearTimeout(callbackTimer);
        if (settled) {
          return;
        }
        if (!completed && failure === undefined) {
          failure = processError("PROCESS_CALLBACK_FAILED", "The process output callback failed.");
        }
        settled = true;
        cleanup();
        if (failure) {
          rejectPromise(failure);
        } else {
          resolvePromise(frozenResult(exitCode, signal, outputs.stdout, outputs.stderr, lines));
        }
      });
    });
  });
}
