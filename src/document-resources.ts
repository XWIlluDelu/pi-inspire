import type { ResourceDescriptor } from "../shared/contracts";
import { stripResourceLocation } from "../shared/resource-references";

/** Document URLs are locations, not the conversation's filename heuristics.
 * No URL returned here is fetched directly by the browser. */
export function isDocumentFileReference(value: string): boolean {
  return Boolean(
    value &&
      !value.startsWith("#") &&
      !/^[\\/]{2}/.test(value) &&
      (!/^[a-z][a-z\d+.-]*:/i.test(value) ||
        /^(?:file:\/\/|vscode:\/\/file\/|[a-z]:[\\/])/i.test(value)),
  );
}

export function documentResourceReference(
  document: Pick<ResourceDescriptor, "workspacePath" | "reference">,
  target: string,
): string | null {
  if (!isDocumentFileReference(target)) return null;
  if (/^(?:\/|~\/|file:\/\/|vscode:\/\/file\/|[a-z]:[\\/])/i.test(target))
    return target;
  // workspacePath is literal filesystem text, whereas reference is URL-like.
  // Encode only the former so #, %, spaces, and ? keep their path meaning.
  const base =
    document.workspacePath !== undefined
      ? document.workspacePath.split("/").map(encodeURIComponent).join("/")
      : stripResourceLocation(document.reference).replace(/\\/g, "/");
  const directory = base.slice(0, base.lastIndexOf("/") + 1);
  const reference = `${directory}${target}`;
  // Even at project root, a missing document-relative file must not fall back
  // to an unrelated same-basename file elsewhere in the workspace.
  return /^(?:\/|~\/|file:\/\/|vscode:\/\/file\/|[a-z]:[\\/])/i.test(reference)
    ? reference
    : `./${reference}`;
}

const MAX_DOCUMENT_IMAGES = 64;
const MAX_DOCUMENT_IMAGE_BYTES = 64 * 1024 * 1024;
const DOCUMENT_IMAGE_CONCURRENCY = 4;

/** One mounted document owns its queue, deduplicated URLs and aggregate byte
 * budget. Disposing aborts all transfers and never publishes a late URL. */
export class DocumentImageResources {
  private request = new AbortController();
  private pending: Array<() => void> = [];
  private active = 0;
  private bytes = 0;
  private images = new Map<string, Promise<string>>();
  private urls: string[] = [];

  constructor(
    private readonly fetchImage: (
      reference: string,
      signal: AbortSignal,
    ) => Promise<Blob>,
  ) {}

  load(reference: string): Promise<string> {
    const cached = this.images.get(reference);
    if (cached) return cached;
    if (this.request.signal.aborted) return Promise.reject(this.aborted());
    if (this.images.size >= MAX_DOCUMENT_IMAGES)
      return Promise.reject(new Error("Document image preview limit reached"));
    const promise = new Promise<string>((resolve, reject) => {
      this.pending.push(() => {
        this.active += 1;
        void (async () => {
          if (this.request.signal.aborted) throw this.aborted();
          if (this.bytes >= MAX_DOCUMENT_IMAGE_BYTES)
            throw new Error("Document image preview limit reached");
          const blob = await this.fetchImage(reference, this.request.signal);
          if (this.request.signal.aborted) throw this.aborted();
          if (this.bytes + blob.size > MAX_DOCUMENT_IMAGE_BYTES)
            throw new Error("Document image preview limit reached");
          this.bytes += blob.size;
          const url = URL.createObjectURL(blob);
          this.urls.push(url);
          return url;
        })()
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.pump();
          });
      });
    });
    this.images.set(reference, promise);
    this.pump();
    return promise;
  }

  dispose(): void {
    this.request.abort();
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    this.pump();
  }

  private aborted(): Error {
    return Object.assign(
      new Error("The document preview is no longer current"),
      { name: "AbortError" },
    );
  }

  private pump(): void {
    while (this.active < DOCUMENT_IMAGE_CONCURRENCY && this.pending.length)
      this.pending.shift()!();
  }
}
