export const REDACTED_VALUE = "[redacted]";
const SENSITIVE_KEY = /(api[-_]?key|authorization|cookie|credential|password|private[-_]?key|secret|token)$/i;

export interface ProjectionLimits {
  depth: number;
  stringChars: number;
  arrayItems: number;
  objectEntries?: number;
}

export function isSensitiveProjectionKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** Generic bounded/redacted structural projection. Serialized byte budgets stay with callers. */
export function projectSafeValue(value: unknown, limits: ProjectionLimits, depth = 0): unknown {
  if (depth > limits.depth) return "[depth limited]";
  if (typeof value === "string") {
    return value.length > limits.stringChars ? `${value.slice(0, limits.stringChars)}\n…[truncated]` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, limits.arrayItems).map((item) => projectSafeValue(item, limits, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>);
  const bounded = limits.objectEntries === undefined ? entries : entries.slice(0, limits.objectEntries);
  return Object.fromEntries(bounded.map(([key, child]) => [
    key,
    isSensitiveProjectionKey(key) ? REDACTED_VALUE : projectSafeValue(child, limits, depth + 1),
  ]));
}
