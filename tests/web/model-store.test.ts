// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "../../shared/contracts";
import type { CommonModelOption } from "../../shared/model-settings";
import { AppStore } from "../../src/store";
import { modelSettingsSnapshot } from "./fixtures/model-settings";
import { sessionPage } from "./fixtures/session-catalog";
import type { RouteResponse } from "./helpers";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
} from "./helpers";
import { baseRoutes, initStore } from "./store-fixture";

describe("model catalog ownership", () => {
  beforeEach(() => installFakeWebSocket());
  it("retains cached choices on failure and never changes active model/effort on refresh", async () => {
    let fail = false;
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap"))
        return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
      if (url.startsWith("/api/models"))
        return fail
          ? { status: 503, body: { error: "catalog offline" } }
          : { body: { models: [{ provider: "fixture", id: "fresh" }] } };
      return undefined;
    });
    const store = new AppStore();
    await store.init("token");
    const before = store.getState();
    await store.refreshModels();
    expect(store.getState().availableModels).toEqual([
      { provider: "fixture", id: "fresh" },
    ]);
    expect(store.getState().model).toEqual(before.model);
    expect(store.getState().thinkingLevel).toBe(before.thinkingLevel);
    fail = true;
    await expect(store.refreshModels()).rejects.toThrow("catalog offline");
    expect(store.getState().availableModels).toEqual([
      { provider: "fixture", id: "fresh" },
    ]);
  });
  it("adopts a config save's refreshed choices without switching the current model or thinking", async () => {
    const snapshot = modelSettingsSnapshot({
      models: [{ provider: "configured", id: "newly-available" }],
      commonModels: [{ provider: "configured", id: "newly-available" }],
    });
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap"))
        return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
      if (url.startsWith("/api/model-settings/config"))
        return { body: { saved: true, snapshot } };
      return undefined;
    });
    const store = new AppStore();
    await store.init("token");
    const before = store.getState();
    await store.editModelConfig(
      { sessionId: before.sessionId! },
      snapshot.configRevision,
      { kind: "provider", id: "configured", values: { apiKey: "synthetic" } },
    );
    expect(store.getState().availableModels).toEqual(snapshot.models);
    expect(store.getState().commonModels).toEqual(snapshot.commonModels);
    expect(store.getState().model).toEqual(before.model);
    expect(store.getState().thinkingLevel).toBe(before.thinkingLevel);
  });
  it.each([
    { read: "settings", write: "preferences" },
    { read: "catalog", write: "config" },
  ] as const)(
    "does not let a pending $read read undo a committed $write save",
    async ({ read, write }) => {
      const pending = deferred<RouteResponse>();
      const committed = modelSettingsSnapshot({
        models: [{ provider: "configured", id: "new" }],
        commonModels: [{ provider: "configured", id: "new" }],
      });
      let reading = true;
      installFetch((url, init) => {
        if (url.startsWith("/api/bootstrap"))
          return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
        if (init?.method === "PATCH")
          return { body: { saved: true, snapshot: committed } };
        if (
          url.startsWith("/api/model-settings") ||
          url.startsWith("/api/models")
        )
          return reading ? pending.promise : { body: committed };
        return undefined;
      });
      const store = new AppStore();
      await store.init("token");
      const owner = { sessionId: store.getState().sessionId! };
      const older =
        read === "settings"
          ? store.readModelSettings(owner)
          : store.refreshModels(owner);
      if (write === "preferences")
        await store.saveModelPreferences(owner, committed.settingsRevision, {
          enabledModels: ["configured/new"],
        });
      else
        await store.editModelConfig(owner, committed.configRevision, {
          kind: "provider",
          id: "configured",
          values: {},
        });
      const savedModels = store.getState().availableModels;
      expect(store.getState().commonModels).toEqual(committed.commonModels);

      pending.resolve({
        body: modelSettingsSnapshot({
          models: [{ provider: "outdated", id: "old" }],
          commonModels: [{ provider: "outdated", id: "old" }],
        }),
      });
      await older;
      expect(store.getState().commonModels).toEqual(committed.commonModels);
      expect(store.getState().availableModels).toEqual(savedModels);

      reading = false;
      await store.refreshModels(owner);
      expect(store.getState().availableModels).toEqual(committed.models);
    },
  );

  it("returns prospective-owner reads and writes without adopting their catalog or common scope into the selected session", async () => {
    const snapshot = modelSettingsSnapshot({
      models: [{ provider: "prospective", id: "model" }],
      commonModels: [{ provider: "prospective", id: "model" }],
    });
    const requests: string[] = [];
    installFetch((url, init) => {
      requests.push(url);
      if (url.startsWith("/api/bootstrap"))
        return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
      if (url.startsWith("/api/model-settings"))
        return {
          body: init?.method === "PATCH" ? { saved: true, snapshot } : snapshot,
        };
      if (url.startsWith("/api/models"))
        return {
          body: {
            models: snapshot.models,
            commonModels: snapshot.commonModels,
            warning: "Prospective warning",
          },
        };
      return undefined;
    });
    const store = new AppStore();
    await store.init("token");
    const before = store.getState();
    const owner = { cwd: "/prospective" };
    expect(await store.readModelSettings(owner)).toEqual(snapshot);
    expect(
      (
        await store.saveModelPreferences(owner, snapshot.settingsRevision, {
          enabledModels: ["prospective/model"],
        })
      ).snapshot,
    ).toEqual(snapshot);
    expect(
      (
        await store.editModelConfig(owner, snapshot.configRevision, {
          kind: "provider",
          id: "prospective",
          values: {},
        })
      ).snapshot,
    ).toEqual(snapshot);
    expect(await store.refreshModels(owner)).toBe("Prospective warning");
    expect(requests).toContain("/api/models?cwd=%2Fprospective");
    expect(store.getState().availableModels).toEqual(before.availableModels);
    expect(store.getState().commonModels).toEqual(before.commonModels);
    expect(store.getState().model).toEqual(before.model);
  });
  it("does not apply a delayed catalog to another selection", async () => {
    const pending = deferred<{
      models: Array<{ provider: string; id: string }>;
    }>();
    installFetch(async (url) => {
      if (url.startsWith("/api/bootstrap"))
        return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
      if (url.startsWith("/api/models")) return { body: await pending.promise };
      if (url === "/api/sessions/deselect")
        return {
          body: { active: null, runState: "idle", sessionStatuses: {} },
        };
      return undefined;
    });
    const store = new AppStore();
    await store.init("token");
    const request = store.refreshModels();
    await store.deselectSession();
    const cached = store.getState().availableModels;
    pending.resolve({ models: [{ provider: "fixture", id: "stale" }] });
    await request;
    expect(store.getState().availableModels).toEqual(cached);
  });
});

describe("native model controls", () => {
  beforeEach(() => installFakeWebSocket());

  function controlHost() {
    let model: ModelOption = {
      provider: "openai",
      id: "gpt-5",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh" },
    };
    let thinkingLevel = "medium",
      sessionId = "s1";
    const models: ModelOption[] = [
      model,
      { provider: "custom", id: "local", reasoning: true },
      { provider: "anthropic", id: "haiku", reasoning: false },
    ];
    let commonModels: CommonModelOption[] = [
      { provider: "custom", id: "local", thinkingLevel: "high" },
      { provider: "openai", id: "gpt-5" },
      { provider: "anthropic", id: "haiku" },
    ];
    const controls: Array<Record<string, unknown>> = [];
    const snapshot = () =>
      activeSnapshot({
        sessionId,
        model,
        thinkingLevel,
        availableModels: models,
        commonModels,
      });
    let modelGate: Promise<unknown> | undefined;
    const fetch = installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return { body: bootstrapPayload({ snapshot: snapshot() }) };
      if (url.startsWith("/api/snapshot")) return { body: snapshot() };
      if (url === "/api/sessions/open") {
        sessionId = String(jsonBody(init).id);
        return { body: snapshot() };
      }
      if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
      if (url === "/api/control/model-cycle") {
        const body = jsonBody(init);
        controls.push(body);
        if (body.direction === -1)
          return {
            status: 409,
            body: {
              error:
                "Only forward model cycling is available; use the model picker",
            },
          };
        if (modelGate) await modelGate;
        if (body.sessionId === sessionId) {
          const current = commonModels.findIndex(
            (item) => item.provider === model.provider && item.id === model.id,
          );
          const next =
            commonModels[(Math.max(0, current) + 1) % commonModels.length]!;
          model = models.find(
            (item) => item.provider === next.provider && item.id === next.id,
          )!;
          thinkingLevel =
            next.thinkingLevel ?? (model.reasoning ? "medium" : "off");
        }
        return { body: { model, thinkingLevel } };
      }
      if (url.startsWith("/api/control/model")) {
        const body = jsonBody(init);
        controls.push(body);
        if (modelGate) await modelGate;
        if (body.sessionId === sessionId) {
          model = models.find(
            (value) =>
              value.provider === body.provider && value.id === body.modelId,
          )!;
          thinkingLevel = model.reasoning ? "medium" : "off";
        }
        return { body: { ok: true } };
      }
      if (url.startsWith("/api/control/thinking")) {
        const body = jsonBody(init);
        controls.push(body);
        thinkingLevel = String(body.level);
        return { body: { ok: true } };
      }
      if (url.startsWith("/api/model-settings")) {
        commonModels = [
          { provider: "anthropic", id: "haiku" },
          { provider: "openai", id: "gpt-5" },
          { provider: "custom", id: "local", thinkingLevel: "high" },
        ];
        return {
          body: {
            saved: true,
            snapshot: modelSettingsSnapshot({ commonModels }),
          },
        };
      }
      if (url.startsWith("/api/preferences"))
        return {
          body: { ...bootstrapPayload().preferences, ...jsonBody(init) },
        };
      return undefined;
    });
    return {
      fetch,
      controls,
      gateModels: (gate: Promise<unknown>) => {
        modelGate = gate;
      },
    };
  }

  it("cycles cached native scope in configured order, serializes rapid model/thinking keys, and adopts committed scope without changing the current model", async () => {
    const host = controlHost(),
      store = new AppStore();
    await store.init("token");
    await Promise.all([
      store.cycleModel(1),
      store.cycleModel(1),
      store.cycleThinking(),
      store.cycleThinking(),
    ]);
    expect(host.controls).toEqual([
      { sessionId: "s1", direction: 1 },
      { sessionId: "s1", direction: 1 },
      { sessionId: "s1", level: "off" },
      { sessionId: "s1", level: "minimal" },
    ]);
    expect(
      host.fetch.mock.calls.some(([url]) =>
        String(url).startsWith("/api/models"),
      ),
    ).toBe(false);
    const current = store.getState().model;
    await store.saveModelPreferences({ sessionId: "s1" }, "a".repeat(64), {
      enabledModels: ["anthropic/haiku", "openai/gpt-5", "custom/local:high"],
    });
    expect(store.getState().model).toEqual(current);
    await store.cycleModel(1);
    expect(host.controls.at(-1)).toEqual({ sessionId: "s1", direction: 1 });
    expect(store.getState().model?.id).toBe("haiku");
    expect(
      store.getState().commonModels.map((value) => value.provider),
    ).toEqual(["anthropic", "openai", "custom"]);
  });

  it("does not let an old queued cycle mutate or delay a newly selected session", async () => {
    const host = controlHost(),
      store = new AppStore(),
      gate = deferred<void>();
    await store.init("token");
    host.gateModels(gate.promise);
    const old = store.cycleModel(1),
      queued = store.cycleThinking();
    await vi.waitFor(() => expect(host.controls).toHaveLength(1));
    await store.openSession("s2");
    await store.cycleThinking();
    expect(host.controls[1]).toEqual({ sessionId: "s2", level: "high" });
    gate.resolve();
    await Promise.all([old, queued]);
    expect(host.controls).toHaveLength(2);
    expect(store.getState().sessionId).toBe("s2");
    expect(store.getState().thinkingLevel).toBe("high");
  });
});

describe("recent model preference", () => {
  beforeEach(() => installFakeWebSocket());

  it("evicts the oldest recent model, promotes an existing identity without duplication, and skips unchanged writes", async () => {
    const recent = Array.from({ length: 8 }, (_, index) => ({
      provider: "fixture",
      id: `recent-${index}`,
    }));
    const patches: Record<string, unknown>[] = [];
    let selected = { provider: "openai", id: "gpt-5" };
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot(),
            preferences: {
              ...bootstrapPayload().preferences,
              recentModelIds: recent,
            },
          }),
        };
      if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
      if (url.startsWith("/api/control/model")) {
        const body = jsonBody(init);
        selected = {
          provider: String(body.provider),
          id: String(body.modelId),
        };
        return { body: { ok: true } };
      }
      if (url.startsWith("/api/snapshot"))
        return { body: activeSnapshot({ model: selected }) };
      if (url.startsWith("/api/preferences")) {
        patches.push(jsonBody(init));
        return {
          body: { ...bootstrapPayload().preferences, ...jsonBody(init) },
        };
      }
      return undefined;
    });
    const store = new AppStore();
    await store.init("token");
    FakeWebSocket.instances.at(-1)!.open();

    await expect(store.setModel("openai", "gpt-5")).resolves.toBe(true);
    const afterNewSelection = [
      { provider: "openai", id: "gpt-5" },
      ...recent.slice(0, 7),
    ];
    await vi.waitFor(() =>
      expect(patches).toEqual([{ recentModelIds: afterNewSelection }]),
    );
    expect(store.getState().prefs.recentModelIds).toEqual(afterNewSelection);

    await expect(store.setModel("fixture", "recent-3")).resolves.toBe(true);
    const afterPromotion = [
      recent[3]!,
      afterNewSelection[0]!,
      ...recent.slice(0, 3),
      ...recent.slice(4, 7),
    ];
    await vi.waitFor(() =>
      expect(patches).toEqual([
        { recentModelIds: afterNewSelection },
        { recentModelIds: afterPromotion },
      ]),
    );
    expect(store.getState().prefs.recentModelIds).toEqual(afterPromotion);

    await expect(store.setModel("fixture", "recent-3")).resolves.toBe(true);
    expect(patches).toHaveLength(2);
    expect(store.getState().prefs.recentModelIds).toEqual(afterPromotion);
  });

  it("keeps formerly colliding NUL-containing identities distinct in the MRU", async () => {
    const patches: Record<string, unknown>[] = [];
    let selected = { provider: "a\u0000b", id: "c" };
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
      if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
      if (url.startsWith("/api/control/model")) {
        selected = jsonBody(init) as typeof selected;
        return { body: { ok: true } };
      }
      if (url.startsWith("/api/snapshot"))
        return { body: activeSnapshot({ model: selected }) };
      if (url.startsWith("/api/preferences")) {
        patches.push(jsonBody(init));
        return {
          body: { ...bootstrapPayload().preferences, ...jsonBody(init) },
        };
      }
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
      if (url.startsWith("/api/bootstrap"))
        return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
      if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
      if (url.startsWith("/api/control/model"))
        return { status: 500, body: { error: "model unavailable" } };
      if (url.startsWith("/api/preferences")) {
        patches.push(jsonBody(init));
        return { body: jsonBody(init) };
      }
      return undefined;
    });
    const store = new AppStore();
    await store.init("token");
    await store.setModel("openai", "missing");
    expect(patches).toEqual([]);
    expect(store.getState().prefs.recentModelIds).toEqual([]);
    expect(store.getState().model).toMatchObject({
      provider: "kimi-coding",
      id: "kimi-k3",
    });
    expect(store.getState().error).toBeNull();
    expect(
      store
        .getState()
        .notices.some(
          (notice) =>
            notice.kind === "warning" && notice.text === "model unavailable",
        ),
    ).toBe(true);
  });
});

describe("thinking level control", () => {
  beforeEach(() => installFakeWebSocket());

  it("rolls back to the truthful level and resyncs when the API rejects the change", async () => {
    let snapshotCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/control/thinking"))
        return { status: 500, body: { error: "unsupported level" } };
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
    expect(store.getState().error).toBeNull();
    expect(
      store
        .getState()
        .notices.some(
          (notice) =>
            notice.kind === "warning" && notice.text === "unsupported level",
        ),
    ).toBe(true);
    await vi.waitFor(() => expect(snapshotCalls).toBeGreaterThan(0));
  });

  it("does not let an older refusal undo a newer accepted level", async () => {
    const xhigh = deferred<RouteResponse>();
    const low = deferred<RouteResponse>();
    const fetch = installFetch((url, init) => {
      if (url.startsWith("/api/control/thinking")) {
        const body = jsonBody(init) as { level: string };
        return body.level === "xhigh" ? xhigh.promise : low.promise;
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    const older = store.setThinkingLevel("xhigh");
    expect(store.getState().thinkingLevel).toBe("xhigh");
    const newer = store.setThinkingLevel("low");
    expect(store.getState().thinkingLevel).toBe("low");
    low.resolve({ body: { ok: true } });
    await expect(newer).resolves.toBe(true);
    expect(store.getState().thinkingLevel).toBe("low");
    xhigh.resolve({ status: 500, body: { error: "unsupported level" } });
    await expect(older).resolves.toBe(false);

    expect(store.getState().thinkingLevel).toBe("low");
    expect(store.getState().notices).toEqual([]);
    expect(store.getState().error).toBeNull();
    expect(
      fetch.mock.calls.filter(([url]) =>
        String(url).startsWith("/api/snapshot"),
      ),
    ).toEqual([]);
  });
});
