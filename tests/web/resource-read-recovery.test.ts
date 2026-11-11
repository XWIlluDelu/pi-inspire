import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Api, ApiError } from "../../src/api";
import { ResourceController } from "../../src/controllers/resource-controller";
import { inspectedPreview } from "../../src/resource-preview";

type Host = ConstructorParameters<typeof ResourceController>[0];

function fixture() {
  const descriptor = {
    id: "notes",
    sessionId: "s1",
    viewId: "v1",
    reference: "notes.txt",
    name: "notes.txt",
    size: 5,
    kind: "text" as const,
    mimeType: "text/plain",
  };
  const state: ReturnType<Host["state"]> = {
    sessionId: "s1",
    transcriptViewId: "v1",
    transcriptIncarnation: "p1",
    transcriptRevision: 1,
    resourcesOpen: true,
    contextMode: "files",
    fileInspection: { kind: "browse" },
    resourceTabs: [],
    resourceStanding: {},
  };
  const api = {
    probeResources: vi.fn(),
    resolveResource: vi.fn().mockResolvedValue(descriptor),
    resourceContent: vi.fn().mockResolvedValue({
      blob: new Blob(["Notes"], { type: "text/plain" }),
      totalSize: 5,
    }),
  };
  let current = api;
  const host: Host = {
    state: () => state,
    api: () => current as unknown as Api,
    patch: (patch) => Object.assign(state, patch),
    handleAuthFailure: vi.fn(),
    revealWorkspacePath: vi.fn(),
    saveDownload: vi.fn(),
  };
  const controller = new ResourceController(host);
  return {
    state,
    api,
    host,
    controller,
    rotate: () => {
      current = { ...api };
      controller.invalidateForTransportReplacement();
    },
  };
}

describe("resource preview read recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not retry probes belonging to an earlier transcript revision", async () => {
    const f = fixture();
    f.api.probeResources.mockRejectedValueOnce(
      new ApiError(503, "Temporary probe failure"),
    );
    await f.controller.probeResources(["notes.txt"]);
    f.state.transcriptRevision += 1;
    await vi.advanceTimersByTimeAsync(14_000);
    expect(f.api.probeResources).toHaveBeenCalledOnce();
  });

  it.each(["resolveResource", "resourceContent"] as const)(
    "recovers a temporary %s failure in the original read",
    async (endpoint) => {
      const f = fixture();
      f.api[endpoint].mockRejectedValueOnce(
        new ApiError(503, "Temporary failure"),
      );
      const reading = f.controller.openResource("notes.txt");
      await vi.advanceTimersByTimeAsync(0);
      expect(inspectedPreview(f.state.fileInspection)?.status).toBe("loading");
      expect(f.state.resourceStanding["notes.txt"]?.availability).toBe(
        endpoint === "resourceContent" ? "available" : undefined,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await reading;
      expect(f.api[endpoint]).toHaveBeenCalledTimes(2);
      expect(inspectedPreview(f.state.fileInspection)).toMatchObject({
        status: "ready",
        text: "Notes",
      });
    },
  );

  it("keeps a confirmed preview through failed refresh and clears its stale feedback after recovery", async () => {
    const f = fixture();
    await f.controller.openResource("notes.txt");
    f.api.resourceContent.mockRejectedValue(
      new ApiError(503, "Content unavailable"),
    );
    const reading = f.controller.openResource("notes.txt");
    await vi.advanceTimersByTimeAsync(0);
    expect(inspectedPreview(f.state.fileInspection)).toMatchObject({
      status: "ready",
      text: "Notes",
      refreshing: true,
    });
    await vi.advanceTimersByTimeAsync(14_000);
    await reading;
    expect(inspectedPreview(f.state.fileInspection)).toMatchObject({
      status: "ready",
      text: "Notes",
      refreshError: "Content unavailable",
    });
    expect(inspectedPreview(f.state.fileInspection)).not.toHaveProperty(
      "refreshing",
      true,
    );
    f.api.resourceContent.mockResolvedValue({
      blob: new Blob(["Updated"]),
      totalSize: 7,
    });
    await f.controller.openResource("notes.txt");
    expect(inspectedPreview(f.state.fileInspection)).toMatchObject({
      status: "ready",
      text: "Updated",
    });
    expect(inspectedPreview(f.state.fileInspection)).not.toHaveProperty(
      "refreshError",
    );
  });

  it("retains a loaded media URL until its replacement is ready", async () => {
    const f = fixture();
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:old")
      .mockReturnValueOnce("blob:new");
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    f.api.resolveResource.mockResolvedValue({
      id: "image",
      sessionId: "s1",
      viewId: "v1",
      reference: "plot.png",
      name: "plot.png",
      mimeType: "image/png",
      size: 5,
      kind: "image",
    });
    await f.controller.openResource("plot.png");
    f.api.resourceContent.mockRejectedValueOnce(
      new ApiError(503, "Temporary failure"),
    );
    const refresh = f.controller.openResource("plot.png");
    await vi.advanceTimersByTimeAsync(0);
    expect(inspectedPreview(f.state.fileInspection)).toMatchObject({
      status: "ready",
      objectUrl: "blob:old",
    });
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await refresh;
    expect(inspectedPreview(f.state.fileInspection)).toMatchObject({
      status: "ready",
      objectUrl: "blob:new",
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:old");
    f.controller.clearSelection();
    expect(revoke).toHaveBeenLastCalledWith("blob:new");
  });

  it.each(["selection", "view", "transport", "closed"] as const)(
    "retires a waiting retry when its %s changes",
    async (change) => {
      const f = fixture();
      f.api.resolveResource.mockRejectedValueOnce(
        new ApiError(503, "Temporary failure"),
      );
      const reading = f.controller.openResource("notes.txt");
      await vi.advanceTimersByTimeAsync(0);
      if (change === "selection") f.controller.clearSelection();
      if (change === "view") {
        f.state.transcriptViewId = "new-view";
        f.controller.invalidate();
      }
      if (change === "transport") {
        f.rotate();
        expect(f.state.resourceTabs).toEqual([{ reference: "notes.txt" }]);
        expect(inspectedPreview(f.state.fileInspection)).toEqual({
          status: "loading",
          reference: "notes.txt",
        });
      }
      if (change === "closed") {
        f.state.resourcesOpen = false;
        f.controller.cancelRequest();
      }
      await reading;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(f.api.resolveResource).toHaveBeenCalledOnce();
      expect(f.api.resourceContent).not.toHaveBeenCalled();
    },
  );

  it("revokes media authority but retains its named tab across transport replacement", async () => {
    const f = fixture();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:retired");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    f.api.resolveResource.mockResolvedValue({
      id: "image",
      sessionId: "s1",
      viewId: "v1",
      reference: "plot.png",
      name: "plot.png",
      mimeType: "image/png",
      size: 5,
      kind: "image",
    });
    await f.controller.openResource("plot.png");
    f.rotate();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:retired");
    expect(f.state).toMatchObject({
      resourceTabs: [{ reference: "plot.png" }],
      fileInspection: {
        kind: "file",
        reference: "plot.png",
        preview: { status: "loading", reference: "plot.png" },
      },
      resourceStanding: {},
    });
    expect(inspectedPreview(f.state.fileInspection)).not.toHaveProperty(
      "descriptor",
    );
    expect(inspectedPreview(f.state.fileInspection)).not.toHaveProperty(
      "objectUrl",
    );
  });

  it("retires positional embedded tabs without discarding named tabs", () => {
    const f = fixture();
    const reference = "pi-embedded://message/0/image/0";
    f.state.resourceTabs = [{ reference: "notes.txt" }, { reference }];
    f.state.fileInspection = {
      kind: "file",
      reference,
      preview: { status: "loading", reference },
    };
    f.rotate();
    expect(f.state).toMatchObject({
      resourceTabs: [{ reference: "notes.txt" }],
      fileInspection: { kind: "browse" },
    });
  });

  it.each([401, 403, 404])(
    "does not retry a definitive %s result or retain revoked content",
    async (status) => {
      const f = fixture();
      await f.controller.openResource("notes.txt");
      f.api.resolveResource.mockRejectedValue(
        new ApiError(status, "Read refused"),
      );
      await f.controller.openResource("notes.txt");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(f.api.resolveResource).toHaveBeenCalledTimes(2);
      expect(f.api.resourceContent).toHaveBeenCalledOnce();
      if (status === 401)
        expect(f.host.handleAuthFailure).toHaveBeenCalledOnce();
      else
        expect(inspectedPreview(f.state.fileInspection)).toMatchObject({
          status: "error",
        });
    },
  );
});
