import path from "node:path";

import {
  OPEN_CODE_FALLBACK_VERSION,
  OPEN_CODE_MINIMUM_VERSION,
} from "./runtime/opencode-installation.js";

const DEFAULT_PORT = 4317;

export const VERSION_PINS = Object.freeze({
  opencode: OPEN_CODE_MINIMUM_VERSION,
  opencodeFallback: OPEN_CODE_FALLBACK_VERSION,
  playwrightMcp: "0.0.78",
  python: "3.13.14",
  supertonic: "1.3.1",
  hyperframes: "0.7.57",
  ffmpeg: "8.1.1",
  ffprobe: "8.1.1",
});

function parsePort(rawPort) {
  if (rawPort === undefined || rawPort === "") {
    return DEFAULT_PORT;
  }

  if (!/^\d+$/.test(String(rawPort))) {
    throw new TypeError("MANUAL_STUDIO_PORT must be an integer");
  }

  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("MANUAL_STUDIO_PORT must be between 1 and 65535");
  }
  return port;
}

export function buildConfig({ root, env = {} } = {}) {
  if (typeof root !== "string" || root.trim() === "") {
    throw new TypeError("root is required");
  }

  const absoluteRoot = path.resolve(root);
  const paths = Object.freeze({
    jobs: path.join(absoluteRoot, "data", "jobs"),
    profile: path.join(absoluteRoot, "data", "browser-profile"),
    runtime: path.join(absoluteRoot, ".runtime"),
  });

  return Object.freeze({
    root: absoluteRoot,
    host: "127.0.0.1",
    port: parsePort(env.MANUAL_STUDIO_PORT),
    paths,
    versions: VERSION_PINS,
  });
}
