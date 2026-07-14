import { randomBytes as secureRandomBytes } from "node:crypto";

import { createOriginPolicy } from "../adapters/browser-runtime.js";
import { StudioError } from "../domain/errors.js";

function authenticationError(code, message, retryable = false) {
  return new StudioError(message, {
    code,
    stage: "authenticating",
    retryable,
  });
}

function validateDependencies(options) {
  const {
    browserRuntime,
    credentialVault,
    jobStore,
    openCodeServer,
    randomBytes = secureRandomBytes,
  } = options ?? {};
  if (
    typeof browserRuntime?.start !== "function" ||
    typeof browserRuntime?.stop !== "function" ||
    typeof credentialVault?.load !== "function" ||
    typeof jobStore?.load !== "function" ||
    typeof jobStore?.transition !== "function" ||
    typeof openCodeServer?.startJob !== "function" ||
    typeof openCodeServer?.stop !== "function" ||
    typeof randomBytes !== "function"
  ) {
    throw authenticationError(
      "AUTHENTICATION_CONFIGURATION_INVALID",
      "The authentication workflow is not configured safely.",
    );
  }
  return { browserRuntime, credentialVault, jobStore, openCodeServer, randomBytes };
}

function assertCreatedJob(job) {
  if (job?.state !== "created") {
    throw authenticationError(
      "AUTHENTICATION_STATE_INVALID",
      "Authentication cannot start from the current job state.",
    );
  }
  const request = job.request;
  if (
    request === null ||
    typeof request !== "object" ||
    typeof request.targetUrl !== "string" ||
    !["manual", "automatic"].includes(request.authMode) ||
    (request.authMode === "automatic" && typeof request.credentialId !== "string")
  ) {
    throw authenticationError(
      "AUTHENTICATION_REQUEST_INVALID",
      "The authentication request is invalid.",
    );
  }
  return request;
}

function capabilityFrom(randomBytes) {
  const bytes = randomBytes(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    throw authenticationError(
      "AUTHENTICATION_CAPABILITY_FAILED",
      "The job capability could not be generated safely.",
    );
  }
  return bytes.toString("base64url");
}

function readCredentials(value) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(
        (key) => typeof key !== "string" || !["username", "password"].includes(key),
      )
    ) {
      throw new Error("invalid credentials");
    }
    const username = Object.getOwnPropertyDescriptor(value, "username");
    const password = Object.getOwnPropertyDescriptor(value, "password");
    if (
      !username ||
      !password ||
      !("value" in username) ||
      !("value" in password) ||
      typeof username.value !== "string" ||
      typeof password.value !== "string"
    ) {
      throw new Error("invalid credentials");
    }
    return { username: username.value, password: password.value };
  } catch {
    throw authenticationError(
      "AUTHENTICATION_CREDENTIALS_INVALID",
      "The stored credentials are invalid.",
    );
  }
}

function browserJob(job, request, credentials) {
  let target;
  try {
    target = new URL(request.targetUrl);
  } catch {
    throw authenticationError(
      "AUTHENTICATION_REQUEST_INVALID",
      "The authentication request is invalid.",
    );
  }
  const automatic = request.authMode === "automatic";
  const originPolicy = createOriginPolicy({
    targetOrigin: target.origin,
    authOrigins: automatic ? [target.origin] : [],
  });
  return {
    id: job.id,
    targetUrl: target.href,
    originPolicy,
    blockedOrigins: [],
    auth: automatic
      ? {
          mode: "automatic",
          loginOrigin: target.origin,
          username: credentials.username,
          password: credentials.password,
        }
      : { mode: "manual" },
  };
}

async function stopRuntimes(browserRuntime, openCodeServer) {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => openCodeServer.stop()),
    Promise.resolve().then(() => browserRuntime.stop()),
  ]);
  return results.every(({ status }) => status === "fulfilled");
}

export function createAuthenticationWorkflow(options) {
  const settings = validateDependencies(options);

  return Object.freeze({
    async startAuthentication(jobId) {
      const job = await settings.jobStore.load(jobId);
      const request = assertCreatedJob(job);
      await settings.jobStore.transition(jobId, "START_AUTHENTICATION", {
        authMode: request.authMode,
      });

      let capability;
      let credentials = null;
      let runtimeJob = null;
      try {
        capability = capabilityFrom(settings.randomBytes);
        if (request.authMode === "automatic") {
          const loaded = await settings.credentialVault.load(request.credentialId);
          credentials = readCredentials(loaded);
        }
        runtimeJob = browserJob(job, request, credentials);
        await settings.browserRuntime.start(runtimeJob, {
          expectedOriginPolicyDigest: runtimeJob.originPolicy.digest,
          mcpCapabilityToken: capability,
        });
        runtimeJob = null;
        credentials = null;
        await settings.openCodeServer.startJob({
          jobId,
          mcpCapabilityToken: capability,
        });
        capability = null;

        return await settings.jobStore.transition(
          jobId,
          request.authMode === "manual" ? "AUTH_REQUIRED" : "AUTHENTICATED",
          request.authMode === "manual" ? { reason: "manual_login" } : {},
        );
      } catch {
        capability = null;
        credentials = null;
        runtimeJob = null;
        const stopped = await stopRuntimes(
          settings.browserRuntime,
          settings.openCodeServer,
        );
        try {
          await settings.jobStore.transition(jobId, "AUTHENTICATION_FAILED", {
            reason: stopped ? "authentication_failed" : "cleanup_failed",
          });
        } catch {
          // The durable store remains authoritative if its transition also fails.
        }
        throw authenticationError(
          stopped ? "AUTHENTICATION_FAILED" : "AUTHENTICATION_CLEANUP_FAILED",
          stopped
            ? "Authentication could not be completed."
            : "Authentication cleanup could not be completed safely.",
          stopped,
        );
      } finally {
        capability = null;
        credentials = null;
        runtimeJob = null;
      }
    },

    async confirmManualLogin(jobId) {
      const job = await settings.jobStore.load(jobId);
      if (
        job.state !== "awaiting_manual_login" ||
        job.request?.authMode !== "manual"
      ) {
        throw authenticationError(
          "AUTHENTICATION_STATE_INVALID",
          "Manual login cannot be confirmed from the current job state.",
        );
      }
      return settings.jobStore.transition(jobId, "CONFIRM_LOGIN", {
        confirmed: true,
      });
    },
  });
}
