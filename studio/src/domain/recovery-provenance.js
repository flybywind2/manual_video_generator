const PLAN_DIGEST = /^[a-f0-9]{64}$/u;

export function findRecoveryAnchor(
  events,
  { anchorEvent, currentEventSequence, currentState },
) {
  if (
    !Array.isArray(events) ||
    typeof anchorEvent !== "string" ||
    !Number.isSafeInteger(currentEventSequence) ||
    currentEventSequence < 1 ||
    typeof currentState !== "string"
  ) {
    return null;
  }

  let expectedSequence = currentEventSequence;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.sequence !== expectedSequence ||
      event?.state !== currentState
    ) {
      return null;
    }
    if (event.event === anchorEvent) {
      return event;
    }
    if (event.event !== "OPERATION_REJECTED") {
      return null;
    }
    expectedSequence -= 1;
  }
  return null;
}

export function latestValidPlanDigest(events) {
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    try {
      const data = events[index]?.data;
      if (data === null || typeof data !== "object") continue;
      const property = Object.getOwnPropertyDescriptor(data, "planDigest");
      if (property && "value" in property && PLAN_DIGEST.test(property.value ?? "")) {
        return property.value;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}
