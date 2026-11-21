// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { modelSettingsSnapshot } from "./fixtures/model-settings";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  installFakeWebSocket,
  jsonBody,
  type RouteResponse,
} from "./helpers";
import { initStore, installStoreRoutes } from "./store-fixture";

beforeEach(() => installFakeWebSocket());

const first = { provider: "fixture", id: "first", reasoning: true };
const second = { provider: "fixture", id: "second", reasoning: true };

it("replaces old Settings and picker results with the committed catalog and keeps prospective reads scoped", async () => {
  const oldSettings = deferred<RouteResponse>();
  const oldPicker = deferred<RouteResponse>();
  const writable = modelSettingsSnapshot({
    models: [second],
    commonModels: [second],
  });
  const stale = modelSettingsSnapshot({
    models: [first],
    commonModels: [first],
  });
  const success = { body: { saved: true, snapshot: writable } };
  installStoreRoutes((url, init) => {
    if (url.includes("cwd=%2Fprospective")) return { body: stale };
    if (url.startsWith("/api/model-settings"))
      return init.method === "PATCH" ? success : oldSettings.promise;
    if (url.startsWith("/api/models")) return oldPicker.promise;
  });
  const { store } = await initStore(
    activeSnapshot({ model: first, availableModels: [first] }),
  );
  const owner = { sessionId: "s1" };
  const settings = store.readModelSettings(owner, true);
  await store.saveModelPreferences(owner, writable.settingsRevision, {
    enabledModels: ["fixture/second"],
  });
  oldSettings.resolve({ body: stale });
  await settings;
  expect(store.getState().commonModels).toEqual([second]);

  const picker = store.refreshModels(owner);
  await store.editModelConfig(owner, writable.configRevision, {
    kind: "provider",
    id: "fixture",
    values: {},
  });
  oldPicker.resolve({ body: stale });
  await picker;
  await store.readModelSettings({ cwd: "/prospective" }, true);
  await store.refreshModels({ cwd: "/prospective" });
  expect(store.getState()).toMatchObject({
    model: first,
    availableModels: [second],
    commonModels: [second],
  });
});

it("serializes active cycle actions and does not wait for retired actions to finish", async () => {
  const held = deferred<RouteResponse>();
  const calls: unknown[] = [];
  const snapshot = (sessionId = "s1") => {
    const result = activeSnapshot({
      sessionId,
      model: first,
      thinkingLevel: "off",
    });
    if (sessionId === "s2") result.sessionStatuses[sessionId]!.external = true;
    return result;
  };
  installStoreRoutes((url, init) => {
    if (url === "/api/sessions/open") return { body: snapshot("s2") };
    if (url === "/api/control/model-cycle") {
      calls.push(jsonBody(init));
      return held.promise;
    }
    if (url === "/api/control/thinking-cycle") {
      calls.push(jsonBody(init));
      return {
        body: {
          model: first,
          thinkingLevel: calls.length === 1 ? "medium" : "high",
        },
      };
    }
    if (url === "/api/control/thinking") {
      const body = jsonBody(init);
      calls.push(body);
      return { body: { model: first, thinkingLevel: body.level } };
    }
  });
  const { store } = await initStore(snapshot());
  await Promise.all([store.cycleThinking(), store.cycleThinking()]);
  expect(calls).toEqual([{ sessionId: "s1" }, { sessionId: "s1" }]);
  expect(store.getState().thinkingLevel).toBe("high");

  const old = store.cycleModel(1);
  const queued = store.cycleThinking();
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  await store.openSession("s2");
  await store.cycleThinking();
  held.resolve({ body: { model: second, thinkingLevel: "high" } });
  await Promise.all([old, queued]);
  expect(calls.slice(2)).toEqual([
    { sessionId: "s1", direction: 1 },
    { sessionId: "s2", level: "minimal" },
  ]);
  expect(store.getState()).toMatchObject({
    sessionId: "s2",
    model: first,
    thinkingLevel: "minimal",
  });
});

it("remembers a distinct confirmed model identity and leaves recency alone after refusal", async () => {
  const recent = Array.from({ length: 8 }, (_, index) => ({
    provider: "fixture",
    id: `recent-${index}`,
  }));
  const routed = { provider: "another", id: "recent-3" };
  const patches: unknown[] = [];
  const defaults = bootstrapPayload().preferences;
  installStoreRoutes((url, init) => {
    if (url === "/api/bootstrap")
      return {
        body: bootstrapPayload({
          startupSessionId: "s1",
          preferences: { ...defaults, recentModelIds: recent },
        }),
      };
    if (url === "/api/control/model")
      return jsonBody(init).modelId === "missing"
        ? { status: 400, body: { error: "model unavailable" } }
        : { body: { model: routed, thinkingLevel: "medium" } };
    if (url.startsWith("/api/snapshot"))
      return { body: activeSnapshot({ model: routed }) };
    if (url === "/api/preferences") {
      const patch = jsonBody(init);
      patches.push(patch);
      return { body: { preferences: { ...defaults, ...patch }, revision: 1 } };
    }
  });
  const { store } = await initStore();
  const expected = [routed, ...recent.slice(0, 7)];
  await expect(store.setModel("fixture", "redirected")).resolves.toBe(true);
  await vi.waitFor(() =>
    expect(store.getState().prefs.recentModelIds).toEqual(expected),
  );
  await store.setModel(routed.provider, routed.id);
  await expect(store.setModel("fixture", "missing")).resolves.toBe(false);
  expect(patches).toEqual([{ recentModelIds: expected }]);
  expect(store.getState().model).toEqual(routed);
});

it.each(["resync", "refusal"] as const)(
  "keeps confirmed effort across an older %s",
  async (stage) => {
    const receipt = deferred<RouteResponse>();
    const resync = deferred<RouteResponse>();
    const receiptOf = (thinkingLevel: string) => ({
      body: { model: first, thinkingLevel },
    });
    let level = "medium",
      reads = 0;
    installStoreRoutes((url, init) => {
      if (url === "/api/control/thinking") {
        level = String(jsonBody(init).level);
        return level === "high" ? receipt.promise : receiptOf(level);
      }
      if (url.startsWith("/api/snapshot")) {
        if (++reads === 2 && stage === "resync") return resync.promise;
        return { body: activeSnapshot({ model: first, thinkingLevel: level }) };
      }
    });
    const { store } = await initStore(activeSnapshot({ model: first }));
    const old = store.setThinkingLevel("high");
    expect(store.getState().thinkingLevel).toBe("medium");
    expect(store.getState().thinkingLevelPending).toBe(true);
    if (stage === "resync") {
      await store.refreshSession();
      receipt.resolve(receiptOf("high"));
      await vi.waitFor(() => expect(reads).toBe(2));
    }
    await expect(store.setThinkingLevel("low")).resolves.toBe(true);
    if (stage === "resync")
      resync.resolve({ body: activeSnapshot({ thinkingLevel: "high" }) });
    else receipt.resolve({ status: 400, body: { error: "old write refused" } });
    await expect(old).resolves.toBe(false);
    expect(store.getState()).toMatchObject({
      model: first,
      thinkingLevel: "low",
      thinkingLevelPending: false,
    });
    expect(store.getState().live.notices).toEqual([]);
  },
);

it("observes Pi after a current refusal without replacing the last confirmation early", async () => {
  const result = deferred<RouteResponse>();
  installStoreRoutes((url) => {
    if (url === "/api/control/thinking")
      return { status: 400, body: { error: "unsupported level" } };
    if (url.startsWith("/api/snapshot")) return result.promise;
  });
  const { store } = await initStore(activeSnapshot({ thinkingLevel: "low" }));
  await expect(store.setThinkingLevel("xhigh")).resolves.toBe(false);
  expect(store.getState().thinkingLevel).toBe("low");
  expect(store.getState().live.notices.at(-1)?.text).toBe("unsupported level");
  result.resolve({ body: activeSnapshot({ thinkingLevel: "off" }) });
  await vi.waitFor(() => expect(store.getState().thinkingLevel).toBe("off"));
});
