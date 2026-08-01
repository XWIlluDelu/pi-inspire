// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppStore } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
} from "./helpers";

describe("recent model preference", () => {
  beforeEach(() => installFakeWebSocket());

  it("records a deduplicated bounded MRU only after a successful setModel", async () => {
    const patches: Record<string, unknown>[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
      if (url.startsWith("/api/sessions")) return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
      if (url.startsWith("/api/control/model")) return { body: { ok: true } };
      if (url.startsWith("/api/snapshot")) return { body: activeSnapshot({ model: { provider: "openai", id: "gpt-5" } }) };
      if (url.startsWith("/api/preferences")) {
        patches.push(jsonBody(init));
        return { body: { ...bootstrapPayload().preferences, ...jsonBody(init) } };
      }
      return undefined;
    });
    const store = new AppStore();
    await store.init("token");
    FakeWebSocket.instances.at(-1)!.open();

    await store.setModel("openai", "gpt-5");
    await vi.waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ recentModelIds: [{ provider: "openai", id: "gpt-5" }] });
    expect(store.getState().prefs.recentModelIds).toEqual([{ provider: "openai", id: "gpt-5" }]);

    await store.setModel("openai", "gpt-5");
    await vi.waitFor(() => expect(patches).toHaveLength(2));
    expect(store.getState().prefs.recentModelIds).toEqual([{ provider: "openai", id: "gpt-5" }]);
  });

  it("keeps formerly colliding NUL-containing identities distinct in the MRU", async () => {
    const patches: Record<string, unknown>[] = [];
    let selected = { provider: "a\u0000b", id: "c" };
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
      if (url.startsWith("/api/sessions")) return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
      if (url.startsWith("/api/control/model")) { selected = jsonBody(init) as typeof selected; return { body: { ok: true } }; }
      if (url.startsWith("/api/snapshot")) return { body: activeSnapshot({ model: selected }) };
      if (url.startsWith("/api/preferences")) { patches.push(jsonBody(init)); return { body: { ...bootstrapPayload().preferences, ...jsonBody(init) } }; }
      return undefined;
    });
    const store = new AppStore();
    await store.init("token");
    await store.setModel("a\u0000b", "c");
    await store.setModel("a", "b\u0000c");
    await vi.waitFor(() => expect(patches).toHaveLength(2));
    expect(store.getState().prefs.recentModelIds).toEqual([
      { provider: "a", id: "b\u0000c" },
      { provider: "a\u0000b", id: "c" },
    ]);
  });

  it("does not mutate recency or active truth after a failed setModel", async () => {
    const patches: Record<string, unknown>[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
      if (url.startsWith("/api/sessions")) return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
      if (url.startsWith("/api/control/model")) return { status: 500, body: { error: "model unavailable" } };
      if (url.startsWith("/api/preferences")) { patches.push(jsonBody(init)); return { body: jsonBody(init) }; }
      return undefined;
    });
    const store = new AppStore();
    await store.init("token");
    await store.setModel("openai", "missing");
    expect(patches).toEqual([]);
    expect(store.getState().prefs.recentModelIds).toEqual([]);
    expect(store.getState().model).toMatchObject({ provider: "kimi-coding", id: "kimi-k3" });
    expect(store.getState().error).toBe("model unavailable");
  });
});
