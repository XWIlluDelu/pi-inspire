// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  activeSnapshot,
  deferred,
  installFakeWebSocket,
  type RouteHandler,
  type RouteResponse,
} from "./helpers";
import { initStore, installStoreRoutes } from "./store-fixture";

function setup(route: RouteHandler) {
  installStoreRoutes(route);
  return initStore();
}

describe("branch request view ownership", () => {
  beforeEach(installFakeWebSocket);

  it("withdraws late Fork attachments after disconnect", async () => {
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
    socket.onclose?.();
    fork.resolve({
      body: {
        sessionId: "forked",
        snapshot: activeSnapshot({ sessionId: "forked" }),
        editorText: "old",
        editorAttachments: [{ id: "old-image" }],
      },
    });
    await expect(forking).resolves.toBe(false);
    expect(deletes).toEqual(["/api/attachments/old-image"]);
    expect(store.getState()).toMatchObject({
      sessionId: "s1",
      branchActionId: null,
      branchTreeError: null,
    });
    expect(store.drafts.get("s1").attachments).toEqual([]);
  });

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
