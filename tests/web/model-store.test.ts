// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "../../shared/contracts";
import type { CommonModelOption } from "../../shared/model-settings";
import { AppStore } from "../../src/store";
import { modelSettingsSnapshot } from "./fixtures/model-settings";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
} from "./helpers";

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
      if (url.startsWith("/api/sessions"))
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
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
      store.cycleModel(-1),
      store.cycleThinking(),
      store.cycleThinking(),
    ]);
    expect(host.controls).toEqual([
      { sessionId: "s1", provider: "anthropic", modelId: "haiku" },
      { sessionId: "s1", provider: "openai", modelId: "gpt-5" },
      { sessionId: "s1", level: "high" },
      { sessionId: "s1", level: "xhigh" },
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
    expect(host.controls.slice(-2)).toEqual([
      { sessionId: "s1", provider: "custom", modelId: "local" },
      { sessionId: "s1", level: "high" },
    ]);
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

  it("records a bounded MRU without rewriting an unchanged order", async () => {
    const patches: Record<string, unknown>[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
      if (url.startsWith("/api/sessions"))
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
      if (url.startsWith("/api/control/model")) return { body: { ok: true } };
      if (url.startsWith("/api/snapshot"))
        return {
          body: activeSnapshot({ model: { provider: "openai", id: "gpt-5" } }),
        };
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

    await store.setModel("openai", "gpt-5");
    await vi.waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      recentModelIds: [{ provider: "openai", id: "gpt-5" }],
    });
    expect(store.getState().prefs.recentModelIds).toEqual([
      { provider: "openai", id: "gpt-5" },
    ]);

    await store.setModel("openai", "gpt-5");
    expect(patches).toHaveLength(1);
    expect(store.getState().prefs.recentModelIds).toEqual([
      { provider: "openai", id: "gpt-5" },
    ]);
  });

  it("keeps formerly colliding NUL-containing identities distinct in the MRU", async () => {
    const patches: Record<string, unknown>[] = [];
    let selected = { provider: "a\u0000b", id: "c" };
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
      if (url.startsWith("/api/sessions"))
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
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
      if (url.startsWith("/api/sessions"))
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
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
