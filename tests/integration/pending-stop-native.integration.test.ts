// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { BootstrapResponse } from "../../shared/contracts";
import { sessionDraft, setSessionDraft } from "../../src/session-drafts";
import { AppStore } from "../../src/store";
import {
  disposeOperationFixture,
  fixture,
} from "../server/fixtures/native-operation";
import { deferred, FakeWebSocket, installFakeWebSocket } from "../web/helpers";

it("shares concurrent Stop requests and reclaims both lost handoffs while stopping a later native run", async () => {
  const browserWindow = window;
  const gate = deferred<void>();
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let store: AppStore | undefined;
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  try {
    f = await fixture(false, 35_000, gate.promise);
    vi.stubGlobal("window", browserWindow);
    installFakeWebSocket();
    const bridge = fetch;
    let bootstrap!: BootstrapResponse;
    let receiptsUnavailable = true;
    const recoverPath = "/api/pending/recover";
    const stopPath = "/api/control/abort";
    const lostPosts = new Set([recoverPath, stopPath]);
    const posts: Array<{ path: string; operationId: string }> = [];
    const before = "Queued before Return";
    const between = "Queued between Return and Stop";
    vi.stubGlobal("fetch", (async (input, init) => {
      const url = String(input);
      if (url === stopPath && lostPosts.has(url)) {
        await f!.api.prompt({ ...f!.delivery(between), behavior: "followUp" });
      }
      const response = await bridge(input, init);
      if (url.startsWith("/api/bootstrap"))
        bootstrap = await response.clone().json();
      if (url === stopPath || url === recoverPath) {
        const { operationId, sessionId, authorityId } = JSON.parse(
          String(init?.body),
        );
        expect(sessionId).toBe(f!.sessionId);
        expect(authorityId).toBe(f!.application.authorityId);
        posts.push({ path: url, operationId });
        if (lostPosts.delete(url))
          throw new TypeError("lost Pending mutation response");
      }
      if (url.startsWith("/api/pending/operations/") && receiptsUnavailable)
        throw new TypeError("Pending receipt unavailable");
      return response;
    }) satisfies typeof fetch);
    store = new AppStore();
    await store.init();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.readyState = 1;
    socket.onopen?.({});
    socket.emit({
      type: "snapshot",
      authorityId: bootstrap.authorityId,
      snapshotDigest: bootstrap.snapshotDigest,
      data: bootstrap.snapshot,
    });
    listener = (event) => socket.emit(event);
    f.runtime.on("event", listener);
    await f.api.prompt(f.delivery("First isolated run"));
    await vi.waitFor(() => expect(f!.modelRequests).toHaveLength(1));
    const bytes = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64",
    );
    const image = await f.attachments.add({
      originalname: "queued.gif",
      mimetype: "image/gif",
      size: bytes.length,
      buffer: bytes,
    } as Express.Multer.File);
    await f.api.prompt({
      ...f.delivery(before),
      behavior: "steer",
      attachmentIds: [image.id],
    });
    setSessionDraft(f.sessionId, "newer draft");
    await Promise.all([store.abort(), store.abort()]);
    await vi.waitFor(() => expect(store!.getState().runState).toBe("aborted"));
    expect(sessionDraft(f.sessionId)).toBe("newer draft");
    expect(store.getState().notices).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("Pending recovery failed"),
      }),
    );
    expect(posts.map(({ path }) => path)).toEqual([recoverPath, stopPath]);
    receiptsUnavailable = false;
    await f.api.prompt(f.delivery("Second isolated run"));
    await vi.waitFor(() => expect(f!.modelRequests).toHaveLength(2));
    expect(store.getState().runState).toBe("running");
    await store.abort();
    await vi.waitFor(async () =>
      expect((await f!.runtime.snapshot()).runState).toBe("aborted"),
    );
    await vi.waitFor(() => {
      const draft = sessionDraft(f!.sessionId).split("\n\n");
      expect(draft.pop()).toBe("newer draft");
      expect(draft.sort()).toEqual([before, between].sort());
      expect(
        store!.getState().attachments.map(({ uploadedId }) => uploadedId),
      ).toEqual([image.id]);
    });
    expect(posts.map(({ path }) => path)).toEqual([
      recoverPath,
      stopPath,
      recoverPath,
      stopPath,
    ]);
    expect(new Set(posts.map(({ operationId }) => operationId)).size).toBe(4);
    expect(store.getState().connection).toBe("open");
    expect(
      f.piEvents.filter(
        (event) => event.type === "agent_settled" && event.aborted === true,
      ),
    ).toHaveLength(2);
  } finally {
    if (f && listener) f.runtime.off("event", listener);
    (
      store as unknown as { connectionController: { stop(): void } } | undefined
    )?.connectionController.stop();
    gate.resolve();
    await disposeOperationFixture();
  }
}, 30_000);
