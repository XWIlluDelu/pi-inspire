import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { requestError } from "./request-error.js";

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

function versionFromStats(details: BigIntStats): string {
  return (
    '"' +
    createHash("sha256")
      .update(
        [
          details.dev,
          details.ino,
          details.size,
          details.mtimeNs,
          details.ctimeNs,
        ].join(":"),
      )
      .digest("base64url") +
    '"'
  );
}

function versionConflict() {
  return requestError(
    "The referenced file changed on disk; open it again",
    409,
  );
}

export function checkResourceVersion(request: Request, version: string): void {
  const ifMatch = request.get("if-match");
  const ifRange = request.get("range") && request.get("if-range");
  if (
    (ifMatch &&
      ifMatch !== "*" &&
      !ifMatch.split(",").some((tag) => tag.trim() === version)) ||
    (ifRange && ifRange !== version)
  )
    throw versionConflict();
}

/** The transfer owns its descriptor. Withhold the last chunk until the
 * descriptor is checked again so a changed file cannot complete the response. */
export async function sendResourceFile(
  request: Request,
  response: Response,
  { handle, details }: { handle: FileHandle; details: BigIntStats },
  headers: () => void = () => undefined,
): Promise<void> {
  try {
    if (response.destroyed) return;
    if (details.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw requestError("The referenced file is too large to preview", 413);
    const size = Number(details.size);
    const version = versionFromStats(details);
    checkResourceVersion(request, version);
    const range = resourceByteRange(request, size);
    const checkVersion = async () => {
      const current = await handle.stat({ bigint: true });
      if (
        current.size !== details.size ||
        current.mtimeNs !== details.mtimeNs ||
        (current.nlink !== 0n && current.ctimeNs !== details.ctimeNs)
      )
        throw versionConflict();
    };
    await checkVersion();
    if (response.destroyed) return;
    headers();
    response.set({
      "Accept-Ranges": "bytes",
      ETag: version,
      "Content-Length": String(range ? range.end - range.start + 1 : size),
    });
    if (range)
      response
        .status(206)
        .set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    if (size === 0 || request.method === "HEAD") {
      response.end();
      return;
    }
    const stream = handle.createReadStream({
      start: range?.start ?? 0,
      end: range?.end ?? size - 1,
      autoClose: false,
    });
    try {
      await pipeline(
        stream,
        async function* (source) {
          let tail: Uint8Array | undefined;
          for await (const chunk of source) {
            await checkVersion();
            if (tail) yield tail;
            tail = chunk;
          }
          await checkVersion();
          if (tail) yield tail;
        },
        response,
      );
    } catch (error) {
      if (!response.destroyed) throw error;
    }
  } finally {
    await handle.close();
  }
}
