/** A non-array object, as decoded from JSON or another untyped boundary. */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function jsonRecord(value: unknown): Record<string, unknown> | null {
  return isJsonRecord(value) ? value : null;
}
