import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OPEN_CODE_FALLBACK_VERSION,
  OPEN_CODE_MINIMUM_VERSION,
  OpenCodeResolutionError,
  parseStableOpenCodeVersion,
  resolveOpenCodeExecutable,
  supportsOpenCodeVersion,
} from "../../src/runtime/opencode-installation.js";

const SAFE_ERROR_MESSAGE = "No safe compatible OpenCode executable is available.";

async function withExecutableFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "opencode-resolution-"));
  const paths = {
    compatible: join(root, "opencode-compatible.exe"),
    newer: join(root, "opencode-newer.exe"),
    old: join(root, "opencode-old.exe"),
    broken: join(root, "opencode-broken.exe"),
    commandShim: join(root, "opencode.cmd"),
    directory: join(root, "opencode-directory.exe"),
    missing: join(root, "opencode-missing.exe"),
  };

  await Promise.all([
    writeFile(paths.compatible, "fixture"),
    writeFile(paths.newer, "fixture"),
    writeFile(paths.old, "fixture"),
    writeFile(paths.broken, "fixture"),
    writeFile(paths.commandShim, "fixture"),
    mkdir(paths.directory),
  ]);

  try {
    await run(paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertSafeExecutionOptions(options) {
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.encoding, "utf8");
  assert.equal(Number.isFinite(options.timeout), true);
  assert.equal(options.timeout > 0, true);
  assert.equal(Number.isFinite(options.maxBuffer), true);
  assert.equal(options.maxBuffer > 0, true);
  assert.deepEqual(
    Object.keys(options.env).sort(),
    ["PATH", "PATHEXT", "SystemRoot", "WINDIR"],
  );
  assert.equal("OPENCODE_TEST_SECRET" in options.env, false);
}

async function assertSanitizedFailure(action, secrets = []) {
  await assert.rejects(action, (error) => {
    assert.equal(error instanceof OpenCodeResolutionError, true);
    assert.equal(error.code, "OPENCODE_UNAVAILABLE");
    assert.equal(error.message, SAFE_ERROR_MESSAGE);
    for (const secret of secrets) {
      assert.equal(error.stack.includes(secret), false);
    }
    return true;
  });
}

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

test("an explicit canonical executable is probed exactly and returns an immutable result", async () => {
  await withExecutableFixture(async ({ compatible }) => {
    let whereCalls = 0;
    let versionCalls = 0;
    process.env.OPENCODE_TEST_SECRET = "do-not-forward-this";

    try {
      const result = await resolveOpenCodeExecutable({
        explicitPath: compatible,
        runWhere: async () => {
          whereCalls += 1;
          throw new Error("PATH fallback must not run");
        },
        runVersion: async (file, argv, options) => {
          versionCalls += 1;
          assert.equal(file, compatible);
          assert.deepEqual(argv, ["--version"]);
          assertSafeExecutionOptions(options);
          return { stdout: "1.17.19\r\n", stderr: "" };
        },
      });

      assert.deepEqual(result, {
        path: compatible,
        source: "explicit",
        version: "1.17.19",
      });
      assert.equal(Object.isFrozen(result), true);
      assert.throws(() => {
        result.version = "9.9.9";
      }, TypeError);
      assert.equal(whereCalls, 0);
      assert.equal(versionCalls, 1);
    } finally {
      delete process.env.OPENCODE_TEST_SECRET;
    }
  });
});

test("the resolver probes and returns the inspected canonical path spelling", async () => {
  const requested = "C:\\SAFE\\OpenCode.exe";
  const canonical = "C:\\safe\\opencode.exe";
  const result = await resolveOpenCodeExecutable({
    explicitPath: requested,
    inspectCandidate: async () => ({
      canonicalPath: canonical,
      isRegularFile: true,
      isReparsePoint: false,
    }),
    runVersion: async (file, argv) => {
      assert.equal(file, canonical);
      assert.deepEqual(argv, ["--version"]);
      return { stdout: "1.18.2\n", stderr: "" };
    },
  });

  assert.deepEqual(result, { path: canonical, source: "explicit", version: "1.18.2" });
});

test("explicit unsafe or unavailable overrides fail terminally without PATH fallback", async () => {
  await withExecutableFixture(async ({ commandShim, directory, missing, old }) => {
    const cases = [
      { path: "opencode.exe", output: "1.18.2\n" },
      { path: commandShim, output: "1.18.2\n" },
      { path: directory, output: "1.18.2\n" },
      { path: missing, output: "1.18.2\n" },
      { path: old, output: "1.4.1\n" },
    ];

    for (const candidate of cases) {
      let whereCalls = 0;
      await assertSanitizedFailure(
        () =>
          resolveOpenCodeExecutable({
            explicitPath: candidate.path,
            runWhere: async () => {
              whereCalls += 1;
              return { stdout: old, stderr: "" };
            },
            runVersion: async () => ({ stdout: candidate.output, stderr: "" }),
          }),
        [candidate.path],
      );
      assert.equal(whereCalls, 0);
    }
  });
});

test("explicit canonical drift, reparse points, and non-regular files are rejected", async () => {
  const candidate = "C:\\safe\\opencode.exe";
  const unsafeInspections = [
    { canonicalPath: "C:\\other\\opencode.exe", isRegularFile: true, isReparsePoint: false },
    { canonicalPath: candidate, isRegularFile: true, isReparsePoint: true },
    { canonicalPath: candidate, isRegularFile: false, isReparsePoint: false },
  ];

  for (const inspection of unsafeInspections) {
    let versionCalls = 0;
    let whereCalls = 0;
    await assertSanitizedFailure(() =>
      resolveOpenCodeExecutable({
        explicitPath: candidate,
        inspectCandidate: async () => inspection,
        runWhere: async () => {
          whereCalls += 1;
          return { stdout: "", stderr: "" };
        },
        runVersion: async () => {
          versionCalls += 1;
          return { stdout: "1.18.2\n", stderr: "" };
        },
      }),
    );
    assert.equal(versionCalls, 0);
    assert.equal(whereCalls, 0);
  }
});

test("PATH candidates are considered in order, canonical-deduped, and the first compatible one wins", async () => {
  await withExecutableFixture(async ({ old, newer }) => {
    const probes = [];
    const trustedSystemRoot = "C:\\TrustedWindows";
    const result = await resolveOpenCodeExecutable({
      runWhere: async (file, argv, options) => {
        assert.equal(file, join(trustedSystemRoot, "System32", "where.exe"));
        assert.deepEqual(argv, ["opencode.exe"]);
        assertSafeExecutionOptions(options);
        return { stdout: `${old}\r\n${old}\r\n${newer}\r\n`, stderr: "" };
      },
      runVersion: async (file, argv, options) => {
        probes.push(file);
        assert.deepEqual(argv, ["--version"]);
        assertSafeExecutionOptions(options);
        return {
          stdout: file === old ? "1.4.1\n" : "1.18.2\n",
          stderr: "",
        };
      },
      environment: {
        PATH: "C:\\Tools",
        PATHEXT: ".EXE",
        SystemRoot: trustedSystemRoot,
        WINDIR: trustedSystemRoot,
        API_TOKEN: "must-not-forward",
      },
    });

    assert.deepEqual(probes, [old, newer]);
    assert.deepEqual(result, { path: newer, source: "path", version: "1.18.2" });
    assert.equal(Object.isFrozen(result), true);
  });
});

test("PATH resolution skips unsafe, broken, malformed, and old candidates", async () => {
  await withExecutableFixture(async ({ commandShim, directory, broken, old, compatible }) => {
    const relative = "relative-opencode.exe";
    const canonicalDrift = "C:\\drift\\opencode.exe";
    const reparse = "C:\\reparse\\opencode.exe";
    const nonRegular = "C:\\device\\opencode.exe";
    const candidates = [
      relative,
      commandShim,
      directory,
      canonicalDrift,
      reparse,
      nonRegular,
      broken,
      old,
      compatible,
    ];
    const inspected = [];
    const probed = [];

    const result = await resolveOpenCodeExecutable({
      runWhere: async () => ({ stdout: `${candidates.join("\r\n")}\r\n`, stderr: "" }),
      inspectCandidate: async (path) => {
        inspected.push(path);
        if (path === canonicalDrift) {
          return { canonicalPath: "C:\\elsewhere\\opencode.exe", isRegularFile: true, isReparsePoint: false };
        }
        if (path === reparse) {
          return { canonicalPath: path, isRegularFile: true, isReparsePoint: true };
        }
        if (path === nonRegular || path === directory) {
          return { canonicalPath: path, isRegularFile: false, isReparsePoint: false };
        }
        return { canonicalPath: path, isRegularFile: true, isReparsePoint: false };
      },
      runVersion: async (path) => {
        probed.push(path);
        if (path === broken) {
          throw new Error("probe failure contains TOP_SECRET");
        }
        return { stdout: path === old ? "1.4.1\n" : "1.18.2\n", stderr: "" };
      },
    });

    assert.deepEqual(inspected, [directory, canonicalDrift, reparse, nonRegular, broken, old, compatible]);
    assert.deepEqual(probed, [broken, old, compatible]);
    assert.deepEqual(result, { path: compatible, source: "path", version: "1.18.2" });
  });
});

test("version probes require exactly one terminal normal line ending", async () => {
  await withExecutableFixture(async ({ compatible }) => {
    for (const stdout of ["1.18.2", "1.18.2\r", "1.18.2\n\n", "1.18.2\r\n\r\n"]) {
      await assertSanitizedFailure(() =>
        resolveOpenCodeExecutable({
          explicitPath: compatible,
          runVersion: async () => ({ stdout, stderr: "" }),
        }),
      );
    }
  });
});

test("version probes reject nonzero, timeout, oversized, multiline, malformed, or noisy output", async () => {
  await withExecutableFixture(async ({ compatible }) => {
    const failures = [
      async () => ({ stdout: "1.18.2\n", stderr: "", exitCode: 7 }),
      async () => {
        const error = new Error("timed out with TIMEOUT_SECRET");
        error.killed = true;
        throw error;
      },
      async () => ({ stdout: "1".repeat(4097), stderr: "" }),
      async () => ({ stdout: "1.18.2\n1.18.3\n", stderr: "" }),
      async () => ({ stdout: "v1.18.2\n", stderr: "" }),
      async () => ({ stdout: "1.18.2\n", stderr: "STDERR_SECRET" }),
    ];

    for (const runVersion of failures) {
      let whereCalls = 0;
      await assertSanitizedFailure(
        () =>
          resolveOpenCodeExecutable({
            explicitPath: compatible,
            runWhere: async () => {
              whereCalls += 1;
              return { stdout: compatible, stderr: "" };
            },
            runVersion,
          }),
        [compatible, "TIMEOUT_SECRET", "STDERR_SECRET"],
      );
      assert.equal(whereCalls, 0);
    }
  });
});

test("PATH lookup failures and exhausted candidates fail closed without leaking details", async () => {
  const secrets = ["C:\\private\\opencode.exe", "API_TOKEN=secret-value"];
  for (const runWhere of [
    async () => {
      throw new Error(`where failed: ${secrets.join(" ")}`);
    },
    async () => ({ stdout: secrets.join("\r\n"), stderr: "", exitCode: 1 }),
    async () => ({ stdout: "x".repeat(65_537), stderr: "" }),
  ]) {
    await assertSanitizedFailure(
      () => resolveOpenCodeExecutable({ runWhere, runVersion: async () => ({ stdout: "1.18.2\n" }) }),
      secrets,
    );
  }
});
