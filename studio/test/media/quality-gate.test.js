import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  QualityGate,
  buildProbeArgs,
  validateFinalMedia,
} from "../../src/media/quality-gate.js";

const execFileAsync = promisify(execFile);

function validProbe(overrides = {}) {
  return {
    streams: [
      {
        index: 0,
        codec_name: "h264",
        codec_type: "video",
        width: 1920,
        height: 1080,
        pix_fmt: "yuv420p",
        avg_frame_rate: "30/1",
        duration: "4.200000",
      },
      {
        index: 1,
        codec_name: "aac",
        codec_type: "audio",
        sample_rate: "44100",
        channels: 1,
        duration: "4.200000",
      },
    ],
    format: {
      duration: "4.200000",
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    },
    ...overrides,
  };
}

async function locate(command) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  try {
    const { stdout } = await execFileAsync(locator, [command], { encoding: "utf8", windowsHide: true });
    return stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

test("probe argv is shell-free and validates the in-job file", () => {
  const jobRoot = process.platform === "win32" ? "C:\\jobs\\job-a" : "/jobs/job-a";
  const filePath = join(jobRoot, "renders", "final manual.mp4");
  const args = buildProbeArgs({ jobRoot, filePath });

  assert.deepEqual(args, [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    filePath,
  ]);
  assert.equal(args.includes(`"${filePath}"`), false);
  assert.throws(
    () => buildProbeArgs({ jobRoot, filePath: join(jobRoot, "..", "escape.mp4") }),
    { code: "UNSAFE_MEDIA_PATH" },
  );
});

test("quality gate accepts only H.264 AAC 1920x1080 30 fps within duration tolerance", () => {
  const result = validateFinalMedia(validProbe(), { expectedDurationMs: 4_200 });
  assert.deepEqual(result, {
    videoCodec: "h264",
    audioCodec: "aac",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 4_200,
    durationDriftMs: 0,
  });

  const invalidReports = [
    validProbe({ streams: [
      { ...validProbe().streams[0], codec_name: "hevc" },
      validProbe().streams[1],
    ] }),
    validProbe({ streams: [validProbe().streams[0]] }),
    validProbe({ streams: [
      { ...validProbe().streams[0], width: 1280 },
      validProbe().streams[1],
    ] }),
    validProbe({ streams: [
      { ...validProbe().streams[0], avg_frame_rate: "30000/1001" },
      validProbe().streams[1],
    ] }),
    validProbe({ format: { ...validProbe().format, duration: "5.000000" } }),
  ];
  for (const report of invalidReports) {
    assert.throws(
      () => validateFinalMedia(report, { expectedDurationMs: 4_200 }),
      { code: "MEDIA_QUALITY_FAILED" },
    );
  }
});

test("malformed or ambiguous FFprobe JSON fails closed", () => {
  for (const report of [null, {}, { streams: [], format: {} }, { ...validProbe(), streams: [...validProbe().streams, validProbe().streams[0]] }]) {
    assert.throws(
      () => validateFinalMedia(report, { expectedDurationMs: 4_200 }),
      { code: "MEDIA_QUALITY_FAILED" },
    );
  }
  assert.throws(
    () => validateFinalMedia(validProbe(), { expectedDurationMs: Number.NaN }),
    { code: "MEDIA_QUALITY_FAILED" },
  );
});

test("forged container, pixel, and audio contracts cannot pass the final gate", () => {
  const invalidReports = [
    validProbe({
      format: { ...validProbe().format, format_name: "matroska,webm" },
    }),
    validProbe({
      streams: [
        { ...validProbe().streams[0], pix_fmt: "yuv444p" },
        validProbe().streams[1],
      ],
    }),
    validProbe({
      streams: [
        validProbe().streams[0],
        { ...validProbe().streams[1], sample_rate: "8000" },
      ],
    }),
    validProbe({
      streams: [
        validProbe().streams[0],
        { ...validProbe().streams[1], channels: 0 },
      ],
    }),
  ];

  for (const report of invalidReports) {
    assert.throws(
      () => validateFinalMedia(report, { expectedDurationMs: 4_200 }),
      { code: "MEDIA_QUALITY_FAILED" },
    );
  }
});

test("container duration cannot hide a short video or audio stream", () => {
  for (const streamIndex of [0, 1]) {
    const report = validProbe();
    report.streams[streamIndex] = {
      ...report.streams[streamIndex],
      duration: "0.100000",
    };
    assert.throws(
      () => validateFinalMedia(report, { expectedDurationMs: 4_200 }),
      { code: "MEDIA_QUALITY_FAILED" },
    );
  }
});

test("actual FFprobe gate accepts a small local H.264/AAC golden file", async (t) => {
  const [ffmpeg, ffprobe] = await Promise.all([locate("ffmpeg"), locate("ffprobe")]);
  if (!ffmpeg || !ffprobe) {
    t.skip("local FFmpeg and FFprobe are not installed");
    return;
  }
  const jobRoot = await mkdtemp(join(tmpdir(), "manual-studio-quality-"));
  t.after(() => rm(jobRoot, { recursive: true, force: true }));
  const filePath = join(jobRoot, "renders", "golden.mp4");
  await mkdir(dirname(filePath), { recursive: true });
  await execFileAsync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#302b63:size=1920x1080:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100",
      "-t",
      "0.4",
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-movflags",
      "+faststart",
      "-y",
      filePath,
    ],
    { windowsHide: true },
  );

  const gate = new QualityGate({ ffprobeExecutable: ffprobe });
  const result = await gate.probe({
    jobRoot,
    filePath,
    expectedDurationMs: 400,
    toleranceMs: 100,
  });

  assert.equal(result.videoCodec, "h264");
  assert.equal(result.audioCodec, "aac");
  assert.equal(result.width, 1920);
  assert.equal(result.height, 1080);
  assert.equal(result.fps, 30);
  assert.equal(result.durationDriftMs <= 100, true);
});

test("probe process failure and invalid JSON never pass the gate", async (t) => {
  const jobRoot = await mkdtemp(join(tmpdir(), "manual-studio-quality-failure-"));
  t.after(() => rm(jobRoot, { recursive: true, force: true }));
  const filePath = join(jobRoot, "renders", "final.mp4");
  await mkdir(dirname(filePath), { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, "mp4", "utf8");

  const nonzero = new QualityGate({
    ffprobeExecutable: process.platform === "win32" ? "C:\\tools\\ffprobe.exe" : "/tools/ffprobe",
    run: async () => ({ exitCode: 1, signal: null, stdout: "", stderr: "bad", lines: [] }),
  });
  await assert.rejects(
    nonzero.probe({ jobRoot, filePath, expectedDurationMs: 1_000 }),
    { code: "FFPROBE_FAILED" },
  );

  const malformed = new QualityGate({
    ffprobeExecutable: process.platform === "win32" ? "C:\\tools\\ffprobe.exe" : "/tools/ffprobe",
    run: async () => ({ exitCode: 0, signal: null, stdout: "not-json", stderr: "", lines: [] }),
  });
  await assert.rejects(
    malformed.probe({ jobRoot, filePath, expectedDurationMs: 1_000 }),
    { code: "FFPROBE_INVALID_OUTPUT" },
  );
});
