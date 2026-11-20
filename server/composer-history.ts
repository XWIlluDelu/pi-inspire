import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { fileReferenceName } from "../shared/attachment-context.js";
import { composerArtifactReference } from "../shared/composer-artifact-references.js";
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
import { requestError } from "./request-error.js";

interface ComposerHistoryCandidate {
  entry: ComposerHistoryEntry;
  imageData: string[];
  filePaths: string[];
}

interface ComposerHistoryMessage extends Record<string, unknown> {
  __inspireHistoryEntryId: string;
}

export type ComposerHistoryFileNameResolver = (
  path: string,
) => string | null | undefined;

function historyFile(
  path: string,
  reference: string,
  cwd?: string,
  fileNameForPath?: ComposerHistoryFileNameResolver,
): ComposerHistoryFile {
  const absolutePath = resolve(path);
  const attachmentName = fileNameForPath?.(absolutePath);
  const project =
    !attachmentName && cwd
      ? !escapesBase(relative(resolve(cwd), absolutePath))
      : false;
  return {
    reference,
    fileName: attachmentName ?? fileReferenceName(path),
    kind: project ? "project" : "attachment",
  };
}

/** Keep the original content coordinates when projecting a saved prompt. */
export function savedComposerPrompt(content: unknown) {
  let text = typeof content === "string" ? content : "";
  const images: Array<{ partIndex: number; data: string; mimeType: string }> =
    [];
  if (Array.isArray(content)) {
    content.forEach((part, partIndex) => {
      if (!part || typeof part !== "object") return;
      const item = part as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        text += item.text;
        return;
      }
      if (
        item.type === "image" &&
        typeof item.data === "string" &&
        typeof item.mimeType === "string"
      ) {
        images.push({ partIndex, data: item.data, mimeType: item.mimeType });
      }
    });
  }

  return { ...parseAttachmentContext(text, images.length), images };
}

function userMessageEntry(
  message: ComposerHistoryMessage,
  cwd?: string,
  fileNameForPath?: ComposerHistoryFileNameResolver,
): ComposerHistoryCandidate | null {
  if (message.role === "bashExecution" && typeof message.command === "string") {
    return {
      entry: {
        text: `${message.excludeFromContext === true ? "!!" : "!"}${message.command}`,
        images: [],
        files: [],
      },
      imageData: [],
      filePaths: [],
    };
  }
  if (message.role !== "user") return null;

  const prompt = savedComposerPrompt(message.content);
  const entryId = message.__inspireHistoryEntryId;
  const text = prompt.text.trim();
  const images: ComposerHistoryImage[] = prompt.images.map(
    ({ partIndex, data, mimeType }) => ({
      reference: composerArtifactReference("image", entryId, partIndex),
      mimeType,
      size: Buffer.byteLength(data, "base64"),
    }),
  );
  const files = prompt.references.map((path, referenceIndex) =>
    historyFile(
      path,
      composerArtifactReference("file", entryId, referenceIndex),
      cwd,
      fileNameForPath,
    ),
  );
  return text || images.length > 0 || files.length > 0
    ? {
        entry: { text, images, files },
        imageData: prompt.images.map(({ data }) => data),
        filePaths: prompt.references,
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
  newestFirst: Iterable<ComposerHistoryMessage>,
  cwd?: string,
  fileNameForPath?: ComposerHistoryFileNameResolver,
): ComposerHistoryEntry[] {
  const history: ComposerHistoryCandidate[] = [];
  for (const message of newestFirst) {
    const candidate = userMessageEntry(message, cwd, fileNameForPath);
    if (!candidate) continue;
    const previous = history.at(-1);
    if (previous && samePrompt(previous, candidate)) {
      // Keep the oldest reference in a consecutive duplicate run, matching
      // forward insertion, without projecting the rest of an obsolete history.
      history[history.length - 1] = candidate;
      continue;
    }
    if (history.length === MAX_COMPOSER_HISTORY_ENTRIES) break;
    history.push(candidate);
  }
  return history.map((candidate) => candidate.entry);
}

type ComposerHistoryOwner = Pick<
  ComposerHistoryPage,
  | "sessionId"
  | "revision"
  | "viewId"
  | "incarnation"
  | "effectiveLeafId"
  | "composerHistoryVersion"
>;

export function projectComposerHistoryPage(
  newestFirst: Iterable<ComposerHistoryMessage>,
  owner: ComposerHistoryOwner,
  start = 0,
  cwd?: string,
  fileNameForPath?: ComposerHistoryFileNameResolver,
): ComposerHistoryPage {
  const history = composerHistoryEntries(newestFirst, cwd, fileNameForPath);
  if (!Number.isSafeInteger(start) || start < 0 || start > history.length) {
    throw requestError("Composer history offset is invalid", 400);
  }

  const hash = createHash("sha256");
  const entryBytes = history.map((entry) => {
    const json = JSON.stringify(entry);
    const bytes = Buffer.byteLength(json);
    hash.update(String(bytes)).update(":").update(json).update("\0");
    return bytes;
  });
  const entries: ComposerHistoryEntry[] = [];
  const base: ComposerHistoryPage = {
    ...owner,
    historyId: hash.digest("base64url"),
    total: history.length,
    start,
    entries,
    nextStart: null,
  };
  // A numeric nextStart is at most 100 and fits in the reserved "null".
  let serializedBytes = Buffer.byteLength(JSON.stringify(base));
  for (let index = start; index < history.length; index += 1) {
    const addedBytes = entryBytes[index]! + (entries.length > 0 ? 1 : 0);
    if (serializedBytes + addedBytes > MAX_COMPOSER_HISTORY_PAGE_BYTES) {
      if (entries.length === 0) {
        throw requestError(
          "A composer history entry exceeds the response limit",
          422,
        );
      }
      break;
    }
    entries.push(history[index]!);
    serializedBytes += addedBytes;
  }
  base.nextStart =
    start + entries.length < history.length ? start + entries.length : null;
  return base;
}
