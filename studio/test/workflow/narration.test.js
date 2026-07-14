import assert from "node:assert/strict";
import {
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { StudioError } from "../../src/domain/errors.js";
import {
  generateNarration,
  retryNarrationScenes,
} from "../../src/workflow/narration.js";

function plan() {
  return {
    steps: [
      {
        id: "open-settings",
        narration: "상단의 설정 메뉴를 선택합니다.",
      },
      {
        id: "choose-profile",
        narration: "프로필 항목을 열어 현재 정보를 확인합니다.",
      },
      {
        id: "finish-review",
        narration: "마지막으로 표시된 내용을 검토합니다.",
      },
    ],
  };
}

function wavFixture(index) {
  const durationSeconds = index + 0.25;
  const payload = Buffer.alloc(durationSeconds * 44_100 * 2);
  payload.writeUInt16LE(index, 0);
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

async function narrationDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), "manual-studio-narration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "narration");
}

class RecordingClient {
  constructor({
    outputRoot,
    failOnce = new Set(),
    alwaysFail = new Set(),
    leaveGarbage = false,
  } = {}) {
    this.calls = [];
    this.failOnce = new Set(failOnce);
    this.alwaysFail = new Set(alwaysFail);
    this.leaveGarbage = leaveGarbage;
    this.active = 0;
    this.maximumActive = 0;
    this.healthCalls = 0;
    this.outputRoot = outputRoot;
  }

  async health() {
    this.healthCalls += 1;
    return {
      status: "ok",
      model: "supertonic-3",
      sampleRate: 44_100,
      version: "1.3.1",
      voicesLoaded: 10,
    };
  }

  async synthesize({ text, voice, outputFile, signal }) {
    const outputPath = join(this.outputRoot, outputFile);
    this.calls.push({ text, voice, outputPath, signal });
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.active -= 1;

    const sceneNumber = Number.parseInt(/scene-(\d+)\.wav$/u.exec(outputPath)?.[1] ?? "0", 10);
    if (this.leaveGarbage) {
      await writeFile(outputPath, "not valid narration", "utf8");
    }
    if (this.alwaysFail.has(sceneNumber) || this.failOnce.delete(sceneNumber)) {
      throw new StudioError("raw Supertonic failure must not enter the manifest", {
        code: "SUPERTONIC_UNAVAILABLE",
        stage: "narration",
        retryable: true,
        details: { internal: "do-not-persist" },
      });
    }

    const wav = wavFixture(sceneNumber);
    await writeFile(outputPath, wav);
    return {
      outputPath,
      durationSeconds: sceneNumber + 0.25,
      sampleRate: 44_100,
      voice,
      lang: "ko",
      bytes: wav.length,
    };
  }
}

test("generates ordered scene WAVs and preserves Korean narration in narration.json", async (t) => {
  const outputDirectory = await narrationDirectory(t);
  const client = new RecordingClient({ outputRoot: outputDirectory });
  const abortController = new AbortController();

  const manifest = await generateNarration({
    plan: plan(),
    outputDirectory,
    client,
    voice: "F2",
    signal: abortController.signal,
  });

  assert.equal(client.maximumActive, 1);
  assert.equal(client.healthCalls, 1);
  assert.deepEqual(
    client.calls.map(({ text, voice, outputPath, signal }) => ({
      text,
      voice,
      file: basename(outputPath),
      signal,
    })),
    [
      {
        text: "상단의 설정 메뉴를 선택합니다.",
        voice: "F2",
        file: "scene-001.wav",
        signal: abortController.signal,
      },
      {
        text: "프로필 항목을 열어 현재 정보를 확인합니다.",
        voice: "F2",
        file: "scene-002.wav",
        signal: abortController.signal,
      },
      {
        text: "마지막으로 표시된 내용을 검토합니다.",
        voice: "F2",
        file: "scene-003.wav",
        signal: abortController.signal,
      },
    ],
  );
  assert.deepEqual(manifest, {
    schemaVersion: "1.0",
    status: "ready",
    lang: "ko",
    voice: "F2",
    scenes: [
      {
        sceneId: "open-settings",
        order: 1,
        text: "상단의 설정 메뉴를 선택합니다.",
        status: "ready",
        file: "scene-001.wav",
        durationSeconds: 1.25,
        sampleRate: 44_100,
        bytes: 110_294,
        attempts: 1,
      },
      {
        sceneId: "choose-profile",
        order: 2,
        text: "프로필 항목을 열어 현재 정보를 확인합니다.",
        status: "ready",
        file: "scene-002.wav",
        durationSeconds: 2.25,
        sampleRate: 44_100,
        bytes: 198_494,
        attempts: 1,
      },
      {
        sceneId: "finish-review",
        order: 3,
        text: "마지막으로 표시된 내용을 검토합니다.",
        status: "ready",
        file: "scene-003.wav",
        durationSeconds: 3.25,
        sampleRate: 44_100,
        bytes: 286_694,
        attempts: 1,
      },
    ],
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(outputDirectory, "narration.json"), "utf8")),
    manifest,
  );
  for (let index = 1; index <= 3; index += 1) {
    assert.deepEqual(
      await readFile(join(outputDirectory, `scene-${String(index).padStart(3, "0")}.wav`)),
      wavFixture(index),
    );
  }
});

test("generation cancellation stops after the active scene and leaves a resumable manifest", async (t) => {
  const outputDirectory = await narrationDirectory(t);
  const client = new RecordingClient({ outputRoot: outputDirectory });
  const controller = new AbortController();
  client.synthesize = async (options) => {
    client.calls.push(options);
    controller.abort();
    throw new StudioError("cancelled during synthesis", {
      code: "SUPERTONIC_CANCELLED",
      stage: "narration",
      retryable: true,
    });
  };

  await assert.rejects(
    generateNarration({
      plan: plan(),
      outputDirectory,
      client,
      voice: "F2",
      signal: controller.signal,
    }),
    { code: "NARRATION_CANCELLED", stage: "narration", retryable: true },
  );

  assert.deepEqual(client.calls.map(({ outputFile }) => outputFile), ["scene-001.wav"]);
  const manifest = JSON.parse(
    await readFile(join(outputDirectory, "narration.json"), "utf8"),
  );
  assert.equal(manifest.status, "failed");
  assert.deepEqual(
    manifest.scenes.map(({ status, file, attempts, error }) => ({
      status,
      file,
      attempts,
      error,
    })),
    [
      {
        status: "failed",
        file: null,
        attempts: 1,
        error: {
          code: "NARRATION_CANCELLED",
          stage: "narration",
          retryable: true,
        },
      },
      {
        status: "failed",
        file: null,
        attempts: 0,
        error: {
          code: "NARRATION_CANCELLED",
          stage: "narration",
          retryable: true,
        },
      },
      {
        status: "failed",
        file: null,
        attempts: 0,
        error: {
          code: "NARRATION_CANCELLED",
          stage: "narration",
          retryable: true,
        },
      },
    ],
  );
});

test("cancellation after synthesis removes the unpublished clip and stops the next scene", async (t) => {
  const outputDirectory = await narrationDirectory(t);
  const client = new RecordingClient({ outputRoot: outputDirectory });
  const controller = new AbortController();
  const synthesize = client.synthesize.bind(client);
  client.synthesize = async (options) => {
    const result = await synthesize(options);
    controller.abort();
    return result;
  };

  await assert.rejects(
    generateNarration({
      plan: plan(),
      outputDirectory,
      client,
      voice: "M1",
      signal: controller.signal,
    }),
    { code: "NARRATION_CANCELLED", retryable: true },
  );

  assert.deepEqual(client.calls.map(({ outputPath }) => basename(outputPath)), [
    "scene-001.wav",
  ]);
  await assert.rejects(readFile(join(outputDirectory, "scene-001.wav")), {
    code: "ENOENT",
  });
  const manifest = JSON.parse(
    await readFile(join(outputDirectory, "narration.json"), "utf8"),
  );
  assert.equal(manifest.status, "failed");
  assert.deepEqual(
    manifest.scenes.map(({ status, attempts, error }) => ({
      status,
      attempts,
      code: error?.code,
    })),
    [
      { status: "failed", attempts: 1, code: "NARRATION_CANCELLED" },
      { status: "failed", attempts: 0, code: "NARRATION_CANCELLED" },
      { status: "failed", attempts: 0, code: "NARRATION_CANCELLED" },
    ],
  );
});

test("retry cancellation stops the retry loop and preserves untouched cancelled scenes", async (t) => {
  const outputDirectory = await narrationDirectory(t);
  const client = new RecordingClient({ outputRoot: outputDirectory });
  const generationController = new AbortController();
  client.synthesize = async (options) => {
    client.calls.push(options);
    generationController.abort();
    throw new StudioError("cancel initial generation", {
      code: "SUPERTONIC_CANCELLED",
      stage: "narration",
      retryable: true,
    });
  };
  await assert.rejects(
    generateNarration({
      plan: plan(),
      outputDirectory,
      client,
      voice: "F1",
      signal: generationController.signal,
    }),
    { code: "NARRATION_CANCELLED" },
  );

  client.calls.length = 0;
  const retryController = new AbortController();
  client.synthesize = async (options) => {
    client.calls.push(options);
    retryController.abort();
    throw new StudioError("cancel retry", {
      code: "SUPERTONIC_CANCELLED",
      stage: "narration",
      retryable: true,
    });
  };

  await assert.rejects(
    retryNarrationScenes({
      plan: plan(),
      outputDirectory,
      client,
      voice: "F1",
      signal: retryController.signal,
      sceneIds: ["choose-profile", "finish-review"],
    }),
    { code: "NARRATION_CANCELLED", retryable: true },
  );

  assert.deepEqual(client.calls.map(({ outputFile }) => outputFile), ["scene-002.wav"]);
  const manifest = JSON.parse(
    await readFile(join(outputDirectory, "narration.json"), "utf8"),
  );
  assert.equal(manifest.status, "failed");
  assert.deepEqual(
    manifest.scenes.map(({ attempts, error }) => ({
      attempts,
      code: error?.code,
    })),
    [
      { attempts: 1, code: "NARRATION_CANCELLED" },
      { attempts: 1, code: "NARRATION_CANCELLED" },
      { attempts: 0, code: "NARRATION_CANCELLED" },
    ],
  );
});

test("refuses narration when the one-time pinned health contract is invalid", async (t) => {
  const outputDirectory = await narrationDirectory(t);
  const client = new RecordingClient({ outputRoot: outputDirectory });
  client.health = async () => ({
    status: "ok",
    model: "supertonic-3",
    sampleRate: 44_100,
    version: "1.3.2",
    voicesLoaded: 10,
  });

  await assert.rejects(
    generateNarration({
      plan: { steps: [plan().steps[0]] },
      outputDirectory,
      client,
      voice: "F2",
    }),
    { code: "NARRATION_SUPERTONIC_UNHEALTHY" },
  );
  await assert.rejects(stat(join(outputDirectory, "narration.json")), {
    code: "ENOENT",
  });
  assert.equal(client.calls.length, 0);
});

test("binds every clip to a client owned by the exact narration directory", async (t) => {
  const outputDirectory = await narrationDirectory(t);
  const otherRoot = await mkdtemp(join(tmpdir(), "manual-studio-other-narration-"));
  t.after(() => rm(otherRoot, { recursive: true, force: true }));
  const client = new RecordingClient({ outputRoot: otherRoot });

  await assert.rejects(
    generateNarration({
      plan: { steps: [plan().steps[0]] },
      outputDirectory,
      client,
      voice: "F2",
    }),
    { code: "NARRATION_OUTPUT_ROOT_MISMATCH" },
  );
  assert.equal(client.healthCalls, 0);
  assert.equal(client.calls.length, 0);
});

test("rejects a concurrent writer for the same narration directory", async (t) => {
  const outputDirectory = await narrationDirectory(t);
  let announceStart;
  const started = new Promise((resolve) => {
    announceStart = resolve;
  });
  let releaseFirst;
  const release = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const client = new RecordingClient({ outputRoot: outputDirectory });
  const baseSynthesize = client.synthesize.bind(client);
  let invocations = 0;
  client.synthesize = async (options) => {
    invocations += 1;
    if (invocations === 1) {
      announceStart();
      await release;
    }
    return baseSynthesize(options);
  };
  const options = {
    plan: { steps: [plan().steps[0]] },
    outputDirectory,
    client,
    voice: "F2",
  };

  const first = generateNarration(options);
  await started;
  const second = generateNarration(options);
  const outcome = await Promise.race([
    second.then(
      () => ({ code: "resolved" }),
      (error) => ({ code: error.code, retryable: error.retryable }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ code: "pending" }), 100)),
  ]);
  assert.deepEqual(outcome, {
    code: "NARRATION_OUTPUT_BUSY",
    retryable: true,
  });

  releaseFirst();
  await first;
  await second.catch(() => undefined);
});

test("rejects a narration output directory that is a junction", async (t) => {
  const outputDirectory = await narrationDirectory(t);
  const outside = await mkdtemp(join(tmpdir(), "manual-studio-narration-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  try {
    await symlink(outside, outputDirectory, "junction");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`junction creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const client = new RecordingClient({ outputRoot: outputDirectory });

  await assert.rejects(
    generateNarration({
      plan: { steps: [plan().steps[0]] },
      outputDirectory,
      client,
      voice: "F2",
    }),
    { code: "NARRATION_UNSAFE_OUTPUT_PATH" },
  );
  await assert.rejects(stat(join(outside, "narration.json")), { code: "ENOENT" });
  assert.equal(client.healthCalls, 0);
});

test("persists partial progress and retries only the failed scene", async (t) => {
  const outputDirectory = await narrationDirectory(t);
  const client = new RecordingClient({
    outputRoot: outputDirectory,
    failOnce: new Set([2]),
  });

  await assert.rejects(
    generateNarration({ plan: plan(), outputDirectory, client, voice: "M2" }),
    (error) => {
      assert.equal(error.code, "NARRATION_INCOMPLETE");
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details, { failedSceneIds: ["choose-profile"] });
      return true;
    },
  );
  const partial = JSON.parse(
    await readFile(join(outputDirectory, "narration.json"), "utf8"),
  );
  assert.equal(partial.status, "failed");
  assert.deepEqual(
    partial.scenes.map(({ sceneId, status, attempts }) => ({ sceneId, status, attempts })),
    [
      { sceneId: "open-settings", status: "ready", attempts: 1 },
      { sceneId: "choose-profile", status: "failed", attempts: 1 },
      { sceneId: "finish-review", status: "ready", attempts: 1 },
    ],
  );
  assert.deepEqual(partial.scenes[1].error, {
    code: "SUPERTONIC_UNAVAILABLE",
    stage: "narration",
    retryable: true,
  });
  assert.equal(JSON.stringify(partial).includes("raw Supertonic failure"), false);
  await assert.rejects(readFile(join(outputDirectory, "scene-002.wav")), { code: "ENOENT" });
  const firstBefore = await readFile(join(outputDirectory, "scene-001.wav"));
  const thirdBefore = await readFile(join(outputDirectory, "scene-003.wav"));
  client.calls.length = 0;

  const complete = await retryNarrationScenes({
    plan: plan(),
    outputDirectory,
    client,
    voice: "M2",
    sceneIds: ["choose-profile"],
  });

  assert.equal(complete.status, "ready");
  assert.deepEqual(client.calls.map(({ text }) => text), [
    "프로필 항목을 열어 현재 정보를 확인합니다.",
  ]);
  assert.equal(complete.scenes[1].attempts, 2);
  assert.equal(Object.hasOwn(complete.scenes[1], "error"), false);
  assert.deepEqual(await readFile(join(outputDirectory, "scene-001.wav")), firstBefore);
  assert.deepEqual(await readFile(join(outputDirectory, "scene-003.wav")), thirdBefore);
});

test("a failed scene never leaves silent or garbage fallback audio", async (t) => {
  const outputDirectory = await narrationDirectory(t);
  const client = new RecordingClient({
    outputRoot: outputDirectory,
    alwaysFail: new Set([1]),
    leaveGarbage: true,
  });

  await assert.rejects(
    generateNarration({
      plan: { steps: [plan().steps[0]] },
      outputDirectory,
      client,
      voice: "M1",
    }),
    { code: "NARRATION_INCOMPLETE" },
  );

  await assert.rejects(stat(join(outputDirectory, "scene-001.wav")), { code: "ENOENT" });
  const manifest = JSON.parse(
    await readFile(join(outputDirectory, "narration.json"), "utf8"),
  );
  assert.equal(manifest.status, "failed");
  assert.equal(manifest.scenes[0].file, null);
  assert.equal(Object.hasOwn(manifest.scenes[0], "durationSeconds"), false);
});

test("partial retry rejects unknown, successful, or stale scenes without synthesis", async (t) => {
  const outputDirectory = await narrationDirectory(t);
  const client = new RecordingClient({
    outputRoot: outputDirectory,
    failOnce: new Set([2]),
  });
  await assert.rejects(
    generateNarration({ plan: plan(), outputDirectory, client, voice: "F1" }),
    { code: "NARRATION_INCOMPLETE" },
  );
  client.calls.length = 0;

  await assert.rejects(
    retryNarrationScenes({
      plan: plan(),
      outputDirectory,
      client,
      voice: "F1",
      sceneIds: ["not-a-scene"],
    }),
    { code: "NARRATION_RETRY_NOT_ALLOWED" },
  );
  await assert.rejects(
    retryNarrationScenes({
      plan: plan(),
      outputDirectory,
      client,
      voice: "F1",
      sceneIds: ["open-settings"],
    }),
    { code: "NARRATION_RETRY_NOT_ALLOWED" },
  );
  const stalePlan = plan();
  stalePlan.steps[1].narration = "변경된 문장은 전체 내레이션 재생성이 필요합니다.";
  await assert.rejects(
    retryNarrationScenes({
      plan: stalePlan,
      outputDirectory,
      client,
      voice: "F1",
      sceneIds: ["choose-profile"],
    }),
    { code: "NARRATION_MANIFEST_MISMATCH" },
  );
  assert.equal(client.calls.length, 0);
});

test("partial retry refuses a manifest whose previously successful WAV disappeared", async (t) => {
  const outputDirectory = await narrationDirectory(t);
  const client = new RecordingClient({
    outputRoot: outputDirectory,
    failOnce: new Set([2]),
  });
  await assert.rejects(
    generateNarration({ plan: plan(), outputDirectory, client, voice: "F1" }),
    { code: "NARRATION_INCOMPLETE" },
  );
  await rm(join(outputDirectory, "scene-001.wav"));
  client.calls.length = 0;

  await assert.rejects(
    retryNarrationScenes({
      plan: plan(),
      outputDirectory,
      client,
      voice: "F1",
      sceneIds: ["choose-profile"],
    }),
    { code: "NARRATION_MANIFEST_MISMATCH" },
  );
  assert.equal(client.calls.length, 0);
});

test("partial retry refuses a ready WAV whose PCM structure was tampered", async (t) => {
  const outputDirectory = await narrationDirectory(t);
  const client = new RecordingClient({
    outputRoot: outputDirectory,
    failOnce: new Set([2]),
  });
  await assert.rejects(
    generateNarration({ plan: plan(), outputDirectory, client, voice: "F1" }),
    { code: "NARRATION_INCOMPLETE" },
  );
  const firstPath = join(outputDirectory, "scene-001.wav");
  const tampered = await readFile(firstPath);
  tampered.writeUInt16LE(2, 22);
  await writeFile(firstPath, tampered);
  client.calls.length = 0;

  await assert.rejects(
    retryNarrationScenes({
      plan: plan(),
      outputDirectory,
      client,
      voice: "F1",
      sceneIds: ["choose-profile"],
    }),
    { code: "NARRATION_MANIFEST_MISMATCH" },
  );
  assert.equal(client.calls.length, 0);
});

test("partial retry rejects a hard-linked narration manifest", async (t) => {
  const outputDirectory = await narrationDirectory(t);
  const client = new RecordingClient({
    outputRoot: outputDirectory,
    failOnce: new Set([2]),
  });
  await assert.rejects(
    generateNarration({ plan: plan(), outputDirectory, client, voice: "F1" }),
    { code: "NARRATION_INCOMPLETE" },
  );
  const manifestPath = join(outputDirectory, "narration.json");
  const outsidePath = join(outputDirectory, "outside-manifest.json");
  await writeFile(outsidePath, await readFile(manifestPath));
  await rm(manifestPath);
  await link(outsidePath, manifestPath);
  client.calls.length = 0;

  await assert.rejects(
    retryNarrationScenes({
      plan: plan(),
      outputDirectory,
      client,
      voice: "F1",
      sceneIds: ["choose-profile"],
    }),
    { code: "NARRATION_MANIFEST_MISMATCH" },
  );
  assert.equal(client.calls.length, 0);
});

test("the sidecar and npm scripts pin the approved local Supertonic runtime", async () => {
  const studioRoot = fileURLToPath(new URL("../../", import.meta.url));
  const source = await readFile(join(studioRoot, "scripts", "supertonic.ps1"), "utf8");
  const packageJson = JSON.parse(await readFile(join(studioRoot, "package.json"), "utf8"));

  assert.match(source, /3\.13\.14/u);
  assert.match(source, /supertonic\[serve\]==1\.3\.1/u);
  assert.match(source, /--model[\s\S]*supertonic-3/u);
  assert.match(source, /--host[\s\S]*127\.0\.0\.1/u);
  assert.match(source, /--port[\s\S]*7788/u);
  assert.doesNotMatch(source, /0\.0\.0\.0/u);
  assert.equal(
    packageJson.scripts["supertonic:ensure"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/supertonic.ps1 -Ensure",
  );
  assert.equal(
    packageJson.scripts["supertonic:start"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/supertonic.ps1 -Ensure -Start",
  );
  assert.equal(
    packageJson.scripts["smoke:supertonic"],
    "node src/adapters/supertonic-client.js --smoke",
  );
});
