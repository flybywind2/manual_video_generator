import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  scavengeEphemeralSecrets,
  withEphemeralSecrets,
} from "../../src/security/ephemeral-secrets.js";

const execFileAsync = promisify(execFile);
const USERNAME = "redaction-user";
const PASSWORD = "redaction-pass";
const OPERATION_NAME = /^op-[a-f0-9]{32}$/u;

async function temporaryStudio(t) {
  const base = await mkdtemp(join(tmpdir(), "manual-video-ephemeral-"));
  t.after(() => rm(base, { force: true, recursive: true }));
  const studio = join(base, "studio");
  await mkdir(studio);
  return {
    base,
    jobsRoot: join(studio, "data", "jobs"),
    runtimeRoot: join(studio, ".runtime", "secrets"),
    studio,
  };
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("applies directory and empty-file ACLs before writing quoted dotenv values", async (t) => {
  const { runtimeRoot } = await temporaryStudio(t);
  const events = [];
  const credentials = {
    username: 'user $ # = " \\ tail',
    password: "pass='value'\\end",
  };

  const result = await withEphemeralSecrets(
    runtimeRoot,
    credentials,
    async (path, context) => {
      events.push("callback");
      assert.equal(context.signal, undefined);
      assert.equal(isAbsolute(path), true);
      assert.match(dirname(path).split(/[\\/]/u).at(-1), OPERATION_NAME);
      assert.equal(path.includes(credentials.username), false);
      assert.equal(path.includes(credentials.password), false);
      assert.equal(
        await readFile(path, "utf8"),
        'MCP_REDACT_USERNAME="user $ # = \\" \\\\ tail"\n' +
          'MCP_REDACT_PASSWORD="pass=\'value\'\\\\end"\n',
      );
      return "created";
    },
    {
      applyAcl: async ({ path, kind }) => {
        if (kind === "directory") {
          assert.equal((await stat(path)).isDirectory(), true);
          events.push("directory-acl");
        } else {
          assert.equal((await stat(path)).size, 0);
          events.push("file-acl");
        }
      },
    },
  );

  assert.equal(result, "created");
  assert.deepEqual(events, ["directory-acl", "file-acl", "callback"]);
  assert.deepEqual(await readdir(runtimeRoot), []);
});

test("rejects dotenv injection and non-allowlisted credential fields", async (t) => {
  const { runtimeRoot } = await temporaryStudio(t);
  let getterRan = false;
  const accessor = { password: PASSWORD };
  Object.defineProperty(accessor, "username", {
    enumerable: true,
    get() {
      getterRan = true;
      return USERNAME;
    },
  });
  const invalid = [
    { username: `bad\nKEY=value`, password: PASSWORD },
    { username: `bad\rKEY=value`, password: PASSWORD },
    { username: `bad\0value`, password: PASSWORD },
    { username: USERNAME, password: `${PASSWORD}\nEXTRA=value` },
    { username: USERNAME, password: PASSWORD, token: "extra" },
    { MCP_REDACT_USERNAME: USERNAME, MCP_REDACT_PASSWORD: PASSWORD },
    accessor,
  ];

  for (const credentials of invalid) {
    await assert.rejects(
      withEphemeralSecrets(runtimeRoot, credentials, async () => undefined, {
        applyAcl: async () => undefined,
      }),
      {
        code: "INVALID_EPHEMERAL_CREDENTIALS",
        message: "The ephemeral credentials are invalid.",
      },
    );
  }
  assert.equal(getterRan, false);
  assert.equal(await pathExists(runtimeRoot), false);
});

test("cleans the operation directory after success and a thrown callback error", async (t) => {
  const { runtimeRoot } = await temporaryStudio(t);
  const applyAcl = async () => undefined;
  let successDirectory;

  assert.equal(
    await withEphemeralSecrets(
      runtimeRoot,
      { username: USERNAME, password: PASSWORD },
      async (path) => {
        successDirectory = dirname(path);
        return 42;
      },
      { applyAcl },
    ),
    42,
  );
  assert.equal(await pathExists(successDirectory), false);

  const callbackError = new Error("callback failed");
  let failureDirectory;
  await assert.rejects(
    withEphemeralSecrets(
      runtimeRoot,
      { username: USERNAME, password: PASSWORD },
      async (path) => {
        failureDirectory = dirname(path);
        throw callbackError;
      },
      { applyAcl },
    ),
    (error) => error === callbackError,
  );
  assert.equal(await pathExists(failureDirectory), false);
});

test("does not invoke a callback for an already-aborted signal", async (t) => {
  const { runtimeRoot } = await temporaryStudio(t);
  const controller = new AbortController();
  controller.abort(new Error("untrusted abort reason"));
  let invoked = false;

  await assert.rejects(
    withEphemeralSecrets(
      runtimeRoot,
      { username: USERNAME, password: PASSWORD },
      async () => {
        invoked = true;
      },
      { signal: controller.signal, applyAcl: async () => undefined },
    ),
    {
      code: "EPHEMERAL_OPERATION_ABORTED",
      message: "The ephemeral secret operation was aborted.",
    },
  );
  assert.equal(invoked, false);
  assert.equal(await pathExists(runtimeRoot), false);
});

test("cleans after cooperative mid-flight abort", async (t) => {
  const { runtimeRoot } = await temporaryStudio(t);
  const controller = new AbortController();
  const callbackStarted = deferred();
  let operationDirectory;
  const operation = withEphemeralSecrets(
    runtimeRoot,
    { username: USERNAME, password: PASSWORD },
    async (path, { signal }) => {
      operationDirectory = dirname(path);
      callbackStarted.resolve();
      await new Promise((resolvePromise, rejectPromise) => {
        signal.addEventListener(
          "abort",
          () => rejectPromise(new Error("cooperative abort")),
          { once: true },
        );
      });
    },
    { signal: controller.signal, applyAcl: async () => undefined },
  );

  await callbackStarted.promise;
  controller.abort();
  await assert.rejects(operation, { message: "cooperative abort" });
  assert.equal(await pathExists(operationDirectory), false);
});

test("waits for an uncooperative callback before removing its file", async (t) => {
  const { runtimeRoot } = await temporaryStudio(t);
  const controller = new AbortController();
  const callbackStarted = deferred();
  const release = deferred();
  let secretPath;
  const operation = withEphemeralSecrets(
    runtimeRoot,
    { username: USERNAME, password: PASSWORD },
    async (path) => {
      secretPath = path;
      callbackStarted.resolve();
      await release.promise;
      return "finished";
    },
    { signal: controller.signal, applyAcl: async () => undefined },
  );

  await callbackStarted.promise;
  controller.abort();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(await pathExists(secretPath), true);
  release.resolve();
  assert.equal(await operation, "finished");
  assert.equal(await pathExists(secretPath), false);
});

test("uses a protected Windows ACL containing only current-user and SYSTEM rules", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows ACL inspection is available only on Windows.");
    return;
  }
  const { runtimeRoot } = await temporaryStudio(t);
  const inspectionScript = String.raw`
$path = $env:MANUAL_VIDEO_ACL_INSPECT_PATH
$acl = [System.IO.File]::GetAccessControl($path)
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sids = @($acl.GetAccessRules(
  $true,
  $false,
  [System.Security.Principal.SecurityIdentifier]
) | ForEach-Object {
  $_.IdentityReference.Value
} | Sort-Object -Unique)
[ordered]@{ Protected = $acl.AreAccessRulesProtected; Current = $current; Sids = $sids } |
  ConvertTo-Json -Compress
`;

  await withEphemeralSecrets(
    runtimeRoot,
    { username: USERNAME, password: PASSWORD },
    async (path) => {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", inspectionScript],
        {
          encoding: "utf8",
          env: { ...process.env, MANUAL_VIDEO_ACL_INSPECT_PATH: path },
          windowsHide: true,
        },
      );
      const acl = JSON.parse(stdout.trim());
      assert.equal(acl.Protected, true);
      assert.equal(acl.Sids.includes(acl.Current), true);
      assert.equal(acl.Sids.includes("S-1-5-18"), true);
      assert.equal(
        acl.Sids.every((sid) => sid === acl.Current || sid === "S-1-5-18"),
        true,
      );
    },
  );
});

test("requires an absolute .runtime/secrets root outside data/jobs", async (t) => {
  const { base, jobsRoot, studio } = await temporaryStudio(t);
  const invalidRoots = [
    "relative/.runtime/secrets",
    join(studio, ".runtime", "other"),
    join(jobsRoot, ".runtime", "secrets"),
  ];

  for (const runtimeRoot of invalidRoots) {
    await assert.rejects(
      withEphemeralSecrets(
        runtimeRoot,
        { username: USERNAME, password: PASSWORD },
        async () => undefined,
        { applyAcl: async () => undefined },
      ),
      { code: "UNSAFE_EPHEMERAL_ROOT" },
    );
  }

  const runtimeParent = join(studio, ".runtime");
  const target = join(base, "outside-secrets");
  const linkedRoot = join(runtimeParent, "secrets");
  await mkdir(runtimeParent, { recursive: true });
  await mkdir(target);
  await symlink(target, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    withEphemeralSecrets(
      linkedRoot,
      { username: USERNAME, password: PASSWORD },
      async () => undefined,
      { applyAcl: async () => undefined },
    ),
    { code: "UNSAFE_EPHEMERAL_ROOT" },
  );
  assert.deepEqual(await readdir(target), []);
});

test("never writes plaintext below studio/data/jobs", async (t) => {
  const { jobsRoot, runtimeRoot } = await temporaryStudio(t);
  const jobDirectory = join(jobsRoot, "job-safe");
  await mkdir(jobDirectory, { recursive: true });
  await writeFile(join(jobDirectory, "sentinel.json"), '{"safe":true}', "utf8");

  await withEphemeralSecrets(
    runtimeRoot,
    { username: USERNAME, password: PASSWORD },
    async () => {
      const persisted = await readFile(join(jobDirectory, "sentinel.json"), "utf8");
      assert.equal(persisted.includes(USERNAME), false);
      assert.equal(persisted.includes(PASSWORD), false);
    },
    { applyAcl: async () => undefined },
  );

  const persisted = await readFile(join(jobDirectory, "sentinel.json"), "utf8");
  assert.equal(persisted.includes(USERNAME), false);
  assert.equal(persisted.includes(PASSWORD), false);
});

test("scavenges only strict stale operation directories without following links", async (t) => {
  const { base, runtimeRoot } = await temporaryStudio(t);
  await mkdir(runtimeRoot, { recursive: true });
  const empty = join(runtimeRoot, `op-${"a".repeat(32)}`);
  const partial = join(runtimeRoot, `op-${"b".repeat(32)}`);
  const strictFile = join(runtimeRoot, `op-${"c".repeat(32)}`);
  const linked = join(runtimeRoot, `op-${"d".repeat(32)}`);
  const outside = join(base, "outside-stale");
  await mkdir(empty);
  await mkdir(partial);
  await writeFile(join(partial, ".mcp-redaction.env"), "partial", "utf8");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "outside", "utf8");
  await symlink(outside, join(partial, "outside-link"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(strictFile, "unrelated", "utf8");
  await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  await mkdir(join(runtimeRoot, "op-not-strict"));
  await mkdir(join(runtimeRoot, "unrelated"));
  await writeFile(join(runtimeRoot, "keep.txt"), "keep", "utf8");

  assert.equal(await scavengeEphemeralSecrets(runtimeRoot), 2);

  assert.equal(await pathExists(empty), false);
  assert.equal(await pathExists(partial), false);
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "outside");
  assert.equal(await readFile(strictFile, "utf8"), "unrelated");
  assert.equal(await pathExists(linked), true);
  assert.deepEqual(
    (await readdir(runtimeRoot)).sort(),
    [
      "keep.txt",
      "op-not-strict",
      `op-${"c".repeat(32)}`,
      `op-${"d".repeat(32)}`,
      "unrelated",
    ].sort(),
  );
});

test("scavenger rejects unsafe roots and treats a missing valid root as empty", async (t) => {
  const { jobsRoot, runtimeRoot, studio } = await temporaryStudio(t);

  assert.equal(await scavengeEphemeralSecrets(runtimeRoot), 0);
  assert.equal(await pathExists(runtimeRoot), false);
  await assert.rejects(scavengeEphemeralSecrets(join(studio, "secrets")), {
    code: "UNSAFE_EPHEMERAL_ROOT",
  });
  await assert.rejects(
    scavengeEphemeralSecrets(join(jobsRoot, ".runtime", "secrets")),
    { code: "UNSAFE_EPHEMERAL_ROOT" },
  );
});
