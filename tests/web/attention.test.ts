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
  sessionSummary,
} from "./helpers";

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(
    async (): Promise<NotificationPermission> => FakeNotification.permission,
  );
  static instances: FakeNotification[] = [];
  onclick: ((event: Event) => void) | null = null;
  close = vi.fn();
  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    FakeNotification.instances.push(this);
  }
}

function attentionRoutes(
  preference: "off" | "title" | "desktop",
  onPatch?: (value: Record<string, unknown>) => void,
  background = sessionSummary({
    id: "bg",
    title: "Background work",
    cwd: "/safe/project",
    project: "project",
  }),
) {
  return (url: string, init: RequestInit) => {
    if (url.startsWith("/api/bootstrap")) {
      return {
        body: bootstrapPayload({
          preferences: {
            ...bootstrapPayload().preferences,
            completionAttention: preference,
          },
          snapshot: activeSnapshot(),
        }),
      };
    }
    if (url.startsWith("/api/sessions/open")) {
      return {
        body: activeSnapshot({
          sessionId: String(jsonBody(init).id),
          sessionName: "Background work",
        }),
      };
    }
    if (url.startsWith("/api/sessions")) {
      return {
        body: { sessions: [background], total: 1, offset: 0, limit: 40 },
      };
    }
    if (url.startsWith("/api/preferences")) {
      const patch = jsonBody(init);
      onPatch?.(patch);
      return {
        body: {
          ...bootstrapPayload().preferences,
          completionAttention: preference,
          ...patch,
        },
      };
    }
    return undefined;
  };
}

async function initialized(preference: "off" | "title" | "desktop") {
  installFetch(attentionRoutes(preference));
  const store = new AppStore();
  await store.init("token");
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  await vi.waitFor(() =>
    expect(
      store.getState().sessions.some((session) => session.id === "bg"),
    ).toBe(true),
  );
  return { store, socket };
}

function visibleFocused(value: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: value ? "visible" : "hidden",
  });
  Object.defineProperty(document, "hasFocus", {
    configurable: true,
    value: vi.fn(() => value),
  });
}

describe("completion attention", () => {
  beforeEach(() => {
    installFakeWebSocket();
    FakeNotification.instances = [];
    FakeNotification.permission = "granted";
    FakeNotification.requestPermission.mockClear();
    vi.stubGlobal("Notification", FakeNotification);
    visibleFocused(true);
  });

  it("never notifies visible selected work and ignores duplicate or historical settles", async () => {
    const { socket } = await initialized("desktop");
    socket.emit({
      type: "agent_settled",
      sessionId: "bg",
      sessionStatus: { runState: "idle" },
    });
    socket.emit({
      type: "agent_start",
      sessionId: "s1",
      sessionStatus: { runState: "running", indicator: "running" },
    });
    socket.emit({
      type: "agent_settled",
      sessionId: "s1",
      sessionStatus: { runState: "idle" },
    });
    expect(FakeNotification.instances).toHaveLength(0);

    socket.emit({
      type: "agent_start",
      sessionId: "bg",
      sessionStatus: { runState: "running", indicator: "running" },
    });
    socket.emit({
      type: "agent_settled",
      sessionId: "bg",
      sessionStatus: { runState: "failed", indicator: "failed" },
    });
    socket.emit({
      type: "agent_settled",
      sessionId: "bg",
      sessionStatus: { runState: "failed", indicator: "failed" },
    });
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]).toMatchObject({
      title: "Task failed",
    });
    expect(FakeNotification.instances[0]!.options?.body).toBe(
      "Project: project",
    );
    expect(FakeNotification.instances[0]!.options?.body).not.toContain(
      "prompt",
    );
  });

  it("never projects a catalog fallback title derived from the first prompt into OS fields", async () => {
    const secret = "SECRET_PROMPT_DO_NOT_NOTIFY";
    // session-catalog.test.ts proves the real unnamed-record projection uses
    // firstMessage here; this browser boundary must still treat it as secret.
    const summary = sessionSummary({
      id: "bg",
      cwd: "/safe/research-project",
      project: "research-project",
      title: secret,
    });
    expect(summary.title).toBe(secret);

    installFetch(attentionRoutes("desktop", undefined, summary));
    const store = new AppStore();
    await store.init("token");
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    await vi.waitFor(() =>
      expect(store.getState().sessions).toContainEqual(summary),
    );
    socket.emit({
      type: "agent_start",
      sessionId: "bg",
      sessionStatus: { runState: "running", indicator: "running" },
    });
    socket.emit({
      type: "agent_settled",
      sessionId: "bg",
      sessionStatus: { runState: "idle", indicator: "completed" },
    });

    expect(FakeNotification.instances).toHaveLength(1);
    const notification = FakeNotification.instances[0]!;
    expect(notification.title).toBe("Task completed");
    expect(notification.options).toMatchObject({
      body: "Project: research-project",
      tag: "inspire-task:bg:completed",
    });
    expect(
      JSON.stringify({
        title: notification.title,
        options: notification.options,
      }),
    ).not.toContain(secret);
  });

  it("keeps automatic compaction inside its agent arm and notifies only on settle", async () => {
    const { socket } = await initialized("desktop");
    socket.emit({
      type: "agent_start",
      sessionId: "bg",
      sessionStatus: { runState: "running", indicator: "running" },
    });
    socket.emit({
      type: "compaction_start",
      sessionId: "bg",
      reason: "threshold",
      sessionStatus: { runState: "compacting", indicator: "running" },
    });
    socket.emit({
      type: "compaction_end",
      sessionId: "bg",
      reason: "threshold",
      result: { tokensBefore: 100 },
      aborted: false,
      willRetry: false,
      sessionStatus: { runState: "running", indicator: "running" },
    });
    // Even a manual compaction event nested in the observed run remains owned
    // by that agent operation rather than creating a second terminal arm.
    socket.emit({
      type: "compaction_start",
      sessionId: "bg",
      reason: "manual",
      sessionStatus: { runState: "compacting", indicator: "running" },
    });
    socket.emit({
      type: "compaction_end",
      sessionId: "bg",
      reason: "manual",
      result: { tokensBefore: 80 },
      aborted: false,
      willRetry: false,
      sessionStatus: { runState: "running", indicator: "running" },
    });
    expect(FakeNotification.instances).toHaveLength(0);

    socket.emit({
      type: "agent_settled",
      sessionId: "bg",
      sessionStatus: { runState: "idle", indicator: "completed" },
    });
    socket.emit({
      type: "compaction_end",
      sessionId: "bg",
      reason: "threshold",
      result: { tokensBefore: 100 },
      aborted: false,
      willRetry: false,
      sessionStatus: { runState: "idle" },
    });
    socket.emit({
      type: "agent_settled",
      sessionId: "bg",
      sessionStatus: { runState: "idle", indicator: "completed" },
    });
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.title).toBe("Task completed");
  });

  it("notifies a standalone manual compaction exactly once and does not misattribute a later settle", async () => {
    const { socket } = await initialized("desktop");
    socket.emit({
      type: "compaction_start",
      sessionId: "bg",
      reason: "manual",
      sessionStatus: { runState: "compacting", indicator: "running" },
    });
    socket.emit({
      type: "compaction_end",
      sessionId: "bg",
      reason: "manual",
      result: { tokensBefore: 100 },
      aborted: false,
      willRetry: false,
      sessionStatus: { runState: "idle", indicator: "completed" },
    });
    socket.emit({
      type: "compaction_end",
      sessionId: "bg",
      reason: "manual",
      result: { tokensBefore: 100 },
      aborted: false,
      willRetry: false,
      sessionStatus: { runState: "idle", indicator: "completed" },
    });
    socket.emit({
      type: "agent_settled",
      sessionId: "bg",
      sessionStatus: { runState: "idle", indicator: "completed" },
    });
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.title).toBe("Task completed");
  });

  it("clears a lost-stream agent arm before a later standalone compaction", async () => {
    const { store, socket } = await initialized("desktop");
    vi.useFakeTimers();
    try {
      socket.emit({
        type: "agent_start",
        sessionId: "bg",
        sessionStatus: { runState: "running", indicator: "running" },
      });
      socket.onclose?.();
      expect(store.getState().connection).toBe("reconnecting");

      // Model the reconnect immediately; init applies its authoritative idle
      // bootstrap before attaching the replacement event stream.
      await store.init("token");
      const reconnected = FakeWebSocket.instances.at(-1)!;
      expect(reconnected).not.toBe(socket);
      reconnected.open();
      reconnected.emit({
        type: "compaction_start",
        sessionId: "bg",
        reason: "manual",
        sessionStatus: { runState: "compacting", indicator: "running" },
      });
      reconnected.emit({
        type: "compaction_end",
        sessionId: "bg",
        reason: "manual",
        result: { tokensBefore: 100 },
        aborted: false,
        willRetry: false,
        sessionStatus: { runState: "idle", indicator: "completed" },
      });
      reconnected.emit({
        type: "agent_settled",
        sessionId: "bg",
        sessionStatus: { runState: "idle", indicator: "completed" },
      });
      expect(FakeNotification.instances).toHaveLength(1);
      expect(FakeNotification.instances[0]!.title).toBe("Task completed");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("lets an authoritative selected idle snapshot retire a missing settle without suppressing later compaction", async () => {
    const { socket } = await initialized("desktop");
    visibleFocused(false);
    socket.emit({
      type: "agent_start",
      sessionId: "s1",
      sessionStatus: { runState: "running", indicator: "running" },
    });
    socket.emit({ type: "snapshot", data: activeSnapshot() });

    socket.emit({
      type: "compaction_start",
      sessionId: "s1",
      reason: "manual",
      sessionStatus: { runState: "compacting", indicator: "running" },
    });
    socket.emit({
      type: "compaction_end",
      sessionId: "s1",
      reason: "manual",
      result: { tokensBefore: 100 },
      aborted: false,
      willRetry: false,
      sessionStatus: { runState: "idle", indicator: "completed" },
    });
    socket.emit({
      type: "agent_settled",
      sessionId: "s1",
      sessionStatus: { runState: "idle", indicator: "completed" },
    });
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.title).toBe("Task completed");
  });

  it("retains an observed agent arm across a matching active authoritative snapshot", async () => {
    const { socket } = await initialized("desktop");
    socket.emit({
      type: "agent_start",
      sessionId: "bg",
      sessionStatus: { runState: "running", indicator: "running" },
    });
    const snapshot = activeSnapshot();
    snapshot.sessionStatuses.bg = { runState: "running", indicator: "running" };
    socket.emit({ type: "snapshot", data: snapshot });
    socket.emit({
      type: "agent_settled",
      sessionId: "bg",
      sessionStatus: { runState: "idle", indicator: "completed" },
    });
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.title).toBe("Task completed");
  });

  it("reports a standalone compaction failure from its terminal event fields", async () => {
    const { socket } = await initialized("desktop");
    socket.emit({
      type: "compaction_start",
      sessionId: "bg",
      reason: "manual",
      sessionStatus: { runState: "compacting", indicator: "running" },
    });
    socket.emit({
      type: "compaction_end",
      sessionId: "bg",
      reason: "manual",
      aborted: false,
      willRetry: false,
      errorMessage: "compaction failed",
      sessionStatus: { runState: "idle", indicator: "failed" },
    });
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.title).toBe("Task failed");
  });

  it("does not infer attention from bootstrap or resync run status", async () => {
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap")) {
        const snapshot = activeSnapshot();
        snapshot.runState = "running";
        snapshot.sessionStatuses.s1 = {
          runState: "running",
          indicator: "running",
        };
        return {
          body: bootstrapPayload({
            preferences: {
              ...bootstrapPayload().preferences,
              completionAttention: "desktop",
            },
            snapshot,
          }),
        };
      }
      if (url.startsWith("/api/sessions"))
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
      return undefined;
    });
    const store = new AppStore();
    await store.init("token");
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.emit({
      type: "agent_settled",
      sessionId: "s1",
      sessionStatus: { runState: "idle" },
    });
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("notifies selected work only when its tab is hidden", async () => {
    const { socket } = await initialized("desktop");
    visibleFocused(false);
    socket.emit({
      type: "agent_start",
      sessionId: "s1",
      sessionStatus: { runState: "running", indicator: "running" },
    });
    socket.emit({
      type: "agent_settled",
      sessionId: "s1",
      sessionStatus: { runState: "aborted" },
    });
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.title).toBe("Task aborted");
  });

  it("marks unseen title attention and clears it on the owning view", async () => {
    const { store, socket } = await initialized("title");
    socket.emit({
      type: "agent_start",
      sessionId: "bg",
      sessionStatus: { runState: "running", indicator: "running" },
    });
    socket.emit({
      type: "agent_settled",
      sessionId: "bg",
      sessionStatus: { runState: "idle", indicator: "completed" },
    });
    expect(store.getState().attentionSessionIds).toEqual(["bg"]);

    await store.openSession("bg");
    store.acknowledgeVisibleSession();
    expect(store.getState().attentionSessionIds).toEqual([]);
  });

  it("focuses and selects the owning session from a notification click", async () => {
    const { store, socket } = await initialized("desktop");
    const focus = vi.fn();
    Object.defineProperty(window, "focus", {
      configurable: true,
      value: focus,
    });
    socket.emit({
      type: "agent_start",
      sessionId: "bg",
      sessionStatus: { runState: "running", indicator: "running" },
    });
    socket.emit({
      type: "agent_settled",
      sessionId: "bg",
      sessionStatus: { runState: "idle", indicator: "completed" },
    });
    expect(store.getState().attentionSessionIds).toEqual(["bg"]);
    FakeNotification.instances[0]!.onclick?.(new Event("click"));
    expect(focus).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(store.getState().sessionId).toBe("bg"));
    expect(store.getState().attentionSessionIds).toEqual([]);
    expect(FakeNotification.instances[0]!.close).toHaveBeenCalledOnce();
  });

  it("requests desktop permission only from the explicit setting action and preserves intent on denial", async () => {
    const patches: Record<string, unknown>[] = [];
    installFetch(attentionRoutes("off", (patch) => patches.push(patch)));
    const store = new AppStore();
    await store.init("token");
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();

    FakeNotification.permission = "denied";
    expect(await store.setCompletionAttention("desktop")).toBe(false);
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
    expect(store.getState().prefs.completionAttention).toBe("off");
    expect(patches).toEqual([]);
    expect(store.getState().error).toBeNull();
    expect(
      store
        .getState()
        .notices.some(
          (notice) => notice.kind === "warning" && /denied/.test(notice.text),
        ),
    ).toBe(true);
  });

  it("persists desktop intent after permission is granted", async () => {
    const patches: Record<string, unknown>[] = [];
    installFetch(attentionRoutes("off", (patch) => patches.push(patch)));
    const store = new AppStore();
    await store.init("token");
    FakeNotification.permission = "default";
    FakeNotification.requestPermission.mockResolvedValueOnce("granted");
    expect(await store.setCompletionAttention("desktop")).toBe(true);
    await vi.waitFor(() =>
      expect(patches).toContainEqual({ completionAttention: "desktop" }),
    );
    expect(store.getState().prefs.completionAttention).toBe("desktop");
  });

  it("does not let a delayed desktop permission result overwrite newer intent", async () => {
    const patches: Record<string, unknown>[] = [];
    installFetch(attentionRoutes("off", (patch) => patches.push(patch)));
    const store = new AppStore();
    await store.init("token");
    let resolvePermission!: (permission: NotificationPermission) => void;
    FakeNotification.permission = "default";
    FakeNotification.requestPermission.mockImplementationOnce(
      () =>
        new Promise<NotificationPermission>((resolve) => {
          resolvePermission = resolve;
        }),
    );

    const desktop = store.setCompletionAttention("desktop");
    await vi.waitFor(() =>
      expect(FakeNotification.requestPermission).toHaveBeenCalledOnce(),
    );
    await expect(store.setCompletionAttention("title")).resolves.toBe(true);
    resolvePermission("granted");
    await expect(desktop).resolves.toBe(false);
    await vi.waitFor(() =>
      expect(patches).toContainEqual({ completionAttention: "title" }),
    );

    expect(patches).not.toContainEqual({ completionAttention: "desktop" });
    expect(store.getState().prefs.completionAttention).toBe("title");
  });

  it("reports an unsupported Notification API without changing the preference", async () => {
    const { store } = await initialized("off");
    vi.stubGlobal("Notification", undefined);
    expect(await store.setCompletionAttention("desktop")).toBe(false);
    expect(store.getState().prefs.completionAttention).toBe("off");
    expect(store.getState().error).toBeNull();
    expect(
      store
        .getState()
        .notices.some(
          (notice) =>
            notice.kind === "warning" && /not supported/.test(notice.text),
        ),
    ).toBe(true);
  });
});
