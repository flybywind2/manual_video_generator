import { StudioError } from "../domain/errors.js";

function invalidSubscription(reason) {
  throw new StudioError("The event subscription is invalid.", {
    code: "INVALID_EVENT_SUBSCRIPTION",
    stage: "events",
    retryable: false,
    details: { reason },
  });
}

function validEvent(event, jobId, afterSequence) {
  return (
    event !== null &&
    typeof event === "object" &&
    event.jobId === jobId &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence > afterSequence
  );
}

export class EventBus {
  #store;
  #maxPending;

  constructor({ store, maxPending = 100 } = {}) {
    if (
      store === null ||
      typeof store !== "object" ||
      typeof store.onEvent !== "function" ||
      typeof store.readEvents !== "function"
    ) {
      invalidSubscription("event_store_required");
    }
    if (
      !Number.isSafeInteger(maxPending) ||
      maxPending < 1 ||
      maxPending > 10_000
    ) {
      invalidSubscription("max_pending_invalid");
    }
    this.#store = store;
    this.#maxPending = maxPending;
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

    let isClosed = false;
    let closeReason;
    let replaying = true;
    let active = false;
    let acceptedSequence = afterSequence;
    let lastDeliveredSequence = afterSequence;
    let unsubscribe;
    let closedResolved = false;
    const buffered = new Map();
    const queue = [];
    const idleWaiters = new Set();
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });

    const finishIdle = () => {
      if (active || queue.length > 0) {
        return;
      }
      for (const resolve of idleWaiters) {
        resolve();
      }
      idleWaiters.clear();
      if (isClosed && !closedResolved) {
        closedResolved = true;
        resolveClosed(
          Object.freeze({
            reason: closeReason,
            lastDeliveredSequence,
          }),
        );
      }
    };

    const idle = () => {
      if (!active && queue.length === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => idleWaiters.add(resolve));
    };

    const closeInternal = (reason) => {
      if (isClosed) {
        return;
      }
      isClosed = true;
      closeReason = reason;
      buffered.clear();
      for (const item of queue.splice(0)) {
        item.resolve(false);
      }
      unsubscribe?.();
      finishIdle();
    };

    const pump = () => {
      if (active || isClosed) {
        finishIdle();
        return;
      }
      const item = queue.shift();
      if (item === undefined) {
        finishIdle();
        return;
      }
      active = true;
      let effect;
      try {
        effect = listener(item.event);
      } catch {
        effect = undefined;
      }
      Promise.resolve(effect)
        .catch(() => undefined)
        .then(() => {
          lastDeliveredSequence = item.event.sequence;
          active = false;
          item.resolve(true);
          if (isClosed) {
            finishIdle();
          } else {
            pump();
          }
        });
    };

    const enqueue = (event) => {
      if (
        isClosed ||
        !validEvent(event, jobId, acceptedSequence)
      ) {
        return Promise.resolve(false);
      }
      if ((active ? 1 : 0) + queue.length >= this.#maxPending) {
        closeInternal("backpressure");
        return Promise.resolve(false);
      }
      acceptedSequence = event.sequence;
      const completion = new Promise((resolve) => {
        queue.push({ event, resolve });
      });
      pump();
      return completion;
    };

    const onLiveEvent = (event) => {
      if (
        isClosed ||
        !validEvent(event, jobId, acceptedSequence) ||
        buffered.has(event.sequence)
      ) {
        return;
      }
      if (replaying) {
        if (
          buffered.size + (active ? 1 : 0) + queue.length >=
          this.#maxPending
        ) {
          closeInternal("backpressure");
          return;
        }
        buffered.set(event.sequence, event);
      } else {
        void enqueue(event);
      }
    };

    unsubscribe = this.#store.onEvent(onLiveEvent);
    const ready = (async () => {
      try {
        const persisted = await this.#store.readEvents(jobId, afterSequence);
        for (const event of [...persisted].sort(
          (left, right) => left.sequence - right.sequence,
        )) {
          if (isClosed) {
            return;
          }
          await enqueue(event);
        }
        if (isClosed) {
          return;
        }
        const bufferedDeliveries = [];
        for (const event of [...buffered.values()].sort(
          (left, right) => left.sequence - right.sequence,
        )) {
          if (event.sequence > acceptedSequence) {
            bufferedDeliveries.push(enqueue(event));
          }
        }
        buffered.clear();
        replaying = false;
        await Promise.all(bufferedDeliveries);
        await idle();
      } catch (error) {
        closeInternal("source_error");
        await idle();
        throw error;
      }
    })();

    return Object.freeze({
      ready,
      closed,
      idle,
      close: () => closeInternal("client"),
    });
  }
}
