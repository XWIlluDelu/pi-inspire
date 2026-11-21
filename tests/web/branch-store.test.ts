// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  activeSnapshot,
  deferred,
  installFakeWebSocket,
  jsonBody,
  selectSession,
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

  it.each(["disconnect", "reselect source"])(
    "withdraws late Fork attachments after %s",
    async (change) => {
      const fork = deferred<RouteResponse>();
      const deletes: string[] = [];
      const { store, socket } = await setup((url, init) => {
        if (url === "/api/branches/fork") return fork.promise;
        if (init.method === "DELETE") {
          deletes.push(url);
          return { body: { ok: true } };
        }
      });
      const forking = store.branches.fork("u1");
      expect(store.getState().branchActionId).toBe("fork:u1");
      if (change === "disconnect") socket.onclose?.();
      else {
        await selectSession(store, activeSnapshot({ sessionId: "s2" }));
        await selectSession(store, activeSnapshot());
      }
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
    },
  );

  it("keeps a failed selection's error when an older branch action also fails", async () => {
    const branch = deferred<RouteResponse>();
    const { store } = await setup((url) => {
      if (url === "/api/branches/navigate") return branch.promise;
      if (url === "/api/sessions/open")
        return { status: 500, body: { error: "selection failed" } };
    });
    const navigating = store.branches.navigate("a1", "switch");
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

  it("retains images across an append and applies authentication failure only to the current History view", async () => {
    const denied = deferred<RouteResponse>();
    const image = deferred<Response>();
    const { store, socket } = await setup((url) =>
      url.startsWith("/api/history?")
        ? denied.promise
        : url.startsWith("/api/branches/image?")
          ? image.promise
          : undefined,
    );
    const read = () =>
      store.branches.history("s1", store.getState().view.viewId!, {
        kind: "entry",
        targetId: "point",
      });
    const stale = read();
    const preview = store.branches.readImage("point", 1);
    socket.emitSnapshot(activeSnapshot({ effectiveLeafId: "appended" }));
    image.resolve(new Response("image"));
    expect(await (await preview)?.text()).toBe("image");
    socket.emitSnapshot(
      activeSnapshot({ transcriptPage: { viewId: "new-view" } }),
    );
    denied.resolve({ status: 401, body: { error: "Expired" } });
    await expect(stale).resolves.toBeNull();
    expect(store.getState().needsToken).toBe(false);
    await expect(read()).resolves.toBeNull();
    expect(store.getState().needsToken).toBe(true);
  });

  it.each(["append", "replacement"])(
    "retires navigation failure after %s",
    async (change) => {
      const result = deferred<RouteResponse>();
      const { store, socket } = await setup((url) =>
        url === "/api/branches/navigate" ? result.promise : undefined,
      );
      const navigation = store.branches.navigate("a1", "switch");
      socket.emitSnapshot(
        activeSnapshot(
          change === "append"
            ? { effectiveLeafId: "appended" }
            : { transcriptPage: { viewId: "replacement" } },
        ),
      );
      result.resolve({ status: 409, body: { error: "Source changed" } });
      await expect(navigation).resolves.toBe(false);
      expect(store.getState()).toMatchObject({
        branchActionId: null,
        branchTreeError: null,
      });
    },
  );

  it.each(["fork", "clone"] as const)(
    "opens a %s at its requested prefix after a live append",
    async (action) => {
      const result = deferred<RouteResponse>();
      const commands: unknown[] = [];
      let reply = result;
      const { store, socket } = await setup((url, init) => {
        if (url === `/api/branches/${action}`) {
          commands.push(jsonBody(init));
          return reply.promise;
        }
      });
      socket.emitSnapshot(activeSnapshot({ effectiveLeafId: "a1" }));
      const copying =
        action === "fork" ? store.branches.fork("u1") : store.branches.clone();
      socket.emitSnapshot(activeSnapshot({ effectiveLeafId: "a2" }));
      result.resolve({
        body: {
          sessionId: "forked",
          snapshot: activeSnapshot({ sessionId: "forked" }),
          editorText: "copied draft",
        },
      });
      await expect(copying).resolves.toBe(true);
      expect(commands).toEqual([
        {
          sessionId: "s1",
          viewId: "view-s1",
          targetId: action === "fork" ? "u1" : "a1",
        },
      ]);
      expect(store.getState().sessionId).toBe("forked");
      expect(store.drafts.get("forked").text).toBe("copied draft");
      if (action !== "fork") return;
      reply = deferred<RouteResponse>();
      const failed = store.branches.fork("u1");
      reply.resolve({ status: 409, body: { error: "Source changed" } });
      await expect(failed).resolves.toBe(false);
      expect(store.getState().branchTreeError).toBe("Source changed");
      reply = deferred<RouteResponse>();
      const retired = store.branches.fork("u1");
      await store.init();
      reply.resolve({ status: 401, body: { error: "Obsolete credentials" } });
      await expect(retired).resolves.toBe(false);
      expect(store.getState().needsToken).toBe(false);
    },
  );

  it("restores editor text when the socket publishes the navigation before its receipt", async () => {
    const result = deferred<RouteResponse>();
    const { store, socket } = await setup((url) =>
      url === "/api/branches/navigate" ? result.promise : undefined,
    );
    const navigation = store.branches.navigate("a1", "edit");
    const snapshot = activeSnapshot({
      transcriptPage: { viewId: "navigated" },
      effectiveLeafId: "u1",
    });
    socket.emitSnapshot(snapshot);
    result.resolve({ body: { snapshot, editorText: "returned draft" } });
    await expect(navigation).resolves.toBe(true);
    expect(store.drafts.get("s1").text).toBe("returned draft");
    expect(store.getState().branchActionId).toBeNull();
  });
});
