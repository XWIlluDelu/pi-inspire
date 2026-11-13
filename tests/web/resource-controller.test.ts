import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceProbeResponse } from "../../shared/contracts";
import { MAX_RESOURCE_PROBE_REFERENCES } from "../../shared/resource-references";
import { type Api, ApiError } from "../../src/api";
import { ResourceController } from "../../src/controllers/resource-controller";
import {
  inspectedPreview,
  MAX_MEDIA_PREVIEW_BYTES,
} from "../../src/resource-preview";
import { fakeResourceDescriptor } from "./fixtures/resources";
import { deferred } from "./helpers";

type Host = ConstructorParameters<typeof ResourceController>[0];

function fixture() {
  const descriptor = fakeResourceDescriptor("notes.txt", {
    id: "notes",
    viewId: "v1",
  });
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
  const probeResponse = (
    results: ResourceProbeResponse["results"],
    revision = state.transcriptRevision,
  ): ResourceProbeResponse => ({
    sessionId: "s1",
    viewId: "v1",
    revision,
    results,
  });
  const api = {
    probeResources: vi.fn(async (_sessionId: string, references: string[]) =>
      probeResponse(
        references.map((reference) => ({
          reference,
          availability: "available",
        })),
      ),
    ),
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
    patch: vi.fn((patch: Parameters<Host["patch"]>[0]) =>
      Object.assign(state, patch),
    ),
    handleAuthFailure: vi.fn(),
    revealWorkspacePath: vi.fn(),
    saveDownload: vi.fn(),
  };
  const controller = new ResourceController(host);
  const replaceApi = () => {
    current = { ...api };
  };
  return {
    state,
    descriptor,
    api,
    host,
    controller,
    probeResponse,
    replaceApi,
    rotate: () => {
      replaceApi();
      controller.invalidateForTransportReplacement();
    },
  };
}

function selectDocument(f: ReturnType<typeof fixture>) {
  const descriptor = fakeResourceDescriptor("reports/README.md", {
    id: "document",
    viewId: "v1",
    kind: "markdown",
    mimeType: "text/markdown",
  });
  f.state.fileInspection = {
    kind: "file",
    reference: descriptor.reference,
    preview: { status: "ready", reference: descriptor.reference, descriptor },
  };
  const image = fakeResourceDescriptor("./reports/curve.png", {
    id: "image",
    viewId: "v1",
    kind: "image",
    mimeType: "image/png",
    size: 3,
  });
  const content = {
    blob: new Blob(["png"], { type: "image/png" }),
    totalSize: 3,
  };
  f.api.resolveResource.mockResolvedValue(image);
  f.api.resourceContent.mockResolvedValue(content);
  return {
    image,
    content,
    read: (signal = new AbortController().signal) =>
      f.controller.loadDocumentImage(descriptor.id, image.reference, signal),
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
      .mockImplementationOnce(async (_sessionId, batch) =>
        f.probeResponse(
          batch.map((reference) => ({
            reference,
            availability:
              reference === missing
                ? "missing"
                : reference === outside
                  ? "unavailable"
                  : "available",
          })),
        ),
      )
      .mockRejectedValueOnce(new ApiError(503, "Second batch unavailable"));

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
    const late = deferred<ResourceProbeResponse>();
    f.api.probeResources.mockReturnValueOnce(late.promise);
    const pending = f.controller.probeResources(["notes.txt", "other.txt"]);

    await f.controller.openResource("notes.txt");
    late.resolve(
      f.probeResponse([
        { reference: "notes.txt", availability: "missing" },
        { reference: "other.txt", availability: "available" },
      ]),
    );
    await pending;
    expect(f.state.resourceStanding).toMatchObject({
      "notes.txt": { availability: "available" },
      "other.txt": { availability: "available" },
    });
  });

  it("keeps confirmed standing through a failed append probe and allows explicit reprobe", async () => {
    const f = fixture();
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
      const late = deferred<ResourceProbeResponse>();
      f.api.probeResources.mockReturnValueOnce(late.promise);
      const probe = f.controller.probeResources(["notes.txt"]);
      if (change === "revision") {
        f.state.transcriptRevision += 1;
        late.resolve(
          f.probeResponse(
            [{ reference: "notes.txt", availability: "missing" }],
            1,
          ),
        );
      } else {
        f.rotate();
        late.reject(new ApiError(401, "Retired credentials"));
      }
      await probe;
      expect(f.state.resourceStanding).toEqual({});
      expect(f.host.handleAuthFailure).not.toHaveBeenCalled();
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

  it("reads a document image through authenticated resolve and bounded content without modifying the selection", async () => {
    const f = fixture();
    const { read, image, content } = selectDocument(f);
    await expect(read()).resolves.toBe(content.blob);
    expect(f.api.resolveResource).toHaveBeenCalledWith(
      "s1",
      image.reference,
      expect.any(AbortSignal),
    );
    expect(f.api.resourceContent).toHaveBeenCalledWith(image.id, "s1", {
      byteLimit: MAX_MEDIA_PREVIEW_BYTES + 1,
      signal: expect.any(AbortSignal),
    });
    expect(f.host.patch).not.toHaveBeenCalled();
  });

  // Images and tickets use the same selected-file owner. Exercise each cause
  // of retirement once, while keeping both request paths and abort signals.
  it.each([
    ["image", "view"],
    ["image", "pane"],
    ["image", "external abort"],
    ["image", "controller abort"],
    ["download", "session"],
    ["download", "selection"],
    ["download", "closed"],
    ["download", "controller abort"],
  ] as const)("retires a pending %s after %s", async (kind, change) => {
    const f = fixture();
    const { image, read } = selectDocument(f);
    const abort = new AbortController();
    const pending = deferred<unknown>();
    const endpoint =
      kind === "image" ? f.api.resolveResource : f.api.resourceDownloadTicket;
    endpoint.mockReturnValueOnce(pending.promise);
    const outcome = expect(
      kind === "image" ? read(abort.signal) : f.controller.downloadResource(),
    ).rejects.toMatchObject({ name: "AbortError" });
    const signal: AbortSignal = endpoint.mock.calls[0]![2];
    if (change === "view") f.state.transcriptViewId = "v2";
    if (change === "pane") f.state.contextMode = "changes";
    if (change === "external abort") abort.abort();
    if (change === "controller abort") f.controller.cancelRequest();
    if (change === "session") f.state.sessionId = "s2";
    if (change === "selection") f.state.fileInspection = { kind: "browse" };
    if (change === "closed") f.state.resourcesOpen = false;
    if (change.endsWith("abort")) expect(signal.aborted).toBe(true);
    pending.resolve(
      kind === "image"
        ? image
        : { ticket: "a".repeat(43), expiresAt: Date.now() + 15_000 },
    );
    await outcome;
    expect(f.api.resourceContent).not.toHaveBeenCalled();
    expect(f.host.saveDownload).not.toHaveBeenCalled();
  });

  it("keeps a document image current through an append and fences a late content response from a retired transport", async () => {
    const f = fixture();
    const { read, image, content } = selectDocument(f);
    const started = deferred<void>();
    const late = deferred<typeof content>();
    f.api.resolveResource.mockImplementationOnce(async () => {
      f.state.transcriptRevision++;
      return image;
    });
    f.api.resourceContent.mockImplementationOnce(() => {
      started.resolve();
      return late.promise;
    });
    const outcome = expect(read()).rejects.toMatchObject({
      name: "AbortError",
    });
    await started.promise;
    f.replaceApi();
    late.resolve(content);
    await outcome;
  });

  it.each([
    { viewId: "v2" },
    { sessionId: "s2" },
    { mimeType: "text/html" },
    { size: MAX_MEDIA_PREVIEW_BYTES + 1 },
  ])(
    "refuses an invalid document image descriptor %j before reading content",
    async (invalid) => {
      const f = fixture();
      const { read, image } = selectDocument(f);
      f.api.resolveResource.mockResolvedValueOnce({ ...image, ...invalid });
      await expect(read()).rejects.toThrow();
      expect(f.api.resourceContent).not.toHaveBeenCalled();
    },
  );

  it.each([
    { totalSize: MAX_MEDIA_PREVIEW_BYTES + 1 },
    { totalSize: 8 },
    { blob: new Blob(["png"], { type: "text/html" }) },
  ])("refuses invalid document image content %j", async (invalid) => {
    const f = fixture();
    const { read, content } = selectDocument(f);
    f.api.resourceContent.mockResolvedValueOnce({ ...content, ...invalid });
    await expect(read()).rejects.toThrow();
  });

  it("reports current image authorization failure without letting an old download invalidate the transport", async () => {
    const f = fixture();
    const { read } = selectDocument(f);
    f.api.resolveResource.mockRejectedValueOnce(
      new ApiError(401, "Pair again"),
    );
    await expect(read()).rejects.toThrow("Pair again");
    const pending = deferred<never>();
    f.api.resourceDownloadTicket.mockReturnValueOnce(pending.promise);
    const outcome = expect(
      f.controller.downloadResource(),
    ).rejects.toMatchObject({ name: "AbortError" });
    f.replaceApi();
    pending.reject(new ApiError(401, "Retired credentials"));
    await outcome;
    expect(f.host.handleAuthFailure).toHaveBeenCalledOnce();
    expect(f.host.saveDownload).not.toHaveBeenCalled();
  });
});
