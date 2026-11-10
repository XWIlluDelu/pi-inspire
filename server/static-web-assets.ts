import express, { type RequestHandler } from "express";
import { isCompressibleStaticAsset } from "./static-asset-cache.mjs";

/** Sidecars are generated at build time. The static server still owns
 * validators, lengths, and immutable caching for each representation. */
export function staticWebAssets(root: string): RequestHandler {
  const options = { immutable: true, maxAge: "1y", fallthrough: true };
  const identity = express.static(root, options);
  const encoded = express.static(root, {
    ...options,
    acceptRanges: false,
    setHeaders(response, file) {
      response.setHeader(
        "Content-Encoding",
        file.endsWith(".br") ? "br" : "gzip",
      );
      response.setHeader(
        "Content-Type",
        /\.css\.(?:br|gz)$/iu.test(file)
          ? "text/css; charset=utf-8"
          : "text/javascript; charset=utf-8",
      );
    },
  });

  return (request, response, next) => {
    const path = request.path;
    if (!isCompressibleStaticAsset(path)) {
      identity(request, response, next);
      return;
    }
    response.vary("Accept-Encoding");
    // Byte ranges and their If-Range validators refer to the original file.
    const encoding =
      request.get("Range") === undefined
        ? request.acceptsEncodings("br", "gzip", "identity")
        : false;
    if (encoding !== "br" && encoding !== "gzip") {
      identity(request, response, next);
      return;
    }

    const originalUrl = request.url;
    const suffix = encoding === "br" ? ".br" : ".gz";
    const queryStart = originalUrl.indexOf("?");
    request.url = `${path}${suffix}${queryStart < 0 ? "" : originalUrl.slice(queryStart)}`;
    encoded(request, response, (error?: unknown) => {
      request.url = originalUrl;
      if (error) next(error);
      else identity(request, response, next);
    });
  };
}
