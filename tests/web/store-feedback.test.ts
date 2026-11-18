// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  installFakeWebSocket,
  inputReceipt,
  installFetch,
  jsonBody,
  type RouteResponse,
  selectSession,
} from "./helpers";
import { baseRoutes, initStore } from "./store-fixture";

beforeEach(() => installFakeWebSocket());

describe("feedback scope", () => {
  it("identifies a native agent interruption without claiming to stop terminal shell work", async () => {
    installFetch((url, init) => {
      if (url === "/api/control/abort")
        return {
          body: {
            ...inputReceipt("abort", jsonBody(init)),
            state: "completed",
            result: { steering: [], followUp: [], interruptionScope: "agent" },
          },
        };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.abort();
    expect(store.getState().live.notices).toEqual([
      expect.objectContaining({
        kind: "info",
        text: expect.stringContaining(
          "Interrupt terminal shell commands in the original Pi terminal",
        ),
      }),
    ]);
  });

  it("preserves a read warning through prompt acceptance and clears it independently of control failures", async () => {
    let unavailable = true;
    const failedActions = ["/api/control/abort", "/api/pending/clear"];
    const requested: string[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/snapshot"))
        return unavailable
          ? { status: 503, body: { error: "Snapshot unavailable" } }
          : { body: activeSnapshot() };
      if (url === "/api/prompt")
        return {
          body: {
            ...inputReceipt("prompt", jsonBody(init)),
            state: "completed",
            result: null,
          },
        };
      if (failedActions.includes(url)) {
        requested.push(url);
        if (url === "/api/control/abort")
          return {
            status: 409,
            body: {
              ...inputReceipt("abort", jsonBody(init)),
              state: "rejected",
              error: { status: 409, message: "Action refused" },
            },
          };
        return { status: 409, body: { error: "Action refused" } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.refreshSession();
    const warning = store.getState().error;
    expect(warning).toContain("Snapshot unavailable");
    await expect(store.sendPrompt("Still usable")).resolves.toMatchObject({
      accepted: true,
    });
    expect(store.getState().error).toBe(warning);
    await store.abort();
    await store.clearPending();
    expect(requested).toEqual(failedActions);
    expect(store.getState().error).toBe(warning);
    const notices = store.getState().live.notices;
    expect(notices).toHaveLength(2);
    unavailable = false;
    await store.refreshSession();
    expect(store.getState().error).toBeNull();
    expect(store.getState().live.notices).toEqual(notices);
  });

  it.each([false, true])(
    "a fresh snapshot resolves read warnings but keeps projection errors (projectionError=%s)",
    async (brokenProjection) => {
      const snapshot = activeSnapshot();
      if (brokenProjection)
        snapshot.active!.projectionHealth = {
          status: "error",
          message: "Broken projection",
        };
      installFetch((url, init) => {
        if (url.startsWith("/api/bootstrap"))
          return { body: bootstrapPayload({ startupSessionId: "s1" }) };
        if (url.startsWith("/api/snapshot"))
          return { status: 503, body: { error: "Snapshot unavailable" } };
        return baseRoutes(url, init);
      });
      const { store, socket } = await initStore(snapshot);
      await store.refreshSession();
      expect(store.getState().error).toBeTruthy();
      socket.emitSnapshot(snapshot);
      expect(store.getState().error).toBe(
        brokenProjection ? "Broken projection" : null,
      );
    },
  );

  it.each(["current", "expired", "changed session"] as const)(
    "scopes a dialog answer to its original request (%s)",
    async (outcome) => {
      const response = deferred<RouteResponse>();
      const nextResponse = deferred<RouteResponse>();
      const submitted = deferred<Record<string, unknown>>();
      installFetch((url, init) => {
        if (url !== "/api/extension-ui") return baseRoutes(url, init);
        const body = jsonBody(init);
        if (body.sessionId === "s2") return nextResponse.promise;
        submitted.resolve(body);
        return response.promise;
      });
      const { store, socket } = await initStore();
      socket.emit({
        type: "extension_ui_pending",
        sessionId: "s1",
        request: {
          sessionId: "s1",
          id: "choice",
          method: "select",
          title: "Choose",
          options: ["One"],
        },
      });
      const answering = store.respondExtensionUi({
        id: "choice",
        value: "One",
      });
      expect(await submitted.promise).toMatchObject({
        sessionId: "s1",
        id: "choice",
      });
      if (outcome === "expired")
        socket.emit({
          type: "extension_ui_remove",
          sessionId: "s1",
          id: "choice",
          reason: "expired",
        });
      let nextAnswer: Promise<string | null> | undefined;
      if (outcome === "changed session") {
        const next = activeSnapshot({ sessionId: "s2" });
        next.pendingExtensionUiRequests = [
          {
            sessionId: "s2",
            id: "choice",
            method: "confirm",
            title: "Question B",
          },
        ];
        await selectSession(store, next);
        nextAnswer = store.respondExtensionUi({
          id: "choice",
          confirmed: true,
        });
      }

      response.resolve(
        outcome === "changed session"
          ? { body: { ok: true } }
          : { status: 409, body: { error: "Reply refused" } },
      );
      await expect(answering).resolves.toBe(
        outcome === "current" ? "Reply refused" : null,
      );
      expect(store.getState()).toMatchObject({
        error: null,
        live: {
          notices: [],
          extensionUiRespondingId: nextAnswer ? "choice" : null,
        },
      });
      if (nextAnswer) {
        expect(store.getState().live.extensionUiRequests).toMatchObject([
          { sessionId: "s2", id: "choice" },
        ]);
        nextResponse.resolve({ body: { ok: true } });
        await nextAnswer;
      }
    },
  );
});
