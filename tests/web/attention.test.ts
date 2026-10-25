// @vitest-environment jsdom
import { MessageChannel } from "node:worker_threads";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as browserAuth from "../../src/browser-auth";
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
async function initialized(
  choice: typeof mode = "desktop",
  open?: (id: string) => RouteResponse | Promise<RouteResponse>,
  existingStore?: AppStore,
  refresh = true,
) {
  mode = choice;
  installFetch((url, init) => {
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
      return {
        body: {
          installationId: "device-one",
          mode,
          grouping,
          groupingUpdatedAt,
          subscribed,
          endpoint: subscribed ? subscriptionEndpoint : expiredEndpoint,
          publicKey: hostPublicKey,
          error: null,
        },
      };
    }
    if (url === "/api/notifications/ack") {
      acknowledgments.push(String(jsonBody(init).id));
      return { body: { ok: true } };
    }
    if (url === "/api/notifications/test")
      return (
        testResponse ?? { body: { transport: subscribed ? "push" : "page" } }
      );
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
  // Most cases begin after a completed device-settings refresh. Startup tests
  // instead supply the real stream settings-before-offer sequence below.
  if (refresh) await store.refreshTaskAlerts();
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
  it("starts core navigation and consumes the first offer while enrollment is pending", async () => {
    const enrollment = deferred<PushSubscription | null>();
    const registration = (await navigator.serviceWorker.getRegistration())!;
    vi.spyOn(registration.pushManager, "getSubscription").mockReturnValue(
      enrollment.promise,
    );
    history.replaceState(null, "", "/#inspire-session=bg");
    const { store, socket } = await initialized(
      "desktop",
      undefined,
      undefined,
      false,
    );
    await vi.waitFor(() => {
      expect(store.getState().connection).toBe("open");
      expect(store.getState().sessionId).toBe("bg");
      expect(
        store.getState().sessions.some((session) => session.id === "bg"),
      ).toBe(true);
    });
    expect(sessionStorage.getItem("inspire-notification-target")).toBeNull();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) => String(url) === "/api/notifications"),
    ).toBe(false);

    socket.emit({
      type: "task_alert_settings",
      settings: {
        installationId: "device-one",
        mode: "desktop",
        subscribed: false,
        endpoint: null,
        publicKey,
        error: null,
        grouping: "session",
        groupingUpdatedAt: 0,
      },
    });
    outcome(socket, "first-offer", "other-session");
    await vi.waitFor(() => expect(acknowledgments).toContain("first-offer"));
    expect(workerMessages).toHaveLength(1);
    expect(store.getState().taskAlerts.mode).toBe("desktop");
    enrollment.resolve(null);
    await vi.waitFor(() => expect(workerSettings).not.toHaveLength(0));
  });

  it("migrates stream settings and repairs existing enrollment through its own echoes", async () => {
    vi.spyOn(browserAuth, "migrateTaskAlertIntent").mockResolvedValue(
      "desktop",
    );
    const local = browserSubscription();
    const registration = (await navigator.serviceWorker.getRegistration())!;
    vi.spyOn(registration.pushManager, "getSubscription").mockResolvedValue(
      local,
    );
    const { store, socket } = await initialized(
      "off",
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
            settings: await response.clone().json(),
          });
        }
        return response;
      }),
    );
    const reconcile = vi.spyOn(
      TaskNotificationController.prototype,
      "initialize",
    );
    socket.emit({
      type: "task_alert_settings",
      settings: {
        installationId: "device-one",
        mode: null,
        subscribed: false,
        endpoint: null,
        publicKey,
        error: null,
        grouping: "session",
        groupingUpdatedAt: 0,
      },
    });
    await reconcile.mock.results[0]!.value;
    expect(store.getState().taskAlerts).toMatchObject({
      mode: "desktop",
      subscribed: true,
      error: null,
    });
    expect(mutations).toEqual([
      { mode: "desktop" },
      { subscription: local.toJSON() },
    ]);
    expect(Permission.requestPermission).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps an explicit Off when legacy migration resolves before pending grouping (%s)",
    async (groupingPending) => {
      const migration = deferred<"desktop">();
      vi.spyOn(browserAuth, "migrateTaskAlertIntent").mockReturnValue(
        migration.promise,
      );
      const { store, socket } = await initialized(
        "off",
        undefined,
        undefined,
        false,
      );
      const reconcile = vi.spyOn(
        TaskNotificationController.prototype,
        "initialize",
      );
      const settings = {
        installationId: "device-one",
        subscribed: false,
        endpoint: null,
        publicKey,
        error: null,
        grouping: "session",
        groupingUpdatedAt: 0,
      };
      socket.emit({
        type: "task_alert_settings",
        settings: { ...settings, mode: null },
      });
      const groupingReply = deferred<void>();
      if (groupingPending) {
        const transport = fetch;
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = await transport(input, init);
            if (
              String(input) === "/api/notifications" &&
              init?.method === "PUT" &&
              jsonBody(init).grouping !== undefined
            )
              await groupingReply.promise;
            return response;
          }),
        );
      }
      const changingGrouping = groupingPending
        ? store.setTaskNotificationGrouping("project")
        : Promise.resolve();
      if (groupingPending)
        await vi.waitFor(() =>
          expect(mutations).toContainEqual({ grouping: "project" }),
        );
      socket.emit({
        type: "task_alert_settings",
        settings: { ...settings, mode: "off", grouping, groupingUpdatedAt },
      });
      let migrationSettled = false;
      const migrated = reconcile.mock.results[0]!.value.then(() => {
        migrationSettled = true;
      });
      migration.resolve("desktop");
      try {
        // Off must retire migration before a slow grouping response can flush
        // pending settings; the old intent must never join the queued writes.
        await vi.waitFor(() => expect(migrationSettled).toBe(true));
        expect(store.getState().taskAlerts.mode).toBe("off");
        expect(mutations.filter((value) => value.mode !== undefined)).toEqual(
          [],
        );
        expect(subscribe).not.toHaveBeenCalled();
      } finally {
        groupingReply.resolve();
        await changingGrouping;
        await migrated;
      }
    },
  );

  it("does not rewrite another window's Off after a delayed permission grant", async () => {
    const { store, socket } = await initialized("title");
    const permission = deferred<NotificationPermission>();
    Permission.permission = "default";
    Permission.requestPermission.mockReturnValueOnce(permission.promise);
    const enabling = store.setCompletionAttention("desktop");
    await vi.waitFor(() => expect(mode).toBe("desktop"));
    // The first echo belongs to this window; the following Off is a newer
    // choice accepted by the same installation's Host from another window.
    socket.emit({
      type: "task_alert_settings",
      settings: {
        installationId: "device-one",
        mode,
        subscribed: false,
        publicKey,
        error: null,
      },
    });
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
    permission.resolve("granted");
    await expect(enabling).resolves.toBe(false);
    expect(mode).toBe("off");
    expect(subscribed).toBe(false);
    expect(store.getState().taskAlerts).toMatchObject({
      mode: "off",
      subscribed: false,
      busy: false,
      error: null,
    });
    expect(mutations.filter((value) => value.mode !== undefined)).toEqual([
      { mode: "desktop" },
    ]);
    expect(subscription!.unsubscribe).toHaveBeenCalledOnce();
  });

  it("retires a permission result when bootstrap replaces its API owner", async () => {
    const { store } = await initialized("title");
    const permission = deferred<NotificationPermission>();
    Permission.permission = "default";
    Permission.requestPermission.mockReturnValueOnce(permission.promise);
    const enabling = store.setCompletionAttention("desktop");
    await vi.waitFor(() => expect(mode).toBe("desktop"));
    await initialized("off", undefined, store);
    const settledIntent = [...mutations];
    permission.resolve("granted");
    await expect(enabling).resolves.toBe(false);
    expect(mutations).toEqual(settledIntent);
    expect(store.getState().taskAlerts).toMatchObject({
      mode: "off",
      busy: false,
    });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("retains a failed explicit grouping choice through unchanged refreshes and retries without touching enrollment", async () => {
    const { store, socket } = await initialized("off");
    let accept = false;
    const saved = (choice: "session" | "project", stamp: number) => ({
      installationId: "device-one",
      mode: "off",
      subscribed: false,
      endpoint: null,
      publicKey,
      error: null,
      grouping: choice,
      groupingUpdatedAt: stamp,
    });
    installFetch((url, init) =>
      url === "/api/notifications"
        ? init.method === "PUT"
          ? accept
            ? { body: saved("project", 1) }
            : { status: 503, body: { error: "Host temporarily unavailable" } }
          : { body: saved("session", 0) }
        : undefined,
    );
    await expect(store.setTaskNotificationGrouping("project")).resolves.toBe(
      false,
    );
    socket.emit({ type: "task_alert_settings", settings: saved("session", 0) });
    await store.refreshTaskAlerts();
    const settingsCount = workerSettings.length;
    worker.dispatchEvent(new Event("controllerchange"));
    await vi.waitFor(() =>
      expect(store.getState().taskAlerts).toMatchObject({
        grouping: "project",
        groupingError: expect.stringContaining("unavailable"),
        groupingBusy: false,
      }),
    );
    expect(workerSettings).toHaveLength(settingsCount);
    accept = true;
    await expect(store.setTaskNotificationGrouping("project")).resolves.toBe(
      true,
    );
    expect(store.getState().taskAlerts).toMatchObject({
      mode: "off",
      grouping: "project",
      groupingError: null,
      groupingBusy: false,
    });
    expect(Permission.requestPermission).not.toHaveBeenCalled();
  });

  it("reconciles worker replacement and ignores an older worker's late error", async () => {
    const { store } = await initialized("off");
    const registration = await navigator.serviceWorker.getRegistration();
    let oldReply: MessagePort | undefined;
    vi.spyOn(registration!.active!, "postMessage").mockImplementationOnce(
      (_message, ports) => {
        oldReply = (Array.isArray(ports) ? ports : ports?.transfer)?.[0] as
          | MessagePort
          | undefined;
      },
    );
    const oldRefresh = store.refreshTaskAlerts();
    await vi.waitFor(() => expect(oldReply).toBeDefined());
    worker.dispatchEvent(new Event("controllerchange"));
    await store.refreshTaskAlerts();
    oldReply!.postMessage({ error: "Retired worker error" });
    oldReply!.close();
    await oldRefresh;
    expect(store.getState().taskAlerts.groupingError).toBeNull();
  });

  it("saves only the grouping choice without requesting permission or altering alert intent", async () => {
    const { store } = await initialized("off");
    await expect(store.setTaskNotificationGrouping("project")).resolves.toBe(
      true,
    );
    expect(mutations.at(-1)).toEqual({ grouping: "project" });
    expect(Permission.requestPermission).not.toHaveBeenCalled();
    expect(store.getState().taskAlerts).toMatchObject({
      mode: "off",
      grouping: "project",
      groupingBusy: false,
      groupingError: null,
    });
    expect(workerSettings.at(-1)).toMatchObject({
      grouping: "project",
      updatedAt: 1,
      owner: publicKey,
    });
    await store.refreshTaskAlerts();
    expect(store.getState().taskAlerts.grouping).toBe("project");
  });

  it("takes a newly paired Host's default even when its revision is lower", async () => {
    const { store } = await initialized("off");
    await store.setTaskNotificationGrouping("project");
    hostPublicKey = "replacement-host-public-key";
    grouping = "session";
    groupingUpdatedAt = 0;
    await initialized("off", undefined, store);
    expect(store.getState().taskAlerts).toMatchObject({
      grouping: "session",
      groupingUpdatedAt: 0,
    });
    expect(workerSettings.at(-1)).toMatchObject({
      owner: hostPublicKey,
      grouping: "session",
      updatedAt: 0,
    });
  });

  it("keeps a new grouping choice when an earlier refresh or settings echo arrives late", async () => {
    const { store, socket } = await initialized("off");
    const oldRead = deferred<RouteResponse>();
    const settings = (choice: "session" | "project", stamp: number) => ({
      installationId: "device-one",
      mode: "off",
      subscribed: false,
      endpoint: null,
      publicKey,
      error: null,
      grouping: choice,
      groupingUpdatedAt: stamp,
    });
    installFetch((url, init) =>
      url === "/api/notifications"
        ? init.method === "PUT"
          ? { body: settings("project", 10) }
          : oldRead.promise
        : undefined,
    );
    const refresh = store.refreshTaskAlerts();
    await store.setTaskNotificationGrouping("project");
    oldRead.resolve({ body: settings("session", 0) });
    await refresh;
    socket.emit({
      type: "task_alert_settings",
      settings: settings("session", 0),
    });
    expect(store.getState().taskAlerts.grouping).toBe("project");
    expect(workerSettings.at(-1)).toMatchObject({
      grouping: "project",
      updatedAt: 10,
    });
    socket.emit({
      type: "task_alert_settings",
      settings: settings("session", 20),
    });
    await vi.waitFor(() =>
      expect(workerSettings.at(-1)).toMatchObject({
        grouping: "session",
        updatedAt: 20,
      }),
    );
    expect(store.getState().taskAlerts.grouping).toBe("session");
  });

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
    expect(mode).toBe("desktop");
    expect(subscribed).toBe(false);
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

  it("keeps display acceptance when push delivery beats the test HTTP response", async () => {
    const { store } = await initialized();
    const response = deferred<RouteResponse>();
    testResponse = response.promise;
    const pending = store.testTaskNotification();
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "inspire-notification-shown", test: true },
      }),
    );
    response.resolve({ body: { transport: "push" } });
    await pending;
    expect(store.getState().taskAlerts.testResult).toBe(
      "Display request accepted. Check your system notifications.",
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

  it("recovers interrupted Host enrollment, leaves it healthy, and repairs rotation without rewriting intent", async () => {
    const { store } = await initialized();
    const local = browserSubscription();
    const registration = (await navigator.serviceWorker.getRegistration())!;
    vi.spyOn(registration.pushManager, "getSubscription").mockResolvedValue(
      local,
    );
    // The browser retained the subscription after the initial registration
    // request failed. The Host has neither its endpoint nor subscribed=true.
    await store.refreshTaskAlerts();
    expect(mutations).toEqual([{ subscription: local.toJSON() }]);
    expect(store.getState().taskAlerts.subscribed).toBe(true);
    expect(subscribe).not.toHaveBeenCalled();
    expect(Permission.requestPermission).not.toHaveBeenCalled();
    mutations = [];
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

  it("replaces an expired browser subscription only when the user enables notifications", async () => {
    const { store } = await initialized();
    const local = browserSubscription();
    expiredEndpoint = local.endpoint;
    const registration = (await navigator.serviceWorker.getRegistration())!;
    vi.spyOn(registration.pushManager, "getSubscription").mockResolvedValue(
      local,
    );
    await store.refreshTaskAlerts();
    expect(mutations).toEqual([]);
    expect(store.getState().taskAlerts.subscribed).toBe(false);
    expect(subscribe).not.toHaveBeenCalled();

    const renewed = browserSubscription(local.endpoint + "-renewed");
    subscribe.mockResolvedValueOnce(renewed);
    await expect(store.setCompletionAttention("desktop")).resolves.toBe(true);
    expect(local.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(mutations.at(-1)).toEqual({ subscription: renewed.toJSON() });
    expect(store.getState().taskAlerts.subscribed).toBe(true);
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
    const settledIntent = [...mutations];
    permission.resolve("granted");
    await expect(old).resolves.toBe(false);
    expect(store.getState().taskAlerts.mode).toBe("off");
    expect(mutations).toEqual(settledIntent);
    expect(mutations.at(-1)).toEqual({ mode: "off", subscription: null });
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
