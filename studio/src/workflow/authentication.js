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

function readStartOptions(options) {
  if (options === undefined) return Object.freeze({ signal: undefined });
  try {
    if (
      options === null ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Reflect.ownKeys(options).some((key) => key !== "signal")
    ) {
      throw new Error("options");
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, "signal");
    const signal = descriptor === undefined ? undefined : descriptor.value;
    if (
      (descriptor !== undefined && !("value" in descriptor)) ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    ) {
      throw new Error("signal");
    }
    return Object.freeze({ signal });
  } catch {
    throw authenticationError(
      "AUTHENTICATION_OPTIONS_INVALID",
      "The authentication options are invalid.",
    );
  }
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
  const operations = new Map();

  const releaseOperation = (jobId, operation) => {
    if (operations.get(jobId) !== operation) return;
    operation.externalSignal?.removeEventListener(
      "abort",
      operation.onExternalAbort,
    );
    operations.delete(jobId);
  };

  const cancelAuthentication = (jobId) => {
    const operation = operations.get(jobId);
    if (operation?.cancelPromise) return operation.cancelPromise;
    const cancellation = Promise.resolve().then(async () => {
      operation?.controller.abort(
        authenticationError(
          "AUTHENTICATION_CANCELLED",
          "Authentication was cancelled.",
        ),
      );
      const stopped = operation
        ? await stopRuntimes(settings.browserRuntime, settings.openCodeServer)
        : true;
      if (!stopped) {
        throw authenticationError(
          "AUTHENTICATION_CLEANUP_FAILED",
          "Authentication cleanup could not be completed safely.",
        );
      }
      const current = await settings.jobStore.load(jobId);
      if (current.state === "cancelled") return current;
      return settings.jobStore.transition(jobId, "CANCEL_JOB", {
        reason: "authentication_cancelled",
      });
    }).finally(() => {
      if (operation) releaseOperation(jobId, operation);
    });
    if (operation) operation.cancelPromise = cancellation;
    return cancellation;
  };

  return Object.freeze({
    async startAuthentication(jobId, options) {
      const { signal: externalSignal } = readStartOptions(options);
      const job = await settings.jobStore.load(jobId);
      const request = assertCreatedJob(job);
      if (externalSignal?.aborted) {
        await cancelAuthentication(jobId);
        throw authenticationError(
          "AUTHENTICATION_CANCELLED",
          "Authentication was cancelled.",
        );
      }
      if (operations.has(jobId)) {
        throw authenticationError(
          "AUTHENTICATION_STATE_INVALID",
          "Authentication is already active for this job.",
        );
      }
      const controller = new AbortController();
      const signal = externalSignal
        ? AbortSignal.any([controller.signal, externalSignal])
        : controller.signal;
      const operation = {
        controller,
        externalSignal,
        onExternalAbort: null,
        cancelPromise: null,
      };
      operation.onExternalAbort = () => {
        cancelAuthentication(jobId).catch(() => {});
      };
      operations.set(jobId, operation);
      externalSignal?.addEventListener("abort", operation.onExternalAbort, {
        once: true,
      });
      try {
        await settings.jobStore.transition(jobId, "START_AUTHENTICATION", {
          authMode: request.authMode,
        });
      } catch (error) {
        if (signal.aborted) {
          await cancelAuthentication(jobId).catch(() => {});
          throw authenticationError(
            "AUTHENTICATION_CANCELLED",
            "Authentication was cancelled.",
          );
        }
        releaseOperation(jobId, operation);
        throw error;
      }

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
          signal,
        });
        runtimeJob = null;
        credentials = null;
        await settings.openCodeServer.startJob({
          jobId,
          mcpCapabilityToken: capability,
          signal,
        });
        capability = null;
      } catch {
        capability = null;
        credentials = null;
        runtimeJob = null;
        if (signal.aborted) {
          await cancelAuthentication(jobId).catch(() => {});
          throw authenticationError(
            "AUTHENTICATION_CANCELLED",
            "Authentication was cancelled.",
          );
        }
        const stopped = await stopRuntimes(
          settings.browserRuntime,
          settings.openCodeServer,
        );
        releaseOperation(jobId, operation);
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
      try {
        return await settings.jobStore.transition(
          jobId,
          request.authMode === "manual" ? "AUTH_REQUIRED" : "AUTHENTICATED",
          request.authMode === "manual" ? { reason: "manual_login" } : {},
        );
      } catch (error) {
        if (signal.aborted) {
          await cancelAuthentication(jobId).catch(() => {});
          throw authenticationError(
            "AUTHENTICATION_CANCELLED",
            "Authentication was cancelled.",
          );
        }
        await stopRuntimes(settings.browserRuntime, settings.openCodeServer);
        releaseOperation(jobId, operation);
        throw error;
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

    releaseAuthentication(jobId) {
      const operation = operations.get(jobId);
      if (operation === undefined) return false;
      releaseOperation(jobId, operation);
      return true;
    },

    cancelAuthentication,
  });
}
