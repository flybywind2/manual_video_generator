import {
  randomBytes as secureRandomBytes,
  timingSafeEqual,
} from "node:crypto";

import { createOriginPolicy } from "../adapters/browser-runtime.js";
import { StudioError } from "../domain/errors.js";
import { findRecoveryAnchor } from "../domain/recovery-provenance.js";

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
    typeof browserRuntime?.sealAuthentication !== "function" ||
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

function readReexecutionOptions(options) {
  try {
    if (
      options === null ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Reflect.ownKeys(options).some(
        (key) => typeof key !== "string" || !["planDigest", "mismatchSequence", "signal"].includes(key),
      )
    ) {
      throw new Error("options");
    }
    const planProperty = Object.getOwnPropertyDescriptor(options, "planDigest");
    const mismatchProperty = Object.getOwnPropertyDescriptor(options, "mismatchSequence");
    const signalProperty = Object.getOwnPropertyDescriptor(options, "signal");
    if (
      !planProperty ||
      !mismatchProperty ||
      !("value" in planProperty) ||
      !("value" in mismatchProperty) ||
      (signalProperty !== undefined && !("value" in signalProperty)) ||
      typeof planProperty.value !== "string" ||
      !/^[a-f0-9]{64}$/u.test(planProperty.value) ||
      !Number.isSafeInteger(mismatchProperty.value) ||
      mismatchProperty.value < 1 ||
      (signalProperty?.value !== undefined && !(signalProperty.value instanceof AbortSignal))
    ) {
      throw new Error("values");
    }
    return Object.freeze({
      planDigest: planProperty.value,
      mismatchSequence: mismatchProperty.value,
      signal: signalProperty?.value,
    });
  } catch {
    throw authenticationError(
      "REEXECUTION_OPTIONS_INVALID",
      "The reexecution authentication options are invalid.",
    );
  }
}

function sameDigest(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    /^[a-f0-9]{64}$/u.test(left) &&
    /^[a-f0-9]{64}$/u.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function assertReexecutionBinding(job, events, planDigest, mismatchSequence) {
  const latest = events?.at?.(-1);
  const mismatch = findRecoveryAnchor(events, {
    anchorEvent: "EXECUTION_MISMATCH",
    currentEventSequence: job?.eventSequence,
    currentState: "needs_review",
  });
  if (
    job?.state !== "needs_review" ||
    !Number.isSafeInteger(job.eventSequence) ||
    latest?.sequence !== job.eventSequence ||
    mismatch === null ||
    mismatch.sequence !== mismatchSequence ||
    !sameDigest(mismatch.data?.planDigest, planDigest) ||
    !sameDigest(latest?.data?.planDigest, planDigest)
  ) {
    throw authenticationError(
      "REEXECUTION_BINDING_INVALID",
      "The reexecution request is not bound to the current mismatch.",
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
  return Object.freeze({ request, mismatch });
}

function manualReexecutionBinding(job, events) {
  const authRequired = findRecoveryAnchor(events, {
    anchorEvent: "AUTH_REQUIRED",
    currentEventSequence: job?.eventSequence,
    currentState: "awaiting_manual_login",
  });
  const planDigest = authRequired?.data?.planDigest;
  const mismatchSequence = authRequired?.data?.mismatchSequence;
  if (
    job?.state !== "awaiting_manual_login" ||
    job.request?.authMode !== "manual" ||
    authRequired?.data?.reason !== "manual_reexecution" ||
    !/^[a-f0-9]{64}$/u.test(planDigest ?? "") ||
    !Number.isSafeInteger(mismatchSequence) ||
    mismatchSequence < 1
  ) {
    return null;
  }
  const authRequiredIndex = events.findIndex(
    ({ sequence }) => sequence === authRequired.sequence,
  );
  const authStart = events[authRequiredIndex - 1];
  if (
    authStart?.event !== "AUTHENTICATION_EXPIRED" ||
    authStart?.state !== "authenticating" ||
    authStart?.data?.reason !== "manual_reexecution" ||
    authStart?.data?.mismatchSequence !== mismatchSequence ||
    !sameDigest(authStart?.data?.planDigest, planDigest)
  ) {
    return null;
  }
  const beforeStart = events.slice(0, authRequiredIndex - 1);
  const previous = beforeStart.at(-1);
  const mismatch = findRecoveryAnchor(beforeStart, {
    anchorEvent: "EXECUTION_MISMATCH",
    currentEventSequence: previous?.sequence,
    currentState: "needs_review",
  });
  if (
    mismatch?.sequence !== mismatchSequence ||
    mismatch?.data?.report?.status !== "mismatch" ||
    !sameDigest(mismatch?.data?.planDigest, planDigest)
  ) {
    return null;
  }
  return Object.freeze({ planDigest, mismatchSequence });
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
        (key) =>
          typeof key !== "string" ||
          !["origin", "username", "password"].includes(key),
      )
    ) {
      throw new Error("invalid credentials");
    }
    const origin = Object.getOwnPropertyDescriptor(value, "origin");
    const username = Object.getOwnPropertyDescriptor(value, "username");
    const password = Object.getOwnPropertyDescriptor(value, "password");
    if (
      !origin ||
      !username ||
      !password ||
      !("value" in origin) ||
      !("value" in username) ||
      !("value" in password) ||
      typeof origin.value !== "string" ||
      typeof username.value !== "string" ||
      typeof password.value !== "string"
    ) {
      throw new Error("invalid credentials");
    }
    const parsedOrigin = new URL(origin.value);
    if (
      !["http:", "https:"].includes(parsedOrigin.protocol) ||
      parsedOrigin.username !== "" ||
      parsedOrigin.password !== "" ||
      parsedOrigin.pathname !== "/" ||
      parsedOrigin.search !== "" ||
      parsedOrigin.hash !== "" ||
      parsedOrigin.origin !== origin.value
    ) {
      throw new Error("invalid credentials");
    }
    return {
      origin: parsedOrigin.origin,
      username: username.value,
      password: password.value,
    };
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
  if (
    automatic &&
    (!Array.isArray(request.authOrigins ?? []) || (request.authOrigins?.length ?? 0) > 1)
  ) {
    throw authenticationError(
      "AUTHENTICATION_REQUEST_INVALID",
      "Automatic authentication requires one unambiguous credential origin.",
    );
  }
  const originPolicy = createOriginPolicy({
    targetOrigin: target.origin,
    authOrigins: request.authOrigins ?? [],
    resourceOrigins: request.resourceOrigins ?? [],
  });
  const loginOrigin = originPolicy.authOrigins[0] ?? originPolicy.targetOrigin;
  if (automatic && credentials.origin !== loginOrigin) {
    throw authenticationError(
      "AUTHENTICATION_CREDENTIAL_ORIGIN_MISMATCH",
      "The stored credential is not approved for this login origin.",
    );
  }
  return {
    id: job.id,
    targetUrl: target.href,
    originPolicy,
    blockedOrigins: [],
    auth: automatic
      ? {
          mode: "automatic",
          loginOrigin,
          username: credentials.username,
          password: credentials.password,
        }
      : { mode: "manual" },
  };
}

function currentOwner(target, type) {
  try {
    if (type === "browser" && "active" in target) {
      return { known: true, jobId: target.active?.jobId ?? null };
    }
    if (type === "opencode" && "activeJobId" in target) {
      return { known: true, jobId: target.activeJobId ?? null };
    }
    if (type === "opencode" && "active" in target) {
      return { known: true, jobId: target.active?.jobId ?? null };
    }
  } catch {
    return { known: false, jobId: null };
  }
  return { known: false, jobId: null };
}

async function stopOwnedRuntimes(
  browserRuntime,
  openCodeServer,
  operation,
  jobId,
) {
  const browserOwner = currentOwner(browserRuntime, "browser");
  const openCodeOwner = currentOwner(openCodeServer, "opencode");
  if (
    operation?.browserOwned &&
    browserOwner.known &&
    typeof browserOwner.jobId === "string" &&
    browserOwner.jobId !== jobId
  ) {
    operation.browserOwned = false;
  }
  if (
    operation?.openCodeOwned &&
    openCodeOwner.known &&
    typeof openCodeOwner.jobId === "string" &&
    openCodeOwner.jobId !== jobId
  ) {
    operation.openCodeOwned = false;
  }
  const targets = [
    ...(operation?.openCodeOwned
      ? [{ key: "openCodeOwned", stop: () => openCodeServer.stop() }]
      : []),
    ...(operation?.browserOwned
      ? [{ key: "browserOwned", stop: () => browserRuntime.stop() }]
      : []),
  ];
  const results = await Promise.allSettled(
    targets.map(({ stop }) => Promise.resolve().then(stop)),
  );
  results.forEach((result, index) => {
    if (result.status === "fulfilled") operation[targets[index].key] = false;
  });
  return results.every(({ status }) => status === "fulfilled");
}

export function createAuthenticationWorkflow(options) {
  const settings = validateDependencies(options);
  const operations = new Map();
  let closed = false;
  let closing = null;

  const assertOpen = () => {
    if (closed) {
      throw authenticationError(
        "AUTHENTICATION_CLOSED",
        "The authentication workflow is closed.",
      );
    }
  };

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
        ? await stopOwnedRuntimes(
            settings.browserRuntime,
            settings.openCodeServer,
            operation,
            jobId,
          )
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

  const cleanupAuthentication = (jobId) => {
    const operation = operations.get(jobId);
    if (operation === undefined) return Promise.resolve();
    if (operation.cleanupPromise !== null) return operation.cleanupPromise;
    operation.cleanupPromise = Promise.resolve().then(async () => {
      operation.controller.abort(
        authenticationError(
          "AUTHENTICATION_CLEANUP",
          "Authentication ownership was released.",
        ),
      );
      const stopped = await stopOwnedRuntimes(
        settings.browserRuntime,
        settings.openCodeServer,
        operation,
        jobId,
      );
      if (!stopped) {
        throw authenticationError(
          "AUTHENTICATION_CLEANUP_FAILED",
          "Authentication cleanup could not be completed safely.",
        );
      }
      releaseOperation(jobId, operation);
    });
    return operation.cleanupPromise;
  };

  const close = () => {
    if (closing !== null) return closing;
    closed = true;
    const cancellations = [...operations.keys()].map((jobId) =>
      cancelAuthentication(jobId),
    );
    closing = Promise.allSettled(cancellations).then((results) => {
      if (results.some(({ status }) => status === "rejected")) {
        throw authenticationError(
          "AUTHENTICATION_CLEANUP_FAILED",
          "Authentication shutdown could not be completed safely.",
        );
      }
    });
    return closing;
  };

  return Object.freeze({
    async prepareReexecution(jobId, options) {
      const {
        planDigest,
        mismatchSequence,
        signal: externalSignal,
      } = readReexecutionOptions(options);
      assertOpen();
      if (typeof settings.jobStore.readEvents !== "function") {
        throw authenticationError(
          "AUTHENTICATION_CONFIGURATION_INVALID",
          "The authentication workflow is not configured safely.",
        );
      }
      const [job, events] = await Promise.all([
        settings.jobStore.load(jobId),
        settings.jobStore.readEvents(jobId, 0),
      ]);
      assertOpen();
      const { request } = assertReexecutionBinding(
        job,
        events,
        planDigest,
        mismatchSequence,
      );
      if (externalSignal?.aborted) {
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

      const recoveryData = Object.freeze({
        reason: "manual_reexecution",
        planDigest,
        mismatchSequence,
      });
      if (request.authMode === "manual") {
        if (typeof settings.jobStore.compareAndTransition !== "function") {
          throw authenticationError(
            "AUTHENTICATION_CONFIGURATION_INVALID",
            "The authentication workflow is not configured safely.",
          );
        }
        await settings.jobStore.compareAndTransition(jobId, {
          expectedState: "needs_review",
          expectedEventSequence: job.eventSequence,
          expectedPlanDigest: planDigest,
          eventName: "AUTHENTICATION_EXPIRED",
          data: recoveryData,
        });
      }

      const controller = new AbortController();
      const signal = externalSignal
        ? AbortSignal.any([controller.signal, externalSignal])
        : controller.signal;
      const operation = {
        browserOwned: false,
        controller,
        externalSignal,
        onExternalAbort: null,
        cancelPromise: null,
        cleanupPromise: null,
        openCodeOwned: false,
      };
      operation.onExternalAbort = () => {
        cancelAuthentication(jobId).catch(() => {});
      };
      operations.set(jobId, operation);
      externalSignal?.addEventListener("abort", operation.onExternalAbort, {
        once: true,
      });

      let capability;
      let credentials = null;
      let runtimeJob = null;
      try {
        capability = capabilityFrom(settings.randomBytes);
        if (request.authMode === "automatic") {
          credentials = readCredentials(
            await settings.credentialVault.load(request.credentialId),
          );
        }
        runtimeJob = browserJob(job, request, credentials);
        await settings.browserRuntime.start(runtimeJob, {
          expectedOriginPolicyDigest: runtimeJob.originPolicy.digest,
          mcpCapabilityToken: capability,
          signal,
        });
        operation.browserOwned = true;
        if (request.authMode === "automatic") {
          await settings.browserRuntime.sealAuthentication(jobId);
        }
        runtimeJob = null;
        credentials = null;
        await settings.openCodeServer.startJob({
          jobId,
          mcpCapabilityToken: capability,
          signal,
        });
        operation.openCodeOwned = true;
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
        const stopped = await stopOwnedRuntimes(
          settings.browserRuntime,
          settings.openCodeServer,
          operation,
          jobId,
        );
        releaseOperation(jobId, operation);
        if (request.authMode === "manual") {
          const current = await settings.jobStore.load(jobId).catch(() => null);
          if (current?.state === "authenticating") {
            await settings.jobStore.transition(jobId, "AUTHENTICATION_FAILED", {
              reason: stopped ? "reexecution_authentication_failed" : "cleanup_failed",
              planDigest,
              mismatchSequence,
            }).catch(() => undefined);
          }
        }
        throw authenticationError(
          stopped
            ? "REEXECUTION_AUTHENTICATION_FAILED"
            : "AUTHENTICATION_CLEANUP_FAILED",
          stopped
            ? "A fresh authenticated browser session could not be prepared."
            : "Authentication cleanup could not be completed safely.",
          stopped,
        );
      } finally {
        capability = null;
        credentials = null;
        runtimeJob = null;
      }

      if (request.authMode === "manual") {
        try {
          return await settings.jobStore.transition(
            jobId,
            "AUTH_REQUIRED",
            recoveryData,
          );
        } catch (error) {
          await stopOwnedRuntimes(
            settings.browserRuntime,
            settings.openCodeServer,
            operation,
            jobId,
          );
          releaseOperation(jobId, operation);
          throw error;
        }
      }
      return Object.freeze({
        state: job.state,
        planDigest,
        mismatchSequence,
      });
    },

    async startAuthentication(jobId, options) {
      const { signal: externalSignal } = readStartOptions(options);
      assertOpen();
      const job = await settings.jobStore.load(jobId);
      assertOpen();
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
        browserOwned: false,
        controller,
        externalSignal,
        onExternalAbort: null,
        cancelPromise: null,
        cleanupPromise: null,
        openCodeOwned: false,
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
        operation.browserOwned = true;
        runtimeJob = null;
        credentials = null;
        if (request.authMode === "automatic") {
          await settings.browserRuntime.sealAuthentication(jobId);
        }
        await settings.openCodeServer.startJob({
          jobId,
          mcpCapabilityToken: capability,
          signal,
        });
        operation.openCodeOwned = true;
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
        const stopped = await stopOwnedRuntimes(
          settings.browserRuntime,
          settings.openCodeServer,
          operation,
          jobId,
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
        await stopOwnedRuntimes(
          settings.browserRuntime,
          settings.openCodeServer,
          operation,
          jobId,
        );
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
      let reexecution = null;
      if (typeof settings.jobStore.readEvents === "function") {
        const events = await settings.jobStore.readEvents(jobId, 0);
        const authRequired = findRecoveryAnchor(events, {
          anchorEvent: "AUTH_REQUIRED",
          currentEventSequence: job.eventSequence,
          currentState: "awaiting_manual_login",
        });
        if (authRequired?.data?.reason === "manual_reexecution") {
          reexecution = manualReexecutionBinding(job, events);
          if (reexecution === null) {
            throw authenticationError(
              "REEXECUTION_BINDING_INVALID",
              "The manual login is not bound to the current mismatch.",
            );
          }
        }
      }
      await settings.browserRuntime.sealAuthentication(jobId);
      return settings.jobStore.transition(
        jobId,
        reexecution === null ? "CONFIRM_LOGIN" : "CONFIRM_REEXECUTION_LOGIN",
        reexecution === null
          ? { confirmed: true }
          : { confirmed: true, ...reexecution },
      );
    },

    releaseAuthentication(jobId) {
      const operation = operations.get(jobId);
      if (operation === undefined) return false;
      releaseOperation(jobId, operation);
      return true;
    },

    cancelAuthentication,
    cleanupAuthentication,
    close,
  });
}
