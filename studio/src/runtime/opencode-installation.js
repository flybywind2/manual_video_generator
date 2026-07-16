const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export const OPEN_CODE_MINIMUM_VERSION = "1.17.19";
export const OPEN_CODE_FALLBACK_VERSION = "1.18.2";

export function parseStableOpenCodeVersion(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match = STABLE_VERSION_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const components = match.slice(1).map(Number);
  if (!components.every(Number.isSafeInteger)) {
    return null;
  }

  return Object.freeze(components);
}

const MINIMUM_COMPONENTS = parseStableOpenCodeVersion(OPEN_CODE_MINIMUM_VERSION);

export function supportsOpenCodeVersion(value) {
  const components = parseStableOpenCodeVersion(value);
  if (!components) {
    return false;
  }

  for (let index = 0; index < MINIMUM_COMPONENTS.length; index += 1) {
    if (components[index] > MINIMUM_COMPONENTS[index]) {
      return true;
    }
    if (components[index] < MINIMUM_COMPONENTS[index]) {
      return false;
    }
  }

  return true;
}
