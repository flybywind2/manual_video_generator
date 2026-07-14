import { StudioError } from "../domain/errors.js";
import { createAuthenticationWorkflow } from "./authentication.js";
import { createExecutionWorkflow } from "./execution.js";
import { createPlanningWorkflow } from "./planning.js";

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

function serviceError(code, message) {
  return new StudioError(message, {
    code,
    stage: "workflow",
    retryable: false,
  });
}

function validateWorkflow(workflow, methods, name) {
  if (
    workflow === null ||
    typeof workflow !== "object" ||
    methods.some((method) => typeof workflow[method] !== "function")
  ) {
    throw serviceError(
      "STUDIO_SERVICE_CONFIGURATION_INVALID",
      `The ${name} workflow is not configured safely.`,
    );
  }
  return workflow;
}

export class StudioService {
  #authentication;
  #execution;
  #jobStore;
  #planning;
  #production;
  #jobTails = new Map();

  constructor({
    authenticationWorkflow,
    executionWorkflow = null,
    jobStore = null,
    planningWorkflow,
    productionWorkflow = null,
  } = {}) {
    this.#authentication = validateWorkflow(
      authenticationWorkflow,
      ["startAuthentication", "confirmManualLogin", "cancelAuthentication"],
      "authentication",
    );
    this.#planning = validateWorkflow(
      planningWorkflow,
      ["createPlan", "updatePlan", "approvePlan", "restoreLatestPlan"],
      "planning",
    );
    this.#execution = executionWorkflow === null
      ? null
      : validateWorkflow(executionWorkflow, ["execute", "cancel"], "execution");
    this.#production = productionWorkflow === null
      ? null
      : validateWorkflow(
          productionWorkflow,
          ["preparePreview", "updateMediaPlan", "approvePreview", "cancel"],
          "production",
        );
    if (jobStore !== null && typeof jobStore?.load !== "function") {
      throw serviceError(
        "STUDIO_SERVICE_CONFIGURATION_INVALID",
        "The job store is not configured safely.",
      );
    }
    this.#jobStore = jobStore;
  }

  #required(workflow, name) {
    if (workflow === null) {
      throw serviceError(
        "STUDIO_SERVICE_CONFIGURATION_INVALID",
        `The ${name} workflow is not configured safely.`,
      );
    }
    return workflow;
  }

  #serialize(jobId, operation) {
    if (typeof jobId !== "string" || !JOB_ID.test(jobId)) {
      return Promise.reject(
        serviceError("STUDIO_SERVICE_JOB_INVALID", "The job identifier is invalid."),
      );
    }
    const previous = this.#jobTails.get(jobId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#jobTails.set(jobId, tail);
    tail.then(() => {
      if (this.#jobTails.get(jobId) === tail) {
        this.#jobTails.delete(jobId);
      }
    });
    return result;
  }

  startAuthentication(jobId, options) {
    return this.#serialize(jobId, () =>
      this.#authentication.startAuthentication(jobId, options));
  }

  authenticateAndPlan(jobId, options) {
    return this.#serialize(jobId, async () => {
      const authenticated = await this.#authentication.startAuthentication(jobId, options);
      return authenticated?.state === "planning"
        ? this.#planning.createPlan(jobId)
        : authenticated;
    });
  }

  cancelAuthentication(jobId) {
    if (typeof jobId !== "string" || !JOB_ID.test(jobId)) {
      return Promise.reject(
        serviceError("STUDIO_SERVICE_JOB_INVALID", "The job identifier is invalid."),
      );
    }
    return this.#authentication.cancelAuthentication(jobId);
  }

  confirmManualLogin(jobId) {
    return this.#serialize(jobId, () =>
      this.#authentication.confirmManualLogin(jobId));
  }

  confirmManualLoginAndPlan(jobId) {
    return this.#serialize(jobId, async () => {
      const authenticated = await this.#authentication.confirmManualLogin(jobId);
      return authenticated?.state === "planning"
        ? this.#planning.createPlan(jobId)
        : authenticated;
    });
  }

  createPlan(jobId) {
    return this.#serialize(jobId, () => this.#planning.createPlan(jobId));
  }

  updatePlan(jobId, plan, expectedCurrentDigest) {
    return this.#serialize(jobId, () =>
      this.#planning.updatePlan(jobId, plan, expectedCurrentDigest));
  }

  approvePlan(jobId, expectedPlanDigest) {
    return this.#serialize(jobId, () =>
      this.#planning.approvePlan(jobId, expectedPlanDigest));
  }

  restoreLatestPlan(jobId) {
    return this.#serialize(jobId, () => this.#planning.restoreLatestPlan(jobId));
  }

  execute(jobId, expectedPlanDigest, options = {}) {
    return this.#serialize(jobId, async () => {
      const execution = this.#required(this.#execution, "execution");
      let result;
      try {
        result = await execution.execute(jobId, expectedPlanDigest, options);
      } finally {
        this.#authentication.releaseAuthentication?.(jobId);
      }
      if (result?.report?.status !== "completed") {
        return result;
      }
      const production = this.#required(this.#production, "production");
      return production.preparePreview(jobId, {
        report: result.report,
        signal: options?.signal,
      });
    });
  }

  updateMediaPlan(jobId, edit) {
    return this.#serialize(jobId, () =>
      this.#required(this.#production, "production").updateMediaPlan(jobId, edit));
  }

  approvePreview(jobId, expectedPreviewDigest, options = {}) {
    return this.#serialize(jobId, () =>
      this.#required(this.#production, "production").approvePreview(
        jobId,
        expectedPreviewDigest,
        options,
      ));
  }

  async cancelJob(jobId) {
    if (typeof jobId !== "string" || !JOB_ID.test(jobId)) {
      throw serviceError("STUDIO_SERVICE_JOB_INVALID", "The job identifier is invalid.");
    }
    if (this.#jobStore === null) {
      throw serviceError(
        "STUDIO_SERVICE_CONFIGURATION_INVALID",
        "The job store is not configured safely.",
      );
    }
    const current = await this.#jobStore.load(jobId);
    if (["cancelled", "completed"].includes(current.state)) return current;
    if (["executing", "needs_review"].includes(current.state)) {
      return this.#required(this.#execution, "execution").cancel(jobId);
    }
    if (["narrating", "composing", "preview_review", "rendering"].includes(current.state)) {
      return this.#required(this.#production, "production").cancel(jobId);
    }
    return this.#authentication.cancelAuthentication(jobId);
  }
}

export function createStudioService(options = {}) {
  const authenticationWorkflow =
    options.authenticationWorkflow ?? createAuthenticationWorkflow(options);
  const planningWorkflow =
    options.planningWorkflow ?? createPlanningWorkflow(options);
  const hasExecutionDependencies =
    options.browserRuntime !== undefined &&
    options.executionLock !== undefined &&
    options.openCodeServer !== undefined &&
    options.opencodePath !== undefined;
  const executionWorkflow = options.executionWorkflow ??
    (hasExecutionDependencies ? createExecutionWorkflow(options) : null);
  return new StudioService({
    authenticationWorkflow,
    executionWorkflow,
    jobStore: options.jobStore ?? null,
    planningWorkflow,
    productionWorkflow: options.productionWorkflow ?? null,
  });
}
