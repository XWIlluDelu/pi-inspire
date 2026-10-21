export interface CopyContent {
  text: string;
  images?: Blob[];
}

export type CopySource = string | CopyContent;
export interface CopyFormats {
  text: boolean;
  image: boolean;
}

export interface CopyLoader {
  (signal: AbortSignal): Promise<CopySource | null>;
  /** Formats are known before reading so gesture-bound browsers can accept a
   * promise-backed ClipboardItem. Undefined supports an older, unbounded view. */
  readonly formats: CopyFormats | undefined;
}

export function copyLoader(
  load: (signal: AbortSignal) => Promise<CopySource | null>,
  formats: CopyFormats | null = { text: true, image: false },
): CopyLoader {
  return Object.assign(load, { formats: formats ?? undefined });
}

// Chromium can explicitly grant background writes. Other engines require the
// write request in the input gesture, even when its data arrives much later.
let permissionSource: Permissions | undefined;
let writePermission: PermissionStatus | undefined;
function observeClipboardPermission(): void {
  const permissions =
    typeof navigator === "undefined" ? undefined : navigator.permissions;
  if (permissions === permissionSource) return;
  permissionSource = permissions;
  writePermission = undefined;
  try {
    const descriptor = {
      name: "clipboard-write" as PermissionName,
      allowWithoutGesture: true,
    };
    void permissions
      ?.query(descriptor)
      .then((status) => {
        if (permissionSource === permissions) writePermission = status;
      })
      .catch(() => {});
  } catch {
    // Not every Permissions implementation recognizes clipboard-write.
  }
}
observeClipboardPermission();

let activeCopy: AbortController | null = null;

function copyCancelled(): DOMException {
  return new DOMException("Copy cancelled", "AbortError");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? copyCancelled());
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/** Inline images do not make network requests (connect-src excludes data URLs). */
export async function imageSourceBlob(
  src: string,
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted();
  const inline = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(
    src,
  );
  if (inline) {
    const bytes = Uint8Array.from(atob(inline[2]!), (character) =>
      character.charCodeAt(0),
    );
    return new Blob([bytes], { type: inline[1] });
  }
  // Saved previews use owned blob URLs. Decode through img-src rather than
  // weakening connect-src just to fetch a browser-local blob.
  if (!src.startsWith("blob:")) throw new Error("Image data is unavailable");
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
    signal.throwIfAborted();
    return await canvasPng(image, image.naturalWidth, image.naturalHeight);
  } finally {
    image.src = "";
  }
}

async function clipboardPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  if (!["image/jpeg", "image/gif", "image/webp"].includes(blob.type))
    throw new Error(
      "This image format cannot be copied. Download the original instead.",
    );
  const bitmap = await createImageBitmap(blob);
  try {
    return await canvasPng(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

function canvasPng(
  image: CanvasImageSource,
  width: number,
  height: number,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image copying is unavailable in this browser");
  context.drawImage(image, 0, 0);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (png) =>
        png ? resolve(png) : reject(new Error("Image conversion failed")),
      "image/png",
    ),
  );
}

/** Initiate a gesture-bound write before asynchronous reads/decoding. The
 * complete source must validate before any promised format resolves. A newer
 * copy retires older reads across controls, not only within one button. */
export async function writeCopyContent(
  source: CopySource | CopyLoader,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
): Promise<boolean> {
  activeCopy?.abort(copyCancelled());
  const owner = new AbortController();
  activeCopy = owner;
  const abort = () => owner.abort(signal?.reason ?? copyCancelled());
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const current = () =>
    activeCopy === owner && !owner.signal.aborted && isCurrent();
  observeClipboardPermission();
  let sourceError: unknown;
  let cancelled = false;
  try {
    if (!current()) return false;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText && !clipboard?.write)
      throw new Error("Clipboard access is unavailable in this browser");

    // Already available text never leaves the gesture, including browsers
    // that have writeText but no ClipboardItem support.
    if (
      typeof source !== "function" &&
      (typeof source === "string" || !source.images?.length)
    ) {
      if (!clipboard.writeText)
        throw new Error("Text copying is unavailable in this browser");
      await clipboard.writeText(
        typeof source === "string" ? source : source.text,
      );
      return current();
    }

    const formats =
      typeof source === "function"
        ? source.formats
        : {
            text: Boolean(source.text),
            image: Boolean(source.images?.length),
          };
    const preparation = (async () => {
      try {
        const loaded =
          typeof source === "function" ? await source(owner.signal) : source;
        if (loaded === null || !current()) {
          cancelled = true;
          throw copyCancelled();
        }
        const content = typeof loaded === "string" ? { text: loaded } : loaded;
        const images: Blob[] = [];
        for (const image of content.images ?? []) {
          images.push(await clipboardPng(image));
          if (!current()) {
            cancelled = true;
            throw copyCancelled();
          }
        }
        const actual = {
          text: !images.length || Boolean(content.text),
          image: images.length > 0,
        };
        if (
          formats &&
          (formats.text !== actual.text || formats.image !== actual.image)
        )
          throw new Error("The copy source changed. Refresh it and try again.");
        return { text: content.text, images };
      } catch (error) {
        sourceError = error;
        throw error;
      }
    })();
    const ready = abortable(preparation, owner.signal);
    // Permission rejection can precede the content read. Always observe its
    // rejection, even if the browser never asks for a promised format.
    void ready.catch(() => {});

    if (
      formats &&
      clipboard.write &&
      typeof ClipboardItem !== "undefined" &&
      writePermission?.state !== "granted"
    ) {
      const data: Record<string, Promise<Blob>> = {};
      if (formats.text)
        data["text/plain"] = ready.then((content) => {
          if (!current()) throw copyCancelled();
          return new Blob([content.text], { type: "text/plain" });
        });
      if (formats.image)
        data["image/png"] = ready.then((content) => {
          if (!current()) throw copyCancelled();
          return content.images[0]!;
        });
      for (const value of Object.values(data)) void value.catch(() => {});
      await Promise.all([clipboard.write([new ClipboardItem(data)]), ready]);
      return current();
    }

    // Explicit background permission supports sequential reverse writes for
    // clipboard history. Older/unbounded source views retain their old path.
    const content = await ready;
    if (!current()) return false;
    if (!content.images.length) {
      if (!clipboard.writeText)
        throw new Error("Text copying is unavailable in this browser");
      await clipboard.writeText(content.text);
    } else {
      if (!clipboard.write || typeof ClipboardItem === "undefined")
        throw new Error(
          "Image copying is unavailable in this browser. Download the image instead.",
        );
      for (let index = content.images.length - 1; index >= 0; index--) {
        if (!current()) return false;
        const data: Record<string, Blob> = {
          "image/png": content.images[index]!,
        };
        if (index === 0 && content.text)
          data["text/plain"] = new Blob([content.text], { type: "text/plain" });
        await clipboard.write([new ClipboardItem(data)]);
      }
    }
    return current();
  } catch (error) {
    if (cancelled || !current()) return false;
    throw sourceError ?? error;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (activeCopy === owner) activeCopy = null;
    owner.abort(copyCancelled());
  }
}
