/** A non-array object, as decoded from JSON or another untyped boundary. */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function jsonRecord(value: unknown): Record<string, unknown> | null {
  return isJsonRecord(value) ? value : null;
}

/** Select only own fields from decoded JSON, including array indices. */
export function jsonValueAt(
  value: unknown,
  path: string | readonly (string | number)[],
): unknown {
  for (const key of typeof path === "string" ? path.split(".") : path) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, key)
    )
      return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}
