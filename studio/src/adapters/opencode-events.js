import { createRedactor } from "../security/redactor.js";

const KNOWN_TYPES = new Set([
  "step_start",
  "text",
  "tool_use",
  "reasoning",
  "step_finish",
  "error",
]);
const PART_TYPES = Object.freeze({
  step_start: "step-start",
  text: "text",
  tool_use: "tool",
  reasoning: "reasoning",
  step_finish: "step-finish",
});
const WRITE_CAPABLE_TOOLS = new Set([
  "playwright_browser_snapshot",
  "playwright_browser_take_screenshot",
  "playwright_browser_start_video",
]);
const MAX_LINE_BYTES = 256 * 1024;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_FINAL_TEXT_BYTES = 1024 * 1024;
const MAX_EVENTS = 10_000;
const MAX_DEPTH = 64;
const MAX_NODES = 20_000;

export class OpenCodeEventError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenCodeEventError";
    this.code = code;
  }

  toJSON() {
    return Object.freeze({ name: this.name, code: this.code, message: this.message });
  }
}

function eventError(code, message) {
  return new OpenCodeEventError(code, message);
}

function isPlain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateData(value, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_NODES || depth > MAX_DEPTH) {
    throw new Error("limit");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object" || state.seen.has(value)) {
    throw new Error("unsafe value");
  }
  state.seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error("unsafe array");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      keys.some(
        (key) =>
          key !== "length" &&
          (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)),
      )
    ) {
      throw new Error("sparse array");
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("unsafe array item");
      }
      validateData(descriptor.value, state, depth + 1);
    }
  } else {
    if (!isPlain(value)) {
      throw new Error("unsafe object");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (
        typeof key !== "string" ||
        key === "__proto__" ||
        key === "constructor" ||
        key === "prototype"
      ) {
        throw new Error("unsafe object key");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("unsafe object value");
      }
      validateData(descriptor.value, state, depth + 1);
    }
  }
  state.seen.delete(value);
}

function safeEvent(value, redactor) {
  try {
    validateData(value, { nodes: 0, seen: new WeakSet() });
    const sanitized = redactor.value(value);
    if (!isPlain(sanitized)) {
      throw new Error("redaction failed");
    }
    return sanitized;
  } catch {
    throw eventError("OPENCODE_EVENT_MALFORMED", "The OpenCode event is malformed.");
  }
}

function readString(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function readRecord(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor && isPlain(descriptor.value)
    ? descriptor.value
    : undefined;
}

function freezeToolEvent(part) {
  const state = readRecord(part, "state");
  const callId = readString(part, "callID") ?? readString(part, "callId");
  const tool = readString(part, "tool");
  const status = state && readString(state, "status");
  const input = state && Object.hasOwn(state, "input") ? state.input : undefined;
  if (
    !state ||
    !callId ||
    callId.length > 256 ||
    !tool ||
    tool.length > 256 ||
    !/^playwright_[a-z0-9_]+$/u.test(tool) ||
    !status ||
    status.length > 64 ||
    !/^[a-z][a-z0-9_-]*$/u.test(status) ||
    !isPlain(input)
  ) {
    throw eventError(
      "OPENCODE_EVENT_MALFORMED",
      "The OpenCode tool event is malformed.",
    );
  }
  if (WRITE_CAPABLE_TOOLS.has(tool) && Object.hasOwn(input, "filename")) {
    throw eventError(
      "OPENCODE_UNSAFE_TOOL_INPUT",
      "OpenCode supplied an unsafe evidence filename.",
    );
  }
  return Object.freeze({
    callId,
    tool,
    status,
    input,
    output: Object.hasOwn(state, "output") ? state.output : null,
  });
}

function inspectParserOptions(options) {
  if (!isPlain(options)) {
    throw eventError("INVALID_OPENCODE_EVENT_OPTIONS", "The OpenCode event options are invalid.");
  }
  const keys = Reflect.ownKeys(options);
  if (keys.some((key) => key !== "redactor")) {
    throw eventError("INVALID_OPENCODE_EVENT_OPTIONS", "The OpenCode event options are invalid.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, "redactor");
  if (descriptor && !("value" in descriptor)) {
    throw eventError("INVALID_OPENCODE_EVENT_OPTIONS", "The OpenCode event options are invalid.");
  }
  const redactor = descriptor?.value ?? createRedactor();
  if (!isPlain(redactor) || typeof redactor.text !== "function" || typeof redactor.value !== "function") {
    throw eventError("INVALID_OPENCODE_EVENT_OPTIONS", "The OpenCode event options are invalid.");
  }
  return redactor;
}

export class OpenCodeEventParser {
  #redactor;
  #sessionId;
  #text = "";
  #completed = false;
  #hadError = false;
  #events = [];
  #unknownEvents = [];
  #toolEvents = [];
  #diagnostics = [];
  #bytes = 0;
  #finished = false;
  #iteration = null;

  constructor(options = {}) {
    this.#redactor = inspectParserOptions(options);
  }

  push(input) {
    if (this.#finished) {
      throw eventError("OPENCODE_EVENT_STATE", "The OpenCode event parser is already finished.");
    }
    if (this.#events.length + this.#diagnostics.length >= MAX_EVENTS) {
      throw eventError("OPENCODE_EVENT_LIMIT", "The OpenCode event limit was exceeded.");
    }

    let value = input;
    if (typeof input === "string") {
      const bytes = Buffer.byteLength(input);
      this.#bytes += bytes;
      if (bytes > MAX_LINE_BYTES || this.#bytes > MAX_STREAM_BYTES) {
        throw eventError("OPENCODE_EVENT_LIMIT", "The OpenCode event limit was exceeded.");
      }
      const trimmed = input.trimStart();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        let diagnostic;
        try {
          diagnostic = this.#redactor.text(input);
        } catch {
          throw eventError("OPENCODE_EVENT_MALFORMED", "The OpenCode diagnostic is malformed.");
        }
        if (typeof diagnostic !== "string") {
          throw eventError("OPENCODE_EVENT_MALFORMED", "The OpenCode diagnostic is malformed.");
        }
        this.#diagnostics.push(diagnostic);
        return Object.freeze({ kind: "diagnostic", text: diagnostic });
      }
      try {
        value = JSON.parse(input);
      } catch {
        throw eventError("OPENCODE_EVENT_MALFORMED", "The OpenCode event is malformed.");
      }
    }

    const safe = safeEvent(value, this.#redactor);
    const type = readString(safe, "type");
    if (!type) {
      throw eventError("OPENCODE_EVENT_MALFORMED", "The OpenCode event is malformed.");
    }
    if (!KNOWN_TYPES.has(type)) {
      throw eventError("OPENCODE_EVENT_UNKNOWN", "The OpenCode event type is not supported.");
    }

    const eventSessionId = readString(safe, "sessionID") ?? readString(safe, "sessionId");
    if (!eventSessionId || eventSessionId.length > 256) {
      throw eventError("OPENCODE_EVENT_MALFORMED", "The OpenCode session identifier is malformed.");
    }
    if (this.#sessionId && this.#sessionId !== eventSessionId) {
      throw eventError("OPENCODE_SESSION_MISMATCH", "The OpenCode event session changed.");
    }
    this.#sessionId = eventSessionId;
    const part = readRecord(safe, "part") ?? Object.freeze({});
    if (type === "error") {
      if (Object.hasOwn(safe, "part") || !readRecord(safe, "error")) {
        throw eventError("OPENCODE_EVENT_MALFORMED", "The OpenCode error event is malformed.");
      }
    } else {
      const partId = readString(part, "id");
      if (
        readString(part, "type") !== PART_TYPES[type] ||
        !partId ||
        partId.length > 256
      ) {
        throw eventError("OPENCODE_EVENT_MALFORMED", "The OpenCode event part is malformed.");
      }
    }
    const partSessionId = readString(part, "sessionID") ?? readString(part, "sessionId");
    if (partSessionId !== undefined && partSessionId !== eventSessionId) {
      throw eventError("OPENCODE_SESSION_MISMATCH", "The OpenCode event session changed.");
    }

    if (type === "step_start") {
      if (this.#iteration && !this.#iteration.finished) {
        throw eventError("OPENCODE_EVENT_MALFORMED", "The OpenCode iteration is malformed.");
      }
      this.#iteration = {
        finished: false,
        hasTool: false,
        messageId: readString(part, "messageID") ?? readString(part, "messageId"),
        textParts: new Map(),
      };
      this.#text = "";
      this.#completed = false;
    } else if (type !== "error" && !this.#iteration) {
      throw eventError("OPENCODE_EVENT_MALFORMED", "The OpenCode iteration is malformed.");
    }
    const partMessageId = readString(part, "messageID") ?? readString(part, "messageId");
    if (
      this.#iteration &&
      partMessageId !== undefined &&
      this.#iteration.messageId !== undefined &&
      partMessageId !== this.#iteration.messageId
    ) {
      throw eventError("OPENCODE_EVENT_MALFORMED", "The OpenCode message identifier changed.");
    }
    if (this.#iteration && this.#iteration.messageId === undefined && partMessageId !== undefined) {
      this.#iteration.messageId = partMessageId;
    }

    if (type === "text") {
      const text = readString(part, "text") ?? readString(safe, "text");
      if (text === undefined) {
        throw eventError("OPENCODE_EVENT_MALFORMED", "The OpenCode text event is malformed.");
      }
      const partId = readString(part, "id");
      let aggregateBytes = Buffer.byteLength(text);
      for (const [id, value] of this.#iteration.textParts) {
        if (id !== partId) aggregateBytes += Buffer.byteLength(value);
      }
      if (aggregateBytes > MAX_FINAL_TEXT_BYTES) {
        throw eventError("OPENCODE_EVENT_LIMIT", "The OpenCode final text limit was exceeded.");
      }
      this.#iteration.textParts.set(partId, text);
    } else if (type === "tool_use") {
      this.#iteration.hasTool = true;
      this.#toolEvents.push(freezeToolEvent(part));
    } else if (type === "step_finish") {
      if (this.#iteration.finished) {
        throw eventError("OPENCODE_EVENT_MALFORMED", "The OpenCode iteration is malformed.");
      }
      this.#iteration.finished = true;
      const terminalParts = [...this.#iteration.textParts.values()];
      this.#completed =
        !this.#iteration.hasTool &&
        terminalParts.length === 1 &&
        terminalParts[0].trim().length > 0;
      this.#text = this.#completed ? terminalParts[0] : "";
    } else if (type === "error") {
      this.#hadError = true;
    }
    this.#events.push(safe);
    return Object.freeze({ kind: "event", event: safe });
  }

  finish() {
    if (this.#finished) {
      throw eventError("OPENCODE_EVENT_STATE", "The OpenCode event parser is already finished.");
    }
    this.#finished = true;
    return Object.freeze({
      sessionId: this.#sessionId ?? null,
      finalText: this.#text,
      completed: this.#completed,
      hadError: this.#hadError,
      events: Object.freeze([...this.#events]),
      unknownEvents: Object.freeze([...this.#unknownEvents]),
      toolEvents: Object.freeze([...this.#toolEvents]),
      diagnostics: Object.freeze([...this.#diagnostics]),
    });
  }
}

export function parseOpenCodeLines(lines, options = {}) {
  if (!Array.isArray(lines) || Object.getPrototypeOf(lines) !== Array.prototype) {
    throw eventError("OPENCODE_EVENT_MALFORMED", "The OpenCode event input is malformed.");
  }
  const keys = Reflect.ownKeys(lines);
  if (
    keys.length !== lines.length + 1 ||
    keys.some(
      (key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)),
    )
  ) {
    throw eventError("OPENCODE_EVENT_MALFORMED", "The OpenCode event input is malformed.");
  }
  const parser = new OpenCodeEventParser(options);
  for (let index = 0; index < lines.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(lines, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw eventError("OPENCODE_EVENT_MALFORMED", "The OpenCode event input is malformed.");
    }
    parser.push(descriptor.value);
  }
  return parser.finish();
}
