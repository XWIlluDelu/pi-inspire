export const BRANCH_BRIDGE_VERSION = 1 as const;
/** Maximum UTF-8 JSON bytes and, independently, encoded base64url characters. */
export const BRANCH_BRIDGE_MAX_ARGUMENT_BYTES = 4_096;
export const BRANCH_BRIDGE_MAX_RESULT_BYTES = 2_048;

export interface BranchBridgeRequest {
  v: typeof BRANCH_BRIDGE_VERSION;
  nonce: string;
  workerId: string;
  sessionId: string;
  operation: "navigate";
  targetId: string;
}

export interface BranchBridgeResult {
  v: typeof BRANCH_BRIDGE_VERSION;
  nonce: string;
  workerId: string;
  sessionId: string;
  ok: boolean;
  cancelled: boolean;
  beforeLeaf: string | null;
  effectiveLeaf: string | null;
  error?: string;
}

/** Structural framing only. Endpoints remain responsible for validating fields. */
export function decodeBranchBridgeJson(
  encodedValue: unknown,
  limit: number,
): unknown {
  if (typeof encodedValue !== "string")
    throw new Error("invalid bridge encoding");
  const encoded = encodedValue.trim();
  if (!encoded || encoded.length > limit || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("invalid bridge encoding");
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length > limit || decoded.toString("base64url") !== encoded) {
    throw new Error("invalid bridge encoding");
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(decoded),
  ) as unknown;
}

/** Enforces both decoded UTF-8 bytes and encoded base64url characters. */
export function encodeBranchBridgeJson(value: unknown, limit: number): string {
  const decoded = Buffer.from(JSON.stringify(value), "utf8");
  if (decoded.length > limit)
    throw new Error("bridge payload exceeds decoded byte limit");
  const encoded = decoded.toString("base64url");
  if (encoded.length > limit)
    throw new Error("bridge payload exceeds encoded character limit");
  return encoded;
}
