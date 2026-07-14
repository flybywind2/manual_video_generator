import { StudioError } from "../domain/errors.js";

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const FORBIDDEN_JOB_IDS = new Set([
  "__proto__",
  "aux",
  "clock$",
  "con",
  "constructor",
  "nul",
  "prn",
  "prototype",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

function assertJobId(jobId) {
  if (
    typeof jobId !== "string" ||
    !JOB_ID.test(jobId) ||
    FORBIDDEN_JOB_IDS.has(jobId.toLowerCase())
  ) {
    throw new StudioError("The queue job identifier is invalid.", {
      code: "INVALID_JOB_ID",
      stage: "queue",
      retryable: false,
      details: { reason: "invalid_identifier" },
    });
  }
  return jobId;
}

export class ExecutionLock {
  #activeJobId = null;
  #queuedJobId = null;

  acquire(jobId) {
    const validId = assertJobId(jobId);
    if (this.#activeJobId === validId) {
      return "active";
    }
    if (this.#queuedJobId === validId) {
      return "queued";
    }
    if (this.#activeJobId === null) {
      this.#activeJobId = validId;
      return "active";
    }
    if (this.#queuedJobId === null) {
      this.#queuedJobId = validId;
      return "queued";
    }
    throw new StudioError("The browser execution queue is full.", {
      code: "QUEUE_FULL",
      stage: "queue",
      retryable: true,
    });
  }

  release(jobId) {
    const validId = assertJobId(jobId);
    if (this.#activeJobId === validId) {
      this.#activeJobId = this.#queuedJobId;
      this.#queuedJobId = null;
    }
    return this.snapshot();
  }

  cancel(jobId) {
    const validId = assertJobId(jobId);
    if (this.#activeJobId === validId) {
      this.#activeJobId = this.#queuedJobId;
      this.#queuedJobId = null;
    } else if (this.#queuedJobId === validId) {
      this.#queuedJobId = null;
    }
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      activeJobId: this.#activeJobId,
      queuedJobId: this.#queuedJobId,
    });
  }
}
