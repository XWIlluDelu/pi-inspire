import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ResourceDescriptor,
  type ResourceKind,
  type ResourceProbeResult,
} from "../shared/contracts.js";
import {
  MAX_RESOURCE_LIST_PAGE_SIZE,
  RESOURCE_LIST_INITIAL_SIZE,
  collectSessionResourceReferences,
  type SessionResourceListResponse,
  type SessionResourceReference,
} from "../shared/resource-references.js";
import { escapesBase } from "./paths.js";
import {
  indexedBasenameMatches,
  invalidateProjectIndex,
  isIndexedProjectFile,
} from "./project-files.js";

export interface ResourceContext {
  sessionId: string;
  viewId?: string;
  revision?: number;
  cwd: string;
  /** Tests and static runtimes may provide messages directly; the real
   * runtime supplies a lazy loader so indexed workspace previews avoid a
   * complete transcript RPC read. */
  messages?: unknown[];
  loadMessages?: () => Promise<unknown[]>;
}

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

function changedResourceError(): Error & { status: number } {
  return Object.assign(
    new Error("The referenced file changed on disk; open it again"),
    { status: 409 },
  );
}

export interface ResolvedResource {
  descriptor: ResourceDescriptor;
  path?: string;
  /** Filesystem object captured at resolve time. The retained anchor keeps
   * that inode allocated, making the device/inode pair non-reusable while this
   * opaque resource handle is live. */
  fileId?: FileIdentity;
  /** Never streamed: it anchors fileId until eviction, session deletion, or
   * server shutdown. A separately opened serving handle can still observe a
   * legitimate in-place rewrite of this same filesystem object. */
  anchor?: FileHandle;
  embedded?: { messageIndex: number; partIndex: number };
  authority: "embedded" | "index" | "citation";
}

const MAX_HANDLES = 256;
const RESOURCE_OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_CITATION_INDEXES = 32;
const LOCATION_FRAGMENT = /#L\d+(?:-L\d+)?$/i;
const LOCATION_SUFFIX = /:\d+(?::\d+)?$/;

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
  ".ipynb": "application/json",
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
  ".png": "image/png",
  ".py": "text/x-python",
  ".r": "text/x-r",
  ".rs": "text/x-rust",
  ".sh": "text/x-shellscript",
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

function stripLocation(reference: string): string {
  return reference
    .replace(LOCATION_FRAGMENT, "")
    .replace(/[?#].*$/u, "")
    .replace(LOCATION_SUFFIX, "");
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Resolve only filesystem syntax; authorization and realpath checks follow. */
export function referencePath(referenceInput: string, cwd: string): string {
  let reference = referenceInput.trim().replace(/^@/, "");
  if (reference.startsWith("<") && reference.endsWith(">"))
    reference = reference.slice(1, -1);
  reference = stripLocation(reference);

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
    MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream"
  );
}

/** The bare name a reference carries, or null when it makes a location claim
 * of its own. Only a bare name — `kernel.py`, never `src/kernel.py`, `./x`,
 * or a URL — is shorthand the project index may recover. */
function bareName(reference: string): string | null {
  let value = reference.trim().replace(/^@/, "");
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  value = decoded(stripLocation(value));
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

async function contextMessages(context: ResourceContext): Promise<unknown[]> {
  if (context.messages) return context.messages;
  return context.loadMessages ? context.loadMessages() : [];
}

function resourceViewId(context: ResourceContext): string {
  return context.viewId ?? `legacy-view:${context.sessionId}`;
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

function contextRevision(context: ResourceContext): number {
  return typeof context.revision === "number" &&
    Number.isSafeInteger(context.revision)
    ? context.revision
    : 0;
}

function citationIndexKey(context: ResourceContext): string | null {
  return context.viewId && Number.isSafeInteger(context.revision)
    ? JSON.stringify([context.sessionId, context.viewId, context.revision])
    : null;
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
      embedded.set(`pi-embedded://${persistedIndex}/${partIndex}`, {
        messageIndex,
        partIndex,
        mimeType: image.mimeType,
        size: Buffer.byteLength(image.data, "base64"),
      });
    });
  });

  return {
    sessionId: context.sessionId,
    viewId: resourceViewId(context),
    revision: contextRevision(context),
    resources,
    citedPaths,
    embedded,
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
    if (!key)
      return contextMessages(context).then((messages) =>
        buildCitationIndex(context, messages),
      );
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
          await this.resolveUsingIndex(context, reference, false, getIndex);
          return { reference, availability: "available" as const };
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
  ): Promise<ResourceDescriptor> {
    let index: Promise<ResourceCitationIndex> | null = null;
    return this.resolveUsingIndex(
      context,
      reference,
      retainHandle,
      () => (index ??= this.citationIndex(context)),
    );
  }

  private async resolveUsingIndex(
    context: ResourceContext,
    reference: string,
    retainHandle: boolean,
    getIndex: () => Promise<ResourceCitationIndex>,
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
        viewId: resourceViewId(context),
        reference,
        name: `embedded-image-${Number(embeddedReference[1]) + 1}`,
        mimeType: embedded.mimeType,
        size: embedded.size,
        kind: "image",
      };
      if (retainHandle) {
        this.remember({
          descriptor,
          embedded: {
            messageIndex: embedded.messageIndex,
            partIndex: embedded.partIndex,
          },
          authority: "embedded",
        });
      }
      return descriptor;
    }

    let lexicalPath: string;
    try {
      lexicalPath = referencePath(reference, context.cwd);
    } catch {
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
    if (!indexed && !(await isCited())) {
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
    const name = path === null ? bareName(reference) : null;
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
    if (path === null && recovered)
      path = await realpath(resolve(context.cwd, recovered)).catch(() => null);
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
    if (escapesBase(within) && (recovered !== null || !(await isCited()))) {
      throw Object.assign(
        new Error(
          "The file is not part of this session's workspace or transcript",
        ),
        { status: 403 },
      );
    }

    let anchor: FileHandle | undefined;
    try {
      // Retaining an open descriptor pins the authorized inode until the
      // opaque handle expires. It is stronger than a stat-version fingerprint:
      // a deleted object cannot have its inode number reused while this anchor
      // remains open, while legitimate writes to that same object stay visible.
      let details: BigIntStats;
      if (retainHandle) {
        anchor = await open(path, RESOURCE_OPEN_FLAGS);
        details = await anchor.stat({ bigint: true });
      } else {
        details = await stat(path, { bigint: true });
      }
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
      const descriptor: ResourceDescriptor = {
        id: randomUUID(),
        sessionId: context.sessionId,
        viewId: resourceViewId(context),
        // A recovery answers with the location it actually opened, so the
        // preview never claims the bare shorthand was a real path.
        reference: recovered ?? reference,
        name: basename(path),
        mimeType,
        size: Number(details.size),
        kind: kindFor(mimeType),
      };
      const authority: ResolvedResource["authority"] =
        (indexed && !escapesBase(within)) || recovered !== null
          ? "index"
          : "citation";
      if (retainHandle) {
        this.remember({
          descriptor,
          path,
          fileId: fileIdentity(details),
          anchor,
          authority,
        });
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
    if (!resource.path || !resource.fileId || !resource.anchor) {
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
    try {
      handle = await open(resource.path, RESOURCE_OPEN_FLAGS);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw Object.assign(new Error("The referenced file was not found"), {
          status: 404,
        });
      }
      throw changedResourceError();
    }
    try {
      const details = await handle.stat({ bigint: true });
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

  get(id: string, sessionId: string, viewId?: string): ResolvedResource {
    const resource = this.handles.get(id);
    if (
      !resource ||
      resource.descriptor.sessionId !== sessionId ||
      (viewId !== undefined && resource.descriptor.viewId !== viewId)
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
      resource.descriptor.viewId !== resourceViewId(context)
    ) {
      throw Object.assign(
        new Error("The resource preview belongs to another branch view"),
        { status: 409 },
      );
    }
    if (resource.authority === "embedded") return;
    if (resource.authority === "index") {
      let lexicalPath: string;
      try {
        lexicalPath = referencePath(resource.descriptor.reference, context.cwd);
      } catch {
        throw Object.assign(
          new Error("The resource is no longer authorized by the workspace"),
          { status: 403 },
        );
      }
      if (await isIndexedProjectFile(context.cwd, lexicalPath)) return;
      throw Object.assign(
        new Error("The resource is no longer authorized by the workspace"),
        { status: 403 },
      );
    }
    const index = await this.citationIndex(context);
    if (!referencedByIndex(index, context, resource.descriptor.reference)) {
      throw Object.assign(
        new Error("The resource is no longer cited by the visible branch"),
        { status: 403 },
      );
    }
  }

  async embeddedData(
    resource: ResolvedResource,
    context: ResourceContext,
  ): Promise<Buffer> {
    const embedded = resource.embedded;
    const messages = await contextMessages(context);
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
    if (!record || record.type !== "image" || typeof record.data !== "string") {
      throw Object.assign(
        new Error("The embedded image is no longer available"),
        { status: 404 },
      );
    }
    return Buffer.from(record.data, "base64");
  }
}
