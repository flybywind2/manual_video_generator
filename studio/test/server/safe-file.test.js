import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openVerifiedRegular } from "../../src/server/router.js";

test("verified file opening rejects a directory swapped to an outside junction", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "manual-studio-safe-open-"));
  const root = join(temporary, "root");
  const safeDirectory = join(root, "media");
  const movedDirectory = join(root, "media-original");
  const outside = join(temporary, "outside");
  const target = join(safeDirectory, "video.mp4");
  await mkdir(safeDirectory, { recursive: true });
  await mkdir(outside);
  await writeFile(target, "approved-content", "utf8");
  await writeFile(join(outside, "video.mp4"), "outside-secret", "utf8");
  t.after(async () => rm(temporary, { force: true, recursive: true }));

  await assert.rejects(
    openVerifiedRegular(root, target, "ARTIFACT_NOT_FOUND", {
      afterInspect: async () => {
        await rename(safeDirectory, movedDirectory);
        await symlink(outside, safeDirectory, "junction");
      },
    }),
    (error) => error?.code === "ARTIFACT_NOT_FOUND",
  );
});
