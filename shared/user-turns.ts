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
