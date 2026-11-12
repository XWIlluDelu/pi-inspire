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

  it("reclaims Pending input after reconnect without continuing the old Stop", async () => {
    const mutation = deferred<RouteResponse>();
    const started = deferred<void>();
    let operationId = "";
    const posts = vi.fn();
    const aborts = vi.fn();
    const selected = activeSnapshot({ sessionId: "s2" });
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap?detail=s2"))
        return { body: bootstrapPayload({ snapshot: selected }) };
      if (url === "/api/pending/recover") {
        posts(jsonBody(init));
        operationId = String(jsonBody(init).operationId);
        started.resolve();
        return mutation.promise;
      }
      if (url.startsWith("/api/pending/operations/")) {
        expect(url).toContain(operationId);
        return { body: { steering: ["retained handoff"], followUp: [] } };
      }
      if (url === "/api/control/abort") {
        aborts();
        return { body: { steering: [], followUp: [] } };
      }
      if (url === "/api/sessions/open") return { body: selected };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    const stopping = store.abort();
    await started.promise;
    await store.openSession("s2");
    setSessionDraft("s2", "B draft");
    await store.init();
    FakeWebSocket.instances.at(-1)!.open();
    await vi.waitFor(() => expect(sessionDraft("s1")).toBe("retained handoff"));
    expect(store.getState().sessionId).toBe("s2");
    mutation.resolve({
      body: { steering: ["retained handoff"], followUp: [] },
    });
    await stopping;
    expect(posts).toHaveBeenCalledOnce();
    expect(aborts).not.toHaveBeenCalled();
    expect(sessionDraft("s1")).toBe("retained handoff");
    expect(sessionDraft("s2")).toBe("B draft");
  });

  it("merges a delayed mixed recovery with its originating session's latest draft and makes the image removable", async () => {
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
    setSessionDraft("s1", "first draft");
    const restoring = store.recoverPending();
    setSessionDraft("s1", "newest draft");
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2" }),
    });
    setSessionDraft("s2", "other session");
    recovery.resolve({
      body: {
        steering: ["queued caption"],
        followUp: ["next input"],
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
    expect(store.getState().editorText).toBeNull();
    expect(sessionDraft("s1")).toBe(
      "queued caption\n\nnext input\n\nnewest draft",
    );
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
      expect(await store.recoverPending()).toBe(true);
      expect(store.getState().editorText?.text).toBe(
        mode === "text-only"
          ? "returned text\n\nnewest saved text"
          : "newest saved text",
      );
      // Closing the history preview after Return must keep the restored draft.
      store.commitComposerHistoryPreview(scope);
      store.cancelComposerHistoryPreview("s1");
      expect(
        store.getState().attachments.map((item) => item.uploadedId),
      ).toEqual(mode === "text-only" ? [original.id] : [image.id, original.id]);
      expect(store.getState().projectFiles).toEqual(["README.md"]);
    },
  );

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

  it("copies addressed Pending content without recovering it and retires old text and images", async () => {
    const delayedText = deferred<RouteResponse>();
    const delayedImage = deferred<RouteResponse>();
    const refusal = "Pending input changed; copy the current item again";
    const readText = vi
      .fn<
        (
          body: Record<string, unknown>,
        ) => RouteResponse | Promise<RouteResponse>
      >()
      .mockReturnValue({
        body: {
          text: "",
          images: [
            { data: btoa("saved pixels"), mimeType: "image/png" },
            { attachmentId: "queued" },
          ],
        },
      });
    const readImage = vi
      .fn()
      .mockResolvedValueOnce({
        body: "uploaded pixels",
        headers: { "Content-Type": "image/png" },
      })
      .mockReturnValueOnce(delayedImage.promise);
    const mutations: string[] = [];
    installFetch((url, init) => {
      if (url === "/api/pending/text") return readText(jsonBody(init));
      if (url === "/api/attachments/queued/image") return readImage();
      if (
        url === "/api/pending/recover" ||
        url === "/api/pending/clear" ||
        init.method === "DELETE"
      )
        mutations.push(url);
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const copied = await store.pendingText(7, "text-steer-0");
    expect(readText).toHaveBeenCalledExactlyOnceWith({
      sessionId: "s1",
      viewId: "view-s1",
      revision: 7,
      itemId: "text-steer-0",
    });
    expect(copied).toMatchObject({
      text: "",
      images: [
        { type: "image/png", size: "saved pixels".length },
        { type: "image/png" },
      ],
    });

    const copy = store.pendingText(store.getState().queue.revision);
    await vi.waitFor(() => expect(readImage).toHaveBeenCalledTimes(2));
    const snapshot = activeSnapshot();
    snapshot.pendingQueues = {
      revision: 99,
      totalCount: 0,
      steering: [],
      followUp: [],
    };
    socket.emit({ type: "snapshot", data: snapshot });
    delayedImage.resolve({ body: "image pixels" });
    expect(await copy).toBeNull();

    readText.mockReturnValueOnce(delayedText.promise);
    const reading = store.pendingText(99);
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2" }),
    });
    delayedText.resolve({ body: { text: "old queue" } });
    expect(await reading).toBeNull();

    readText.mockReturnValueOnce({ status: 409, body: { error: refusal } });
    expect(await store.pendingText(7)).toBeNull();
    expect(store.getState().notices.at(-1)?.text).toBe(refusal);
    expect(mutations).toEqual([]);
    expect(store.getState().attachments).toEqual([]);
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
    await store.init();
    expect(store.getState().attachments[0]?.status).toBe("ready");
    expect(uploads).toBe(1);
    authorityId = "22222222-2222-4222-8222-222222222222";
    await store.init();
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
});
