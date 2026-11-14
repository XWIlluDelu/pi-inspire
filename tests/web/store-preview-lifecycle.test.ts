import { beforeEach, expect, it, vi } from "vitest";
import { inspectedPreview } from "../../src/resource-preview";
import { fakeResourceDescriptor } from "./fixtures/resources";
import {
  activeSnapshot,
  deferred,
  installFakeWebSocket,
  jsonBody,
  selectSession,
} from "./helpers";
import { initStore, installStoreRoutes } from "./store-fixture";

const chart = { reference: "chart.png", workspacePath: "plots/chart.png" };
const embedded = "pi-embedded://0/0";

beforeEach(() => {
  installFakeWebSocket();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:chart");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

async function fixture() {
  let viewId = "view-s1";
  let refused = false;
  const pending = deferred<void>();
  const resolve = vi.fn(async (request: Record<string, unknown>) => {
    const reference = String(request.reference);
    if (reference === "pending.png") await pending.promise;
    if (refused)
      return { status: 403, body: { error: "File no longer authorized" } };
    return {
      body: fakeResourceDescriptor(reference, {
        id: `${reference}-${resolve.mock.calls.length}`,
        viewId,
        workspacePath:
          reference === embedded ? undefined : `plots/${reference}`,
        mimeType: "image/png",
        kind: "image",
      }),
    };
  });
  installStoreRoutes((url, init) => {
    if (url === "/api/resources/resolve") return resolve(jsonBody(init));
    if (url.includes("/content?"))
      return new Response("png", { headers: { "Content-Type": "image/png" } });
  });
  const { store, socket } = await initStore();
  const state = () => store.getState();
  return {
    store,
    state,
    resolve,
    pending,
    preview: () => inspectedPreview(state().fileInspection),
    snapshot: (overrides: Parameters<typeof activeSnapshot>[0]) => {
      const next = activeSnapshot(overrides);
      viewId = next.active!.transcriptPage.viewId;
      socket.emitSnapshot(next);
    },
    revokeAccess: () => {
      refused = true;
    },
  };
}

it.each(["rewrite", "view", "incarnation"] as const)(
  "keeps ordinary appends and reauthorizes named files after a new %s",
  async (change) => {
    const f = await fixture();
    await f.store.openResource(chart.reference);
    const ready = f.preview();
    expect(ready).toMatchObject({ status: "ready", objectUrl: "blob:chart" });
    f.snapshot({ transcriptPage: { revision: 2 } });
    expect(f.preview()).toBe(ready);
    expect(f.resolve).toHaveBeenCalledOnce();
    const view =
      change === "view"
        ? { viewId: "rewritten" }
        : change === "incarnation"
          ? { incarnation: "new-projection" }
          : {};
    f.snapshot({
      transcriptPage: {
        ...view,
        revision: 3,
        appendFromRevision: change === "rewrite" ? 3 : 2,
      },
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:chart");
    await vi.waitFor(() =>
      expect(f.preview()).toMatchObject({
        status: "ready",
        descriptor: { viewId: f.state().view.viewId },
      }),
    );
    expect(f.resolve).toHaveBeenLastCalledWith(expect.objectContaining(chart));
    expect(f.state().resourceTabs).toEqual([chart]);

    f.revokeAccess();
    f.snapshot({
      transcriptPage: { ...view, revision: 4, appendFromRevision: 4 },
    });
    await vi.waitFor(() =>
      expect(f.preview()).toMatchObject({
        status: "error",
        message: "File no longer authorized",
      }),
    );
    expect(f.state().fileInspection).toMatchObject({ kind: "file", ...chart });
  },
);

it("retires closed and positional tabs while retaining named navigation only in its workspace", async () => {
  const f = await fixture();
  const reading = f.store.openResource("pending.png");
  f.store.closeResourceTab("pending.png");
  await f.store.openResource(chart.reference);
  f.pending.resolve();
  await reading;
  expect(f.state()).toMatchObject({
    resourceTabs: [chart],
    fileInspection: { kind: "file", ...chart },
  });
  for (const transcriptPage of [
    { revision: 2, appendFromRevision: 2 },
    { viewId: "view-branch-b" },
  ]) {
    await f.store.openResource(embedded);
    f.snapshot({ transcriptPage });
    expect(f.state()).toMatchObject({
      resourceTabs: [chart],
      fileInspection: { kind: "browse" },
    });
  }
  await f.store.openResource(chart.reference);
  const urls = vi.mocked(URL.revokeObjectURL).mock.calls.length;
  f.snapshot({
    cwd: "/elsewhere",
    transcriptPage: { viewId: "different-workspace" },
  });
  expect(f.state()).toMatchObject({
    resourceTabs: [],
    fileInspection: { kind: "browse" },
  });
  await f.store.openResource(chart.reference);
  await selectSession(
    f.store,
    activeSnapshot({ sessionId: "s2", cwd: "/elsewhere" }),
  );
  expect(f.state()).toMatchObject({
    resourceTabs: [],
    fileInspection: { kind: "browse" },
  });
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(urls + 2);
});
