import { requestError } from "./request-error.js";
import { createHash } from "node:crypto";
import { basename, relative, resolve } from "node:path";
import {
  type ComposerHistoryEntry,
  type ComposerHistoryFile,
  type ComposerHistoryImage,
  type ComposerHistoryPage,
  MAX_COMPOSER_HISTORY_ENTRIES,
  MAX_COMPOSER_HISTORY_PAGE_BYTES,
} from "../shared/contracts.js";
import { parseAttachmentContext } from "./attachments.js";
import { escapesBase } from "./paths.js";

interface ComposerHistoryCandidate {
  entry: ComposerHistoryEntry;
  imageData: string[];
  filePaths: string[];
}

export type ComposerHistoryFileNameResolver = (
  path: string,
) => string | null | undefined;

function historyFile(
  path: string,
  persistedIndex: number,
  referenceIndex: number,
  cwd?: string,
  fileNameForPath?: ComposerHistoryFileNameResolver,
): ComposerHistoryFile {
  const absolutePath = resolve(path);
  const project = cwd
    ? !escapesBase(relative(resolve(cwd), absolutePath))
    : false;
  return {
    reference: `pi-file://${persistedIndex}/${referenceIndex}`,
    fileName:
      (!project ? fileNameForPath?.(absolutePath) : null) ??
      (basename(path) || "file"),
    kind: project ? "project" : "attachment",
  };
}

function userMessageEntry(
  value: unknown,
  messageIndex: number,
  cwd?: string,
  fileNameForPath?: ComposerHistoryFileNameResolver,
): ComposerHistoryCandidate | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.role !== "user") return null;

  const persistedIndex = Number.isSafeInteger(message.__inspireMessageIndex)
    ? Number(message.__inspireMessageIndex)
    : messageIndex;
  let content = "";
  const images: ComposerHistoryImage[] = [];
  const imageData: string[] = [];
  if (typeof message.content === "string") {
    content = message.content;
  } else if (Array.isArray(message.content)) {
    message.content.forEach((part, partIndex) => {
      if (!part || typeof part !== "object") return;
      const item = part as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        content += item.text;
        return;
      }
      if (
        item.type === "image" &&
        typeof item.data === "string" &&
        typeof item.mimeType === "string"
      ) {
        images.push({
          reference: `pi-embedded://${persistedIndex}/${partIndex}`,
          mimeType: item.mimeType,
          size: Buffer.byteLength(item.data, "base64"),
        });
        imageData.push(item.data);
      }
    });
  }

  const parsed = parseAttachmentContext(content);
  const text = parsed.text.trim();
  const files = parsed.references.map((path, referenceIndex) =>
    historyFile(path, persistedIndex, referenceIndex, cwd, fileNameForPath),
  );
  return text || images.length > 0 || files.length > 0
    ? {
        entry: { text, images, files },
        imageData,
        filePaths: parsed.references,
      }
    : null;
}

function samePrompt(
  left: ComposerHistoryCandidate,
  right: ComposerHistoryCandidate,
): boolean {
  return (
    left.entry.text === right.entry.text &&
    left.entry.images.length === right.entry.images.length &&
    left.entry.images.every(
      (image, index) =>
        image.mimeType === right.entry.images[index]?.mimeType &&
        left.imageData[index] === right.imageData[index],
    ) &&
    left.filePaths.length === right.filePaths.length &&
    left.filePaths.every((path, index) => path === right.filePaths[index])
  );
}

/** Reproduce Pi's newest-first editor history with persisted prompt artifacts. */
export function composerHistoryEntries(
  messages: readonly unknown[],
  cwd?: string,
  fileNameForPath?: ComposerHistoryFileNameResolver,
): ComposerHistoryEntry[] {
  const history: ComposerHistoryCandidate[] = [];
  messages.forEach((message, messageIndex) => {
    const candidate = userMessageEntry(
      message,
      messageIndex,
      cwd,
      fileNameForPath,
    );
    if (!candidate || (history[0] && samePrompt(history[0], candidate))) return;
    history.unshift(candidate);
    if (history.length > MAX_COMPOSER_HISTORY_ENTRIES) history.pop();
  });
  return history.map((candidate) => candidate.entry);
}

function historyIdentity(entries: readonly ComposerHistoryEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    const serialized = JSON.stringify(entry);
    const bytes = Buffer.byteLength(serialized);
    hash.update(String(bytes));
    hash.update(":");
    hash.update(serialized);
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
  cwd?: string,
  fileNameForPath?: ComposerHistoryFileNameResolver,
): ComposerHistoryPage {
  const history = composerHistoryEntries(messages, cwd, fileNameForPath);
  if (!Number.isSafeInteger(start) || start < 0 || start > history.length) {
    throw requestError("Composer history offset is invalid", 400);
  }

  const entries: ComposerHistoryEntry[] = [];
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
        throw requestError(
          "A composer history entry exceeds the response limit",
          422,
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
