import { StudioError } from "../domain/errors.js";
import { createAuthenticationWorkflow } from "./authentication.js";
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
  #planning;
  #jobTails = new Map();

  constructor({ authenticationWorkflow, planningWorkflow } = {}) {
    this.#authentication = validateWorkflow(
      authenticationWorkflow,
      ["startAuthentication", "confirmManualLogin"],
      "authentication",
    );
    this.#planning = validateWorkflow(
      planningWorkflow,
      ["createPlan", "updatePlan", "approvePlan", "restoreLatestPlan"],
      "planning",
    );
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

  startAuthentication(jobId) {
    return this.#serialize(jobId, () =>
      this.#authentication.startAuthentication(jobId));
  }

  confirmManualLogin(jobId) {
    return this.#serialize(jobId, () =>
      this.#authentication.confirmManualLogin(jobId));
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
}

export function createStudioService(options = {}) {
  const authenticationWorkflow =
    options.authenticationWorkflow ?? createAuthenticationWorkflow(options);
  const planningWorkflow =
    options.planningWorkflow ?? createPlanningWorkflow(options);
  return new StudioService({ authenticationWorkflow, planningWorkflow });
}
