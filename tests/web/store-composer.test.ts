// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PiRuntimeSettings } from "../../shared/contracts";
import {
  deleteSessionDraft,
  sessionDraft,
  setSessionDraft,
} from "../../src/session-drafts";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
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

describe("thinking level control", () => {
  beforeEach(() => installFakeWebSocket());

  it("rolls back to the truthful level and resyncs when the API rejects the change", async () => {
    let snapshotCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/control/thinking"))
        return { status: 500, body: { error: "unsupported level" } };
      if (url.startsWith("/api/snapshot")) {
        snapshotCalls += 1;
        return { body: activeSnapshot({ thinkingLevel: "medium" }) };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    expect(store.getState().thinkingLevel).toBe("medium");

    await store.setThinkingLevel("xhigh");
    // rolled back: the UI must not claim a level the runtime rejected
    expect(store.getState().thinkingLevel).toBe("medium");
    expect(store.getState().error).toBeNull();
    expect(
      store
        .getState()
        .notices.some(
          (notice) =>
            notice.kind === "warning" && notice.text === "unsupported level",
        ),
    ).toBe(true);
    await vi.waitFor(() => expect(snapshotCalls).toBeGreaterThan(0));
  });

  it("does not let an older refusal undo a newer accepted level", async () => {
    const xhigh = deferred<RouteResponse>();
    const low = deferred<RouteResponse>();
    installFetch((url, init) => {
      if (url.startsWith("/api/control/thinking")) {
        const body = jsonBody(init) as { level: string };
        return body.level === "xhigh" ? xhigh.promise : low.promise;
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    const older = store.setThinkingLevel("xhigh");
    const newer = store.setThinkingLevel("low");
    low.resolve({ body: { ok: true } });
    await newer;
    xhigh.resolve({ status: 500, body: { error: "unsupported level" } });
    await older;

    expect(store.getState().thinkingLevel).toBe("low");
  });
});

describe("composer session partitions", () => {
  beforeEach(() => installFakeWebSocket());

  it("invalidates ready attachment handles only when bootstrap confirms a different Host", async () => {
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
      if (url === "/api/attachments")
        return {
          body: {
            attachments: [
              { id: "upload", fileName: "notes.txt", kind: "file" },
            ],
          },
        };
      if (url === "/api/prompt") prompt();
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.addFiles([new File(["notes"], "notes.txt")]);
    await store.init(null);
    expect(store.getState().attachments[0]?.status).toBe("ready");
    authorityId = "22222222-2222-4222-8222-222222222222";
    await store.init(null);
    expect(store.getState().attachments[0]).toMatchObject({
      status: "error",
      error: expect.stringContaining("Host restarted"),
    });
    await store.sendPrompt("send");
    expect(prompt).not.toHaveBeenCalled();
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

describe("Pi native command dispatch", () => {
  beforeEach(() => installFakeWebSocket());

  it.each(["compact", "export", "reload"])(
    "shows /%s running without invented progress guidance",
    async (command) => {
      const native = deferred<RouteResponse>();
      installFetch((url, init) => {
        if (url.startsWith("/api/control/native-command"))
          return native.promise;
        return baseRoutes(url, init);
      });
      const { store } = await initStore();

      await store.sendPrompt(`/${command}`);
      expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
        command,
        status: "running",
        message: "",
      });

      native.resolve({
        body: { command, outcome: "completed", message: "Host result" },
      });
      await vi.waitFor(() =>
        expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
          status: "success",
          message: "Host result",
        }),
      );
    },
  );

  it("routes host commands away from the model and retains their result", async () => {
    const nativeBodies: Record<string, unknown>[] = [];
    let promptCount = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/control/native-command")) {
        nativeBodies.push(jsonBody(init));
        return {
          body: {
            command: "compact",
            outcome: "completed",
            message: "Context compacted from 12,640 to about 4,200 tokens.",
            details: [
              { label: "Before", value: "12,640 tokens" },
              { label: "After (estimate)", value: "4,200 tokens" },
            ],
          },
        };
      }
      if (url.startsWith("/api/prompt")) {
        promptCount += 1;
        return { status: 202, body: { accepted: true } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await expect(
      store.sendPrompt("/compact focus on decisions"),
    ).resolves.toEqual({ accepted: true, historyEntry: null });
    await vi.waitFor(() =>
      expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
        command: "compact",
        status: "success",
        message: "Context compacted from 12,640 to about 4,200 tokens.",
      }),
    );
    expect(nativeBodies).toEqual([
      {
        sessionId: "s1",
        command: "compact",
        argument: "focus on decisions",
      },
    ]);
    expect(promptCount).toBe(0);
  });

  it("routes /bug to explicit terminal guidance without uploading or prompting", async () => {
    let dispatchCount = 0;
    installFetch((url, init) => {
      if (
        url.startsWith("/api/prompt") ||
        url.startsWith("/api/control/native-command")
      )
        dispatchCount += 1;
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await expect(
      store.sendPrompt("/bug unexpected response"),
    ).resolves.toMatchObject({ accepted: true });
    expect(dispatchCount).toBe(0);
    expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
      command: "bug",
      status: "warning",
      action: {
        kind: "open-terminal",
        value: "/bug unexpected response",
      },
    });
  });

  it("keeps an RPC acceptance-unknown Host result non-retryable", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/control/native-command"))
        return {
          status: 504,
          body: {
            error: "Pi export outcome is unknown",
            code: "PI_RPC_OUTCOME_UNKNOWN",
          },
        };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await expect(store.sendPrompt("/export")).resolves.toMatchObject({
      accepted: true,
    });
    await vi.waitFor(() =>
      expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
        command: "export",
        status: "warning",
        message: expect.stringContaining("could not confirm"),
      }),
    );
  });

  it("does not evict an in-flight Host receipt from bounded command history", async () => {
    const native = deferred<RouteResponse>();
    installFetch((url, init) => {
      if (url.startsWith("/api/control/native-command")) return native.promise;
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await store.sendPrompt("/compact");
    await store.sendPrompt("/session");
    await store.sendPrompt("/hotkeys");
    await store.sendPrompt("/quit");
    await store.sendPrompt("/share");

    expect(store.getState().commandActivities.s1).toHaveLength(4);
    expect(store.getState().commandActivities.s1).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "compact", status: "running" }),
        expect.objectContaining({
          command: "share",
          status: "warning",
          details: [{ label: "Run in Pi", value: "/share" }],
          action: {
            kind: "open-terminal",
            label: "Open terminal & copy command",
            value: "/share",
          },
        }),
      ]),
    );

    native.resolve({
      body: {
        command: "compact",
        outcome: "completed",
        message: "Context compacted.",
      },
    });
    await vi.waitFor(() =>
      expect(store.getState().commandActivities.s1).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ command: "compact", status: "success" }),
        ]),
      ),
    );
  });

  it("reserves built-in names while retaining namespaced runtime commands", async () => {
    const promptBodies: Record<string, unknown>[] = [];
    let nativeCount = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/control/native-command")) {
        nativeCount += 1;
        return { status: 202, body: { accepted: true } };
      }
      if (url.startsWith("/api/prompt")) {
        promptBodies.push(jsonBody(init));
        return { status: 202, body: { accepted: true } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        commands: [
          {
            name: "model",
            description: "Extension-owned model command",
            source: "extension",
          },
          { name: "plugin:model", source: "extension" },
        ],
      }),
    });

    expect(store.isNativeCommand("/model custom")).toBe(true);
    await expect(store.sendPrompt("/model custom")).resolves.toMatchObject({
      accepted: true,
    });
    await expect(store.sendPrompt("/model\tcustom")).resolves.toMatchObject({
      accepted: true,
    });
    expect(promptBodies).toHaveLength(0);
    expect(store.getState().nativeCommandUiRequest).toMatchObject({
      action: "model",
      query: "custom",
    });
    await store.sendPrompt("/plugin:model\tcustom");
    expect(promptBodies).toHaveLength(1);
    expect(promptBodies.at(-1)).toMatchObject({
      sessionId: "s1",
      message: "/plugin:model custom",
    });
    expect(nativeCount).toBe(0);
  });

  it("keeps unknown slash input out of model delivery", async () => {
    let promptCount = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/prompt")) {
        promptCount += 1;
        return { status: 202, body: { accepted: true } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await expect(store.sendPrompt("/does-not-exist")).resolves.toBe(false);
    await expect(store.sendPrompt("/MODEL")).resolves.toBe(false);
    expect(promptCount).toBe(0);
    expect(store.getState().commandActivities.s1).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "does-not-exist",
          status: "error",
        }),
      ]),
    );
  });

  it("declines state-changing native commands while Pi is busy", async () => {
    let nativeCount = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/control/native-command")) {
        nativeCount += 1;
        return {
          body: {
            command: "compact",
            outcome: "completed",
            message: "Context compacted.",
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const running = activeSnapshot();
    running.runState = "running";
    running.sessionStatuses.s1 = { runState: "running" };
    socket.emit({ type: "snapshot", data: running });

    await expect(store.sendPrompt("/compact")).resolves.toEqual({
      accepted: true,
      historyEntry: null,
    });
    expect(nativeCount).toBe(0);
    expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
      command: "compact",
      status: "warning",
      message: expect.stringContaining("Wait for the current Pi operation"),
    });
  });

  it("keeps local controls and live model/thinking/export available during Pi work", async () => {
    let exports = 0;
    let modelChanges = 0;
    let thinkingChanges = 0;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    installFetch((url, init) => {
      if (url.startsWith("/api/transcript/assistant-text"))
        return { body: { text: "last settled answer" } };
      if (url.startsWith("/api/control/model")) {
        modelChanges += 1;
        return { body: { ok: true } };
      }
      if (url.startsWith("/api/control/thinking")) {
        thinkingChanges += 1;
        return { body: { ok: true } };
      }
      if (url.startsWith("/api/control/native-command")) {
        exports += 1;
        return {
          body: {
            command: "export",
            outcome: "completed",
            message: "Exported.",
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const running = activeSnapshot();
    running.runState = "running";
    running.sessionStatuses.s1 = { runState: "running" };
    socket.emit({ type: "snapshot", data: running });
    await store.sendPrompt("/settings");
    expect(store.getState().nativeCommandUiRequest?.action).toBe("settings");
    await store.sendPrompt("/session");
    expect(store.getState().commandActivities.s1?.at(-1)?.command).toBe(
      "session",
    );
    await store.sendPrompt("/copy");
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("last settled answer"),
    );
    await store.sendPrompt("/model");
    expect(store.getState().nativeCommandUiRequest?.action).toBe("model");
    await store.sendPrompt("/thinking");
    expect(store.getState().nativeCommandUiRequest?.action).toBe("thinking");
    await store.sendPrompt("/model no-exact-match");
    expect(store.getState().nativeCommandUiRequest?.action).toBe("model");
    expect(store.getState().commandActivities.s1?.at(-1)?.command).not.toBe(
      "model",
    );
    await store.sendPrompt("/model kimi-coding/kimi-k3");
    await store.sendPrompt("/thinking low");
    await vi.waitFor(() => {
      expect(modelChanges).toBe(1);
      expect(thinkingChanges).toBe(1);
    });
    await store.sendPrompt("/export");
    await vi.waitFor(() => expect(exports).toBe(1));
  });

  it("updates Pi delivery and resilience settings through typed controls", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let runtimeSettings: PiRuntimeSettings = {
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      steeringMode: "all",
      followUpMode: "one-at-a-time",
    };
    installFetch((url, init) => {
      if (url.startsWith("/api/control/")) {
        const body = jsonBody(init);
        requests.push({ path: url, body });
        runtimeSettings = {
          ...runtimeSettings,
          ...(url.endsWith("auto-compaction")
            ? { autoCompactionEnabled: body.enabled as boolean }
            : url.endsWith("auto-retry")
              ? { autoRetryEnabled: body.enabled as boolean }
              : url.endsWith("steering-mode")
                ? { steeringMode: body.mode as "all" | "one-at-a-time" }
                : { followUpMode: body.mode as "all" | "one-at-a-time" }),
        };
        return { body: { ok: true } };
      }
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({ runtimeSettings }),
          }),
        };
      if (url.startsWith("/api/snapshot"))
        return { body: activeSnapshot({ runtimeSettings }) };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await store.setAutoCompaction(false);
    await store.setAutoRetry(false);
    await store.setSteeringMode("one-at-a-time");
    await store.setFollowUpMode("all");

    expect(requests.map(({ path }) => path)).toEqual([
      "/api/control/auto-compaction",
      "/api/control/auto-retry",
      "/api/control/steering-mode",
      "/api/control/follow-up-mode",
    ]);
    expect(store.getState().runtimeSettings).toEqual({
      autoCompactionEnabled: false,
      autoRetryEnabled: false,
      steeringMode: "one-at-a-time",
      followUpMode: "all",
    });
  });

  it.each([
    ["autoRetryEnabled", "setAutoRetry", false, true],
    ["autoCompactionEnabled", "setAutoCompaction", false, true],
    ["steeringMode", "setSteeringMode", "all", "one-at-a-time"],
    ["followUpMode", "setFollowUpMode", "all", "one-at-a-time"],
  ] as const)(
    "does not let an old %s failure roll back a newer success",
    async (key, method, initial, next) => {
      const runtimeSettings: PiRuntimeSettings = {
        autoCompactionEnabled: false,
        autoRetryEnabled: false,
        steeringMode: "all",
        followUpMode: "all",
      };
      const requests = [
        deferred<RouteResponse>(),
        deferred<RouteResponse>(),
        deferred<RouteResponse>(),
      ];
      let index = 0;
      installFetch((url, init) => {
        if (url.startsWith("/api/control/")) return requests[index++]!.promise;
        if (url.startsWith("/api/bootstrap"))
          return {
            body: bootstrapPayload({
              snapshot: activeSnapshot({
                runtimeSettings: { ...runtimeSettings },
              }),
            }),
          };
        if (url.startsWith("/api/snapshot"))
          return {
            body: activeSnapshot({ runtimeSettings: { ...runtimeSettings } }),
          };
        return baseRoutes(url, init);
      });
      const { store } = await initStore();
      const set = store[method] as (
        value: typeof initial | typeof next,
      ) => Promise<boolean>;
      const a = set(next);
      const b = set(initial);
      const c = set(next);
      Object.assign(runtimeSettings, { [key]: next });
      requests[1]!.resolve({ body: { ok: true } });
      requests[2]!.resolve({ body: { ok: true } });
      await Promise.all([b, c]);
      requests[0]!.resolve({ status: 400, body: { error: "old failure" } });
      expect(await a).toBe(false);
      expect(store.getState().runtimeSettings?.[key]).toBe(next);
    },
  );

  it("reconciles a failed latest setting instead of trusting an optimistic predecessor", async () => {
    const runtimeSettings: PiRuntimeSettings = {
      autoCompactionEnabled: false,
      autoRetryEnabled: false,
      steeringMode: "all",
      followUpMode: "all",
    };
    const requests = [deferred<RouteResponse>(), deferred<RouteResponse>()];
    let index = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/control/")) return requests[index++]!.promise;
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({ runtimeSettings }),
          }),
        };
      if (url.startsWith("/api/snapshot"))
        return { body: activeSnapshot({ runtimeSettings }) };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    const a = store.setAutoRetry(true);
    const b = store.setAutoRetry(false);
    requests[0]!.resolve({ status: 400, body: { error: "first failed" } });
    await a;
    requests[1]!.resolve({ status: 400, body: { error: "second failed" } });
    await b;
    await vi.waitFor(() =>
      expect(store.getState().runtimeSettings?.autoRetryEnabled).toBe(false),
    );
  });

  it("copies the complete Host response instead of the truncated or live preview", async () => {
    const fullText = `${"x".repeat(70_000)}THE_END_42\n`;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    let copyUrl = "";
    installFetch((url, init) => {
      if (url.startsWith("/api/transcript/assistant-text")) {
        copyUrl = url;
        return { body: { text: fullText } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        pageMessages: [
          {
            role: "assistant",
            content: `${fullText.slice(0, 64_000)}\n…[truncated]`,
          },
          {
            role: "assistant",
            content: "unfinished response",
            __inspireLiveId: "live-1",
            __inspireSettled: false,
          },
        ],
      }),
    });

    await expect(store.sendPrompt("/copy")).resolves.toMatchObject({
      accepted: true,
    });
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(fullText));
    await vi.waitFor(() =>
      expect(
        store
          .getState()
          .commandActivities.s1?.some(
            (activity) => activity.command === "copy",
          ),
      ).toBeFalsy(),
    );
    expect(store.getState().notices.at(-1)?.text).toContain(
      "Copied the complete",
    );
    const query = new URL(copyUrl, "http://localhost").searchParams;
    expect(query.get("sessionId")).toBe("s1");
    expect(query.get("viewId")).toBe(store.getState().transcriptViewId);
  });

  it("does not write delayed copy content after a branch change", async () => {
    const response = deferred<RouteResponse>();
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    installFetch((url, init) =>
      url.startsWith("/api/transcript/assistant-text")
        ? response.promise
        : baseRoutes(url, init),
    );
    const { store, socket } = await initStore();
    await store.sendPrompt("/copy");
    const snapshot = activeSnapshot();
    snapshot.active!.transcriptPage.viewId = "another-branch";
    socket.emit({ type: "snapshot", data: snapshot });
    response.resolve({ body: { text: "old branch" } });
    await vi.waitFor(() =>
      expect(store.getState().commandActivities.s1?.at(-1)?.status).toBe(
        "error",
      ),
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each([
    ["/model kimi-coding/kimi-k3", "/api/control/model", "model"],
    ["/thinking low", "/api/control/thinking", "thinking"],
    ["/name New session", "/api/sessions/rename", "name"],
  ] as const)(
    "%s keeps successful confirmation transient and retains one real failure",
    async (command, route, name) => {
      let fail = false;
      installFetch((url, init) => {
        if (url.startsWith(route))
          return fail
            ? { status: 400, body: { error: `Pi rejected ${name}` } }
            : { body: { ok: true } };
        return baseRoutes(url, init);
      });
      const { store } = await initStore();

      await store.sendPrompt(command);
      await vi.waitFor(() =>
        expect(
          store
            .getState()
            .commandActivities.s1?.some((item) => item.command === name),
        ).toBeFalsy(),
      );
      expect(store.getState().notices.at(-1)?.kind).toBe("info");

      fail = true;
      const noticeCount = store.getState().notices.length;
      await store.sendPrompt(command);
      await vi.waitFor(() =>
        expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
          command: name,
          status: "error",
          message: `Pi rejected ${name}`,
        }),
      );
      expect(store.getState().notices).toHaveLength(noticeCount);
    },
  );

  it("keeps a delayed command failure in its original session without notifying the new one", async () => {
    const response = deferred<RouteResponse>();
    installFetch((url, init) =>
      url.startsWith("/api/control/model")
        ? response.promise
        : baseRoutes(url, init),
    );
    const { store, socket } = await initStore();
    await store.sendPrompt("/model kimi-coding/kimi-k3");
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2" }),
    });
    const notices = store.getState().notices.length;
    response.resolve({ status: 400, body: { error: "Provider denied model" } });
    await vi.waitFor(() =>
      expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
        command: "model",
        status: "error",
        message: "Provider denied model",
      }),
    );
    expect(store.getState().notices).toHaveLength(notices);
  });

  it("executes browser-native model and session information commands", async () => {
    const modelBodies: Record<string, unknown>[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/control/model")) {
        modelBodies.push(jsonBody(init));
        return { body: { ok: true } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await expect(
      store.sendPrompt("/model kimi-coding/kimi-k3"),
    ).resolves.toEqual({
      accepted: true,
      historyEntry: null,
    });
    await vi.waitFor(() => expect(modelBodies).toHaveLength(1));
    await vi.waitFor(() =>
      expect(
        store
          .getState()
          .commandActivities.s1?.some(
            (activity) => activity.command === "model",
          ),
      ).toBeFalsy(),
    );
    expect(store.getState().notices.at(-1)?.text).toContain(
      "Active model is now",
    );
    await store.sendPrompt("/session");

    expect(modelBodies[0]).toEqual({
      sessionId: "s1",
      provider: "kimi-coding",
      modelId: "kimi-k3",
    });
    expect(store.getState().commandActivities.s1?.at(-1)).toMatchObject({
      command: "session",
      status: "info",
      details: expect.arrayContaining([
        expect.objectContaining({ label: "Project" }),
        expect.objectContaining({ label: "Model" }),
      ]),
    });
  });
});
