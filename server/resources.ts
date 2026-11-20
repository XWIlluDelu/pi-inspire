import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { parseComposerArtifactReference } from "../shared/composer-artifact-references.js";
import {
  MAX_PROMPT_IMAGE_BYTES,
  type ResourceDescriptor,
  type ResourceKind,
  type ResourceProbeResult,
} from "../shared/contracts.js";
import {
  HTML_PREVIEW_BYTES,
  type HtmlPreviewResponse,
} from "../shared/html-preview.js";
import { jsonRecord } from "../shared/json-record.js";
import { isSupportedPromptImageMimeType } from "../shared/image-types.js";
import {
  collectSessionResourceReferences,
  fileResourceReference,
  isEmbeddedImageReference,
  isTextFileName,
  MAX_RESOURCE_LIST_PAGE_SIZE,
  MAX_RESOURCE_PATH_LENGTH,
  resourceRefusal,
  type SessionResourceReference,
  stripResourceLocation,
} from "../shared/resource-references.js";
import { filesystemRelativePath } from "./filesystem-containment.js";
import { canonicalBase64DecodedSize } from "./image-content.js";
import { resolveUserPath } from "./paths.js";
import {
  invalidateProjectFiles,
  workspaceBasenameMatches,
} from "./project-files.js";
import { requestError } from "./request-error.js";

/** A revision-bound lazy source keeps workspace reads independent of history. */
export interface ResourceContext {
  sessionId: string;
  viewId: string;
  revision: number;
  cwd: string;
  loadMessages(): Promise<readonly unknown[]>;
  loadHistoryImage(
    entryId: string,
    part: number,
  ): Promise<{ block: unknown; messageIndex: number } | null>;
}

const RESOURCE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;

function changedResourceError(): Error & { status: number } {
  return requestError(
    "The referenced file changed on disk; open it again",
    409,
  );
}

function nonFileResourceError(): Error & { status: number } {
  return requestError("The reference is not a file", 400);
}

/** Open the path the user actually selected and prove that its descriptor
 * is the canonical file we authorized. For an already-canonical path,
 * `O_NOFOLLOW` also rejects a final-component exchange. For a selected symlink
 * or symlinked cwd, the post-open path and inode witnesses bind the followed
 * chain to the retained descriptor without relying on a platform-specific
 * descriptor filesystem. */
export async function openAuthorizedResourceFile(
  selectedPath: string,
  canonicalPath: string,
  purpose: "resolve" | "serve" = "serve",
): Promise<{ handle: FileHandle; details: BigIntStats }> {
  const flags =
    RESOURCE_OPEN_FLAGS |
    (selectedPath === canonicalPath ? constants.O_NOFOLLOW : 0);
  const handle = await open(selectedPath, flags).catch(
    (error: NodeJS.ErrnoException) => {
      if (purpose === "resolve" && error.code === "EISDIR")
        throw nonFileResourceError();
      throw error;
    },
  );
  try {
    const [openedPath, details, linked] = await Promise.all([
      realpath(selectedPath),
      handle.stat({ bigint: true }),
      lstat(canonicalPath, { bigint: true }),
    ]);
    if (
      openedPath !== canonicalPath ||
      details.dev !== linked.dev ||
      details.ino !== linked.ino
    )
      throw changedResourceError();
    if (!details.isFile() || !linked.isFile()) {
      if (purpose === "resolve") throw nonFileResourceError();
      throw changedResourceError();
    }
    return { handle, details };
  } catch (error) {
    await handle.close().catch(() => undefined);
    const status = (error as { status?: unknown }).status;
    if (status === 400 || status === 409) throw error;
    throw changedResourceError();
  }
}

export function openCanonicalResourceFile(canonicalPath: string) {
  return openAuthorizedResourceFile(canonicalPath, canonicalPath);
}

type ResourceLocator =
  | { authority: "embedded" }
  | {
      /** Absolute path selected by the reference before symlink resolution. */
      selectedPath: string;
      /** Canonical target pinned by this opaque handle. */
      path: string;
      /** Index root to invalidate if an indexed serving path disappears. */
      workspaceRoot?: string;
      authority: "workspace" | "filesystem" | "citation";
    };
type ResourceCandidate = ResourceLocator & {
  descriptor: Omit<ResourceDescriptor, "id">;
};

interface HtmlPreview {
  resourceId: string;
  sessionId: string;
  root: string;
  entryPath: string;
  html: string;
}

type ResolvedResource = ResourceCandidate & { descriptor: ResourceDescriptor };

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
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
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

/** Confine an exact selection before touching its file; realpath checks follow. */
async function exactWorkspacePath(
  workspacePath: string,
  cwd: string,
): Promise<string> {
  if (isAbsolute(workspacePath) || workspacePath.includes("\0")) {
    throw requestError("The workspace path is not valid", 400);
  }
  const root = resolve(cwd);
  const candidate = resolve(root, workspacePath);
  if ((await filesystemRelativePath(root, candidate)) === null) {
    throw requestError("The workspace path is not valid", 400);
  }
  return candidate;
}

/** Resolve link-form resource syntax. Callers with literal filesystem text
 * must first use fileResourceReference, or the exact workspacePath channel. */
export function referencePath(referenceInput: string, cwd: string): string {
  let reference = referenceInput.trim().replace(/^@/, "");
  if (reference.startsWith("<") && reference.endsWith(">"))
    reference = reference.slice(1, -1);
  reference = stripResourceLocation(reference);

  if (/^vscode:\/\/file\//i.test(reference)) {
    // VS Code puts the filesystem path after the `file` authority. Convert
    // through a file URL so Windows drive prefixes (/C:/...) and escaping
    // follow native URL-to-path rules without damaging POSIX absolute paths.
    const url = new URL("file:///");
    url.pathname = new URL(reference).pathname;
    reference = fileURLToPath(url);
  } else if (/^file:\/\//i.test(reference)) {
    const url = new URL(reference);
    url.hash = "";
    url.search = "";
    reference = fileURLToPath(url);
  } else {
    reference = decoded(reference);
  }

  if (reference.length > MAX_RESOURCE_PATH_LENGTH)
    throw requestError("The resource path is too long", 400);
  return resolveUserPath(reference, cwd);
}

/** Once the Host has resolved a reference, normalize only its native path
 * separators for document URL joining. POSIX backslashes are filename bytes;
 * Windows backslashes are directory separators. Do not reinterpret URL syntax. */
function descriptorReference(reference: string): string {
  return /^(?:file:\/\/|vscode:\/\/file\/)/iu.test(reference)
    ? reference
    : reference.replaceAll("\\", sep === "\\" ? "/" : "%5C");
}

export function mimeTypeFor(path: string): string {
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

async function openedResourceMimeType(
  path: string,
  handle: FileHandle,
): Promise<string> {
  // Property lists may be XML/OpenStep text or a binary plist on the same
  // current macOS system. Sniff only its bounded signature through the already
  // authorized descriptor; never read a pathname again for classification.
  if (extname(path).toLowerCase() === ".plist") {
    const signature = Buffer.alloc(8);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    if (bytesRead === 8 && signature.toString("ascii") === "bplist00")
      return "application/octet-stream";
  }
  return mimeTypeFor(path);
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

interface ResourceCitationIndex {
  recent: SessionResourceReference[];
  citedPaths: Set<string>;
}

async function embeddedImage(context: ResourceContext, reference: string) {
  const history = parseComposerArtifactReference("image", reference);
  let image: { messageIndex: number; block: unknown } | null = null;
  if (history) {
    image = await context.loadHistoryImage(...history);
  } else {
    const coordinates = /^pi-embedded:\/\/(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(
      reference,
    );
    if (coordinates) {
      const messageIndex = Number(coordinates[1]);
      const message = jsonRecord((await context.loadMessages())[messageIndex]);
      if (message?.display !== false && Array.isArray(message?.content))
        image = {
          messageIndex,
          block: message.content[Number(coordinates[2])],
        };
    }
  }
  const block = jsonRecord(image?.block);
  if (
    image &&
    block?.type === "image" &&
    typeof block.data === "string" &&
    typeof block.mimeType === "string" &&
    isSupportedPromptImageMimeType(block.mimeType)
  ) {
    const size = canonicalBase64DecodedSize(block.data);
    if (size && size <= MAX_PROMPT_IMAGE_BYTES)
      return {
        messageIndex: image.messageIndex,
        data: block.data,
        mimeType: block.mimeType,
        size,
      };
  }
  throw requestError("The embedded image is no longer available", 404);
}

function buildCitationIndex(
  context: ResourceContext,
  messages: readonly unknown[],
): ResourceCitationIndex {
  const resources = collectSessionResourceReferences(messages);
  const recent: SessionResourceReference[] = [];
  const citedPaths = new Set<string>();
  let writes = 0;
  for (const resource of resources) {
    // Keep the newest page and enough older writes to fill the output list.
    if (
      recent.length < MAX_RESOURCE_LIST_PAGE_SIZE ||
      (resource.writes && writes < MAX_RESOURCE_LIST_PAGE_SIZE)
    ) {
      recent.push(resource);
      if (resource.writes) writes++;
    }
    if (!resource.reference || resource.reference.startsWith("pi-embedded://"))
      continue;
    try {
      citedPaths.add(referencePath(resource.reference, context.cwd));
    } catch {
      // Invalid references remain visible but confer no path authority.
    }
  }

  return { recent, citedPaths };
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
  private readonly htmlPreviews = new Map<string, HtmlPreview>();
  // One current observation per session. An older in-flight reader retains its own promise.
  private readonly citationIndexes = new Map<
    string,
    {
      viewId: string;
      revision: number;
      index: Promise<ResourceCitationIndex>;
    }
  >();

  private citationIndex(
    context: ResourceContext,
  ): Promise<ResourceCitationIndex> {
    const { sessionId, viewId, revision } = context;
    const cached = this.citationIndexes.get(sessionId);
    this.citationIndexes.delete(sessionId);
    if (cached?.viewId === viewId && cached.revision === revision) {
      this.citationIndexes.set(sessionId, cached);
      return cached.index;
    }
    const index = context
      .loadMessages()
      .then((messages) => buildCitationIndex(context, messages));
    this.citationIndexes.set(sessionId, { viewId, revision, index });
    if (this.citationIndexes.size > MAX_CITATION_INDEXES)
      this.citationIndexes.delete(this.citationIndexes.keys().next().value!);
    void index.catch(() => {
      if (this.citationIndexes.get(sessionId)?.index === index)
        this.citationIndexes.delete(sessionId);
    });
    return index;
  }

  /** Include the newest references and the most recent writes outside that page. */
  async list(context: ResourceContext): Promise<SessionResourceReference[]> {
    return (await this.citationIndex(context)).recent.slice();
  }

  /** Check a bounded reference set without retaining content handles. Every
   * citation check shares one lazy index build. */
  async probe(
    context: ResourceContext,
    references: string[],
  ): Promise<ResourceProbeResult[]> {
    return Promise.all(
      references.map(async (reference) => {
        try {
          const resource = await this.resolveCandidate(
            context,
            reference,
          );
          return {
            reference,
            availability: "available" as const,
            ...(resource.descriptor.workspacePath
              ? { workspacePath: resource.descriptor.workspacePath }
              : {}),
          };
        } catch (error) {
          const result = resourceRefusal(reference, error);
          if (result) return result;
          throw error;
        }
      }),
    );
  }

  async resolve(
    context: ResourceContext,
    reference: string,
    workspacePath?: string,
  ): Promise<ResourceDescriptor> {
    const resource = await this.resolveCandidate(
      context,
      reference,
      workspacePath,
    );
    const descriptor = { id: randomUUID(), ...resource.descriptor };
    this.remember({ ...resource, descriptor });
    return descriptor;
  }

  async fileManagerPath(
    context: ResourceContext,
    reference: string,
    workspacePath?: string,
    directory = false,
  ): Promise<string> {
    if (directory) {
      if (workspacePath === undefined)
        throw requestError("Choose a workspace directory", 400);
      const selected = await exactWorkspacePath(workspacePath, context.cwd);
      const root = await realpath(context.cwd);
      const path = await realpath(selected).catch(() => null);
      if (path === null) throw requestError("The directory was not found", 404);
      if ((await filesystemRelativePath(root, path)) === null)
        throw requestError("The directory is outside the project", 403);
      if (!(await lstat(path)).isDirectory())
        throw requestError("The reference is not a directory", 400);
      return path;
    }
    const resource = await this.resolveCandidate(
      context,
      reference,
      workspacePath,
    );
    if (resource.authority === "embedded")
      throw requestError("This resource has no file on disk", 400);
    return resource.path;
  }

  private async resolveCandidate(
    context: ResourceContext,
    reference: string,
    workspacePath?: string,
  ): Promise<ResourceCandidate> {
    if (isEmbeddedImageReference(reference)) {
      const embedded = await embeddedImage(context, reference);
      return {
        descriptor: {
          sessionId: context.sessionId,
          viewId: context.viewId,
          reference,
          name: `embedded-image-${embedded.messageIndex + 1}`,
          mimeType: embedded.mimeType,
          size: embedded.size,
          kind: "image",
        },
        authority: "embedded",
      };
    }

    const exactWorkspaceSelection = workspacePath !== undefined;
    let lexicalPath: string;
    try {
      lexicalPath = exactWorkspaceSelection
        ? await exactWorkspacePath(workspacePath, context.cwd)
        : referencePath(reference, context.cwd);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        typeof (error as { status?: unknown }).status === "number"
      )
        throw error;
      throw requestError("The file reference is not valid", 400);
    }

    // Workspace access is independent of bounded discovery and Git. Check
    // lexical containment before touching a path, then canonical containment
    // after resolution. Explicit citations remain a separate outside-workspace
    // authority and are loaded only when that authority is needed.
    let cited: Promise<boolean> | null = null;
    const isCited = () =>
      (cited ??= this.citationIndex(context).then((index) =>
        referencedByIndex(index, context, reference),
      ));
    const lexicalWithin = await filesystemRelativePath(
      context.cwd,
      lexicalPath,
    );
    const lexicalInside = lexicalWithin !== null && lexicalWithin !== "";
    if (!lexicalInside && (exactWorkspaceSelection || !(await isCited()))) {
      throw requestError(
        "The file is not part of this session's workspace or transcript",
        403,
      );
    }

    let path = await realpath(lexicalPath).catch(() => null);
    // Shorthand needs fresh discovery, but simultaneous misses can share
    // its in-flight scan. The absent literal name isn't a stale search result.
    const name =
      path === null && !exactWorkspaceSelection ? bareName(reference) : null;
    const search = name
      ? await workspaceBasenameMatches(context.cwd, name, true)
      : { matches: [], truncated: false };
    const { matches } = search;
    if (path === null && (matches.length > 1 || search.truncated)) {
      throw requestError(
        search.truncated
          ? `Cannot establish a unique location for "${name}"; use its full workspace path`
          : `"${name}" names ${matches.length} files in this workspace`,
        409,
        { matches },
      );
    }
    const recovered = matches.length === 1 ? matches[0]! : null;
    const selectedPath = recovered
      ? resolve(context.cwd, recovered)
      : lexicalPath;
    if (path === null && recovered)
      path = await realpath(selectedPath).catch(() => null);
    if (path === null) {
      if (lexicalInside && (!name || recovered)) invalidateProjectFiles();
      throw requestError("The referenced file was not found", 404);
    }

    // A workspace symlink and a recovered shorthand never borrow citation
    // authority to leave the workspace.
    const workspaceRoot = await realpath(context.cwd).catch(() => null);
    const within =
      workspaceRoot === null
        ? null
        : await filesystemRelativePath(workspaceRoot, path);
    const insideWorkspace = within !== null;
    if (
      !insideWorkspace &&
      (recovered !== null || exactWorkspaceSelection || !(await isCited()))
    ) {
      throw requestError(
        "The file is not part of this session's workspace or transcript",
        403,
      );
    }

    const { handle, details } = await openAuthorizedResourceFile(
      selectedPath,
      path,
      "resolve",
    );
    try {
      if (details.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw requestError("The referenced file is too large to preview", 413);
      }
      const mimeType = await openedResourceMimeType(path, handle);
      const workspacePath = within
        ? sep === "\\"
          ? within.split(sep).join("/")
          : within
        : undefined;
      const descriptor: ResourceCandidate["descriptor"] = {
        sessionId: context.sessionId,
        viewId: context.viewId,
        // A recovery answers with the location it actually opened, so the
        // preview never claims the bare shorthand was a real path.
        reference: descriptorReference(
          recovered ? fileResourceReference(recovered) : reference,
        ),
        ...(workspacePath ? { workspacePath } : {}),
        name: basename(path),
        mimeType,
        size: Number(details.size),
        kind: kindFor(mimeType),
      };
      const authority: ResourceCandidate["authority"] = insideWorkspace
        ? exactWorkspaceSelection
          ? "workspace"
          : "filesystem"
        : "citation";
      return {
        descriptor,
        selectedPath,
        path,
        ...(insideWorkspace && workspaceRoot ? { workspaceRoot } : {}),
        authority,
      };
    } finally {
      await handle.close();
    }
  }

  /** Open the currently authorized logical file for one response. */
  async openForServing(
    resource: Extract<ResolvedResource, { path: string }>,
  ): Promise<{ handle: FileHandle; details: BigIntStats }> {
    try {
      return await openAuthorizedResourceFile(
        resource.selectedPath,
        resource.path,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        if (resource.workspaceRoot)
          invalidateProjectFiles();
        throw requestError("The referenced file was not found", 404);
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
  }

  private remember(resource: ResolvedResource): void {
    this.handles.set(resource.descriptor.id, resource);
    if (this.handles.size > MAX_HANDLES)
      this.forgetHandle(this.handles.keys().next().value!);
  }

  private forgetHandle(id: string): void {
    this.handles.delete(id);
    for (const [previewId, preview] of this.htmlPreviews) {
      if (preview.resourceId === id) this.htmlPreviews.delete(previewId);
    }
  }

  close(): void {
    this.handles.clear();
    this.htmlPreviews.clear();
    this.citationIndexes.clear();
  }

  forgetSession(sessionId: string): void {
    for (const [id, resource] of this.handles) {
      if (resource.descriptor.sessionId === sessionId) this.forgetHandle(id);
    }
    this.citationIndexes.delete(sessionId);
  }

  async createHtmlPreview(
    resourceId: string,
    context: ResourceContext,
    html: string,
  ): Promise<HtmlPreviewResponse> {
    if (Buffer.byteLength(html) > HTML_PREVIEW_BYTES)
      throw requestError("The HTML is too large for interactive preview", 413);
    const resource = await this.authorize(resourceId, context);
    if (
      resource.descriptor.kind !== "html" ||
      resource.authority === "embedded"
    )
      throw requestError("Only HTML files support interactive preview", 400);
    const root = resource.workspaceRoot ?? dirname(resource.path);
    const entryPath = relative(root, resource.path);
    const id = randomUUID();
    this.htmlPreviews.set(id, {
      resourceId,
      sessionId: context.sessionId,
      root,
      entryPath,
      html,
    });
    if (this.htmlPreviews.size > 32)
      this.htmlPreviews.delete(this.htmlPreviews.keys().next().value!);
    return {
      id,
      url: `/html-preview/${id}/${entryPath.split(sep).map(encodeURIComponent).join("/")}`,
    };
  }

  removeHtmlPreview(id: string, sessionId: string): void {
    if (this.htmlPreviews.get(id)?.sessionId === sessionId)
      this.htmlPreviews.delete(id);
  }

  getHtmlPreview(id: string): HtmlPreview {
    const preview = this.htmlPreviews.get(id);
    if (!preview) throw requestError("The interactive preview has ended", 404);
    return preview;
  }

  get(id: string, sessionId: string, viewId: string): ResolvedResource {
    const resource = this.handles.get(id);
    if (
      !resource ||
      resource.descriptor.sessionId !== sessionId ||
      resource.descriptor.viewId !== viewId
    ) {
      throw requestError("The resource preview is no longer available", 404);
    }
    return resource;
  }

  async authorize(
    id: string,
    context: ResourceContext,
  ): Promise<ResolvedResource> {
    const resource = this.get(id, context.sessionId, context.viewId);
    await this.checkAuthority(resource, context);
    return this.get(id, context.sessionId, context.viewId);
  }

  private async checkAuthority(
    resource: ResolvedResource,
    context: ResourceContext,
  ): Promise<void> {
    // embeddedContent revalidates an embedded reference against the same message
    // load from which it reads bytes, avoiding a second full transcript load.
    if (resource.authority === "embedded") return;
    if (
      resource.authority === "workspace" ||
      resource.authority === "filesystem"
    ) {
      const workspaceRoot = await realpath(context.cwd).catch(() => null);
      const within =
        workspaceRoot && workspaceRoot === resource.workspaceRoot
          ? await filesystemRelativePath(workspaceRoot, resource.path)
          : null;
      if (within) return;
      // Exact selections are literal paths, never reinterpreted as citations.
      // Serving additionally checks that the selected path still resolves to the authorized path.
      if (resource.authority === "workspace") {
        throw requestError("The file is no longer inside this workspace", 403);
      }
    }
    const index = await this.citationIndex(context);
    if (!referencedByIndex(index, context, resource.descriptor.reference)) {
      throw requestError(
        "The resource is no longer cited by the visible branch",
        403,
      );
    }
  }

  async embeddedContent(
    resource: ResolvedResource,
    context: ResourceContext,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const { data, mimeType } = await embeddedImage(
      context,
      resource.descriptor.reference,
    );
    return { data: Buffer.from(data, "base64"), mimeType };
  }
}
