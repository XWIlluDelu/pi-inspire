import { realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_ATTACHMENTS,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGE_ENCODED_BYTES,
  type PromptRequest,
} from "../shared/contracts.js";
import {
  type AttachmentContextFile,
  type AttachmentStore,
  parseAttachmentContext,
  resolveProjectFiles,
} from "./attachments.js";
import { escapesBase } from "./paths.js";
import type { RuntimeSlot } from "./runtime-slot.js";

type HistorySelection = NonNullable<PromptRequest["historyArtifacts"]>;
type RecalledImage = { type: "image"; data: string; mimeType: string };
type UserMessage = Record<string, unknown>;
type UserMessageLookup = (messageIndex: number) => UserMessage;

interface ResolvedComposerHistoryArtifacts {
  images: RecalledImage[];
  files: AttachmentContextFile[];
  fileBytes: number;
  projectFiles: string[];
}

function requestError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

function effectiveLeaf(slot: RuntimeSlot): string | null {
  return (
    slot.navigationLease?.effectiveLeafId ?? slot.projection?.leafId ?? null
  );
}

function historyProjection(
  slot: RuntimeSlot,
  selection: HistorySelection,
): {
  projection: NonNullable<RuntimeSlot["projection"]>;
  effectiveLeafId: string | null;
} {
  const projection = slot.projection;
  const effectiveLeafId = effectiveLeaf(slot);
  if (
    !projection ||
    selection.viewId !== slot.viewId ||
    selection.incarnation !== projection.incarnation ||
    selection.effectiveLeafId !== effectiveLeafId
  ) {
    throw requestError(
      "Recalled attachments belong to an earlier conversation view",
      409,
    );
  }
  return { projection, effectiveLeafId };
}

function userMessageLookup(messages: readonly unknown[]): UserMessageLookup {
  const byPersistedIndex = new Map<number, unknown>();
  messages.forEach((message, messageIndex) => {
    if (!message || typeof message !== "object") return;
    const record = message as UserMessage;
    const persistedIndex = Number.isSafeInteger(record.__inspireMessageIndex)
      ? Number(record.__inspireMessageIndex)
      : messageIndex;
    if (byPersistedIndex.has(persistedIndex)) {
      throw requestError(
        "The conversation contains ambiguous attachment references",
        409,
      );
    }
    byPersistedIndex.set(persistedIndex, message);
  });

  return (messageIndex) => {
    const message = byPersistedIndex.get(messageIndex);
    if (
      !message ||
      typeof message !== "object" ||
      (message as UserMessage).role !== "user"
    ) {
      throw requestError("A recalled attachment is no longer available", 409);
    }
    return message as UserMessage;
  };
}

function referenceIndexes(
  reference: string,
  pattern: RegExp,
  label: "image" | "file",
): [messageIndex: number, itemIndex: number] {
  const match = pattern.exec(reference);
  const messageIndex = match ? Number(match[1]) : -1;
  const itemIndex = match ? Number(match[2]) : -1;
  if (
    !Number.isSafeInteger(messageIndex) ||
    messageIndex < 0 ||
    !Number.isSafeInteger(itemIndex) ||
    itemIndex < 0
  ) {
    throw requestError(`A recalled ${label} reference is invalid`, 400);
  }
  return [messageIndex, itemIndex];
}

function recalledImages(
  references: readonly string[],
  userMessage: UserMessageLookup,
): RecalledImage[] {
  return references.map((reference) => {
    const [messageIndex, partIndex] = referenceIndexes(
      reference,
      /^pi-embedded:\/\/(\d+)\/(\d+)$/,
      "image",
    );
    const record = userMessage(messageIndex);
    const part = Array.isArray(record.content)
      ? record.content[partIndex]
      : null;
    if (
      !part ||
      typeof part !== "object" ||
      (part as UserMessage).type !== "image"
    ) {
      throw requestError("A recalled image is not a user attachment", 400);
    }
    const image = part as UserMessage;
    const data = image.data;
    const mimeType = image.mimeType;
    if (
      typeof data !== "string" ||
      typeof mimeType !== "string" ||
      !/^image\/(png|jpe?g|gif|webp)$/i.test(mimeType)
    ) {
      throw requestError("A recalled image is invalid", 422);
    }
    if (
      Buffer.byteLength(data) >
      4 * Math.ceil(MAX_ATTACHMENT_FILE_BYTES / 3)
    ) {
      throw requestError(
        `Each image must be at most ${MAX_ATTACHMENT_FILE_BYTES} bytes`,
        413,
      );
    }
    const normalized = data.replace(/=+$/u, "");
    const decoded = Buffer.from(data, "base64");
    if (
      decoded.length === 0 ||
      decoded.toString("base64").replace(/=+$/u, "") !== normalized
    ) {
      throw requestError("A recalled image is invalid", 422);
    }
    return { type: "image", data, mimeType };
  });
}

function promptText(record: UserMessage): string {
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return "";
  return record.content
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      (part as UserMessage).type === "text" &&
      typeof (part as UserMessage).text === "string"
        ? [(part as UserMessage).text as string]
        : [],
    )
    .join("");
}

function recalledFilePaths(
  references: readonly string[],
  userMessage: UserMessageLookup,
): string[] {
  return references.map((reference) => {
    const [messageIndex, referenceIndex] = referenceIndexes(
      reference,
      /^pi-file:\/\/(\d+)\/(\d+)$/,
      "file",
    );
    const path = parseAttachmentContext(promptText(userMessage(messageIndex)))
      .references[referenceIndex];
    if (!path) {
      throw requestError(
        "A recalled file is not a persisted prompt attachment",
        400,
      );
    }
    return path;
  });
}

async function recalledFiles(
  cwd: string,
  paths: readonly string[],
  attachments: Pick<AttachmentStore, "ownsPromptFile">,
): Promise<{
  files: AttachmentContextFile[];
  fileBytes: number;
  projectFiles: string[];
}> {
  if (paths.length === 0) return { files: [], fileBytes: 0, projectFiles: [] };
  const workspaceRoot = await realpath(cwd).catch(() => null);
  if (!workspaceRoot) {
    throw requestError("The project is unavailable for recalled files", 409);
  }

  const files: AttachmentContextFile[] = [];
  let fileBytes = 0;
  const projectFiles: string[] = [];
  for (const path of paths) {
    const candidate = resolve(path);
    const outsideWorkspace = escapesBase(relative(workspaceRoot, candidate));
    const ownedAttachment =
      outsideWorkspace && attachments.ownsPromptFile(candidate);
    // Persisted path text is descriptive, not a capability. Reject an external
    // path before touching it unless this Host still owns that upload.
    if (outsideWorkspace && !ownedAttachment) {
      throw requestError(
        "A recalled attachment is not owned by this Host; add it again",
        409,
      );
    }

    const actual = await realpath(candidate).catch(() => null);
    if (!actual || actual !== candidate) {
      throw requestError("A recalled file is no longer available", 409);
    }
    const details = await stat(actual).catch(() => null);
    if (!details?.isFile()) {
      throw requestError("A recalled file is no longer available", 409);
    }
    if (!outsideWorkspace) {
      projectFiles.push(actual);
      continue;
    }
    if (details.size > MAX_ATTACHMENT_FILE_BYTES) {
      throw requestError(
        `Each attachment must be at most ${MAX_ATTACHMENT_FILE_BYTES} bytes`,
        413,
      );
    }
    files.push({ kind: "file", path: actual });
    fileBytes += details.size;
  }
  return {
    files,
    fileBytes,
    projectFiles: await resolveProjectFiles(cwd, projectFiles),
  };
}

/** Re-run project-index authority after the prompt has crossed the runtime
 * FIFO. Selection and delivery can be separated by worker startup or another
 * mutation, so the first validation cannot authorize the later send. */
export async function revalidateProjectFiles(
  cwd: string,
  requested: readonly string[] | undefined,
  expected: readonly string[],
): Promise<string[]> {
  if (!requested?.length) return [];
  let current: string[];
  try {
    current = await resolveProjectFiles(cwd, [...requested]);
  } catch (error) {
    throw Object.assign(
      requestError(
        "A selected project file changed before prompt delivery",
        409,
      ),
      { cause: error },
    );
  }
  if (
    current.length !== expected.length ||
    current.some((path, index) => path !== expected[index])
  ) {
    throw requestError(
      "A selected project file changed before prompt delivery",
      409,
    );
  }
  return current;
}

export async function resolveComposerHistoryArtifacts(
  slot: RuntimeSlot,
  request: PromptRequest,
  attachments: Pick<AttachmentStore, "ownsPromptFile">,
): Promise<ResolvedComposerHistoryArtifacts> {
  const selection = request.historyArtifacts;
  if (!selection)
    return { images: [], files: [], fileBytes: 0, projectFiles: [] };
  if (
    new Set(selection.imageReferences).size !==
      selection.imageReferences.length ||
    new Set(selection.fileReferences).size !== selection.fileReferences.length
  ) {
    throw requestError("A recalled attachment was repeated", 400);
  }

  const { projection, effectiveLeafId } = historyProjection(slot, selection);
  const userMessage = userMessageLookup(
    projection.viewMessages(effectiveLeafId),
  );
  const images = recalledImages(selection.imageReferences, userMessage);
  const resolvedFiles = await recalledFiles(
    slot.cwd,
    recalledFilePaths(selection.fileReferences, userMessage),
    attachments,
  );
  return { images, ...resolvedFiles };
}

export function assertPromptArtifactBudget(
  attachmentCount: number,
  rawAttachmentBytes: number,
  images: readonly { data: string }[],
): void {
  if (attachmentCount > MAX_ATTACHMENTS) {
    throw requestError(
      `At most ${MAX_ATTACHMENTS} attachments per message`,
      413,
    );
  }
  if (rawAttachmentBytes > MAX_ATTACHMENT_UPLOAD_BYTES) {
    throw requestError(
      `Attachments per message must total at most ${MAX_ATTACHMENT_UPLOAD_BYTES} bytes`,
      413,
    );
  }
  const imageBytes = images.map((image) =>
    Buffer.byteLength(image.data, "base64"),
  );
  if (imageBytes.some((bytes) => bytes > MAX_ATTACHMENT_FILE_BYTES)) {
    throw requestError(
      `Each image must be at most ${MAX_ATTACHMENT_FILE_BYTES} bytes`,
      413,
    );
  }
  const rawBytes = imageBytes.reduce((sum, bytes) => sum + bytes, 0);
  if (rawBytes > MAX_PROMPT_IMAGE_BYTES) {
    throw requestError(
      `Images per message must total at most ${MAX_PROMPT_IMAGE_BYTES} bytes`,
      413,
    );
  }
  const encodedBytes = images.reduce(
    (sum, image) => sum + Buffer.byteLength(image.data),
    0,
  );
  if (encodedBytes > MAX_PROMPT_IMAGE_ENCODED_BYTES) {
    throw requestError(
      `Encoded images exceed the ${MAX_PROMPT_IMAGE_ENCODED_BYTES}-byte prompt budget`,
      413,
    );
  }
}
