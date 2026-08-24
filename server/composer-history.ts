import { createHash } from "node:crypto";
import {
  MAX_COMPOSER_HISTORY_ENTRIES,
  MAX_COMPOSER_HISTORY_PAGE_BYTES,
  type ComposerHistoryPage,
} from "../shared/contracts.js";
import { promptTextWithoutAttachmentContext } from "./attachments.js";

function userMessageText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.role !== "user") return null;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return null;
  return message.content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const content = part as Record<string, unknown>;
      return content.type === "text" && typeof content.text === "string"
        ? [content.text]
        : [];
    })
    .join("");
}

/** Reproduce Pi's process-local editor history initialization. */
export function composerHistoryEntries(messages: readonly unknown[]): string[] {
  const history: string[] = [];
  for (const message of messages) {
    const content = userMessageText(message);
    const text = content
      ? promptTextWithoutAttachmentContext(content).trim()
      : "";
    if (!text || history[0] === text) continue;
    history.unshift(text);
    if (history.length > MAX_COMPOSER_HISTORY_ENTRIES) history.pop();
  }
  return history;
}

function historyIdentity(entries: readonly string[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    const bytes = Buffer.byteLength(entry);
    hash.update(String(bytes));
    hash.update(":");
    hash.update(entry);
    hash.update("\0");
  }
  return hash.digest("base64url");
}

type ComposerHistoryOwner = Pick<
  ComposerHistoryPage,
  "sessionId" | "revision" | "viewId" | "incarnation" | "effectiveLeafId"
>;

export function projectComposerHistoryPage(
  messages: readonly unknown[],
  owner: ComposerHistoryOwner,
  start = 0,
): ComposerHistoryPage {
  const history = composerHistoryEntries(messages);
  if (!Number.isSafeInteger(start) || start < 0 || start > history.length) {
    throw Object.assign(new Error("Composer history offset is invalid"), {
      status: 400,
    });
  }

  const entries: string[] = [];
  const base: ComposerHistoryPage = {
    ...owner,
    historyId: historyIdentity(history),
    total: history.length,
    start,
    entries,
    nextStart: null,
  };
  let serializedBytes = Buffer.byteLength(JSON.stringify(base));
  for (let index = start; index < history.length; index += 1) {
    const entry = history[index]!;
    const addedBytes =
      Buffer.byteLength(JSON.stringify(entry)) + (entries.length > 0 ? 1 : 0);
    if (serializedBytes + addedBytes > MAX_COMPOSER_HISTORY_PAGE_BYTES) {
      if (entries.length === 0) {
        throw Object.assign(
          new Error("A composer history entry exceeds the response limit"),
          { status: 422 },
        );
      }
      break;
    }
    entries.push(entry);
    serializedBytes += addedBytes;
  }
  base.nextStart =
    start + entries.length < history.length ? start + entries.length : null;
  if (
    Buffer.byteLength(JSON.stringify(base)) > MAX_COMPOSER_HISTORY_PAGE_BYTES
  ) {
    throw new Error("Composer history response exceeded its serialized limit");
  }
  return base;
}
