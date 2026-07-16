import assert from "node:assert/strict";
import { link, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  OPEN_CODE_FALLBACK_VERSION,
  OPEN_CODE_MINIMUM_VERSION,
  OpenCodeResolutionError,
  parseStableOpenCodeVersion,
  resolveOpenCodeExecutable,
  resolveOpenCodeInstallation,
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

async function withInstallationFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "opencode-installation-"));
  const studioRoot = join(root, "studio");
  const runtimeRoot = join(studioRoot, ".runtime", "opencode");
  await mkdir(studioRoot, { recursive: true });

  try {
    await run({ root, runtimeRoot, studioRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeOpenCodePackage(packageRoot, manifest = {}) {
  const executable = join(packageRoot, "bin", "opencode.exe");
  const manifestPath = join(packageRoot, "package.json");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await writeFile(executable, "native fixture");
  await writeFile(
    manifestPath,
    JSON.stringify({
      name: "opencode-ai",
      version: "1.18.2",
      bin: { opencode: "./bin/opencode.exe" },
      ...manifest,
    }),
  );
  return { executable, manifestPath };
}

async function writeTrustedNodeFixture(root) {
  const nodeExecutable = join(root, "trusted-node", "node.exe");
  const npmCliPath = join(root, "trusted-node", "node_modules", "npm", "bin", "npm-cli.js");
  await mkdir(dirname(npmCliPath), { recursive: true });
  await writeFile(nodeExecutable, "trusted node fixture");
  await writeFile(npmCliPath, "trusted npm cli fixture");
  return { nodeExecutable, npmCliPath };
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

test("check-mode installation resolution requires bounded Studio roots and fails sanitized when exhausted", async () => {
  const studioRoot = await mkdtemp(join(tmpdir(), "opencode-installation-"));
  const runtimeRoot = join(studioRoot, ".runtime", "opencode");

  try {
    await assertSanitizedFailure(() =>
      resolveOpenCodeInstallation({
        mode: "check",
        studioRoot,
        runtimeRoot,
        runWhere: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
      }),
    );
    await assert.rejects(() => lstat(runtimeRoot), { code: "ENOENT" });
  } finally {
    await rm(studioRoot, { recursive: true, force: true });
  }
});

test("check mode derives an npm native binary from where.exe opencode.cmd without reading or executing the shim", async () => {
  await withInstallationFixture(async ({ root, runtimeRoot, studioRoot }) => {
    const shimDirectory = join(root, "npm-global");
    const commandShim = join(shimDirectory, "opencode.cmd");
    const { executable, manifestPath } = await writeOpenCodePackage(
      join(shimDirectory, "node_modules", "opencode-ai"),
    );
    await writeFile(commandShim, "@echo SHIM_MUST_NOT_RUN_OR_BE_READ");

    const lookups = [];
    const reads = [];
    const versionProbes = [];
    const trustedSystemRoot = "C:\\TrustedWindows";
    const result = await resolveOpenCodeInstallation({
      mode: "check",
      studioRoot,
      runtimeRoot,
      environment: {
        PATH: shimDirectory,
        PATHEXT: ".EXE;.CMD",
        SystemRoot: trustedSystemRoot,
        WINDIR: trustedSystemRoot,
      },
      runWhere: async (file, argv, options) => {
        lookups.push([...argv]);
        assert.equal(file, join(trustedSystemRoot, "System32", "where.exe"));
        assertSafeExecutionOptions(options);
        if (argv[0] === "opencode.exe") {
          return { stdout: "", stderr: "not found", exitCode: 1 };
        }
        assert.deepEqual(argv, ["opencode.cmd"]);
        return { stdout: `${commandShim}\r\n`, stderr: "", exitCode: 0 };
      },
      readManifest: async (file) => {
        reads.push(file);
        return readFile(file, "utf8");
      },
      runVersion: async (file, argv, options) => {
        versionProbes.push(file);
        assert.deepEqual(argv, ["--version"]);
        assertSafeExecutionOptions(options);
        return { stdout: "1.18.2\n", stderr: "", exitCode: 0 };
      },
    });

    assert.deepEqual(lookups, [["opencode.exe"], ["opencode.cmd"]]);
    assert.deepEqual(reads, [manifestPath]);
    assert.deepEqual(versionProbes, [executable]);
    assert.equal(reads.includes(commandShim), false);
    assert.equal(versionProbes.includes(commandShim), false);
    assert.deepEqual(result, {
      path: executable,
      source: "npm-global",
      version: "1.18.2",
    });
    assert.equal(Object.isFrozen(result), true);
  });
});

test("the exact project fallback at 1.18.2 precedes PATH and npm-global discovery", async () => {
  await withInstallationFixture(async ({ runtimeRoot, studioRoot }) => {
    const { executable, manifestPath } = await writeOpenCodePackage(
      join(runtimeRoot, "node_modules", "opencode-ai"),
    );
    let lookupCalls = 0;
    const reads = [];
    const versionProbes = [];

    const result = await resolveOpenCodeInstallation({
      mode: "check",
      studioRoot,
      runtimeRoot,
      runWhere: async () => {
        lookupCalls += 1;
        throw new Error("project fallback must win before discovery");
      },
      readManifest: async (file) => {
        reads.push(file);
        return readFile(file, "utf8");
      },
      runVersion: async (file) => {
        versionProbes.push(file);
        return { stdout: "1.18.2\n", stderr: "", exitCode: 0 };
      },
    });

    assert.equal(executable, join(
      studioRoot,
      ".runtime",
      "opencode",
      "node_modules",
      "opencode-ai",
      "bin",
      "opencode.exe",
    ));
    assert.deepEqual(result, { path: executable, source: "project", version: "1.18.2" });
    assert.deepEqual(reads, [manifestPath]);
    assert.deepEqual(versionProbes, [executable]);
    assert.equal(lookupCalls, 0);
  });
});

test("an old Bun native candidate is skipped before a valid npm 1.18.2 native package", async () => {
  await withInstallationFixture(async ({ root, runtimeRoot, studioRoot }) => {
    const oldBunExecutable = join(root, "bun", "opencode.exe");
    await mkdir(join(root, "bun"), { recursive: true });
    await writeFile(oldBunExecutable, "old bun fixture");

    const shimDirectory = join(root, "npm");
    const commandShim = join(shimDirectory, "opencode.cmd");
    const { executable } = await writeOpenCodePackage(
      join(shimDirectory, "node_modules", "opencode-ai"),
    );
    await writeFile(commandShim, "@echo never execute this shim");
    const probes = [];

    const result = await resolveOpenCodeInstallation({
      mode: "check",
      studioRoot,
      runtimeRoot,
      runWhere: async (_file, [lookup]) => lookup === "opencode.exe"
        ? { stdout: `${oldBunExecutable}\r\n`, stderr: "", exitCode: 0 }
        : { stdout: `${commandShim}\r\n`, stderr: "", exitCode: 0 },
      runVersion: async (file) => {
        probes.push(file);
        return {
          stdout: file === oldBunExecutable ? "1.4.1\n" : "1.18.2\n",
          stderr: "",
          exitCode: 0,
        };
      },
    });

    assert.deepEqual(probes, [oldBunExecutable, executable]);
    assert.equal(probes.includes(commandShim), false);
    assert.deepEqual(result, { path: executable, source: "npm-global", version: "1.18.2" });
  });
});

test("a composed explicit override remains terminal before project and discovery fallbacks", async () => {
  await withInstallationFixture(async ({ root, runtimeRoot, studioRoot }) => {
    await writeOpenCodePackage(join(runtimeRoot, "node_modules", "opencode-ai"));
    const explicitOld = join(root, "explicit", "opencode.exe");
    await mkdir(join(root, "explicit"), { recursive: true });
    await writeFile(explicitOld, "old explicit fixture");
    let manifestReads = 0;
    let lookupCalls = 0;

    await assertSanitizedFailure(() => resolveOpenCodeInstallation({
      mode: "check",
      studioRoot,
      runtimeRoot,
      explicitPath: explicitOld,
      readManifest: async () => {
        manifestReads += 1;
        throw new Error("project fallback must not be read");
      },
      runWhere: async () => {
        lookupCalls += 1;
        throw new Error("discovery must not run");
      },
      runVersion: async () => ({ stdout: "1.4.1\n", stderr: "", exitCode: 0 }),
    }));

    assert.equal(manifestReads, 0);
    assert.equal(lookupCalls, 0);
  });
});

test("npm manifests fail closed when missing, oversized, malformed, mismatched, or unsafe", async () => {
  const cases = [
    {
      name: "missing",
      mutate: async ({ manifestPath }) => rm(manifestPath),
    },
    {
      name: "oversized",
      mutate: async ({ manifestPath }) => writeFile(manifestPath, JSON.stringify({
        name: "opencode-ai",
        version: "1.18.2",
        bin: { opencode: "./bin/opencode.exe" },
        padding: "x".repeat(70_000),
      })),
    },
    {
      name: "malformed JSON",
      mutate: async ({ manifestPath }) => writeFile(manifestPath, "{MANIFEST_SECRET"),
    },
    {
      name: "wrong JSON root",
      mutate: async ({ manifestPath }) => writeFile(manifestPath, "[]"),
    },
    {
      name: "wrong package name",
      manifest: { name: "not-opencode-ai" },
    },
    {
      name: "unstable version",
      manifest: { version: "1.18.2-beta.1" },
    },
    {
      name: "incompatible version",
      manifest: { version: "1.4.1" },
    },
    {
      name: "missing bin entry",
      manifest: { bin: {} },
    },
    {
      name: "non-object bin entry",
      manifest: { bin: "./bin/opencode.exe" },
    },
    {
      name: "traversing bin entry",
      manifest: { bin: { opencode: "sub/../bin/opencode.exe" } },
    },
    {
      name: "unsafe reparse manifest",
      inspectManifest: async (file) => ({
        canonicalPath: file,
        isRegularFile: true,
        isReparsePoint: true,
        size: (await lstat(file)).size,
      }),
    },
    {
      name: "manifest-binary version mismatch",
      executableVersion: "1.18.3",
    },
  ];

  for (const testCase of cases) {
    await withInstallationFixture(async ({ root, runtimeRoot, studioRoot }) => {
      const shimDirectory = join(root, "npm", testCase.name.replaceAll(" ", "-"));
      const commandShim = join(shimDirectory, "opencode.cmd");
      const fixture = await writeOpenCodePackage(
        join(shimDirectory, "node_modules", "opencode-ai"),
        testCase.manifest,
      );
      await writeFile(commandShim, "@echo SHIM_SECRET");
      await testCase.mutate?.(fixture);
      const versionProbes = [];

      await assertSanitizedFailure(
        () => resolveOpenCodeInstallation({
          mode: "check",
          studioRoot,
          runtimeRoot,
          inspectManifest: testCase.inspectManifest,
          runWhere: async (_file, [lookup]) => lookup === "opencode.exe"
            ? { stdout: "", stderr: "not found", exitCode: 1 }
            : { stdout: `${commandShim}\r\n`, stderr: "", exitCode: 0 },
          runVersion: async (file) => {
            versionProbes.push(file);
            return {
              stdout: `${testCase.executableVersion ?? "1.18.2"}\n`,
              stderr: "",
              exitCode: 0,
            };
          },
        }),
        [commandShim, "MANIFEST_SECRET", "SHIM_SECRET"],
      );
      assert.equal(versionProbes.includes(commandShim), false, testCase.name);
    });
  }
});

test("the project target is accepted only at the exact fallback version 1.18.2", async () => {
  await withInstallationFixture(async ({ runtimeRoot, studioRoot }) => {
    await writeOpenCodePackage(
      join(runtimeRoot, "node_modules", "opencode-ai"),
      { version: "1.18.3" },
    );
    let versionCalls = 0;

    await assertSanitizedFailure(() => resolveOpenCodeInstallation({
      mode: "check",
      studioRoot,
      runtimeRoot,
      runWhere: async () => ({ stdout: "", stderr: "not found", exitCode: 1 }),
      runVersion: async () => {
        versionCalls += 1;
        return { stdout: "1.18.3\n", stderr: "", exitCode: 0 };
      },
    }));
    assert.equal(versionCalls, 0);
  });
});

test("local node_modules .bin discovery canonical-dedupes shims and accepts regular hard links", async () => {
  await withInstallationFixture(async ({ root, runtimeRoot, studioRoot }) => {
    const nodeModules = join(root, "local", "node_modules");
    const commandShim = join(nodeModules, ".bin", "opencode.cmd");
    const { executable, manifestPath } = await writeOpenCodePackage(
      join(nodeModules, "opencode-ai"),
    );
    await mkdir(join(nodeModules, ".bin"), { recursive: true });
    await writeFile(commandShim, "@echo never execute");
    const hardLinkSource = join(root, "hard-link-source.exe");
    await writeFile(hardLinkSource, "hard-linked native fixture");
    await rm(executable);
    await link(hardLinkSource, executable);

    const reads = [];
    const probes = [];
    const result = await resolveOpenCodeInstallation({
      mode: "check",
      studioRoot,
      runtimeRoot,
      runWhere: async (_file, [lookup]) => lookup === "opencode.exe"
        ? { stdout: "", stderr: "", exitCode: 1 }
        : { stdout: `${commandShim}\r\n${commandShim}\r\n`, stderr: "", exitCode: 0 },
      readManifest: async (file) => {
        reads.push(file);
        return readFile(file, "utf8");
      },
      runVersion: async (file) => {
        probes.push(file);
        return { stdout: "1.18.2\n", stderr: "", exitCode: 0 };
      },
    });

    assert.deepEqual(reads, [manifestPath]);
    assert.deepEqual(probes, [executable]);
    assert.deepEqual(result, { path: executable, source: "npm-global", version: "1.18.2" });
  });
});

test("malformed, timed-out, and oversized native lookups fail closed before cmd lookup", async () => {
  const failures = [
    async () => { throw new Error("LOOKUP_SECRET"); },
    async () => ({ stdout: "C:\\unsafe\\opencode.exe\r\n", exitCode: 0 }),
    async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    async () => ({ stdout: "", stderr: "", exitCode: 1, timedOut: true }),
    async () => ({ stdout: "", stderr: "", exitCode: 1, outputExceeded: true }),
    async () => ({ stdout: "x".repeat(65_537), stderr: "", exitCode: 0 }),
  ];

  for (const failure of failures) {
    await withInstallationFixture(async ({ runtimeRoot, studioRoot }) => {
      let lookupCalls = 0;
      await assertSanitizedFailure(
        () => resolveOpenCodeInstallation({
          mode: "check",
          studioRoot,
          runtimeRoot,
          runWhere: async (...args) => {
            lookupCalls += 1;
            return failure(...args);
          },
        }),
        ["LOOKUP_SECRET", "C:\\unsafe\\opencode.exe"],
      );
      assert.equal(lookupCalls, 1);
    });
  }
});

test("prepare installs exact 1.18.2 in a unique sibling stage and atomically publishes it", async () => {
  await withInstallationFixture(async ({ root, runtimeRoot, studioRoot }) => {
    const nodeExecutable = join(root, "trusted-node", "node.exe");
    const npmCliPath = join(root, "trusted-node", "node_modules", "npm", "bin", "npm-cli.js");
    await mkdir(dirname(npmCliPath), { recursive: true });
    await writeFile(nodeExecutable, "trusted node fixture");
    await writeFile(npmCliPath, "trusted npm cli fixture");

    let installCalls = 0;
    let stagePath;
    const result = await resolveOpenCodeInstallation({
      mode: "prepare",
      studioRoot,
      runtimeRoot,
      nodeExecutable,
      npmCliPath,
      runWhere: async () => ({ stdout: "", stderr: "not found", exitCode: 1 }),
      runInstall: async (file, argv, options) => {
        installCalls += 1;
        stagePath = argv[3];
        assert.equal(file, nodeExecutable);
        assert.equal(dirname(stagePath), join(studioRoot, ".runtime"));
        assert.match(basename(stagePath), /^\.opencode-staging-/u);
        assert.deepEqual(argv, [
          npmCliPath,
          "install",
          "--prefix",
          stagePath,
          "--no-save",
          "--package-lock=false",
          "--no-audit",
          "--no-fund",
          "--no-progress",
          "--loglevel=error",
          "opencode-ai@1.18.2",
        ]);
        assertSafeExecutionOptions(options);
        assert.equal(argv.includes("--global"), false);
        assert.equal(argv.includes("--ignore-scripts"), false);
        await writeOpenCodePackage(join(stagePath, "node_modules", "opencode-ai"));
        return {
          stdout: "\nadded 3 packages in 4s\n",
          stderr: "npm warn bounded diagnostic\n",
          exitCode: 0,
        };
      },
      runVersion: async () => ({ stdout: "1.18.2\n", stderr: "", exitCode: 0 }),
    });

    assert.equal(installCalls, 1);
    assert.deepEqual(result, {
      path: join(runtimeRoot, "node_modules", "opencode-ai", "bin", "opencode.exe"),
      source: "project",
      version: "1.18.2",
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal((await lstat(result.path)).isFile(), true);
    await assert.rejects(() => lstat(stagePath), { code: "ENOENT" });
  });
});

test("prepare accepts an exact verified race winner and safely cleans its unpublished stage", async () => {
  await withInstallationFixture(async ({ root, runtimeRoot, studioRoot }) => {
    const { nodeExecutable, npmCliPath } = await writeTrustedNodeFixture(root);
    let stagePath;
    const result = await resolveOpenCodeInstallation({
      mode: "prepare",
      studioRoot,
      runtimeRoot,
      nodeExecutable,
      npmCliPath,
      runWhere: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
      runInstall: async (_file, argv) => {
        stagePath = argv[3];
        await writeOpenCodePackage(join(stagePath, "node_modules", "opencode-ai"));
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      publishStage: async (_stage, destination) => {
        await writeOpenCodePackage(join(destination, "node_modules", "opencode-ai"));
        const error = new Error("RACE_SECRET");
        error.code = "EEXIST";
        throw error;
      },
      runVersion: async () => ({ stdout: "1.18.2\n", stderr: "", exitCode: 0 }),
    });

    assert.deepEqual(result, {
      path: join(runtimeRoot, "node_modules", "opencode-ai", "bin", "opencode.exe"),
      source: "project",
      version: "1.18.2",
    });
    await assert.rejects(() => lstat(stagePath), { code: "ENOENT" });
  });
});

test("prepare never deletes or replaces an invalid preexisting runtime destination", async () => {
  await withInstallationFixture(async ({ runtimeRoot, studioRoot }) => {
    const sentinel = "INVALID_RUNTIME_SENTINEL";
    await mkdir(dirname(runtimeRoot), { recursive: true });
    await writeFile(runtimeRoot, sentinel);
    let installCalls = 0;

    await assertSanitizedFailure(
      () => resolveOpenCodeInstallation({
        mode: "prepare",
        studioRoot,
        runtimeRoot,
        runWhere: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
        runInstall: async () => {
          installCalls += 1;
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      }),
      [runtimeRoot, sentinel],
    );

    assert.equal(installCalls, 0);
    assert.equal(await readFile(runtimeRoot, "utf8"), sentinel);
  });
});

test("prepare makes zero install calls for an existing candidate or a terminal invalid explicit override", async () => {
  await withInstallationFixture(async ({ root, runtimeRoot, studioRoot }) => {
    const { executable } = await writeOpenCodePackage(
      join(runtimeRoot, "node_modules", "opencode-ai"),
    );
    let installCalls = 0;
    const noInstall = async () => {
      installCalls += 1;
      throw new Error("INSTALL_MUST_NOT_RUN");
    };
    const existing = await resolveOpenCodeInstallation({
      mode: "prepare",
      studioRoot,
      runtimeRoot,
      runWhere: async () => { throw new Error("discovery must not run"); },
      runInstall: noInstall,
      runVersion: async () => ({ stdout: "1.18.2\n", stderr: "", exitCode: 0 }),
    });
    assert.deepEqual(existing, { path: executable, source: "project", version: "1.18.2" });

    const explicitOld = join(root, "explicit-old.exe");
    await writeFile(explicitOld, "old explicit fixture");
    await assertSanitizedFailure(() => resolveOpenCodeInstallation({
      mode: "prepare",
      studioRoot,
      runtimeRoot,
      explicitPath: explicitOld,
      runInstall: noInstall,
      runVersion: async () => ({ stdout: "1.4.1\n", stderr: "", exitCode: 0 }),
    }));
    assert.equal(installCalls, 0);
  });
});

test("prepare rejects malformed install results, failures, and output beyond the byte bound", async () => {
  const failures = [
    {
      name: "throw",
      result: async () => { throw new Error("INSTALL_ERROR_SECRET"); },
    },
    {
      name: "nonzero",
      result: async () => ({ stdout: "", stderr: "", exitCode: 7 }),
    },
    {
      name: "timeout",
      result: async () => ({ stdout: "", stderr: "", exitCode: 1, timedOut: true }),
    },
    {
      name: "max buffer",
      result: async () => ({ stdout: "", stderr: "", exitCode: 1, outputExceeded: true }),
    },
    {
      name: "malformed result",
      result: async () => null,
    },
    {
      name: "non-string stdout",
      result: async () => ({ stdout: Buffer.from("not a string"), stderr: "", exitCode: 0 }),
    },
    {
      name: "non-string stderr",
      result: async () => ({ stdout: "", stderr: 7, exitCode: 0 }),
    },
    {
      name: "oversized stdout",
      result: async () => ({ stdout: "O".repeat(65_537), stderr: "", exitCode: 0 }),
    },
    {
      name: "oversized stderr",
      result: async () => ({ stdout: "", stderr: "E".repeat(65_537), exitCode: 0 }),
    },
  ];

  for (const failure of failures) {
    await withInstallationFixture(async ({ root, runtimeRoot, studioRoot }) => {
      const { nodeExecutable, npmCliPath } = await writeTrustedNodeFixture(root);
      let installCalls = 0;
      let stagePath;
      await assertSanitizedFailure(
        () => resolveOpenCodeInstallation({
          mode: "prepare",
          studioRoot,
          runtimeRoot,
          nodeExecutable,
          npmCliPath,
          environment: {
            PATH: "C:\\Tools",
            PATHEXT: ".EXE;.CMD",
            SystemRoot: "C:\\Windows",
            WINDIR: "C:\\Windows",
            INSTALL_ENV_SECRET: "must-not-forward",
          },
          runWhere: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
          runInstall: async (_file, argv, options) => {
            installCalls += 1;
            stagePath = argv[3];
            assertSafeExecutionOptions(options);
            assert.equal("INSTALL_ENV_SECRET" in options.env, false);
            return failure.result();
          },
          runVersion: async () => { throw new Error("version probe must not run"); },
        }),
        [
          runtimeRoot,
          "INSTALL_ERROR_SECRET",
          "must-not-forward",
        ],
      );

      assert.equal(installCalls, 1, failure.name);
      await assert.rejects(() => lstat(stagePath), { code: "ENOENT" });
      await assert.rejects(() => lstat(runtimeRoot), { code: "ENOENT" });
    });
  }
});

test("prepare rejects partial, mismatched, and unsafe staged installations before publish", async () => {
  const cases = [
    {
      name: "missing package",
      populate: async () => {},
    },
    {
      name: "missing native binary",
      populate: async (stagePath) => {
        const fixture = await writeOpenCodePackage(
          join(stagePath, "node_modules", "opencode-ai"),
        );
        await rm(fixture.executable);
      },
    },
    {
      name: "wrong fallback version",
      populate: async (stagePath) => writeOpenCodePackage(
        join(stagePath, "node_modules", "opencode-ai"),
        { version: "1.18.3" },
      ),
    },
    {
      name: "manifest-binary mismatch",
      populate: async (stagePath) => writeOpenCodePackage(
        join(stagePath, "node_modules", "opencode-ai"),
      ),
      executableVersion: "1.18.3",
    },
    {
      name: "unsafe manifest",
      populate: async (stagePath) => writeOpenCodePackage(
        join(stagePath, "node_modules", "opencode-ai"),
      ),
      inspectManifest: async (file) => ({
        canonicalPath: file,
        isRegularFile: true,
        isReparsePoint: true,
        size: (await lstat(file)).size,
      }),
    },
  ];

  for (const testCase of cases) {
    await withInstallationFixture(async ({ root, runtimeRoot, studioRoot }) => {
      const { nodeExecutable, npmCliPath } = await writeTrustedNodeFixture(root);
      let installCalls = 0;
      let publishCalls = 0;
      let stagePath;
      await assertSanitizedFailure(() => resolveOpenCodeInstallation({
        mode: "prepare",
        studioRoot,
        runtimeRoot,
        nodeExecutable,
        npmCliPath,
        inspectManifest: testCase.inspectManifest,
        runWhere: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
        runInstall: async (_file, argv) => {
          installCalls += 1;
          stagePath = argv[3];
          await testCase.populate(stagePath);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        publishStage: async () => {
          publishCalls += 1;
          throw new Error("PUBLISH_MUST_NOT_RUN");
        },
        runVersion: async () => ({
          stdout: `${testCase.executableVersion ?? "1.18.2"}\n`,
          stderr: "",
          exitCode: 0,
        }),
      }));

      assert.equal(installCalls, 1, testCase.name);
      assert.equal(publishCalls, 0, testCase.name);
      await assert.rejects(() => lstat(stagePath), { code: "ENOENT" });
      await assert.rejects(() => lstat(runtimeRoot), { code: "ENOENT" });
    });
  }
});

test("prepare never recursively cleans a stage outside its exact owned sibling prefix", async () => {
  await withInstallationFixture(async ({ root, runtimeRoot, studioRoot }) => {
    const { nodeExecutable, npmCliPath } = await writeTrustedNodeFixture(root);
    const outsideStage = join(root, "outside-stage");
    const sentinel = join(outsideStage, "KEEP_ME.txt");
    await mkdir(outsideStage, { recursive: true });
    await writeFile(sentinel, "OUTSIDE_SENTINEL");
    let installCalls = 0;
    let cleanupCalls = 0;

    await assertSanitizedFailure(() => resolveOpenCodeInstallation({
      mode: "prepare",
      studioRoot,
      runtimeRoot,
      nodeExecutable,
      npmCliPath,
      runWhere: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
      makeStage: async () => outsideStage,
      removeStage: async () => {
        cleanupCalls += 1;
      },
      runInstall: async () => {
        installCalls += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    }));

    assert.equal(installCalls, 0);
    assert.equal(cleanupCalls, 0);
    assert.equal(await readFile(sentinel, "utf8"), "OUTSIDE_SENTINEL");
  });
});

test("prepare rejects publish failures and never accepts or deletes an invalid race winner", async () => {
  const cases = [
    { name: "ordinary publish failure", code: "EACCES", createWinner: false },
    { name: "invalid race winner", code: "EEXIST", createWinner: true },
  ];

  for (const testCase of cases) {
    await withInstallationFixture(async ({ root, runtimeRoot, studioRoot }) => {
      const { nodeExecutable, npmCliPath } = await writeTrustedNodeFixture(root);
      let stagePath;
      await assertSanitizedFailure(
        () => resolveOpenCodeInstallation({
          mode: "prepare",
          studioRoot,
          runtimeRoot,
          nodeExecutable,
          npmCliPath,
          runWhere: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
          runInstall: async (_file, argv) => {
            stagePath = argv[3];
            await writeOpenCodePackage(join(stagePath, "node_modules", "opencode-ai"));
            return { stdout: "", stderr: "", exitCode: 0 };
          },
          publishStage: async () => {
            if (testCase.createWinner) {
              await writeOpenCodePackage(
                join(runtimeRoot, "node_modules", "opencode-ai"),
                { version: "1.18.3" },
              );
            }
            const error = new Error("PUBLISH_ERROR_SECRET");
            error.code = testCase.code;
            throw error;
          },
          runVersion: async () => ({ stdout: "1.18.2\n", stderr: "", exitCode: 0 }),
        }),
        [runtimeRoot, "PUBLISH_ERROR_SECRET"],
      );

      await assert.rejects(() => lstat(stagePath), { code: "ENOENT" });
      if (testCase.createWinner) {
        const winnerManifest = JSON.parse(await readFile(
          join(runtimeRoot, "node_modules", "opencode-ai", "package.json"),
          "utf8",
        ));
        assert.equal(winnerManifest.version, "1.18.3", testCase.name);
      } else {
        await assert.rejects(() => lstat(runtimeRoot), { code: "ENOENT" });
      }
    });
  }
});

test("prepare rejects npm.cmd and non-sibling npm CLI paths before staging or install", async () => {
  await withInstallationFixture(async ({ root, runtimeRoot, studioRoot }) => {
    const { nodeExecutable } = await writeTrustedNodeFixture(root);
    const npmCommandShim = join(dirname(nodeExecutable), "npm.cmd");
    const unrelatedNpmCli = join(root, "unrelated", "npm-cli.js");
    await writeFile(npmCommandShim, "@echo never execute");
    await mkdir(dirname(unrelatedNpmCli), { recursive: true });
    await writeFile(unrelatedNpmCli, "untrusted npm cli fixture");

    for (const npmCliPath of [npmCommandShim, unrelatedNpmCli]) {
      let installCalls = 0;
      let stageCalls = 0;
      await assertSanitizedFailure(() => resolveOpenCodeInstallation({
        mode: "prepare",
        studioRoot,
        runtimeRoot,
        nodeExecutable,
        npmCliPath,
        runWhere: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
        makeStage: async () => {
          stageCalls += 1;
          throw new Error("stage must not be created");
        },
        runInstall: async () => {
          installCalls += 1;
          throw new Error("install must not run");
        },
      }));
      assert.equal(stageCalls, 0);
      assert.equal(installCalls, 0);
      await assert.rejects(() => lstat(dirname(runtimeRoot)), { code: "ENOENT" });
    }
  });
});

test("check mode never invokes any preparation mutation hook", async () => {
  await withInstallationFixture(async ({ runtimeRoot, studioRoot }) => {
    const mutations = [];
    const record = (name) => async () => {
      mutations.push(name);
      throw new Error(`${name} must not run`);
    };

    await assertSanitizedFailure(() => resolveOpenCodeInstallation({
      mode: "check",
      studioRoot,
      runtimeRoot,
      runWhere: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
      createDirectory: record("createDirectory"),
      makeStage: record("makeStage"),
      runInstall: record("runInstall"),
      publishStage: record("publishStage"),
      removeStage: record("removeStage"),
    }));

    assert.deepEqual(mutations, []);
    await assert.rejects(() => lstat(runtimeRoot), { code: "ENOENT" });
  });
});

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
