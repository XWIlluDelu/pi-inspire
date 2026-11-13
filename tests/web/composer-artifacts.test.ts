// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  type RouteResponse,
  selectSession,
  TEST_HOST_AUTHORITY,
} from "./helpers";
import { baseRoutes, initStore } from "./store-fixture";

describe("Pending input recovery and copying", () => {
  beforeEach(() => {
    installFakeWebSocket();
  });

  it("reclaims Pending input after reconnect without continuing the old Stop", async () => {
    const mutation = deferred<RouteResponse>();
    const started = deferred<void>();
    let operationId = "";
    const posts = vi.fn();
    const aborts = vi.fn();
    const selected = activeSnapshot({ sessionId: "s2" });
    installFetch((url, init) => {
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
    store.drafts.setText("s2", "B draft");
    await store.init();
    FakeWebSocket.instances.at(-1)!.join(selected);
    await vi.waitFor(() =>
      expect(store.drafts.get("s1").text).toBe("retained handoff"),
    );
    expect(store.getState().sessionId).toBe("s2");
    mutation.resolve({
      body: { steering: ["retained handoff"], followUp: [] },
    });
    await stopping;
    expect(posts).toHaveBeenCalledOnce();
    expect(aborts).not.toHaveBeenCalled();
    expect(store.drafts.get("s1").text).toBe("retained handoff");
    expect(store.drafts.get("s2").text).toBe("B draft");
  });

  it("merges delayed recovery into its original draft, keeping files and image removal", async () => {
    const recovery = deferred<RouteResponse>();
    const deletes: string[] = [];
    installFetch((url, init) => {
      if (url === "/api/pending/recover") return recovery.promise;
      if (url === "/api/attachments")
        return {
          body: {
            attachments: [
              { id: "saved-file", fileName: "latest.txt", kind: "file" },
            ],
          },
        };
      if (url.endsWith("/image")) return { body: "preview bytes" };
      if (init.method === "DELETE" && url.startsWith("/api/attachments/")) {
        deletes.push(url);
        return { body: { ok: true } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.addFiles([new File(["draft file"], "latest.txt")]);
    store.addProjectFile("README.md");
    store.drafts.setText("s1", "first draft");
    const restoring = store.recoverPending();
    store.drafts.setText("s1", "newest draft");
    await selectSession(store, activeSnapshot({ sessionId: "s2" }));
    store.drafts.setText("s2", "other session");
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
    expect(store.drafts.get("s2")).toMatchObject({
      text: "other session",
      attachments: [],
    });
    expect(store.drafts.get("s1")).toMatchObject({
      text: "queued caption\n\nnext input\n\nnewest draft",
      projectFiles: ["README.md"],
    });
    await selectSession(store, activeSnapshot());
    await vi.waitFor(() =>
      expect(
        store.drafts.get(store.getState().sessionId).attachments[0]?.previewUrl,
      ).toMatch(/^blob:/),
    );
    store.removeAttachment(
      store.drafts.get(store.getState().sessionId).attachments[0]!.localId,
    );
    expect(
      store.drafts.get("s1").attachments.map(({ uploadedId }) => uploadedId),
    ).toEqual(["saved-file"]);
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
    expect(
      store.drafts.get(store.getState().sessionId).attachments,
    ).toHaveLength(9);
    expect(await store.sendPrompt("all captions")).toBe(false);
    expect(
      store.drafts.get(store.getState().sessionId).attachments,
    ).toHaveLength(9);
    expect(store.getState().notices.at(-1)?.text).toBe(
      "At most 8 attachments per message",
    );
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
        expect(storeRef.drafts.get("s1").text).toBe("steer\n\nfollow\n\ndraft");
        expect(jsonBody(init).sessionId).toBe("s1");
        return stopped.promise;
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    storeRef = store;
    store.drafts.setText("s1", "draft");
    const stopping = store.abort();
    await vi.waitFor(() => expect(calls).toEqual(["recover", "abort"]));
    await selectSession(store, activeSnapshot({ sessionId: "s2" }));
    store.drafts.setText("s2", "other work");
    store.drafts.setText("s1", "edited while stopping");
    stopped.resolve({ body: { steering: [], followUp: ["late pending"] } });
    await stopping;
    expect(store.drafts.get("s1").text).toBe(
      "late pending\n\nedited while stopping",
    );
    expect(store.drafts.get("s2").text).toBe("other work");
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
    socket.emitSnapshot(snapshot);
    delayedImage.resolve({ body: "image pixels" });
    expect(await copy).toBeNull();

    readText.mockReturnValueOnce(delayedText.promise);
    const reading = store.pendingText(99);
    await selectSession(store, activeSnapshot({ sessionId: "s2" }));
    delayedText.resolve({ body: { text: "old queue" } });
    expect(await reading).toBeNull();

    readText.mockReturnValueOnce({ status: 409, body: { error: refusal } });
    expect(await store.pendingText(7)).toBeNull();
    expect(store.getState().notices.at(-1)?.text).toBe(refusal);
    expect(mutations).toEqual([]);
    expect(store.drafts.get(store.getState().sessionId).attachments).toEqual(
      [],
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
            ...bootstrapPayload({ startupSessionId: "s1" }),
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
    expect(
      store.drafts.get(store.getState().sessionId).attachments[0]?.status,
    ).toBe("ready");
    expect(uploads).toBe(1);
    authorityId = "22222222-2222-4222-8222-222222222222";
    await store.init();
    expect(
      store.drafts.get(store.getState().sessionId).attachments[0]?.status,
    ).toBe("uploading");
    FakeWebSocket.instances.at(-1)!.join(activeSnapshot(), { authorityId });
    await vi.waitFor(() =>
      expect(
        store.drafts.get(store.getState().sessionId).attachments[0],
      ).toMatchObject({
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
