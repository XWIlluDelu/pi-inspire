export interface CopyContent {
  text: string;
  images?: Blob[];
}

export type CopySource = string | CopyContent;
export type CopyLoader = (signal: AbortSignal) => Promise<CopySource | null>;

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

/** Browsers generally support one clipboard item, not an image-file list.
 * Reverse writes order images for clipboard history where available; the final item
 * contains the first image and the original plain text as alternate formats. */
export async function writeCopyContent(
  source: CopySource,
  current: () => boolean = () => true,
): Promise<boolean> {
  const content = typeof source === "string" ? { text: source } : source;
  if (!content.images?.length) {
    if (!navigator.clipboard?.writeText)
      throw new Error("Clipboard access is unavailable in this browser");
    if (!current()) return false;
    await navigator.clipboard.writeText(content.text);
    return current();
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
    throw new Error(
      "Image copying is unavailable in this browser. Download the image instead.",
    );
  // Prepare all images before writing, so a failed read/conversion does not
  // replace the clipboard with only part of the requested content.
  const images = [];
  for (const image of content.images) {
    images.push(await clipboardPng(image));
    if (!current()) return false;
  }
  for (let index = images.length - 1; index >= 0; index--) {
    if (!current()) return false;
    const data: Record<string, Blob> = { "image/png": images[index]! };
    if (index === 0 && content.text)
      data["text/plain"] = new Blob([content.text], { type: "text/plain" });
    await navigator.clipboard.write([new ClipboardItem(data)]);
  }
  return current();
}
