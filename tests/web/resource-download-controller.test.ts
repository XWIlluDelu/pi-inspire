import { describe, expect, it, vi } from "vitest";
import type { Api } from "../../src/api";
import { ApiError } from "../../src/api";
import { ResourceController } from "../../src/controllers/resource-controller";
import { deferred } from "./helpers";

type Host = ConstructorParameters<typeof ResourceController>[0];
function fixture() {
  const descriptor = {
    id: "file",
    sessionId: "s1",
    viewId: "v1",
    reference: "large.bin",
    name: "large.bin",
    size: 100_000_000,
    kind: "binary" as const,
    mimeType: "application/octet-stream",
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
    },
    resourceTabs: [],
    resourceAvailability: {},
    resourceWorkspacePaths: {},
  };
  const pending = deferred<{ ticket: string; expiresAt: number }>();
  const api = { resourceDownloadTicket: vi.fn(() => pending.promise) };
  let generation = 1;
  const host: Host = {
    state: () => state,
    api: () => api as unknown as Api,
    transportGeneration: () => generation,
    patch: vi.fn(),
    handleAuthFailure: vi.fn(),
    prepareGitForResourceOpen: vi.fn(),
    selectWorkspacePath: vi.fn(),
    saveDownload: vi.fn(),
  };
  const controller = new ResourceController(host);
  return {
    state,
    api,
    host,
    controller,
    pending,
    rotate: () => {
      generation++;
    },
  };
}

describe("native resource download authority", () => {
  it("mints only a narrow transfer without loading bytes or imposing the preview cap", async () => {
    const f = fixture();
    const request = f.controller.downloadResource();
    expect(f.api.resourceDownloadTicket).toHaveBeenCalledWith(
      "file",
      "s1",
      expect.any(AbortSignal),
    );
    f.pending.resolve({
      ticket: "a".repeat(43),
      expiresAt: Date.now() + 15_000,
    });
    await request;
    expect(f.host.saveDownload).toHaveBeenCalledExactlyOnceWith(
      `/api/resource-downloads/${"a".repeat(43)}`,
      "large.bin",
    );
  });

  it.each([
    "session",
    "view",
    "selection",
    "transport",
    "closed",
    "cancelled",
  ] as const)(
    "retires pending download issuance after %s changes",
    async (change) => {
      const f = fixture();
      const request = f.controller.downloadResource();
      const outcome = expect(request).rejects.toMatchObject({
        name: "AbortError",
      });
      if (change === "session") f.state.sessionId = "s2";
      if (change === "view") f.state.transcriptViewId = "v2";
      if (change === "selection") f.state.resourcePreview = null;
      if (change === "transport") f.rotate();
      if (change === "closed") f.state.resourcesOpen = false;
      if (change === "cancelled") f.controller.cancelRequest();
      f.pending.resolve({
        ticket: "a".repeat(43),
        expiresAt: Date.now() + 15_000,
      });
      await outcome;
      expect(f.host.saveDownload).not.toHaveBeenCalled();
    },
  );

  it("does not let an old 401 invalidate a fresh transport", async () => {
    const f = fixture();
    const request = f.controller.downloadResource();
    const outcome = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    f.rotate();
    f.pending.reject(new ApiError(401, "Old access"));
    await outcome;
    expect(f.host.handleAuthFailure).not.toHaveBeenCalled();
    expect(f.host.saveDownload).not.toHaveBeenCalled();
  });
});
