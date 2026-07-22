// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStore } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  type RouteHandler,
} from "./helpers";

const baseRoutes: RouteHandler = (url) => {
  if (url.startsWith("/api/bootstrap")) return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
  if (url.startsWith("/api/snapshot")) return { body: activeSnapshot() };
  if (url.startsWith("/api/sessions")) return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
  return undefined;
};

async function initStore(): Promise<{ store: AppStore; socket: FakeWebSocket }> {
  const store = new AppStore();
  await store.init("token");
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  return { store, socket };
}

describe("websocket lifecycle", () => {
  beforeEach(() => installFakeWebSocket());

  it("does not issue an HTTP resync on open; the pushed snapshot is authoritative", async () => {
    let snapshotCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/snapshot")) snapshotCalls += 1;
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    expect(snapshotCalls).toBe(0);
    socket.emit({ type: "snapshot", data: activeSnapshot({ sessionId: "s9" }) });
    expect(store.getState().sessionId).toBe("s9");
    expect(snapshotCalls).toBe(0);
  });

  it("ignores unknown wire events without notifying listeners", async () => {
    installFetch(baseRoutes);
    const { store, socket } = await initStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    socket.emit({ type: "future_wire_event", data: { anything: true } });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("thinking level control", () => {
  beforeEach(() => installFakeWebSocket());

  it("rolls back to the truthful level and resyncs when the API rejects the change", async () => {
    let snapshotCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/control/thinking")) return { status: 500, body: { error: "unsupported level" } };
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
    expect(store.getState().error).toBe("unsupported level");
    await vi.waitFor(() => expect(snapshotCalls).toBeGreaterThan(0));
  });

  it("keeps the optimistic level when the API accepts the change", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/control/thinking")) return { body: { ok: true } };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.setThinkingLevel("low");
    expect(store.getState().thinkingLevel).toBe("low");
    expect(store.getState().error).toBeNull();
  });
});

describe("notice expiry", () => {
  beforeEach(() => {
    installFakeWebSocket();
    installFetch(baseRoutes);
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it("cancels the expiry timer when a notice is dismissed manually", async () => {
    const { store, socket } = await initStore();
    socket.emit({ type: "extension_ui_request", id: "n1", method: "notify", message: "Indexed 3 files" });
    const notice = store.getState().notices.at(-1)!;
    expect(notice.text).toBe("Indexed 3 files");

    const listener = vi.fn();
    store.subscribe(listener);
    store.dismissNotice(notice.id);
    expect(store.getState().notices).toHaveLength(0);
    listener.mockClear();

    // the cancelled timer must never fire a stray publish afterwards
    vi.advanceTimersByTime(60_000);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getState().notices).toHaveLength(0);
  });
});
