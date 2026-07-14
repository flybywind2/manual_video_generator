import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  ALLOWED_SUPERTONIC_VOICES,
  runSupertonicSmoke,
  SupertonicClient,
} from "../../src/adapters/supertonic-client.js";

function wavFixture(payload = Buffer.alloc(882)) {
  const wav = Buffer.alloc(44 + payload.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + payload.length, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(44_100, 24);
  wav.writeUInt32LE(88_200, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(payload.length, 40);
  payload.copy(wav, 44);
  return wav;
}

async function readJsonRequest(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

async function outputPath(t, name = "scene.wav") {
  const root = await mkdtemp(join(tmpdir(), "manual-studio-supertonic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, name);
}

function clientForOutput(baseUrl, target, options = {}) {
  return new SupertonicClient({
    baseUrl,
    outputRoot: dirname(target),
    ...options,
  });
}

function outputOptions(target) {
  return { outputFile: basename(target) };
}

function sendWav(response, overrides = {}) {
  const headers = {
    "content-type": overrides.contentType ?? "audio/wav",
    "x-audio-duration": overrides.duration ?? "0.010",
    "x-sample-rate": overrides.sampleRate ?? "44100",
    "x-supertonic-version": overrides.version ?? "1.3.1",
    ...overrides.headers,
  };
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      delete headers[name];
    }
  }
  response.writeHead(overrides.status ?? 200, headers);
  response.end(overrides.body ?? wavFixture());
}

test("health reads the official /v1/health readiness contract", async (t) => {
  let method;
  let url;
  const baseUrl = await listen(t, (request, response) => {
    method = request.method;
    url = request.url;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        status: "ok",
        model: "supertonic-3",
        sample_rate: 44_100,
        version: "1.3.1",
        voices_loaded: 10,
      }),
    );
  });

  const health = await new SupertonicClient({ baseUrl }).health();

  assert.equal(method, "GET");
  assert.equal(url, "/v1/health");
  assert.deepEqual(health, {
    status: "ok",
    model: "supertonic-3",
    sampleRate: 44_100,
    version: "1.3.1",
    voicesLoaded: 10,
  });
});

test("health rejects a server that is not the pinned Supertonic 1.3.1 runtime", async (t) => {
  const baseUrl = await listen(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        status: "ok",
        model: "supertonic-3",
        sample_rate: 44_100,
        version: "1.3.2",
        voices_loaded: 10,
      }),
    );
  });

  await assert.rejects(new SupertonicClient({ baseUrl }).health(), {
    code: "SUPERTONIC_INVALID_HEALTH",
    retryable: false,
  });
});

test("synthesize sends one explicit Korean WAV request and atomically publishes it", async (t) => {
  const requests = [];
  const baseUrl = await listen(t, async (request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      body: await readJsonRequest(request),
    });
    sendWav(response);
  });
  const target = await outputPath(t);
  await writeFile(target, "old-audio", "utf8");

  const result = await clientForOutput(baseUrl, target).synthesize({
    text: "설정 메뉴를 선택합니다.",
    voice: "F1",
    ...outputOptions(target),
  });

  assert.deepEqual(requests, [
    {
      method: "POST",
      url: "/v1/tts",
      body: {
        text: "설정 메뉴를 선택합니다.",
        voice: "F1",
        lang: "ko",
        response_format: "wav",
      },
    },
  ]);
  assert.equal(result.outputPath, target);
  assert.equal(result.durationSeconds, 0.01);
  assert.equal(result.sampleRate, 44_100);
  assert.equal(result.voice, "F1");
  assert.equal(result.lang, "ko");
  assert.deepEqual(await readFile(target), wavFixture());
  assert.deepEqual(await readdir(join(target, "..")), ["scene.wav"]);
});

test("synthesize publishes only a relative WAV beneath its explicit job-owned root", async (t) => {
  const baseUrl = await listen(t, (_request, response) => sendWav(response));
  const root = await mkdtemp(join(tmpdir(), "manual-studio-supertonic-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "clips", "scene.wav");

  const result = await new SupertonicClient({ baseUrl, outputRoot: root }).synthesize({
    text: "작업 소유 경로를 확인합니다.",
    voice: "F1",
    outputFile: "clips/scene.wav",
  });

  assert.equal(result.outputPath, target);
  assert.deepEqual(await readFile(target), wavFixture());
});

test("output roots reject UNC, traversal, and linked parent directories", async (t) => {
  assert.throws(
    () => new SupertonicClient({ outputRoot: "\\\\server\\share\\job" }),
    { code: "SUPERTONIC_INVALID_OUTPUT_ROOT" },
  );

  const root = await mkdtemp(join(tmpdir(), "manual-studio-supertonic-root-"));
  const outside = await mkdtemp(join(tmpdir(), "manual-studio-supertonic-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const baseUrl = await listen(t, (_request, response) => sendWav(response));
  const client = new SupertonicClient({ baseUrl, outputRoot: root });

  await assert.rejects(
    client.synthesize({
      text: "상위 경로 이동을 거부합니다.",
      voice: "F1",
      outputFile: "../outside.wav",
    }),
    { code: "SUPERTONIC_INVALID_OUTPUT_FILE" },
  );

  await mkdir(join(root, "clips"));
  try {
    await symlink(outside, join(root, "clips", "linked"), "junction");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`junction creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    client.synthesize({
      text: "연결된 상위 경로를 거부합니다.",
      voice: "F1",
      outputFile: "clips/linked/escaped.wav",
    }),
    { code: "SUPERTONIC_UNSAFE_OUTPUT_PATH" },
  );
  await assert.rejects(readFile(join(outside, "escaped.wav")), { code: "ENOENT" });
});

test("only the ten built-in Supertonic preset voices are accepted", async (t) => {
  assert.deepEqual(ALLOWED_SUPERTONIC_VOICES, [
    "M1",
    "M2",
    "M3",
    "M4",
    "M5",
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
  ]);
  let requests = 0;
  const baseUrl = await listen(t, (_request, response) => {
    requests += 1;
    sendWav(response);
  });
  const target = await outputPath(t);

  await assert.rejects(
    clientForOutput(baseUrl, target).synthesize({
      text: "허용되지 않은 음성입니다.",
      voice: "custom-voice",
      ...outputOptions(target),
    }),
    { code: "SUPERTONIC_VOICE_NOT_ALLOWED", stage: "narration", retryable: false },
  );
  assert.equal(requests, 0);
});

test("non-WAV media types, file extensions, and payloads are rejected", async (t) => {
  const responses = [
    { contentType: "audio/mpeg", body: Buffer.from("ID3") },
    { contentType: "audio/wav", body: Buffer.from("not a wave") },
  ];
  const baseUrl = await listen(t, (_request, response) => {
    sendWav(response, responses.shift());
  });
  const root = await outputPath(t);
  const client = clientForOutput(baseUrl, root);

  await assert.rejects(
    client.synthesize({ text: "첫 번째 장면입니다.", voice: "M1", ...outputOptions(root) }),
    { code: "SUPERTONIC_INVALID_AUDIO" },
  );
  await assert.rejects(
    client.synthesize({ text: "두 번째 장면입니다.", voice: "M1", ...outputOptions(root) }),
    { code: "SUPERTONIC_INVALID_AUDIO" },
  );
  await assert.rejects(
    client.synthesize({
      text: "확장자가 잘못되었습니다.",
      voice: "M1",
      outputFile: basename(root).replace(/\.wav$/u, ".mp3"),
    }),
    { code: "SUPERTONIC_INVALID_OUTPUT_FILE" },
  );
});

test("missing or invalid duration and non-44.1 kHz audio are rejected", async (t) => {
  const responses = [
    { duration: "" },
    { duration: "not-a-number" },
    { duration: "0" },
    { sampleRate: "48000" },
  ];
  const baseUrl = await listen(t, (_request, response) => {
    const next = responses.shift();
    if (next.duration === "") {
      next.headers = { "x-audio-duration": undefined };
    }
    sendWav(response, next);
  });
  const target = await outputPath(t);
  const client = clientForOutput(baseUrl, target);

  for (const code of [
    "SUPERTONIC_INVALID_DURATION",
    "SUPERTONIC_INVALID_DURATION",
    "SUPERTONIC_INVALID_DURATION",
    "SUPERTONIC_INVALID_SAMPLE_RATE",
  ]) {
    await assert.rejects(
      client.synthesize({ text: "오디오를 검증합니다.", voice: "M1", ...outputOptions(target) }),
      { code },
    );
  }
});

test("synthesize rejects unpinned Supertonic response versions", async (t) => {
  const responses = [{ version: undefined }, { version: "1.3.2" }];
  const baseUrl = await listen(t, (_request, response) => {
    const next = responses.shift();
    if (next.version === undefined) {
      next.headers = { "x-supertonic-version": undefined };
    }
    sendWav(response, next);
  });
  const target = await outputPath(t);
  const client = clientForOutput(baseUrl, target);

  await assert.rejects(
    client.synthesize({ text: "버전 헤더를 확인합니다.", voice: "M1", ...outputOptions(target) }),
    { code: "SUPERTONIC_INVALID_VERSION" },
  );
  await assert.rejects(
    client.synthesize({ text: "고정 버전을 확인합니다.", voice: "M1", ...outputOptions(target) }),
    { code: "SUPERTONIC_INVALID_VERSION" },
  );
});

test("synthesize validates the complete mono 16-bit PCM RIFF contract", async (t) => {
  const corruptions = [
    (wav) => wav.writeUInt32LE(wav.length - 9, 4),
    (wav) => wav.writeUInt16LE(3, 20),
    (wav) => wav.writeUInt16LE(2, 22),
    (wav) => wav.writeUInt16LE(8, 34),
    (wav) => wav.writeUInt32LE(wav.length, 40),
  ];
  const bodies = corruptions.map((corrupt) => {
    const wav = Buffer.from(wavFixture());
    corrupt(wav);
    return wav;
  });
  bodies.push(wavFixture());
  const baseUrl = await listen(t, (_request, response) => {
    const body = bodies.shift();
    sendWav(response, {
      body,
      ...(bodies.length === 0 ? { duration: "0.500" } : {}),
    });
  });
  const target = await outputPath(t);
  const client = clientForOutput(baseUrl, target);

  for (let index = 0; index < corruptions.length; index += 1) {
    await assert.rejects(
      client.synthesize({ text: "PCM 구조를 확인합니다.", voice: "M1", ...outputOptions(target) }),
      { code: "SUPERTONIC_INVALID_AUDIO" },
    );
  }
  await assert.rejects(
    client.synthesize({ text: "PCM 길이를 확인합니다.", voice: "M1", ...outputOptions(target) }),
    { code: "SUPERTONIC_INVALID_DURATION" },
  );
});

test("concurrent synthesis calls across client instances are globally serialized", async (t) => {
  let active = 0;
  let maximumActive = 0;
  const order = [];
  const baseUrl = await listen(t, async (request, response) => {
    const { text } = await readJsonRequest(request);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push(`start:${text}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    order.push(`end:${text}`);
    active -= 1;
    sendWav(response);
  });
  const root = await mkdtemp(join(tmpdir(), "manual-studio-supertonic-queue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clients = [0, 1, 2].map(
    () => new SupertonicClient({ baseUrl, outputRoot: root }),
  );

  await Promise.all(
    ["하나", "둘", "셋"].map((text, index) =>
      clients[index].synthesize({
        text,
        voice: "M1",
        outputFile: `scene-${index + 1}.wav`,
      }),
    ),
  );

  assert.equal(maximumActive, 1);
  assert.deepEqual(order, [
    "start:하나",
    "end:하나",
    "start:둘",
    "end:둘",
    "start:셋",
    "end:셋",
  ]);
});

test("a queued synthesis can be cancelled before it reaches Supertonic", async (t) => {
  let firstStarted;
  const started = new Promise((resolve) => {
    firstStarted = resolve;
  });
  let releaseFirst;
  const release = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const requests = [];
  const baseUrl = await listen(t, async (request, response) => {
    const { text } = await readJsonRequest(request);
    requests.push(text);
    if (text === "첫 요청") {
      firstStarted();
      await release;
    }
    sendWav(response);
  });
  const root = await mkdtemp(join(tmpdir(), "manual-studio-supertonic-queue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new SupertonicClient({ baseUrl, outputRoot: root }).synthesize({
    text: "첫 요청",
    voice: "M1",
    outputFile: "first.wav",
  });
  await started;

  const controller = new AbortController();
  const second = new SupertonicClient({ baseUrl, outputRoot: root }).synthesize({
    text: "취소할 요청",
    voice: "M1",
    outputFile: "cancelled.wav",
    signal: controller.signal,
  });
  controller.abort();
  const outcome = await Promise.race([
    second.then(
      () => ({ code: "resolved" }),
      (error) => ({ code: error.code, retryable: error.retryable }),
    ),
    new Promise((resolve) =>
      setTimeout(() => resolve({ code: "still_queued" }), 100),
    ),
  ]);
  assert.deepEqual(outcome, { code: "SUPERTONIC_CANCELLED", retryable: true });
  assert.deepEqual(requests, ["첫 요청"]);

  releaseFirst();
  await first;
  await assert.rejects(readFile(join(root, "cancelled.wav")), { code: "ENOENT" });
});

test("request timeout is reported as a structured retryable error", async (t) => {
  const baseUrl = await listen(t, () => {});
  const target = await outputPath(t);

  await assert.rejects(
    clientForOutput(baseUrl, target, { timeoutMs: 30 }).synthesize({
      text: "응답 시간 제한을 확인합니다.",
      voice: "M1",
      ...outputOptions(target),
    }),
    {
      code: "SUPERTONIC_TIMEOUT",
      stage: "narration",
      retryable: true,
    },
  );
});

test("request timeout remains active while a response body is stalled", async (t) => {
  const baseUrl = await listen(t, (_request, response) => {
    response.writeHead(200, {
      "content-type": "audio/wav",
      "x-audio-duration": "1.000",
      "x-sample-rate": "44100",
      "x-supertonic-version": "1.3.1",
    });
    response.flushHeaders();
    response.write(wavFixture().subarray(0, 12));
  });
  const target = await outputPath(t);
  const operation = clientForOutput(baseUrl, target, { timeoutMs: 30 }).synthesize({
    text: "본문 스트림 시간 제한을 확인합니다.",
    voice: "M1",
    ...outputOptions(target),
  });
  operation.catch(() => undefined);

  const outcome = await Promise.race([
    operation.then(
      () => ({ code: "resolved" }),
      (error) => ({ code: error.code, retryable: error.retryable }),
    ),
    new Promise((resolve) =>
      setTimeout(() => resolve({ code: "still_pending" }), 150),
    ),
  ]);

  assert.deepEqual(outcome, { code: "SUPERTONIC_TIMEOUT", retryable: true });
});

test("503 responses preserve a bounded upstream code without creating audio", async (t) => {
  const baseUrl = await listen(t, async (_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          message: "server is loading a local model",
          type: "server_error",
          code: "not_ready",
        },
      }),
    );
  });
  const target = await outputPath(t);

  await assert.rejects(
    clientForOutput(baseUrl, target).synthesize({
      text: "서버 준비 상태를 확인합니다.",
      voice: "M1",
      ...outputOptions(target),
    }),
    (error) => {
      assert.equal(error.code, "SUPERTONIC_UNAVAILABLE");
      assert.equal(error.stage, "narration");
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details, { status: 503, upstreamCode: "not_ready" });
      assert.doesNotMatch(error.message, /server is loading/u);
      return true;
    },
  );
  await assert.rejects(readFile(target), { code: "ENOENT" });
});

test("oversized error bodies are cancelled without hiding the HTTP status", async (t) => {
  const baseUrl = await listen(t, (_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.write("x".repeat(9_000));
  });
  const target = await outputPath(t);

  await assert.rejects(
    clientForOutput(baseUrl, target, { timeoutMs: 1_000 }).synthesize({
      text: "오류 본문 제한을 확인합니다.",
      voice: "M1",
      ...outputOptions(target),
    }),
    { code: "SUPERTONIC_UNAVAILABLE", retryable: true },
  );
});

test("failed validation keeps an existing target and removes temporary files", async (t) => {
  const baseUrl = await listen(t, (_request, response) => {
    sendWav(response, { duration: "invalid" });
  });
  const target = await outputPath(t);
  await writeFile(target, "previous-good-audio", "utf8");

  await assert.rejects(
    clientForOutput(baseUrl, target).synthesize({
      text: "기존 파일을 보존합니다.",
      voice: "M1",
      ...outputOptions(target),
    }),
    { code: "SUPERTONIC_INVALID_DURATION" },
  );

  assert.equal(await readFile(target, "utf8"), "previous-good-audio");
  assert.deepEqual(await readdir(join(target, "..")), ["scene.wav"]);
});

test("the live smoke checks health, synthesizes Korean audio, and removes its temporary WAV", async (t) => {
  const requests = [];
  const baseUrl = await listen(t, async (request, response) => {
    requests.push(request.url);
    if (request.url === "/v1/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ok",
          model: "supertonic-3",
          sample_rate: 44_100,
          version: "1.3.1",
          voices_loaded: 10,
        }),
      );
      return;
    }
    const body = await readJsonRequest(request);
    assert.equal(body.text, "수퍼토닉 한국어 음성 합성 점검입니다.");
    sendWav(response);
  });

  const result = await runSupertonicSmoke({ baseUrl });

  assert.deepEqual(requests, ["/v1/health", "/v1/tts"]);
  assert.deepEqual(result, {
    status: "ok",
    model: "supertonic-3",
    version: "1.3.1",
    sampleRate: 44_100,
    durationSeconds: 0.01,
    bytes: 926,
  });
});
