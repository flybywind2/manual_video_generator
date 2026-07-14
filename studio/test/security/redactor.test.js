import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { createRedactor } from "../../src/security/redactor.js";

const REDACTED = "[REDACTED]";

test("redacts exact and overlapping secrets longest-first", () => {
  const redactor = createRedactor({
    secrets: ["violet-key", "violet-key-extended", "violet-key"],
    sensitiveKeys: [],
  });

  assert.equal(
    redactor.text("violet-key-extended / violet-key"),
    `${REDACTED} / ${REDACTED}`,
  );
  assert.equal(Object.isFrozen(redactor), true);
  assert.equal(Object.isFrozen(redactor.text), true);
  assert.equal(Object.isFrozen(redactor.value), true);
  assert.deepEqual(Reflect.ownKeys(redactor), ["text", "value"]);
});

test("redacts URI and form encodings with independently cased percent hex", () => {
  const redactor = createRedactor({
    secrets: ["name+ box/@"],
    sensitiveKeys: [],
  });

  assert.equal(redactor.text("name%2b%20box%2F%40"), REDACTED);
  assert.equal(redactor.text("name%2B+box%2f%40"), REDACTED);
});

test("redacts encodeURI and arbitrary raw-percent-form mixtures per character", () => {
  const redactor = createRedactor({
    secrets: ["name/ box?value", "name/"],
    sensitiveKeys: [],
  });

  for (const encoded of [
    "name/%20box?value",
    "n%61me/%20b%6Fx?value",
    "name%2f+box%3Fvalue",
    "%6eame/%20box%3fvalue",
  ]) {
    assert.equal(redactor.text(encoded), REDACTED);
  }
  assert.equal(
    redactor.text("n%61me%2f+box%3fvalue|n%61me%2F"),
    `${REDACTED}|${REDACTED}`,
  );

  const percent = createRedactor({ secrets: ["%"], sensitiveKeys: [] });
  assert.equal(percent.text("%25"), REDACTED);
});

test("chooses the longest cross-secret representation regardless of order", () => {
  for (const secrets of [
    ["%", "/"],
    ["/", "%"],
  ]) {
    const redactor = createRedactor({ secrets, sensitiveKeys: [] });
    assert.equal(redactor.text("%2F|%2f"), `${REDACTED}|${REDACTED}`);
  }

  for (const secrets of [
    ["%", "a"],
    ["a", "%"],
  ]) {
    const redactor = createRedactor({ secrets, sensitiveKeys: [] });
    assert.equal(redactor.text("%61|%61"), `${REDACTED}|${REDACTED}`);
  }
});

test("fails closed before allowed common-prefix patterns can block the event loop", () => {
  const prefix = "a".repeat(500);
  const suffixes = Array.from(
    { length: 128 },
    (_, index) => String.fromCodePoint(0x100 + index),
  );
  const redactor = createRedactor({
    secrets: suffixes.map((suffix) => prefix + suffix),
    sensitiveKeys: [],
  });
  const started = performance.now();

  const nonmatch = redactor.text("a".repeat(5_000));
  const match = redactor.text("a".repeat(5_000) + suffixes[0]);
  const elapsedMs = performance.now() - started;

  assert.equal(nonmatch, REDACTED);
  assert.equal(match, REDACTED);
  assert.equal(
    elapsedMs < 2_000,
    true,
    `redaction exceeded the bounded runtime: ${Math.round(elapsedMs)}ms`,
  );
});

test("fails closed for oversized matcher work while preserving normal precision", () => {
  const longPrefix = "b".repeat(4_095);
  const largeMatcher = createRedactor({
    secrets: [`${longPrefix}x`, `${longPrefix}y`],
    sensitiveKeys: [],
  });
  assert.equal(largeMatcher.text("b".repeat(5_000)), REDACTED);

  const boundedInput = createRedactor({
    secrets: ["needle"],
    sensitiveKeys: [],
  });
  assert.equal(boundedInput.text("x".repeat(125_001)), REDACTED);

  const normal = createRedactor({
    secrets: ["name/ box?value", "short"],
    sensitiveKeys: [],
  });
  assert.equal(
    normal.text("prefix n%61me%2f+box%3fvalue suffix"),
    `prefix ${REDACTED} suffix`,
  );
});

test("rejects unpaired Unicode secrets and redacts valid emoji encodings", () => {
  for (const secret of [`bad\uD800`, `bad\uDC00`]) {
    assert.throws(
      () => createRedactor({ secrets: [secret], sensitiveKeys: [] }),
      { message: "Invalid redactor configuration." },
    );
  }

  const redactor = createRedactor({ secrets: ["pair-😀"], sensitiveKeys: [] });
  assert.equal(redactor.text("pair-😀|pair-%F0%9f%98%80"), `${REDACTED}|${REDACTED}`);
});

test("redacts case-insensitive sensitive keys throughout nested own data", () => {
  const redactor = createRedactor({
    secrets: [],
    sensitiveKeys: ["username", "password", "apiToken"],
  });
  const value = {
    UserName: "operator",
    nested: [{ PASSWORD: "credential" }, { apitOKEN: "token" }],
    safe: true,
  };

  assert.deepEqual(redactor.value(value), {
    UserName: REDACTED,
    nested: [{ PASSWORD: REDACTED }, { apitOKEN: REDACTED }],
    safe: true,
  });
});

test("clones and freezes nested values without mutating input types", () => {
  const redactor = createRedactor({
    secrets: ["violet-value"],
    sensitiveKeys: [],
  });
  const input = {
    line: "prefix violet-value suffix",
    values: [1, true, false, null, "untouched"],
  };

  const output = redactor.value(input);

  assert.deepEqual(output, {
    line: `prefix ${REDACTED} suffix`,
    values: [1, true, false, null, "untouched"],
  });
  assert.notEqual(output, input);
  assert.notEqual(output.values, input.values);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.values), true);
  assert.equal(input.line, "prefix violet-value suffix");
});

test("fails closed on inherited, accessor, sparse, symbol, and cyclic data", () => {
  const redactor = createRedactor({
    secrets: ["violet-value"],
    sensitiveKeys: [],
  });
  let getterRan = false;
  const accessor = {};
  Object.defineProperty(accessor, "unsafe", {
    enumerable: true,
    get() {
      getterRan = true;
      return "violet-value";
    },
  });
  const cyclic = {};
  cyclic.self = cyclic;
  const symbolData = { safe: true };
  symbolData[Symbol("unsafe")] = "violet-value";
  const sparse = new Array(2);
  sparse[1] = "violet-value";

  assert.equal(redactor.value(Object.create({ inherited: "violet-value" })), REDACTED);
  assert.equal(redactor.value(accessor), REDACTED);
  assert.equal(getterRan, false);
  assert.equal(redactor.value(cyclic), REDACTED);
  assert.equal(redactor.value(symbolData), REDACTED);
  assert.equal(redactor.value(sparse), REDACTED);
});

test("removes secrets embedded in process lines, JSON text, values, and keys", () => {
  const redactor = createRedactor({
    secrets: ["violet-value"],
    sensitiveKeys: [],
  });
  const line = '{"stdout":"before-violet-value-after"}';
  const value = { "key-violet-value": "violet-value" };

  assert.equal(
    redactor.text(line),
    `{"stdout":"before-${REDACTED}-after"}`,
  );
  assert.deepEqual(redactor.value(value), {
    [`key-${REDACTED}`]: REDACTED,
  });
  assert.equal(JSON.stringify(redactor.value(value)).includes("violet-value"), false);
});

test("empty, duplicate, and regex metacharacter secrets cannot replace globally", () => {
  const redactor = createRedactor({
    secrets: ["", "a.*(b)", "a.*(b)"],
    sensitiveKeys: [""],
  });

  assert.equal(redactor.text("plain"), "plain");
  assert.equal(redactor.text("a.*(b) then aZZb"), `${REDACTED} then aZZb`);
});

test("unsafe redactor configuration fails without reading or disclosing values", () => {
  let getterRan = false;
  const secrets = [];
  Object.defineProperty(secrets, "0", {
    enumerable: true,
    get() {
      getterRan = true;
      return "violet-hidden";
    },
  });
  secrets.length = 1;

  for (const unsafe of [secrets, [Symbol("violet-hidden")]]) {
    assert.throws(
      () => createRedactor({ secrets: unsafe, sensitiveKeys: [] }),
      (error) => {
        assert.equal(error.message, "Invalid redactor configuration.");
        assert.equal(String(error).includes("violet-hidden"), false);
        return true;
      },
    );
  }
  assert.equal(getterRan, false);
});

test("normalizes every hostile configuration reflection trap", () => {
  const marker = "redactor-proxy-private-marker";
  const traps = ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"];

  for (const trap of traps) {
    const configuration = new Proxy(
      { secrets: ["safe"], sensitiveKeys: [] },
      {
        [trap]() {
          throw new Error(marker);
        },
      },
    );
    assert.throws(
      () => createRedactor(configuration),
      (error) => {
        assert.equal(error.message, "Invalid redactor configuration.");
        assert.equal(String(error).includes(marker), false);
        return true;
      },
    );
  }

  const hostileSecrets = new Proxy(["safe"], {
    ownKeys() {
      throw new Error(marker);
    },
  });
  assert.throws(
    () => createRedactor({ secrets: hostileSecrets, sensitiveKeys: [] }),
    (error) => {
      assert.equal(error.message, "Invalid redactor configuration.");
      assert.equal(String(error).includes(marker), false);
      return true;
    },
  );
});
