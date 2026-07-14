import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildConfig } from "./config.js";
import { EventBus } from "./jobs/event-bus.js";
import { JobStore } from "./jobs/job-store.js";
import { inspectRuntime } from "./preflight.js";
import { createApp } from "./server/app.js";

const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function startStudio({ root = STUDIO_ROOT, env = process.env, healthCheck } = {}) {
  const config = buildConfig({ root, env });
  const jobStore = new JobStore({ root: config.paths.jobs });
  const eventBus = new EventBus({ store: jobStore });
  const app = createApp({
    jobStore,
    eventBus,
    jobsRoot: config.paths.jobs,
    publicRoot: resolve(config.root, "public"),
    healthCheck: healthCheck ?? (() => inspectRuntime({ config })),
  });
  try {
    await new Promise((resolveListen, reject) => {
      app.once("error", reject);
      app.listen(config.port, config.host, resolveListen);
    });
  } catch (error) {
    await jobStore.close();
    throw error;
  }

  let closing;
  const close = () => {
    if (closing !== undefined) {
      return closing;
    }
    closing = (async () => {
      await new Promise((resolveClose, reject) => {
        app.close((error) => error ? reject(error) : resolveClose());
        app.closeAllConnections();
      });
      await jobStore.close();
    })();
    return closing;
  };
  return Object.freeze({ app, close, config, eventBus, jobStore });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    const studio = await startStudio();
    console.log(`Manual Video Studio: http://${studio.config.host}:${studio.config.port}`);
    let stopping = false;
    const stop = async () => {
      if (stopping) {
        return;
      }
      stopping = true;
      try {
        await studio.close();
        process.exitCode = 0;
      } catch {
        process.exitCode = 1;
      }
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch {
    console.error("Manual Video Studio could not start.");
    process.exitCode = 1;
  }
}
