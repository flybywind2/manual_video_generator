import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildConfig } from "./config.js";
import { cleanupStaleBrowserProfiles } from "./browser/stale-profile-cleanup.js";
import { EventBus } from "./jobs/event-bus.js";
import { JobStore } from "./jobs/job-store.js";
import { TaskSupervisor } from "./jobs/task-supervisor.js";
import { createMediaProducer } from "./media/producer.js";
import { inspectServiceHealth } from "./preflight.js";
import { createProductionRuntime } from "./runtime.js";
import { createApp } from "./server/app.js";
import { ProductionWorkflow } from "./workflow/production.js";
import { reconcileInterruptedJobs } from "./workflow/restart-recovery.js";
import { createStudioService } from "./workflow/studio-service.js";

const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function startStudio({
  root = STUDIO_ROOT,
  env = process.env,
  healthCheck,
  runtimeFactory,
  serviceFactory = createStudioService,
} = {}) {
  const config = buildConfig({ root, env });
  const jobStore = new JobStore({ root: config.paths.jobs });
  const eventBus = new EventBus({ store: jobStore });
  const taskSupervisor = new TaskSupervisor();
  const shouldCreateRuntime = runtimeFactory !== undefined || healthCheck === undefined;
  const createRuntime = runtimeFactory ?? createProductionRuntime;
  if (typeof createRuntime !== "function") {
    await jobStore.close();
    throw new TypeError("runtimeFactory must be a function");
  }
  if (typeof serviceFactory !== "function") {
    await jobStore.close();
    throw new TypeError("serviceFactory must be a function");
  }

  let runtime = null;
  let studioService = null;
  let app;
  try {
    await reconcileInterruptedJobs(jobStore);
    await cleanupStaleBrowserProfiles(config.root);
    if (shouldCreateRuntime) {
      runtime = await createRuntime({
        config,
        env,
        producerFactory: ({ adapters }) => createMediaProducer({
          jobStore,
          jobsRoot: config.paths.jobs,
          templatePath: resolve(config.root, "templates", "hyperframes", "index.html"),
          ffmpeg: adapters.ffmpeg,
          hyperframes: adapters.hyperframes,
          qualityGate: adapters.qualityGate,
          supertonicBaseUrl: "http://127.0.0.1:7788",
        }),
      });
      const productionWorkflow = new ProductionWorkflow({
        jobStore,
        producer: runtime.runtime.producer,
      });
      studioService = serviceFactory({
        jobStore,
        browserRuntime: runtime.runtime.browserRuntime,
        credentialVault: runtime.runtime.credentialVault,
        executionLock: runtime.runtime.executionLock,
        openCodeServer: runtime.runtime.openCodeServer,
        opencodePath: runtime.paths.opencode,
        productionWorkflow,
      });
    }

    app = createApp({
      jobStore,
      eventBus,
      jobsRoot: config.paths.jobs,
      publicRoot: resolve(config.root, "public"),
      healthCheck: healthCheck ?? (() => inspectServiceHealth({ config })),
      credentialVault: runtime?.runtime.credentialVault ?? null,
      studioService,
      scheduleBackground: (operation) => taskSupervisor.schedule(operation),
    });
    await new Promise((resolveListen, reject) => {
      app.once("error", reject);
      app.listen(config.port, config.host, resolveListen);
    });
  } catch (error) {
    await Promise.allSettled([
      taskSupervisor.close(),
      studioService?.close(),
    ]);
    await runtime?.close().catch(() => undefined);
    await jobStore.close().catch(() => undefined);
    throw error;
  }

  let closing;
  const close = () => {
    if (closing !== undefined) {
      return closing;
    }
    closing = (async () => {
      const failures = [];
      try {
        await new Promise((resolveClose, reject) => {
          app.close((error) => error ? reject(error) : resolveClose());
          app.closeAllConnections();
        });
      } catch (error) {
        failures.push(error);
      }
      const results = await Promise.allSettled([
        taskSupervisor.close(),
        studioService?.close(),
      ]);
      failures.push(...results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason));
      try {
        await runtime?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await jobStore.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Manual Video Studio did not close cleanly.");
      }
    })();
    return closing;
  };
  return Object.freeze({
    app,
    close,
    config,
    eventBus,
    jobStore,
    runtime,
    studioService,
    taskSupervisor,
  });
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
