import { isDeepStrictEqual } from "node:util";

function persistedJson(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? undefined : JSON.parse(encoded) as unknown;
}

export function samePersistedJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(persistedJson(left), persistedJson(right));
}
