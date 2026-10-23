// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteSessionDraft,
  sessionDraft,
  setSessionDraft,
} from "../../src/session-drafts";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  type RouteResponse,
  TEST_HOST_AUTHORITY,
} from "./helpers";
import { baseRoutes, initStore } from "./store-fixture";

describe("Pending input recovery and copying", () => {
  beforeEach(() => {
    installFakeWebSocket();
    deleteSessionDraft("s1");
    deleteSessionDraft("s2");
  });

  it("does not carry the second Stop mutation across transport replacement during its first recovery", async () => {
    const recovery = deferred<RouteResponse>();
    const started = deferred<void>();
    const aborts: Record<string, unknown>[] = [];
    installFetch((url, init) => {
      if (url === "/api/pending/recover") {
        started.resolve();
        return recovery.promise;
      }
      if (url === "/api/control/abort") {
        aborts.push(jsonBody(init));
        return { body: { steering: [], followUp: [] } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    const stop = store.abort();
    await started.promise;
    await store.init("replacement-token");
    recovery.resolve({
      body: { steering: ["original handoff"], followUp: [] },
    });
    await stop;
    expect(aborts).toEqual([]);
  });

  it("reclaims both lost Stop handoffs once across concurrent observers", async () => {
    const image = {
      id: "recovered-image",
      fileName: "pending.png",
      mimeType: "image/png",
      size: 7,
      kind: "image",
    };
    const receipts = new Map<
      string,
      {
        steering: string[];
        followUp: string[];
        attachments?: (typeof image)[];
        authorityId?: string;
      }
    >();
    const posts: Record<string, unknown>[] = [];
    installFetch((url, init) => {
      if (url === "/api/pending/recover" || url === "/api/control/abort") {
        const body = jsonBody(init);
        posts.push(body);
        receipts.set(
          String(body.operationId),
          url === "/api/pending/recover"
            ? {
                steering: ["first handoff"],
                followUp: [],
                attachments: [image],
                authorityId: TEST_HOST_AUTHORITY,
              }
            : { steering: [], followUp: ["Stop boundary handoff"] },
        );
        throw new TypeError("response lost after dequeue");
      }
      if (url.startsWith("/api/pending/operations/")) {
        const operationId = new URL(url, "http://localhost").pathname
          .split("/")
          .at(-1)!;
        return { body: receipts.get(operationId) };
      }
      if (url.endsWith("/image")) return { body: "preview bytes" };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    setSessionDraft("s1", "newer draft");
    await Promise.all([store.abort(), store.abort()]);
    expect(posts).toHaveLength(2);
    expect(
      posts.every(
        (post) =>
          post.sessionId === "s1" && post.authorityId === TEST_HOST_AUTHORITY,
      ),
    ).toBe(true);
    expect(new Set(posts.map((post) => post.operationId)).size).toBe(2);
    expect(sessionDraft("s1")).toBe(
      "Stop boundary handoff\n\nfirst handoff\n\nnewer draft",
    );
    expect(store.getState().attachments.map((item) => item.uploadedId)).toEqual(
      [image.id],
    );
  });

  it("reclaims an unobserved recovery after reconnect without issuing another mutation or changing B's draft", async () => {
    let operationId = "";
    let connected = false;
    let posts = 0;
    installFetch((url, init) => {
      if (url === "/api/pending/recover") {
        operationId = String(jsonBody(init).operationId);
        posts++;
        throw new TypeError("response lost");
      }
      if (url.startsWith("/api/pending/operations/")) {
        expect(url).toContain(operationId);
        if (!connected) throw new TypeError("observation also unavailable");
        return { body: { steering: ["returned A"], followUp: [] } };
      }
      if (url === "/api/sessions/open")
        return { body: activeSnapshot({ sessionId: "s2" }) };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    expect(await store.recoverPending()).toBe(false);
    await store.openSession("s2");
    setSessionDraft("s2", "B draft");
    connected = true;
    await store.init("token");
    const { FakeWebSocket } = await import("./helpers");
    FakeWebSocket.instances.at(-1)!.open();
    await vi.waitFor(() => expect(sessionDraft("s1")).toBe("returned A"));
    expect(sessionDraft("s2")).toBe("B draft");
    expect(posts).toBe(1);
  });

  it("reclaims through a new transport while the original mutation observer is still pending", async () => {
    const mutation = deferred<RouteResponse>();
    const started = deferred<void>();
    let posts = 0,
      reads = 0,
      operationId = "";
    installFetch((url, init) => {
      if (url === "/api/pending/recover") {
        posts++;
        operationId = String(jsonBody(init).operationId);
        started.resolve();
        return mutation.promise;
      }
      if (url.startsWith("/api/pending/operations/")) {
        expect(url).toContain(operationId);
        reads++;
        return { body: { steering: ["retained handoff"], followUp: [] } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    const recovering = store.recoverPending();
    await started.promise;
    await store.init("replacement-token");
    const { FakeWebSocket } = await import("./helpers");
    FakeWebSocket.instances.at(-1)!.open();
    await vi.waitFor(() => expect(sessionDraft("s1")).toBe("retained handoff"));
    expect(posts).toBe(1);
    expect(reads).toBe(1);
    mutation.resolve({
      body: { steering: ["retained handoff"], followUp: [] },
    });
    expect(await recovering).toBe(false);
    expect(sessionDraft("s1")).toBe("retained handoff");
  });

  it("starts a receipt-only observation on socket resume even when the same API's mutation remains pending", async () => {
    const mutation = deferred<RouteResponse>();
    let reads = 0;
    installFetch((url, init) => {
      if (url === "/api/pending/recover") return mutation.promise;
      if (url.startsWith("/api/pending/operations/")) {
        reads++;
        return {
          body: { steering: ["socket-reclaimed handoff"], followUp: [] },
        };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const recovering = store.recoverPending();
    socket.onclose?.();
    store.recoverConnection("online");
    const { FakeWebSocket } = await import("./helpers");
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    FakeWebSocket.instances.at(-1)!.open();
    await vi.waitFor(() =>
      expect(sessionDraft("s1")).toBe("socket-reclaimed handoff"),
    );
    expect(reads).toBe(1);
    mutation.resolve({
      body: { steering: ["socket-reclaimed handoff"], followUp: [] },
    });
    expect(await recovering).toBe(true);
    expect(sessionDraft("s1")).toBe("socket-reclaimed handoff");
  });

  it("restores image handles and thumbnails beside the newest draft attachments, then resends them", async () => {
    const recoveredImage = {
      id: "recovered-image",
      fileName: "pending.png",
      mimeType: "image/png",
      size: 7,
      kind: "image",
    };
    const draftImage = {
      ...recoveredImage,
      id: "draft-image",
      fileName: "draft.png",
    };
    let sent: Record<string, unknown> = {};
    installFetch((url, init) => {
      if (url === "/api/attachments" && init.method === "POST")
        return { body: { attachments: [draftImage] } };
      if (url === "/api/pending/recover")
        return {
          body: {
            steering: ["queued caption"],
            followUp: [],
            attachments: [recoveredImage],
            authorityId: TEST_HOST_AUTHORITY,
          },
        };
      if (url === "/api/attachments/recovered-image/image")
        return { body: "preview bytes" };
      if (url === "/api/prompt") {
        sent = jsonBody(init);
        return { status: 202, body: { accepted: true } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.addFiles([
      new File(["payload"], "draft.png", { type: "image/png" }),
    ]);
    setSessionDraft("s1", "new draft");
    expect(await store.recoverPending()).toBe(true);
    expect(sessionDraft("s1")).toBe("queued caption\n\nnew draft");
    expect(store.getState().attachments.map((item) => item.uploadedId)).toEqual(
      ["recovered-image", "draft-image"],
    );
    await vi.waitFor(() =>
      expect(store.getState().attachments[0]?.previewUrl).toMatch(/^blob:/),
    );
    expect(
      store.getState().attachments.every((item) => item.status === "ready"),
    ).toBe(true);
    expect(await store.sendPrompt(sessionDraft("s1"), "followUp")).toBeTruthy();
    expect(sent.attachmentIds).toEqual(["recovered-image", "draft-image"]);
    expect(sent.behavior).toBe("followUp");
  });

  it("keeps delayed image-only recovery with its original partition and makes every copy removable", async () => {
    const recovery = deferred<RouteResponse>();
    const deletes: string[] = [];
    installFetch((url, init) => {
      if (url === "/api/pending/recover") return recovery.promise;
      if (url.endsWith("/image")) return { body: "preview bytes" };
      if (init.method === "DELETE" && url.startsWith("/api/attachments/")) {
        deletes.push(url);
        return { body: { ok: true } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const restoring = store.recoverPending();
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2" }),
    });
    setSessionDraft("s2", "other session");
    recovery.resolve({
      body: {
        steering: [""],
        followUp: [],
        attachments: [
          {
            id: "original-image",
            fileName: "pending.png",
            mimeType: "image/png",
            size: 7,
            kind: "image",
          },
        ],
        authorityId: TEST_HOST_AUTHORITY,
      },
    });
    expect(await restoring).toBe(true);
    expect(store.getState().attachments).toEqual([]);
    expect(sessionDraft("s2")).toBe("other session");
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s1" }),
    });
    await vi.waitFor(() =>
      expect(store.getState().attachments[0]?.previewUrl).toMatch(/^blob:/),
    );
    store.removeAttachment(store.getState().attachments[0]!.localId);
    expect(store.getState().attachments).toEqual([]);
    expect(deletes).toEqual(["/api/attachments/original-image"]);
  });

  it("never truncates recovered images to a send limit and explains why that draft cannot send yet", async () => {
    const images = Array.from({ length: 9 }, (_, index) => ({
      id: `image-${index}`,
      fileName: `pending-${index}.png`,
      mimeType: "image/png",
      size: 7,
      kind: "image",
    }));
    installFetch((url, init) => {
      if (url === "/api/pending/recover")
        return {
          body: {
            steering: ["all captions"],
            followUp: [],
            attachments: images,
            authorityId: TEST_HOST_AUTHORITY,
          },
        };
      if (url.endsWith("/image")) return { body: "preview bytes" };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    expect(await store.recoverPending()).toBe(true);
    expect(store.getState().attachments).toHaveLength(9);
    expect(await store.sendPrompt("all captions")).toBe(false);
    expect(store.getState().attachments).toHaveLength(9);
    expect(store.getState().notices.at(-1)?.text).toBe(
      "At most 8 attachments per message",
    );
  });

  it.each(["text-only", "image-only"] as const)(
    "merges %s recovery into the saved draft while browsing history",
    async (mode) => {
      const original = {
        id: "saved-file",
        fileName: "latest.txt",
        mimeType: "text/plain",
        size: 7,
        kind: "file",
      };
      const image = {
        id: "pending-image",
        fileName: "pending.png",
        mimeType: "image/png",
        size: 7,
        kind: "image",
      };
      installFetch((url, init) => {
        if (url === "/api/attachments" && init.method === "POST")
          return { body: { attachments: [original] } };
        if (url === "/api/pending/recover")
          return {
            body: {
              steering: mode === "text-only" ? ["returned text"] : [""],
              followUp: [],
              ...(mode === "image-only"
                ? { attachments: [image], authorityId: TEST_HOST_AUTHORITY }
                : {}),
            },
          };
        if (url.endsWith("/image")) return { body: "preview bytes" };
        return baseRoutes(url, init);
      });
      const { store } = await initStore();
      await store.addFiles([
        new File(["payload"], "latest.txt", { type: "text/plain" }),
      ]);
      store.addProjectFile("README.md");
      setSessionDraft("s1", "newest saved text");
      const scope = {
        sessionId: "s1",
        viewId: "view-s1",
        incarnation: null,
        effectiveLeafId: null,
        historyVersion: "history-1",
      };
      store.previewComposerHistoryEntry(scope, {
        text: "temporary history preview",
        images: [{ reference: "old-image", mimeType: "image/png", size: 7 }],
        files: [],
      });
      expect(store.getState().attachments[0]?.recalledArtifact).toBeDefined();
      expect(await store.recoverPending()).toBe(true);
      expect(store.getState().editorText?.text).toBe(
        mode === "text-only"
          ? "returned text\n\nnewest saved text"
          : "newest saved text",
      );
      expect(
        store.getState().attachments.map((item) => item.uploadedId),
      ).toEqual(mode === "text-only" ? [original.id] : [image.id, original.id]);
      expect(store.getState().projectFiles).toEqual(["README.md"]);
      // Nonce/history-exit callbacks must not commit or discard the old preview.
      store.commitComposerHistoryPreview(scope);
      store.cancelComposerHistoryPreview("s1");
      expect(
        store.getState().attachments.map((item) => item.uploadedId),
      ).toEqual(mode === "text-only" ? [original.id] : [image.id, original.id]);
      expect(store.getState().projectFiles).toEqual(["README.md"]);
    },
  );

  it("merges complete mixed input ahead of the latest draft without changing queue projection", async () => {
    const recovery = deferred<RouteResponse>();
    installFetch((url, init) =>
      url === "/api/pending/recover" ? recovery.promise : baseRoutes(url, init),
    );
    const { store } = await initStore();
    setSessionDraft("s1", "old draft");
    const restoring = store.recoverPending();
    setSessionDraft("s1", "newly typed draft");
    const longText = `${"x".repeat(2000)}THE_END`;
    recovery.resolve({
      body: {
        steering: [longText, "steer two"],
        followUp: ["queue one", "queue two"],
      },
    });
    expect(await restoring).toBe(true);
    expect(sessionDraft("s1")).toBe(
      `${longText}\n\nsteer two\n\nqueue one\n\nqueue two\n\nnewly typed draft`,
    );
    expect(store.getState().editorText?.text).toBe(sessionDraft("s1"));
    expect(store.getState().queue.totalCount).toBe(0);
  });

  it("keeps a delayed recovery with its original session instead of replacing another draft", async () => {
    const recovery = deferred<RouteResponse>();
    installFetch((url, init) =>
      url === "/api/pending/recover" ? recovery.promise : baseRoutes(url, init),
    );
    const { store, socket } = await initStore();
    setSessionDraft("s1", "first draft");
    const restoring = store.recoverPending();
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2" }),
    });
    setSessionDraft("s2", "second draft");
    recovery.resolve({
      body: { steering: ["old session input"], followUp: [] },
    });
    expect(await restoring).toBe(true);
    expect(sessionDraft("s1")).toBe("old session input\n\nfirst draft");
    expect(sessionDraft("s2")).toBe("second draft");
    expect(store.getState().editorText).toBeNull();
  });

  it("restores input before sending Stop and binds both requests to the original session", async () => {
    const stopped = deferred<RouteResponse>();
    const calls: string[] = [];
    let storeRef: Awaited<ReturnType<typeof initStore>>["store"];
    installFetch((url, init) => {
      if (url === "/api/pending/recover") {
        calls.push("recover");
        return { body: { steering: ["steer"], followUp: ["follow"] } };
      }
      if (url === "/api/control/abort") {
        calls.push("abort");
        expect(sessionDraft("s1")).toBe("steer\n\nfollow\n\ndraft");
        expect(storeRef.getState().editorText?.text).toBe(sessionDraft("s1"));
        expect(jsonBody(init).sessionId).toBe("s1");
        return stopped.promise;
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    storeRef = store;
    setSessionDraft("s1", "draft");
    const stopping = store.abort();
    await vi.waitFor(() => expect(calls).toEqual(["recover", "abort"]));
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2" }),
    });
    setSessionDraft("s2", "other work");
    setSessionDraft("s1", "edited while stopping");
    stopped.resolve({ body: { steering: [], followUp: ["late pending"] } });
    await stopping;
    expect(sessionDraft("s1")).toBe("late pending\n\nedited while stopping");
    expect(sessionDraft("s2")).toBe("other work");
  });

  it("still stops when preliminary recovery fails instead of leaving the task running", async () => {
    const calls: string[] = [];
    installFetch((url, init) => {
      if (url === "/api/pending/recover") {
        calls.push("recover");
        return { status: 409, body: { error: "Queue read failed" } };
      }
      if (url === "/api/control/abort") {
        calls.push("abort");
        return { body: { steering: ["recovered by Stop"], followUp: [] } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.abort();
    expect(calls).toEqual(["recover", "abort"]);
    expect(sessionDraft("s1")).toBe("recovered by Stop");
    expect(store.getState().notices.at(-1)?.text).toContain(
      "Queue read failed",
    );
  });

  it("reads authoritative full copy content and invalidates a late copy after selection changes", async () => {
    const copy = deferred<RouteResponse>();
    let body: Record<string, unknown> = {};
    installFetch((url, init) => {
      if (url === "/api/pending/text") {
        body = jsonBody(init);
        return copy.promise;
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const reading = store.pendingText(7, "text-steer-0");
    expect(body).toEqual({
      sessionId: "s1",
      viewId: "view-s1",
      revision: 7,
      itemId: "text-steer-0",
    });
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2" }),
    });
    copy.resolve({ body: { text: "x".repeat(2000) } });
    expect(await reading).toBeNull();
  });

  it("reads Pending image bytes without recovering handles, and retires them when the queue changes", async () => {
    let image = deferred<RouteResponse>();
    const mutations: string[] = [];
    installFetch((url, init) => {
      if (url === "/api/pending/text")
        return {
          body: {
            text: "",
            images: [
              { data: btoa("saved pixels"), mimeType: "image/png" },
              { attachmentId: "queued" },
            ],
          },
        };
      if (url === "/api/attachments/queued/image") return image.promise;
      if (url.includes("/pending/recover") || init.method === "DELETE")
        mutations.push(url);
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const first = store.pendingText(store.getState().queue.revision);
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/attachments/queued/image"),
        expect.anything(),
      ),
    );
    image.resolve({
      body: "uploaded pixels",
      headers: { "Content-Type": "image/png" },
    });
    const copied = await first;
    expect(copied).toMatchObject({
      text: "",
      images: [{ type: "image/png" }, { type: "image/png" }],
    });
    expect(typeof copied === "object" && copied?.images?.[0]?.size).toBe(
      "saved pixels".length,
    );
    image = deferred<RouteResponse>();
    const copy = store.pendingText(store.getState().queue.revision);
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(([input]) =>
            String(input).includes("/attachments/queued/image"),
          ),
      ).toHaveLength(2),
    );
    const snapshot = activeSnapshot();
    snapshot.pendingQueues = {
      revision: 99,
      totalCount: 0,
      steering: [],
      followUp: [],
    };
    socket.emit({ type: "snapshot", data: snapshot });
    image.resolve({ body: "image pixels" });
    expect(await copy).toBeNull();
    expect(mutations).toEqual([]);
    expect(store.getState().attachments).toEqual([]);
  });

  it("reports a real copy failure without returning a preview", async () => {
    installFetch((url, init) =>
      url === "/api/pending/text"
        ? {
            status: 409,
            body: {
              error: "Pending input changed; copy the current item again",
            },
          }
        : baseRoutes(url, init),
    );
    const { store } = await initStore();
    expect(await store.pendingText(7)).toBeNull();
    expect(store.getState().notices.at(-1)?.text).toContain(
      "Pending input changed",
    );
  });
});

describe("composer session partitions", () => {
  beforeEach(() => installFakeWebSocket());

  it("reuploads unsent browser-held attachments after bootstrap confirms a different Host", async () => {
    let uploads = 0;
    let authorityId = "11111111-1111-4111-8111-111111111111";
    const prompt = vi.fn();
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: {
            ...bootstrapPayload({ snapshot: activeSnapshot() }),
            authorityId,
          },
        };
      if (url === "/api/attachments") {
        uploads += 1;
        return {
          body: {
            attachments: [
              { id: `upload-${uploads}`, fileName: "notes.txt", kind: "file" },
            ],
          },
        };
      }
      if (url === "/api/prompt") {
        prompt(jsonBody(init));
        return { status: 202, body: { accepted: true } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.addFiles([new File(["notes"], "notes.txt")]);
    await store.init(null);
    expect(store.getState().attachments[0]?.status).toBe("ready");
    expect(uploads).toBe(1);
    authorityId = "22222222-2222-4222-8222-222222222222";
    await store.init(null);
    expect(store.getState().attachments[0]?.status).toBe("uploading");
    FakeWebSocket.instances.at(-1)!.open(activeSnapshot(), authorityId);
    await vi.waitFor(() =>
      expect(store.getState().attachments[0]).toMatchObject({
        status: "ready",
        uploadedId: "upload-2",
        uploadedAuthorityId: authorityId,
      }),
    );
    expect(prompt).not.toHaveBeenCalled();
    await store.sendPrompt("send");
    expect(prompt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ authorityId, attachmentIds: ["upload-2"] }),
    );
  });

  it("keeps staged artifacts with their session across switches and sends", async () => {
    let uploads = 0;
    const promptBodies: Record<string, unknown>[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/attachments")) {
        uploads += 1;
        return {
          body: {
            attachments: [
              {
                id: `att-${uploads}`,
                fileName: `file-${uploads}.txt`,
                mimeType: "text/plain",
                size: 5,
                kind: "file",
              },
            ],
          },
        };
      }
      if (url.startsWith("/api/prompt")) {
        promptBodies.push(jsonBody(init));
        return { status: 202, body: { accepted: true } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    await store.addFiles([
      new File(["hello"], "notes.txt", { type: "text/plain" }),
    ]);
    store.addProjectFile("src/index.ts");
    expect(store.getState().attachments).toHaveLength(1);

    // Switching sessions swaps the visible slice; session B starts clean.
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2", sessionName: "B" }),
    });
    expect(store.getState().attachments).toEqual([]);
    expect(store.getState().projectFiles).toEqual([]);

    // A send from B must not carry A's staged artifacts.
    await store.sendPrompt("from B");
    expect(promptBodies.at(-1)).toMatchObject({
      sessionId: "s2",
      message: "from B",
    });

    // Switching back restores A's staged work untouched.
    socket.emit({ type: "snapshot", data: activeSnapshot() });
    expect(store.getState().attachments.map((item) => item.fileName)).toEqual([
      "file-1.txt",
    ]);
    expect(store.getState().projectFiles).toEqual(["src/index.ts"]);
  });
});
