import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  OPEN_CODE_FALLBACK_VERSION,
  OPEN_CODE_MINIMUM_VERSION,
  resolveOpenCodeInstallation,
} from "../src/runtime/opencode-installation.js";

function readyReport(selection) {
  return {
    ready: true,
    minimum: OPEN_CODE_MINIMUM_VERSION,
    fallback: OPEN_CODE_FALLBACK_VERSION,
    path: selection.path,
    source: selection.source,
    version: selection.version,
  };
}

function unavailableReport() {
  return {
    ready: false,
    minimum: OPEN_CODE_MINIMUM_VERSION,
    fallback: OPEN_CODE_FALLBACK_VERSION,
    path: null,
    source: null,
    version: null,
    code: "OPENCODE_UNAVAILABLE",
  };
}

function writeReport(stdout, report) {
  stdout.write(`${JSON.stringify(report)}\n`);
}

function strictAbsoluteRoot(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_767 ||
    value.includes("\0") ||
    value.trim() !== value ||
    !path.isAbsolute(value) ||
    /^(?:\\\\|\/\/)[.?](?:\\|\/)/u.test(value) ||
    value.split(/[\\/]+/u).some((part) => part === "." || part === "..")
  ) {
    return null;
  }
  const normalized = path.resolve(value);
  return normalized === value ? normalized : null;
}

function sameCanonicalPath(left, right) {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

export async function runOpenCodeRuntimeCli({
  argv = process.argv.slice(2),
  environment = process.env,
  resolveInstallation = resolveOpenCodeInstallation,
  stdout = process.stdout,
} = {}) {
  const [mode, studioRoot, runtimeRoot] = argv;
  const normalizedStudioRoot = strictAbsoluteRoot(studioRoot);
  const normalizedRuntimeRoot = strictAbsoluteRoot(runtimeRoot);
  if (
    argv.length !== 3 ||
    (mode !== "check" && mode !== "prepare") ||
    normalizedStudioRoot === null ||
    normalizedRuntimeRoot === null ||
    !sameCanonicalPath(
      normalizedRuntimeRoot,
      path.join(normalizedStudioRoot, ".runtime", "opencode"),
    )
  ) {
    writeReport(stdout, unavailableReport());
    return 1;
  }

  const options = { mode, studioRoot, runtimeRoot, environment };
  if (Object.prototype.hasOwnProperty.call(environment, "MANUAL_STUDIO_OPENCODE_PATH")) {
    options.explicitPath = environment.MANUAL_STUDIO_OPENCODE_PATH;
  }
  try {
    const selection = await resolveInstallation(options);
    writeReport(stdout, readyReport(selection));
    return 0;
  } catch {
    writeReport(stdout, unavailableReport());
    return 1;
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  process.exitCode = await runOpenCodeRuntimeCli();
}
