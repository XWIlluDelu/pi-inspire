// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { AppStore } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  branchTree,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  type RouteResponse,
} from "./helpers";

async function setup(
  route: (
    url: string,
  ) => Promise<RouteResponse | undefined> | RouteResponse | undefined,
) {
  installFetch(async (url) => {
    if (url.startsWith("/api/bootstrap"))
      return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
    if (url.startsWith("/api/sessions?"))
      return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
    return route(url);
  });
  const store = new AppStore();
  await store.init("token");
  (store as unknown as { set(value: unknown): void }).set({
    branchTree: branchTree(),
  });
  return store;
}

function moveView(store: AppStore, viewId = "view-2"): void {
  const snapshot = activeSnapshot({
    transcriptPage: {
      sessionId: "s1",
      revision: 2,
      viewId,
      incarnation: "projection-1",
      appendFromRevision: 2,
      effectiveLeafId: "u1",
      messages: [],
      hasOlder: false,
      olderCursor: null,
    },
    effectiveLeafId: "u1",
  });
  (
    store as unknown as { applySnapshot(snapshot: unknown): void }
  ).applySnapshot(snapshot);
}

describe("branch request view ownership", () => {
  beforeEach(() => installFakeWebSocket());

  it("ignores a delayed tree success after a same-session view transition", async () => {
    const pending = deferred<RouteResponse | undefined>();
    const store = await setup((url) =>
      url.startsWith("/api/branches/tree") ? pending.promise : undefined,
    );
    const loading = store.loadBranchTree();
    moveView(store);
    pending.resolve({ body: { ...branchTree(), revision: 99 } });
    await loading;
    expect(store.getState().branchTree?.revision).toBe(1);
    expect(store.getState().branchTreeError).toMatch(/stale/);
    expect(store.getState().branchTreeLoading).toBe(false);
  });

  it("ignores a delayed navigation error after a same-session view transition", async () => {
    const pending = deferred<RouteResponse | undefined>();
    const store = await setup((url) =>
      url.startsWith("/api/branches/navigate") ? pending.promise : undefined,
    );
    const navigating = store.navigateBranch("a1", "switch");
    moveView(store);
    pending.resolve({ status: 500, body: { error: "old view failed" } });
    await expect(navigating).resolves.toBe(false);
    expect(store.getState().error).not.toBe("old view failed");
    expect(store.getState().branchTreeError).toMatch(/stale/);
    expect(store.getState().branchActionId).toBeNull();
  });

  it("forks a transcript input only after refreshing tree capability and revision", async () => {
    let treeReads = 0;
    let forks = 0;
    const store = await setup((url) => {
      if (url.startsWith("/api/branches/tree")) {
        treeReads += 1;
        return { body: branchTree() };
      }
      if (url.startsWith("/api/branches/fork")) {
        forks += 1;
        return {
          body: {
            sessionId: "forked",
            snapshot: activeSnapshot({ sessionId: "forked" }),
            editorText: "user",
          },
        };
      }
      return undefined;
    });

    await expect(store.forkFromEntry("u1")).resolves.toBe(true);
    expect(treeReads).toBe(1);
    expect(forks).toBe(1);
    expect(store.getState().sessionId).toBe("forked");
  });

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

  it.each(["tree", "navigate", "fork"] as const)(
    "suppresses a delayed branch %s 401 only after the auth transport is genuinely replaced",
    async (kind) => {
      const pending = deferred<RouteResponse | undefined>();
      const store = await setup((url) =>
        url.startsWith(`/api/branches/${kind}`) ? pending.promise : undefined,
      );
      const request =
        kind === "tree"
          ? store.loadBranchTree()
          : kind === "navigate"
            ? store.navigateBranch("a1", "switch")
            : store.forkBranch("u1");
      await store.init("replacement-token");
      pending.resolve({
        status: 401,
        body: { error: "expired old transport" },
      });
      await request;
      expect(store.getState().needsToken).toBe(false);
    },
  );

  it.each(["tree", "navigate", "fork"] as const)(
    "honors a delayed branch %s 401 after a view transition on the current transport",
    async (kind) => {
      const pending = deferred<RouteResponse | undefined>();
      const store = await setup((url) =>
        url.startsWith(`/api/branches/${kind}`) ? pending.promise : undefined,
      );
      const request =
        kind === "tree"
          ? store.loadBranchTree()
          : kind === "navigate"
            ? store.navigateBranch("a1", "switch")
            : store.forkBranch("u1");
      moveView(store);
      pending.resolve({
        status: 401,
        body: { error: "current transport unauthorized" },
      });
      await request;
      expect(store.getState()).toMatchObject({
        needsToken: true,
        connection: "offline",
        error: null,
      });
    },
  );

  it.each(["tree", "navigate", "fork"] as const)(
    "settles delayed branch %s ownership across failed and successful selection intents",
    async (kind) => {
      for (const selectionOutcome of ["failed", "successful"] as const) {
        const branch = deferred<RouteResponse | undefined>();
        const opening = deferred<RouteResponse | undefined>();
        const store = await setup((url) => {
          if (url.startsWith(`/api/branches/${kind}`)) return branch.promise;
          if (url.startsWith("/api/sessions/open")) return opening.promise;
          return undefined;
        });
        const branchRequest =
          kind === "tree"
            ? store.loadBranchTree()
            : kind === "navigate"
              ? store.navigateBranch("a1", "switch")
              : store.forkBranch("u1");
        const selection = store.openSession("s2");
        expect(store.getState()).toMatchObject({
          branchTreeLoading: false,
          branchActionId: null,
        });
        expect(store.getState().branchTreeError).toMatch(/stale/);

        if (selectionOutcome === "failed")
          opening.resolve({ status: 500, body: { error: "selection failed" } });
        else opening.resolve({ body: activeSnapshot({ sessionId: "s2" }) });
        await selection;
        branch.resolve(
          selectionOutcome === "failed"
            ? { status: 500, body: { error: "obsolete branch failure" } }
            : kind === "tree"
              ? { body: { ...branchTree(), revision: 99 } }
              : kind === "navigate"
                ? {
                    body: {
                      snapshot: activeSnapshot(),
                      editorText: "obsolete",
                    },
                  }
                : {
                    body: {
                      sessionId: "forked",
                      snapshot: activeSnapshot({ sessionId: "forked" }),
                      editorText: "obsolete",
                    },
                  },
        );
        await branchRequest;

        if (selectionOutcome === "failed") {
          expect(store.getState().sessionId).toBe("s1");
          expect(store.getState().branchTreeError).toMatch(/stale/);
          expect(store.getState().error).toBeNull();
          expect(store.getState().sessionActionError).toBe("selection failed");
        } else {
          expect(store.getState().sessionId).toBe("s2");
          expect(store.getState().branchTree).toBeNull();
          expect(store.getState().error).not.toBe("obsolete branch failure");
        }
        expect(store.getState()).toMatchObject({
          branchTreeLoading: false,
          branchActionId: null,
        });
      }
    },
  );

  it.each(["navigate", "fork"] as const)(
    "routes an owned branch %s 401 through auth loss",
    async (kind) => {
      const store = await setup((url) => {
        if (url.startsWith(`/api/branches/${kind}`))
          return { status: 401, body: { error: "unauthorized" } };
        return undefined;
      });
      if (kind === "navigate") await store.navigateBranch("a1", "switch");
      else await store.forkBranch("u1");
      expect(store.getState()).toMatchObject({
        needsToken: true,
        connection: "offline",
        error: null,
      });
    },
  );
});
