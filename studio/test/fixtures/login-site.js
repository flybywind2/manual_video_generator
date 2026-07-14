import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../../src/jobs/event-bus.js";
import { JobStore } from "../../src/jobs/job-store.js";
import { createApp } from "../../src/server/app.js";

export const FIXTURE_USERNAME = "demo";
export const FIXTURE_PASSWORD = "manual-video-demo";

export async function startTestStudio(t, options = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "manual-studio-http-"));
  const jobsRoot = join(temporary, "jobs");
  const store = options.store ?? new JobStore({
    root: jobsRoot,
    now: options.now,
    randomId: options.randomId,
  });
  const eventBus = options.eventBus ?? new EventBus({ store });
  const app = createApp({
    jobStore: store,
    eventBus,
    jobsRoot,
    publicRoot: options.publicRoot,
    healthCheck: options.healthCheck ?? (async () => ({
      ready: true,
      checks: {
        node: {
          status: "ready",
          expected: ">=22",
          actual: "24.13.1",
          secret: "must-not-leak",
        },
      },
      token: "must-not-leak",
    })),
    maxJsonBytes: options.maxJsonBytes,
    credentialVault: options.credentialVault,
    studioService: options.studioService,
    scheduleBackground: options.scheduleBackground,
  });

  await new Promise((resolve, reject) => {
    app.once("error", reject);
    app.listen(0, "127.0.0.1", resolve);
  });
  const address = app.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise((resolve) => {
      app.close(resolve);
      app.closeAllConnections();
    });
    await store.close();
    await rm(temporary, { force: true, recursive: true });
  });

  return { app, baseUrl, eventBus, jobsRoot, store, temporary };
}

export function sessionCookie(response) {
  const header = response.headers.get("set-cookie");
  return header?.split(";", 1)[0] ?? null;
}
