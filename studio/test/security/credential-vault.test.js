import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { CredentialVault } from "../../src/security/credential-vault.js";

const USERNAME = "demo";
const PASSWORD = "secret-123";

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "manual-video-vault-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  return join(root, "vault");
}

function fakeDpapi(calls = []) {
  return async (options) => {
    calls.push(options);
    const request = JSON.parse(options.input);
    if (request.operation === "protect") {
      return {
        exitCode: 0,
        stdout: Buffer.from(request.payload, "utf8").toString("base64"),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: Buffer.from(request.payload, "base64").toString("utf8"),
      stderr: "",
    };
  };
}

test("round-trips injected DPAPI without persisting either credential value", async (t) => {
  const root = await temporaryRoot(t);
  const calls = [];
  const vault = new CredentialVault({ root, runPowerShell: fakeDpapi(calls) });

  await vault.save("fixture", { username: USERNAME, password: PASSWORD });
  const persisted = await readFile(vault.pathFor("fixture"), "utf8");

  assert.equal(persisted.includes(USERNAME), false);
  assert.equal(persisted.includes(PASSWORD), false);
  assert.deepEqual(await vault.load("fixture"), {
    username: USERNAME,
    password: PASSWORD,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].shell, false);
  assert.equal(calls[0].input.includes(USERNAME), true);
  assert.equal(calls[0].input.includes(PASSWORD), true);
  for (const call of calls) {
    const processBoundary = JSON.stringify({
      command: call.command,
      args: call.args,
      env: call.env,
    });
    assert.equal(processBoundary.includes(USERNAME), false);
    assert.equal(processBoundary.includes(PASSWORD), false);
    assert.match(call.command, /(?:powershell|pwsh)\.exe$/iu);
    assert.equal(call.timeoutMs > 0 && call.timeoutMs <= 30_000, true);
  }
});

test("uses real Windows CurrentUser DPAPI for a persisted round trip", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows DPAPI is available only on Windows.");
    return;
  }
  const root = await temporaryRoot(t);
  const vault = new CredentialVault({ root });

  await vault.save("real-fixture", { username: USERNAME, password: PASSWORD });
  const persisted = await readFile(vault.pathFor("real-fixture"), "utf8");

  assert.equal(persisted.includes(USERNAME), false);
  assert.equal(persisted.includes(PASSWORD), false);
  assert.deepEqual(await vault.load("real-fixture"), {
    username: USERNAME,
    password: PASSWORD,
  });
});

test("passes a constant script in arguments and plaintext only through stdin", async (t) => {
  const root = await temporaryRoot(t);
  const calls = [];
  const vault = new CredentialVault({ root, runPowerShell: fakeDpapi(calls) });

  await vault.save("fixture", { username: USERNAME, password: PASSWORD });

  assert.equal(calls[0].args.includes("-EncodedCommand"), true);
  assert.equal(calls[0].args.join(" ").includes(USERNAME), false);
  assert.equal(calls[0].args.join(" ").includes(PASSWORD), false);
  assert.deepEqual(calls[0].env, {});
  assert.equal(calls[0].input.includes(USERNAME), true);
  assert.equal(calls[0].input.includes(PASSWORD), true);
});

test("rejects traversal, device names, unsafe types, and overlong names", async (t) => {
  const root = await temporaryRoot(t);
  const vault = new CredentialVault({ root, runPowerShell: fakeDpapi() });
  const unsafeNames = [
    "",
    ".",
    "..",
    "../escape",
    "child/name",
    "child\\name",
    "CON",
    "nul",
    "COM1",
    "lpt9",
    "a".repeat(65),
    new String("fixture"),
  ];

  for (const name of unsafeNames) {
    assert.throws(() => vault.pathFor(name), {
      code: "INVALID_CREDENTIAL_NAME",
    });
    await assert.rejects(
      vault.save(name, { username: USERNAME, password: PASSWORD }),
      { code: "INVALID_CREDENTIAL_NAME" },
    );
  }
  await assert.rejects(readdir(root), { code: "ENOENT" });
});

test("rejects invalid credential shapes without invoking getters or PowerShell", async (t) => {
  const root = await temporaryRoot(t);
  let calls = 0;
  let getterRan = false;
  const vault = new CredentialVault({
    root,
    runPowerShell: async () => {
      calls += 1;
      throw new Error("must not run");
    },
  });
  const accessor = { password: PASSWORD };
  Object.defineProperty(accessor, "username", {
    enumerable: true,
    get() {
      getterRan = true;
      return USERNAME;
    },
  });
  const invalid = [
    null,
    { username: "", password: PASSWORD },
    { username: USERNAME, password: "" },
    { username: USERNAME, password: PASSWORD, passwordSelector: "#password" },
    { username: "u".repeat(257), password: PASSWORD },
    { username: USERNAME, password: "p".repeat(4097) },
    accessor,
    Object.create({ username: USERNAME, password: PASSWORD }),
  ];

  for (const credentials of invalid) {
    await assert.rejects(vault.save("fixture", credentials), {
      code: "INVALID_CREDENTIALS",
    });
  }
  assert.equal(getterRan, false);
  assert.equal(calls, 0);
});

test("normalizes hostile option and credential reflection traps", async (t) => {
  const root = await temporaryRoot(t);
  const marker = "vault-proxy-private-marker";
  const traps = ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"];

  for (const trap of traps) {
    const options = new Proxy(
      { root, runPowerShell: fakeDpapi() },
      {
        [trap]() {
          throw new Error(marker);
        },
      },
    );
    assert.throws(
      () => new CredentialVault(options),
      (error) => {
        assert.equal(error.code, "UNSAFE_VAULT_ROOT");
        assert.equal(error.message, "The credential vault root is unsafe.");
        assert.equal(String(error).includes(marker), false);
        return true;
      },
    );
  }

  const vault = new CredentialVault({ root, runPowerShell: fakeDpapi() });
  for (const [index, trap] of traps.entries()) {
    const credentials = new Proxy(
      { username: USERNAME, password: PASSWORD },
      {
        [trap]() {
          throw new Error(marker);
        },
      },
    );
    await assert.rejects(
      vault.save(`proxy-${index}`, credentials),
      (error) => {
        assert.equal(error.code, "INVALID_CREDENTIALS");
        assert.equal(error.message, "The credentials are invalid.");
        assert.equal(String(error).includes(marker), false);
        return true;
      },
    );
  }
});

test("normalizes hostile PowerShell result reflection traps", async (t) => {
  const root = await temporaryRoot(t);
  const marker = "runner-proxy-private-marker";
  const traps = ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"];

  for (const [index, trap] of traps.entries()) {
    const vault = new CredentialVault({
      root,
      runPowerShell: async () =>
        new Proxy(
          { exitCode: 0, stderr: "", stdout: "QUFBQQ==" },
          {
            [trap]() {
              throw new Error(marker);
            },
          },
        ),
    });
    await assert.rejects(
      vault.save(`runner-${index}`, { username: USERNAME, password: PASSWORD }),
      (error) => {
        assert.equal(error.code, "VAULT_ENCRYPT_FAILED");
        assert.equal(error.message, "The credential operation failed safely.");
        assert.equal(String(error).includes(marker), false);
        return true;
      },
    );
  }
});

test("rejects a relative, symbolic-link, or junction vault root", async (t) => {
  assert.throws(
    () => new CredentialVault({ root: "relative-vault", runPowerShell: fakeDpapi() }),
    { code: "UNSAFE_VAULT_ROOT" },
  );

  const parent = await mkdtemp(join(tmpdir(), "manual-video-vault-links-"));
  t.after(() => rm(parent, { force: true, recursive: true }));
  const target = join(parent, "target");
  const linkedRoot = join(parent, "linked-root");
  await mkdir(target);
  await symlink(target, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  const vault = new CredentialVault({
    root: linkedRoot,
    runPowerShell: fakeDpapi(),
  });

  await assert.rejects(
    vault.save("fixture", { username: USERNAME, password: PASSWORD }),
    { code: "UNSAFE_VAULT_ROOT" },
  );
  assert.deepEqual(await readdir(target), []);
});

test("rejects an intermediate junction before creating directories outside it", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "manual-video-vault-prefix-"));
  t.after(() => rm(parent, { force: true, recursive: true }));
  const outside = join(parent, "outside");
  const linkedPrefix = join(parent, "linked-prefix");
  await mkdir(outside);
  await symlink(
    outside,
    linkedPrefix,
    process.platform === "win32" ? "junction" : "dir",
  );
  const vault = new CredentialVault({
    root: join(linkedPrefix, "nested", "vault"),
    runPowerShell: fakeDpapi(),
  });

  await assert.rejects(
    vault.save("fixture", { username: USERNAME, password: PASSWORD }),
    { code: "UNSAFE_VAULT_ROOT" },
  );
  assert.deepEqual(await readdir(outside), []);
});

test("rejects symbolic credential paths and leaves their target untouched", async (t) => {
  const root = await temporaryRoot(t);
  const vault = new CredentialVault({ root, runPowerShell: fakeDpapi() });
  await vault.save("fixture", { username: USERNAME, password: PASSWORD });
  const outside = join(dirname(root), "outside");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "outside", "utf8");
  await rm(vault.pathFor("fixture"));
  await symlink(
    outside,
    vault.pathFor("fixture"),
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(vault.load("fixture"), {
    code: "UNSAFE_VAULT_PATH",
  });
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "outside");
});

test("normalizes runner failures and never exposes child output or credentials", async (t) => {
  const root = await temporaryRoot(t);
  const vault = new CredentialVault({
    root,
    runPowerShell: async () => ({
      exitCode: 12,
      stdout: USERNAME,
      stderr: PASSWORD,
      timedOut: true,
    }),
  });

  await assert.rejects(
    vault.save("fixture", { username: USERNAME, password: PASSWORD }),
    (error) => {
      assert.equal(error.code, "VAULT_ENCRYPT_FAILED");
      assert.equal(error.message, "The credential operation failed safely.");
      assert.equal(String(error).includes(USERNAME), false);
      assert.equal(String(error).includes(PASSWORD), false);
      return true;
    },
  );
});

test("returns one safe error for corrupt, tampered, or invalid decrypted payloads", async (t) => {
  const root = await temporaryRoot(t);
  const vault = new CredentialVault({ root, runPowerShell: fakeDpapi() });
  await vault.save("fixture", { username: USERNAME, password: PASSWORD });

  for (const persisted of [
    "not-json",
    JSON.stringify({ version: 1, ciphertext: "%%%" }),
    JSON.stringify({ version: 2, ciphertext: "AAAA" }),
    JSON.stringify({ version: 1, ciphertext: "AAAA", extra: true }),
  ]) {
    await writeFile(vault.pathFor("fixture"), persisted, "utf8");
    await assert.rejects(vault.load("fixture"), {
      code: "VAULT_DECRYPT_FAILED",
      message: "The stored credential could not be decrypted.",
    });
  }

  const invalidPlaintextVault = new CredentialVault({
    root,
    runPowerShell: async ({ input }) => {
      const request = JSON.parse(input);
      if (request.operation === "protect") {
        return { exitCode: 0, stdout: "QUFBQQ==", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          username: USERNAME,
          password: PASSWORD,
          passwordSelector: "#password",
        }),
        stderr: "",
      };
    },
  });
  await invalidPlaintextVault.save("fixture", {
    username: USERNAME,
    password: PASSWORD,
  });
  await assert.rejects(invalidPlaintextVault.load("fixture"), {
    code: "VAULT_DECRYPT_FAILED",
    message: "The stored credential could not be decrypted.",
  });
});

test("publishes ciphertext atomically without leaving temporary files", async (t) => {
  const root = await temporaryRoot(t);
  const vault = new CredentialVault({ root, runPowerShell: fakeDpapi() });

  await vault.save("fixture", { username: USERNAME, password: PASSWORD });

  assert.deepEqual(await readdir(root), ["fixture.dpapi"]);
});

test("permission failure on the temporary file cannot publish a target", async (t) => {
  const root = await temporaryRoot(t);
  const probePath = join(dirname(root), "file-handle-probe");
  const probe = await open(probePath, "wx", 0o600);
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  await rm(probePath);
  t.mock.method(fileHandlePrototype, "chmod", async () => {
    throw new Error("injected chmod failure");
  });
  const vault = new CredentialVault({ root, runPowerShell: fakeDpapi() });

  await assert.rejects(
    vault.save("fixture", { username: USERNAME, password: PASSWORD }),
    { code: "VAULT_WRITE_FAILED" },
  );
  await assert.rejects(readFile(vault.pathFor("fixture")), { code: "ENOENT" });
  assert.deepEqual(await readdir(root), []);
});
