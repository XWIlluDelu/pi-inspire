// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeSnapshot,
  deferred,
  type FakeWebSocket,
  installFakeWebSocket,
  jsonBody,
  type RouteHandler,
  type RouteResponse,
  savedInputNode,
} from "./helpers";
import { initStore, installStoreRoutes } from "./store-fixture";

function setup(route: RouteHandler) {
  installStoreRoutes(route);
  return initStore();
}

function advanceView(socket: FakeWebSocket, change: "view" | "append") {
  const effectiveLeafId = change === "view" ? "u1" : "a2";
  socket.emitSnapshot(
    activeSnapshot({
      effectiveLeafId,
      transcriptPage: {
        revision: 2,
        effectiveLeafId,
        ...(change === "view"
          ? { viewId: "view-2", appendFromRevision: 2 }
          : {}),
      },
    }),
    { detailSessionId: "s1", detailRevision: 0 },
  );
}

describe("branch request view ownership", () => {
  beforeEach(installFakeWebSocket);

  it("discards a complete-content copy when its source view changes during image loading", async () => {
    const image = deferred<RouteResponse>();
    const { store, socket } = await setup((url) => {
      if (url.startsWith("/api/history?kind=entry&"))
        return {
          body: {
            sessionId: "s1",
            revision: 1,
            node: savedInputNode,
            text: "saved input",
            nextOffset: null,
            totalChars: 11,
            images: [{ index: 0, mimeType: "image/png" }],
          },
        };
      if (url.startsWith("/api/branches/image")) return image.promise;
    });
    const copy = store.branchCopyContent("u1", new AbortController().signal);
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/branches/image"),
        expect.anything(),
      ),
    );
    advanceView(socket, "view");
    image.resolve({ body: "saved pixels" });
    expect(await copy).toBeNull();
  });

  it.each(["selection", "disconnect"] as const)(
    "withdraws late Fork attachments after %s",
    async (boundary) => {
      const fork = deferred<RouteResponse>();
      const deletes: string[] = [];
      const { store, socket } = await setup((url, init) => {
        if (url === "/api/branches/fork") return fork.promise;
        if (url === "/api/sessions/open")
          return { body: activeSnapshot({ sessionId: "s2" }) };
        if (init.method === "DELETE") {
          deletes.push(url);
          return { body: { ok: true } };
        }
      });
      const forking = store.forkBranch("u1");
      expect(store.getState().branchActionId).toBe("fork:u1");
      if (boundary === "selection") await store.openSession("s2");
      else socket.onclose?.();
      fork.resolve({
        body: {
          sessionId: "forked",
          snapshot: activeSnapshot({ sessionId: "forked" }),
          editorText: "old",
          editorAttachments: [{ id: "old-image" }],
        },
      });
      await expect(forking).resolves.toBe(false);
      const sessionId = boundary === "selection" ? "s2" : "s1";
      expect(deletes).toEqual(["/api/attachments/old-image"]);
      expect(store.getState()).toMatchObject({
        sessionId,
        branchActionId: null,
        branchTreeError: null,
      });
      expect(store.drafts.get(sessionId).attachments).toEqual([]);
    },
  );

  it.each([
    { kind: "navigate", change: "append" },
    { kind: "navigate", change: "view" },
    { kind: "fork", change: "append" },
  ] as const)(
    "releases a failed $kind action after a source $change",
    async ({ kind, change }) => {
      const pending = deferred<RouteResponse | undefined>();
      const { store, socket } = await setup((url) =>
        url.startsWith(`/api/branches/${kind}`) ? pending.promise : undefined,
      );
      const acting =
        kind === "navigate"
          ? store.navigateBranch("a1", "switch")
          : store.forkBranch("u1");
      advanceView(socket, change);
      pending.resolve({ status: 409, body: { error: "Source changed" } });
      await expect(acting).resolves.toBe(false);
      expect(store.getState().branchActionId).toBeNull();
      // Navigation owns the original leaf; independent copying survives an
      // append, so its failure retains the server diagnostic.
      if (kind === "navigate") {
        expect(store.getState().branchTreeError).toBeNull();
      } else expect(store.getState().branchTreeError).toBe("Source changed");
      expect(store.getState().sessionId).toBe("s1");
      expect(store.getState().transcriptEffectiveLeafId).toBe(
        change === "view" ? "u1" : "a2",
      );
    },
  );

  it.each(["fork", "clone"] as const)(
    "keeps a %s target when the source appends without replacing its view",
    async (mode) => {
      const response = deferred<RouteResponse>();
      let request: Record<string, unknown> | undefined;
      const { store, socket } = await setup((url, init) => {
        if (url === `/api/branches/${mode}`) {
          request = jsonBody(init);
          return response.promise;
        }
      });
      socket.emitSnapshot(
        activeSnapshot({
          effectiveLeafId: "a1",
          transcriptPage: { effectiveLeafId: "a1" },
        }),
        { detailSessionId: "s1", detailRevision: 0 },
      );
      const copying =
        mode === "fork"
          ? store.forkFromEntry("u1")
          : store.cloneCurrentBranch();
      advanceView(socket, "append");
      response.resolve({
        body: {
          sessionId: "forked",
          snapshot: activeSnapshot({ sessionId: "forked" }),
          editorText: "",
        },
      });
      await expect(copying).resolves.toBe(true);
      expect(request).toEqual({
        sessionId: "s1",
        viewId: "view-s1",
        targetId: mode === "fork" ? "u1" : "a1",
      });
      expect(store.getState().sessionId).toBe("forked");
    },
  );

  it.each([
    ["history", "view"],
    ["history", "transport"],
    ["fork", "transport"],
  ] as const)(
    "retires a delayed branch %s 401 when its %s is replaced",
    async (kind, changed) => {
      const pending = deferred<RouteResponse | undefined>();
      const { store, socket } = await setup((url) =>
        url.startsWith(
          kind === "history"
            ? "/api/history?kind=page"
            : `/api/branches/${kind}`,
        )
          ? pending.promise
          : undefined,
      );
      const request =
        kind === "history"
          ? store.readNativeHistory(
              "s1",
              "view-s1",
              { kind: "page" },
              new AbortController().signal,
            )
          : store.forkBranch("u1");
      if (changed === "view") advanceView(socket, "view");
      else await store.init();
      pending.resolve({ status: 401, body: { error: "Unauthorized" } });
      await request;
      expect(store.getState().needsToken).toBe(false);
    },
  );

  it("keeps a failed selection's error when an older branch action also fails", async () => {
    const branch = deferred<RouteResponse>();
    const { store } = await setup((url) => {
      if (url === "/api/branches/navigate") return branch.promise;
      if (url === "/api/sessions/open")
        return { status: 500, body: { error: "selection failed" } };
    });
    const navigating = store.navigateBranch("a1", "switch");
    const selection = store.openSession("s2");
    expect(store.getState()).toMatchObject({
      branchActionId: null,
    });
    await selection;
    branch.resolve({ status: 500, body: { error: "obsolete branch failure" } });
    await expect(navigating).resolves.toBe(false);

    expect(store.getState()).toMatchObject({
      sessionId: "s1",
      branchActionId: null,
      branchTreeError: null,
      error: null,
      sessionActionError: "selection failed",
    });
  });
});
