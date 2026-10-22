import type { UserTurnAnchor } from "./contracts.js";
import { userMessageContent } from "./user-message.js";

const USER_TURN_SNIPPET_CHARS = 180;

type UserTurnSummary = Pick<UserTurnAnchor, "snippet" | "attachmentCount">;

/** Derive the one bounded user-turn summary shared by transcript projections. */
export function userTurnSummary(value: unknown): UserTurnSummary {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { snippet: "User message", attachmentCount: 0 };
  const record = value as Record<string, unknown>;
  const {
    caption: normalized,
    references,
    imageCount: attachmentCount,
  } = userMessageContent(record.content);
  const snippet = Array.from(normalized.slice(0, USER_TURN_SNIPPET_CHARS * 2))
    .slice(0, USER_TURN_SNIPPET_CHARS)
    .join("");
  return {
    snippet:
      snippet ||
      (attachmentCount > 0
        ? attachmentCount === 1
          ? "Image attachment"
          : `${attachmentCount} image attachments`
        : "User message"),
    attachmentCount: attachmentCount + references.length,
  };
}

/** Project an in-memory transcript whose user-turn ordinals are sequential. */
export function sequentialUserTurnAnchors(
  messages: readonly unknown[],
  fallbackIdPrefix: string,
): UserTurnAnchor[] {
  const turns: UserTurnAnchor[] = [];
  for (const [index, value] of messages.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.role !== "user") continue;
    turns.push({
      id:
        typeof record.__inspireMessageId === "string"
          ? record.__inspireMessageId
          : `${fallbackIdPrefix}:${index}`,
      ordinal: turns.length,
      ...userTurnSummary(record),
    });
  }
  return turns;
}
