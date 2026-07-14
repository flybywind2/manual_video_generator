import { StudioError } from "../domain/errors.js";

function invalidSubscription(reason) {
  throw new StudioError("The event subscription is invalid.", {
    code: "INVALID_EVENT_SUBSCRIPTION",
    stage: "events",
    retryable: false,
    details: { reason },
  });
}

export class EventBus {
  #store;

  constructor({ store } = {}) {
    if (
      store === null ||
      typeof store !== "object" ||
      typeof store.onEvent !== "function" ||
      typeof store.readEvents !== "function"
    ) {
      invalidSubscription("event_store_required");
    }
    this.#store = store;
  }

  subscribe(jobId, afterSequence = 0, listener) {
    if (typeof jobId !== "string" || jobId.length === 0) {
      invalidSubscription("job_id_required");
    }
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      invalidSubscription("after_sequence_invalid");
    }
    if (typeof listener !== "function") {
      invalidSubscription("listener_required");
    }

    let closed = false;
    let replaying = true;
    let lastSequence = afterSequence;
    const buffered = new Map();

    const deliver = (event) => {
      if (
        closed ||
        event === null ||
        typeof event !== "object" ||
        event.jobId !== jobId ||
        !Number.isSafeInteger(event.sequence) ||
        event.sequence <= lastSequence
      ) {
        return;
      }
      lastSequence = event.sequence;
      try {
        Promise.resolve(listener(event)).catch(() => undefined);
      } catch {
        // A subscriber is never allowed to break persistence or its peers.
      }
    };

    const onLiveEvent = (event) => {
      if (
        closed ||
        event === null ||
        typeof event !== "object" ||
        event.jobId !== jobId ||
        !Number.isSafeInteger(event.sequence) ||
        event.sequence <= lastSequence
      ) {
        return;
      }
      if (replaying) {
        buffered.set(event.sequence, event);
      } else {
        deliver(event);
      }
    };

    const unsubscribe = this.#store.onEvent(onLiveEvent);
    const close = () => {
      if (!closed) {
        closed = true;
        buffered.clear();
        unsubscribe();
      }
    };
    const ready = (async () => {
      try {
        const persisted = await this.#store.readEvents(jobId, afterSequence);
        if (closed) {
          return;
        }
        for (const event of [...persisted].sort(
          (left, right) => left.sequence - right.sequence,
        )) {
          deliver(event);
        }
        for (const event of [...buffered.values()].sort(
          (left, right) => left.sequence - right.sequence,
        )) {
          deliver(event);
        }
        buffered.clear();
        replaying = false;
      } catch (error) {
        close();
        throw error;
      }
    })();

    return Object.freeze({ ready, close });
  }
}
