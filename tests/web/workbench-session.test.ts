import { beforeEach, expect, it, vi } from "vitest";
import { inspectedPreview } from "../../src/resource-preview";
import { AppStore } from "../../src/store";
import { lastWorkbenchSession } from "../../src/workbench-session";
import { fakeResourceDescriptor } from "./fixtures/resources";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  emptySnapshot,
  FakeWebSocket,
  installFakeWebSocket,
  jsonBody,
  selectSession,
  TEST_HOST_AUTHORITY,
} from "./helpers";
import { installStoreRoutes } from "./store-fixture";

const positionalImage = "pi-embedded://0/0";
const isImage = (reference: string) =>
  reference.endsWith(".png") || reference === positionalImage;

function fixture() {
  const host = {
    authorityId: TEST_HOST_AUTHORITY,
    cwd: "/project",
    missing: "",
    imageView: "view-s1",
    refuseImage: false,
    pendingImage: undefined as Promise<void> | undefined,
    offline: false,
    bootstrap: undefined as Promise<void> | undefined,
  };
  const reads: string[] = [];
  const requests = installStoreRoutes(async (url, init) => {
    if (url.startsWith("/api/bootstrap")) {
      await host.bootstrap;
      return host.offline
        ? { status: 503, body: { error: "Host unavailable" } }
        : {
            body: bootstrapPayload({
              authorityId: host.authorityId,
              startupSessionId: "s1",
            }),
          };
    }
    if (url === "/api/resources/resolve") {
      const { sessionId, reference: rawReference } = jsonBody(init);
      const reference = String(rawReference);
      reads.push(reference);
      if (reference === "pending.png") await host.pendingImage;
      const image = isImage(reference);
      if (image && host.refuseImage)
        return { status: 403, body: { error: "File no longer authorized" } };
      return reference === host.missing
        ? { status: 404, body: { error: "File was deleted" } }
        : {
            body: fakeResourceDescriptor(reference, {
              id: image ? `image-${reads.length}` : `temporary-${reads.length}`,
              sessionId: String(sessionId),
              viewId: image ? host.imageView : `view-${sessionId}`,
              workspacePath:
                reference === positionalImage ? undefined : reference,
              ...(image ? { kind: "image", mimeType: "image/png" } : {}),
            }),
          };
    }
    if (url.includes("/resources/image-") && url.includes("/content"))
      return new Response("png", { headers: { "Content-Type": "image/png" } });
    if (url.includes("/content")) return { body: "PRIVATE FILE BODY" };
    if (url.startsWith("/api/files/list")) return { body: { entries: [] } };
    if (url.startsWith("/api/files?"))
      return {
        body: { files: [{ name: "known.txt", path: "src/known.txt" }] },
      };
  });
  const join = () => {
    const socket = FakeWebSocket.instances.at(-1)!;
    const id = new URL(socket.url).searchParams.get("detail");
    socket.join(
      id ? activeSnapshot({ sessionId: id, cwd: host.cwd }) : emptySnapshot,
      { authorityId: host.authorityId },
    );
  };
  const connect = async (store = new AppStore()) => {
    await store.init();
    join();
    return store;
  };
  return { host, reads, requests, join, connect };
}

const fileRefs = (store: AppStore) =>
  store.getState().resourceTabs.map((tab) => tab.reference);
const preview = (store: AppStore) =>
  inspectedPreview(store.getState().fileInspection);
const inspect = (sessionId: string, cwd = "/project") =>
  activeSnapshot({ sessionId, cwd });

beforeEach(() => installFakeWebSocket());

it("retains named image tabs through updates, reacquires authority, and revokes retired image bytes", async () => {
  const { host, connect, reads } = fixture();
  const store = await connect();
  const socket = FakeWebSocket.instances.at(-1)!;
  const snapshot = (
    transcriptPage: NonNullable<
      Parameters<typeof activeSnapshot>[0]
    >["transcriptPage"],
  ) => {
    const next = activeSnapshot({ cwd: host.cwd, transcriptPage });
    host.imageView = next.active!.transcriptPage.viewId;
    socket.emitSnapshot(next);
  };
  vi.spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:restored")
    .mockReturnValueOnce("blob:before")
    .mockReturnValueOnce("blob:rewrite")
    .mockReturnValueOnce("blob:branch")
    .mockReturnValueOnce("blob:incarnation")
    .mockReturnValueOnce("blob:positional");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const pending = deferred<void>();
  host.pendingImage = pending.promise;
  const reading = store.openResource("pending.png");
  store.closeResourceTab("pending.png");
  await store.openResource("chart.png");
  pending.resolve();
  await reading;
  expect(fileRefs(store)).toEqual(["chart.png"]);
  expect(preview(store)).toMatchObject({
    status: "ready",
    objectUrl: "blob:before",
  });
  const ready = preview(store);
  snapshot({ revision: 2 });
  expect(preview(store)).toBe(ready);
  expect(reads).toEqual(["pending.png", "chart.png"]);
  for (const [transcriptPage, objectUrl] of [
    [{ revision: 3, appendFromRevision: 3 }, "blob:rewrite"],
    [
      { viewId: "other-branch", revision: 4, appendFromRevision: 3 },
      "blob:branch",
    ],
    [
      {
        viewId: "other-branch",
        incarnation: "new-projection",
        revision: 5,
        appendFromRevision: 4,
      },
      "blob:incarnation",
    ],
  ] as const) {
    snapshot(transcriptPage);
    await vi.waitFor(() =>
      expect(preview(store)).toMatchObject({
        status: "ready",
        descriptor: { viewId: host.imageView },
        objectUrl,
      }),
    );
  }
  expect(reads.slice(1)).toEqual(Array(4).fill("chart.png"));
  await store.openResource(positionalImage);
  expect(preview(store)).toMatchObject({
    status: "ready",
    objectUrl: "blob:positional",
  });
  snapshot({
    viewId: "other-branch",
    incarnation: "new-projection",
    revision: 6,
    appendFromRevision: 6,
  });
  expect(fileRefs(store)).toEqual(["chart.png"]);
  expect(preview(store)).toBeNull();
  expect(revoke.mock.calls.flat()).toEqual([
    "blob:before",
    "blob:rewrite",
    "blob:branch",
    "blob:incarnation",
    "blob:positional",
  ]);
  await store.openResource(positionalImage);
  snapshot({ viewId: "third-branch", revision: 7 });
  expect(fileRefs(store)).toEqual(["chart.png"]);
  expect(preview(store)).toBeNull();
  await store.openResource("chart.png");
  host.refuseImage = true;
  snapshot({ viewId: "third-branch", revision: 8, appendFromRevision: 8 });
  await vi.waitFor(() =>
    expect(preview(store)).toMatchObject({
      status: "error",
      message: "File no longer authorized",
    }),
  );
  expect(fileRefs(store)).toEqual(["chart.png"]);
});

it.each(["terminal", "closed"] as const)(
  "keeps dormant files behind %s until the reader reopens",
  async (mode) => {
    const { host, reads, requests, connect } = fixture();
    const first = await connect();
    await first.openResource("deleted.txt");
    if (mode === "terminal") first.openContextMode("terminal");
    else first.setResourcesOpen(false);
    const reopened = await connect();
    expect(reopened.getState()).toMatchObject({
      resourcesOpen: mode === "terminal",
      contextMode: mode === "terminal" ? "terminal" : "files",
      fileInspection: { kind: "file", reference: "deleted.txt", preview: null },
    });
    expect(reads).toEqual(["deleted.txt"]);
    expect(
      requests.mock.calls.some(([url]) => String(url).includes("/terminal")),
    ).toBe(false);
    host.missing = "deleted.txt";
    if (mode === "terminal") reopened.openContextMode("files");
    else reopened.setResourcesOpen(true);
    await vi.waitFor(() =>
      expect(preview(reopened)).toMatchObject({
        status: "error",
        message: "File was deleted",
      }),
    );
    expect(fileRefs(reopened)).toEqual(["deleted.txt"]);
  },
);

it("keeps a new session’s file intent during reconnect and bootstrap", async () => {
  const { host, reads, connect, join } = fixture();
  const store = await connect();
  await store.openResource("old.txt");
  host.offline = true;
  await store.init();
  expect(store.getState().connection).toBe("offline");
  host.offline = false;
  const boot = deferred<void>();
  host.bootstrap = boot.promise;
  const reconnecting = store.init();
  try {
    await selectSession(store, inspect("s2"));
    await store.openResource("new.txt");
  } finally {
    boot.resolve();
    await reconnecting;
    join();
  }
  await vi.waitFor(() =>
    expect(preview(store)).toMatchObject({
      status: "ready",
      reference: "new.txt",
    }),
  );
  expect(store.getState().sessionId).toBe("s2");
  expect(fileRefs(store)).toEqual(["new.txt"]);
  expect(reads).toEqual(["old.txt", "new.txt"]);
  await selectSession(store, inspect("s1"));
  expect(fileRefs(store)).toEqual(["old.txt"]);
});

it("keeps navigation usable when the tab refuses workbench storage", async () => {
  const { connect } = fixture();
  const storage = window.sessionStorage;
  vi.spyOn(window, "sessionStorage", "get").mockReturnValue({
    getItem: storage.getItem.bind(storage),
    setItem: () => {
      throw new DOMException("Storage disabled", "SecurityError");
    },
  } as unknown as Storage);
  const store = await connect();
  await store.openResource("one.txt");
  expect(preview(store)?.status).toBe("ready");
  expect(lastWorkbenchSession()).toBeNull();
});

it("restores paths without keeping preview data or reusing a tab for a moved workspace", async () => {
  const { host, connect, reads } = fixture();
  const first = await connect();
  await first.openResource("readme.md");
  expect(JSON.stringify(sessionStorage)).not.toMatch(
    /PRIVATE FILE BODY|temporary-/,
  );
  host.authorityId = "22222222-2222-4222-8222-222222222222";
  const second = await connect();
  await vi.waitFor(() =>
    expect(preview(second)).toMatchObject({
      status: "ready",
      descriptor: { id: "temporary-2" },
    }),
  );
  expect(reads).toEqual(["readme.md", "readme.md"]);
  host.cwd = "/another-project";
  expect(fileRefs(await connect())).toEqual([]);
});
