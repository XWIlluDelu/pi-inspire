import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseComposerArtifactReference } from "../shared/composer-artifact-references.js";
import {
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_PROJECT_FILES,
  type PromptRequest,
} from "../shared/contracts.js";
import { isSupportedPromptImageMimeType } from "../shared/image-types.js";
import { jsonRecord } from "../shared/json-record.js";
import {
  addAttachmentContext,
  assertAttachmentBudget,
  type AttachmentContextFile,
  type AttachmentStore,
  resolveProjectFiles,
} from "./attachments.js";
import { savedComposerPrompt } from "./composer-history.js";
import { filesystemRelativePath } from "./filesystem-containment.js";
import { canonicalBase64DecodedSize } from "./image-content.js";
import { requestError } from "./request-error.js";
import type { RuntimeSlot } from "./runtime-slot.js";

type HistorySelection = NonNullable<PromptRequest["historyArtifacts"]>;
type RecalledImage = { type: "image"; data: string; mimeType: string };
type UserContentLookup = (entryId: string) => unknown;

interface PromptArtifacts {
  images: RecalledImage[];
  files: AttachmentContextFile[];
  fileBytes: number;
  projectFiles: string[];
}

function historyUserContent(
  slot: RuntimeSlot,
  selection: HistorySelection,
): UserContentLookup {
  const projection = slot.history;
  const effectiveLeafId = slot.effectiveLeaf;
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
  return (entryId) => projection.historyUserContent(entryId, effectiveLeafId);
}

function recalledReference(
  reference: string,
  label: "image" | "file",
): [entryId: string, itemIndex: number] {
  const target = parseComposerArtifactReference(label, reference);
  if (!target)
    throw requestError(`A recalled ${label} reference is invalid`, 400);
  return target;
}

function recalledImages(
  references: readonly string[],
  userContent: UserContentLookup,
): RecalledImage[] {
  return references.map((reference) => {
    const [entryId, partIndex] = recalledReference(reference, "image");
    const content = userContent(entryId);
    const image = Array.isArray(content)
      ? jsonRecord(content[partIndex])
      : null;
    if (image?.type !== "image") {
      throw requestError("A recalled image is not a user attachment", 400);
    }
    const data = image.data;
    const mimeType = image.mimeType;
    if (
      typeof data !== "string" ||
      typeof mimeType !== "string" ||
      !isSupportedPromptImageMimeType(mimeType)
    ) {
      throw requestError("A recalled image is invalid", 422);
    }
    const decodedSize = canonicalBase64DecodedSize(data);
    if (decodedSize === null || decodedSize === 0) {
      throw requestError("A recalled image is invalid", 422);
    }
    if (decodedSize > MAX_ATTACHMENT_FILE_BYTES) {
      throw requestError(
        `Each image must be at most ${MAX_ATTACHMENT_FILE_BYTES} bytes`,
        413,
      );
    }
    return { type: "image", data, mimeType };
  });
}

function recalledFilePaths(
  references: readonly string[],
  userContent: UserContentLookup,
): string[] {
  return references.map((reference) => {
    const [entryId, referenceIndex] = recalledReference(reference, "file");
    const path = savedComposerPrompt(userContent(entryId)).references[
      referenceIndex
    ];
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
    const outsideWorkspace =
      (await filesystemRelativePath(workspaceRoot, candidate)) === null;
    const ownedAttachment = attachments.ownsPromptFile(candidate);
    // Persisted path text is descriptive, not a capability. Reject an external
    // path before touching it unless durable Inspire ownership authorizes it.
    if (outsideWorkspace && !ownedAttachment) {
      throw requestError(
        "A recalled attachment is not owned by Inspire; add it again",
        409,
      );
    }

    if (!ownedAttachment) {
      // Project files are canonicalized, confined, and index-authorized as one
      // fresh batch below. Do not stat an untrusted symlink target first.
      projectFiles.push(candidate);
      continue;
    }
    const actual = await realpath(candidate).catch(() => null);
    if (!actual || actual !== candidate) {
      throw requestError("A recalled file is no longer available", 409);
    }
    const details = await stat(actual).catch(() => null);
    if (!details?.isFile()) {
      throw requestError("A recalled file is no longer available", 409);
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
  if (!isDeepStrictEqual(current, expected)) {
    throw requestError(
      "A selected project file changed before prompt delivery",
      409,
    );
  }
  return current;
}

/** Start both reads on admission. Return only leases that this submission acquired. */
export async function stagePromptInput(
  slot: RuntimeSlot,
  request: PromptRequest,
  attachments: AttachmentStore,
): Promise<{
  staged: Awaited<ReturnType<AttachmentStore["resolveForPrompt"]>>;
  projectFiles: string[];
}> {
  const ids = request.attachmentIds ?? [];
  const uploads = attachments.resolveForPrompt(ids);
  try {
    const [staged, projectFiles] = await Promise.all([
      uploads,
      resolveProjectFiles(slot.cwd, request.projectFiles),
    ]);
    return { staged, projectFiles };
  } catch (error) {
    await uploads.then(
      () => attachments.restage(ids),
      () => {},
    );
    throw error;
  }
}

export async function preparePiPrompt(
  slot: RuntimeSlot,
  request: PromptRequest,
  message: string,
  input: Awaited<ReturnType<typeof stagePromptInput>>,
  attachments: AttachmentStore,
  earlierHistory?: PromptArtifacts,
) {
  const { staged, projectFiles: selected } = input;
  const history = await resolveComposerHistoryArtifacts(
    slot,
    request,
    attachments,
  );
  if (earlierHistory && !isDeepStrictEqual(history, earlierHistory))
    throw requestError(
      "A recalled attachment changed before prompt delivery",
      409,
    );
  const files = [...staged.files, ...history.files];
  const fileBytes = staged.files.reduce(
    (sum, file) => sum + (file.kind === "file" ? file.size : 0),
    history.fileBytes,
  );
  const images = [...staged.images, ...history.images];
  const expected = [...new Set([...selected, ...history.projectFiles])];
  if (expected.length > MAX_PROJECT_FILES)
    throw requestError(
      `At most ${MAX_PROJECT_FILES} project files per message`,
      413,
    );
  const projectFiles = await revalidateProjectFiles(
    slot.cwd,
    [...(request.projectFiles ?? []), ...history.projectFiles],
    expected,
  );
  // Uploaded images come from verified bytes. Recalled images were checked as canonical base64.
  const imageBytes = images.reduce(
    (sum, image) => sum + Buffer.byteLength(image.data, "base64"),
    0,
  );
  assertAttachmentBudget(
    files.length + history.images.length,
    fileBytes + imageBytes,
    imageBytes,
  );
  const fullMessage = addAttachmentContext(message, files, projectFiles);
  if (!fullMessage && images.length === 0)
    throw requestError("Message or attachment is required", 400);
  return { fullMessage, images, recalledImages: history.images };
}

/** Read recalled images without preparing files or transferring upload ownership. */
export function readComposerHistoryImages(
  slot: RuntimeSlot,
  selection: HistorySelection,
): RecalledImage[] {
  return recalledImages(
    selection.imageReferences,
    historyUserContent(slot, selection),
  );
}

export async function resolveComposerHistoryArtifacts(
  slot: RuntimeSlot,
  request: PromptRequest,
  attachments: Pick<AttachmentStore, "ownsPromptFile" | "ready">,
): Promise<PromptArtifacts> {
  const selection = request.historyArtifacts;
  if (!selection)
    return { images: [], files: [], fileBytes: 0, projectFiles: [] };
  await attachments.ready();
  if (
    new Set(selection.imageReferences).size !==
      selection.imageReferences.length ||
    new Set(selection.fileReferences).size !== selection.fileReferences.length
  ) {
    throw requestError("A recalled attachment was repeated", 400);
  }

  const userContent = historyUserContent(slot, selection);
  const images = recalledImages(selection.imageReferences, userContent);
  const resolvedFiles = await recalledFiles(
    slot.cwd,
    recalledFilePaths(selection.fileReferences, userContent),
    attachments,
  );
  return { images, ...resolvedFiles };
}
