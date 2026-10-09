import type { FileHandle } from "node:fs/promises";
import type { Request, Response } from "express";
import { requestError } from "./request-error.js";

/** One range, including suffix/open-ended ranges; never silently send a whole
 * large file for an invalid range. Empty files ignore Range. */
export function resourceByteRange(
  request: Request,
  size: number,
): { start: number; end: number } | null {
  if (!request.get("range") || size === 0) return null;
  const ranges = request.range(size);
  if (!Array.isArray(ranges) || ranges.type !== "bytes" || ranges.length !== 1)
    throw requestError("The requested byte range cannot be served", 416, {
      contentRange: `bytes */${size}`,
    });
  return ranges[0]!;
}

/** Own the opened descriptor through range validation, disconnect and streaming. */
export async function sendResourceFile(
  request: Request,
  response: Response,
  handle: FileHandle,
  size: number,
): Promise<void> {
  if (response.destroyed) {
    await handle.close();
    return;
  }
  let range: { start: number; end: number } | null;
  try {
    range = resourceByteRange(request, size);
  } catch (error) {
    await handle.close();
    throw error;
  }
  response.set("Accept-Ranges", "bytes");
  if (range)
    response.status(206).set({
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      "Content-Length": String(range.end - range.start + 1),
    });
  else response.set("Content-Length", String(size));
  if (size === 0) {
    await handle.close();
    response.end();
    return;
  }
  const stream = handle.createReadStream(
    range
      ? { start: range.start, end: range.end }
      : { start: 0, end: size - 1 },
  );
  response.once("close", () => stream.destroy());
  stream.on("error", () => {
    if (!response.headersSent) response.status(500);
    response.end();
  });
  stream.pipe(response);
}
