import assert from "node:assert/strict";
import test from "node:test";

import {
  OPEN_CODE_FALLBACK_VERSION,
  OPEN_CODE_MINIMUM_VERSION,
  parseStableOpenCodeVersion,
  supportsOpenCodeVersion,
} from "../../src/runtime/opencode-installation.js";

test("the OpenCode compatibility floor is inclusive and stable-only", () => {
  assert.equal(OPEN_CODE_MINIMUM_VERSION, "1.17.19");
  assert.equal(OPEN_CODE_FALLBACK_VERSION, "1.18.2");

  assert.deepEqual(parseStableOpenCodeVersion("1.18.2"), [1, 18, 2]);
  assert.equal(supportsOpenCodeVersion("1.17.18"), false);
  assert.equal(supportsOpenCodeVersion("1.17.19"), true);
  assert.equal(supportsOpenCodeVersion("1.18.2"), true);
  assert.equal(supportsOpenCodeVersion("2.0.0"), true);

  for (const value of [
    "1.18",
    "v1.18.2",
    "1.18.2-beta.1",
    "1.18.2+build.1",
    "01.18.2",
    "9007199254740992.18.2",
  ]) {
    assert.equal(parseStableOpenCodeVersion(value), null);
    assert.equal(supportsOpenCodeVersion(value), false);
  }
});
