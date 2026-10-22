import {
  fileReferenceName,
  parseAttachmentContext,
} from "./attachment-context.js";
import { MAX_SESSION_DISPLAY_TITLE_CHARS } from "./contracts.js";

/** User-facing text and file references share one projection across live and saved messages. */
export function userMessageContent(content: unknown) {
  const blocks = Array.isArray(content)
    ? content.filter(
        (block): block is Record<string, unknown> =>
          block !== null && typeof block === "object" && !Array.isArray(block),
      )
    : [];
  const text =
    typeof content === "string"
      ? content
      : blocks
          .filter(
            (block) => block.type === "text" && typeof block.text === "string",
          )
          .map((block) => block.text as string)
          .join("\n\n");
  const imageCount = blocks.filter((block) => block.type === "image").length;
  const parsed = parseAttachmentContext(text, imageCount);
  return {
    ...parsed,
    imageCount,
    caption: (
      parsed.text.trim() || parsed.references.map(fileReferenceName).join(", ")
    )
      .replace(/\s+/gu, " ")
      .trim(),
  };
}

/** Plain previews keep file identity without exposing transport instructions. */
export function userMessagePreviewText(content: unknown): string {
  const { text, references } = userMessageContent(content);
  return [text, ...references.map(fileReferenceName)]
    .filter(Boolean)
    .join("\n\n");
}

/** A title summarizes the user's input, not model-facing attachment instructions. */
export function userMessageTitle(content: unknown): string {
  return userMessageContent(content).caption.slice(
    0,
    MAX_SESSION_DISPLAY_TITLE_CHARS,
  );
}
