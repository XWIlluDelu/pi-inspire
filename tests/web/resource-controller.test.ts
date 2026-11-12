import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceDescriptor } from "../../shared/contracts";
import { MAX_RESOURCE_PROBE_REFERENCES } from "../../shared/resource-references";
import { type Api, ApiError } from "../../src/api";
import { ResourceController } from "../../src/controllers/resource-controller";
import {
  inspectedPreview,
  MAX_MEDIA_PREVIEW_BYTES,
} from "../../src/resource-preview";
import { deferred } from "./helpers";

type Host = ConstructorParameters<typeof ResourceController>[0];

function fixture() {
  const descriptor: ResourceDescriptor = {
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
    resourceDownloadTicket: vi.fn(),
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
    descriptor,
    api,
    host,
    controller,
    rotate: () => {
      current = { ...api };
      controller.invalidateForTransportReplacement();
    },
  };
}

describe("ResourceController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retains verified batches and retries only unverified references", async () => {
    const f = fixture();
    const references = Array.from(
      { length: MAX_RESOURCE_PROBE_REFERENCES + 2 },
      (_, index) => `file-${index}.md`,
    );
    const [missing, outside] = references;
    const unavailable = references[MAX_RESOURCE_PROBE_REFERENCES]!;
    f.api.probeResources
      .mockImplementationOnce(async (_sessionId, batch: string[]) => ({
        sessionId: "s1",
        viewId: "v1",
        revision: 1,
        results: batch.map((reference) => ({
          reference,
          availability:
            reference === missing
              ? "missing"
              : reference === outside
                ? "unavailable"
                : "available",
        })),
      }))
      .mockRejectedValueOnce(new ApiError(503, "Second batch unavailable"))
      .mockImplementation(async (_sessionId, batch: string[]) => ({
        sessionId: "s1",
        viewId: "v1",
        revision: 1,
        results: batch.map((reference) => ({
          reference,
          availability: "available",
        })),
      }));

    await f.controller.probeResources(references);
    expect(f.state.resourceStanding[missing!]?.availability).toBe("missing");
    expect(f.state.resourceStanding[outside!]?.availability).toBe(
      "unavailable",
    );
    expect(f.state.resourceStanding[unavailable]?.availability).toBe("unknown");
    await vi.advanceTimersByTimeAsync(1_000);
    await f.controller.probeResources([...references, "newly-visible.md"]);
    expect(f.api.probeResources.mock.calls.map(([, batch]) => batch)).toEqual([
      references.slice(0, MAX_RESOURCE_PROBE_REFERENCES),
      references.slice(MAX_RESOURCE_PROBE_REFERENCES),
      references.slice(MAX_RESOURCE_PROBE_REFERENCES),
      ["newly-visible.md"],
    ]);
    expect(f.state.resourceStanding[missing!]?.availability).toBe("missing");
    expect(f.state.resourceStanding[unavailable]?.availability).toBe(
      "available",
    );
    expect(f.state.fileInspection).toEqual({ kind: "browse" });
    expect(f.api.resourceContent).not.toHaveBeenCalled();
  });

  it("does not let an older probe overwrite a successful resolve", async () => {
    const f = fixture();
    const late = deferred<unknown>();
    f.api.probeResources.mockReturnValueOnce(late.promise);
    const pending = f.controller.probeResources(["notes.txt", "other.txt"]);

    await f.controller.openResource("notes.txt");
    late.resolve({
      sessionId: "s1",
      viewId: "v1",
      revision: 1,
      results: [
        { reference: "notes.txt", availability: "missing" },
        { reference: "other.txt", availability: "available" },
      ],
    });
    await pending;
    expect(f.state.resourceStanding).toMatchObject({
      "notes.txt": { availability: "available" },
      "other.txt": { availability: "available" },
    });
  });

  it("keeps confirmed standing through a failed append probe and allows explicit reprobe", async () => {
    const f = fixture();
    f.api.probeResources.mockImplementation(
      async (_sessionId, references: string[]) => ({
        sessionId: "s1",
        viewId: "v1",
        revision: f.state.transcriptRevision,
        results: references.map((reference) => ({
          reference,
          availability: "available",
        })),
      }),
    );
    await f.controller.probeResources(["notes.txt"]);
    f.state.transcriptRevision += 1;
    f.api.probeResources.mockRejectedValueOnce(
      new ApiError(503, "Read unavailable"),
    );
    await f.controller.probeResources(["notes.txt", "new.txt"]);
    expect(f.state.resourceStanding["notes.txt"]?.availability).toBe(
      "available",
    );
    expect(f.state.resourceStanding["new.txt"]?.availability).toBe("unknown");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.state.resourceStanding["new.txt"]?.availability).toBe("available");
    await f.controller.probeResources(["notes.txt"]);
    expect(f.api.probeResources).toHaveBeenCalledTimes(3);
    f.controller.cancelProbes(true);
    expect(f.state.resourceStanding).toEqual({});
    await f.controller.probeResources(["notes.txt"]);
    expect(f.api.probeResources).toHaveBeenCalledTimes(4);
    expect(f.state.resourceStanding["notes.txt"]?.availability).toBe(
      "available",
    );
  });

  it.each(["revision", "transport"] as const)(
    "ignores an in-flight probe from the retired %s",
    async (change) => {
      const f = fixture();
      const late = deferred<unknown>();
      f.api.probeResources.mockReturnValueOnce(late.promise);
      const probe = f.controller.probeResources(["notes.txt"]);
      if (change === "revision") {
        f.state.transcriptRevision += 1;
        late.resolve({
          sessionId: "s1",
          viewId: "v1",
          revision: 1,
          results: [{ reference: "notes.txt", availability: "missing" }],
        });
      } else {
        f.rotate();
        late.reject(new ApiError(401, "Retired credentials"));
      }
      await probe;
      expect(f.state.resourceStanding).toEqual({});
      expect(f.host.handleAuthFailure).not.toHaveBeenCalled();
      f.api.probeResources.mockResolvedValue({
        sessionId: "s1",
        viewId: "v1",
        revision: f.state.transcriptRevision,
        results: [{ reference: "notes.txt", availability: "available" }],
      });
      await f.controller.probeResources(["notes.txt"]);
      expect(f.state.resourceStanding["notes.txt"]?.availability).toBe(
        "available",
      );
    },
  );

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

  it("retains loaded media on refresh failure and revokes it on replacement, close and transport change", async () => {
    const f = fixture();
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:old")
      .mockReturnValueOnce("blob:new")
      .mockReturnValueOnce("blob:reopened");
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const blob = new Blob(["first"], { type: "image/png" });
    f.api.resolveResource.mockResolvedValue({
      ...f.descriptor,
      reference: "plot.png",
      name: "plot.png",
      mimeType: blob.type,
      size: blob.size,
      kind: "image",
    });
    f.api.resourceContent.mockResolvedValue({ blob, totalSize: blob.size });
    await f.controller.openResource("plot.png");

    f.api.resourceContent.mockRejectedValue(
      new ApiError(503, "Content unavailable"),
    );
    const refresh = f.controller.openResource("plot.png");
    const preview = () => inspectedPreview(f.state.fileInspection);
    await vi.advanceTimersByTimeAsync(0);
    expect(preview()).toMatchObject({
      status: "ready",
      objectUrl: "blob:old",
      refreshing: true,
    });
    await vi.advanceTimersByTimeAsync(14_000);
    await refresh;
    expect(preview()).toMatchObject({
      status: "ready",
      objectUrl: "blob:old",
      refreshError: "Content unavailable",
    });
    expect(preview()).not.toHaveProperty("refreshing", true);
    expect(revoke).not.toHaveBeenCalled();

    const updated = new Blob(["updated"], { type: blob.type });
    f.api.resourceContent.mockResolvedValue({
      blob: updated,
      totalSize: updated.size,
    });
    await f.controller.openResource("plot.png");
    expect(preview()).toMatchObject({
      status: "ready",
      objectUrl: "blob:new",
      descriptor: { size: updated.size },
    });
    expect(preview()).not.toHaveProperty("refreshError");
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:old");
    f.controller.clearSelection();
    expect(revoke).toHaveBeenLastCalledWith("blob:new");

    await f.controller.openResource("plot.png");
    f.rotate();
    expect(revoke).toHaveBeenLastCalledWith("blob:reopened");
    expect(f.state.resourceTabs).toEqual([{ reference: "plot.png" }]);
    expect(f.state.resourceStanding).toEqual({});
    expect(preview()).toEqual({ status: "loading", reference: "plot.png" });
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
      if (change === "transport") f.rotate();
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

  it("retires positional embedded tabs without discarding named tabs", () => {
    const f = fixture();
    const reference = "pi-embedded://0/0";
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

  it.each([20, 4])(
    "uses the transfer total %i for text preview size and truncation",
    async (totalSize) => {
      const f = fixture();
      f.api.resourceContent.mockResolvedValue({
        blob: new Blob(["text"]),
        totalSize,
      });
      await f.controller.openResource("notes.txt");
      expect(inspectedPreview(f.state.fileInspection)).toMatchObject({
        status: "ready",
        truncated: totalSize > 4,
        descriptor: { size: totalSize },
      });
    },
  );

  it.each([
    ["html", "page.html", "text/html", "<h1>你好 🌍</h1>"],
    [
      "image",
      "chart.svg",
      "image/svg+xml",
      '<svg xmlns="http://www.w3.org/2000/svg"><text>你好 🌍</text></svg>',
    ],
  ] as const)(
    "decodes BOM source without losing %s preview behavior",
    async (kind, name, type, text) => {
      const f = fixture();
      const blob = new Blob([Buffer.from("\uFEFF" + text, "utf16le")], {
        type,
      });
      f.api.resolveResource.mockResolvedValue({
        ...f.descriptor,
        kind,
        reference: name,
        name,
        mimeType: type,
        size: blob.size,
      });
      f.api.resourceContent.mockResolvedValue({ blob, totalSize: blob.size });
      const createUrl = vi
        .spyOn(URL, "createObjectURL")
        .mockReturnValue("blob:preview");
      try {
        await f.controller.openResource(name);
        expect(inspectedPreview(f.state.fileInspection)).toMatchObject({
          status: "ready",
          text,
          truncated: false,
          objectUrl: "blob:preview",
        });
        const preview = createUrl.mock.calls[0]![0] as Blob;
        if (kind === "html") {
          expect(preview.type).toBe("text/html;charset=utf-8");
          expect(await preview.text()).toContain("你好 🌍");
          expect(await preview.text()).toContain("Content-Security-Policy");
        } else {
          expect(preview).toBe(blob);
        }
      } finally {
        f.controller.invalidate();
      }
    },
  );

  it("withholds oversized image bytes before requesting content", async () => {
    const f = fixture();
    f.api.resolveResource.mockResolvedValueOnce({
      ...f.descriptor,
      kind: "image",
      reference: "large.png",
      name: "large.png",
      mimeType: "image/png",
      size: MAX_MEDIA_PREVIEW_BYTES + 1,
    });
    await f.controller.openResource("large.png");
    expect(f.api.resourceContent).not.toHaveBeenCalled();
    expect(inspectedPreview(f.state.fileInspection)).toMatchObject({
      status: "ready",
      contentUnavailable: "too-large",
    });
  });

  it.each(["file selection", "session"] as const)(
    "cancels a content transfer when the %s changes",
    async (change) => {
      const f = fixture();
      const started = deferred<AbortSignal>();
      const late = deferred<unknown>();
      f.api.resourceContent.mockImplementationOnce((_id, _session, options) => {
        started.resolve(options.signal);
        return late.promise;
      });
      const read = f.controller.openResource("notes.txt");
      const signal = await started.promise;
      if (change === "file selection")
        await f.controller.openResource("other.txt");
      else {
        f.state.sessionId = "s2";
        f.controller.invalidate();
      }
      expect(signal.aborted).toBe(true);
      const current = f.state.fileInspection;
      late.resolve({ blob: new Blob(["old bytes"]), totalSize: 9 });
      await read;
      expect(f.state.fileInspection).toBe(current);
    },
  );

  it.each([
    ["pi-embedded://4/0", "pi-embedded://4/0"],
    ["chart.png", "./figures/chart.png"],
  ])(
    "reads %s without selecting Files",
    async (reference, resolvedReference) => {
      const f = fixture();
      const blob = new Blob(["png"], { type: "image/png" });
      const signal = new AbortController().signal;
      f.api.resolveResource.mockResolvedValue({
        ...f.descriptor,
        reference: resolvedReference,
        kind: "image",
        mimeType: blob.type,
        size: blob.size,
      });
      f.api.resourceContent.mockResolvedValue({ blob, totalSize: blob.size });
      const read = (owner: string) =>
        f.controller.loadTranscriptImage("s1", "v1", owner, reference, signal);

      await expect(read("v1\u0000p1")).resolves.toBe(blob);
      expect(f.api.resourceContent).toHaveBeenCalledWith("notes", "s1", {
        byteLimit: MAX_MEDIA_PREVIEW_BYTES + 1,
        signal,
      });
      await expect(read("v1\u0000obsolete")).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(f.api.resolveResource).toHaveBeenCalledOnce();
      expect(f.state.fileInspection).toEqual({ kind: "browse" });
    },
  );

  it.each(["projection", "transport"] as const)(
    "retires an in-flight transcript image after %s replacement",
    async (change) => {
      const f = fixture();
      const reference = "pi-embedded://4/0";
      const started = deferred<void>();
      const late = deferred<unknown>();
      f.api.resolveResource.mockResolvedValue({
        ...f.descriptor,
        kind: "image",
        reference,
      });
      f.api.resourceContent.mockImplementation(() => {
        started.resolve();
        return late.promise;
      });
      const read = f.controller.loadTranscriptImage(
        "s1",
        "v1",
        "v1\u0000p1",
        reference,
        new AbortController().signal,
      );
      await started.promise;
      if (change === "projection") {
        f.state.transcriptIncarnation = "p2";
        late.resolve({ blob: new Blob(["old"]), totalSize: 3 });
      } else {
        f.rotate();
        late.reject(new ApiError(401, "Retired credentials"));
      }
      await expect(read).rejects.toMatchObject({ name: "AbortError" });
      expect(f.host.handleAuthFailure).not.toHaveBeenCalled();
    },
  );

  it("distinguishes a missing file from a failed transfer and recovers its standing", async () => {
    const f = fixture();
    f.api.resolveResource.mockRejectedValueOnce(new ApiError(404, "Missing"));
    await f.controller.openResource("notes.txt");
    expect(f.state.resourceStanding["notes.txt"]?.availability).toBe("missing");
    expect(inspectedPreview(f.state.fileInspection)).toMatchObject({
      status: "error",
      message: "Missing",
    });

    f.api.resourceContent.mockRejectedValueOnce(
      new ApiError(404, "Bytes unavailable"),
    );
    await f.controller.openResource("notes.txt");
    expect(inspectedPreview(f.state.fileInspection)).toMatchObject({
      status: "error",
      message: "Bytes unavailable",
    });
    expect(f.state.resourceStanding["notes.txt"]?.availability).toBe(
      "available",
    );
  });

  it("offers the Host's candidates without loading any guessed path", async () => {
    const f = fixture();
    const matches = ["a/notes.txt", "b/notes.txt"];
    f.api.resolveResource.mockRejectedValueOnce(
      new ApiError(409, "Ambiguous", matches),
    );
    await f.controller.openResource("notes.txt");
    expect(inspectedPreview(f.state.fileInspection)).toMatchObject({
      status: "ambiguous",
      matches,
    });
    expect(f.state.resourceStanding["notes.txt"]).toMatchObject({
      availability: "ambiguous",
      matches,
    });
    expect(f.api.resourceContent).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
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

  describe("native resource downloads", () => {
    async function downloadFixture() {
      const f = fixture();
      f.api.resolveResource.mockResolvedValue({
        ...f.descriptor,
        reference: "large.bin",
        name: "large.bin",
        size: MAX_MEDIA_PREVIEW_BYTES + 1,
        kind: "binary",
        mimeType: "application/octet-stream",
      });
      await f.controller.openResource("large.bin");
      const pending = deferred<{ ticket: string; expiresAt: number }>();
      f.api.resourceDownloadTicket.mockReturnValue(pending.promise);
      return {
        ...f,
        pending,
        replaceApi: () =>
          vi
            .spyOn(f.host, "api")
            .mockReturnValue({ ...f.api } as unknown as Api),
      };
    }

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
        const f = await downloadFixture();
        const request = f.controller.downloadResource();
        const outcome = expect(request).rejects.toMatchObject({
          name: "AbortError",
        });
        if (change === "session") f.state.sessionId = "s2";
        if (change === "view") f.state.transcriptViewId = "v2";
        if (change === "selection") f.state.fileInspection = { kind: "browse" };
        if (change === "transport") f.replaceApi();
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
      const f = await downloadFixture();
      const request = f.controller.downloadResource();
      const outcome = expect(request).rejects.toMatchObject({
        name: "AbortError",
      });
      f.replaceApi();
      f.pending.reject(new ApiError(401, "Old access"));
      await outcome;
      expect(f.host.handleAuthFailure).not.toHaveBeenCalled();
      expect(f.host.saveDownload).not.toHaveBeenCalled();
    });
  });
});
