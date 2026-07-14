import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanupStaleBrowserProfiles } from "../../src/browser/stale-profile-cleanup.js";

const JOB_A = "job-aaaaaaaaaaaaaaaa";
const JOB_B = "job-bbbbbbbbbbbbbbbb";
const JOB_C = "job-cccccccccccccccc";

test("browser profile cleanup is a no-op when the runtime tree is absent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "manual-browser-cleanup-missing-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  const removed = await cleanupStaleBrowserProfiles(root);

  assert.deepEqual(removed, []);
  assert.equal(Object.isFrozen(removed), true);
  await assert.rejects(access(join(root, ".runtime")), { code: "ENOENT" });
});

test("browser profile cleanup removes validated per-job trees but retains the browser root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "manual-browser-cleanup-valid-"));
  const browserRoot = join(root, ".runtime", "browser");
  await Promise.all([
    mkdir(join(browserRoot, JOB_B, "profile", "Default"), { recursive: true }),
    mkdir(join(browserRoot, JOB_A), { recursive: true }),
  ]);
  await writeFile(
    join(browserRoot, JOB_B, "profile", "Default", "Preferences"),
    "stale",
    "utf8",
  );
  t.after(() => rm(root, { force: true, recursive: true }));

  assert.deepEqual(await cleanupStaleBrowserProfiles(root), [
    JOB_A,
    JOB_B,
  ]);
  await access(browserRoot);
  await assert.rejects(access(join(browserRoot, JOB_A)), { code: "ENOENT" });
  await assert.rejects(access(join(browserRoot, JOB_B)), { code: "ENOENT" });
});

test("browser profile cleanup preflights every candidate before deleting any", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "manual-browser-cleanup-preflight-"));
  const browserRoot = join(root, ".runtime", "browser");
  const validMarker = join(browserRoot, JOB_A, "marker.txt");
  await Promise.all([
    mkdir(join(browserRoot, JOB_A), { recursive: true }),
    mkdir(join(browserRoot, "z.invalid-profile"), { recursive: true }),
  ]);
  await writeFile(validMarker, "keep", "utf8");
  t.after(() => rm(root, { force: true, recursive: true }));

  await assert.rejects(
    cleanupStaleBrowserProfiles(root),
    /unsafe browser profile name/u,
  );
  assert.equal(await readFile(validMarker, "utf8"), "keep");
});

test("browser profile cleanup rejects nested junctions without touching their target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "manual-browser-cleanup-link-"));
  const outside = await mkdtemp(join(tmpdir(), "manual-browser-cleanup-outside-"));
  const profileRoot = join(root, ".runtime", "browser", JOB_C);
  const localMarker = join(profileRoot, "local.txt");
  const outsideMarker = join(outside, "outside.txt");
  await mkdir(profileRoot, { recursive: true });
  await Promise.all([
    writeFile(localMarker, "local", "utf8"),
    writeFile(outsideMarker, "outside", "utf8"),
  ]);
  await symlink(outside, join(profileRoot, "escape"), "junction");
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  });

  await assert.rejects(
    cleanupStaleBrowserProfiles(root),
    /unsafe browser profile/u,
  );
  assert.equal(await readFile(localMarker, "utf8"), "local");
  assert.equal(await readFile(outsideMarker, "utf8"), "outside");
});

test("browser profile cleanup rejects a linked browser root without touching its target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "manual-browser-cleanup-root-link-"));
  const outside = await mkdtemp(join(tmpdir(), "manual-browser-cleanup-root-outside-"));
  const runtimeRoot = join(root, ".runtime");
  const outsideMarker = join(outside, "outside.txt");
  await mkdir(runtimeRoot);
  await writeFile(outsideMarker, "outside", "utf8");
  await symlink(outside, join(runtimeRoot, "browser"), "junction");
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  });

  await assert.rejects(
    cleanupStaleBrowserProfiles(root),
    /unsafe browser profile directory/u,
  );
  assert.equal(await readFile(outsideMarker, "utf8"), "outside");
});
