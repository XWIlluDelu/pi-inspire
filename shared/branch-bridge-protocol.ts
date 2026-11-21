import { z } from "zod";
import { MAX_SESSION_ID_CHARS } from "./contracts.js";

export const BRANCH_BRIDGE_VERSION = 1 as const;
export const MODEL_REFRESH_SUFFIX = "_models";
export const RETRY_STATE_SUFFIX = "_retry";
export const PENDING_IMAGE_SUFFIX = "_pending_images";
export const UI_RELOAD_SUFFIX = "_ui_reload";
export const MODEL_REFRESH_TIMEOUT_MS = 15_000;
/** Maximum UTF-8 JSON bytes and, independently, encoded base64url characters. */
export const BRANCH_BRIDGE_MAX_ARGUMENT_BYTES = 16_384;
export const BRANCH_BRIDGE_MAX_RESULT_BYTES = 2_048;

const owner = {
  v: z.literal(BRANCH_BRIDGE_VERSION),
  nonce: z.string(),
  workerId: z.string(),
  sessionId: z.string(),
};
const leaf = z.string().nullable();
export const branchBridgeRequest = z.strictObject({
  ...owner,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/),
  sessionId: z.string().min(1).max(MAX_SESSION_ID_CHARS),
  operation: z.literal("navigate"),
  targetId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  summarize: z.boolean().optional(),
  customInstructions: z.string().max(2000).optional(),
});
export type BranchBridgeRequest = z.infer<typeof branchBridgeRequest>;

export const branchBridgeResult = z.strictObject({
  ...owner,
  ok: z.boolean(),
  cancelled: z.boolean(),
  beforeLeaf: leaf,
  effectiveLeaf: leaf,
  /** Leaf observed in the native session_tree event, before callback effects. */
  navigationLeaf: leaf.optional(),
  summaryId: z.string().min(1).optional(),
  error: z.string().max(300).optional(),
});
export type BranchBridgeResult = z.infer<typeof branchBridgeResult>;

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
