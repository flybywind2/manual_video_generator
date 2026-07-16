import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildConfig } from "../src/config.js";
import { inspectRuntime } from "../src/preflight.js";
import { resolveOpenCodeInstallation } from "../src/runtime/opencode-installation.js";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildDoctorReport({
  root = defaultRoot,
  processEnvironment = process.env,
  inspect = inspectRuntime,
  resolveInstallation = resolveOpenCodeInstallation,
} = {}) {
  const config = buildConfig({ root, env: processEnvironment });
  const runtimeRoot = path.join(root, ".runtime", "opencode");
  const hasSelectedPath = Object.prototype.hasOwnProperty.call(
    processEnvironment,
    "MANUAL_STUDIO_OPENCODE_PATH",
  );
  const hasSelectedVersion = Object.prototype.hasOwnProperty.call(
    processEnvironment,
    "MANUAL_STUDIO_OPENCODE_VERSION",
  );
  const environment = {};

  if (hasSelectedPath) {
    environment.MANUAL_STUDIO_OPENCODE_PATH = processEnvironment.MANUAL_STUDIO_OPENCODE_PATH;
  }
  if (hasSelectedVersion) {
    environment.MANUAL_STUDIO_OPENCODE_VERSION = processEnvironment.MANUAL_STUDIO_OPENCODE_VERSION;
  }

  try {
    const options = {
      mode: "check",
      studioRoot: root,
      runtimeRoot,
      environment: processEnvironment,
      ...(hasSelectedPath
        ? { explicitPath: processEnvironment.MANUAL_STUDIO_OPENCODE_PATH }
        : {}),
    };
    const selection = await resolveInstallation(options);
    if (!hasSelectedPath && !hasSelectedVersion) {
      environment.MANUAL_STUDIO_OPENCODE_PATH = selection.path;
      environment.MANUAL_STUDIO_OPENCODE_VERSION = selection.version;
    }
  } catch {
    if (!hasSelectedPath && !hasSelectedVersion) {
      environment.MANUAL_STUDIO_OPENCODE_PATH = "";
      environment.MANUAL_STUDIO_OPENCODE_VERSION = "";
    }
  }

  return inspect({ config, environment });
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  const report = await buildDoctorReport();

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ready ? 0 : 1;
}
