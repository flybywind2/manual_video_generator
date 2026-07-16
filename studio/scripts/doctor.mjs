import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildConfig } from "../src/config.js";
import { inspectRuntime } from "../src/preflight.js";
import { resolveOpenCodeInstallation } from "../src/runtime/opencode-installation.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = buildConfig({ root, env: process.env });
const runtimeRoot = path.join(root, ".runtime", "opencode");
const hasSelectedPath = Object.prototype.hasOwnProperty.call(
  process.env,
  "MANUAL_STUDIO_OPENCODE_PATH",
);
const hasSelectedVersion = Object.prototype.hasOwnProperty.call(
  process.env,
  "MANUAL_STUDIO_OPENCODE_VERSION",
);
const environment = {};

if (hasSelectedPath) {
  environment.MANUAL_STUDIO_OPENCODE_PATH = process.env.MANUAL_STUDIO_OPENCODE_PATH;
}
if (hasSelectedVersion) {
  environment.MANUAL_STUDIO_OPENCODE_VERSION = process.env.MANUAL_STUDIO_OPENCODE_VERSION;
}

try {
  const options = {
    mode: "check",
    studioRoot: root,
    runtimeRoot,
    environment: process.env,
    ...(hasSelectedPath
      ? { explicitPath: process.env.MANUAL_STUDIO_OPENCODE_PATH }
      : {}),
  };
  const selection = await resolveOpenCodeInstallation(options);
  if (!hasSelectedPath && !hasSelectedVersion) {
    environment.MANUAL_STUDIO_OPENCODE_PATH = selection.path;
    environment.MANUAL_STUDIO_OPENCODE_VERSION = selection.version;
  }
} catch {
  // The sanitized preflight report below describes an unavailable selection.
}

const report = await inspectRuntime({ config, environment });

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ready ? 0 : 1;
