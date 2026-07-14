import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  HYPERFRAMES_VERSION,
  HyperframesAdapter,
} from "../../src/adapters/hyperframes.js";
import { createMediaPlan } from "../../src/media/media-plan.js";
import { writeComposition } from "../../src/media/composition.js";
import { QualityGate } from "../../src/media/quality-gate.js";
import { runProcess } from "../../src/process/process-runner.js";

const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);

async function jobProject(t) {
  const jobRoot = await mkdtemp(join(tmpdir(), "manual-studio-hyperframes-"));
  t.after(() => rm(jobRoot, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  }));
  const projectPath = join(jobRoot, "composition");
  const renderPath = join(jobRoot, "renders", "final.mp4");
  await mkdir(projectPath, { recursive: true });
  await mkdir(dirname(renderPath), { recursive: true });
  await writeFile(join(projectPath, "index.html"), '<main data-composition-id="test" data-width="1920" data-height="1080"></main>', "utf8");
  return { jobRoot, projectPath, renderPath };
}

function successfulRun(calls, { createRender = false } = {}) {
  return async (options) => {
    calls.push(options);
    if (createRender && options.args.includes("render")) {
      const outputIndex = options.args.indexOf("--output");
      await writeFile(options.args[outputIndex + 1], "mp4", "utf8");
    }
    return {
      exitCode: 0,
      signal: null,
      stdout: options.args.includes("check")
        ? JSON.stringify({
            ok: true,
            strict: true,
            lint: { errorCount: 0, warningCount: 0, findings: [] },
            runtime: { errorCount: 0, warningCount: 0, findings: [] },
            layout: { errorCount: 0, warningCount: 0, findings: [] },
            motion: { errorCount: 0, warningCount: 0, findings: [] },
            contrast: { errorCount: 0, warningCount: 0, findings: [] },
          })
        : options.args.includes("lint")
          ? JSON.stringify({ ok: true, errorCount: 0, warningCount: 0, findings: [] })
          : "",
      stderr: "",
      lines: [],
    };
  };
}

test("adapter verifies the exact installed HyperFrames version and CLI entry", async () => {
  assert.equal(HYPERFRAMES_VERSION, "0.7.57");
  const adapter = new HyperframesAdapter({ studioRoot, run: async () => assert.fail("must not run") });
  const installation = await adapter.verifyInstallation();

  assert.equal(installation.version, "0.7.57");
  assert.equal(installation.nodeExecutable, process.execPath);
  assert.equal(installation.cliPath, join(studioRoot, "node_modules", "hyperframes", "dist", "cli.js"));
});

test("version mismatch fails before any HyperFrames command can execute", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "manual-studio-hyperframes-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "node_modules", "hyperframes");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version: "0.7.58", bin: { hyperframes: "./dist/cli.js" } }), "utf8");
  await writeFile(join(packageRoot, "dist", "cli.js"), "", "utf8");
  let invoked = false;
  const adapter = new HyperframesAdapter({
    studioRoot: root,
    run: async () => {
      invoked = true;
      return { exitCode: 0, signal: null, stdout: "", stderr: "", lines: [] };
    },
  });

  await assert.rejects(adapter.verifyInstallation(), { code: "HYPERFRAMES_VERSION_MISMATCH" });
  assert.equal(invoked, false);
});

test("lint, strict check, and background preview use fixed argv and skip skill installation", async (t) => {
  const { jobRoot, projectPath } = await jobProject(t);
  const calls = [];
  const adapter = new HyperframesAdapter({
    studioRoot,
    run: successfulRun(calls),
    environment: {
      PATH: process.env.PATH ?? "",
      SECRET_TOKEN: "must-not-propagate",
    },
  });

  await adapter.lint({ jobRoot, projectPath });
  await adapter.check({ jobRoot, projectPath });
  const preview = await adapter.preview({ jobRoot, projectPath, port: 4765 });

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.command, process.execPath);
    assert.equal(call.cwd, projectPath);
    assert.equal(call.env.HYPERFRAMES_SKIP_SKILLS, "1");
    assert.equal(Object.hasOwn(call.env, "SECRET_TOKEN"), false);
    assert.equal(call.args[0], join(studioRoot, "node_modules", "hyperframes", "dist", "cli.js"));
  }
  assert.deepEqual(calls[0].args.slice(1), ["lint", projectPath, "--json"]);
  assert.deepEqual(calls[1].args.slice(1), [
    "check",
    projectPath,
    "--json",
    "--strict",
    "--at-transitions",
    "--max-transition-samples",
    "200",
    "--frame-check",
    "severity=error;seek=.25,.5,.75;tol=2",
  ]);
  assert.deepEqual(calls[2].args.slice(1), [
    "preview",
    projectPath,
    "--port",
    "4765",
    "--background",
    "--no-open",
    "--force-new",
  ]);
  assert.deepEqual(preview, { url: "http://127.0.0.1:4765", port: 4765 });
});

test("render uses fail-closed strict flags and publishes only an existing in-job MP4", async (t) => {
  const { jobRoot, projectPath, renderPath } = await jobProject(t);
  const calls = [];
  const adapter = new HyperframesAdapter({
    studioRoot,
    run: successfulRun(calls, { createRender: true }),
  });

  const result = await adapter.render({ jobRoot, projectPath, outputPath: renderPath });

  assert.equal(result.outputPath, renderPath);
  assert.equal(result.bytes, 3);
  const engineOutput = calls[0].args[calls[0].args.indexOf("--output") + 1];
  assert.notEqual(engineOutput, renderPath);
  assert.match(engineOutput, /[\\/]\.hyperframes-stage-[^\\/]+[\\/]render\.mp4$/u);
  assert.deepEqual(calls[0].args.slice(1), [
    "render",
    projectPath,
    "--composition",
    "index.html",
    "--output",
    engineOutput,
    "--format",
    "mp4",
    "--fps",
    "30",
    "--quality",
    "high",
    "--crf",
    "18",
    "--video-frame-format",
    "png",
    "--workers",
    "1",
    "--no-best-effort",
    "--strict-all",
    "--strict-variables",
    "--resolution",
    "landscape",
    "--no-page-side-compositing",
  ]);

  const missingOutput = new HyperframesAdapter({ studioRoot, run: successfulRun([]) });
  await assert.rejects(
    missingOutput.render({ jobRoot, projectPath, outputPath: join(jobRoot, "renders", "missing.mp4") }),
    { code: "HYPERFRAMES_OUTPUT_MISSING" },
  );
});

test("render rejects a hard-linked final output before HyperFrames runs", async (t) => {
  const { jobRoot, projectPath, renderPath } = await jobProject(t);
  const outside = await mkdtemp(join(tmpdir(), "manual-studio-hyperframes-hardlink-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsidePath = join(outside, "outside.mp4");
  await writeFile(outsidePath, "outside-original");
  await link(outsidePath, renderPath);
  let invoked = false;
  const adapter = new HyperframesAdapter({
    studioRoot,
    run: async () => {
      invoked = true;
      return { exitCode: 0, signal: null, stdout: "", stderr: "", lines: [] };
    },
  });

  await assert.rejects(
    adapter.render({ jobRoot, projectPath, outputPath: renderPath }),
    { code: "UNSAFE_MEDIA_PATH" },
  );
  assert.equal(invoked, false);
  assert.equal(await readFile(outsidePath, "utf8"), "outside-original");
});

test("render stages engine output and rejects a swapped final parent before publish", async (t) => {
  const { jobRoot, projectPath, renderPath } = await jobProject(t);
  const outside = await mkdtemp(join(tmpdir(), "manual-studio-hyperframes-parent-swap-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  let engineOutput;
  const adapter = new HyperframesAdapter({
    studioRoot,
    run: async (options) => {
      if (options.args.includes("render")) {
        engineOutput = options.args[options.args.indexOf("--output") + 1];
        await rm(dirname(renderPath), { recursive: true });
        await symlink(
          outside,
          dirname(renderPath),
          process.platform === "win32" ? "junction" : "dir",
        );
        await writeFile(engineOutput, "staged-mp4");
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "", lines: [] };
    },
  });

  await assert.rejects(
    adapter.render({ jobRoot, projectPath, outputPath: renderPath }),
    { code: "UNSAFE_MEDIA_PATH" },
  );
  assert.notEqual(engineOutput, renderPath);
  await assert.rejects(stat(join(outside, "final.mp4")), { code: "ENOENT" });
});

test("project and render paths cannot escape the job or traverse a directory link", async (t) => {
  const { jobRoot, projectPath } = await jobProject(t);
  const adapter = new HyperframesAdapter({ studioRoot, run: successfulRun([]) });

  await assert.rejects(
    adapter.lint({ jobRoot, projectPath: join(jobRoot, "..", "outside") }),
    { code: "UNSAFE_MEDIA_PATH" },
  );
  await assert.rejects(
    adapter.render({ jobRoot, projectPath, outputPath: join(jobRoot, "..", "outside.mp4") }),
    { code: "UNSAFE_MEDIA_PATH" },
  );

  const outside = await mkdtemp(join(tmpdir(), "manual-studio-hyperframes-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const linked = join(jobRoot, "linked-project");
  try {
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
      return;
    }
    throw error;
  }
  await assert.rejects(adapter.lint({ jobRoot, projectPath: linked }), { code: "UNSAFE_MEDIA_PATH" });
});

test("nonzero lint/check/render exits are fail-closed", async (t) => {
  const { jobRoot, projectPath, renderPath } = await jobProject(t);
  const adapter = new HyperframesAdapter({
    studioRoot,
    run: async () => ({ exitCode: 2, signal: null, stdout: "", stderr: "failed", lines: [] }),
  });

  await assert.rejects(adapter.lint({ jobRoot, projectPath }), { code: "HYPERFRAMES_COMMAND_FAILED" });
  await assert.rejects(adapter.check({ jobRoot, projectPath }), { code: "HYPERFRAMES_COMMAND_FAILED" });
  await assert.rejects(adapter.render({ jobRoot, projectPath, outputPath: renderPath }), { code: "HYPERFRAMES_COMMAND_FAILED" });
});

test("check rejects nested warnings even when HyperFrames reports top-level ok", async (t) => {
  const { jobRoot, projectPath } = await jobProject(t);
  const adapter = new HyperframesAdapter({
    studioRoot,
    run: async () => ({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({
        ok: true,
        strict: true,
        lint: { errorCount: 0, warningCount: 0, findings: [] },
        runtime: { errorCount: 0, warningCount: 1, findings: [{ code: "warning" }] },
        layout: { errorCount: 0, warningCount: 0, findings: [] },
        motion: { errorCount: 0, warningCount: 0, findings: [] },
        contrast: { errorCount: 0, warningCount: 0, findings: [] },
      }),
      stderr: "",
      lines: [],
    }),
  });

  await assert.rejects(
    adapter.check({ jobRoot, projectPath }),
    { code: "HYPERFRAMES_VALIDATION_FAILED" },
  );
});

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

async function availablePort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const port = server.address().port;
  await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  return port;
}

test("live golden composition passes lint, check, preview, strict render, and FFprobe", async (t) => {
  if (process.env.MANUAL_STUDIO_LIVE_HYPERFRAMES !== "1") {
    t.skip("set MANUAL_STUDIO_LIVE_HYPERFRAMES=1 for the local golden render");
    return;
  }
  const [ffmpeg, ffprobe] = await Promise.all([locate("ffmpeg"), locate("ffprobe")]);
  if (!ffmpeg || !ffprobe) {
    t.skip("local FFmpeg and FFprobe are not installed");
    return;
  }
  const jobRoot = await mkdtemp(join(tmpdir(), "manual-studio-hyperframes-live-"));
  t.after(() => rm(jobRoot, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  }));
  const projectPath = join(jobRoot, "composition");
  const recordingPath = join(projectPath, "media", "normalized.mp4");
  const narrationPath = join(projectPath, "narration", "step-1.wav");
  const outputPath = join(jobRoot, "renders", "final.mp4");
  await Promise.all([
    mkdir(projectPath, { recursive: true }),
    mkdir(dirname(recordingPath), { recursive: true }),
    mkdir(dirname(narrationPath), { recursive: true }),
    mkdir(dirname(outputPath), { recursive: true }),
  ]);
  await Promise.all([
    execFileAsync(
      ffmpeg,
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=#302b63:size=1920x1080:rate=30",
        "-t", "0.6", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
        "-an", "-movflags", "+faststart", "-y", recordingPath,
      ],
      { windowsHide: true },
    ),
    execFileAsync(
      ffmpeg,
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
        "-t", "0.6", "-ac", "1", "-c:a", "pcm_s16le", "-y", narrationPath,
      ],
      { windowsHide: true },
    ),
  ]);
  const mediaPlan = createMediaPlan({
    recordingPath: "composition/media/normalized.mp4",
    scenes: [
      {
        id: "step-1",
        sourceStartMs: 0,
        sourceEndMs: 600,
        caption: "설정 메뉴를 선택합니다.",
        chapter: "설정 열기",
        highlight: { x: 120, y: 160, width: 320, height: 72 },
      },
    ],
    narrations: [
      {
        sceneId: "step-1",
        path: "composition/narration/step-1.wav",
        durationMs: 600,
        text: "설정 메뉴를 선택합니다.",
      },
    ],
  });
  await writeComposition({
    jobRoot,
    templatePath: join(studioRoot, "templates", "hyperframes", "index.html"),
    outputPath: join(projectPath, "index.html"),
    mediaPlan,
  });

  const commandResults = [];
  const adapter = new HyperframesAdapter({
    studioRoot,
    run: async (options) => {
      const result = await runProcess(options);
      commandResults.push({
        command: options.args[1],
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 8_000),
        stderr: result.stderr.slice(0, 8_000),
      });
      return result;
    },
  });
  const port = await availablePort();
  let previewStarted = false;
  try {
    try {
      await adapter.lint({ jobRoot, projectPath });
      await adapter.check({ jobRoot, projectPath });
      await adapter.preview({ jobRoot, projectPath, port });
      previewStarted = true;
      await adapter.render({ jobRoot, projectPath, outputPath });
    } catch (error) {
      t.diagnostic(JSON.stringify(commandResults));
      throw error;
    }
  } finally {
    if (previewStarted) {
      await adapter.stopPreview({ jobRoot, projectPath });
    }
  }
  const quality = await new QualityGate({ ffprobeExecutable: ffprobe }).probe({
    jobRoot,
    filePath: outputPath,
    expectedDurationMs: mediaPlan.video.durationMs,
  });
  assert.equal(quality.videoCodec, "h264");
  assert.equal(quality.audioCodec, "aac");
  assert.equal(quality.durationDriftMs <= 500, true);
});
