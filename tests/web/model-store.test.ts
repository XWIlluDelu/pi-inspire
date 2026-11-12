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
  it("replaces cached choices only with an authoritative catalog and keeps native selection", async () => {
    const fresh = [{ provider: "fixture", id: "fresh" }];
    const offline = { status: 503, body: { error: "catalog offline" } };
    const catalog = vi
      .fn()
      .mockReturnValueOnce(offline)
      .mockReturnValueOnce({ body: { models: fresh } })
      .mockReturnValueOnce(offline);
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            availableModels: [{ provider: "fixture", id: "previous-pi" }],
            snapshot: activeSnapshot({ availableModels: [] }),
          }),
        };
      return url.startsWith("/api/models") ? catalog() : baseRoutes(url, init);
    });
    const { store } = await initStore();
    const { model, thinkingLevel } = store.getState();
    await expect(store.refreshModels()).rejects.toThrow("catalog offline");
    expect(store.getState().availableModels).toEqual([]);
    await store.refreshModels();
    await expect(store.refreshModels()).rejects.toThrow("catalog offline");
    expect(store.getState()).toMatchObject({
      availableModels: fresh,
      model,
      thinkingLevel,
    });
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
      await store.init();
      const before = store.getState();
      const owner = { sessionId: before.sessionId! };
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
      const savedModels =
        write === "config" ? committed.models : before.availableModels;
      expect(store.getState()).toMatchObject({
        availableModels: savedModels,
        commonModels: committed.commonModels,
        model: before.model,
        thinkingLevel: before.thinkingLevel,
      });

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

  it("keeps prospective model configuration independent of the selected session", async () => {
    const models = [{ provider: "prospective", id: "model" }];
    const snapshot = modelSettingsSnapshot({ models, commonModels: models });
    const paths: string[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/model-settings")) {
        paths.push(url);
        return {
          body: init.method === "PATCH" ? { saved: true, snapshot } : snapshot,
        };
      }
      if (url.startsWith("/api/models")) {
        paths.push(url);
        return { body: { models, commonModels: models } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    const { availableModels, commonModels, model } = store.getState();
    const owner = { cwd: "/prospective" };
    await expect(store.readModelSettings(owner)).resolves.toEqual(snapshot);
    await store.saveModelPreferences(owner, snapshot.settingsRevision, {
      enabledModels: ["prospective/model"],
    });
    await store.editModelConfig(owner, snapshot.configRevision, {
      kind: "provider",
      id: "prospective",
      values: {},
    });
    await store.refreshModels(owner);
    expect(
      paths.map((path) =>
        new URL(path, "http://fixture").searchParams.get("cwd"),
      ),
    ).toEqual(Array(4).fill("/prospective"));
    expect(store.getState()).toMatchObject({
      availableModels,
      commonModels,
      model,
    });
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
    await store.init();
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
    const nativeCycles = [
      { model: models[2]!, thinkingLevel: "off" },
      { model: models[1]!, thinkingLevel: "high" },
      { model: models[2]!, thinkingLevel: "off" },
    ];
    let cycle = 0;
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
    installFetch(async (url, init) => {
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
        if (modelGate) await modelGate;
        if (body.sessionId === sessionId)
          ({ model, thinkingLevel } = nativeCycles[cycle++]!);
        return { body: { model, thinkingLevel } };
      }
      if (url.startsWith("/api/control/thinking")) {
        const body = jsonBody(init);
        controls.push(body);
        thinkingLevel = String(body.level);
        return { body: { model, thinkingLevel } };
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
      controls,
      gateModels: (gate: Promise<unknown>) => {
        modelGate = gate;
      },
    };
  }

  it("uses refreshed thinking capabilities and adopts Pi's actual command result", async () => {
    const initial: ModelOption = {
      provider: "fixture",
      id: "reasoner",
      reasoning: false,
    };
    const redirected = {
      provider: "native",
      id: "extension-choice",
      reasoning: true,
    };
    let model = initial;
    const catalog: ModelOption[] = [
      {
        ...initial,
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      },
    ];
    let thinkingLevel = "high";
    const levels: string[] = [];
    const snapshot = () =>
      activeSnapshot({ model, thinkingLevel, availableModels: [] });
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return { body: bootstrapPayload({ snapshot: snapshot() }) };
      if (url.startsWith("/api/snapshot")) return { body: snapshot() };
      if (url.startsWith("/api/models")) return { body: { models: catalog } };
      if (url.startsWith("/api/control/thinking")) {
        thinkingLevel = String(jsonBody(init).level);
        levels.push(thinkingLevel);
        if (thinkingLevel === "max") {
          model = redirected;
          thinkingLevel = "low";
        }
        return { body: { model, thinkingLevel } };
      }
      return baseRoutes(url, init);
    });
    const store = new AppStore();
    await store.init();
    await store.refreshModels();
    await store.cycleThinking();
    expect(levels).toEqual(["xhigh"]);
    expect(store.getState().model).toMatchObject({
      provider: initial.provider,
      id: initial.id,
    });
    await store.sendPrompt("/thinking max");
    await vi.waitFor(() => expect(store.getState().thinkingLevel).toBe("low"));
    expect(levels).toEqual(["xhigh", "max"]);
    expect(store.getState().model).toEqual(redirected);
  });

  it("serializes rapid native model and thinking actions and preserves selection when scope is saved", async () => {
    const host = controlHost(),
      store = new AppStore();
    await store.init();
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
    await store.init();
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

  it("updates bounded model recency only after a distinct, accepted selection", async () => {
    const recent = Array.from({ length: 8 }, (_, index) => ({
      provider: "fixture",
      id: `recent-${index}`,
    }));
    const patches: Record<string, unknown>[] = [];
    const otherProvider = { provider: "local", id: recent[3]!.id };
    let selected = otherProvider;
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
        if (body.modelId === "missing")
          return { status: 500, body: { error: "model unavailable" } };
        selected = {
          provider: String(body.provider),
          id: String(body.modelId),
        };
        return {
          body: { model: selected, thinkingLevel: "medium" },
        };
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
    await store.init();
    FakeWebSocket.instances.at(-1)!.open();

    await expect(
      store.setModel(otherProvider.provider, otherProvider.id),
    ).resolves.toBe(true);
    const afterNewSelection = [otherProvider, ...recent.slice(0, 7)];
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
    await expect(store.setModel("fixture", "missing")).resolves.toBe(false);
    expect(store.getState().model).toEqual(recent[3]);
    expect(store.getState().notices.at(-1)?.text).toBe("model unavailable");
    expect(store.getState().prefs.recentModelIds).toEqual(afterPromotion);
    expect(patches).toHaveLength(2);
  });
});

describe("thinking level control", () => {
  beforeEach(() => installFakeWebSocket());

  it.each(["snapshot", "failure"] as const)(
    "retires an older thinking change's resync %s after a confirmed change",
    async (completion) => {
      const firstReceipt = deferred<RouteResponse>();
      const resync = deferred<RouteResponse>();
      const model = { provider: "kimi-coding", id: "kimi-k3" };
      let thinkingLevel = "medium";
      let reads = 0;
      installFetch((url, init) => {
        if (url.startsWith("/api/snapshot")) {
          reads += 1;
          if (reads === 2) return resync.promise;
          return {
            body: activeSnapshot({
              thinkingLevel,
              pageMessages: [{ role: "user", content: "Fresh history" }],
            }),
          };
        }
        if (url === "/api/control/thinking") {
          thinkingLevel = String(jsonBody(init).level);
          return thinkingLevel === "high"
            ? firstReceipt.promise
            : { body: { model, thinkingLevel } };
        }
        return baseRoutes(url, init);
      });
      const { store } = await initStore();
      const older = store.setThinkingLevel("high");
      await store.refreshSession();
      firstReceipt.resolve({ body: { model, thinkingLevel: "high" } });
      await vi.waitFor(() => expect(reads).toBe(2));

      await expect(store.setThinkingLevel("low")).resolves.toBe(true);
      resync.resolve(
        completion === "snapshot"
          ? { body: activeSnapshot({ thinkingLevel: "high" }) }
          : { status: 503, body: { error: "Older read failed" } },
      );
      await expect(older).resolves.toBe(false);
      expect(store.getState().thinkingLevel).toBe("low");
      expect(store.getState().error).toBeNull();

      await store.refreshSession();
      expect(store.getState().thinkingLevel).toBe("low");
      expect(store.getState().messages).toMatchObject([
        { role: "user", content: "Fresh history" },
      ]);
      expect(store.getState().error).toBeNull();
      expect(reads).toBe(3);
    },
  );

  it.each(["picker", "cycle"] as const)(
    "keeps the newer %s selection when an earlier thinking response arrives late",
    async (control) => {
      const delivery = deferred<void>();
      const oldModel = { provider: "fixture", id: "old", reasoning: true };
      const newModel = { provider: "fixture", id: "new", reasoning: true };
      let model = oldModel;
      let thinkingLevel = "medium";
      const snapshot = () => activeSnapshot({ model, thinkingLevel });
      installFetch(async (url, init) => {
        if (url.startsWith("/api/bootstrap"))
          return { body: bootstrapPayload({ snapshot: snapshot() }) };
        if (url.startsWith("/api/snapshot")) return { body: snapshot() };
        if (url === "/api/control/thinking") {
          // Pi completes this mutation first. Only HTTP delivery is delayed;
          // the next mutation and its snapshot observe the newer native state.
          thinkingLevel = String(jsonBody(init).level);
          const result = { model, thinkingLevel };
          await delivery.promise;
          return { body: result };
        }
        if (
          url === "/api/control/model" ||
          url === "/api/control/model-cycle"
        ) {
          model = newModel;
          thinkingLevel = "low";
          return { body: { model, thinkingLevel } };
        }
        return baseRoutes(url, init);
      });
      const { store } = await initStore();
      const thinking = store.setThinkingLevel("high");
      await vi.waitFor(() => expect(thinkingLevel).toBe("high"));
      if (control === "picker") await store.setModel("fixture", "new");
      else await store.cycleModel(1);
      expect(store.getState().model).toEqual(newModel);
      expect(store.getState().thinkingLevel).toBe("low");

      delivery.resolve();
      await thinking;

      expect(store.getState().model).toEqual(newModel);
      expect(store.getState().thinkingLevel).toBe("low");
    },
  );

  it.each([false, true])(
    "reconciles a refused thinking change with native state (newer snapshot: %s)",
    async (nativeUpdate) => {
      const thinking = deferred<RouteResponse>();
      const resync = deferred<RouteResponse>();
      installFetch((url, init) => {
        if (url === "/api/control/thinking") return thinking.promise;
        if (url.startsWith("/api/snapshot")) return resync.promise;
        return baseRoutes(url, init);
      });
      const { store, socket } = await initStore();
      const confirmed = nativeUpdate ? "low" : "medium";
      const changing = store.setThinkingLevel("xhigh");
      if (nativeUpdate) {
        socket.emit({
          type: "snapshot",
          data: activeSnapshot({ thinkingLevel: confirmed }),
        });
      }

      thinking.resolve({ status: 400, body: { error: "unsupported level" } });
      await expect(changing).resolves.toBe(false);
      expect(store.getState().thinkingLevel).toBe(confirmed);
      expect(store.getState().notices.at(-1)?.text).toBe("unsupported level");
      expect(store.getState().error).toBeNull();

      resync.resolve({ body: activeSnapshot({ thinkingLevel: "off" }) });
      await vi.waitFor(() =>
        expect(store.getState().thinkingLevel).toBe("off"),
      );
    },
  );

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
    low.resolve({
      body: { model: store.getState().model, thinkingLevel: "low" },
    });
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
