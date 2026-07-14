const SENSITIVE_DETAIL_KEY =
  /(?:authorization|cookie|credential|pass(?:word|phrase)?|secret|token)/iu;

function safeDetailValue(key, value) {
  if (SENSITIVE_DETAIL_KEY.test(key)) {
    return "[REDACTED]";
  }

  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }

  if (typeof value === "string") {
    return value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 256);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) =>
      typeof item === "string"
        ? item.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 256)
        : String(item).slice(0, 256),
    );
  }

  return "[OMITTED]";
}

function safeDetails(details) {
  if (details === null || typeof details !== "object" || Array.isArray(details)) {
    return Object.freeze({});
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(details)
        .slice(0, 30)
        .map(([key, value]) => [key, safeDetailValue(key, value)]),
    ),
  );
}

export class StudioError extends Error {
  constructor(
    message,
    { code, stage = "unknown", retryable = false, details = {} } = {},
  ) {
    super(message);
    this.name = "StudioError";
    this.code = code ?? "STUDIO_ERROR";
    this.stage = stage;
    this.retryable = Boolean(retryable);
    this.details = safeDetails(details);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      stage: this.stage,
      retryable: this.retryable,
      details: this.details,
    };
  }
}
