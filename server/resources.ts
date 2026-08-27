import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_PROMPT_IMAGE_BYTES,
  type ResourceDescriptor,
  type ResourceKind,
  type ResourceProbeResult,
} from "../shared/contracts.js";
import {
  collectSessionResourceReferences,
  isTextFileName,
  MAX_RESOURCE_LIST_PAGE_SIZE,
  RESOURCE_LIST_INITIAL_SIZE,
  type SessionResourceListResponse,
  type SessionResourceReference,
  stripResourceLocation,
} from "../shared/resource-references.js";
import {
  canonicalBase64DecodedSize,
  decodeCanonicalBase64,
  isSupportedPromptImageMimeType,
} from "./image-content.js";
import { escapesBase } from "./paths.js";
import {
  indexedBasenameMatches,
  invalidateProjectIndex,
  isIndexedProjectFile,
} from "./project-files.js";

interface ResourceContextIdentity {
  sessionId: string;
  viewId: string;
  revision: number;
  cwd: string;
}

/** Resource authority is always bound to one transcript view and exactly one
 * message source. The live runtime loads lazily so indexed workspace previews
 * do not require a complete transcript RPC read. */
export type ResourceContext = ResourceContextIdentity &
  (
    | { messages: unknown[]; loadMessages?: never }
    | { messages?: never; loadMessages: () => Promise<unknown[]> }
  );

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

function fileIdentity(stats: BigIntStats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameFileObject(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

const RESOURCE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;

function changedResourceError(): Error & { status: number } {
  return Object.assign(
    new Error("The referenced file changed on disk; open it again"),
    { status: 409 },
  );
}

/** Open the path the user actually selected and prove that its descriptor
 * resolves to the canonical file we authorized. For an already-canonical path,
 * `O_NOFOLLOW` also rejects a final-component exchange. For a selected symlink
 * or symlinked cwd, the descriptor witness binds the followed chain atomically
 * to the expected target. INSΠRE is Linux-only, so `/proc/self/fd` is the
 * kernel-owned descriptor-to-path witness rather than a second pathname stat. */
async function openAuthorizedResourceFile(
  selectedPath: string,
  canonicalPath: string,
): Promise<{ handle: FileHandle; details: BigIntStats }> {
  const flags =
    RESOURCE_OPEN_FLAGS |
    (selectedPath === canonicalPath ? constants.O_NOFOLLOW : 0);
  const handle = await open(selectedPath, flags);
  try {
    let openedPath: string;
    try {
      openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    } catch {
      throw changedResourceError();
    }
    if (openedPath !== canonicalPath) throw changedResourceError();
    return { handle, details: await handle.stat({ bigint: true }) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export function openCanonicalResourceFile(
  canonicalPath: string,
): Promise<{ handle: FileHandle; details: BigIntStats }> {
  return openAuthorizedResourceFile(canonicalPath, canonicalPath);
}

interface ResolvedResource {
  descriptor: ResourceDescriptor;
  /** Absolute path selected by the reference before symlink resolution. */
  selectedPath?: string;
  /** Canonical target pinned by this opaque handle. */
  path?: string;
  /** Filesystem object captured at resolve time. The retained anchor keeps
   * that inode allocated, making the device/inode pair non-reusable while this
   * opaque resource handle is live. */
  fileId?: FileIdentity;
  /** Never streamed: it anchors fileId until eviction, session deletion, or
   * server shutdown. A separately opened serving handle can still observe a
   * legitimate in-place rewrite of this same filesystem object. */
  anchor?: FileHandle;
  authority: "embedded" | "workspace" | "index" | "citation";
}

const MAX_HANDLES = 256;
const MAX_CITATION_INDEXES = 32;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".c": "text/x-c",
  ".cc": "text/x-c++",
  ".cpp": "text/x-c++",
  ".css": "text/css",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".go": "text/x-go",
  ".h": "text/x-c",
  ".hpp": "text/x-c++",
  ".htm": "text/html",
  ".html": "text/html",
  ".ipynb": "application/x-ipynb+json",
  ".java": "text/x-java",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".jsx": "text/jsx",
  ".log": "text/plain",
  ".m4a": "audio/mp4",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".mjs": "text/javascript",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".php": "text/x-php",
  ".png": "image/png",
  ".py": "text/x-python",
  ".r": "text/x-r",
  ".rb": "text/x-ruby",
  ".rs": "text/x-rust",
  ".sh": "text/x-shellscript",
  ".sql": "text/x-sql",
  ".svg": "image/svg+xml",
  ".tex": "text/x-tex",
  ".toml": "application/toml",
  ".ts": "text/typescript",
  ".tsv": "text/tab-separated-values",
  ".tsx": "text/tsx",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Resolve only filesystem syntax; authorization and realpath checks follow. */
function exactWorkspacePath(workspacePath: string, cwd: string): string {
  if (isAbsolute(workspacePath) || workspacePath.includes("\0")) {
    throw Object.assign(new Error("The workspace path is not valid"), {
      status: 400,
    });
  }
  const root = resolve(cwd);
  const candidate = resolve(root, workspacePath);
  if (escapesBase(relative(root, candidate))) {
    throw Object.assign(new Error("The workspace path is not valid"), {
      status: 400,
    });
  }
  return candidate;
}

export function referencePath(referenceInput: string, cwd: string): string {
  let reference = referenceInput.trim().replace(/^@/, "");
  if (reference.startsWith("<") && reference.endsWith(">"))
    reference = reference.slice(1, -1);
  reference = stripResourceLocation(reference);

  if (/^vscode:\/\/file\//i.test(reference)) {
    const url = new URL(reference);
    reference = decoded(url.pathname);
  } else if (/^file:\/\//i.test(reference)) {
    const url = new URL(reference);
    url.hash = "";
    url.search = "";
    reference = fileURLToPath(url);
  } else {
    reference = decoded(reference);
  }

  if (reference === "~") reference = homedir();
  else if (reference.startsWith("~/"))
    reference = resolve(homedir(), reference.slice(2));
  return isAbsolute(reference) ? resolve(reference) : resolve(cwd, reference);
}

function mimeTypeFor(path: string): string {
  return (
    MIME_BY_EXTENSION[extname(path).toLowerCase()] ??
    (isTextFileName(path) ? "text/plain" : "application/octet-stream")
  );
}

/** The bare name a reference carries, or null when it makes a location claim
 * of its own. Only a bare name — `kernel.py`, never `src/kernel.py`, `./x`,
 * or a URL — is shorthand the project index may recover. */
function bareName(reference: string): string | null {
  let value = reference.trim().replace(/^@/, "");
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  value = decoded(stripResourceLocation(value));
  if (
    !value ||
    value === "~" ||
    /[\\/]/.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  )
    return null;
  return value;
}

function kindFor(mimeType: string): ResourceKind {
  if (mimeType === "text/html") return "html";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "text/markdown") return "markdown";
  if (mimeType === "application/x-ipynb+json") return "notebook";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    mimeType.includes("toml") ||
    mimeType.includes("yaml")
  )
    return "text";
  return "binary";
}

function contextMessages(context: ResourceContext): Promise<unknown[]> {
  return context.loadMessages
    ? context.loadMessages()
    : Promise.resolve(context.messages);
}

function classifiedProbeFailure(
  reference: string,
  error: unknown,
): ResourceProbeResult | null {
  const record =
    error && typeof error === "object"
      ? (error as { status?: unknown; message?: unknown; matches?: unknown })
      : null;
  const status = typeof record?.status === "number" ? record.status : null;
  const message =
    typeof record?.message === "string" ? record.message : undefined;
  if (status === 409 && Array.isArray(record?.matches)) {
    return {
      reference,
      availability: "ambiguous",
      ...(message ? { message } : {}),
      matches: record.matches.map(String),
    };
  }
  if (status === 404)
    return {
      reference,
      availability: "missing",
      ...(message ? { message } : {}),
    };
  if (status === 403)
    return {
      reference,
      availability: "unavailable",
      ...(message ? { message } : {}),
    };
  if (status === 400)
    return {
      reference,
      availability: "invalid",
      ...(message ? { message } : {}),
    };
  return null;
}

interface EmbeddedCitation {
  messageIndex: number;
  partIndex: number;
  mimeType: string;
  size: number;
}

interface ResourceCitationIndex {
  sessionId: string;
  viewId: string;
  revision: number;
  resources: SessionResourceReference[];
  citedPaths: Set<string>;
  embedded: Map<string, EmbeddedCitation>;
}

interface ResourceListOptions {
  cursor?: string;
  limit?: number;
}

function citationIndexKey(context: ResourceContext): string {
  return JSON.stringify([context.sessionId, context.viewId, context.revision]);
}

function encodeResourceCursor(
  index: ResourceCitationIndex,
  offset: number,
): string {
  return Buffer.from(
    JSON.stringify({
      sessionId: index.sessionId,
      viewId: index.viewId,
      revision: index.revision,
      offset,
    }),
  ).toString("base64url");
}

function resourceCursorOffset(
  cursor: string,
  index: ResourceCitationIndex,
): number {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw Object.assign(new Error("The resource cursor is not valid"), {
      status: 400,
    });
  }
  if (!value || typeof value !== "object") {
    throw Object.assign(new Error("The resource cursor is not valid"), {
      status: 400,
    });
  }
  const record = value as Record<string, unknown>;
  if (
    record.sessionId !== index.sessionId ||
    record.viewId !== index.viewId ||
    record.revision !== index.revision
  ) {
    throw Object.assign(
      new Error("The referenced-file view changed; reload the list"),
      { status: 409 },
    );
  }
  if (
    !Number.isSafeInteger(record.offset) ||
    Number(record.offset) < 0 ||
    Number(record.offset) > index.resources.length
  ) {
    throw Object.assign(new Error("The resource cursor is not valid"), {
      status: 400,
    });
  }
  return Number(record.offset);
}

function embeddedCitations(messages: unknown[]): Map<string, EmbeddedCitation> {
  const embedded = new Map<string, EmbeddedCitation>();
  messages.forEach((message, messageIndex) => {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.display === false || !Array.isArray(record.content)) return;
    const persistedIndex = Number.isSafeInteger(record.__inspireMessageIndex)
      ? Number(record.__inspireMessageIndex)
      : messageIndex;
    record.content.forEach((part, partIndex) => {
      if (!part || typeof part !== "object") return;
      const image = part as Record<string, unknown>;
      if (
        image.type !== "image" ||
        typeof image.data !== "string" ||
        typeof image.mimeType !== "string"
      )
        return;
      if (!isSupportedPromptImageMimeType(image.mimeType)) return;
      const size = canonicalBase64DecodedSize(image.data);
      if (size === null || size === 0 || size > MAX_PROMPT_IMAGE_BYTES) return;
      embedded.set(`pi-embedded://${persistedIndex}/${partIndex}`, {
        messageIndex,
        partIndex,
        mimeType: image.mimeType,
        size,
      });
    });
  });
  return embedded;
}

function buildCitationIndex(
  context: ResourceContext,
  messages: unknown[],
): ResourceCitationIndex {
  const resources = collectSessionResourceReferences(messages);
  const citedPaths = new Set<string>();
  for (const resource of resources) {
    if (!resource.reference || resource.reference.startsWith("pi-embedded://"))
      continue;
    try {
      citedPaths.add(referencePath(resource.reference, context.cwd));
    } catch {
      // Invalid references remain visible but confer no path authority.
    }
  }

  return {
    sessionId: context.sessionId,
    viewId: context.viewId,
    revision: context.revision,
    resources,
    citedPaths,
    embedded: embeddedCitations(messages),
  };
}

function referencedByIndex(
  index: ResourceCitationIndex,
  context: ResourceContext,
  requested: string,
): boolean {
  try {
    return index.citedPaths.has(referencePath(requested, context.cwd));
  } catch {
    return false;
  }
}

export class ResourceStore {
  private readonly handles = new Map<string, ResolvedResource>();
  private readonly citationIndexes = new Map<
    string,
    {
      sessionId: string;
      generation: number;
      promise: Promise<ResourceCitationIndex>;
    }
  >();
  private citationIndexGeneration = 0;

  private citationIndex(
    context: ResourceContext,
  ): Promise<ResourceCitationIndex> {
    const key = citationIndexKey(context);
    const cached = this.citationIndexes.get(key);
    if (cached) {
      this.citationIndexes.delete(key);
      this.citationIndexes.set(key, cached);
      return cached.promise;
    }
    const promise = contextMessages(context).then((messages) =>
      buildCitationIndex(context, messages),
    );
    const entry = {
      sessionId: context.sessionId,
      generation: ++this.citationIndexGeneration,
      promise,
    };
    this.citationIndexes.set(key, entry);
    if (this.citationIndexes.size > MAX_CITATION_INDEXES) {
      this.citationIndexes.delete(
        this.citationIndexes.keys().next().value as string,
      );
    }
    void promise.then(
      () => {
        if (this.citationIndexes.get(key) !== entry) return;
        for (const [staleKey, stale] of this.citationIndexes) {
          if (
            staleKey !== key &&
            stale.sessionId === context.sessionId &&
            stale.generation < entry.generation
          )
            this.citationIndexes.delete(staleKey);
        }
      },
      () => {
        if (this.citationIndexes.get(key) === entry)
          this.citationIndexes.delete(key);
      },
    );
    return promise;
  }

  /** Return one bounded page from the complete, revision-bound citation
   * index. The index contains no transcript content or retained handles. */
  async list(
    context: ResourceContext,
    options: ResourceListOptions = {},
  ): Promise<
    Omit<SessionResourceListResponse, "sessionId" | "viewId" | "revision">
  > {
    const index = await this.citationIndex(context);
    const limit = options.limit ?? RESOURCE_LIST_INITIAL_SIZE;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_RESOURCE_LIST_PAGE_SIZE
    ) {
      throw Object.assign(new Error("The resource page size is not valid"), {
        status: 400,
      });
    }
    const offset = options.cursor
      ? resourceCursorOffset(options.cursor, index)
      : 0;
    const end = Math.min(index.resources.length, offset + limit);
    return {
      offset,
      total: index.resources.length,
      nextCursor:
        end < index.resources.length ? encodeResourceCursor(index, end) : null,
      resources: index.resources.slice(offset, end),
    };
  }

  /** Check a bounded reference set without retaining content handles. Every
   * citation check shares one lazy index build. */
  async probe(
    context: ResourceContext,
    references: string[],
  ): Promise<ResourceProbeResult[]> {
    let index: Promise<ResourceCitationIndex> | null = null;
    const getIndex = () => (index ??= this.citationIndex(context));
    return Promise.all(
      references.map(async (reference) => {
        try {
          const descriptor = await this.resolveUsingIndex(
            context,
            reference,
            false,
            getIndex,
          );
          return {
            reference,
            availability: "available" as const,
            ...(descriptor.workspacePath
              ? { workspacePath: descriptor.workspacePath }
              : {}),
          };
        } catch (error) {
          const result = classifiedProbeFailure(reference, error);
          if (result) return result;
          throw error;
        }
      }),
    );
  }

  async resolve(
    context: ResourceContext,
    reference: string,
    retainHandle = true,
    workspacePath?: string,
  ): Promise<ResourceDescriptor> {
    let index: Promise<ResourceCitationIndex> | null = null;
    return this.resolveUsingIndex(
      context,
      reference,
      retainHandle,
      () => (index ??= this.citationIndex(context)),
      workspacePath,
    );
  }

  private async resolveUsingIndex(
    context: ResourceContext,
    reference: string,
    retainHandle: boolean,
    getIndex: () => Promise<ResourceCitationIndex>,
    workspacePath?: string,
  ): Promise<ResourceDescriptor> {
    const embeddedReference = /^pi-embedded:\/\/(\d+)\/(\d+)$/.exec(reference);
    if (embeddedReference) {
      const embedded = (await getIndex()).embedded.get(reference);
      if (!embedded) {
        throw Object.assign(
          new Error("The embedded image is no longer available"),
          { status: 404 },
        );
      }
      const descriptor: ResourceDescriptor = {
        id: randomUUID(),
        sessionId: context.sessionId,
        viewId: context.viewId,
        reference,
        name: `embedded-image-${Number(embeddedReference[1]) + 1}`,
        mimeType: embedded.mimeType,
        size: embedded.size,
        kind: "image",
      };
      if (retainHandle) {
        this.remember({ descriptor, authority: "embedded" });
      }
      return descriptor;
    }

    const exactWorkspaceSelection = workspacePath !== undefined;
    let lexicalPath: string;
    try {
      lexicalPath = exactWorkspaceSelection
        ? exactWorkspacePath(workspacePath, context.cwd)
        : referencePath(reference, context.cwd);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        typeof (error as { status?: unknown }).status === "number"
      )
        throw error;
      throw Object.assign(new Error("The file reference is not valid"), {
        status: 400,
      });
    }

    // Previewable set: files the transcript references, plus files the
    // project index contains (the same authority behind @-search and the
    // workspace explorer). Ignored trees stay out of reach either way
    // unless the session itself cited them. Citation is the costlier
    // authority — it scans the whole transcript — so it is consulted
    // lazily; the cached project index answers the common explorer path.
    let cited: Promise<boolean> | null = null;
    const isCited = () =>
      (cited ??= getIndex().then((index) =>
        referencedByIndex(index, context, reference),
      ));
    const indexed = await isIndexedProjectFile(context.cwd, lexicalPath);
    if (!indexed && (exactWorkspaceSelection || !(await isCited()))) {
      throw Object.assign(
        new Error(
          "The file is not part of this session's workspace or transcript",
        ),
        { status: 403 },
      );
    }

    let path = await realpath(lexicalPath).catch(() => null);
    // A resolved location the index believed in is gone: rescan, so neither
    // the explorer nor search keeps offering it.
    if (path === null && indexed) invalidateProjectIndex(context.cwd);
    // A bare textual mention is shorthand, not a location claim: recover it
    // from the index when exactly one indexed file carries that name, and
    // refuse to guess when several do.
    const name =
      path === null && !exactWorkspaceSelection ? bareName(reference) : null;
    const matches = name ? await indexedBasenameMatches(context.cwd, name) : [];
    const recovered = matches.length === 1 ? matches[0]! : null;
    if (path === null && matches.length > 1) {
      throw Object.assign(
        new Error(`"${name}" names ${matches.length} files in this workspace`),
        {
          status: 409,
          matches,
        },
      );
    }
    const selectedPath = recovered
      ? resolve(context.cwd, recovered)
      : lexicalPath;
    if (path === null && recovered)
      path = await realpath(selectedPath).catch(() => null);
    if (path === null) {
      throw Object.assign(new Error("The referenced file was not found"), {
        status: 404,
      });
    }

    // Index authority ends at the workspace boundary: a project symlink
    // never opens an outside file the way an explicit citation can, and a
    // recovered name answers with an indexed file only — never on the
    // strength of a citation that named something else.
    const workspaceRoot = await realpath(context.cwd).catch(() => null);
    const within =
      workspaceRoot === null ? ".." : relative(workspaceRoot, path);
    const insideWorkspace = !escapesBase(within);
    const canonicalIndexed =
      insideWorkspace &&
      workspaceRoot !== null &&
      (await isIndexedProjectFile(workspaceRoot, path));
    // Indexing a symlink authorizes that directory entry, not an ignored or
    // otherwise unindexed target reached through it. An explicit branch
    // citation remains an independent authority for the resolved file.
    if (
      (recovered !== null && !canonicalIndexed) ||
      (!canonicalIndexed && (exactWorkspaceSelection || !(await isCited())))
    ) {
      throw Object.assign(
        new Error(
          "The file is not part of this session's workspace or transcript",
        ),
        { status: 403 },
      );
    }

    let anchor: FileHandle | undefined;
    try {
      // The descriptor-path witness proves the opened object is still the
      // canonical object authorized above. Retaining that descriptor then pins
      // its inode until the opaque handle expires; probes close it immediately.
      const opened = await openAuthorizedResourceFile(selectedPath, path);
      anchor = opened.handle;
      const details = opened.details;
      if (!details.isFile())
        throw Object.assign(new Error("The reference is not a file"), {
          status: 400,
        });
      if (details.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw Object.assign(
          new Error("The referenced file is too large to preview"),
          { status: 413 },
        );
      }
      const mimeType = mimeTypeFor(path);
      const workspacePath =
        within && !escapesBase(within)
          ? sep === "\\"
            ? within.split(sep).join("/")
            : within
          : undefined;
      const descriptor: ResourceDescriptor = {
        id: randomUUID(),
        sessionId: context.sessionId,
        viewId: context.viewId,
        // A recovery answers with the location it actually opened, so the
        // preview never claims the bare shorthand was a real path.
        reference: recovered ?? reference,
        ...(workspacePath ? { workspacePath } : {}),
        name: basename(path),
        mimeType,
        size: Number(details.size),
        kind: kindFor(mimeType),
      };
      const authority: ResolvedResource["authority"] = canonicalIndexed
        ? exactWorkspaceSelection
          ? "workspace"
          : "index"
        : "citation";
      if (retainHandle) {
        this.remember({
          descriptor,
          selectedPath,
          path,
          fileId: fileIdentity(details),
          anchor,
          authority,
        });
        anchor = undefined;
      } else {
        await anchor.close();
        anchor = undefined;
      }
      return descriptor;
    } catch (error) {
      await anchor?.close().catch(() => undefined);
      throw error;
    }
  }

  /** Open the resource for serving. The retained anchor keeps the originally
   * authorized inode allocated, then this method proves the current pathname
   * still resolves to that same object before streaming a fresh handle. */
  async openForServing(
    resource: ResolvedResource,
  ): Promise<{ handle: FileHandle; size: number }> {
    if (
      !resource.selectedPath ||
      !resource.path ||
      !resource.fileId ||
      !resource.anchor
    ) {
      throw Object.assign(
        new Error("The resource preview is no longer available"),
        { status: 404 },
      );
    }
    let anchored: BigIntStats;
    try {
      anchored = await resource.anchor.stat({ bigint: true });
    } catch {
      throw changedResourceError();
    }
    if (
      !anchored.isFile() ||
      !sameFileObject(fileIdentity(anchored), resource.fileId)
    ) {
      throw changedResourceError();
    }

    let handle: FileHandle;
    let details: BigIntStats;
    try {
      const opened = await openAuthorizedResourceFile(
        resource.selectedPath,
        resource.path,
      );
      handle = opened.handle;
      details = opened.details;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw Object.assign(new Error("The referenced file was not found"), {
          status: 404,
        });
      }
      if (
        code === "EACCES" ||
        code === "ELOOP" ||
        code === "ENOTDIR" ||
        code === "EPERM"
      )
        throw changedResourceError();
      // Descriptor exhaustion and I/O failures are operational failures, not
      // evidence that the authorized pathname changed.
      throw error;
    }
    try {
      if (
        !details.isFile() ||
        !sameFileObject(fileIdentity(details), resource.fileId)
      ) {
        throw changedResourceError();
      }
      if (details.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw Object.assign(
          new Error("The referenced file is too large to preview"),
          { status: 413 },
        );
      }
      return { handle, size: Number(details.size) };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private release(resource: ResolvedResource): void {
    void resource.anchor?.close().catch(() => undefined);
  }

  private remember(resource: ResolvedResource): void {
    this.handles.set(resource.descriptor.id, resource);
    if (this.handles.size > MAX_HANDLES) {
      const id = this.handles.keys().next().value as string;
      const evicted = this.handles.get(id);
      this.handles.delete(id);
      if (evicted) this.release(evicted);
    }
  }

  async close(): Promise<void> {
    const resources = [...this.handles.values()];
    this.handles.clear();
    this.citationIndexes.clear();
    await Promise.all(
      resources.map(async (resource) =>
        resource.anchor?.close().catch(() => undefined),
      ),
    );
  }

  forgetSession(sessionId: string): void {
    for (const [id, resource] of this.handles) {
      if (resource.descriptor.sessionId === sessionId) {
        this.handles.delete(id);
        this.release(resource);
      }
    }
    for (const [key, entry] of this.citationIndexes) {
      if (entry.sessionId === sessionId) this.citationIndexes.delete(key);
    }
  }

  get(id: string, sessionId: string, viewId: string): ResolvedResource {
    const resource = this.handles.get(id);
    if (
      !resource ||
      resource.descriptor.sessionId !== sessionId ||
      resource.descriptor.viewId !== viewId
    ) {
      throw Object.assign(
        new Error("The resource preview is no longer available"),
        { status: 404 },
      );
    }
    return resource;
  }

  async revalidate(
    resource: ResolvedResource,
    context: ResourceContext,
  ): Promise<void> {
    if (
      resource.descriptor.sessionId !== context.sessionId ||
      resource.descriptor.viewId !== context.viewId
    ) {
      throw Object.assign(
        new Error("The resource preview belongs to another branch view"),
        { status: 409 },
      );
    }
    // embeddedContent revalidates an embedded reference against the same message
    // load from which it reads bytes, avoiding a second full transcript load.
    if (resource.authority === "embedded") return;
    if (resource.authority === "workspace" || resource.authority === "index") {
      const workspaceRoot = await realpath(context.cwd).catch(() => null);
      const within =
        workspaceRoot && resource.path
          ? relative(workspaceRoot, resource.path)
          : "..";
      if (workspaceRoot && resource.path && !escapesBase(within)) {
        // Serving is the authority boundary, not the five-second explorer
        // cache. Rebuild once so a newly ignored/deleted path is revoked
        // before any headers or bytes leave the Host.
        invalidateProjectIndex(workspaceRoot);
        if (await isIndexedProjectFile(workspaceRoot, resource.path)) return;
      }
      // An exact Files/Changes selection is index-only: reference syntax must
      // never reinterpret a literal workspace filename as a citation after
      // index membership is revoked. A textual reference that originally had
      // both authorities may still retain its independent exact citation.
      if (resource.authority === "workspace") {
        throw Object.assign(
          new Error("The file is no longer in the workspace index"),
          { status: 403 },
        );
      }
    }
    const index = await this.citationIndex(context);
    if (!referencedByIndex(index, context, resource.descriptor.reference)) {
      throw Object.assign(
        new Error("The resource is no longer cited by the visible branch"),
        { status: 403 },
      );
    }
  }

  async embeddedContent(
    resource: ResolvedResource,
    context: ResourceContext,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const messages = await contextMessages(context);
    const embedded = embeddedCitations(messages).get(
      resource.descriptor.reference,
    );
    const message = embedded ? messages[embedded.messageIndex] : undefined;
    const content =
      message && typeof message === "object"
        ? (message as Record<string, unknown>).content
        : undefined;
    const part =
      embedded && Array.isArray(content)
        ? content[embedded.partIndex]
        : undefined;
    const record =
      part && typeof part === "object"
        ? (part as Record<string, unknown>)
        : undefined;
    const data =
      record && record.type === "image" && typeof record.data === "string"
        ? decodeCanonicalBase64(record.data)
        : null;
    if (!data || !embedded) {
      throw Object.assign(
        new Error("The embedded image is no longer available"),
        { status: 404 },
      );
    }
    return { data, mimeType: embedded.mimeType };
  }
}
