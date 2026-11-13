import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Request, Response } from "express";
import { filesystemRelativePath } from "./filesystem-containment.js";
import { requestError } from "./request-error.js";
import { sendResourceFile } from "./resource-http.js";
import {
  mimeTypeFor,
  openAuthorizedResourceFile,
  type ResourceContext,
  type ResourceStore,
} from "./resources.js";

/** Opaque-origin document capability. It confers authority only for the
 * chosen HTML and its local assets. */
export async function serveHtmlPreview(
  resources: ResourceStore,
  getContext: (sessionId: string) => Promise<ResourceContext>,
  request: Request,
  response: Response,
): Promise<void> {
  const id = String(request.params.id);
  const grant = resources.getHtmlPreview(id);
  const context = await getContext(grant.resource.descriptor.sessionId);
  resources.get(
    grant.resource.descriptor.id,
    context.sessionId,
    context.viewId,
  );
  await resources.revalidate(grant.resource, context);
  const root = await realpath(grant.root).catch(() => null);
  if (root !== grant.root)
    throw requestError("The preview folder changed on disk", 409);
  resources.getHtmlPreview(id);
  if (response.destroyed) return;
  response.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "SAMEORIGIN",
    // Modules, fonts and fetch run from an opaque origin. CORS applies only
    // to this capability route, without cookies/credentials.
    "Access-Control-Allow-Origin": "*",
    "Content-Security-Policy": [
      "sandbox allow-scripts",
      "default-src http: https: data: blob:",
      "script-src http: https: data: blob: 'unsafe-inline' 'unsafe-eval'",
      "style-src http: https: data: blob: 'unsafe-inline'",
      "connect-src http: https: ws: wss:",
      "object-src 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join("; "),
  });
  const segments = request.params.path;
  const assetPath = Array.isArray(segments)
    ? segments.join(sep)
    : String(segments);
  if (assetPath.includes("\0"))
    throw requestError("The preview asset path is not valid", 400);
  const selected = resolve(grant.root, assetPath);
  const within = await filesystemRelativePath(grant.root, selected);
  if (within === null)
    throw requestError("The asset is outside this preview's files", 403);
  resources.getHtmlPreview(id);
  if (response.destroyed) return;
  if (within === grant.entryPath) {
    response.type("html").send(grant.html);
    return;
  }
  const canonical = await realpath(selected).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR")
        throw requestError("The preview asset was not found", 404);
      throw error;
    },
  );
  if ((await filesystemRelativePath(grant.root, canonical)) === null)
    throw requestError("The asset is outside this preview's files", 403);
  const asset = await openAuthorizedResourceFile(selected, canonical);
  try {
    resources.getHtmlPreview(id);
  } catch (error) {
    await asset.handle.close();
    throw error;
  }
  await sendResourceFile(request, response, asset, () => {
    response.set("Content-Type", mimeTypeFor(canonical));
  });
}
