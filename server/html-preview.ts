import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { Request, Response } from "express";
import {
  HTML_PREVIEW_BYTES,
  type HtmlPreviewResponse,
} from "../shared/html-preview.js";
import { escapesBase } from "./paths.js";
import { requestError } from "./request-error.js";
import { sendResourceFile } from "./resource-http.js";
import {
  mimeTypeFor,
  openCanonicalResourceFile,
  type ResourceContext,
  type ResourceStore,
} from "./resources.js";

interface HtmlPreviewGrant {
  resourceId: string;
  sessionId: string;
  root: string;
  entryPath: string;
  html: string;
}

/** These are document capabilities, never Host credentials. The opaque-origin
 * frame may load its project assets but cannot authenticate to Inspire's API. */
export class HtmlPreviewStore {
  private readonly grants = new Map<string, HtmlPreviewGrant>();

  constructor(
    private readonly resources: ResourceStore,
    private readonly context: (sessionId: string) => Promise<ResourceContext>,
  ) {}

  async create(
    resourceId: string,
    context: ResourceContext,
    html: string,
  ): Promise<HtmlPreviewResponse> {
    const resource = this.resources.get(
      resourceId,
      context.sessionId,
      context.viewId,
    );
    if (resource.descriptor.kind !== "html" || !resource.path)
      throw requestError("Only HTML files support interactive preview", 400);
    if (Buffer.byteLength(html) > HTML_PREVIEW_BYTES)
      throw requestError("The HTML is too large for interactive preview", 413);
    await this.resources.revalidate(resource, context);
    const opened = await this.resources.openForServing(resource);
    await opened.handle.close();
    const root = resource.workspaceRoot ?? dirname(resource.path);
    const entryPath = relative(root, resource.path);
    const id = randomUUID();
    this.grants.set(id, {
      resourceId,
      sessionId: context.sessionId,
      root,
      entryPath,
      // Run exactly the loaded version the user chose, not a later disk edit.
      html,
    });
    if (this.grants.size > 32)
      this.grants.delete(this.grants.keys().next().value!);
    return {
      id,
      url: `/html-preview/${id}/${entryPath.split(sep).map(encodeURIComponent).join("/")}`,
    };
  }

  remove(id: string, sessionId: string): void {
    const grant = this.grants.get(id);
    if (grant?.sessionId === sessionId) this.grants.delete(id);
  }

  close(): void {
    this.grants.clear();
  }

  async serve(request: Request, response: Response): Promise<void> {
    // No pairing cookie or bearer token is accepted here: knowing this
    // revocable capability is authority for this preview's assets only.
    const id = String(request.params.id);
    const grant = this.grants.get(id);
    if (!grant) throw requestError("The interactive preview has ended", 404);
    const context = await this.context(grant.sessionId);
    const resource = this.resources.get(
      grant.resourceId,
      grant.sessionId,
      context.viewId,
    );
    await this.resources.revalidate(resource, context);
    const opened = await this.resources.openForServing(resource);
    await opened.handle.close();
    if (this.grants.get(id) !== grant || response.destroyed)
      throw requestError("The interactive preview has ended", 404);
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
    if (escapesBase(relative(grant.root, selected)))
      throw requestError("The asset is outside this preview's files", 403);
    if (relative(grant.root, selected) === grant.entryPath) {
      response.type("html").send(grant.html);
      return;
    }
    const canonical = await realpath(selected).catch(() => {
      throw requestError("The preview asset was not found", 404);
    });
    if (escapesBase(relative(grant.root, canonical)))
      throw requestError("The asset is outside this preview's files", 403);
    const asset = await openCanonicalResourceFile(canonical);
    if (this.grants.get(id) !== grant || response.destroyed) {
      await asset.handle.close();
      return;
    }
    response.set("Content-Type", mimeTypeFor(canonical));
    await sendResourceFile(
      request,
      response,
      asset.handle,
      Number(asset.details.size),
    );
  }
}
