import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { messageFallbackCorrelation } from "../shared/message-identity.js";
import { MAX_RPC_LINE_BYTES } from "./pi-rpc.js";
import { samePersistedJson } from "./persisted-json.js";
import { isCanonicalIsoTimestamp } from "./runtime-entry-chain.js";
import type {
  PersistenceExpectation,
  PersistenceMatcher,
} from "./runtime-slot.js";

export function knownExpectation(
  matcher: PersistenceMatcher,
  exactEntry: SessionEntry | null = null,
): PersistenceExpectation {
  return {
    token: Symbol("persistence-expectation"),
    matcher,
    exactEntry,
    ready: Promise.resolve(),
    settle: () => undefined,
  };
}

export function deferredExpectation(): PersistenceExpectation {
  let settleReady!: () => void;
  let settled = false;
  const expectation: PersistenceExpectation = {
    token: Symbol("persistence-expectation"),
    matcher: null,
    exactEntry: null,
    ready: new Promise<void>((resolveReady) => {
      settleReady = resolveReady;
    }),
    settle(matcher) {
      if (settled) return;
      settled = true;
      expectation.matcher = matcher;
      settleReady();
    },
  };
  return expectation;
}

export function persistenceMessageKey(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.role === "custom" && typeof record.customType === "string")
    return `custom:${record.customType}`;
  const correlation = messageFallbackCorrelation(message);
  return correlation ? `message:${correlation}` : null;
}

export function persistenceEntryKey(entry: SessionEntry): string | null {
  if (entry.type === "message") return persistenceMessageKey(entry.message);
  if (entry.type === "custom_message") return `custom:${entry.customType}`;
  if (typeof entry.id === "string") return `entry:${entry.id}`;
  return null;
}

export function exactEntryExpectation(
  entry: SessionEntry,
): PersistenceExpectation {
  const expected = structuredClone(entry);
  return knownExpectation(
    (candidate) => samePersistedJson(candidate, expected),
    expected,
  );
}

export function eventSessionEntry(value: unknown): SessionEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.type !== "string" ||
    typeof entry.id !== "string" ||
    entry.id.length === 0 ||
    entry.id.length > 200 ||
    (entry.parentId !== null && typeof entry.parentId !== "string") ||
    !isCanonicalIsoTimestamp(entry.timestamp)
  )
    return null;
  try {
    if (Buffer.byteLength(JSON.stringify(entry)) > MAX_RPC_LINE_BYTES)
      return null;
  } catch {
    return null;
  }
  return structuredClone(entry) as unknown as SessionEntry;
}

export function customMessageEntryMatches(
  message: unknown,
  entry: SessionEntry,
): boolean {
  if (
    !message ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    entry.type !== "custom_message"
  )
    return false;
  const record = message as Record<string, unknown>;
  return (
    record.role === "custom" &&
    entry.customType === record.customType &&
    samePersistedJson(entry.content ?? [], record.content ?? []) &&
    entry.display === record.display &&
    samePersistedJson(entry.details, record.details)
  );
}

export function messageExpectation(
  message: unknown,
): PersistenceExpectation | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.role === "custom") {
    return knownExpectation((entry) =>
      customMessageEntryMatches(message, entry),
    );
  }
  if (
    record.role !== "user" &&
    record.role !== "assistant" &&
    record.role !== "toolResult"
  )
    return null;
  return knownExpectation(
    (entry) =>
      entry.type === "message" && samePersistedJson(entry.message, record),
  );
}

export function compactionMatcher(result: unknown): PersistenceMatcher | null {
  if (!result || typeof result !== "object") return null;
  const expected = result as Record<string, unknown>;
  if (
    typeof expected.summary !== "string" ||
    typeof expected.firstKeptEntryId !== "string" ||
    typeof expected.tokensBefore !== "number"
  )
    return null;
  return (entry) =>
    entry.type === "compaction" &&
    entry.summary === expected.summary &&
    entry.firstKeptEntryId === expected.firstKeptEntryId &&
    entry.tokensBefore === expected.tokensBefore &&
    samePersistedJson(entry.details, expected.details) &&
    samePersistedJson(entry.usage, expected.usage);
}
