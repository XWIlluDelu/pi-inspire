import { describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/api";
import { ApiError } from "../../src/api";
import { ResourceController } from "../../src/controllers/resource-controller";
import { MAX_MEDIA_PREVIEW_BYTES } from "../../src/resource-preview";
import { deferred } from "./helpers";

type Host = ConstructorParameters<typeof ResourceController>[0];
function fixture() {
  const descriptor = {
    id: "document",
    sessionId: "s1",
    viewId: "v1",
    reference: "reports/README.md",
    name: "README.md",
    size: 0,
    kind: "markdown" as const,
    mimeType: "text/markdown",
  };
  const state: ReturnType<Host["state"]> = {
    sessionId: "s1",
    transcriptViewId: "v1",
    transcriptIncarnation: "p1",
    transcriptRevision: 1,
    resourcesOpen: true,
    contextMode: "files",
    fileBrowserView: "preview",
    selectedResourceReference: descriptor.reference,
    selectedResourceWorkspacePath: descriptor.reference,
    resourcePreview: {
      status: "ready",
      reference: descriptor.reference,
      descriptor,
      text: "![Curve](curve.png)",
    },
    resourceAvailability: {},
    resourceWorkspacePaths: {},
  };
  const image = {
    ...descriptor,
    id: "image",
    reference: "./reports/curve.png",
    name: "curve.png",
    kind: "image" as const,
    mimeType: "image/png",
    size: 3,
  };
  const content = {
    blob: new Blob(["png"], { type: "image/png" }),
    totalSize: 3,
  };
  const api = {
    resolveResource: vi.fn(async () => image),
    resourceContent: vi.fn(async () => content),
  };
  let generation = 1;
  const host: Host = {
    state: () => state,
    api: () => api as unknown as Api,
    transportGeneration: () => generation,
    patch: vi.fn(),
    handleAuthFailure: vi.fn(),
    prepareGitForResourceOpen: vi.fn(),
    selectWorkspacePath: vi.fn(),
  };
  const controller = new ResourceController(host);
  const load = (signal = new AbortController().signal) =>
    controller.loadDocumentImage("document", image.reference, signal);
  return {
    state,
    image,
    content,
    api,
    host,
    controller,
    load,
    replaceTransport: () => generation++,
  };
}

describe("document image resource controller", () => {
  it("uses the authenticated resolve/content path without replacing selection or advancing availability", async () => {
    const f = fixture();
    expect(await f.load()).toBe(f.content.blob);
    expect(f.api.resolveResource).toHaveBeenCalledWith(
      "s1",
      "./reports/curve.png",
      expect.any(AbortSignal),
    );
    expect(f.api.resourceContent).toHaveBeenCalledWith("image", "s1", {
      byteLimit: MAX_MEDIA_PREVIEW_BYTES + 1,
      signal: expect.any(AbortSignal),
    });
    expect(f.host.patch).not.toHaveBeenCalled();
    expect(f.host.prepareGitForResourceOpen).not.toHaveBeenCalled();
  });

  it.each(["selection", "session", "view", "pane", "transport"])(
    "rejects a resolve result after %s changes",
    async (change) => {
      const f = fixture();
      const gate = deferred<typeof f.image>();
      f.api.resolveResource.mockReturnValue(gate.promise);
      const outcome = expect(f.load()).rejects.toMatchObject({
        name: "AbortError",
      });
      if (change === "selection") f.state.resourcePreview = null;
      if (change === "session") f.state.sessionId = "s2";
      if (change === "view") f.state.transcriptViewId = "v2";
      if (change === "pane") f.state.resourcesOpen = false;
      if (change === "transport") f.replaceTransport();
      gate.resolve(f.image);
      await outcome;
      expect(f.api.resourceContent).not.toHaveBeenCalled();
    },
  );

  it("keeps compatible same-view appends current but fences a late content transfer", async () => {
    const f = fixture();
    const gate = deferred<typeof f.content>();
    f.api.resourceContent.mockImplementation(() => {
      f.state.transcriptRevision++;
      return gate.promise;
    });
    const promise = f.load();
    await vi.waitFor(() => expect(f.api.resourceContent).toHaveBeenCalled());
    const outcome = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });
    f.replaceTransport();
    gate.resolve(f.content);
    await outcome;
  });

  it.each(["external", "controller"])(
    "aborts in-flight requests on %s cancellation even if fetch returns success",
    async (mode) => {
      const f = fixture();
      const request = new AbortController();
      const gate = deferred<typeof f.image>();
      f.api.resolveResource.mockReturnValue(gate.promise);
      const outcome = expect(f.load(request.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      if (mode === "external") request.abort();
      else f.controller.cancelRequest();
      expect(
        (
          f.api.resolveResource.mock.calls[0] as unknown as [
            string,
            string,
            AbortSignal,
          ]
        )[2].aborted,
      ).toBe(true);
      gate.resolve(f.image);
      await outcome;
      expect(f.api.resourceContent).not.toHaveBeenCalled();
    },
  );

  it.each(["view", "session", "mime", "size"])(
    "refuses invalid image descriptors: %s",
    async (bad) => {
      const f = fixture();
      if (bad === "view") f.image.viewId = "v2";
      if (bad === "session") f.image.sessionId = "s2";
      if (bad === "mime") f.image.mimeType = "text/html";
      if (bad === "size") f.image.size = MAX_MEDIA_PREVIEW_BYTES + 1;
      await expect(f.load()).rejects.toThrow();
      expect(f.api.resourceContent).not.toHaveBeenCalled();
    },
  );

  it.each(["growth", "truncated", "mime"])(
    "refuses invalid transferred content: %s",
    async (bad) => {
      const f = fixture();
      if (bad === "growth") f.content.totalSize = MAX_MEDIA_PREVIEW_BYTES + 1;
      if (bad === "truncated") f.content.totalSize = 8;
      if (bad === "mime")
        f.content.blob = new Blob(["png"], { type: "text/html" });
      await expect(f.load()).rejects.toThrow();
    },
  );

  it("reports auth failure only while its document and transport are current", async () => {
    const f = fixture();
    f.api.resolveResource.mockRejectedValue(new ApiError(401, "Pair again"));
    await expect(f.load()).rejects.toThrow("Pair again");
    expect(f.host.handleAuthFailure).toHaveBeenCalledTimes(1);
    f.state.resourcePreview = null;
    await expect(f.load()).rejects.toMatchObject({ name: "AbortError" });
    expect(f.api.resolveResource).toHaveBeenCalledTimes(1);
    expect(f.host.handleAuthFailure).toHaveBeenCalledTimes(1);
  });
});
