const EXACT_JSON_FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu;

export function unwrapExactJsonFence(value) {
  if (typeof value !== "string") return value;
  const match = EXACT_JSON_FENCE.exec(value.trim());
  return match === null ? value : match[1];
}
