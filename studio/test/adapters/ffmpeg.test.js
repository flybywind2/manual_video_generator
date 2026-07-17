import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  FfmpegAdapter,
  buildNormalizeArgs,
} from "../../src/adapters/ffmpeg.js";

const execFileAsync = promisify(execFile);

async function temporaryJob(t) {
  const root = await mkdtemp(join(tmpdir(), "manual-studio-ffmpeg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "recording"), { recursive: true });
  await mkdir(join(root, "media"), { recursive: true });
  return root;
}

async function locate(command) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  try {
    const { stdout } = await execFileAsync(locator, [command], {
      encoding: "utf8",
      windowsHide: true,
    });
    return stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

test("normalization argv fixes the browser recording contract without shell quoting", () => {
  const jobRoot = process.platform === "win32" ? "C:\\jobs\\job-a" : "/jobs/job-a";
  const inputPath = join(jobRoot, "recording", "raw browser capture.webm");
  const outputPath = join(jobRoot, "media", "normalized browser.mp4");

  const args = buildNormalizeArgs({ jobRoot, inputPath, outputPath });

  assert.equal(Array.isArray(args), true);
  assert.equal(Object.isFrozen(args), true);
  assert.equal(args.at(-1), outputPath);
  assert.equal(args[args.indexOf("-i") + 1], inputPath);
  assert.equal(args.includes(`"${inputPath}"`), false);
  assert.equal(args.includes(`'${inputPath}'`), false);
  assert.equal(args.includes("-vf"), true);
  const filter = args[args.indexOf("-vf") + 1];
  assert.match(filter, /scale=1920:1080:force_original_aspect_ratio=decrease/u);
  assert.match(filter, /pad=1920:1080:\(ow-iw\)\/2:\(oh-ih\)\/2/u);
  assert.match(filter, /fps=30/u);
  assert.deepEqual(
    [
      args[args.indexOf("-fps_mode") + 1],
      args[args.indexOf("-c:v") + 1],
      args[args.indexOf("-crf") + 1],
      args[args.indexOf("-g") + 1],
      args[args.indexOf("-keyint_min") + 1],
      args[args.indexOf("-pix_fmt") + 1],
      args[args.indexOf("-movflags") + 1],
    ],
    ["cfr", "libx264", "18", "30", "30", "yuv420p", "+faststart"],
  );
  assert.equal(args.includes("-an"), true);
  assert.equal(args[args.indexOf("-threads") + 1], "2");
});

test("normalization refuses input or output outside the job root", () => {
  const jobRoot = process.platform === "win32" ? "C:\\jobs\\job-a" : "/jobs/job-a";
  const inside = join(jobRoot, "recording", "raw.webm");
  const outside = process.platform === "win32" ? "C:\\jobs\\other\\escape.mp4" : "/jobs/other/escape.mp4";

  assert.throws(
    () => buildNormalizeArgs({ jobRoot, inputPath: outside, outputPath: join(jobRoot, "media", "out.mp4") }),
    { code: "UNSAFE_MEDIA_PATH" },
  );
  assert.throws(
    () => buildNormalizeArgs({ jobRoot, inputPath: inside, outputPath: outside }),
    { code: "UNSAFE_MEDIA_PATH" },
  );
});

test("actual testsrc2 WebM normalizes to a probeable 1920x1080 30 fps H.264 MP4", async (t) => {
  const [ffmpeg, ffprobe] = await Promise.all([locate("ffmpeg"), locate("ffprobe")]);
  if (!ffmpeg || !ffprobe) {
    t.skip("local FFmpeg and FFprobe are not installed");
    return;
  }

  const jobRoot = await temporaryJob(t);
  const inputPath = join(jobRoot, "recording", "raw.webm");
  const outputPath = join(jobRoot, "media", "normalized.mp4");
  await execFileAsync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=12",
      "-t",
      "0.4",
      "-c:v",
      "libvpx-vp9",
      "-y",
      inputPath,
    ],
    { windowsHide: true },
  );

  const adapter = new FfmpegAdapter({ executable: ffmpeg, probeExecutable: ffprobe });
  const result = await adapter.normalizeRecording({ jobRoot, inputPath, outputPath });
  const metadata = JSON.parse(
    (await execFileAsync(
      ffprobe,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,avg_frame_rate,pix_fmt", "-of", "json", outputPath],
      { encoding: "utf8", windowsHide: true },
    )).stdout,
  );

  assert.equal(result.outputPath, outputPath);
  assert.equal((await stat(outputPath)).size > 0, true);
  assert.deepEqual(metadata.streams, [
    {
      codec_name: "h264",
      width: 1920,
      height: 1080,
      pix_fmt: "yuv420p",
      avg_frame_rate: "30/1",
    },
  ]);
  assert.equal((await readFile(outputPath)).subarray(4, 8).toString("ascii"), "ftyp");
});

test("runtime containment rejects a symlinked output directory", async (t) => {
  const ffmpeg = await locate("ffmpeg");
  if (!ffmpeg) {
    t.skip("local FFmpeg is not installed");
    return;
  }
  const jobRoot = await temporaryJob(t);
  const outside = await mkdtemp(join(tmpdir(), "manual-studio-ffmpeg-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const linked = join(jobRoot, "linked-media");
  try {
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
      t.skip("directory links are unavailable");
      return;
    }
    throw error;
  }
  const inputPath = join(jobRoot, "recording", "raw.webm");
  await execFileAsync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=16x16:rate=1", "-t", "0.1", "-c:v", "libvpx-vp9", "-y", inputPath], { windowsHide: true });
  const adapter = new FfmpegAdapter({ executable: ffmpeg, probeExecutable: ffmpeg });

  await assert.rejects(
    adapter.normalizeRecording({
      jobRoot,
      inputPath,
      outputPath: join(linked, "escape.mp4"),
    }),
    { code: "UNSAFE_MEDIA_PATH" },
  );
  await assert.rejects(stat(join(outside, "escape.mp4")), { code: "ENOENT" });
});

test("normalization rejects a hard-linked final output before invoking FFmpeg", async (t) => {
  const jobRoot = await temporaryJob(t);
  const outsideRoot = await mkdtemp(join(tmpdir(), "manual-studio-ffmpeg-hardlink-"));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));
  const inputPath = join(jobRoot, "recording", "raw.webm");
  const outputPath = join(jobRoot, "media", "normalized.mp4");
  const outsidePath = join(outsideRoot, "outside.mp4");
  await writeFile(inputPath, "webm");
  await writeFile(outsidePath, "outside-original");
  await link(outsidePath, outputPath);
  let invoked = false;
  const executable = process.platform === "win32" ? "C:\\tools\\ffmpeg.exe" : "/tools/ffmpeg";
  const adapter = new FfmpegAdapter({
    executable,
    probeExecutable: executable,
    run: async () => {
      invoked = true;
      return { exitCode: 0, signal: null, stdout: "", stderr: "", lines: [] };
    },
  });

  await assert.rejects(
    adapter.normalizeRecording({ jobRoot, inputPath, outputPath }),
    { code: "UNSAFE_MEDIA_PATH" },
  );
  assert.equal(invoked, false);
  assert.equal(await readFile(outsidePath, "utf8"), "outside-original");
});

test("normalization stages engine output and rejects a swapped final parent before publish", async (t) => {
  const jobRoot = await temporaryJob(t);
  const outside = await mkdtemp(join(tmpdir(), "manual-studio-ffmpeg-parent-swap-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const inputPath = join(jobRoot, "recording", "raw.webm");
  const outputPath = join(jobRoot, "media", "normalized.mp4");
  await writeFile(inputPath, "webm");
  let engineOutput;
  const executable = process.platform === "win32" ? "C:\\tools\\ffmpeg.exe" : "/tools/ffmpeg";
  const adapter = new FfmpegAdapter({
    executable,
    probeExecutable: executable,
    run: async ({ args }) => {
      engineOutput = args.at(-1);
      await rm(join(jobRoot, "media"), { recursive: true });
      await symlink(outside, join(jobRoot, "media"), process.platform === "win32" ? "junction" : "dir");
      await writeFile(engineOutput, "staged-mp4");
      return { exitCode: 0, signal: null, stdout: "", stderr: "", lines: [] };
    },
  });

  await assert.rejects(
    adapter.normalizeRecording({ jobRoot, inputPath, outputPath }),
    { code: "UNSAFE_MEDIA_PATH" },
  );
  assert.notEqual(engineOutput, outputPath);
  await assert.rejects(stat(join(outside, "normalized.mp4")), { code: "ENOENT" });
});

test("normalization rechecks that the produced file was not replaced by a link", async (t) => {
  const jobRoot = await temporaryJob(t);
  const outsideRoot = await mkdtemp(join(tmpdir(), "manual-studio-ffmpeg-output-link-"));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));
  const inputPath = join(jobRoot, "recording", "raw.webm");
  const outputPath = join(jobRoot, "media", "normalized.mp4");
  const outsidePath = join(outsideRoot, "outside.mp4");
  const probeLink = join(jobRoot, "media", "probe-link.mp4");
  await Promise.all([
    writeFile(inputPath, "webm", "utf8"),
    writeFile(outsidePath, "outside-media", "utf8"),
  ]);
  try {
    await symlink(outsidePath, probeLink, "file");
    await unlink(probeLink);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
      t.skip("file links are unavailable");
      return;
    }
    throw error;
  }
  const executable = process.platform === "win32" ? "C:\\tools\\ffmpeg.exe" : "/tools/ffmpeg";
  const adapter = new FfmpegAdapter({
    executable,
    probeExecutable: executable,
    run: async () => {
      await symlink(outsidePath, outputPath, "file");
      return { exitCode: 0, signal: null, stdout: "", stderr: "", lines: [] };
    },
  });

  await assert.rejects(
    adapter.normalizeRecording({ jobRoot, inputPath, outputPath }),
    { code: "UNSAFE_MEDIA_PATH" },
  );
});
