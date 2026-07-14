import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const studioRoot = join(here, "..", "..");

async function source(relativePath) {
  return readFile(join(studioRoot, relativePath), "utf8");
}

function validProbe(overrides = {}) {
  return {
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        pix_fmt: "yuv420p",
        width: 1920,
        height: 1080,
        avg_frame_rate: "30/1",
        duration: "4.200",
      },
      {
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "48000",
        channels: 2,
        duration: "4.200",
      },
    ],
    format: {
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
      duration: "4.200",
    },
    ...overrides,
  };
}

function validPlan(overrides = {}) {
  return {
    schemaVersion: "1.0",
    video: { width: 1920, height: 1080, fps: 30, durationMs: 4200 },
    captions: [
      { sceneId: "step-1", startMs: 0, endMs: 2000, text: "프로젝트 메뉴를 선택합니다." },
      { sceneId: "step-2", startMs: 2000, endMs: 4200, text: "완료 화면을 확인합니다." },
    ],
    ...overrides,
  };
}

test("bootstrap pins and checks every supported engine with a no-mutation check mode", async () => {
  const script = await source("scripts/bootstrap.ps1");

  assert.match(script, /SupportsShouldProcess/u);
  assert.match(script, /\[switch\]\$Check/u);
  assert.match(script, /22/u);
  assert.match(script, /opencode/iu);
  assert.match(script, /3\.13\.14/u);
  assert.match(script, /supertonic[^\r\n]*1\.3\.1|1\.3\.1[^\r\n]*supertonic/iu);
  assert.match(script, /@playwright\/mcp[^\r\n]*0\.0\.78|0\.0\.78[^\r\n]*@playwright\/mcp/iu);
  assert.match(script, /hyperframes[^\r\n]*0\.7\.57|0\.7\.57[^\r\n]*hyperframes/iu);
  assert.match(script, /ffmpeg/iu);
  assert.match(script, /ffprobe/iu);
  assert.match(script, /Get-VersionOutput\s+-FilePath\s+\$opencodePath/iu);
  assert.match(script, /Get-VersionOutput\s+-FilePath\s+\$ffmpegPath/iu);
  assert.match(script, /Get-VersionOutput\s+-FilePath\s+\$ffprobePath/iu);
  assert.match(script, /npm(?:\.cmd)?[^\r\n]*ci/iu);
  assert.match(script, /SUPERTONIC_CACHE_DIR/u);
  assert.match(script, /data[\\/]cache[\\/]supertonic-3/iu);
});

test("bootstrap treats zero missing Supertonic model files as a ready array result", async () => {
  const script = await source("scripts/bootstrap.ps1");

  assert.match(
    script,
    /\$modelReady\s*=\s*@\(\s*\$requiredModelFiles\s*\|\s*Where-Object[\s\S]*?\)\.Count\s*-eq\s*0/iu,
  );
});

test("bootstrap treats zero failed engine checks as a ready array result", async () => {
  const script = await source("scripts/bootstrap.ps1");

  assert.match(
    script,
    /\$ready\s*=\s*@\(\s*\$checks\.Values\s*\|\s*Where-Object[\s\S]*?\)\.Count\s*-eq\s*0/iu,
  );
});

test("start is the loopback-only entrypoint and never launches the retired backend", async () => {
  const script = await source("scripts/start.ps1");

  assert.match(script, /\[switch\]\$Check/u);
  assert.match(script, /bootstrap\.ps1/iu);
  assert.match(script, /supertonic\.ps1/iu);
  assert.match(script, /Start-Process/iu);
  assert.match(script, /WindowStyle[^\r\n]*Hidden/iu);
  assert.match(script, /SupertonicExecutable/iu);
  assert.match(script, /Start-Process[^\r\n]*-FilePath\s+\$SupertonicExecutable/iu);
  assert.match(script, /127\.0\.0\.1/u);
  assert.match(script, /MANUAL_STUDIO_PORT/u);
  assert.match(script, /node(?:\.exe)?[^\r\n]*src[\\/]index\.js/iu);
  assert.doesNotMatch(script, /(?:backend[\\/]|uvicorn|fastapi|main\.py)/iu);
});

test("artifact evidence rejects silence, placeholders, wrong codecs, and missing captions", async () => {
  const { validateArtifactEvidence } = await import("../../scripts/verify.mjs");
  const analysis = { meanVolumeDb: -20, maxVolumeDb: -1, frozenMs: 0, blackMs: 0 };

  const accepted = validateArtifactEvidence({
    probe: validProbe(),
    analysis,
    mediaPlan: validPlan(),
  });
  assert.equal(accepted.durationMs, 4200);
  assert.equal(accepted.captionCount, 2);

  assert.throws(
    () => validateArtifactEvidence({
      probe: validProbe(),
      analysis: { ...analysis, maxVolumeDb: -91 },
      mediaPlan: validPlan(),
    }),
    { code: "VERIFY_SILENT_AUDIO" },
  );
  assert.throws(
    () => validateArtifactEvidence({
      probe: validProbe(),
      analysis: { ...analysis, frozenMs: 4_000 },
      mediaPlan: validPlan(),
    }),
    { code: "VERIFY_PLACEHOLDER_VIDEO" },
  );
  assert.throws(
    () => validateArtifactEvidence({
      probe: validProbe({
        streams: [
          { ...validProbe().streams[0], codec_name: "vp9" },
          validProbe().streams[1],
        ],
      }),
      analysis,
      mediaPlan: validPlan(),
    }),
    { code: "VERIFY_MEDIA_QUALITY" },
  );
  assert.throws(
    () => validateArtifactEvidence({
      probe: validProbe(),
      analysis,
      mediaPlan: validPlan({ captions: [] }),
    }),
    { code: "VERIFY_MISSING_CAPTIONS" },
  );
});

test("FFmpeg diagnostics are parsed without echoing arbitrary process output", async () => {
  const { parseFfmpegAnalysis } = await import("../../scripts/verify.mjs");
  const parsed = parseFfmpegAnalysis(`
    [Parsed_volumedetect_0] mean_volume: -18.4 dB
    [Parsed_volumedetect_0] max_volume: -0.8 dB
    [freezedetect] lavfi.freezedetect.freeze_duration: 0.800
    [blackdetect] black_start:1 black_end:1.2 black_duration:0.200
  `);

  assert.deepEqual(parsed, {
    meanVolumeDb: -18.4,
    maxVolumeDb: -0.8,
    frozenMs: 800,
    blackMs: 200,
  });
});

test("live smoke has an explicit opt-in gate and parses persisted SSE events", async () => {
  const script = await source("scripts/smoke-live.mjs");
  assert.match(script, /MANUAL_STUDIO_LIVE_SMOKE/u);
  assert.match(script, /\/api\/health/u);
  assert.match(script, /\/api\/jobs/u);
  assert.match(script, /plan\/approve/u);
  assert.match(script, /\/execute/u);
  assert.match(script, /preview\/approve/u);
  assert.match(script, /RENDER_COMPLETED|completed/u);

  const { parseSseFrames } = await import("../../scripts/smoke-live.mjs");
  const parsed = parseSseFrames(
    'id: 4\nevent: PLAN_READY\ndata: {"sequence":4,"event":"PLAN_READY","state":"plan_review","data":{"planDigest":"' +
      "a".repeat(64) +
      '"}}\n\n: heartbeat\n\n',
  );
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].event, "PLAN_READY");
  assert.equal(parsed.events[0].data.planDigest, "a".repeat(64));
  assert.equal(parsed.rest, "");
});

test("README documents the one supported start path, privacy, disclosures, and five engines", async () => {
  const readme = await source("README.md");

  assert.match(readme, /scripts[\\/]start\.ps1/iu);
  assert.doesNotMatch(readme, /npm\s+(?:run\s+)?start/iu);
  assert.match(readme, /수동 로그인/u);
  assert.match(readme, /자동 로그인/u);
  assert.match(readme, /DPAPI/u);
  assert.match(readme, /data[\\/]cache[\\/]supertonic-3/iu);
  assert.match(readme, /첫 실행[^\r\n]*다운로드/iu);
  assert.match(readme, /재시도/u);
  assert.match(readme, /AI[^\r\n]*(?:생성|합성)|(?:생성|합성)[^\r\n]*AI/iu);
  assert.match(readme, /OpenRAIL-M/u);
  for (const engine of ["OpenCode", "Supertonic", "HyperFrames", "Playwright MCP", "FFmpeg"]) {
    assert.match(readme, new RegExp(engine, "iu"));
  }
  assert.doesNotMatch(readme, /(?:password|secret|token)\s*[=:]\s*[^<\s$]+/iu);
});
