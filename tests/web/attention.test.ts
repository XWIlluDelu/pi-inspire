// @vitest-environment jsdom
import { MessageChannel } from "node:worker_threads";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskAlertSettings } from "../../shared/notifications";
import { createApi } from "../../src/api";
import { createInitialAppState } from "../../src/app-state";
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
  type RouteHandler,
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
let workerSettings: Record<string, unknown>[];
let subscription: {
  toJSON(): object;
  unsubscribe(): Promise<boolean>;
  options: object;
} | null;
let worker: EventTarget;
const publicKey =
  "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const subscribe = vi.fn(async () => subscription!);
let hostPublicKey = publicKey;
let mode: "off" | "title" | "desktop";
let grouping: "session" | "project";
let groupingUpdatedAt: number;
let subscribed: boolean;
let subscriptionEndpoint: string;
let expiredEndpoint: string | null;
let mutations: Record<string, unknown>[];
let acknowledgments: string[];
let testResponse: Promise<RouteResponse> | undefined;

function hostSettings(
  overrides: Partial<TaskAlertSettings> = {},
): TaskAlertSettings {
  return {
    mode,
    grouping,
    groupingUpdatedAt,
    subscribed,
    endpoint: subscribed ? subscriptionEndpoint : expiredEndpoint,
    publicKey: hostPublicKey,
    error: null,
    ...overrides,
  };
}

function browserSubscription(endpoint = subscriptionEndpoint) {
  const local = {
    endpoint,
    expirationTime: null,
    getKey: () => null,
    unsubscribe: vi.fn(async () => true),
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
  return local;
}

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
const notificationRoutes: RouteHandler = (url, init) => {
  if (url === "/api/notifications") {
    if (init.method === "PUT") {
      const body = jsonBody(init);
      mutations.push(body);
      if (body.mode !== undefined) mode = body.mode as typeof mode;
      if (body.grouping !== undefined && body.grouping !== grouping) {
        grouping = body.grouping as typeof grouping;
        groupingUpdatedAt++;
      }
      if (body.subscription !== undefined)
        subscribed = mode === "desktop" && Boolean(body.subscription);
      if (body.subscription)
        subscriptionEndpoint = (body.subscription as { endpoint: string })
          .endpoint;
    }
    return { body: hostSettings() };
  }
  if (url === "/api/notifications/ack") {
    acknowledgments.push(String(jsonBody(init).id));
    return { body: { ok: true } };
  }
  if (url === "/api/notifications/test")
    return (
      testResponse ?? { body: { transport: subscribed ? "push" : "page" } }
    );
};

async function notificationController(choice: typeof mode = "desktop") {
  mode = choice;
  installFetch(notificationRoutes);
  const api = createApi();
  let state = createInitialAppState();
  const controller = new TaskNotificationController({
    state: () => state,
    patch: (patch) => {
      state = { ...state, ...patch };
    },
    api: () => api,
    mark: vi.fn(),
    clear: vi.fn(),
    openSession: vi.fn(),
  });
  await controller.initialize();
  return { controller, alerts: () => state.taskAlerts };
}

async function initialized(
  choice: typeof mode = "desktop",
  open?: (id: string) => RouteResponse | Promise<RouteResponse>,
  existingStore?: AppStore,
  refresh = true,
) {
  mode = choice;
  installFetch((url, init) => {
    const route = notificationRoutes(url, init);
    if (route) return route;
    if (url.startsWith("/api/bootstrap"))
      return {
        body: bootstrapPayload({ startupSessionId: "s1" }),
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
  await store.init();
  // Most cases begin after a completed device-settings refresh. Startup tests
  // instead supply the real stream settings-before-offer sequence below.
  if (refresh) await store.refreshTaskAlerts();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.join(activeSnapshot());
  return { store, socket };
}
function failedOutcome(id: string, sessionId: string) {
  return {
    id,
    sessionId,
    outcome: "failed" as const,
    project: "research-project",
    createdAt: Date.now(),
  };
}

function outcome(socket: FakeWebSocket, id = "outcome-one", sessionId = "bg") {
  socket.emit({
    type: "task_notification",
    notification: failedOutcome(id, sessionId),
  });
}

beforeEach(() => {
  installFakeWebSocket();
  vi.stubGlobal("Notification", Permission);
  vi.stubGlobal("MessageChannel", MessageChannel);
  Permission.permission = "granted";
  Permission.requestPermission.mockReset().mockResolvedValue("granted");
  workerMessages = [];
  workerSettings = [];
  grouping = "session";
  groupingUpdatedAt = 0;
  hostPublicKey = publicKey;
  mutations = [];
  acknowledgments = [];
  testResponse = undefined;
  subscribed = false;
  subscriptionEndpoint = "https://fcm.googleapis.com/endpoint";
  expiredEndpoint = null;
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
        (message.type === "inspire-notification-settings"
          ? workerSettings
          : workerMessages
        ).push(message);
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
  it.each(["off", "title", "desktop"] as const)(
    "skips push lookup without permission when saved mode is %s",
    async (choice) => {
      Permission.permission = "default";
      subscribed = choice === "desktop";
      const registration = (await navigator.serviceWorker.getRegistration())!;
      const getSubscription = vi.spyOn(registration.pushManager, "getSubscription");
      const { alerts } = await notificationController(choice);
      expect(getSubscription).not.toHaveBeenCalled();
      expect(alerts()).toMatchObject({ mode: choice, subscribed: false });
      expect(mutations).toEqual(choice === "desktop" ? [{ subscription: null }] : []);
    },
  );

  it("opens the conversation and consumes the first offer while repairing existing Desktop enrollment", async () => {
    const enrollment = deferred<PushSubscription | null>();
    const registration = (await navigator.serviceWorker.getRegistration())!;
    const getSubscription = vi
      .spyOn(registration.pushManager, "getSubscription")
      .mockReturnValue(enrollment.promise);
    const local = browserSubscription();
    history.replaceState(null, "", "/#inspire-session=bg");
    const { store, socket } = await initialized(
      "desktop",
      undefined,
      undefined,
      false,
    );
    const transport = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await transport(input, init);
        if (String(input) === "/api/notifications" && init?.method === "PUT") {
          socket.emit({
            type: "task_alert_settings",
            settings: hostSettings(),
          });
        }
        return response;
      }),
    );

    socket.emit({ type: "task_alert_settings", settings: hostSettings() });
    outcome(socket, "first-offer", "other-session");
    await vi.waitFor(() => {
      expect(store.getState().connection).toBe("open");
      expect(store.getState().sessionId).toBe("bg");
      expect(store.getState().sessions.some(({ id }) => id === "bg")).toBe(
        true,
      );
      expect(acknowledgments).toContain("first-offer");
    });
    expect(workerMessages).toHaveLength(1);

    enrollment.resolve(local);
    await vi.waitFor(() =>
      expect(store.getState().taskAlerts).toMatchObject({
        mode: "desktop",
        subscribed: true,
        error: null,
      }),
    );
    expect(mutations).toEqual([{ subscription: local.toJSON() }]);
    expect(Permission.requestPermission).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();

    mutations = [];
    await store.refreshTaskAlerts();
    expect(mutations).toEqual([]);
    local.endpoint += "-rotated";
    await store.refreshTaskAlerts();
    expect(mutations).toEqual([{ subscription: local.toJSON() }]);

    getSubscription.mockResolvedValue(null);
    await store.refreshTaskAlerts();
    expect(mutations.at(-1)).toEqual({ subscription: null });
    expect(store.getState().taskAlerts).toMatchObject({
      mode: "desktop",
      subscribed: false,
    });
  });

  it.each(["this window", "another window", "a replacement Host"] as const)(
    "ignores a delayed permission grant after Off from %s",
    async (owner) => {
      const { store, socket } = await initialized("title");
      const permission = deferred<NotificationPermission>();
      Permission.permission = "default";
      Permission.requestPermission.mockReturnValueOnce(permission.promise);
      const enabling = store.setCompletionAttention("desktop");
      await vi.waitFor(() => expect(mode).toBe("desktop"));

      if (owner === "this window") await store.setCompletionAttention("off");
      else if (owner === "a replacement Host") {
        hostPublicKey = "replacement-host-public-key";
        await initialized("off", undefined, store);
      } else {
        // The earlier echo belongs to this window. The following Off was
        // accepted for the same installation after that write.
        socket.emit({ type: "task_alert_settings", settings: hostSettings() });
        mode = "off";
        socket.emit({ type: "task_alert_settings", settings: hostSettings() });
      }

      const accepted = [...mutations];
      permission.resolve("granted");
      await expect(enabling).resolves.toBe(false);
      if (owner === "another window") {
        expect(mutations.filter((change) => change.mode !== undefined)).toEqual(
          accepted,
        );
        expect(mode).toBe("off");
        expect(subscribed).toBe(false);
        expect(subscription!.unsubscribe).toHaveBeenCalledOnce();
      } else {
        expect(mutations).toEqual(accepted);
        expect(subscribe).not.toHaveBeenCalled();
      }
      expect(store.getState().taskAlerts).toMatchObject({
        mode: "off",
        subscribed: false,
        busy: false,
        error: null,
      });
    },
  );

  it("keeps a failed grouping choice until retry saves it independently of enrollment", async () => {
    const { controller, alerts } = await notificationController("off");
    let accept = false;
    installFetch((url, init) => {
      if (url !== "/api/notifications") return;
      if (init.method === "PUT") {
        mutations.push(jsonBody(init));
        if (!accept)
          return {
            status: 503,
            body: { error: "Host temporarily unavailable" },
          };
        grouping = "project";
        groupingUpdatedAt = 1;
      }
      return { body: hostSettings() };
    });

    await expect(controller.setGrouping("project")).resolves.toBe(false);
    controller.applySettings(hostSettings());
    await controller.initialize();
    worker.dispatchEvent(new Event("controllerchange"));
    await vi.waitFor(() =>
      expect(alerts()).toMatchObject({
        grouping: "project",
        groupingError: expect.stringContaining("unavailable"),
        groupingBusy: false,
      }),
    );
    expect(workerSettings.at(-1)).toMatchObject({ grouping: "session" });

    accept = true;
    await expect(controller.setGrouping("project")).resolves.toBe(true);
    await controller.initialize();
    expect(mutations).toEqual([
      { grouping: "project" },
      { grouping: "project" },
    ]);
    expect(alerts()).toMatchObject({
      mode: "off",
      grouping: "project",
      groupingError: null,
      groupingBusy: false,
    });
    expect(workerSettings.at(-1)).toMatchObject({
      owner: publicKey,
      grouping: "project",
      updatedAt: 1,
    });
    expect(Permission.requestPermission).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("reconciles worker replacement and ignores an older worker's late error", async () => {
    const { controller, alerts } = await notificationController("off");
    const registration = await navigator.serviceWorker.getRegistration();
    let oldReply: MessagePort | undefined;
    vi.spyOn(registration!.active!, "postMessage").mockImplementationOnce(
      (_message, ports) => {
        oldReply = (Array.isArray(ports) ? ports : ports?.transfer)?.[0] as
          | MessagePort
          | undefined;
      },
    );
    const oldRefresh = controller.initialize();
    await vi.waitFor(() => expect(oldReply).toBeDefined());
    worker.dispatchEvent(new Event("controllerchange"));
    await controller.initialize();
    oldReply!.postMessage({ error: "Retired worker error" });
    oldReply!.close();
    await oldRefresh;
    expect(alerts().groupingError).toBeNull();
  });

  it("accepts grouping updates in order within each Host", async () => {
    const { store, socket } = await initialized("off");
    const oldRead = deferred<RouteResponse>();
    installFetch((url, init) =>
      url === "/api/notifications"
        ? init.method === "PUT"
          ? {
              body: hostSettings({
                grouping: "project",
                groupingUpdatedAt: 10,
              }),
            }
          : oldRead.promise
        : undefined,
    );
    const refresh = store.refreshTaskAlerts();
    await store.setTaskNotificationGrouping("project");
    oldRead.resolve({ body: hostSettings() });
    await refresh;
    socket.emit({
      type: "task_alert_settings",
      settings: hostSettings(),
    });
    expect(store.getState().taskAlerts.grouping).toBe("project");
    expect(workerSettings.at(-1)).toMatchObject({
      grouping: "project",
      updatedAt: 10,
    });
    socket.emit({
      type: "task_alert_settings",
      settings: hostSettings({ groupingUpdatedAt: 20 }),
    });
    await vi.waitFor(() =>
      expect(workerSettings.at(-1)).toMatchObject({
        grouping: "session",
        updatedAt: 20,
      }),
    );
    expect(store.getState().taskAlerts.grouping).toBe("session");

    hostPublicKey = "replacement-host-public-key";
    grouping = "project";
    await initialized("off", undefined, store);
    expect(store.getState().taskAlerts).toMatchObject({
      grouping: "project",
      groupingUpdatedAt: 0,
    });
    expect(workerSettings.at(-1)).toMatchObject({
      owner: hostPublicKey,
      grouping: "project",
      updatedAt: 0,
    });
  });

  it("uses this installation's live settings and delivers outcomes after transport replacement", async () => {
    const { store, socket } = await initialized("off");
    mode = "desktop";
    socket.emit({ type: "task_alert_settings", settings: hostSettings() });
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
    await store.init();
    const replacement = FakeWebSocket.instances.at(-1)!;
    replacement.join(activeSnapshot());
    outcome(replacement, "outcome-two");
    await vi.waitFor(() => expect(acknowledgments).toContain("outcome-two"));
    expect(workerMessages).toHaveLength(2);

    mode = "off";
    replacement.emit({ type: "task_alert_settings", settings: hostSettings() });
    expect(store.getState().attentionSessionIds).toEqual([]);
    expect(store.getState().taskAlerts.mode).toBe("off");
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

  it("keeps a notification target through pairing and reconnect, then honors newer clicks", async () => {
    const slow = deferred<RouteResponse>();
    const opened: string[] = [];
    let unavailable = true;
    const click = (id: string) =>
      worker.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "inspire-notification-open", sessionId: id },
        }),
      );
    function open(id: string): RouteResponse | Promise<RouteResponse> {
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
    }
    const store = new AppStore();
    store.captureNotificationTarget();
    click("bg");
    await initialized("desktop", open, store);
    await vi.waitFor(() =>
      expect(store.getState().sessionActionError).toContain(
        "temporarily unavailable",
      ),
    );
    unavailable = false;
    await store.init();
    FakeWebSocket.instances.at(-1)!.join(activeSnapshot());
    await vi.waitFor(() => expect(store.getState().sessionId).toBe("bg"));

    click("slow");
    await vi.waitFor(() => expect(opened).toContain("slow"));
    click("latest");
    await vi.waitFor(() => expect(store.getState().sessionId).toBe("latest"));
    slow.resolve({ body: activeSnapshot({ sessionId: "slow" }) });
    // Let the earlier selection response reach the Store before checking which
    // conversation remains selected.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().sessionId).toBe("latest");
    click("deleted");
    await vi.waitFor(() =>
      expect(store.getState().sessionActionError).toBe(
        "This session was deleted",
      ),
    );
    expect(store.getState().sessionId).toBe("latest");
  });

  it("preserves alert intent after permission denial and reports test delivery after enrollment", async () => {
    Permission.permission = "default";
    const { controller, alerts } = await notificationController("off");
    expect(Permission.requestPermission).not.toHaveBeenCalled();
    Permission.requestPermission.mockImplementationOnce(async () => {
      Permission.permission = "denied";
      return "denied";
    });
    await expect(controller.setMode("desktop")).resolves.toBe(false);
    expect(alerts()).toMatchObject({
      mode: "desktop",
      permission: "denied",
      subscribed: false,
      busy: false,
    });
    expect(mode).toBe("desktop");
    expect(subscribe).not.toHaveBeenCalled();

    // The user unblocks notifications in their browser settings.
    Permission.permission = "granted";
    await expect(controller.setMode("desktop")).resolves.toBe(true);
    expect(Permission.requestPermission).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(alerts().subscribed).toBe(true);
    await controller.test();
    expect(alerts().testResult).toContain("Sent to the browser push service");

    const response = deferred<RouteResponse>();
    testResponse = response.promise;
    const pending = controller.test();
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "inspire-notification-shown", test: true },
      }),
    );
    response.resolve({ body: { transport: "push" } });
    await pending;
    expect(alerts().testResult).toBe(
      "Display request accepted. Check your system notifications.",
    );
  });

  it("ignores a retired notification test error after Off", async () => {
    const { controller, alerts } = await notificationController();
    const response = deferred<RouteResponse>();
    testResponse = response.promise;
    const pendingTest = controller.test();
    const local = browserSubscription();
    const unsubscribe = deferred<boolean>();
    local.unsubscribe.mockReturnValueOnce(unsubscribe.promise);
    const registration = (await navigator.serviceWorker.getRegistration())!;
    vi.spyOn(registration.pushManager, "getSubscription").mockResolvedValue(
      local,
    );

    const disabling = controller.setMode("off");
    await vi.waitFor(() => expect(local.unsubscribe).toHaveBeenCalledOnce());
    response.reject(new Error("Old notification test failed"));
    await pendingTest;

    expect(alerts()).toMatchObject({
      mode: "off",
      busy: true,
      error: null,
      testResult: null,
    });
    unsubscribe.resolve(true);
    await expect(disabling).resolves.toBe(true);
    expect(alerts().busy).toBe(false);
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
        settings: hostSettings(),
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

  it("replaces an expired browser subscription only when the user enables notifications", async () => {
    const { controller, alerts } = await notificationController();
    const local = browserSubscription();
    expiredEndpoint = local.endpoint;
    const registration = (await navigator.serviceWorker.getRegistration())!;
    vi.spyOn(registration.pushManager, "getSubscription").mockResolvedValue(
      local,
    );
    await controller.initialize();
    expect(mutations).toEqual([]);
    expect(alerts().subscribed).toBe(false);
    expect(subscribe).not.toHaveBeenCalled();

    const renewed = browserSubscription(local.endpoint + "-renewed");
    subscribe.mockResolvedValueOnce(renewed);
    await expect(controller.setMode("desktop")).resolves.toBe(true);
    expect(local.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(mutations.at(-1)).toEqual({ subscription: renewed.toJSON() });
    expect(alerts().subscribed).toBe(true);
  });

  it("retires a pending page display when alerts are disabled before worker readiness", async () => {
    const { controller, alerts } = await notificationController();
    const registration = await navigator.serviceWorker.ready;
    const ready = deferred<ServiceWorkerRegistration>();
    const waiting = vi.fn(() => ready.promise);
    Object.defineProperty(navigator.serviceWorker, "ready", {
      configurable: true,
      get: waiting,
    });
    const pending = controller.receive(failedOutcome("before-disable", "bg"));
    expect(waiting).toHaveBeenCalledOnce();

    await controller.setMode("off");
    ready.resolve(registration);
    await pending;

    expect(workerMessages).toEqual([]);
    expect(alerts()).toMatchObject({
      mode: "off",
      error: null,
    });
  });

  it("leaves a failed display unacknowledged for Host push fallback", async () => {
    const { controller, alerts } = await notificationController();
    const registration = await navigator.serviceWorker.ready;
    vi.spyOn(registration.active!, "postMessage").mockImplementation(
      (_data, transfer) => {
        const port = (transfer as MessagePort[])[0]!;
        port.postMessage({ error: "Display refused" });
        port.close();
      },
    );
    visibleFocused(false);
    await controller.receive(failedOutcome("display-failed", "s1"));
    await vi.waitFor(() => expect(alerts().error).toBe("Display refused"));
    expect(acknowledgments).toEqual([]);
  });
});
