import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildConfig } from "../src/config.js";
import { inspectRuntime } from "../src/preflight.js";

const root = path.resolve("test-fixtures", "studio-root");

function readyRuntimeOverrides(overrides = {}) {
  const locations = {
    opencode: path.join(root, "tools", "opencode.exe"),
    playwrightMcp: path.join(root, "node_modules", "@playwright", "mcp", "cli.js"),
    python: path.join(root, ".runtime", "python", "python.exe"),
    supertonic: path.join(root, ".runtime", "python", "Scripts", "supertonic.exe"),
    hyperframes: path.join(root, "node_modules", "hyperframes", "dist", "cli.js"),
    ffmpeg: path.join(root, "tools", "ffmpeg.exe"),
    ffprobe: path.join(root, "tools", "ffprobe.exe"),
  };
  const versions = {
    opencode: "1.4.1",
    playwrightMcp: "0.0.78",
    python: "3.13.14",
    supertonic: "1.3.1",
    hyperframes: "0.7.57",
    ffmpeg: "8.1.1",
    ffprobe: "8.1.1",
  };

  return {
    nodeVersion: "v24.13.1",
    locate: async (tool) => locations[tool] ?? null,
    version: async (tool) => versions[tool] ?? null,
    ...overrides,
  };
}

test("buildConfig pins the three package runtimes exactly", () => {
  const config = buildConfig({ root, env: {} });

  assert.deepEqual(config.versions, {
    playwrightMcp: "0.0.78",
    supertonic: "1.3.1",
    hyperframes: "0.7.57",
  });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.versions), true);
});

test("buildConfig exposes only a frozen loopback service with absolute paths under root", () => {
  const config = buildConfig({
    root: path.join("relative", "studio"),
    env: { MANUAL_STUDIO_PORT: "5432" },
  });

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 5432);
  assert.equal(Object.isFrozen(config.paths), true);

  for (const servicePath of Object.values(config.paths)) {
    assert.equal(path.isAbsolute(servicePath), true);
    assert.equal(path.relative(config.root, servicePath).startsWith(".."), false);
  }
});

test("buildConfig defaults the service port to 4317", () => {
  assert.equal(buildConfig({ root, env: {} }).port, 4317);
});

test("inspectRuntime discovers every command and marks a complete Node 22+ runtime ready", async () => {
  const discovered = [];
  const defaults = readyRuntimeOverrides();
  const report = await inspectRuntime({
    config: buildConfig({ root, env: {} }),
    ...defaults,
    locate: async (tool, context) => {
      discovered.push(tool);
      return defaults.locate(tool, context);
    },
  });

  assert.equal(report.ready, true);
  assert.deepEqual(discovered, [
    "opencode",
    "playwrightMcp",
    "python",
    "supertonic",
    "hyperframes",
    "ffmpeg",
    "ffprobe",
  ]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(report.checks).map(([key, check]) => [key, check.status])),
    {
      node: "ready",
      opencode: "ready",
      playwrightMcp: "ready",
      python: "ready",
      supertonic: "ready",
      hyperframes: "ready",
      ffmpeg: "ready",
      ffprobe: "ready",
    },
  );
});

test("inspectRuntime reports missing and mismatched tools independently", async () => {
  const defaults = readyRuntimeOverrides();
  const report = await inspectRuntime({
    config: buildConfig({ root, env: {} }),
    ...defaults,
    nodeVersion: "v21.7.3",
    locate: async (tool, context) =>
      tool === "ffmpeg" ? null : defaults.locate(tool, context),
    version: async (tool, executable, context) =>
      tool === "playwrightMcp"
        ? "0.0.77"
        : defaults.version(tool, executable, context),
  });

  assert.equal(report.ready, false);
  assert.equal(report.checks.node.status, "mismatch");
  assert.equal(report.checks.playwrightMcp.status, "mismatch");
  assert.equal(report.checks.ffmpeg.status, "missing");
  assert.equal(report.checks.ffprobe.status, "ready");
});

test("inspectRuntime public status never serializes environment values or thrown secret text", async () => {
  const secret = "never-print-this-password";
  const config = buildConfig({
    root,
    env: {
      MANUAL_STUDIO_PORT: "4318",
      LOGIN_PASSWORD: secret,
      OPENAI_API_KEY: "never-print-this-api-key",
    },
  });
  const defaults = readyRuntimeOverrides();
  const report = await inspectRuntime({
    config,
    ...defaults,
    version: async (tool, executable, context) => {
      if (tool === "opencode") {
        throw new Error(`command failed with ${secret}`);
      }
      return defaults.version(tool, executable, context);
    },
  });
  const serialized = JSON.stringify({ config, report });

  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("never-print-this-api-key"), false);
  assert.equal(serialized.includes("LOGIN_PASSWORD"), false);
  assert.equal(serialized.includes("OPENAI_API_KEY"), false);
  assert.equal(report.checks.opencode.status, "missing");
});
