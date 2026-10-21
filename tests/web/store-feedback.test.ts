// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  installFakeWebSocket,
  installFetch,
  type RouteResponse,
} from "./helpers";
import { baseRoutes, initStore } from "./store-fixture";

beforeEach(() => installFakeWebSocket());

describe("feedback scope", () => {
  it("identifies a native agent interruption without claiming to stop terminal shell work", async () => {
    installFetch((url, init) => {
      if (url === "/api/control/abort")
        return {
          body: { steering: [], followUp: [], interruptionScope: "agent" },
        };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.abort();
    expect(store.getState().notices).toEqual([
      expect.objectContaining({
        kind: "info",
        text: expect.stringContaining(
          "Interrupt terminal shell commands in the original Pi terminal",
        ),
      }),
    ]);
  });

  it.each(["send", "stop", "clear-pending", "prompt-history"] as const)(
    "keeps %s feedback separate from a current synchronization warning",
    async (action) => {
      const snapshot = activeSnapshot({
        transcriptPage: { composerHistoryVersion: "history-1" },
      });
      const requested: string[] = [];
      installFetch((url, init) => {
        if (url.startsWith("/api/bootstrap"))
          return { body: bootstrapPayload({ snapshot }) };
        if (url.startsWith("/api/snapshot"))
          return { status: 503, body: { error: "Snapshot unavailable" } };
        if (
          ["/api/prompt", "/api/control/abort", "/api/pending/clear"].includes(
            url,
          ) ||
          url.startsWith("/api/composer/history")
        ) {
          requested.push(url);
          return { status: 503, body: { error: "Action refused" } };
        }
        return baseRoutes(url, init);
      });
      const { store } = await initStore();
      await store.refreshSession();
      const warning = store.getState().error;
      expect(warning).toBe("Failed to refresh session: Snapshot unavailable");

      if (action === "send") await store.sendPrompt("Keep this draft");
      else if (action === "stop") await store.abort();
      else if (action === "clear-pending") await store.clearPending();
      else {
        const state = store.getState();
        await store.loadComposerHistory(
          state.sessionId!,
          state.transcriptViewId!,
          state.transcriptIncarnation,
          state.composerHistoryVersion!,
        );
      }

      expect(requested).toHaveLength(1);
      expect(store.getState().error).toBe(warning);
      expect(store.getState().notices).toEqual([
        expect.objectContaining({ kind: "warning", text: expect.any(String) }),
      ]);
      if (action === "send")
        expect(store.getState().editorText?.text).toBe("Keep this draft");
    },
  );

  it("clears a refresh warning only when state is reobserved, not when a send succeeds", async () => {
    let unavailable = true;
    installFetch((url, init) => {
      if (url.startsWith("/api/snapshot"))
        return unavailable
          ? { status: 503, body: { error: "Snapshot unavailable" } }
          : { body: activeSnapshot() };
      if (url === "/api/prompt")
        return { body: { accepted: true, historyEntry: null } };
      if (url === "/api/control/abort")
        return { status: 409, body: { error: "Stop was not confirmed" } };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.refreshSession();
    await store.sendPrompt("Still usable");
    expect(store.getState().error).toContain("Snapshot unavailable");
    await store.abort();
    const notices = store.getState().notices;
    expect(notices).toHaveLength(1);
    unavailable = false;
    await store.refreshSession();
    expect(store.getState().error).toBeNull();
    expect(store.getState().notices).toEqual(notices);
  });

  it.each([false, true])(
    "a cached snapshot resolves read warnings but keeps projection errors (projectionError=%s)",
    async (brokenProjection) => {
      const snapshot = activeSnapshot();
      if (brokenProjection)
        snapshot.active!.projectionHealth = {
          status: "error",
          message: "Broken projection",
        };
      installFetch((url, init) => {
        if (url.startsWith("/api/bootstrap"))
          return { body: bootstrapPayload({ snapshot }) };
        if (url.startsWith("/api/snapshot"))
          return { status: 503, body: { error: "Snapshot unavailable" } };
        return baseRoutes(url, init);
      });
      const { store, socket } = await initStore();
      await store.refreshSession();
      expect(store.getState().error).toBeTruthy();
      socket.emit({ type: "snapshot", unchanged: true });
      expect(store.getState().error).toBe(
        brokenProjection ? "Broken projection" : null,
      );
    },
  );

  it.each([false, true])(
    "returns a dialog response error only while its request still exists (expired=%s)",
    async (expired) => {
      const response = deferred<RouteResponse>();
      installFetch((url, init) =>
        url === "/api/extension-ui" ? response.promise : baseRoutes(url, init),
      );
      const { store, socket } = await initStore();
      socket.emit({
        type: "extension_ui_request",
        sessionId: "s1",
        id: "choice",
        method: "select",
        title: "Choose",
        options: ["One"],
      });
      const answering = store.respondExtensionUi({
        id: "choice",
        value: "One",
      });
      if (expired)
        socket.emit({
          type: "extension_ui_remove",
          sessionId: "s1",
          id: "choice",
          reason: "expired",
        });
      response.resolve({ status: 409, body: { error: "Reply refused" } });
      await expect(answering).resolves.toBe(expired ? null : "Reply refused");
      expect(store.getState().error).toBeNull();
      expect(store.getState().notices).toEqual([]);
      expect(store.getState().extensionUiRespondingId).toBeNull();
    },
  );
});
