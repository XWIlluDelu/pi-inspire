// @vitest-environment jsdom
import { MessageChannel } from "node:worker_threads";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskNotificationController } from "../../src/notifications";
import { AppStore } from "../../src/store";
import { sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  type RouteResponse,
  sessionSummary,
} from "./helpers";

class Permission {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(
    async (): Promise<NotificationPermission> => "granted",
  );
}
let workerMessages: Record<string, unknown>[];
let subscription: {
  toJSON(): object;
  unsubscribe(): Promise<boolean>;
  options: object;
} | null;
let worker: EventTarget;
const publicKey =
  "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const subscribe = vi.fn(async () => subscription!);
let mode: "off" | "title" | "desktop";
let subscribed: boolean;
let subscriptionEndpoint: string;
let mutations: Record<string, unknown>[];
let acknowledgments: string[];

function visibleFocused(value: boolean) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: value ? "visible" : "hidden",
  });
  Object.defineProperty(document, "hasFocus", {
    configurable: true,
    value: () => value,
  });
}
async function initialized(
  choice: typeof mode = "desktop",
  open?: (id: string) => RouteResponse | Promise<RouteResponse>,
  existingStore?: AppStore,
) {
  mode = choice;
  installFetch((url, init) => {
    if (url === "/api/notifications") {
      if (init.method === "PUT") {
        const body = jsonBody(init);
        mutations.push(body);
        if (body.mode !== undefined) mode = body.mode as typeof mode;
        if (body.subscription !== undefined)
          subscribed = mode === "desktop" && Boolean(body.subscription);
        if (body.subscription)
          subscriptionEndpoint = (body.subscription as { endpoint: string })
            .endpoint;
      }
      return {
        body: {
          installationId: "device-one",
          mode,
          subscribed,
          endpoint: subscribed ? subscriptionEndpoint : null,
          publicKey,
          error: null,
        },
      };
    }
    if (url === "/api/notifications/ack") {
      acknowledgments.push(String(jsonBody(init).id));
      return { body: { ok: true } };
    }
    if (url === "/api/notifications/test")
      return { body: { transport: subscribed ? "push" : "page" } };
    if (url.startsWith("/api/bootstrap"))
      return {
        body: bootstrapPayload({
          snapshot: activeSnapshot(),
          preferences: {
            ...bootstrapPayload().preferences,
            completionAttention: "off",
          },
        }),
      };
    if (url.startsWith("/api/sessions/open"))
      return open
        ? open(String(jsonBody(init).id))
        : { body: activeSnapshot({ sessionId: String(jsonBody(init).id) }) };
    if (url.startsWith("/api/sessions"))
      return {
        body: sessionPage(
          [
            sessionSummary({
              id: "bg",
              title: "PRIVATE FIRST PROMPT",
              project: "research-project",
              cwd: "/safe/research-project",
            }),
          ],
          1,
        ),
      };
    return undefined;
  });
  const store = existingStore ?? new AppStore();
  await store.init("token");
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  return { store, socket };
}
function outcome(socket: FakeWebSocket, id = "outcome-one", sessionId = "bg") {
  socket.emit({
    type: "task_notification",
    notification: {
      id,
      sessionId,
      outcome: "failed",
      project: "research-project",
      createdAt: Date.now(),
    },
  });
}

beforeEach(() => {
  installFakeWebSocket();
  vi.stubGlobal("Notification", Permission);
  vi.stubGlobal("MessageChannel", MessageChannel);
  Permission.permission = "granted";
  Permission.requestPermission.mockReset().mockResolvedValue("granted");
  workerMessages = [];
  mutations = [];
  acknowledgments = [];
  subscribed = false;
  subscriptionEndpoint = "https://fcm.googleapis.com/endpoint";
  subscription = {
    toJSON: () => ({
      expirationTime: null,
      endpoint: "https://fcm.googleapis.com/endpoint",
      keys: { auth: "key", p256dh: "key" },
    }),
    unsubscribe: vi.fn(async () => true),
    options: {},
  };
  worker = new EventTarget();
  const registration = {
    active: {
      postMessage: (message: Record<string, unknown>, ports: MessagePort[]) => {
        workerMessages.push(message);
        ports[0]!.postMessage({ ok: true });
        ports[0]!.close();
      },
    },
    pushManager: { getSubscription: async () => null, subscribe },
  };
  subscribe.mockClear();
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: Object.assign(worker, {
      ready: Promise.resolve(registration),
      getRegistration: async () => registration,
    }),
  });
  sessionStorage.clear();
  visibleFocused(true);
});

describe("device-local task alerts", () => {
  it("delivers Host outcomes without a browser start event, including after transport replacement", async () => {
    const { store, socket } = await initialized();
    outcome(socket);
    await vi.waitFor(() => expect(acknowledgments).toEqual(["outcome-one"]));
    expect(workerMessages).toHaveLength(1);
    expect(store.getState().attentionSessionIds).toEqual(["bg"]);
    expect(JSON.stringify(workerMessages)).not.toContain(
      "PRIVATE FIRST PROMPT",
    );
    expect(workerMessages[0]).toMatchObject({
      type: "inspire-notification-display",
      notification: { outcome: "failed", project: "research-project" },
    });
    await store.init("token");
    const replacement = FakeWebSocket.instances.at(-1)!;
    replacement.open();
    outcome(replacement, "outcome-two");
    await vi.waitFor(() => expect(acknowledgments).toContain("outcome-two"));
    expect(workerMessages).toHaveLength(2);
  });

  it("acknowledges viewed work without display and keeps title-only attention local", async () => {
    const { store, socket } = await initialized("title");
    outcome(socket, "viewed", "s1");
    outcome(socket, "unseen");
    await vi.waitFor(() => expect(acknowledgments).toHaveLength(2));
    expect(workerMessages).toEqual([]);
    expect(store.getState().attentionSessionIds).toEqual(["bg"]);
    await store.openSession("bg");
    store.acknowledgeVisibleSession();
    expect(store.getState().attentionSessionIds).toEqual([]);
  });

  it("opens the owning conversation from worker clicks and retains a cold-launch target", async () => {
    const { store } = await initialized();
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "inspire-notification-open", sessionId: "bg" },
      }),
    );
    await vi.waitFor(() => expect(store.getState().sessionId).toBe("bg"));
    expect(sessionStorage.getItem("inspire-notification-target")).toBeNull();

    history.replaceState(null, "", "/#inspire-session=s1");
    store.captureNotificationTarget();
    expect(location.hash).toBe("");
    expect(sessionStorage.getItem("inspire-notification-target")).toBe("s1");
    await store.init("token");
    FakeWebSocket.instances.at(-1)!.open();
    await vi.waitFor(() => expect(store.getState().sessionId).toBe("s1"));
  });

  it("keeps an unavailable click target, supersedes slow clicks, and explains a deleted target", async () => {
    const slow = deferred<RouteResponse>();
    const opened: string[] = [];
    let unavailable = true;
    const { store } = await initialized("desktop", async (id) => {
      opened.push(id);
      if (id === "slow") return slow.promise;
      if (id === "bg" && unavailable)
        return { status: 503, body: { error: "Host temporarily unavailable" } };
      if (id === "deleted")
        return {
          status: 404,
          body: {
            code: "SESSION_NOT_FOUND",
            error: "This session was deleted",
          },
        };
      return { body: activeSnapshot({ sessionId: id }) };
    });
    const click = (id: string) =>
      worker.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "inspire-notification-open", sessionId: id },
        }),
      );
    click("bg");
    await vi.waitFor(() =>
      expect(store.getState().sessionActionError).toContain(
        "temporarily unavailable",
      ),
    );
    expect(sessionStorage.getItem("inspire-notification-target")).toBe("bg");
    unavailable = false;
    await store.init("token");
    FakeWebSocket.instances.at(-1)!.open();
    await vi.waitFor(() => expect(store.getState().sessionId).toBe("bg"));

    click("slow");
    await vi.waitFor(() => expect(opened).toContain("slow"));
    click("latest");
    await vi.waitFor(() => expect(store.getState().sessionId).toBe("latest"));
    slow.resolve({ body: activeSnapshot({ sessionId: "slow" }) });
    await vi.waitFor(() =>
      expect(sessionStorage.getItem("inspire-notification-target")).toBeNull(),
    );
    expect(store.getState().sessionId).toBe("latest");
    click("deleted");
    await vi.waitFor(() =>
      expect(store.getState().sessionActionError).toBe(
        "This session was deleted",
      ),
    );
    expect(sessionStorage.getItem("inspire-notification-target")).toBeNull();
    expect(store.getState().sessionId).toBe("latest");
  });

  it("retains a worker click received on the pairing screen", async () => {
    const store = new AppStore();
    store.captureNotificationTarget();
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "inspire-notification-open", sessionId: "bg" },
      }),
    );
    expect(sessionStorage.getItem("inspire-notification-target")).toBe("bg");
    await initialized("desktop", undefined, store);
    await vi.waitFor(() => expect(store.getState().sessionId).toBe("bg"));
  });

  it("applies this installation's shared setting before consuming an outcome", async () => {
    const { store, socket } = await initialized("off");
    socket.emit({
      type: "task_alert_settings",
      settings: {
        installationId: "device-one",
        mode: "desktop",
        subscribed: true,
        publicKey,
        error: null,
      },
    });
    outcome(socket);
    await vi.waitFor(() => expect(workerMessages).toHaveLength(1));
    socket.emit({
      type: "task_alert_settings",
      settings: {
        installationId: "device-one",
        mode: "off",
        subscribed: false,
        publicKey,
        error: null,
      },
    });
    expect(store.getState().taskAlerts.mode).toBe("off");
    expect(store.getState().attentionSessionIds).toEqual([]);
  });

  it("requests permission only on a gesture, stores this device's intent, and keeps denial visible", async () => {
    const { store } = await initialized("off");
    expect(Permission.requestPermission).not.toHaveBeenCalled();
    Permission.permission = "default";
    Permission.requestPermission.mockResolvedValueOnce("denied");
    await expect(store.setCompletionAttention("desktop")).resolves.toBe(false);
    expect(store.getState().taskAlerts).toMatchObject({
      mode: "desktop",
      permission: "denied",
      busy: false,
    });
    expect(store.getState().prefs.completionAttention).toBe("off");
    expect(mutations).toEqual([{ mode: "desktop", subscription: null }]);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("enrolls for background delivery and tests the actual configured transport", async () => {
    const { store } = await initialized("off");
    Permission.permission = "default";
    await expect(store.setCompletionAttention("desktop")).resolves.toBe(true);
    expect(Permission.requestPermission).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(store.getState().taskAlerts.subscribed).toBe(true);
    expect(mutations.at(-1)?.subscription).not.toHaveProperty("expirationTime");
    await store.testTaskNotification();
    expect(store.getState().taskAlerts.testResult).toContain(
      "Sent to the browser push service",
    );
  });

  it.each(["resolves", "rejects"] as const)(
    "keeps another window's Off choice when pending enrollment %s",
    async (settlement) => {
      const { store, socket } = await initialized("off");
      const pending = deferred<NonNullable<typeof subscription>>();
      subscribe.mockReturnValueOnce(pending.promise);
      const enabling = store.setCompletionAttention("desktop");
      await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());

      // Another window writes Off while this one waits on the push service.
      mode = "off";
      subscribed = false;
      socket.emit({
        type: "task_alert_settings",
        settings: {
          installationId: "device-one",
          mode,
          subscribed,
          publicKey,
          error: null,
        },
      });
      if (settlement === "resolves") pending.resolve(subscription!);
      else pending.reject(new Error("Push setup failed"));
      await expect(enabling).resolves.toBe(false);

      expect(mode).toBe("off");
      expect(subscribed).toBe(false);
      expect(store.getState().taskAlerts).toMatchObject({
        mode: "off",
        subscribed: false,
        busy: false,
        error: null,
      });
      if (settlement === "resolves")
        expect(subscription!.unsubscribe).toHaveBeenCalledOnce();
    },
  );

  it("leaves a healthy subscription alone and repairs rotation without rewriting intent", async () => {
    const { store } = await initialized();
    subscribed = true;
    const local = {
      endpoint: subscriptionEndpoint,
      expirationTime: null,
      getKey: () => null,
      unsubscribe: async () => true,
      options: {
        userVisibleOnly: true,
        applicationServerKey: Uint8Array.from(atob(publicKey), (ch) =>
          ch.charCodeAt(0),
        ).buffer,
      },
      toJSON: () => ({
        endpoint: local.endpoint,
        keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
      }),
    };
    const registration = (await navigator.serviceWorker.getRegistration())!;
    vi.spyOn(registration.pushManager, "getSubscription").mockResolvedValue(
      local,
    );
    await store.refreshTaskAlerts();
    expect(mutations).toEqual([]);
    local.endpoint += "-rotated";
    await store.refreshTaskAlerts();
    expect(mutations).toEqual([{ subscription: local.toJSON() }]);
    expect(store.getState().taskAlerts).toMatchObject({
      mode: "desktop",
      subscribed: true,
    });
  });

  it("refreshes enrollment health when the browser has lost its subscription", async () => {
    const { store } = await initialized("desktop");
    await store.setCompletionAttention("desktop");
    expect(store.getState().taskAlerts.subscribed).toBe(true);
    await store.refreshTaskAlerts();
    expect(store.getState().taskAlerts.subscribed).toBe(false);
    expect(mutations.at(-1)).toEqual({ subscription: null });
  });

  it("does not let delayed permission overwrite a newer Off choice", async () => {
    const { store } = await initialized("off");
    const permission = deferred<NotificationPermission>();
    Permission.permission = "default";
    Permission.requestPermission.mockReturnValueOnce(permission.promise);
    const old = store.setCompletionAttention("desktop");
    await store.setCompletionAttention("off");
    permission.resolve("granted");
    await expect(old).resolves.toBe(false);
    expect(store.getState().taskAlerts.mode).toBe("off");
    expect(mutations).toEqual([{ mode: "off", subscription: null }]);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it.each(["resolves", "rejects"] as const)(
    "retires a pending page display when alerts are disabled before worker readiness %s",
    async (settlement) => {
      const { store, socket } = await initialized();
      const registration = await navigator.serviceWorker.ready;
      const ready = deferred<ServiceWorkerRegistration>();
      const waiting = vi.fn(() => ready.promise);
      Object.defineProperty(navigator.serviceWorker, "ready", {
        configurable: true,
        get: waiting,
      });
      const receive = vi.spyOn(TaskNotificationController.prototype, "receive");
      outcome(socket, "before-disable");
      expect(waiting).toHaveBeenCalledOnce();
      const pending = receive.mock.results[0]!.value as Promise<void>;

      await store.setCompletionAttention("off");
      if (settlement === "resolves") ready.resolve(registration);
      else ready.reject(new Error("Worker startup failed"));
      await pending;

      expect(workerMessages).toEqual([]);
      expect(store.getState().taskAlerts).toMatchObject({
        mode: "off",
        error: null,
      });
    },
  );

  it("leaves a failed display unacknowledged for Host push fallback", async () => {
    const { store, socket } = await initialized();
    const registration = await navigator.serviceWorker.ready;
    vi.spyOn(registration.active!, "postMessage").mockImplementation(
      (_data, transfer) => {
        const port = (transfer as MessagePort[])[0]!;
        port.postMessage({ error: "Display refused" });
        port.close();
      },
    );
    visibleFocused(false);
    outcome(socket, "display-failed", "s1");
    await vi.waitFor(() =>
      expect(store.getState().taskAlerts.error).toBe("Display refused"),
    );
    expect(acknowledgments).toEqual([]);
  });
});
