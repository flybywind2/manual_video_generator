import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildConfig } from "../src/config.js";
import { inspectRuntime } from "../src/preflight.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = buildConfig({ root, env: process.env });
const report = await inspectRuntime({ config });

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ready ? 0 : 1;
