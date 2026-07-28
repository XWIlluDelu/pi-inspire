import { randomUUID } from "node:crypto";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ResourceDescriptor,
  type ResourceKind,
} from "../shared/contracts.js";
import { collectSessionResourceReferences } from "../shared/resource-references.js";
import { escapesBase } from "./paths.js";
import { indexedBasenameMatches, invalidateProjectIndex, isIndexedProjectFile } from "./project-files.js";

export interface ResourceContext {
  sessionId: string;
  cwd: string;
  /** Tests and static runtimes may provide messages directly; the real
   * runtime supplies a lazy loader so indexed workspace previews avoid a
   * complete transcript RPC read. */
  messages?: unknown[];
  loadMessages?: () => Promise<unknown[]>;
}

export interface ResolvedResource {
  descriptor: ResourceDescriptor;
  path?: string;
  /** Filesystem identity captured at resolve time. Serving re-opens and
   * re-stats, then binds the object it streams to this exact inode so a
   * file swapped for a symlink (or any other file) after authorization is
   * refused, not followed. */
  fileId?: { dev: number; ino: number };
  embedded?: { messageIndex: number; partIndex: number };
}

const MAX_HANDLES = 256;
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
  if (reference.startsWith("<") && reference.endsWith(">")) reference = reference.slice(1, -1);
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
  else if (reference.startsWith("~/")) reference = resolve(homedir(), reference.slice(2));
  return isAbsolute(reference) ? resolve(reference) : resolve(cwd, reference);
}

function mimeTypeFor(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** The bare name a reference carries, or null when it makes a location claim
 * of its own. Only a bare name — `kernel.py`, never `src/kernel.py`, `./x`,
 * or a URL — is shorthand the project index may recover. */
function bareName(reference: string): string | null {
  let value = reference.trim().replace(/^@/, "");
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  value = decoded(stripLocation(value));
  if (!value || value === "~" || /[\\/]/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return null;
  return value;
}

function kindFor(mimeType: string): ResourceKind {
  if (mimeType === "text/html") return "html";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "text/markdown") return "markdown";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("text/") || mimeType.includes("json") || mimeType.includes("xml") || mimeType.includes("toml") || mimeType.includes("yaml")) return "text";
  return "binary";
}

async function contextMessages(context: ResourceContext): Promise<unknown[]> {
  if (context.messages) return context.messages;
  return context.loadMessages ? context.loadMessages() : [];
}

function referencedBySession(context: ResourceContext, messages: unknown[], requested: string): boolean {
  let requestedPath: string;
  try {
    requestedPath = referencePath(requested, context.cwd);
  } catch {
    return false;
  }
  return collectSessionResourceReferences(messages).some((item) => {
    if (!item.reference) return false;
    try {
      return referencePath(item.reference, context.cwd) === requestedPath;
    } catch {
      return false;
    }
  });
}

export class ResourceStore {
  private readonly handles = new Map<string, ResolvedResource>();

  async resolve(context: ResourceContext, reference: string): Promise<ResourceDescriptor> {
    const embedded = /^pi-embedded:\/\/(\d+)\/(\d+)$/.exec(reference);
    if (embedded) {
      const messages = await contextMessages(context);
      const message = messages[Number(embedded[1])];
      const messageRecord = message && typeof message === "object" ? message as Record<string, unknown> : undefined;
      if (messageRecord?.display === false) {
        throw Object.assign(new Error("The embedded image is no longer available"), { status: 404 });
      }
      const content = messageRecord?.content;
      const part = Array.isArray(content) ? content[Number(embedded[2])] : undefined;
      if (!part || typeof part !== "object" || (part as Record<string, unknown>).type !== "image") {
        throw Object.assign(new Error("The embedded image is no longer available"), { status: 404 });
      }
      const record = part as Record<string, unknown>;
      if (typeof record.data !== "string" || typeof record.mimeType !== "string") {
        throw Object.assign(new Error("The embedded image is incomplete"), { status: 404 });
      }
      const mimeType = record.mimeType;
      const messageIndex = Number(embedded[1]);
      const partIndex = Number(embedded[2]);
      const descriptor: ResourceDescriptor = {
        id: randomUUID(),
        sessionId: context.sessionId,
        reference,
        name: `embedded-image-${messageIndex + 1}`,
        mimeType,
        size: Buffer.byteLength(record.data, "base64"),
        kind: "image",
      };
      this.remember({ descriptor, embedded: { messageIndex, partIndex } });
      return descriptor;
    }

    let lexicalPath: string;
    try {
      lexicalPath = referencePath(reference, context.cwd);
    } catch {
      throw Object.assign(new Error("The file reference is not valid"), { status: 400 });
    }

    // Previewable set: files the transcript references, plus files the
    // project index contains (the same authority behind @-search and the
    // workspace explorer). Ignored trees stay out of reach either way
    // unless the session itself cited them. Citation is the costlier
    // authority — it scans the whole transcript — so it is consulted
    // lazily; the cached project index answers the common explorer path.
    let cited: Promise<boolean> | null = null;
    const isCited = () =>
      (cited ??= contextMessages(context).then((messages) => referencedBySession(context, messages, reference)));
    const indexed = await isIndexedProjectFile(context.cwd, lexicalPath);
    if (!indexed && !(await isCited())) {
      throw Object.assign(new Error("The file is not part of this session's workspace or transcript"), { status: 403 });
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
      throw Object.assign(new Error(`"${name}" names ${matches.length} files in this workspace`), {
        status: 409,
        matches,
      });
    }
    if (path === null && recovered) path = await realpath(resolve(context.cwd, recovered)).catch(() => null);
    if (path === null) {
      throw Object.assign(new Error("The referenced file was not found"), { status: 404 });
    }

    // Index authority ends at the workspace boundary: a project symlink
    // never opens an outside file the way an explicit citation can, and a
    // recovered name answers with an indexed file only — never on the
    // strength of a citation that named something else.
    const workspaceRoot = await realpath(context.cwd).catch(() => null);
    const within = workspaceRoot === null ? ".." : relative(workspaceRoot, path);
    if (escapesBase(within) && (recovered !== null || !(await isCited()))) {
      throw Object.assign(new Error("The file is not part of this session's workspace or transcript"), { status: 403 });
    }

    const details = await stat(path);
    if (!details.isFile()) throw Object.assign(new Error("The reference is not a file"), { status: 400 });
    const mimeType = mimeTypeFor(path);
    const descriptor: ResourceDescriptor = {
      id: randomUUID(),
      sessionId: context.sessionId,
      // A recovery answers with the location it actually opened, so the
      // preview never claims the bare shorthand was a real path.
      reference: recovered ?? reference,
      name: basename(path),
      mimeType,
      size: details.size,
      kind: kindFor(mimeType),
    };
    this.remember({ descriptor, path, fileId: { dev: details.dev, ino: details.ino } });
    return descriptor;
  }

  /** Open the resource for serving, bound to the inode inspected at resolve.
   * The returned handle is the exact object streamed to the client — no
   * second path lookup follows — so a file swapped after authorization can
   * neither be opened as the original nor slipped in between check and read. */
  async openForServing(resource: ResolvedResource): Promise<{ handle: FileHandle; size: number }> {
    if (!resource.path || !resource.fileId) {
      throw Object.assign(new Error("The resource preview is no longer available"), { status: 404 });
    }
    const handle = await open(resource.path, "r").catch(() => null);
    if (!handle) throw Object.assign(new Error("The referenced file was not found"), { status: 404 });
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.dev !== resource.fileId.dev || details.ino !== resource.fileId.ino) {
        throw Object.assign(new Error("The referenced file changed on disk; open it again"), { status: 409 });
      }
      return { handle, size: details.size };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private remember(resource: ResolvedResource): void {
    this.handles.set(resource.descriptor.id, resource);
    if (this.handles.size > MAX_HANDLES) this.handles.delete(this.handles.keys().next().value as string);
  }

  get(id: string, sessionId: string): ResolvedResource {
    const resource = this.handles.get(id);
    if (!resource || resource.descriptor.sessionId !== sessionId) {
      throw Object.assign(new Error("The resource preview is no longer available"), { status: 404 });
    }
    return resource;
  }

  async embeddedData(resource: ResolvedResource, context: ResourceContext): Promise<Buffer> {
    const embedded = resource.embedded;
    const messages = await contextMessages(context);
    const message = embedded ? messages[embedded.messageIndex] : undefined;
    const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : undefined;
    const part = embedded && Array.isArray(content) ? content[embedded.partIndex] : undefined;
    const record = part && typeof part === "object" ? part as Record<string, unknown> : undefined;
    if (!record || record.type !== "image" || typeof record.data !== "string") {
      throw Object.assign(new Error("The embedded image is no longer available"), { status: 404 });
    }
    return Buffer.from(record.data, "base64");
  }
}
