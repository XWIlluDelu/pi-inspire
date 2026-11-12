// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSessionDraft } from "../../src/session-drafts";
import { AppStore } from "../../src/store";
import {
  activeSnapshot,
  branchTree,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  jsonBody,
  type RouteHandler,
  type RouteResponse,
} from "./helpers";
import { installStoreRoutes } from "./store-fixture";

async function setup(route: RouteHandler) {
  installStoreRoutes(route);
  const store = new AppStore();
  await store.init();
  (store as unknown as { set(value: unknown): void }).set({
    branchTree: branchTree(),
  });
  return store;
}

function moveView(store: AppStore, viewId = "view-2"): void {
  const snapshot = activeSnapshot({
    transcriptPage: {
      revision: 2,
      viewId,
      appendFromRevision: 2,
      effectiveLeafId: "u1",
      messages: [],
    },
    effectiveLeafId: "u1",
  });
  (
    store as unknown as { applySnapshot(snapshot: unknown): void }
  ).applySnapshot(snapshot);
}

function advanceLeaf(store: AppStore) {
  // An append advances the effective leaf without replacing the view.
  (
    store as unknown as { applySnapshot(snapshot: unknown): void }
  ).applySnapshot(
    activeSnapshot({
      effectiveLeafId: "a2",
      transcriptPage: { revision: 2, effectiveLeafId: "a2" },
    }),
  );
}

describe("branch request view ownership", () => {
  it("discards a complete-content copy when its source view changes during image loading", async () => {
    const image = deferred<RouteResponse>();
    const store = await setup((url) => {
      if (url.startsWith("/api/branches/entry"))
        return {
          body: {
            sessionId: "s1",
            revision: 1,
            node: branchTree().nodes[0],
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
    moveView(store);
    image.resolve({ body: "saved pixels" });
    expect(await copy).toBeNull();
  });

  beforeEach(() => {
    installFakeWebSocket();
    for (const id of ["s1", "s2", "forked"]) deleteSessionDraft(id);
  });
  afterEach(() => vi.useRealTimers());

  it("retires History reads and withdraws late Fork attachments after switching sessions", async () => {
    const fork = deferred<RouteResponse>();
    const history = deferred<RouteResponse>();
    const deletes: string[] = [];
    const store = await setup((url, init) => {
      if (url === "/api/branches/fork") return fork.promise;
      if (url.startsWith("/api/branches/tree")) return history.promise;
      if (url === "/api/sessions/open")
        return { body: activeSnapshot({ sessionId: "s2" }) };
      if (init.method === "DELETE") {
        deletes.push(url);
        return { body: { ok: true } };
      }
      return undefined;
    });
    const reading = store.loadBranchTree();
    const forking = store.forkBranch("u1");
    expect(store.getState()).toMatchObject({
      branchTreeLoading: true,
      branchActionId: "fork:u1",
    });
    await store.openSession("s2");
    history.resolve({ body: { ...branchTree(), revision: 99 } });
    fork.resolve({
      body: {
        sessionId: "forked",
        snapshot: activeSnapshot({ sessionId: "forked" }),
        editorText: "old",
        editorAttachments: [{ id: "old-image" }],
      },
    });
    await reading;
    await expect(forking).resolves.toBe(false);
    expect(deletes).toEqual(["/api/attachments/old-image"]);
    expect(store.getState()).toMatchObject({
      sessionId: "s2",
      branchTree: null,
      branchTreeLoading: false,
      branchTreeError: null,
      attachments: [],
    });
  });

  it.each(["success", "failure"] as const)(
    "renews a tree read made stale by an ordinary append (%s)",
    async (outcome) => {
      const pending = deferred<RouteResponse | undefined>();
      let treeReads = 0;
      const store = await setup((url) => {
        if (!url.startsWith("/api/branches/tree")) return undefined;
        treeReads += 1;
        return treeReads === 1
          ? pending.promise
          : { body: { ...branchTree(), effectiveLeafId: "a2", revision: 2 } };
      });
      FakeWebSocket.instances.at(-1)!.open();
      vi.useFakeTimers();
      const loading = store.loadBranchTree();
      advanceLeaf(store);
      pending.resolve(
        outcome === "success"
          ? { body: branchTree() }
          : { status: 503, body: { error: "Old tree failed" } },
      );
      await loading;
      expect(store.getState().branchTree?.revision).toBe(1);
      expect(store.getState()).toMatchObject({
        branchTreeLoading: false,
        branchTreeError: null,
        branchTreeStale: true,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(treeReads).toBe(2);
      expect(store.getState().branchTree?.revision).toBe(2);
      expect(store.getState()).toMatchObject({
        branchTreeLoading: false,
        branchTreeError: null,
        branchTreeStale: false,
      });
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
      const store = await setup((url) =>
        url.startsWith(`/api/branches/${kind}`) ? pending.promise : undefined,
      );
      const acting =
        kind === "navigate"
          ? store.navigateBranch("a1", "switch")
          : store.forkBranch("u1");
      if (change === "view") moveView(store);
      else advanceLeaf(store);
      pending.resolve({ status: 409, body: { error: "Source changed" } });
      await expect(acting).resolves.toBe(false);
      expect(store.getState().branchActionId).toBeNull();
      // Navigation owns the original leaf; independent copying survives an
      // append, so its failure retains the server diagnostic.
      if (kind === "navigate") {
        expect(store.getState().branchTreeError).toBeNull();
        expect(store.getState().branchTreeStale).toBe(true);
      } else expect(store.getState().branchTreeError).toBe("Source changed");
      expect(store.getState().sessionId).toBe("s1");
      expect(store.getState().transcriptEffectiveLeafId).toBe(
        change === "view" ? "u1" : "a2",
      );
      expect(store.getState().branchTree?.revision).toBe(1);
    },
  );

  it.each(["fork", "clone"] as const)(
    "keeps a %s target when the source appends without replacing its view",
    async (mode) => {
      const response = deferred<RouteResponse>();
      let request: Record<string, unknown> | undefined;
      let treeReads = 0;
      const store = await setup((url, init) => {
        if (url.startsWith("/api/branches/tree")) treeReads += 1;
        if (url === `/api/branches/${mode}`) {
          request = jsonBody(init);
          return response.promise;
        }
      });
      const internal = store as unknown as {
        applySnapshot(snapshot: unknown): void;
      };
      internal.applySnapshot(
        activeSnapshot({
          effectiveLeafId: "a1",
          transcriptPage: { effectiveLeafId: "a1" },
        }),
      );
      const copying =
        mode === "fork"
          ? store.forkFromEntry("u1")
          : store.cloneCurrentBranch();
      advanceLeaf(store);
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
      expect(treeReads).toBe(0);
      expect(store.getState().sessionId).toBe("forked");
    },
  );

  it("ignores delayed fork success after reconnect invalidates ownership", async () => {
    const fork = deferred<RouteResponse | undefined>();
    const store = await setup((url) => {
      if (url.startsWith("/api/branches/fork")) return fork.promise;
      return undefined;
    });
    const forking = store.forkBranch("u1");
    FakeWebSocket.instances.at(-1)!.onclose?.();
    fork.resolve({
      body: {
        sessionId: "forked",
        snapshot: activeSnapshot({ sessionId: "forked" }),
        editorText: "old",
      },
    });
    await expect(forking).resolves.toBe(false);
    expect(store.getState().sessionId).toBe("s1");
    expect(store.getState().branchActionId).toBeNull();
  });

  it.each([
    ["tree", "view"],
    ["tree", "transport"],
    ["fork", "transport"],
  ] as const)(
    "scopes a delayed branch %s 401 after replacing its %s",
    async (kind, changed) => {
      const pending = deferred<RouteResponse | undefined>();
      const store = await setup((url) =>
        url.startsWith(`/api/branches/${kind}`) ? pending.promise : undefined,
      );
      const request =
        kind === "tree" ? store.loadBranchTree() : store.forkBranch("u1");
      if (changed === "view") moveView(store);
      else await store.init();
      pending.resolve({ status: 401, body: { error: "Unauthorized" } });
      await request;
      if (changed === "view")
        expect(store.getState()).toMatchObject({
          needsToken: true,
          connection: "offline",
          error: null,
        });
      else expect(store.getState().needsToken).toBe(false);
    },
  );

  it("keeps a failed selection's error when an older branch action also fails", async () => {
    const branch = deferred<RouteResponse>();
    const store = await setup((url) => {
      if (url === "/api/branches/navigate") return branch.promise;
      if (url === "/api/sessions/open")
        return { status: 500, body: { error: "selection failed" } };
    });
    const navigating = store.navigateBranch("a1", "switch");
    const selection = store.openSession("s2");
    expect(store.getState()).toMatchObject({
      branchActionId: null,
      branchTreeStale: true,
    });
    await selection;
    branch.resolve({ status: 500, body: { error: "obsolete branch failure" } });
    await expect(navigating).resolves.toBe(false);

    expect(store.getState()).toMatchObject({
      sessionId: "s1",
      branchActionId: null,
      branchTreeStale: true,
      branchTreeError: null,
      error: null,
      sessionActionError: "selection failed",
    });
  });
});
