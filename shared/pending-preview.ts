import {
  MAX_PENDING_PREVIEW_CHARS,
  type PendingMessageSummary,
} from "./contracts.js";

export function pendingTextSummary(
  text: string,
): Pick<PendingMessageSummary, "textPreview" | "textLength" | "textTruncated"> {
  let textPreview = text;
  if (text.length > MAX_PENDING_PREVIEW_CHARS || text.split("\n").length > 4) {
    const separator = "\n…\n";
    const headBudget = Math.floor(MAX_PENDING_PREVIEW_CHARS * 0.75);
    const tailBudget =
      MAX_PENDING_PREVIEW_CHARS - headBudget - separator.length;
    // Keep three leading lines and the last line, without splitting surrogate pairs.
    const head = text
      .slice(0, headBudget)
      .split("\n")
      .slice(0, 3)
      .join("\n")
      .replace(/\p{Surrogate}$/u, "");
    const tail = text
      .replace(/[\r\n]+$/, "")
      .slice(-tailBudget)
      .split("\n")
      .at(-1)!
      .replace(/^\p{Surrogate}/u, "");
    const shortened = `${head}${separator}${tail}`;
    if (shortened.length < text.length) textPreview = shortened;
  }
  return {
    textPreview,
    textLength: text.length,
    textTruncated: textPreview !== text,
  };
}
