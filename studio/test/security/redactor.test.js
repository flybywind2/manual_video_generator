import assert from "node:assert/strict";
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
