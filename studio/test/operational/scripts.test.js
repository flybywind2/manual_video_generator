import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
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
  assert.match(script, /ExpectedOpenCode\s*=\s*"1\.4\.1"/iu);
  assert.match(script, /3\.13\.14/u);
  assert.match(script, /supertonic[^\r\n]*1\.3\.1|1\.3\.1[^\r\n]*supertonic/iu);
  assert.match(script, /@playwright\/mcp[^\r\n]*0\.0\.78|0\.0\.78[^\r\n]*@playwright\/mcp/iu);
  assert.match(script, /hyperframes[^\r\n]*0\.7\.57|0\.7\.57[^\r\n]*hyperframes/iu);
  assert.match(script, /ExpectedFFmpeg\s*=\s*"8\.1\.1"/iu);
  assert.match(script, /Install-WingetPackage\s+-Id\s+"Gyan\.FFmpeg"\s+-Version\s+\$ExpectedFFmpeg/iu);
  assert.match(script, /Get-VersionOutput\s+-FilePath\s+\$opencodePath/iu);
  assert.match(script, /Get-VersionOutput\s+-FilePath\s+\$ffmpegPath/iu);
  assert.match(script, /Get-VersionOutput\s+-FilePath\s+\$ffprobePath/iu);
  assert.match(script, /opencode-ai@1\.4\.1/iu);
  assert.match(script, /\$opencodeVersion\s+-eq\s+\$ExpectedOpenCode/iu);
  assert.match(script, /\$ffmpegVersion\s+-eq\s+\$ExpectedFFmpeg/iu);
  assert.match(script, /\$ffprobeVersion\s+-eq\s+\$ExpectedFFmpeg/iu);
  assert.match(script, /npm(?:\.cmd)?[^\r\n]*ci/iu);
  assert.match(script, /SUPERTONIC_CACHE_DIR/u);
  assert.match(script, /data[\\/]cache[\\/]supertonic-3/iu);
});

test("npm start delegates to the only supported PowerShell entrypoint", async () => {
  const manifest = JSON.parse(await source("package.json"));

  assert.match(manifest.scripts.start, /powershell[^\r\n]*scripts[\\/]start\.ps1/iu);
  assert.doesNotMatch(manifest.scripts.start, /node[^\r\n]*src[\\/]index\.js/iu);
  assert.equal(manifest.scripts.verify, "node scripts/verify.mjs");
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
  assert.match(script, /Get-NetTCPConnection[^\r\n]*7788/iu);
  assert.match(script, /already in use/iu);
  assert.match(script, /sidecarListenerPid/u);
  assert.match(script, /taskkill\.exe/iu);
  assert.match(script, /\/PID[^\r\n]*\/T[^\r\n]*\/F/iu);
  assert.match(script, /remained open/iu);
  assert.doesNotMatch(script, /(?:backend[\\/]|uvicorn|fastapi|main\.py)/iu);
});

test("artifact evidence rejects silence, placeholders, wrong codecs, and missing captions", async () => {
  const { validateArtifactEvidence } = await import("../../scripts/verify.mjs");
  const analysis = {
    meanVolumeDb: -20,
    maxVolumeDb: -1,
    frozenMs: 0,
    longestFrozenMs: 0,
    blackMs: 0,
    longestBlackMs: 0,
  };

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
      analysis: { ...analysis, frozenMs: 4_000, longestFrozenMs: 4_000 },
      mediaPlan: validPlan(),
    }),
    { code: "VERIFY_PLACEHOLDER_VIDEO" },
  );
  assert.doesNotThrow(() => validateArtifactEvidence({
    probe: validProbe(),
    analysis: { ...analysis, frozenMs: 4_000, longestFrozenMs: 1_000 },
    mediaPlan: validPlan(),
  }));
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
    [freezedetect] lavfi.freezedetect.freeze_duration: 0.400
    [blackdetect] black_start:1 black_end:1.2 black_duration:0.200
    [blackdetect] black_start:2 black_end:2.1 black_duration:0.100
  `);

  assert.deepEqual(parsed, {
    meanVolumeDb: -18.4,
    maxVolumeDb: -0.8,
    frozenMs: 1200,
    longestFrozenMs: 800,
    blackMs: 300,
    longestBlackMs: 200,
  });
});

test("artifact verification runs the Node test runner directly on Windows", async () => {
  const script = await source("scripts/verify.mjs");
  assert.match(script, /run\(process\.execPath, \["--test"\]/u);
  assert.doesNotMatch(script, /npm\.cmd/u);
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
  assert.match(script, /fixture\/dashboard/u);

  const { buildSmokeRequest, parseSseFrames } = await import("../../scripts/smoke-live.mjs");
  const request = buildSmokeRequest({}, "http://127.0.0.1:4317");
  assert.equal(
    request.completionCondition,
    "완료: Manual Video 프로젝트가 열렸습니다.",
  );
  assert.equal(
    buildSmokeRequest(
      { MANUAL_STUDIO_SMOKE_COMPLETION_CONDITION: "사용자 지정 완료 조건" },
      "http://127.0.0.1:4317",
    ).completionCondition,
    "사용자 지정 완료 조건",
  );
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

test("live smoke best-effort cancels a created job when a later API gate fails", async (t) => {
  let cancelCalls = 0;
  const server = createServer((request, response) => {
    const sendJson = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/api/health") {
      sendJson(200, { ready: true });
      return;
    }
    if (request.method === "POST" && request.url === "/api/jobs") {
      sendJson(201, { id: "smoke-cancel-job" });
      return;
    }
    if (request.method === "GET" && request.url === "/api/jobs/smoke-cancel-job/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`event: PLAN_READY\ndata: ${JSON.stringify({
        event: "PLAN_READY",
        state: "plan_review",
        data: { planDigest: "a".repeat(64) },
      })}\n\n`);
      return;
    }
    if (request.method === "POST" && request.url === "/api/jobs/smoke-cancel-job/plan/approve") {
      sendJson(500, { error: { code: "TEST_GATE_FAILED" } });
      return;
    }
    if (request.method === "POST" && request.url === "/api/jobs/smoke-cancel-job/cancel") {
      cancelCalls += 1;
      sendJson(200, { state: "cancelled" });
      return;
    }
    sendJson(404, { error: { code: "NOT_FOUND" } });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const { runLiveSmoke } = await import("../../scripts/smoke-live.mjs");

  await assert.rejects(
    runLiveSmoke({
      env: {
        MANUAL_STUDIO_BASE_URL: baseUrl,
        MANUAL_STUDIO_SMOKE_AUTH_MODE: "automatic",
        MANUAL_STUDIO_SMOKE_CREDENTIAL_ID: "test-credential",
        MANUAL_STUDIO_SMOKE_TARGET_URL: `${baseUrl}/fixture/dashboard`,
        MANUAL_STUDIO_SMOKE_TIMEOUT_MS: "10000",
      },
    }),
    { code: "TEST_GATE_FAILED" },
  );
  assert.equal(cancelCalls, 1);
});

test("README documents the one supported start path, privacy, disclosures, and five engines", async () => {
  const readme = await source("README.md");

  assert.match(readme, /scripts[\\/]start\.ps1/iu);
  assert.doesNotMatch(readme, /npm\s+(?:run\s+)?start/iu);
  assert.match(readme, /수동 로그인/u);
  assert.match(readme, /자동 로그인/u);
  assert.match(readme, /자동 로그인에서는 대상 URL을 로그인 후 도착할 화면으로 지정/u);
  assert.match(readme, /로그인 폼 URL과 대상 URL이 같으면[^\r\n]*수동 로그인/u);
  assert.match(readme, /DPAPI/u);
  assert.match(readme, /data[\\/]cache[\\/]supertonic-3/iu);
  assert.match(readme, /첫 실행[^\r\n]*다운로드/iu);
  assert.match(readme, /재시도/u);
  assert.match(readme, /AI[^\r\n]*(?:생성|합성)|(?:생성|합성)[^\r\n]*AI/iu);
  assert.match(readme, /OpenRAIL-M/u);
  for (const engine of ["OpenCode", "Supertonic", "HyperFrames", "Playwright MCP", "FFmpeg"]) {
    assert.match(readme, new RegExp(engine, "iu"));
  }
  for (const variable of [
    "MANUAL_STUDIO_BASE_URL",
    "MANUAL_STUDIO_SMOKE_TIMEOUT_MS",
    "MANUAL_STUDIO_SMOKE_TARGET_URL",
    "MANUAL_STUDIO_SMOKE_PROMPT",
    "MANUAL_STUDIO_SMOKE_COMPLETION_CONDITION",
    "MANUAL_STUDIO_SMOKE_CREDENTIAL_ID",
  ]) {
    assert.match(readme, new RegExp(variable, "u"));
  }
  assert.match(readme, /node\s+scripts[\\/]verify\.mjs\s+--artifact[^\r\n]*--plan/iu);
  assert.doesNotMatch(readme, /(?:password|secret|token)\s*[=:]\s*[^<\s$]+/iu);
});
