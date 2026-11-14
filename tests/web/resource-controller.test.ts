import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ResourceProbeResponse } from "../../shared/contracts";
import { MAX_RESOURCE_PROBE_REFERENCES } from "../../shared/resource-references";
import { type Api, ApiError } from "../../src/api";
import { emptyTranscriptView } from "../../src/app-state";
import { ResourceController } from "../../src/controllers/resource-controller";
import {
  inspectedPreview,
  MAX_MEDIA_PREVIEW_BYTES,
} from "../../src/resource-preview";
import { fakeResourceDescriptor } from "./fixtures/resources";
import { deferred } from "./helpers";

type Host = ConstructorParameters<typeof ResourceController>[0];
type Content = Awaited<ReturnType<Api["resourceContent"]>>;
const document = fakeResourceDescriptor("reports/README.md", {
  id: "document",
  viewId: "v1",
  kind: "markdown",
  mimeType: "text/markdown",
});
const image = fakeResourceDescriptor("./reports/curve.png", {
  id: "image",
  viewId: "v1",
  kind: "image",
  mimeType: "image/png",
  size: 3,
});
const pixels = new Blob(["png"], { type: "image/png" });
const content: Content = { blob: pixels, totalSize: pixels.size };
const temporary = new ApiError(503, "Temporarily unavailable");
const retired = new ApiError(401, "Retired credentials");
const ticket = "a".repeat(43);
const downloadGrant = { ticket, expiresAt: 2_000_000_000_000 };

function fixture() {
  const state: ReturnType<Host["state"]> = {
    sessionId: "s1",
    view: {
      ...emptyTranscriptView,
      viewId: "v1",
      incarnation: "p1",
      revision: 1,
    },
    resourcesOpen: true,
    contextMode: "files",
    fileInspection: { kind: "browse" },
    resourceTabs: [],
    resourceStanding: {},
  };
  const probeResponse = (
    results: ResourceProbeResponse["results"],
    revision = state.view.revision,
  ): ResourceProbeResponse => ({
    sessionId: "s1",
    viewId: "v1",
    revision,
    results,
  });
  const transport = {
    probeResources: vi.fn<Api["probeResources"]>(async (_session, refs) =>
      probeResponse(
        refs.map((reference) => ({ reference, availability: "available" })),
      ),
    ),
    resourceDownloadTicket: vi.fn<Api["resourceDownloadTicket"]>(),
    resolveResource: vi
      .fn<Api["resolveResource"]>()
      .mockResolvedValue(fakeResourceDescriptor("notes.txt", { viewId: "v1" })),
    resourceContent: vi.fn<Api["resourceContent"]>().mockResolvedValue({
      blob: new Blob(["Notes"], { type: "text/plain" }),
      totalSize: 5,
    }),
  };
  let api = transport as unknown as Api;
  const authFailure = vi.fn();
  const saveDownload = vi.fn();
  const patch = vi.fn((partial: Parameters<Host["patch"]>[0]) => {
    Object.assign(state, partial);
  });
  const controller = new ResourceController({
    state: () => state,
    api: () => api,
    patch,
    handleAuthFailure: authFailure,
    saveDownload,
    revealWorkspacePath: vi.fn(),
  });
  return {
    ...transport,
    controller,
    state,
    patch,
    authFailure,
    saveDownload,
    probeResponse,
    preview: () => inspectedPreview(state.fileInspection),
    standing: (reference: string) =>
      state.resourceStanding[reference]?.availability,
    replaceApi: () => {
      api = { ...api };
    },
    selectDocument: () => {
      state.fileInspection = {
        kind: "file",
        reference: document.reference,
        preview: {
          status: "ready",
          reference: document.reference,
          descriptor: document,
        },
      };
      transport.resolveResource.mockResolvedValue(image);
      transport.resourceContent.mockResolvedValue(content);
      return (signal = new AbortController().signal) =>
        controller.loadDocumentImage(document.id, image.reference, signal);
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("keeps verified probe batches, retries only failed references and drops retries across revisions", async () => {
  const f = fixture();
  const batch = Array.from(
    { length: MAX_RESOURCE_PROBE_REFERENCES },
    (_, index) => `file-${index}.md`,
  );
  const remaining = ["later.md", "new.md"];
  f.probeResources
    .mockResolvedValueOnce(
      f.probeResponse(
        batch.map((reference, index) => ({
          reference,
          availability:
            index === 0 ? "missing" : index === 1 ? "unavailable" : "available",
        })),
      ),
    )
    .mockRejectedValueOnce(temporary);
  await f.controller.probeResources([...batch, ...remaining]);
  expect([
    f.standing(batch[0]!),
    f.standing(batch[1]!),
    f.standing(remaining[0]!),
  ]).toEqual(["missing", "unavailable", "unknown"]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.probeResources.mock.calls.map(([, refs]) => refs)).toEqual([
    batch,
    remaining,
    remaining,
  ]);
  f.state.view.revision++;
  f.probeResources.mockRejectedValueOnce(temporary);
  await f.controller.probeResources([...remaining, "after-append.md"]);
  expect(f.standing("later.md")).toBe("available");
  expect(f.standing("after-append.md")).toBe("unknown");
  f.state.view.revision++;
  await vi.advanceTimersByTimeAsync(14_000);
  expect(f.probeResources).toHaveBeenCalledTimes(4);
  f.controller.cancelProbes(true);
  expect(f.state.resourceStanding).toEqual({});
  expect(f.resourceContent).not.toHaveBeenCalled();
});

it.each(["newer resolve", "revision", "transport"] as const)(
  "does not publish an old probe after %s",
  async (change) => {
    const f = fixture();
    const late = deferred<ResourceProbeResponse>();
    f.probeResources.mockReturnValueOnce(late.promise);
    const pending = f.controller.probeResources(["notes.txt", "other.txt"]);
    if (change === "newer resolve")
      await f.controller.openResource("notes.txt");
    if (change === "revision") f.state.view.revision++;
    if (change === "transport") {
      f.replaceApi();
      f.controller.invalidateForTransportReplacement();
      late.reject(retired);
    } else
      late.resolve(
        f.probeResponse(
          [
            { reference: "notes.txt", availability: "missing" },
            { reference: "other.txt", availability: "available" },
          ],
          1,
        ),
      );
    await pending;
    if (change === "newer resolve") {
      expect(f.standing("notes.txt")).toBe("available");
      expect(f.standing("other.txt")).toBe("available");
    } else expect(f.state.resourceStanding).toEqual({});
    expect(f.authFailure).not.toHaveBeenCalled();
  },
);

it.each(["resolveResource", "resourceContent"] as const)(
  "recovers %s until the view retires its retry",
  async (endpoint) => {
    const f = fixture();
    f[endpoint].mockRejectedValueOnce(temporary);
    const reading = f.controller.openResource("notes.txt");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.preview()?.status).toBe("loading");
    await vi.advanceTimersByTimeAsync(1_000);
    await reading;
    expect(f.preview()).toMatchObject({ status: "ready", text: "Notes" });
    expect(f[endpoint]).toHaveBeenCalledTimes(2);

    f[endpoint].mockRejectedValueOnce(temporary);
    const refreshing = f.controller.openResource("notes.txt");
    await vi.advanceTimersByTimeAsync(0);
    f.state.view.viewId = "replacement";
    f.controller.invalidate();
    await refreshing;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f[endpoint]).toHaveBeenCalledTimes(3);
  },
);

it("retains only a still-authorized media URL across refresh failure, replacement and close", async () => {
  const f = fixture();
  vi.spyOn(URL, "createObjectURL")
    .mockReturnValueOnce("blob:old")
    .mockReturnValueOnce("blob:new")
    .mockReturnValueOnce("blob:reopened");
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  f.resolveResource.mockResolvedValue(image);
  f.resourceContent.mockResolvedValue(content);
  await f.controller.openResource(image.reference);
  f.resourceContent.mockRejectedValue(temporary);
  const refreshing = f.controller.openResource(image.reference);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.preview()).toMatchObject({
    objectUrl: "blob:old",
    refreshing: true,
  });
  await vi.advanceTimersByTimeAsync(14_000);
  await refreshing;
  expect(f.preview()).toMatchObject({
    objectUrl: "blob:old",
    refreshing: false,
    refreshError: temporary.message,
  });
  expect(revoke).not.toHaveBeenCalled();

  const updated = new Blob(["updated"], { type: pixels.type });
  f.resourceContent.mockResolvedValue({
    blob: updated,
    totalSize: updated.size,
  });
  await f.controller.openResource(image.reference);
  expect(f.preview()).toMatchObject({
    objectUrl: "blob:new",
    descriptor: { size: updated.size },
  });
  expect(f.preview()).not.toHaveProperty("refreshError");
  f.controller.clearSelection();
  await f.controller.openResource(image.reference);
  f.state.resourceTabs.push({ reference: "pi-embedded://0/0" });
  f.replaceApi();
  f.controller.invalidateForTransportReplacement();
  expect(revoke.mock.calls).toEqual([
    ["blob:old"],
    ["blob:new"],
    ["blob:reopened"],
  ]);
  expect(f.state.resourceTabs).toEqual([{ reference: image.reference }]);
  expect(f.state.resourceStanding).toEqual({});
  expect(f.preview()).toEqual({
    status: "loading",
    reference: image.reference,
  });
});

it("takes truncation and size from current text transfer bytes", async () => {
  const f = fixture();
  for (const totalSize of [20, 4]) {
    f.resourceContent.mockResolvedValueOnce({
      blob: new Blob(["text"]),
      totalSize,
    });
    await f.controller.openResource("notes.txt");
    expect(f.preview()).toMatchObject({
      status: "ready",
      truncated: totalSize > 4,
      descriptor: { size: totalSize },
    });
  }
});

it.each([
  ["html", "page.html", "text/html", "<h1>你好 🌍</h1>"],
  [
    "image",
    "chart.svg",
    "image/svg+xml",
    '<svg xmlns="http://www.w3.org/2000/svg"><text>你好 🌍</text></svg>',
  ],
] as const)(
  "decodes %s source while constructing the correct preview Blob",
  async (kind, name, mimeType, text) => {
    const f = fixture();
    const blob = new Blob([Buffer.from(`\uFEFF${text}`, "utf16le")], {
      type: mimeType,
    });
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:preview");
    f.resolveResource.mockResolvedValue(
      fakeResourceDescriptor(name, {
        viewId: "v1",
        kind,
        mimeType,
        size: blob.size,
      }),
    );
    f.resourceContent.mockResolvedValue({ blob, totalSize: blob.size });
    await f.controller.openResource(name);
    expect(f.preview()).toMatchObject({
      status: "ready",
      text,
      objectUrl: "blob:preview",
    });
    const rendered = create.mock.calls[0]![0] as Blob;
    if (kind === "html") {
      expect(rendered.type).toBe("text/html;charset=utf-8");
      expect(await rendered.text()).toContain(text);
    } else expect(rendered).toBe(blob);
    f.controller.invalidate();
  },
);

it("aborts old content on a newer file choice and never installs its late body", async () => {
  const f = fixture();
  const started = deferred<AbortSignal>();
  const late = deferred<Content>();
  f.resourceContent.mockImplementationOnce((_id, _session, options) => {
    started.resolve(options!.signal!);
    return late.promise;
  });
  const reading = f.controller.openResource("notes.txt");
  const signal = await started.promise;
  await f.controller.openResource("other.txt");
  expect(signal.aborted).toBe(true);
  late.resolve(content);
  await reading;
  expect(f.preview()).toMatchObject({
    status: "ready",
    reference: "other.txt",
    text: "Notes",
  });
});

it.each(["incarnation", "transport"] as const)(
  "keeps transcript images out of Files and fences the old %s",
  async (change) => {
    const f = fixture();
    const reference = "pi-embedded://4/0";
    f.resolveResource.mockResolvedValue({ ...image, reference });
    f.resourceContent.mockResolvedValue(content);
    const read = () =>
      f.controller.loadTranscriptImage(
        "s1",
        "v1",
        "v1\u0000p1",
        reference,
        new AbortController().signal,
      );
    await expect(read()).resolves.toBe(pixels);
    expect(f.state.fileInspection).toEqual({ kind: "browse" });
    const started = deferred<void>();
    const late = deferred<Content>();
    f.resourceContent.mockImplementationOnce(() => {
      started.resolve();
      return late.promise;
    });
    const result = expect(read()).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;
    if (change === "incarnation") {
      f.state.view.incarnation = "p2";
      late.resolve(content);
    } else {
      f.replaceApi();
      late.reject(retired);
    }
    await result;
    expect(f.authFailure).not.toHaveBeenCalled();
  },
);

it("keeps distinct standing for ambiguity, a missing file, and a failed transfer", async () => {
  const f = fixture();
  const matches = ["a/notes.txt", "b/notes.txt"];
  f.resolveResource.mockRejectedValueOnce(
    new ApiError(409, "Ambiguous", matches),
  );
  await f.controller.openResource("notes.txt");
  expect(f.preview()).toMatchObject({ status: "ambiguous", matches });
  expect(f.state.resourceStanding["notes.txt"]).toMatchObject({
    availability: "ambiguous",
    matches,
  });
  f.resolveResource.mockRejectedValueOnce(new ApiError(404, "Missing"));
  await f.controller.openResource("notes.txt");
  expect(f.preview()).toMatchObject({ status: "error", message: "Missing" });
  expect(f.standing("notes.txt")).toBe("missing");
  expect(f.resourceContent).not.toHaveBeenCalled();
  f.resourceContent.mockRejectedValueOnce(
    new ApiError(404, "Bytes unavailable"),
  );
  await f.controller.openResource("notes.txt");
  expect(f.preview()).toMatchObject({
    status: "error",
    message: "Bytes unavailable",
  });
  expect(f.standing("notes.txt")).toBe("available");
});

it.each([401, 403])(
  "does not retry a definitive %i or preserve revoked file bytes",
  async (status) => {
    const f = fixture();
    await f.controller.openResource("notes.txt");
    f.resolveResource.mockRejectedValue(new ApiError(status, "Read refused"));
    await f.controller.openResource("notes.txt");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.resolveResource).toHaveBeenCalledTimes(2);
    expect(f.resourceContent).toHaveBeenCalledOnce();
    expect(f.authFailure).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    if (status === 403)
      expect(f.preview()).toMatchObject({
        status: "error",
        message: "Read refused",
      });
  },
);

it("authorizes linked images independently and requires complete addressed media", async () => {
  const f = fixture();
  const read = f.selectDocument();
  for (const invalid of [
    { viewId: "v2" },
    { sessionId: "s2" },
    { mimeType: "text/html" },
    { size: MAX_MEDIA_PREVIEW_BYTES + 1 },
  ]) {
    f.resolveResource.mockResolvedValueOnce({ ...image, ...invalid });
    await expect(read()).rejects.toThrow();
  }
  expect(f.resourceContent).not.toHaveBeenCalled();
  for (const invalid of [
    { totalSize: MAX_MEDIA_PREVIEW_BYTES + 1 },
    { totalSize: 8 },
    { blob: new Blob(["png"], { type: "text/html" }) },
  ]) {
    f.resourceContent.mockResolvedValueOnce({ ...content, ...invalid });
    await expect(read()).rejects.toThrow();
  }
  f.resolveResource.mockImplementationOnce(async () => {
    f.state.view.revision++;
    return image;
  });
  await expect(read()).resolves.toBe(pixels);
  expect(f.resolveResource).toHaveBeenLastCalledWith(
    "s1",
    image.reference,
    expect.any(AbortSignal),
  );
  expect(f.resourceContent).toHaveBeenLastCalledWith(image.id, "s1", {
    byteLimit: MAX_MEDIA_PREVIEW_BYTES + 1,
    signal: expect.any(AbortSignal),
  });
  expect(f.patch).not.toHaveBeenCalled();
});

it.each([
  "pane closes",
  "another file",
  "controller abort",
  "reader abort",
  "transport",
] as const)("retires image and download ownership on %s", async (change) => {
  const f = fixture();
  const read = f.selectDocument();
  const gate = deferred<typeof image>();
  const grant = deferred<typeof downloadGrant>();
  const reader = new AbortController();
  f.resolveResource
    .mockRejectedValueOnce(new ApiError(401, "Pair again"))
    .mockReturnValueOnce(gate.promise);
  await expect(read()).rejects.toThrow("Pair again");
  f.resourceDownloadTicket.mockReturnValueOnce(grant.promise);
  const inline = expect(read(reader.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  const downloading = f.controller.downloadResource();
  const result =
    change === "reader abort"
      ? downloading
      : expect(downloading).rejects.toMatchObject({ name: "AbortError" });
  if (change === "pane closes") f.state.resourcesOpen = false;
  if (change === "another file") f.state.fileInspection = { kind: "browse" };
  if (change === "controller abort") f.controller.cancelRequest();
  if (change === "reader abort") reader.abort();
  if (change === "transport") {
    f.replaceApi();
    grant.reject(retired);
  } else grant.resolve(downloadGrant);
  if (change === "controller abort" || change === "reader abort")
    expect(f.resolveResource.mock.calls[1]![2]?.aborted).toBe(true);
  gate.resolve(image);
  await Promise.all([inline, result]);
  expect(f.resourceContent).not.toHaveBeenCalled();
  expect(f.authFailure).toHaveBeenCalledOnce();
  expect(f.saveDownload).toHaveBeenCalledTimes(
    change === "reader abort" ? 1 : 0,
  );
});
