const REDACTED = "[REDACTED]";
const INVALID_CONFIGURATION = "Invalid redactor configuration.";
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/u;
const REGEXP_META = /[\\^$.*+?()[\]{}|]/gu;
const MAX_DEPTH = 64;
const MAX_NODES = 10_000;

function invalidConfiguration() {
  throw new TypeError(INVALID_CONFIGURATION);
}

function readStringList(configuration, name) {
  const descriptor = Object.getOwnPropertyDescriptor(configuration, name);
  if (descriptor === undefined) {
    return [];
  }
  if (!("value" in descriptor)) {
    invalidConfiguration();
  }
  const values = descriptor.value;
  if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype) {
    invalidConfiguration();
  }
  const ownKeys = Reflect.ownKeys(values);
  if (
    ownKeys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" || !ARRAY_INDEX.test(key)),
    ) ||
    ownKeys.length !== values.length + 1
  ) {
    invalidConfiguration();
  }

  const result = [];
  for (let index = 0; index < values.length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(values, String(index));
    if (
      item === undefined ||
      !("value" in item) ||
      item.enumerable !== true ||
      typeof item.value !== "string"
    ) {
      invalidConfiguration();
    }
    result.push(item.value);
  }
  return result;
}

function readConfiguration(configuration) {
  if (
    configuration === null ||
    typeof configuration !== "object" ||
    (Object.getPrototypeOf(configuration) !== Object.prototype &&
      Object.getPrototypeOf(configuration) !== null)
  ) {
    invalidConfiguration();
  }
  const keys = Reflect.ownKeys(configuration);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "secrets" && key !== "sensitiveKeys"),
    )
  ) {
    invalidConfiguration();
  }
  return {
    secrets: readStringList(configuration, "secrets"),
    sensitiveKeys: readStringList(configuration, "sensitiveKeys"),
  };
}

function escapeLiteral(value) {
  return value.replace(REGEXP_META, "\\$&");
}

function hexCharacterPattern(character) {
  if (character >= "a" && character <= "f") {
    return `[${character}${character.toUpperCase()}]`;
  }
  if (character >= "A" && character <= "F") {
    return `[${character.toLowerCase()}${character}]`;
  }
  return character;
}

function encodedPattern(value) {
  let source = "";
  for (let index = 0; index < value.length; index += 1) {
    if (
      value[index] === "%" &&
      index + 2 < value.length &&
      /^[0-9A-Fa-f]{2}$/u.test(value.slice(index + 1, index + 3))
    ) {
      source += `%${hexCharacterPattern(value[index + 1])}${hexCharacterPattern(value[index + 2])}`;
      index += 2;
    } else {
      source += escapeLiteral(value[index]);
    }
  }
  return source;
}

function encodedVariants(secret) {
  const variants = [];
  try {
    variants.push(encodeURIComponent(secret));
  } catch {
    // A malformed UTF-16 value can still be redacted in its original form.
  }
  try {
    const encoded = new URLSearchParams([["value", secret]]).toString();
    variants.push(encoded.slice(encoded.indexOf("=") + 1));
  } catch {
    // Keep the original exact replacement when form encoding is unavailable.
  }
  return variants;
}

function createSecretPattern(secrets) {
  const entries = [];
  for (const secret of new Set(secrets)) {
    if (secret.length === 0) {
      continue;
    }
    entries.push({ literalLength: secret.length, source: escapeLiteral(secret) });
    for (const encoded of encodedVariants(secret)) {
      if (encoded !== secret && encoded.length > 0) {
        entries.push({
          literalLength: encoded.length,
          source: encodedPattern(encoded),
        });
      }
    }
  }

  entries.sort((left, right) => right.literalLength - left.literalLength);
  const sources = [...new Set(entries.map(({ source }) => source))];
  return sources.length === 0 ? null : new RegExp(sources.join("|"), "gu");
}

function normalizeSensitiveKey(key) {
  return key.normalize("NFKC").toLocaleLowerCase("en-US");
}

function safeClone(value, replaceText, sensitiveKeys, seen, budget, depth) {
  budget.count += 1;
  if (budget.count > MAX_NODES || depth > MAX_DEPTH) {
    throw budget;
  }

  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return replaceText(value);
  }
  if (typeof value !== "object" || seen.has(value)) {
    throw budget;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw budget;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== value.length + 1 ||
      ownKeys.some(
        (key) =>
          key !== "length" &&
          (typeof key !== "string" || !ARRAY_INDEX.test(key)),
      )
    ) {
      throw budget;
    }
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw budget;
      }
      output.push(
        safeClone(
          descriptor.value,
          replaceText,
          sensitiveKeys,
          seen,
          budget,
          depth + 1,
        ),
      );
    }
    seen.delete(value);
    return Object.freeze(output);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw budget;
  }
  const output = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || FORBIDDEN_KEYS.has(key)) {
      throw budget;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw budget;
    }
    const safeKey = replaceText(key);
    if (FORBIDDEN_KEYS.has(safeKey) || Object.hasOwn(output, safeKey)) {
      throw budget;
    }
    const safeValue = sensitiveKeys.has(normalizeSensitiveKey(key))
      ? REDACTED
      : safeClone(
          descriptor.value,
          replaceText,
          sensitiveKeys,
          seen,
          budget,
          depth + 1,
        );
    Object.defineProperty(output, safeKey, {
      configurable: false,
      enumerable: true,
      value: safeValue,
      writable: false,
    });
  }
  seen.delete(value);
  return Object.freeze(output);
}

export function createRedactor(configuration = {}) {
  const { secrets, sensitiveKeys: configuredKeys } = readConfiguration(
    configuration,
  );
  const pattern = createSecretPattern(secrets);
  const sensitiveKeys = new Set(
    configuredKeys.filter((key) => key.length > 0).map(normalizeSensitiveKey),
  );
  const replaceText = (input) =>
    pattern === null ? input : input.replace(pattern, REDACTED);

  const text = Object.freeze((input) =>
    typeof input === "string" ? replaceText(input) : REDACTED,
  );
  const value = Object.freeze((input) => {
    try {
      return safeClone(
        input,
        replaceText,
        sensitiveKeys,
        new WeakSet(),
        { count: 0 },
        0,
      );
    } catch {
      return REDACTED;
    }
  });

  return Object.freeze({ text, value });
}
