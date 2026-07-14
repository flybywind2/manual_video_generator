import { StudioError } from "../domain/errors.js";

function supervisorError() {
  return new StudioError("The background task supervisor is closed.", {
    code: "TASK_SUPERVISOR_CLOSED",
    stage: "server",
    retryable: false,
  });
}

export class TaskSupervisor {
  #controller = new AbortController();
  #tasks = new Set();
  #onError;
  #closing = null;
  #closed = false;

  constructor({ onError = () => undefined } = {}) {
    if (typeof onError !== "function") {
      throw new TypeError("onError must be a function");
    }
    this.#onError = onError;
  }

  get pendingCount() {
    return this.#tasks.size;
  }

  schedule(operation) {
    if (this.#closed) throw supervisorError();
    if (typeof operation !== "function") {
      throw new TypeError("background operation must be a function");
    }
    let tracked;
    tracked = Promise.resolve()
      .then(() => operation(this.#controller.signal))
      .catch((error) => {
        try {
          this.#onError(error);
        } catch {
          // Background error reporting must never replace the task failure.
        }
        throw error;
      })
      .finally(() => {
        this.#tasks.delete(tracked);
      });
    this.#tasks.add(tracked);
    tracked.catch(() => undefined);
    return tracked;
  }

  close() {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    this.#controller.abort(supervisorError());
    const pending = [...this.#tasks];
    this.#closing = Promise.allSettled(pending);
    return this.#closing;
  }
}

